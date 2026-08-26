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

type GithubAutomationWebhookSourceSnapshotV1 = Readonly<{
  revision: string;
  definitions: readonly GithubAutomationWebhookSourceDefinitionV1[];
}>;

type GithubAutomationWebhookSourceReadV1 = Readonly<{
  snapshot: GithubAutomationWebhookSourceSnapshotV1;
  /** True only for the read that first adopted this revision in this generation. */
  adoptedRevision: boolean;
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

/**
 * One handler closure is registered for one active plugin generation. Its
 * bounded map only remembers host-confirmed source revisions; every read and
 * admission still enters the host's current invocation/target owner.
 */
export type GithubWebhookActionHandlerV1 = (
  rawInput: unknown,
  context: PluginInvocationContext,
) => Promise<PluginWebhookActionResult>;

function sourceSnapshotKey(endpointSourceInstanceId: string): string {
  return `${GITHUB_PLUGIN_ID}\u0000${GITHUB_WEBHOOK_CONTRIBUTION_ID}\u0000${endpointSourceInstanceId}`;
}

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

async function readCurrentAutomationSources(params: Readonly<{
  context: PluginInvocationContext;
  endpointSourceInstanceId: string;
  sourceSnapshots: Map<string, GithubAutomationWebhookSourceSnapshotV1>;
}>): Promise<GithubAutomationWebhookSourceReadV1> {
  const key = sourceSnapshotKey(params.endpointSourceInstanceId);
  const previous = params.sourceSnapshots.get(key) ?? null;
  const definitions: GithubAutomationWebhookSourceDefinitionV1[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | null = null;

  while (true) {
    params.context.signal.throwIfAborted();
    const result = await params.context.services.actions.execute('automation.event.sources.list', {
      transport: { kind: 'durablePush' },
      ...(cursor === undefined && previous !== null
        ? { knownRevision: previous.revision }
        : cursor === undefined ? {} : { cursor }),
    }, { signal: params.context.signal });
    params.context.signal.throwIfAborted();
    if (result.kind === 'unchanged') {
      if (cursor === undefined && previous !== null && result.revision === previous.revision) {
        return { snapshot: previous, adoptedRevision: false };
      }
      throw new Error('github_automation_source_revision_unavailable');
    }
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
      const next = Object.freeze({
        revision,
        definitions: Object.freeze([...definitions]),
      });
      params.sourceSnapshots.set(key, next);
      return { snapshot: next, adoptedRevision: previous === null || previous.revision !== revision };
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
  admitted: boolean;
}>): readonly AutomationEventSourceStatusInputV1[] {
  return params.definitions.map((definition) => ({
    kind: 'source',
    automationId: definition.automationId,
    templateVersion: definition.templateVersion,
    eventRef: definition.eventRef,
    sourceSelectorId: definition.sourceSelectorId,
    state: params.admitted ? 'observing' : 'attention',
    code: params.admitted ? 'none' : 'admissionUnavailable',
    lastObservedAt: params.observedAtMs,
    lastDispositionAt: params.admitted ? params.observedAtMs : null,
    nextRetryAt: null,
    // Only a settled delivery advances the counters. An unavailable admission
    // is redelivered, so counting it here would multiply one occurrence by its
    // attempt count.
    observedDelta: params.admitted ? 1 : 0,
    admittedDelta: params.admitted ? 1 : 0,
    skippedDelta: 0,
  }));
}

async function admitAutomationWebhookEvent(params: Readonly<{
  input: PluginWebhookActionInput;
  normalized: NonNullable<ReturnType<typeof normalizeGithubWebhookDelivery>['automationEvent']>;
  context: PluginInvocationContext;
  sourceSnapshots: Map<string, GithubAutomationWebhookSourceSnapshotV1>;
}>): Promise<PluginWebhookActionResult> {
  const read = await readCurrentAutomationSources({
    context: params.context,
    endpointSourceInstanceId: params.input.endpoint.sourceInstanceId,
    sourceSnapshots: params.sourceSnapshots,
  });
  const providerDefinitions = read.snapshot.definitions.filter((definition) => (
    isGithubAutomationDefinitionForSource(definition, params.normalized.sourceInstanceId)
  ));
  const catalogReports = read.adoptedRevision
    ? catalogStatusReports({ definitions: providerDefinitions, revision: read.snapshot.revision })
    : [];
  const definitions = providerDefinitions.filter((definition) => (
    definition.eventRef.localId === params.normalized.eventRef.localId
  ));
  if (definitions.length === 0) {
    await reportAutomationWebhookStatus({ context: params.context, reports: catalogReports });
    return PluginWebhookActionResultSchema.parse({ kind: 'settled', disposition: 'ignored' });
  }
  const reportHealth = async (admitted: boolean): Promise<void> => {
    await reportAutomationWebhookStatus({
      context: params.context,
      reports: [
        ...catalogReports,
        ...sourceStatusReports({
          definitions,
          observedAtMs: params.input.delivery.receivedAtMs,
          admitted,
        }),
      ],
    });
  };

  try {
    params.context.signal.throwIfAborted();
    const admitted = await params.context.services.actions.execute('automation.event.admit', {
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
        templateVersion: definition.templateVersion,
        sourceSelectorId: definition.sourceSelectorId,
      })),
    }, { signal: params.context.signal });
    params.context.signal.throwIfAborted();
    if (!isCheckpointSafeAdmissionResult(admitted, definitions.length)) {
      await reportHealth(false);
      return PluginWebhookActionResultSchema.parse({
        kind: 'retry',
        code: 'github.automation-unavailable',
      });
    }
  } catch (error) {
    if (params.context.signal.aborted) throw error;
    await reportHealth(false);
    return PluginWebhookActionResultSchema.parse({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
  }
  await reportHealth(true);
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
  sourceSnapshots: Map<string, GithubAutomationWebhookSourceSnapshotV1>,
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
      sourceSnapshots,
    });
  } catch (error) {
    if (context.signal.aborted) throw error;
    return PluginWebhookActionResultSchema.parse({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
  }
}

/**
 * Creates the one generation-owned GitHub webhook handler. Call this exactly
 * once while activating the plugin; a per-delivery Action service is not a
 * generation boundary and therefore cannot own the revision cache.
 */
export function createGithubWebhookActionHandlerV1(): GithubWebhookActionHandlerV1 {
  const sourceSnapshots = new Map<string, GithubAutomationWebhookSourceSnapshotV1>();
  return async (rawInput, context) => await handleGithubWebhookActionV1(
    rawInput,
    context,
    sourceSnapshots,
  );
}
