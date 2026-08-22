import {
  getPluginHookDefinitionV1,
  readHookEventEnvelopeV1,
  validatePluginHookPayloadV1,
  validatePluginHookResultV1,
  type PluginHookDecisionResultV1,
  type PluginHookAggregationKindV1,
  type PluginHookFailureModeV1,
  type HookEventEnvelopeV1,
} from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import type { ResolvedActivationTarget } from '@/plugins/projection/registry/types';

import {
  matchesHookDefinitionFilters,
  matchesHookRegistrationFilters,
} from '@/plugins/projection/hooks/matchesHookRegistrationFilters';
import { logger } from '@/ui/logger';

export type DispatchedPluginHookOutcomeV1 = Readonly<{
  pluginId: string;
  /** Registration-local identity when the dispatcher can correlate an outcome. */
  localId?: string;
  hookId: string;
  status: 'fulfilled' | 'rejected';
  result?: unknown;
  error?: string;
}>;

export type DispatchPluginHookEventResultV1 = Readonly<{
  eventId: string | null;
  matchedHandlerCount: number;
  outcomes: readonly DispatchedPluginHookOutcomeV1[];
  validationError?: string;
  aggregate?: Readonly<{
    executionKind: string;
    result: unknown;
  }>;
  interception?: Readonly<
    | { status: 'continued'; input: unknown }
    | { status: 'rejected'; code?: string; message?: string }
  >;
}>;

export type PluginHookDispatchObservationV1 = Readonly<{
  pluginId: string;
  hookId: string;
  status: DispatchedPluginHookOutcomeV1['status'];
  durationMs: number;
  error?: string;
}>;

type HookRuntimeRegistry = Pick<
  ResolvedExecutablePluginRuntimeRegistry,
  'hookHandlersByHookId'
> & Readonly<{
  activateContributionsOnDemand?: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'];
  contributes?: Readonly<{
    activationTargets?: readonly ResolvedActivationTarget[];
  }>;
}>;

type PluginHookFailureClassification =
  | 'plugin_hook_handler_failed'
  | 'plugin_hook_handler_timed_out'
  | 'plugin_hook_handler_cancelled'
  | 'plugin_hook_result_invalid';

class PluginHookHandlerTimeoutError extends Error {
  constructor() {
    super('plugin_hook_handler_timed_out');
    this.name = 'PluginHookHandlerTimeoutError';
  }
}

const pluginHookHandlerTimeoutErrors = new WeakSet<object>();
const pluginHookHandlerCancelledErrors = new WeakSet<object>();

function createPluginHookHandlerCancelledError(): Error {
  const error = new Error('plugin_hook_handler_cancelled');
  error.name = 'AbortError';
  pluginHookHandlerCancelledErrors.add(error);
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function aggregateHookResults(
  outcomes: readonly DispatchedPluginHookOutcomeV1[],
  executionKind: string | null,
  aggregation: PluginHookAggregationKindV1 | null,
  failureMode: PluginHookFailureModeV1 | null,
  replacementPayload?: unknown,
): DispatchPluginHookEventResultV1['aggregate'] {
  if (!executionKind || !aggregation || aggregation === 'none') {
    return undefined;
  }

  const hasFailClosedRejection = failureMode === 'failClosed'
    && outcomes.some((outcome) => outcome.status === 'rejected');
  const fulfilledResults = outcomes.flatMap((outcome) => (
    outcome.status === 'fulfilled' && Object.prototype.hasOwnProperty.call(outcome, 'result')
      ? [outcome.result]
      : []
  ));

  if (aggregation === 'mergeObject') {
    return {
      executionKind,
      result: Object.freeze(
        fulfilledResults.reduce<Record<string, unknown>>((merged, result) => (
          isRecord(result) ? { ...merged, ...result } : merged
        ), {}),
      ),
    };
  }

  if (aggregation === 'firstDecision') {
    const decision = hasFailClosedRejection
      ? { decision: 'deny' as const }
      : fulfilledResults.find((result): result is PluginHookDecisionResultV1 => (
          isRecord(result)
          && (result.decision === 'allow' || result.decision === 'deny')
        )) ?? { decision: 'abstain' as const };
    return {
      executionKind,
      result: Object.freeze(decision),
    };
  }

  if (aggregation === 'allDecisions') {
    const rejected = hasFailClosedRejection
      || outcomes.some((outcome) => outcome.status === 'rejected');
    const denied = fulfilledResults.some((result) => isRecord(result) && result.decision === 'deny');
    const allowed = fulfilledResults.some((result) => isRecord(result) && result.decision === 'allow');
    return {
      executionKind,
      result: Object.freeze({ decision: denied || rejected ? 'deny' : allowed ? 'allow' : 'abstain' }),
    };
  }

  if (aggregation === 'replace') {
    return {
      executionKind,
      result: replacementPayload ?? (fulfilledResults.length > 0 ? fulfilledResults[fulfilledResults.length - 1] : null),
    };
  }

  return {
    executionKind,
    result: Object.freeze([...fulfilledResults]),
  };
}

function withHookTimeout<TResult>(params: Readonly<{
  promise: Promise<TResult>;
  timeoutMs?: number;
  timeoutController?: AbortController;
  callerSignal?: AbortSignal;
}>): Promise<TResult> {
  const timeoutMs = params.timeoutMs;
  const timeoutEnabled = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!timeoutEnabled && !params.callerSignal) {
    return params.promise;
  }
  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      params.callerSignal?.removeEventListener('abort', cancel);
      callback();
    };
    const cancel = () => finish(() => {
      const reason = params.callerSignal?.reason;
      if (reason instanceof PluginHookHandlerTimeoutError) {
        pluginHookHandlerTimeoutErrors.add(reason);
        reject(reason);
        return;
      }
      reject(createPluginHookHandlerCancelledError());
    });
    const timeout = timeoutEnabled
      ? setTimeout(() => finish(() => {
          const error = new PluginHookHandlerTimeoutError();
          pluginHookHandlerTimeoutErrors.add(error);
          params.timeoutController?.abort(error);
          reject(error);
        }), Math.trunc(timeoutMs))
      : undefined;
    timeout?.unref?.();
    if (params.callerSignal?.aborted) {
      cancel();
      return;
    }
    params.callerSignal?.addEventListener('abort', cancel, { once: true });
    params.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function createTimedHookContext(params: Readonly<{
  context: unknown;
  timeoutMs?: number;
}>): Readonly<{
  context: unknown;
  timeoutController?: AbortController;
  dispose(): void;
}> {
  const timeoutMs = params.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { context: params.context, dispose: () => {} };
  }

  const timeoutController = new AbortController();
  const source = isRecord(params.context) ? params.context : {};
  const callerSignal = source.signal instanceof AbortSignal ? source.signal : null;
  let removeCallerAbortListener = () => {};
  if (callerSignal) {
    const abortFromCaller = () => timeoutController.abort(callerSignal.reason);
    if (callerSignal.aborted) {
      abortFromCaller();
    } else {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true });
      removeCallerAbortListener = () => callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }
  return {
    context: Object.freeze({ ...source, signal: timeoutController.signal }),
    timeoutController,
    dispose: removeCallerAbortListener,
  };
}

function buildRejectedOutcome(params: Readonly<{
  pluginId: string;
  localId?: string;
  hookId: string;
  error: PluginHookFailureClassification;
}>): DispatchedPluginHookOutcomeV1 {
  return {
    pluginId: params.pluginId,
    ...(params.localId ? { localId: params.localId } : {}),
    hookId: params.hookId,
    status: 'rejected',
    error: params.error,
  };
}

function classifyPluginHookHandlerFailure(error: unknown): PluginHookFailureClassification {
  if ((typeof error === 'object' && error !== null && pluginHookHandlerCancelledErrors.has(error))
    || (isRecord(error) && error.name === 'AbortError')) {
    return 'plugin_hook_handler_cancelled';
  }
  return typeof error === 'object'
    && error !== null
    && pluginHookHandlerTimeoutErrors.has(error)
    ? 'plugin_hook_handler_timed_out'
    : 'plugin_hook_handler_failed';
}

function isExecutionInterceptionBeforeHook(hookId: string): hookId is 'action.execute.before' | 'agent.tool.execute.before' {
  return hookId === 'action.execute.before' || hookId === 'agent.tool.execute.before';
}

function applyExecutionInterceptionInput(params: Readonly<{
  hookId: 'action.execute.before' | 'agent.tool.execute.before';
  payload: unknown;
  input: unknown;
}>): unknown {
  if (!isRecord(params.payload)) return params.payload;
  if (params.hookId === 'action.execute.before') {
    return Object.freeze({ ...params.payload, input: params.input });
  }
  const tool = isRecord(params.payload.tool) ? params.payload.tool : {};
  return Object.freeze({
    ...params.payload,
    tool: Object.freeze({ ...tool, input: params.input }),
  });
}

async function publishHookObservation(params: Readonly<{
  observation: PluginHookDispatchObservationV1;
  publishHookObservation?: (record: PluginHookDispatchObservationV1) => Promise<void> | void;
}>): Promise<void> {
  try {
    if (params.publishHookObservation) {
      await params.publishHookObservation(params.observation);
      return;
    }
  } catch (error) {
    logger.debug('[plugins] Failed to publish plugin hook observation', {
      pluginId: params.observation.pluginId,
      hookId: params.observation.hookId,
      error: 'plugin_hook_observation_publish_failed',
    });
  }
}

function logRejectedHookOutcome(outcome: DispatchedPluginHookOutcomeV1): void {
  if (outcome.status !== 'rejected') {
    return;
  }
  logger.debug('[plugins] Plugin hook handler failed', {
    pluginId: outcome.pluginId,
    hookId: outcome.hookId,
    error: outcome.error,
  });
}

function shouldStopDispatchAfterOutcome(params: Readonly<{
  aggregation: PluginHookAggregationKindV1 | null;
  failureMode: PluginHookFailureModeV1 | null;
  outcome: DispatchedPluginHookOutcomeV1;
}>): boolean {
  if (params.outcome.status === 'rejected' && params.failureMode === 'failClosed') {
    return true;
  }
  if (params.outcome.status === 'fulfilled' && params.aggregation === 'firstDecision') {
    return isRecord(params.outcome.result)
      && (params.outcome.result.decision === 'allow' || params.outcome.result.decision === 'deny');
  }
  return false;
}

function buildCurrentHookDeclarationKey(pluginId: string, localId: string): string {
  return `current\0${pluginId}\0${localId}`;
}

function createAggregateDispatchContext(params: Readonly<{
  context: unknown;
  timeoutMs?: number;
}>): Readonly<{
  context: unknown;
  dispose(): void;
}> {
  const timeoutMs = params.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { context: params.context, dispose: () => {} };
  }
  const source = isRecord(params.context) ? params.context : {};
  const callerSignal = source.signal instanceof AbortSignal ? source.signal : null;
  const aggregateController = new AbortController();
  const abortFromCaller = () => aggregateController.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    aggregateController.abort(new PluginHookHandlerTimeoutError());
  }, Math.trunc(timeoutMs));
  timeout.unref?.();
  return {
    context: Object.freeze({ ...source, signal: aggregateController.signal }),
    dispose() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

async function dispatchConcurrentHandler(params: Readonly<{
  handler: ResolvedPluginHookHandler;
  envelope: HookEventEnvelopeV1;
  context: unknown;
  handlerTimeoutMs?: number;
  buildHandlerEvent?: (params: Readonly<{
    handler: ResolvedPluginHookHandler;
    envelope: HookEventEnvelopeV1;
  }>) => HookEventEnvelopeV1;
  publishHookObservation?: (record: PluginHookDispatchObservationV1) => Promise<void> | void;
}>): Promise<DispatchedPluginHookOutcomeV1> {
  const startedAtMs = Date.now();
  let outcome: DispatchedPluginHookOutcomeV1;
  try {
    const dispatchEnvelope = params.buildHandlerEvent
      ? params.buildHandlerEvent({ handler: params.handler, envelope: params.envelope })
      : params.envelope;
    const payloadValidation = validatePluginHookPayloadV1({
      hookId: dispatchEnvelope.eventId,
      payload: dispatchEnvelope.payload,
    });
    if (!payloadValidation.success) {
      outcome = buildRejectedOutcome({
        pluginId: params.handler.pluginId,
        ...(params.handler.localId ? { localId: params.handler.localId } : {}),
        hookId: params.handler.hookId,
        error: 'plugin_hook_result_invalid',
      });
    } else {
      const timedContext = createTimedHookContext({
        context: params.context,
        timeoutMs: params.handlerTimeoutMs,
      });
      try {
        const timedContextRecord = isRecord(timedContext.context) ? timedContext.context : {};
        const cancellationSignal = timedContextRecord.signal instanceof AbortSignal
          ? timedContextRecord.signal
          : undefined;
        // Invocations begin together through Promise.all below. A synchronous trusted
        // in-process handler can still monopolize the event loop; the host can cancel
        // asynchronous work but cannot preempt that CPU work.
        const result = await withHookTimeout({
          promise: Promise.resolve().then(async () => await params.handler.handler(dispatchEnvelope, timedContext.context)),
          timeoutMs: params.handlerTimeoutMs,
          timeoutController: timedContext.timeoutController,
          ...(cancellationSignal ? { callerSignal: cancellationSignal } : {}),
        });
        const resultValidation = validatePluginHookResultV1({
          hookId: dispatchEnvelope.eventId,
          result,
        });
        outcome = resultValidation.success
          ? {
              pluginId: params.handler.pluginId,
              ...(params.handler.localId ? { localId: params.handler.localId } : {}),
              hookId: params.handler.hookId,
              status: 'fulfilled',
              ...(typeof resultValidation.result === 'undefined' ? {} : { result: resultValidation.result }),
            }
          : buildRejectedOutcome({
              pluginId: params.handler.pluginId,
              ...(params.handler.localId ? { localId: params.handler.localId } : {}),
              hookId: params.handler.hookId,
              error: 'plugin_hook_result_invalid',
            });
      } finally {
        timedContext.dispose();
      }
    }
  } catch (error) {
    outcome = buildRejectedOutcome({
      pluginId: params.handler.pluginId,
      ...(params.handler.localId ? { localId: params.handler.localId } : {}),
      hookId: params.handler.hookId,
      error: classifyPluginHookHandlerFailure(error),
    });
  }
  if (outcome.status === 'rejected') {
    logRejectedHookOutcome(outcome);
  }
  await publishHookObservation({
    observation: {
      pluginId: outcome.pluginId,
      hookId: outcome.hookId,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      durationMs: Date.now() - startedAtMs,
    },
    publishHookObservation: params.publishHookObservation,
  });
  return outcome;
}

export async function dispatchPluginHookEvent(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  event: HookEventEnvelopeV1 | unknown;
  context?: unknown;
  handlerTimeoutMs?: number;
  /**
   * The one existing dispatcher may construct a handler-scoped payload for
   * bounded contracts such as Agent composition without granting a handler a
   * shared catalog or a second dispatch path.
   */
  buildHandlerEvent?: (params: Readonly<{
    handler: ResolvedPluginHookHandler;
    envelope: HookEventEnvelopeV1;
  }>) => HookEventEnvelopeV1;
  /** Ordered-list/best-effort hooks may settle independent handlers in parallel. */
  dispatchMode?: 'sequential' | 'concurrent';
  aggregateTimeoutMs?: number;
  publishHookObservation?: (record: PluginHookDispatchObservationV1) => Promise<void> | void;
}>): Promise<DispatchPluginHookEventResultV1> {
  const envelope = readHookEventEnvelopeV1(params.event);
  if (!envelope) {
    return {
      eventId: null,
      matchedHandlerCount: 0,
      outcomes: Object.freeze([]),
    };
  }

  const hookDefinition = getPluginHookDefinitionV1(envelope.eventId);
  const payloadValidation = validatePluginHookPayloadV1({
    hookId: envelope.eventId,
    payload: envelope.payload,
  });
  if (!payloadValidation.success) {
    const executionKind = hookDefinition?.executionKind ?? null;
    const shouldFailClosed = hookDefinition?.failureMode === 'failClosed';
    return {
      eventId: envelope.eventId,
      matchedHandlerCount: 0,
      outcomes: Object.freeze([]),
      validationError: payloadValidation.message,
      ...(shouldFailClosed && executionKind
        ? {
            aggregate: {
              executionKind,
              result: Object.freeze({ decision: 'deny' as const }),
            },
          }
      : {}),
    };
  }
  const hookActivationDemands = (params.runtimeRegistry.contributes?.activationTargets ?? []).flatMap((target) => (
    target.manifest.contributes.hooks.flatMap((hook) => (
      hook.on === envelope.eventId
      && matchesHookDefinitionFilters(envelope, hook)
        ? [{ pluginId: target.pluginId, family: 'hooks', localId: hook.id }]
        : []
    ))
  ));
  await params.runtimeRegistry.activateContributionsOnDemand?.(hookActivationDemands);
  const handlers = params.runtimeRegistry.hookHandlersByHookId.get(envelope.eventId) ?? [];
  const outcomes: DispatchedPluginHookOutcomeV1[] = [];
  let matchedExecutionKind: string | null = null;
  const aggregation = hookDefinition?.aggregation ?? null;
  const failureMode = hookDefinition?.failureMode ?? null;
  const initialReplacementPayload = payloadValidation.payload;
  let currentReplacementPayload = payloadValidation.payload;
  let replacementFailed = false;
  let interception: DispatchPluginHookEventResultV1['interception'];
  const matchingCurrentFailClosedDeclarations = failureMode === 'failClosed'
    ? (params.runtimeRegistry.contributes?.activationTargets ?? []).flatMap((target) => (
        target.manifest.contributes.hooks.flatMap((declaration) => (
          declaration.on === envelope.eventId
          && matchesHookDefinitionFilters(envelope, declaration)
            ? [Object.freeze({
                key: buildCurrentHookDeclarationKey(target.pluginId, declaration.id),
                pluginId: target.pluginId,
                hookId: declaration.on,
                executionKind: declaration.executionKind,
              })]
            : []
        ))
      ))
    : [];
  const matchingFailClosedDeclarations = matchingCurrentFailClosedDeclarations;
  const matchingHandlers = handlers.filter((handler) => matchesHookRegistrationFilters(envelope, handler.registration));
  const availableRegistrationKeys = new Set(
    matchingHandlers.flatMap((handler) => (
      handler.localId
        ? [buildCurrentHookDeclarationKey(handler.pluginId, handler.localId)]
        : []
    )),
  );

  if (
    params.dispatchMode === 'concurrent'
    && aggregation !== 'replace'
    && aggregation !== 'firstDecision'
    && failureMode !== 'failClosed'
  ) {
    const aggregateContext = createAggregateDispatchContext({
      context: params.context,
      timeoutMs: params.aggregateTimeoutMs,
    });
    try {
      const concurrentOutcomes = await Promise.all(matchingHandlers.map(async (handler) => (
        await dispatchConcurrentHandler({
          handler,
          envelope,
          context: aggregateContext.context,
          handlerTimeoutMs: params.handlerTimeoutMs,
          ...(params.buildHandlerEvent ? { buildHandlerEvent: params.buildHandlerEvent } : {}),
          ...(params.publishHookObservation ? { publishHookObservation: params.publishHookObservation } : {}),
        })
      )));
      outcomes.push(...concurrentOutcomes);
      for (const handler of matchingHandlers) {
        matchedExecutionKind ??= handler.registration.definition.executionKind;
      }
    } finally {
      aggregateContext.dispose();
    }
    const aggregate = aggregateHookResults(
      outcomes,
      matchedExecutionKind,
      aggregation,
      failureMode,
    );
    return {
      eventId: envelope.eventId,
      matchedHandlerCount: outcomes.length,
      outcomes: Object.freeze([...outcomes]),
      ...(aggregate ? { aggregate } : {}),
    };
  }

  for (const handler of matchingHandlers) {
    matchedExecutionKind ??= handler.registration.definition.executionKind;
    const startedAtMs = Date.now();

    try {
      const dispatchEnvelope = aggregation === 'replace'
        ? Object.freeze({ ...envelope, payload: currentReplacementPayload })
        : envelope;
      const timedContext = createTimedHookContext({
        context: params.context,
        timeoutMs: params.handlerTimeoutMs,
      });
      let result: unknown;
      try {
        const timedContextRecord = isRecord(timedContext.context) ? timedContext.context : {};
        const cancellationSignal = timedContextRecord.signal instanceof AbortSignal
          ? timedContextRecord.signal
          : undefined;
        result = await withHookTimeout({
          promise: Promise.resolve(handler.handler(dispatchEnvelope, timedContext.context)),
          timeoutMs: params.handlerTimeoutMs,
          timeoutController: timedContext.timeoutController,
          ...(cancellationSignal ? { callerSignal: cancellationSignal } : {}),
        });
      } finally {
        timedContext.dispose();
      }
      const resultValidation = validatePluginHookResultV1({
        hookId: envelope.eventId,
        result,
      });
      if (!resultValidation.success) {
        const outcome = buildRejectedOutcome({
          pluginId: handler.pluginId,
          ...(handler.localId ? { localId: handler.localId } : {}),
          hookId: handler.hookId,
          error: 'plugin_hook_result_invalid',
        });
        outcomes.push(outcome);
        logRejectedHookOutcome(outcome);
        await publishHookObservation({
          observation: {
            pluginId: outcome.pluginId,
            hookId: outcome.hookId,
            status: outcome.status,
            error: outcome.error,
            durationMs: Date.now() - startedAtMs,
          },
          publishHookObservation: params.publishHookObservation,
        });
        if (aggregation === 'replace') {
          replacementFailed = true;
          break;
        }
        if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
          break;
        }
        continue;
      }
      if (isExecutionInterceptionBeforeHook(envelope.eventId) && isRecord(resultValidation.result)) {
        if (resultValidation.result.status === 'rejected') {
          interception = Object.freeze({
            status: 'rejected',
            ...(typeof resultValidation.result.code === 'string' ? { code: resultValidation.result.code } : {}),
            ...(typeof resultValidation.result.message === 'string' ? { message: resultValidation.result.message } : {}),
          });
          const outcome: DispatchedPluginHookOutcomeV1 = {
            pluginId: handler.pluginId,
            ...(handler.localId ? { localId: handler.localId } : {}),
            hookId: handler.hookId,
            status: 'fulfilled',
            result: resultValidation.result,
          };
          outcomes.push(outcome);
          await publishHookObservation({
            observation: {
              pluginId: outcome.pluginId,
              hookId: outcome.hookId,
              status: outcome.status,
              durationMs: Date.now() - startedAtMs,
            },
            publishHookObservation: params.publishHookObservation,
          });
          break;
        }
        if (resultValidation.result.status === 'continue') {
          currentReplacementPayload = applyExecutionInterceptionInput({
            hookId: envelope.eventId,
            payload: currentReplacementPayload,
            input: resultValidation.result.input,
          });
          interception = Object.freeze({ status: 'continued', input: resultValidation.result.input });
        }
      }
      if (aggregation === 'replace' && typeof result !== 'undefined') {
        if (!isExecutionInterceptionBeforeHook(envelope.eventId)) {
          currentReplacementPayload = resultValidation.result;
        }
      }
      const outcome: DispatchedPluginHookOutcomeV1 = {
        pluginId: handler.pluginId,
        ...(handler.localId ? { localId: handler.localId } : {}),
        hookId: handler.hookId,
        status: 'fulfilled',
        ...(aggregation === 'replace'
          ? { result: currentReplacementPayload }
          : typeof resultValidation.result === 'undefined' ? {} : { result: resultValidation.result }),
      };
      outcomes.push(outcome);
      await publishHookObservation({
        observation: {
          pluginId: outcome.pluginId,
          hookId: outcome.hookId,
          status: outcome.status,
          durationMs: Date.now() - startedAtMs,
        },
        publishHookObservation: params.publishHookObservation,
      });
      if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
        break;
      }
    } catch (error) {
      const outcome: DispatchedPluginHookOutcomeV1 = buildRejectedOutcome({
        pluginId: handler.pluginId,
        ...(handler.localId ? { localId: handler.localId } : {}),
        hookId: handler.hookId,
        error: classifyPluginHookHandlerFailure(error),
      });
      outcomes.push(outcome);
      logRejectedHookOutcome(outcome);
      await publishHookObservation({
        observation: {
          pluginId: outcome.pluginId,
          hookId: outcome.hookId,
          status: outcome.status,
          error: outcome.error,
          durationMs: Date.now() - startedAtMs,
        },
        publishHookObservation: params.publishHookObservation,
      });
      if (aggregation === 'replace') {
        replacementFailed = true;
        break;
      }
      if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
        break;
      }
    }
  }

  if (failureMode === 'failClosed' && matchingFailClosedDeclarations.length > 0) {
    const unavailableDeclaration = matchingFailClosedDeclarations.find(
      (declaration) => !availableRegistrationKeys.has(declaration.key),
    );
    if (unavailableDeclaration) {
      matchedExecutionKind ??= unavailableDeclaration.executionKind;
      outcomes.push({
        pluginId: unavailableDeclaration.pluginId,
        hookId: unavailableDeclaration.hookId,
        status: 'rejected',
        error: `Plugin hook '${unavailableDeclaration.hookId}' declared by plugin '${unavailableDeclaration.pluginId}' is unavailable.`,
      });
    }
  }

  const aggregate = aggregateHookResults(
    outcomes,
    matchedExecutionKind,
    aggregation,
    failureMode,
    aggregation === 'replace'
      ? replacementFailed ? initialReplacementPayload : currentReplacementPayload
      : undefined,
  );
  return {
    eventId: envelope.eventId,
    matchedHandlerCount: outcomes.length,
    outcomes: Object.freeze([...outcomes]),
    ...(aggregate ? { aggregate } : {}),
    ...(interception ? { interception } : {}),
  };
}
