import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { getCwd, setCwd, resetCwd, parseCwdSentinelPayload, CwdEvent } from "../../plugin/shell-mode/cwd"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { provideTestInstance, disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  resetCwd()
  await disposeAllInstances()
})

async function withInstance(fn: () => Promise<void>): Promise<void> {
  await using tmp = await tmpdir()
  await provideTestInstance({ directory: tmp.path, fn })
}

function subscribeCwd(received: string[]): () => void {
  const handler = (event: GlobalEvent) => {
    if (event.payload?.type !== CwdEvent.Updated.type) return
    const cwd = event.payload.properties?.cwd
    if (typeof cwd === "string") received.push(cwd)
  }
  GlobalBus.on("event", handler)
  return () => GlobalBus.off("event", handler)
}

describe("setCwd / getCwd — unit", () => {
  test("absolute path is stored and returned", async () => {
    await withInstance(async () => {
      setCwd("/tmp")
      expect(getCwd()).toBe("/tmp")
    })
  })

  test("tilde is expanded to home directory", async () => {
    await withInstance(async () => {
      setCwd("~/projects")
      expect(getCwd()).toBe(path.join(os.homedir(), "projects"))
    })
  })

  test("bare tilde expands to home directory", async () => {
    await withInstance(async () => {
      setCwd("~")
      expect(getCwd()).toBe(os.homedir())
    })
  })

  // Expected values go through path.resolve so they match the platform's
  // path syntax (win32 resolves "/workspace" + "subdir" to "D:\workspace\subdir").
  test("relative path resolves against current cwd", async () => {
    await withInstance(async () => {
      setCwd("/workspace")
      setCwd("subdir")
      expect(getCwd()).toBe(path.resolve("/workspace", "subdir"))
    })
  })

  test("chained relative cds accumulate correctly", async () => {
    await withInstance(async () => {
      setCwd("/workspace")
      setCwd("a")
      setCwd("b")
      expect(getCwd()).toBe(path.resolve("/workspace", "a", "b"))
    })
  })

  test(".. resolves against current cwd", async () => {
    await withInstance(async () => {
      setCwd("/workspace/a/b")
      setCwd("..")
      expect(getCwd()).toBe(path.resolve("/workspace/a/b", ".."))
    })
  })
})

// LAC-742 regression: getCwd defaults to Instance.directory before any cd
describe("getCwd default — LAC-742 regression", () => {
  test("defaults to Instance.directory before any setCwd", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        expect(getCwd()).toBe(tmp.path)
      },
    })
  })

  test("resetCwd restores fallback to Instance.directory", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        setCwd("/tmp")
        expect(getCwd()).toBe("/tmp")
        resetCwd()
        expect(getCwd()).toBe(tmp.path)
      },
    })
  })
})

// LAC-742 regression: tool path resolution uses updated cwd
describe("tool path resolution — LAC-742 regression", () => {
  test("after cd /tmp, getCwd() is /tmp (bash tool base)", async () => {
    await withInstance(async () => {
      setCwd("/tmp")
      expect(getCwd()).toBe("/tmp")
      expect(path.resolve(getCwd(), "relative-file.txt")).toBe(path.resolve("/tmp", "relative-file.txt"))
    })
  })

  test("relative tool path resolves against updated cwd, not Instance.directory", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        expect(getCwd()).toBe(tmp.path)
        setCwd("/tmp")
        expect(getCwd()).toBe("/tmp")
        expect(getCwd()).not.toBe(tmp.path)
      },
    })
  })
})

// LAC-2693 regression: on Windows, a shell that does not understand the
// wrapper template echoes it literally (cmd.exe printing "$(pwd -P ...)").
// That text must never reach setCwd — the poisoned cwd is process-wide and
// makes every later spawn fail its cwd access check.
describe("parseCwdSentinelPayload — LAC-2693 regression", () => {
  test("parses exit code and posix cwd", () => {
    expect(parseCwdSentinelPayload("0:/home/user/project")).toEqual({ exitCode: 0, cwd: "/home/user/project" })
  })

  test("parses exit code and windows drive cwd", () => {
    expect(parseCwdSentinelPayload("1:D:\\a\\lash\\lash")).toEqual({ exitCode: 1, cwd: "D:\\a\\lash\\lash" })
  })

  test("accepts legacy payload without exit code", () => {
    expect(parseCwdSentinelPayload("/tmp")).toEqual({ exitCode: null, cwd: "/tmp" })
  })

  test("treats non-numeric prefix with drive colon as cwd", () => {
    expect(parseCwdSentinelPayload("D:\\foo")).toEqual({ exitCode: null, cwd: "D:\\foo" })
  })

  test("rejects unexpanded posix substitution echoed by cmd.exe", () => {
    expect(parseCwdSentinelPayload("$__oc_exit:$(pwd -P 2>/dev/null || pwd)")).toEqual({
      exitCode: null,
      cwd: null,
    })
    expect(parseCwdSentinelPayload("0:$(pwd -P")).toEqual({ exitCode: 0, cwd: null })
  })

  test("rejects unexpanded cmd variables echoed by a posix shell", () => {
    expect(parseCwdSentinelPayload("%ERRORLEVEL%:%CD%")).toEqual({ exitCode: null, cwd: null })
  })

  test("handles empty and cwd-less payloads", () => {
    expect(parseCwdSentinelPayload("")).toEqual({ exitCode: null, cwd: null })
    expect(parseCwdSentinelPayload("0:")).toEqual({ exitCode: 0, cwd: null })
  })
})

// LAC-3732 regression: the session prompt runs under Effect InstanceRef, not
// the ambient instance context (only CLI bootstrap enters that), so the emit
// guarded by instanceContext.use() silently never fired and the TUI footer cwd
// went stale. setCwd must publish when the caller passes the directory.
describe("CwdEvent.Updated without ambient context — LAC-3732 regression", () => {
  test("published when caller passes directory explicitly", async () => {
    const received: string[] = []
    const unsub = subscribeCwd(received)

    setCwd("/tmp", { directory: "/some/project" })
    await Bun.sleep(10)

    expect(received).toEqual(["/tmp"])
    unsub()
  })

  test("event carries the caller-provided instance directory", async () => {
    const directories: (string | undefined)[] = []
    const handler = (event: GlobalEvent) => {
      if (event.payload?.type !== CwdEvent.Updated.type) return
      directories.push(event.directory)
    }
    GlobalBus.on("event", handler)

    setCwd("/tmp", { directory: "/some/project" })
    await Bun.sleep(10)

    expect(directories).toEqual(["/some/project"])
    GlobalBus.off("event", handler)
  })

  test("not published when no ambient context and no directory passed", async () => {
    const received: string[] = []
    const unsub = subscribeCwd(received)

    setCwd("/tmp")
    await Bun.sleep(10)

    expect(received).toEqual([])
    unsub()
  })
})

// LAC-742 regression: CwdEvent.Updated bus event
describe("CwdEvent.Updated — LAC-742 regression", () => {
  test("published when cwd changes", async () => {
    await using tmp = await tmpdir()
    const received: string[] = []

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const unsub = subscribeCwd(received)
        await Bun.sleep(10)

        setCwd("/tmp")
        await Bun.sleep(10)

        expect(received).toEqual(["/tmp"])
        unsub()
      },
    })
  })

  test("not published when same cwd is set again", async () => {
    await using tmp = await tmpdir()
    const received: string[] = []

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const unsub = subscribeCwd(received)
        await Bun.sleep(10)

        setCwd("/tmp")
        setCwd("/tmp")
        await Bun.sleep(10)

        expect(received).toEqual(["/tmp"])
        unsub()
      },
    })
  })

  test("published for each distinct cd destination", async () => {
    await using tmp = await tmpdir()
    const received: string[] = []

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const unsub = subscribeCwd(received)
        await Bun.sleep(10)

        setCwd("/tmp")
        setCwd("/var")
        await Bun.sleep(10)

        expect(received).toEqual(["/tmp", "/var"])
        unsub()
      },
    })
  })
})
