import { z } from '../../zodRuntimePolicy.js';

export const CLI_ACQUISITION_PROGRESS_EVENT = 'cli.acquisition.progress' as const;

export const CliAcquisitionPhaseSchema = z.enum([
  'resolvingRelease', 'downloading', 'verifying', 'unpacking', 'installing', 'finalizing', 'checkingCli', 'checkingDaemon',
]);
export type CliAcquisitionPhase = z.infer<typeof CliAcquisitionPhaseSchema>;

/** Optional download counters describe archive transfer only, never overall setup completion. */
export const CliAcquisitionProgressSchema = z.object({
  phase: CliAcquisitionPhaseSchema,
  receivedBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
  totalBytes: z.optional(z.number().check(z.int(), z.positive())),
  failure: z.optional(z.object({ cause: z.string() })),
});
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
