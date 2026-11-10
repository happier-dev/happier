// Historical terminal schema from ui-web-v0.2.12 (a357c65536ba89669422977d6f7daf9aa0d17e73).
// Its windowsRemoteSessionLaunchMode constant is inlined verbatim from that same tag.
// Test-only released reader: do not update it when the current schema evolves.
import { z } from '../../../zodRuntimePolicy.js';
const WINDOWS_REMOTE_SESSION_LAUNCH_MODES = ['hidden', 'windows_terminal', 'console'] as const;

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

export function createSessionTerminalMetadataSchema(zod: typeof z) {
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', 'zellij', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  return zod.looseObject({
      // Optional only for compatibility with retirement tombstones written by the
      // first attachment-bound serviceability writer before it preserved host mode.
      mode: zod.optional(terminalModeSchema),
      requested: zod.optional(requestedModeSchema),
      fallbackReason: zod.optional(zod.string()),
      controlServiceabilityV1: zod.optional(zod.looseObject({
        v: zod.literal(1),
        attachmentId: zod.optional(zod.string()),
        state: zod.enum(['servable', 'recoverable_unservable', 'unknown']),
        observedAt: zod.number(),
        reason: zod.optional(zod.string()),
        retired: zod.optional(zod.boolean()),
      })),
      tmux: zod.optional(zod
        .object({
          target: zod.string(),
          tmpDir: zod.optional(zod.nullable(zod.string())),
        })),
      zellij: zod.optional(zod
        .object({
          sessionName: zod.string(),
          paneId: zod.optional(zod.string()),
          /** Socket-root attestation for hosts written by the v1 terminal-host metadata writer. */
          socketDirV1: zod.optional(zod.string()),
        })),
      windows: zod.optional(zod
        .object({
          host: zod.enum(['windows_terminal', 'console']),
          windowId: zod.optional(zod.string()),
          pid: zod.optional(zod.number().check(zod.int())),
          title: zod.optional(zod.string()),
        })),
    }).check(zod.superRefine((terminal, ctx) => {
      if (terminal.mode !== undefined) return;
      if (terminal.controlServiceabilityV1?.retired === true) return;
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Terminal mode is required outside legacy retirement tombstones',
      });
    }));
}

export const SessionTerminalMetadataSchema = createSessionTerminalMetadataSchema(z);
