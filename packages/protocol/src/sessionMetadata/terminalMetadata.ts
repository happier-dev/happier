import { z } from 'zod';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODES } from './windowsRemoteSessionLaunchMode.js';

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

export function createSessionTerminalMetadataSchema(zod: typeof z) {
  const terminalModeSchema = zod.enum(['plain', 'tmux', 'windows_terminal', 'windows_console']);
  const requestedModeSchema = zod.enum(['plain', 'tmux', ...WINDOWS_REMOTE_SESSION_LAUNCH_MODES]);
  return zod
    .object({
      mode: terminalModeSchema,
      requested: requestedModeSchema.optional(),
      fallbackReason: zod.string().optional(),
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
    .passthrough();
}

export const SessionTerminalMetadataSchema = createSessionTerminalMetadataSchema(z);
export type SessionTerminalMetadata = z.infer<typeof SessionTerminalMetadataSchema>;
