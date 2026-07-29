import { z } from 'zod';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODES } from './windowsRemoteSessionLaunchMode.js';

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

export function createSessionTerminalMetadataSchema(zod: typeof z) {
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'zellij', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', 'zellij', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  return zod
    .object({
      mode: terminalModeSchema.optional(),
      requested: requestedModeSchema.optional(),
      fallbackReason: zod.string().optional(),
      controlServiceabilityV1: zod.object({
        v: zod.literal(1),
        attachmentId: zod.string().optional(),
        state: zod.enum(['servable', 'recoverable_unservable', 'unknown']),
        observedAt: zod.number(),
        reason: zod.string().optional(),
        retired: zod.boolean().optional(),
      }).passthrough().optional(),
      tmux: zod
        .object({
          target: zod.string(),
          tmpDir: zod.string().nullable().optional(),
        })
        .optional(),
      windows: zod
        .object({
          host: zod.enum(['windows_terminal', 'console']),
          windowId: zod.string().optional(),
          pid: zod.number().int().optional(),
          title: zod.string().optional(),
        })
        .optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (value.mode === undefined && value.controlServiceabilityV1?.retired !== true) {
        ctx.addIssue({
          code: zod.ZodIssueCode.custom,
          path: ['mode'],
          message: 'Mode-less terminal metadata is accepted only for an explicitly retired legacy attachment',
        });
      }
    });
}

export const SessionTerminalMetadataSchema = createSessionTerminalMetadataSchema(z);
export type SessionTerminalMetadata = z.infer<typeof SessionTerminalMetadataSchema>;

export function isSessionTerminalPermanentlyAbsent(
  value: SessionTerminalMetadata['controlServiceabilityV1'] | null | undefined,
): boolean {
  return value?.v === 1 && value.retired === true;
}
