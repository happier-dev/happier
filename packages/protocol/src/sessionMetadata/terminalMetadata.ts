import { z } from 'zod';

/**
 * Session terminal attachment metadata (stored in encrypted `session.metadata`).
 *
 * Keep schemas permissive (passthrough) for forward compatibility.
 * Use factory forms for nohoist/multi-Zod repos.
 */

export function createSessionTerminalMetadataSchema(zod: typeof z) {
  return zod
    .object({
      mode: zod.enum(['plain', 'tmux']),
      requested: zod.enum(['plain', 'tmux']).optional(),
      fallbackReason: zod.string().optional(),
      tmux: zod
        .object({
          target: zod.string(),
          tmpDir: zod.string().nullable().optional(),
        })
        .optional(),
    })
    .passthrough();
}

export const SessionTerminalMetadataSchema = createSessionTerminalMetadataSchema(z);
export type SessionTerminalMetadata = z.infer<typeof SessionTerminalMetadataSchema>;
