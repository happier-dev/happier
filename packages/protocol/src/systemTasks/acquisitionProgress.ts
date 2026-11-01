import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const CLI_ACQUISITION_PROGRESS_EVENT = 'cli.acquisition.progress' as const;

export const CliAcquisitionPhaseSchema = lazySchema(() => z.enum([
  'resolvingRelease', 'downloading', 'verifying', 'unpacking', 'installing', 'finalizing', 'checkingCli', 'checkingDaemon',
]));
export type CliAcquisitionPhase = z.infer<typeof CliAcquisitionPhaseSchema>;

/** Optional download counters describe archive transfer only, never overall setup completion. */
export const CliAcquisitionProgressSchema = lazySchema(() => z.object({
  phase: CliAcquisitionPhaseSchema,
  receivedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().positive().optional(),
  failure: z.object({ cause: z.string() }).optional(),
}));
export type CliAcquisitionProgress = z.infer<typeof CliAcquisitionProgressSchema>;

/** Unknown future phases or malformed samples leave older readers on their normal task status. */
export function parseCliAcquisitionProgress(value: unknown): CliAcquisitionProgress | null {
  const parsed = CliAcquisitionProgressSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readCliAcquisitionFailurePhase(code: string): CliAcquisitionPhase | null {
  const match = /^cli_acquisition_(.+)_failed$/.exec(code);
  const parsed = CliAcquisitionPhaseSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}
