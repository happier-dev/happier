import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import { normalizePanelReview, PanelReviewError, type PanelReviewResult } from './document.js';

export type PanelReviewRunInput = Readonly<{
  /** Host-issued unique create-run identity; this adapter does not resume runs. */
  runId: string;
  cwd: string;
  executable: ManagedExecutableRef;
  /** Native arguments supplied by the shared admitted scope/options adapter. */
  reviewArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  instructions?: string;
  onProgress?: () => void;
}>;

export async function runPanelReview(
  services: Readonly<{ exec: Pick<ExecService, 'run'>; fs: Pick<FileSystemService, 'getPluginDataDirectory' | 'writeFile'> }>,
  input: PanelReviewRunInput,
): Promise<PanelReviewResult> {
  input.signal.throwIfAborted();
  const dataDirectory = await services.fs.getPluginDataDirectory({ relativePath: `runs/${input.runId}`, signal: input.signal });
  input.signal.throwIfAborted();
  if (input.instructions) await services.fs.writeFile({ root: 'pluginData', relativePath: `runs/${input.runId}/config.toml` },
    new TextEncoder().encode(`review_guidelines = ${JSON.stringify(input.instructions)}\n`), { signal: input.signal });
  const launch = {
    executable: input.executable, cwd: input.cwd,
    env: { ...input.env, ROBOREV_DATA_DIR: dataDirectory, ROBOREV_TELEMETRY_ENABLED: '0', NO_COLOR: '1' },
  };
  const command = async (
    phase: Exclude<PanelReviewError['phase'], 'document'>,
    args: readonly string[],
    options?: Parameters<ExecService['run']>[1],
  ): Promise<PluginProcessResult> => {
    const result = await services.exec.run({ ...launch, args }, options);
    options?.signal?.throwIfAborted();
    const observed = result.termination.observed;
    // Native wait uses 1 for either a completed FAIL verdict or a job failure.
    // The selected stored document, never this exit code, supplies the result.
    if (observed.kind !== 'exit' || (observed.exitCode !== 0 && !(phase === 'wait' && observed.exitCode === 1))) {
      throw new PanelReviewError('panel_native_process_failed', phase, observed.kind === 'exit' ? observed.exitCode : undefined, result.termination);
    }
    return result;
  };
  let jobId: number | null = null;
  let waitSettled = false;
  let primary: { error: unknown } | null = null;
  try {
    // Native start/enqueue/list acquire daemon/job custody. Complete these short
    // native operations before honoring Stop, so cleanup always knows what it
    // owns. The native CLI owns their startup/request deadlines.
    await command('start', ['daemon', 'start'], { descendantDisposition: 'preserve-on-success' });
    input.signal.throwIfAborted();
    // Quiet is the native no-hook-maintenance path. It also omits the rendered
    // receipt. In this unique create-run's isolated database, list returns one
    // top-level review; native listing hides panel members under synthesis.
    await command('review', ['review', ...input.reviewArgs, '--quiet']);
    const listed = await command('list', ['job', 'list', '--json']);
    let jobs: unknown;
    try { jobs = JSON.parse(new TextDecoder().decode(listed.stdout)); }
    catch { throw new PanelReviewError('panel_job_missing', 'list'); }
    if (!Array.isArray(jobs) || jobs.length !== 1) throw new PanelReviewError('panel_job_missing', 'list');
    const selected: unknown = jobs[0];
    if (!selected || typeof selected !== 'object' || !('id' in selected)
      || typeof selected.id !== 'number' || !Number.isSafeInteger(selected.id) || selected.id < 1) {
      throw new PanelReviewError('panel_job_missing', 'list');
    }
    jobId = selected.id;
    input.onProgress?.();
    input.signal.throwIfAborted();
    await command('wait', ['job', 'wait', '--job', String(jobId)], { signal: input.signal });
    waitSettled = true;
    input.onProgress?.();
    const shown = await command('show', ['job', 'show', '--job', String(jobId), '--json'], { signal: input.signal });
    let record: unknown;
    try {
      record = JSON.parse(new TextDecoder().decode(shown.stdout));
    } catch {
      throw new PanelReviewError('panel_document_invalid', 'document');
    }
    return normalizePanelReview(record, jobId);
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    // Native synthesis cancellation cascades to its panel members. Stop alone
    // drains active work, so cancel first when the native wait was interrupted.
    if (jobId !== null && !waitSettled) {
      try { await command('cancel', ['job', 'cancel', String(jobId)]); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await command('stop', ['daemon', 'stop']); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      if (primary !== null) throw new AggregateError([primary.error, ...cleanupErrors], 'Panel review and native cleanup failed');
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, 'Panel review native cleanup failed');
    }
  }
}
