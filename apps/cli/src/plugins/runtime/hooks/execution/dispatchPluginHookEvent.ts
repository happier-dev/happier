import {
  getPluginHookDefinitionV1,
  readHookEventEnvelopeV1,
  validatePluginHookPayloadV1,
  type PluginHookAggregationKindV1,
  type PluginHookFailureModeV1,
  type HookEventEnvelopeV1,
} from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';

import { matchesHookRegistrationFilters } from '@/plugins/projection/hooks/matchesHookRegistrationFilters';
import { publishHostPluginEvent } from '@/plugins/runtime/context/events';
import { logger } from '@/ui/logger';

export type DispatchedPluginHookOutcomeV1 = Readonly<{
  pluginId: string;
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
  'hookHandlersByHookId' | 'readHookEventEnvelopeV1'
> & Readonly<{
  activatePluginsByEvent?: ResolvedExecutablePluginRuntimeRegistry['activatePluginsByEvent'];
  contributes?: Readonly<{
    hookRegistrations?: readonly ResolvedHookRegistration[];
  }>;
}>;

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
    const firstOutcome = outcomes[0];
    const decisionResult = firstOutcome?.status === 'fulfilled'
      ? firstOutcome.result
      : false;
    const denied = decisionResult === false
      || (isRecord(decisionResult) && decisionResult.allow === false)
      || (isRecord(decisionResult) && decisionResult.allowed === false)
      || hasFailClosedRejection;
    return {
      executionKind,
      result: Object.freeze({ allowed: !denied && firstOutcome?.status !== 'rejected' }),
    };
  }

  if (aggregation === 'allDecisions') {
    const rejected = hasFailClosedRejection
      || outcomes.some((outcome) => outcome.status === 'rejected');
    const denied = fulfilledResults.some((result) => (
      result === false
      || (isRecord(result) && result.allow === false)
      || (isRecord(result) && result.allowed === false)
    ));
    return {
      executionKind,
      result: Object.freeze({ allowed: !denied && !rejected }),
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
  pluginId: string;
  hookId: string;
}>): Promise<TResult> {
  const timeoutMs = params.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return params.promise;
  }
  return new Promise<TResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Plugin hook '${params.hookId}' handler for plugin '${params.pluginId}' timed out after ${Math.trunc(timeoutMs)}ms`));
    }, Math.trunc(timeoutMs));
    timeout.unref?.();
    params.promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function buildRejectedOutcome(params: Readonly<{
  pluginId: string;
  hookId: string;
  error: unknown;
}>): DispatchedPluginHookOutcomeV1 {
  return {
    pluginId: params.pluginId,
    hookId: params.hookId,
    status: 'rejected',
    error: params.error instanceof Error ? params.error.message : String(params.error ?? 'hook_dispatch_failed'),
  };
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
    await publishHostPluginEvent('@happier/runtime/plugin-hook', params.observation);
  } catch (error) {
    logger.debug('[plugins] Failed to publish plugin hook observation', {
      pluginId: params.observation.pluginId,
      hookId: params.observation.hookId,
      error,
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
    return true;
  }
  return false;
}

function buildHookRegistrationKey(registration: ResolvedHookRegistration): string {
  return [
    registration.pluginId,
    registration.manifestPath,
    registration.daemonEntryPath ?? '',
    registration.definition.id,
    registration.definition.handler.exportName ?? 'default',
  ].join('\0');
}

export async function dispatchPluginHookEvent(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  event: HookEventEnvelopeV1 | unknown;
  context?: unknown;
  handlerTimeoutMs?: number;
  publishHookObservation?: (record: PluginHookDispatchObservationV1) => Promise<void> | void;
}>): Promise<DispatchPluginHookEventResultV1> {
  const envelope = params.runtimeRegistry.readHookEventEnvelopeV1
    ? params.runtimeRegistry.readHookEventEnvelopeV1(params.event)
    : readHookEventEnvelopeV1(params.event);
  if (!envelope) {
    return {
      eventId: null,
      matchedHandlerCount: 0,
      outcomes: Object.freeze([]),
    };
  }

  await params.runtimeRegistry.activatePluginsByEvent?.(`onHook:${envelope.eventId}`);
  const handlers = params.runtimeRegistry.hookHandlersByHookId.get(envelope.eventId) ?? [];
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
              result: Object.freeze({ allowed: false }),
            },
          }
        : {}),
    };
  }
  const outcomes: DispatchedPluginHookOutcomeV1[] = [];
  let matchedExecutionKind: string | null = null;
  const aggregation = hookDefinition?.aggregation ?? null;
  const failureMode = hookDefinition?.failureMode ?? null;
  let currentReplacementPayload = payloadValidation.payload;
  const matchingFailClosedRegistrations = failureMode === 'failClosed'
    ? (params.runtimeRegistry.contributes?.hookRegistrations ?? []).filter((registration) => (
        registration.definition.id === envelope.eventId
        && matchesHookRegistrationFilters(envelope, registration)
      ))
    : [];
  const matchingHandlers = handlers.filter((handler) => matchesHookRegistrationFilters(envelope, handler.registration));
  const availableRegistrationKeys = new Set(
    matchingHandlers.map((handler) => buildHookRegistrationKey(handler.registration)),
  );

  for (const handler of matchingHandlers) {
    matchedExecutionKind ??= handler.registration.definition.executionKind;
    const startedAtMs = Date.now();

    try {
      const dispatchEnvelope = aggregation === 'replace'
        ? Object.freeze({ ...envelope, payload: currentReplacementPayload })
        : envelope;
      const result = await withHookTimeout({
        promise: Promise.resolve(handler.handler(dispatchEnvelope, params.context)),
        timeoutMs: params.handlerTimeoutMs,
        pluginId: handler.pluginId,
        hookId: handler.hookId,
      });
      const replacementValidation = aggregation === 'replace' && typeof result !== 'undefined'
        ? validatePluginHookPayloadV1({
            hookId: envelope.eventId,
            payload: result,
          })
        : { success: true as const, payload: currentReplacementPayload };
      if (!replacementValidation.success) {
        const outcome = buildRejectedOutcome({
          pluginId: handler.pluginId,
          hookId: handler.hookId,
          error: replacementValidation.message,
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
        if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
          break;
        }
        continue;
      }
      if (aggregation === 'replace' && typeof result !== 'undefined') {
        currentReplacementPayload = replacementValidation.payload;
      }
      const outcome: DispatchedPluginHookOutcomeV1 = {
        pluginId: handler.pluginId,
        hookId: handler.hookId,
        status: 'fulfilled',
        ...(aggregation === 'replace'
          ? { result: currentReplacementPayload }
          : typeof result === 'undefined' ? {} : { result }),
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
        hookId: handler.hookId,
        error,
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
      if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
        break;
      }
    }
  }

  if (failureMode === 'failClosed' && matchingFailClosedRegistrations.length > 0) {
    const unavailableRegistration = matchingFailClosedRegistrations.find(
      (registration) => !availableRegistrationKeys.has(buildHookRegistrationKey(registration)),
    );
    if (unavailableRegistration) {
      matchedExecutionKind ??= unavailableRegistration.definition.executionKind;
      outcomes.push({
        pluginId: unavailableRegistration.pluginId,
        hookId: unavailableRegistration.definition.id,
        status: 'rejected',
        error: `Plugin hook '${unavailableRegistration.definition.id}' declared by plugin '${unavailableRegistration.pluginId}' is unavailable.`,
      });
    }
  }

  const aggregate = aggregateHookResults(
    outcomes,
    matchedExecutionKind,
    aggregation,
    failureMode,
    aggregation === 'replace' ? currentReplacementPayload : undefined,
  );
  return {
    eventId: envelope.eventId,
    matchedHandlerCount: outcomes.length,
    outcomes: Object.freeze([...outcomes]),
    ...(aggregate ? { aggregate } : {}),
  };
}
