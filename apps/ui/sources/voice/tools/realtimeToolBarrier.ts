import {
  VoiceAssistantActionSchema,
  VoiceRealtimeJsonValueSchema,
  VoiceRealtimeToolCallV1Schema,
  VoiceRealtimeToolResultV1Schema,
  type VoiceRealtimeJsonValue,
  type VoiceRealtimeToolCallV1,
  type VoiceRealtimeToolResultV1,
} from '@happier-dev/protocol';

export class RealtimeToolBarrierError extends Error {
  readonly code: 'duplicate_call_id' | 'response_conflict' | 'too_many_calls' | 'capacity_exceeded' | 'disposed';

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

export type RealtimeToolAuthorization =
  | Readonly<{ status: 'allowed' }>
  | Readonly<{ status: 'denied'; code?: string }>;

export type RealtimeToolValidation =
  | Readonly<{ status: 'allowed' }>
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

type RealtimeToolBarrierDeps = Readonly<{
  validateCall?: (call: VoiceRealtimeToolCallV1) => RealtimeToolValidation;
  classifyCall?: (call: VoiceRealtimeToolCallV1) => RealtimeToolEffectClass;
  authorizeCall: (call: VoiceRealtimeToolCallV1, signal: AbortSignal) => Promise<RealtimeToolAuthorization>;
  executeCall: (call: VoiceRealtimeToolCallV1, signal: AbortSignal) => Promise<unknown>;
  redactResult: (value: unknown, call: VoiceRealtimeToolCallV1) => unknown;
  submitResults: (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    signal: AbortSignal,
  ) => Promise<void>;
  continueResponse: (responseId: string, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxResponses?: number;
  maxCallsPerResponse?: number;
}>;

type ResponseRecord = {
  fingerprint: string;
  calls: readonly VoiceRealtimeToolCallV1[];
  /** Terminal attempt/call cancellation; never used for a transport detach. */
  controller: AbortController;
  /** The current provider-delivery leg, independently abortable on detach. */
  deliveryController: AbortController;
  detached: boolean;
  promise: Promise<RealtimeToolBarrierResult>;
  settled: boolean;
  result: RealtimeToolBarrierResult | null;
};

type EffectOutcomeRecord = {
  fingerprint: string;
  promise: Promise<VoiceRealtimeToolResultV1>;
  result: VoiceRealtimeToolResultV1 | null;
};

const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.floor(Number(value))) : fallback;
}

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
  result: VoiceRealtimeToolResultV1,
  call: VoiceRealtimeToolCallV1,
): VoiceRealtimeToolResultV1 {
  return VoiceRealtimeToolResultV1Schema.parse({
    ...result,
    responseId: call.responseId,
    callId: call.callId,
    toolName: call.toolName,
    order: call.order,
  });
}

function terminalResult(
  call: VoiceRealtimeToolCallV1,
  status: Exclude<VoiceRealtimeToolResultV1['status'], 'success'>,
  errorCode: string,
): VoiceRealtimeToolResultV1 {
  const fallbackCode = status === 'denied'
    ? 'permission_denied'
    : status === 'cancelled'
      ? 'tool_cancelled'
      : status === 'timeout'
        ? 'tool_timeout'
        : 'tool_failed';
  const safeErrorCode = SAFE_ERROR_CODE_PATTERN.test(errorCode) ? errorCode : fallbackCode;
  return VoiceRealtimeToolResultV1Schema.parse({
    v: 1,
    responseId: call.responseId,
    callId: call.callId,
    toolName: call.toolName,
    order: call.order,
    status,
    errorCode: safeErrorCode,
  });
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
  const timeoutMs = clampPositiveInteger(deps.timeoutMs, 30_000);
  const maxResponses = clampPositiveInteger(deps.maxResponses, 128);
  const maxCallsPerResponse = clampPositiveInteger(deps.maxCallsPerResponse, 64);
  const responses = new Map<string, ResponseRecord>();
  const effectOutcomes = new Map<string, EffectOutcomeRecord>();
  let disposed = false;

  const evictSettledResponses = (targetSize: number): void => {
    if (responses.size <= targetSize) return;
    for (const [responseId, record] of responses) {
      // A failed delivery still owns a completed result.
      // Keep that bounded same-call custody until it is redelivered or the
      // attempt disposes; evicting it would turn a replay into re-execution.
      if (
        !record.settled
        || record.result?.status === 'failed'
        || record.result?.status === 'detached'
      ) continue;
      responses.delete(responseId);
      if (responses.size <= targetSize) return;
    }
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
    results: readonly VoiceRealtimeToolResultV1[],
    calls: readonly VoiceRealtimeToolCallV1[],
  ): readonly VoiceRealtimeToolResultV1[] => Object.freeze(results.map((result, index) => {
    if (result.status !== 'success') return result;
    const call = calls[index]!;
    try {
      const output = VoiceRealtimeJsonValueSchema.parse(deps.redactResult(result.output, call));
      return VoiceRealtimeToolResultV1Schema.parse({ ...result, output });
    } catch {
      return terminalResult(call, 'error', 'redaction_failed');
    }
  }));

  const submitCompletedResults = async (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    record: ResponseRecord,
  ): Promise<RealtimeToolBarrierResult> => {
    const redactedResults = redactCompletedResults(results, record.calls);
    const executionSignal = record.controller.signal;
    const deliverySignal = record.deliveryController.signal;
    const deliveryDetached = (): boolean => record.detached && !executionSignal.aborted;
    if (executionSignal.aborted) return Object.freeze({ status: 'cancelled', results: redactedResults });
    if (deliveryDetached()) return Object.freeze({ status: 'detached', results: redactedResults });
    try {
      await raceWithAbort(
        () => deps.submitResults(responseId, redactedResults, deliverySignal),
        deliverySignal,
      );
      if (executionSignal.aborted) return Object.freeze({ status: 'cancelled', results: redactedResults });
      if (deliveryDetached()) return Object.freeze({ status: 'detached', results: redactedResults });
      await raceWithAbort(
        () => deps.continueResponse(responseId, deliverySignal),
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
  ): Promise<VoiceRealtimeToolResultV1> => {
    const validation = deps.validateCall?.(call) ?? (
      VoiceAssistantActionSchema.safeParse({ t: call.toolName, args: call.arguments }).success
        ? { status: 'allowed' as const }
        : { status: 'rejected' as const, code: 'invalid_tool_call' }
    );
    if (validation.status === 'rejected') {
      return terminalResult(call, 'error', validation.code ?? 'invalid_tool_call');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    responseSignal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const authorization = await raceWithAbort(
        () => deps.authorizeCall(call, controller.signal),
        controller.signal,
      );
      if (authorization.status === 'denied') {
        return terminalResult(call, 'denied', authorization.code ?? 'permission_denied');
      }
      const effectClass = deps.classifyCall?.(call) ?? 'read_only';
      const executeAndRedact = async (): Promise<VoiceRealtimeToolResultV1> => {
        try {
          const rawResult = effectClass === 'external'
            ? await raceWithAbort(() => deps.executeCall(call, controller.signal), controller.signal)
            : await deps.executeCall(call, controller.signal);
          let redacted: VoiceRealtimeJsonValue;
          try {
            redacted = VoiceRealtimeJsonValueSchema.parse(deps.redactResult(rawResult, call));
          } catch {
            return terminalResult(call, 'error', 'redaction_failed');
          }
          return VoiceRealtimeToolResultV1Schema.parse({
            v: 1,
            responseId: call.responseId,
            callId: call.callId,
            toolName: call.toolName,
            order: call.order,
            status: 'success',
            output: redacted,
          });
        } catch (error) {
          if (effectClass !== 'read_only' && (controller.signal.aborted || !(error instanceof RealtimeToolExecutionError))) {
            return terminalResult(call, 'error', 'outcome_unknown');
          }
          if (timedOut) return terminalResult(call, 'timeout', 'tool_timeout');
          if (error instanceof RealtimeToolExecutionError) {
            return terminalResult(call, error.resultStatus, error.safeCode);
          }
          return terminalResult(call, 'error', 'tool_failed');
        }
      };

      let execution: Promise<VoiceRealtimeToolResultV1>;
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
        if (effectClass === 'external' && effectOutcome && (responseSignal.aborted || timedOut)) {
          return projectResultToCall(await effectOutcome.promise, call);
        }
        throw error;
      }
    } catch (error) {
      if (responseSignal.aborted) return terminalResult(call, 'cancelled', 'tool_cancelled');
      if (timedOut) return terminalResult(call, 'timeout', 'tool_timeout');
      if (error instanceof RealtimeToolExecutionError) {
        return terminalResult(call, error.resultStatus, error.safeCode);
      }
      return terminalResult(call, 'error', 'tool_failed');
    } finally {
      clearTimeout(timer);
      responseSignal.removeEventListener('abort', abort);
      controller.abort();
    }
  };

  const executeResponse = async (
    responseId: string,
    calls: readonly VoiceRealtimeToolCallV1[],
    record: ResponseRecord,
  ): Promise<RealtimeToolBarrierResult> => {
    const controller = record.controller;
    const retainedEffectResults = (): readonly VoiceRealtimeToolResultV1[] => Object.freeze(
      calls.flatMap((call) => {
        const outcome = effectOutcomes.get(call.callId);
        if (!outcome || outcome.fingerprint !== effectFingerprint(call) || !outcome.result) return [];
        return [projectResultToCall(outcome.result, call)];
      }),
    );
    if (controller.signal.aborted) {
      return Object.freeze({ status: 'cancelled', results: Object.freeze([]) });
    }
    const completedResults = await Promise.all(calls.map(async (call) => await executeOne(call, controller.signal)));
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
  }>): Promise<RealtimeToolBarrierResult> => {
    if (disposed) throw new RealtimeToolBarrierError('disposed');
    const responseId = input.responseId;
    if (input.calls.length > maxCallsPerResponse) {
      throw new RealtimeToolBarrierError('too_many_calls');
    }
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
      if (
        existing.settled
        && (existing.result?.status === 'failed' || existing.result?.status === 'detached')
      ) {
        // The controller calls `run` again only after the provider has proven
        // same-response custody on a resumed transport. Reapply current
        // redaction to its retained result without re-entering authorization
        // or execution.
        existing.detached = false;
        resetDeliveryController(existing);
        existing.settled = false;
        existing.promise = submitCompletedResults(
          responseId,
          existing.result.results,
          existing,
        ).then((result) => {
          existing.result = result;
          existing.settled = true;
          if (result.status === 'cancelled' && responses.get(responseId) === existing) {
            responses.delete(responseId);
          }
          return result;
        }).finally(() => {
          existing.settled = true;
          evictSettledResponses(maxResponses);
        });
      }
      return await existing.promise;
    }

    evictSettledResponses(maxResponses - 1);
    if (responses.size >= maxResponses) {
      throw new RealtimeToolBarrierError('capacity_exceeded');
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const record: ResponseRecord = {
      fingerprint,
      calls,
      controller,
      deliveryController: new AbortController(),
      detached: false,
      settled: false,
      result: null,
      promise: Promise.resolve({ status: 'cancelled', results: [] }),
    };
    resetDeliveryController(record);
    record.promise = executeResponse(responseId, calls, record)
      .then((result) => {
        record.settled = true;
        record.result = result;
        if (result.status === 'cancelled' && responses.get(responseId) === record) {
          responses.delete(responseId);
        }
        return result;
      })
      .finally(() => {
        record.settled = true;
        input.signal?.removeEventListener('abort', abort);
        evictSettledResponses(maxResponses);
      });
    responses.set(responseId, record);
    return await record.promise;
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
