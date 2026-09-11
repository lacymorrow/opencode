/**
 * Working directory state management for shell mode.
 * Tracks the current working directory independently from Instance.directory.
 */

import { context as instanceContext } from "@/project/instance-context"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import path from "path"
import os from "os"
import { Schema } from "effect"

let currentCwd: string | null = null

/**
 * Event published when the working directory changes.
 */
export const CwdEvent = {
  Updated: EventV2.define({
    type: "cwd.updated",
    schema: {
      cwd: Schema.String,
    },
  }),
}

/**
 * Get the current working directory.
 * Returns Instance.directory if not explicitly set.
 *
 * The ambient instance context is only entered by CLI `bootstrap()`; Effect-based
 * callers (tools, session prompt) run with `InstanceRef` instead and must pass the
 * instance directory as `fallback` or getCwd degrades to process.cwd().
 */
export function getCwd(fallback?: string): string {
  if (currentCwd === null) {
    try {
      return instanceContext.use().directory
    } catch {
      return fallback ?? process.cwd()
    }
  }
  return currentCwd
}

/**
 * Set the current working directory.
 * Handles ~ expansion and relative path resolution.
 *
 * Effect-based callers (session prompt) run with `InstanceRef`, not the
 * ambient instance context, so they must pass `options.directory` or the
 * cwd.updated event is silently skipped and the TUI footer goes stale
 * (LAC-3732).
 */
export function setCwd(dir: string, options?: { directory?: string }): void {
  let resolved = dir

  // Handle ~ expansion
  if (resolved.startsWith("~")) {
    resolved = path.join(os.homedir(), resolved.slice(1))
  }

  // Resolve relative paths against current cwd
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(getCwd(), resolved)
  }

  const changed = currentCwd !== resolved
  currentCwd = resolved

  // Publish event if cwd changed. EventV2 / Bus refactor (upstream PR #29068)
  // collapsed BusEvent.publish into GlobalBus.emit for ambient (non-Effect) callers.
  if (changed) {
    let directory = options?.directory
    if (directory === undefined) {
      try {
        directory = instanceContext.use().directory
      } catch {
        // No instance context and no explicit directory; skip publishing
      }
    }
    if (directory !== undefined) {
      GlobalBus.emit("event", {
        directory,
        payload: {
          type: CwdEvent.Updated.type,
          properties: { cwd: resolved },
        },
      })
    }
  }
}

/**
 * Reset the working directory to Instance.directory.
 */
export function resetCwd(): void {
  currentCwd = null
}

export interface CwdSentinelResult {
  exitCode: number | null
  cwd: string | null
}

/**
 * Parse the payload that follows the cwd sentinel in wrapped shell output:
 * "<exitCode>:<cwd>", or legacy "<cwd>" with no exit code.
 *
 * Shells always report their working directory as an absolute path. A
 * non-absolute value means the wrapper template was not expanded by the
 * shell that ran it (e.g. cmd.exe echoing a bash-style "$(pwd -P ...)"
 * literally, or bash echoing "%CD%"). Such values must never reach
 * setCwd — the poisoned cwd is shared process-wide and makes every
 * subsequent spawn fail its cwd access check (LAC-2693).
 */
export function parseCwdSentinelPayload(payload: string): CwdSentinelResult {
  let exitCode: number | null = null
  let cwd: string | null = payload || null
  const colonIndex = payload.indexOf(":")
  if (colonIndex !== -1) {
    const code = parseInt(payload.slice(0, colonIndex), 10)
    // A non-numeric prefix means the colon belongs to the cwd itself
    // (e.g. a bare "D:\foo" drive path), not an exit-code separator.
    if (!isNaN(code)) {
      exitCode = code
      cwd = payload.slice(colonIndex + 1).trim() || null
    }
  }
  if (cwd && !path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd)) cwd = null
  return { exitCode, cwd }
}
