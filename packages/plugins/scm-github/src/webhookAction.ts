import {
  decodePluginWebhookActionRawBody,
  PluginWebhookActionInputSchema,
  PluginWebhookActionResultSchema,
  type PluginWebhookActionInput,
  type PluginWebhookActionResult,
} from '@happier-dev/plugin-sdk/webhooks';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import {
  normalizeGithubWebhookDelivery,
} from './observations/githubWebhookNormalization.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_PLUGIN_ID,
  GITHUB_WEBHOOK_CONTRIBUTION_ID,
} from './observations/githubProviderContracts.js';
import { isGithubAutomationEventLocalId } from './githubAutomationEvents.js';

type GithubAutomationWebhookSourceListResultV1 = PluginActionResultById['automation.event.sources.list'];
type GithubAutomationWebhookSourceDefinitionV1 = Extract<
  GithubAutomationWebhookSourceListResultV1,
  Readonly<{ kind: 'page' }>
>['definitions'][number];

type GithubAutomationWebhookSourceScanV1 = Readonly<{
  revision: string;
  definitions: readonly GithubAutomationWebhookSourceDefinitionV1[];
}>;

type AutomationEventSourceStatusReportV1 = PluginActionInputById['automation.event.source.status.report'];
type AutomationEventSourceStatusInputV1 = Extract<
  AutomationEventSourceStatusReportV1,
  Readonly<{ kind: 'source' }>
>;
type AutomationEventCatalogStatusInputV1 = Extract<
  AutomationEventSourceStatusReportV1,
  Readonly<{ kind: 'catalogReconciliation' }>
>;

export type GithubWebhookActionHandlerV1 = (
  rawInput: unknown,
  context: PluginInvocationContext,
) => Promise<PluginWebhookActionResult>;

function isWebhookIngressHostCaller(context: PluginInvocationContext): boolean {
  return context.surface === 'plugin'
    && context.caller?.kind === 'host'
    && context.caller.domain === 'ingress'
    && context.caller.originSurface === 'webhook';
}

function isMatchingWebhookContributionCaller(
  input: PluginWebhookActionInput,
  context: PluginInvocationContext,
): boolean {
  return input.endpoint.webhookContribution.pluginId === GITHUB_PLUGIN_ID
    && input.endpoint.webhookContribution.localId === GITHUB_WEBHOOK_CONTRIBUTION_ID
    && context.caller?.kind === 'host'
    && context.caller.contribution.id === input.endpoint.webhookContribution.localId
    && context.caller.contribution.qualifiedId
      === `${input.endpoint.webhookContribution.pluginId}/${input.endpoint.webhookContribution.localId}`;
}

function invalidWebhookCallerResult(): PluginWebhookActionResult {
  return PluginWebhookActionResultSchema.parse({
    kind: 'deadLetter',
    code: 'github_webhook_caller_invalid',
  });
}

function isGithubAutomationDefinitionForSource(
  definition: GithubAutomationWebhookSourceDefinitionV1,
  sourceInstanceId: string,
): boolean {
  return definition.eventRef.pluginId === GITHUB_PLUGIN_ID
    && isGithubAutomationEventLocalId(definition.eventRef.localId)
    && definition.sourceContractVersion === GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION
    && definition.sourceInstanceId === sourceInstanceId
    && definition.observationTransport.kind === 'durablePush';
}

function isCheckpointSafeAdmissionResult(
  result: PluginActionResultById['automation.event.admit'],
  expectedCount: number,
): boolean {
  return result.results.length === expectedCount
    && result.results.every((item) => item.checkpointSafe === true);
}

async function readCurrentAutomationSources(
  context: PluginInvocationContext,
): Promise<GithubAutomationWebhookSourceScanV1> {
  const definitions: GithubAutomationWebhookSourceDefinitionV1[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | null = null;

  while (true) {
    context.signal.throwIfAborted();
    const result = await context.services.actions.execute('automation.event.sources.list', {
      transport: { kind: 'durablePush' },
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: context.signal });
    context.signal.throwIfAborted();
    if (result.kind === 'unchanged') throw new Error('github_automation_source_revision_unavailable');
    if (result.kind === 'cursorStale') {
      throw new Error('github_automation_source_cursor_stale');
    }
    if (
      (revision !== null && revision !== result.revision)
      || (result.nextCursor !== null && result.definitions.length === 0)
    ) {
      throw new Error('github_automation_source_page_invalid');
    }
    revision ??= result.revision;
    definitions.push(...result.definitions);
    if (result.nextCursor === null) {
      return Object.freeze({
        revision,
        definitions: Object.freeze([...definitions]),
      });
    }
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('github_automation_source_cursor_repeated');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}

/**
 * Reports the same Automation health facts through the same canonical host
 * status owner the checkpointed-pull observer uses. Without a durable-push
 * producer, `automation.event.source.status.report`'s `durablePush` catalog
 * scope had no writer at all and a push Automation's status stayed permanently
 * null while its pull twin reported every cycle.
 *
 * A status report is never allowed to change the delivery disposition: the
 * admission above is the authoritative fact, and re-delivering an accepted
 * occurrence to repair telemetry would re-admit it. Cancellation still
 * propagates, because an aborted invocation must not settle.
 */
async function reportAutomationWebhookStatus(params: Readonly<{
  context: PluginInvocationContext;
  reports: readonly AutomationEventSourceStatusReportV1[];
}>): Promise<void> {
  try {
    for (const report of params.reports) {
      params.context.signal.throwIfAborted();
      await params.context.services.actions.execute(
        'automation.event.source.status.report',
        report,
        { signal: params.context.signal },
      );
    }
  } catch (error) {
    if (params.context.signal.aborted) throw error;
  }
}

function catalogStatusReports(params: Readonly<{
  definitions: readonly GithubAutomationWebhookSourceDefinitionV1[];
  revision: string;
}>): readonly AutomationEventCatalogStatusInputV1[] {
  // The catalog fact is scoped to one endpoint, and only the definitions this
  // delivery matched name an endpoint this handler has authority to speak for.
  const endpointIds = new Set<string>();
  for (const definition of params.definitions) {
    if (definition.observationTransport.kind !== 'durablePush') continue;
    endpointIds.add(definition.observationTransport.webhookEndpointId);
  }
  return [...endpointIds].map((webhookEndpointId) => ({
    kind: 'catalogReconciliation',
    scope: { kind: 'durablePush', webhookEndpointId },
    observedRevision: params.revision,
    adoptedRevision: params.revision,
    state: 'current',
    scanStartedAt: null,
    nextRetryAt: null,
  }));
}

function sourceStatusReports(params: Readonly<{
  definitions: readonly GithubAutomationWebhookSourceDefinitionV1[];
  observedAtMs: number;
  results: PluginActionResultById['automation.event.admit']['results'] | null;
}>): readonly AutomationEventSourceStatusInputV1[] {
  return params.definitions.map((definition, index) => {
    const result = params.results?.[index] ?? null;
    const settled = result?.checkpointSafe === true;
    const admitted = settled && result.kind === 'admitted';
    const skipped = settled && result.kind === 'skipped';
    return {
      kind: 'source',
      automationId: definition.automationId,
      triggerId: definition.triggerId,
      triggerRevision: definition.triggerRevision,
      eventRef: definition.eventRef,
      sourceSelectorId: definition.sourceSelectorId,
      state: settled ? 'observing' : 'attention',
      code: settled ? 'none' : 'admissionUnavailable',
      lastObservedAt: params.observedAtMs,
      lastDispositionAt: settled ? params.observedAtMs : null,
      nextRetryAt: null,
      // A retryable delivery has no terminal disposition, so it does not
      // multiply counters. Settled outcomes are mapped positionally to the
      // exact trigger definition that produced them.
      observedDelta: settled ? 1 : 0,
      admittedDelta: admitted ? 1 : 0,
      skippedDelta: skipped ? 1 : 0,
    };
  });
}

async function admitAutomationWebhookEvent(params: Readonly<{
  input: PluginWebhookActionInput;
  normalized: NonNullable<ReturnType<typeof normalizeGithubWebhookDelivery>['automationEvent']>;
  context: PluginInvocationContext;
}>): Promise<PluginWebhookActionResult> {
  const currentSources = await readCurrentAutomationSources(params.context);
  const providerDefinitions = currentSources.definitions.filter((definition) => (
    isGithubAutomationDefinitionForSource(definition, params.normalized.sourceInstanceId)
  ));
  const catalogReports = catalogStatusReports({
    definitions: providerDefinitions,
    revision: currentSources.revision,
  });
  const definitions = providerDefinitions.filter((definition) => (
    definition.eventRef.localId === params.normalized.eventRef.localId
  ));
  if (definitions.length === 0) {
    await reportAutomationWebhookStatus({ context: params.context, reports: catalogReports });
    return PluginWebhookActionResultSchema.parse({ kind: 'settled', disposition: 'ignored' });
  }
  const reportHealth = async (
    results: PluginActionResultById['automation.event.admit']['results'] | null,
  ): Promise<void> => {
    await reportAutomationWebhookStatus({
      context: params.context,
      reports: [
        ...catalogReports,
        ...sourceStatusReports({
          definitions,
          observedAtMs: params.input.delivery.receivedAtMs,
          results,
        }),
      ],
    });
  };

  let admitted: PluginActionResultById['automation.event.admit'];
  try {
    params.context.signal.throwIfAborted();
    admitted = await params.context.services.actions.execute('automation.event.admit', {
      eventRef: {
        pluginId: params.normalized.eventRef.pluginId,
        localId: params.normalized.eventRef.localId,
      },
      occurrenceId: params.normalized.occurrenceId,
      occurredAt: params.normalized.occurredAtMs,
      observationReceivedAt: params.input.delivery.receivedAtMs,
      payload: params.normalized.payload,
      definitions: definitions.map((definition) => ({
        automationId: definition.automationId,
        triggerId: definition.triggerId,
        triggerRevision: definition.triggerRevision,
        sourceSelectorId: definition.sourceSelectorId,
      })),
    }, { signal: params.context.signal });
    params.context.signal.throwIfAborted();
    if (!isCheckpointSafeAdmissionResult(admitted, definitions.length)) {
      await reportHealth(null);
      return PluginWebhookActionResultSchema.parse({
        kind: 'retry',
        code: 'github.automation-unavailable',
      });
    }
  } catch (error) {
    if (params.context.signal.aborted) throw error;
    await reportHealth(null);
    return PluginWebhookActionResultSchema.parse({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
  }
  await reportHealth(admitted.results);
  return PluginWebhookActionResultSchema.parse({ kind: 'settled', disposition: 'accepted' });
}

/**
 * Provider-owned parse/normalization boundary for the generic host delivery.
 * The host has already authenticated and durably admitted the exact raw bytes;
 * this Action never verifies, persists, or creates another delivery record.
 */
async function handleGithubWebhookActionV1(
  rawInput: unknown,
  context: PluginInvocationContext,
): Promise<PluginWebhookActionResult> {
  context.signal.throwIfAborted();
  if (!isWebhookIngressHostCaller(context)) return invalidWebhookCallerResult();
  let input: PluginWebhookActionInput;
  let normalized: ReturnType<typeof normalizeGithubWebhookDelivery>;
  try {
    input = PluginWebhookActionInputSchema.parse(rawInput);
    if (!isMatchingWebhookContributionCaller(input, context)) {
      return invalidWebhookCallerResult();
    }
    normalized = normalizeGithubWebhookDelivery({
      rawBody: decodePluginWebhookActionRawBody(input),
      eventType: input.verified.eventType,
      providerDeliveryId: input.delivery.providerDeliveryId,
      receivedAtMs: input.delivery.receivedAtMs,
    });
    context.signal.throwIfAborted();
  } catch (error) {
    if (context.signal.aborted) throw error;
    return PluginWebhookActionResultSchema.parse({
      kind: 'deadLetter',
      code: 'github_payload_invalid',
    });
  }
  // Only the Automation Event arm has a consumer today. Every other delivery
  // GitHub sends to this endpoint — including a normalized issue comment — is
  // settled as ignored: retrying cannot make a missing consumer appear, so a
  // retry would only burn twelve attempts and record a misleading dead letter.
  if (normalized.automationEvent === null) {
    return PluginWebhookActionResultSchema.parse({ kind: 'settled', disposition: 'ignored' });
  }
  try {
    return await admitAutomationWebhookEvent({
      input,
      normalized: normalized.automationEvent,
      context,
    });
  } catch (error) {
    if (context.signal.aborted) throw error;
    return PluginWebhookActionResultSchema.parse({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
  }
}

export function createGithubWebhookActionHandlerV1(): GithubWebhookActionHandlerV1 {
  return handleGithubWebhookActionV1;
}
