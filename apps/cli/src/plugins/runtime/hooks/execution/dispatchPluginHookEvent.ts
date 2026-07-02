import {
  getPluginHookDefinitionV1,
  readHookEventEnvelopeV1,
  validatePluginHookPayloadV1,
  type PluginHookAggregationKindV1,
  type PluginHookFailureModeV1,
  type HookEventEnvelopeV1,
} from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { matchesHookRegistrationFilters } from '@/plugins/projection/hooks/matchesHookRegistrationFilters';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function aggregateHookResults(
  outcomes: readonly DispatchedPluginHookOutcomeV1[],
  executionKind: string | null,
  aggregation: PluginHookAggregationKindV1 | null,
): DispatchPluginHookEventResultV1['aggregate'] {
  if (!executionKind || !aggregation || aggregation === 'none') {
    return undefined;
  }

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
      || (isRecord(decisionResult) && decisionResult.allowed === false);
    return {
      executionKind,
      result: Object.freeze({ allowed: !denied && firstOutcome?.status !== 'rejected' }),
    };
  }

  if (aggregation === 'allDecisions') {
    const rejected = outcomes.some((outcome) => outcome.status === 'rejected');
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
      result: fulfilledResults.length > 0 ? fulfilledResults[fulfilledResults.length - 1] : null,
    };
  }

  return {
    executionKind,
    result: Object.freeze([...fulfilledResults]),
  };
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

export async function dispatchPluginHookEvent(params: Readonly<{
  runtimeRegistry: Pick<
    ResolvedExecutablePluginRuntimeRegistry,
    'hookHandlersByHookId' | 'readHookEventEnvelopeV1'
  >;
  event: HookEventEnvelopeV1 | unknown;
  context?: unknown;
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

  const handlers = params.runtimeRegistry.hookHandlersByHookId.get(envelope.eventId) ?? [];
  const hookDefinition = getPluginHookDefinitionV1(envelope.eventId);
  const payloadValidation = validatePluginHookPayloadV1({
    hookId: envelope.eventId,
    payload: envelope.payload,
  });
  if (!payloadValidation.success) {
    return {
      eventId: envelope.eventId,
      matchedHandlerCount: 0,
      outcomes: Object.freeze([]),
      validationError: payloadValidation.message,
    };
  }
  const outcomes: DispatchedPluginHookOutcomeV1[] = [];
  let matchedExecutionKind: string | null = null;
  const aggregation = hookDefinition?.aggregation ?? null;
  const failureMode = hookDefinition?.failureMode ?? null;

  for (const handler of handlers) {
    if (!matchesHookRegistrationFilters(envelope, handler.registration)) {
      continue;
    }

    matchedExecutionKind ??= handler.registration.definition.executionKind;

    try {
      const result = await handler.handler(envelope, params.context);
      const outcome: DispatchedPluginHookOutcomeV1 = {
        pluginId: handler.pluginId,
        hookId: handler.hookId,
        status: 'fulfilled',
        ...(typeof result === 'undefined' ? {} : { result }),
      };
      outcomes.push(outcome);
      if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
        break;
      }
    } catch (error) {
      const outcome: DispatchedPluginHookOutcomeV1 = {
        pluginId: handler.pluginId,
        hookId: handler.hookId,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error ?? 'hook_dispatch_failed'),
      };
      outcomes.push(outcome);
      if (shouldStopDispatchAfterOutcome({ aggregation, failureMode, outcome })) {
        break;
      }
    }
  }

  const aggregate = aggregateHookResults(outcomes, matchedExecutionKind, aggregation);
  return {
    eventId: envelope.eventId,
    matchedHandlerCount: outcomes.length,
    outcomes: Object.freeze([...outcomes]),
    ...(aggregate ? { aggregate } : {}),
  };
}
