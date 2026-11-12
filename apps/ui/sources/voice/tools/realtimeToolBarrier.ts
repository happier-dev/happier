import { VoiceRealtimeToolCallV1Schema, VoiceRealtimeToolResultV1Schema, type VoiceRealtimeJsonValue, type VoiceRealtimeToolCallV1, type VoiceRealtimeToolResultV1 } from '@happier-dev/protocol/voice/realtime/events';
import { decodeVoiceToolInput } from './voiceActionExecution';
import { resolveVoiceToolExecutionFailure } from './voiceToolExecutionFailure';
import type { SpokenActionTurnOrigin } from './executeSpokenAction';

export class RealtimeToolBarrierError extends Error {
  readonly code: 'duplicate_call_id' | 'response_conflict' | 'disposed';

  constructor(code: RealtimeToolBarrierError['code']) {
    super(code);
    this.name = 'RealtimeToolBarrierError';
    this.code = code;
  }
}

export class RealtimeToolExecutionError extends Error {
  readonly resultStatus: 'denied' | 'error';
  readonly safeCode: string;

  constructor(resultStatus: RealtimeToolExecutionError['resultStatus'], safeCode: string) {
    super(safeCode);
    this.name = 'RealtimeToolExecutionError';
    this.resultStatus = resultStatus;
    this.safeCode = safeCode;
  }
}

export type RealtimeToolValidation =
  | Readonly<{ status: 'allowed'; call?: VoiceRealtimeToolCallV1 }>
  | Readonly<{ status: 'rejected'; code?: string }>;

export type RealtimeToolEffectClass = 'read_only' | 'mutation' | 'external';

export type RealtimeToolBarrierResult = Readonly<{
  /**
   * `detached` is a delivery-only interruption. Completed results stay
   * attempt-owned so the controller can redeliver them with current redaction
   * only after the provider has proven that its response/call identity holds.
   */
  status: 'submitted' | 'cancelled' | 'detached' | 'failed';
  results: readonly VoiceRealtimeToolResultV1[];
}>;

// The wire failure envelope excludes output. Keep its already-redacted owner
// value with the retained result so later delivery can refresh privacy and
// derive the same human outcome without reconstructing or retaining raw data.
type RetainedToolResult = Readonly<{
  result: VoiceRealtimeToolResultV1;
  redactedFailure?: unknown;
}>;

type RetainedBarrierResult = Readonly<{
  status: RealtimeToolBarrierResult['status'];
  results: readonly RetainedToolResult[];
}>;

function publicBarrierResult(value: RetainedBarrierResult): RealtimeToolBarrierResult {
  return Object.freeze({ status: value.status, results: Object.freeze(value.results.map(({ result }) => result)) });
}

type RealtimeToolBarrierDeps = Readonly<{
  validateCall?: (call: VoiceRealtimeToolCallV1) => RealtimeToolValidation;
  classifyCall?: (call: VoiceRealtimeToolCallV1) => RealtimeToolEffectClass;
  executeCall: (call: VoiceRealtimeToolCallV1, signal: AbortSignal, turnOrigin: SpokenActionTurnOrigin) => Promise<unknown>;
  redactResult: (value: unknown, call: VoiceRealtimeToolCallV1) => unknown;
  summarizeResult?: (redactedValue: unknown, call: VoiceRealtimeToolCallV1) => string | null;
  submitResults: (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    signal: AbortSignal,
  ) => Promise<void>;
  continueResponse: (responseId: string, signal: AbortSignal, turnOrigin: SpokenActionTurnOrigin) => Promise<void>;
}>;

type ResponseRecord = {
  fingerprint: string;
  calls: readonly VoiceRealtimeToolCallV1[];
  turnOrigin: SpokenActionTurnOrigin;
  /** Terminal attempt/call cancellation; never used for a transport detach. */
  controller: AbortController;
  /** The current provider-delivery leg, independently abortable on detach. */
  deliveryController: AbortController;
  detached: boolean;
  promise: Promise<RetainedBarrierResult>;
  settled: boolean;
};

type EffectOutcomeRecord = {
  fingerprint: string;
  promise: Promise<RetainedToolResult>;
  result: RetainedToolResult | null;
};

const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

function isJsonArray(value: VoiceRealtimeJsonValue): value is readonly VoiceRealtimeJsonValue[] {
  return Array.isArray(value);
}

function stableJson(value: VoiceRealtimeJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`;
}

function sortCalls(calls: readonly VoiceRealtimeToolCallV1[]): VoiceRealtimeToolCallV1[] {
  return [...calls].sort((left, right) => left.order - right.order || left.callId.localeCompare(right.callId));
}

function responseFingerprint(calls: readonly VoiceRealtimeToolCallV1[]): string {
  const value: readonly VoiceRealtimeJsonValue[] = calls.map((call) => ({
    v: call.v,
    responseId: call.responseId,
    callId: call.callId,
    toolName: call.toolName,
    order: call.order,
    arguments: call.arguments,
  }));
  return stableJson(value);
}

function effectFingerprint(call: VoiceRealtimeToolCallV1): string {
  return stableJson({
    toolName: call.toolName,
    arguments: call.arguments,
  });
}

function projectResultToCall(
  retained: RetainedToolResult,
  call: VoiceRealtimeToolCallV1,
): RetainedToolResult {
  return { ...retained, result: VoiceRealtimeToolResultV1Schema.parse({
    ...retained.result,
    responseId: call.responseId,
    callId: call.callId,
    toolName: call.toolName,
    order: call.order,
  }) };
}

function terminalResult(
  call: VoiceRealtimeToolCallV1,
  status: 'denied' | 'cancelled' | 'error',
  errorCode: string,
): RetainedToolResult {
  const fallbackCode = status === 'denied'
    ? 'permission_denied'
    : status === 'cancelled'
      ? 'tool_cancelled'
      : 'tool_failed';
  const safeErrorCode = SAFE_ERROR_CODE_PATTERN.test(errorCode) ? errorCode : fallbackCode;
  return { result: VoiceRealtimeToolResultV1Schema.parse({
    v: 1,
    responseId: call.responseId,
    callId: call.callId,
    toolName: call.toolName,
    order: call.order,
    status,
    errorCode: safeErrorCode,
  }) };
}

async function raceWithAbort<T>(startOperation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const onAbort = () => rejectAbort?.(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([startOperation(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    rejectAbort = null;
  }
}

export function createRealtimeToolBarrier(deps: RealtimeToolBarrierDeps) {
  const responses = new Map<string, ResponseRecord>();
  const effectOutcomes = new Map<string, EffectOutcomeRecord>();
  let disposed = false;

  const redactFailure = (
    call: VoiceRealtimeToolCallV1,
    status: VoiceRealtimeToolResultV1['status'],
    value: unknown,
  ): RetainedToolResult => {
    try {
      const projected = deps.redactResult(value, call);
      const failure = projected !== null && typeof projected === 'object' && !Array.isArray(projected)
        ? projected : null;
      const projectedErrorCode = failure === null ? undefined : Reflect.get(failure, 'errorCode');
      const errorDetails = failure === null ? undefined : Reflect.get(failure, 'details');
      const summary = deps.summarizeResult?.(projected, call);
      return { redactedFailure: projected, result: VoiceRealtimeToolResultV1Schema.parse({
        v: 1, responseId: call.responseId, callId: call.callId, toolName: call.toolName,
        order: call.order, status, errorCode: projectedErrorCode,
        ...(errorDetails === undefined ? {} : { errorDetails }),
        ...(summary ? { summary } : {}),
      }) };
    } catch {
      return terminalResult(call, 'error', 'redaction_failed');
    }
  };

  const projectSuccess = (call: VoiceRealtimeToolCallV1, value: unknown): RetainedToolResult => {
    const output = deps.redactResult(value, call);
    const summary = deps.summarizeResult?.(output, call);
    return { result: VoiceRealtimeToolResultV1Schema.parse({ v: 1, responseId: call.responseId, callId: call.callId,
      toolName: call.toolName, order: call.order, status: 'success', output, ...(summary ? { summary } : {}),
    }) };
  };

  const resetDeliveryController = (record: ResponseRecord): void => {
    record.deliveryController.abort();
    const deliveryController = new AbortController();
    if (record.controller.signal.aborted) deliveryController.abort();
    else record.controller.signal.addEventListener(
      'abort',
      () => deliveryController.abort(),
      { once: true },
    );
    record.deliveryController = deliveryController;
  };

  const redactCompletedResults = (
    results: readonly RetainedToolResult[],
    calls: readonly VoiceRealtimeToolCallV1[],
  ): readonly RetainedToolResult[] => Object.freeze(results.map((retained, index) => {
    const call = calls[index]!;
    const result = retained.result;
    if (result.status !== 'success') {
      return redactFailure(call, result.status, retained.redactedFailure ?? {
        ok: false, errorCode: result.errorCode,
        ...(result.errorDetails === undefined ? {} : { details: result.errorDetails }),
      });
    }
    try {
      return projectSuccess(call, result.output);
    } catch {
      return terminalResult(call, 'error', 'redaction_failed');
    }
  }));

  const submitCompletedResults = async (
    responseId: string,
    results: readonly RetainedToolResult[],
    record: ResponseRecord,
  ): Promise<RetainedBarrierResult> => {
    const redactedResults = redactCompletedResults(results, record.calls);
    const executionSignal = record.controller.signal;
    const deliverySignal = record.deliveryController.signal;
    const deliveryDetached = (): boolean => record.detached && !executionSignal.aborted;
    if (executionSignal.aborted) return Object.freeze({ status: 'cancelled', results: redactedResults });
    if (deliveryDetached()) return Object.freeze({ status: 'detached', results: redactedResults });
    try {
      await raceWithAbort(
        () => deps.submitResults(responseId, redactedResults.map(({ result }) => result), deliverySignal),
        deliverySignal,
      );
      if (executionSignal.aborted) return Object.freeze({ status: 'cancelled', results: redactedResults });
      if (deliveryDetached()) return Object.freeze({ status: 'detached', results: redactedResults });
      await raceWithAbort(
        () => deps.continueResponse(responseId, deliverySignal, record.turnOrigin),
        deliverySignal,
      );
      if (executionSignal.aborted) return Object.freeze({ status: 'cancelled', results: redactedResults });
      if (deliveryDetached()) return Object.freeze({ status: 'detached', results: redactedResults });
      return Object.freeze({ status: 'submitted', results: redactedResults });
    } catch {
      if (executionSignal.aborted) return Object.freeze({ status: 'cancelled', results: redactedResults });
      if (deliveryDetached()) return Object.freeze({ status: 'detached', results: redactedResults });
      return Object.freeze({ status: 'failed', results: redactedResults });
    }
  };

  const executeOne = async (
    call: VoiceRealtimeToolCallV1,
    responseSignal: AbortSignal,
    turnOrigin: SpokenActionTurnOrigin,
  ): Promise<RetainedToolResult> => {
    const validation = deps.validateCall?.(call) ?? (() => {
      const input = decodeVoiceToolInput(call.toolName, call.arguments);
      return input ? { status: 'allowed' as const, call: { ...call, ...input } }
        : { status: 'rejected' as const, code: 'invalid_tool_call' };
    })();
    if (validation.status === 'rejected') {
      return terminalResult(call, 'error', validation.code ?? 'invalid_tool_call');
    }
    const admittedCall = validation.call ?? call;
    const controller = new AbortController();
    const abort = () => controller.abort();
    responseSignal.addEventListener('abort', abort, { once: true });
    try {
      const effectClass = deps.classifyCall?.(admittedCall) ?? 'read_only';
      const executeAndRedact = async (): Promise<RetainedToolResult> => {
        try {
          const rawResult = await deps.executeCall(admittedCall, controller.signal, turnOrigin);
          try {
            if (rawResult !== null && typeof rawResult === 'object' && Reflect.get(rawResult, 'ok') === false) {
              const errorCode: unknown = Reflect.get(rawResult, 'errorCode');
              return redactFailure(admittedCall, 'error', { ...rawResult,
                errorCode: typeof errorCode === 'string' && errorCode ? errorCode : 'tool_failed' });
            }
            return projectSuccess(admittedCall, rawResult);
          } catch {
            return terminalResult(call, 'error', 'redaction_failed');
          }
        } catch (error) {
          if (error instanceof RealtimeToolExecutionError) {
            return terminalResult(call, error.resultStatus, error.safeCode);
          }
          const failure = resolveVoiceToolExecutionFailure(error, effectClass !== 'read_only');
          return redactFailure(admittedCall, 'error', failure);
        }
      };

      let execution: Promise<RetainedToolResult>;
      let effectOutcome: EffectOutcomeRecord | null = null;
      if (effectClass === 'read_only') {
        execution = executeAndRedact();
      } else {
        const fingerprint = effectFingerprint(call);
        const existingOutcome = effectOutcomes.get(call.callId);
        if (existingOutcome) {
          if (existingOutcome.fingerprint !== fingerprint) {
            return terminalResult(call, 'error', 'tool_call_identity_conflict');
          }
          effectOutcome = existingOutcome;
          execution = effectOutcome.promise;
        } else {
          const initialExecution = executeAndRedact();
          const record: EffectOutcomeRecord = {
            fingerprint,
            promise: initialExecution,
            result: null,
          };
          record.promise = initialExecution.then((result) => {
            record.result = result;
            return result;
          });
          effectOutcome = record;
          effectOutcomes.set(call.callId, record);
          execution = record.promise;
        }
      }

      try {
        const result = await raceWithAbort(() => execution, controller.signal);
        if (responseSignal.aborted && !effectOutcome) {
          return terminalResult(call, 'cancelled', 'tool_cancelled');
        }
        return projectResultToCall(result, call);
      } catch (error) {
        if (effectOutcome?.result) {
          return projectResultToCall(effectOutcome.result, call);
        }
        throw error;
      }
    } catch (error) {
      if (responseSignal.aborted) return terminalResult(call, 'cancelled', 'tool_cancelled');
      if (error instanceof RealtimeToolExecutionError) {
        return terminalResult(call, error.resultStatus, error.safeCode);
      }
      return terminalResult(call, 'error', 'tool_failed');
    } finally {
      responseSignal.removeEventListener('abort', abort);
      controller.abort();
    }
  };

  const executeResponse = async (
    responseId: string,
    calls: readonly VoiceRealtimeToolCallV1[],
    record: ResponseRecord,
  ): Promise<RetainedBarrierResult> => {
    const controller = record.controller;
    const retainedEffectResults = (): readonly RetainedToolResult[] => Object.freeze(
      calls.flatMap((call) => {
        const outcome = effectOutcomes.get(call.callId);
        if (!outcome || outcome.fingerprint !== effectFingerprint(call) || !outcome.result) return [];
        return [projectResultToCall(outcome.result, call)];
      }),
    );
    if (controller.signal.aborted) {
      return Object.freeze({ status: 'cancelled', results: Object.freeze([]) });
    }
    const completedResults = await Promise.all(calls.map(async (call) => await executeOne(call, controller.signal, record.turnOrigin)));
    if (controller.signal.aborted) {
      return Object.freeze({ status: 'cancelled', results: retainedEffectResults() });
    }
    const submission = await submitCompletedResults(responseId, completedResults, record);
    if (submission.status === 'cancelled') {
      return Object.freeze({ status: 'cancelled', results: retainedEffectResults() });
    }
    return submission;
  };

  const run = async (input: Readonly<{
    responseId: string;
    calls: readonly unknown[];
    signal?: AbortSignal | null;
    turnOrigin?: SpokenActionTurnOrigin;
  }>): Promise<RealtimeToolBarrierResult> => {
    if (disposed) throw new RealtimeToolBarrierError('disposed');
    const responseId = input.responseId;
    const calls = sortCalls(input.calls.map((raw) => VoiceRealtimeToolCallV1Schema.parse(raw)));
    if (!responseId || responseId.trim() !== responseId || calls.some((call) => call.responseId !== responseId)) {
      throw new RealtimeToolBarrierError('response_conflict');
    }
    const callIds = new Set<string>();
    for (const call of calls) {
      if (callIds.has(call.callId)) throw new RealtimeToolBarrierError('duplicate_call_id');
      callIds.add(call.callId);
    }
    const fingerprint = responseFingerprint(calls);
    const existing = responses.get(responseId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RealtimeToolBarrierError('response_conflict');
      // Each proven duplicate delivery needs its own result (SDK callbacks
      // can be concurrent). Serialize delivery, not execution, and reapply
      // current privacy to the canonical retained result every time.
      const abort = () => existing.controller.abort();
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener('abort', abort, { once: true });
      existing.settled = false;
      const replay = existing.promise.then(async (previous) => {
        if (previous.status === 'cancelled' || existing.controller.signal.aborted) return previous;
        existing.detached = false;
        resetDeliveryController(existing);
        return await submitCompletedResults(responseId, previous.results, existing);
      }).then((result) => {
        if (result.status === 'cancelled' && responses.get(responseId) === existing) {
          responses.delete(responseId);
        }
        return result;
      }).finally(() => {
        input.signal?.removeEventListener('abort', abort);
        if (existing.promise === replay) existing.settled = true;
      });
      existing.promise = replay;
      return publicBarrierResult(await replay);
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const record: ResponseRecord = {
      fingerprint,
      calls,
      turnOrigin: input.turnOrigin ?? 'synthetic',
      controller,
      deliveryController: new AbortController(),
      detached: false,
      settled: false,
      promise: Promise.resolve({ status: 'cancelled', results: [] }),
    };
    resetDeliveryController(record);
    const response = executeResponse(responseId, calls, record)
      .then((result) => {
        if (record.promise === response) record.settled = true;
        if (result.status === 'cancelled' && responses.get(responseId) === record) {
          responses.delete(responseId);
        }
        return result;
      })
      .finally(() => {
        if (record.promise === response) record.settled = true;
        input.signal?.removeEventListener('abort', abort);
      });
    record.promise = response;
    responses.set(responseId, record);
    return publicBarrierResult(await record.promise);
  };

  return Object.freeze({
    run,
    /**
     * A reconnect loses only this provider delivery leg. It must not abort
     * execution: completed results remain in this attempt-local response
     * record until the controller can prove same-call resumption.
     */
    detach: (responseId: string): boolean => {
      const record = responses.get(responseId);
      if (!record || record.settled) return false;
      record.detached = true;
      record.deliveryController.abort();
      return true;
    },
    /** Terminal response cancellation, distinct from a transport detach. */
    cancel: (responseId: string): boolean => {
      const record = responses.get(responseId);
      if (!record || record.settled) return false;
      record.controller.abort();
      return true;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const record of responses.values()) record.controller.abort();
      responses.clear();
      effectOutcomes.clear();
    },
  });
}
