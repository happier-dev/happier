import { z } from 'zod/mini';
import { logger } from '@/ui/logger';

/** Private native-pipe observation; never part of the public preparation result. */
export const DirectoryPreflightRefusalSchema = z.strictObject({
  branch: z.enum(['managed_tag', 'canonical_path', 'directory_readiness', 'checkout_directory']),
  directoryKind: z.enum(['managed', 'path']),
  requestedDirectory: z.optional(z.string()),
  directory: z.optional(z.string()),
  effectiveUid: z.optional(z.number().check(z.int(), z.nonnegative())),
});
export type DirectoryPreflightRefusal = z.infer<typeof DirectoryPreflightRefusalSchema>;

export function recordDirectoryPreflightRefusal(diagnostic: DirectoryPreflightRefusal,
  context?: Readonly<{ transportRequestId?: string; operationKey?: string }>): void {
  try {
    logger.warnLocalFile('[sessionCreation] Directory preflight refused', { ...diagnostic, ...context });
  } catch { /* File diagnostics never replace the original refusal. */ }
}
