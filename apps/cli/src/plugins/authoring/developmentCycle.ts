import { isPluginDevelopmentDependencyInputPath } from './developmentDependencyInputs';
import type {
  PluginDevelopmentSourceObservation,
  PluginDevelopmentSourceRequest,
} from './sourceObserver';

type SuccessfulPluginDevelopmentSourceObservation = Extract<
  PluginDevelopmentSourceObservation,
  { ok: true }
>;

export type PluginDevelopmentCycleDiagnostic = Readonly<{
  code: string;
  message: string;
}>;

export type PluginDevelopmentCycleDurations = Readonly<{
  submissionMs?: number;
}>;

type PluginDevelopmentCycleBatch = Readonly<{
  dependencyInputChanged: boolean;
  dependencyInputChangeUnknown: boolean;
  changedPathCount: number | null;
}>;

export type PluginDevelopmentCycleResult<TSubmission> =
  | Readonly<{
      kind: 'cancelled';
      durations: PluginDevelopmentCycleDurations;
    } & PluginDevelopmentCycleBatch>
  | Readonly<{
      kind: 'submissionFailed';
      diagnostics: readonly PluginDevelopmentCycleDiagnostic[];
      durations: PluginDevelopmentCycleDurations;
    } & PluginDevelopmentCycleBatch>
  | Readonly<{
      kind: 'submitted';
      request: PluginDevelopmentSourceRequest;
      submission: TSubmission;
      durations: PluginDevelopmentCycleDurations;
    } & PluginDevelopmentCycleBatch>;

type SubmitDevelopmentChange<TSubmission> = (
  request: PluginDevelopmentSourceRequest,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<TSubmission>;

function classifyCapturedBatch(request: PluginDevelopmentSourceRequest): PluginDevelopmentCycleBatch {
  if (request.changedPaths === undefined) {
    return Object.freeze({
      dependencyInputChanged: false,
      dependencyInputChangeUnknown: true,
      changedPathCount: null,
    });
  }
  return Object.freeze({
    dependencyInputChanged: request.changedPaths.some((path) => (
      isPluginDevelopmentDependencyInputPath(path)
    )),
    dependencyInputChangeUnknown: false,
    changedPathCount: request.changedPaths.length,
  });
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The sole CLI author-cycle coordinator observes/coalesces a captured source
 * batch and submits it to the daemon. It deliberately has no dependency,
 * generated-UI, candidate, activation, or adoption authority: the daemon
 * materializes and evaluates one owned development closure from this batch.
 */
export async function runPluginDevelopmentCycle<TSubmission>(params: Readonly<{
  observation: SuccessfulPluginDevelopmentSourceObservation;
  submit: SubmitDevelopmentChange<TSubmission>;
  signal?: AbortSignal;
  nowMs?: () => number;
}>): Promise<PluginDevelopmentCycleResult<TSubmission>> {
  const nowMs = params.nowMs ?? Date.now;
  const batch = classifyCapturedBatch(params.observation.request);
  const durations: { submissionMs?: number } = {};

  if (aborted(params.signal)) {
    return Object.freeze({
      kind: 'cancelled',
      ...batch,
      durations: Object.freeze(durations),
    });
  }

  try {
    const startedAtMs = nowMs();
    const submission = params.signal
      ? await params.submit(params.observation.request, { signal: params.signal })
      : await params.submit(params.observation.request);
    durations.submissionMs = Math.max(0, nowMs() - startedAtMs);
    if (aborted(params.signal)) {
      return Object.freeze({
        kind: 'cancelled',
        ...batch,
        durations: Object.freeze(durations),
      });
    }
    return Object.freeze({
      kind: 'submitted',
      ...batch,
      request: params.observation.request,
      submission,
      durations: Object.freeze(durations),
    });
  } catch (error) {
    if (aborted(params.signal)) {
      return Object.freeze({
        kind: 'cancelled',
        ...batch,
        durations: Object.freeze(durations),
      });
    }
    return Object.freeze({
      kind: 'submissionFailed',
      ...batch,
      diagnostics: Object.freeze([Object.freeze({
        code: 'plugin_dev_candidate_request_failed',
        message: error instanceof Error
          ? `Unable to submit the development candidate: ${error.message}`
          : 'Unable to submit the development candidate.',
      })]),
      durations: Object.freeze(durations),
    });
  }
}
