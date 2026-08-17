import {
  decodePluginWebhookActionRawBody,
  PluginWebhookActionInputSchema,
  PluginWebhookActionResultSchema,
  type PluginWebhookActionInput,
  type PluginWebhookActionResult,
} from '@happier-dev/plugin-sdk/webhooks';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import {
  normalizeGithubWebhookDelivery,
} from './observations/githubWebhookNormalization.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_EVENT_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_PLUGIN_ID,
  GITHUB_WEBHOOK_CONTRIBUTION_ID,
} from './observations/githubProviderContracts.js';

type GithubAutomationWebhookSourceListResultV1 = PluginActionResultById['automation.event.sources.list'];
type GithubAutomationWebhookSourceDefinitionV1 = Extract<
  GithubAutomationWebhookSourceListResultV1,
  Readonly<{ kind: 'page' }>
>['definitions'][number];

type GithubAutomationWebhookSourceSnapshotV1 = Readonly<{
  revision: string;
  definitions: readonly GithubAutomationWebhookSourceDefinitionV1[];
}>;

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
  return `${GITHUB_PLUGIN_ID}\u0000${GITHUB_AUTOMATION_REPOSITORY_EVENT_ID}\u0000${endpointSourceInstanceId}`;
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

function isMatchingAutomationDefinition(
  definition: GithubAutomationWebhookSourceDefinitionV1,
  sourceInstanceId: string,
): boolean {
  return definition.eventRef.pluginId === GITHUB_PLUGIN_ID
    && definition.eventRef.localId === GITHUB_AUTOMATION_REPOSITORY_EVENT_ID
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
}>): Promise<GithubAutomationWebhookSourceSnapshotV1> {
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
        return previous;
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
      return next;
    }
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('github_automation_source_cursor_repeated');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}

async function admitAutomationWebhookEvent(params: Readonly<{
  input: PluginWebhookActionInput;
  normalized: NonNullable<ReturnType<typeof normalizeGithubWebhookDelivery>['automationEvent']>;
  context: PluginInvocationContext;
  sourceSnapshots: Map<string, GithubAutomationWebhookSourceSnapshotV1>;
}>): Promise<PluginWebhookActionResult> {
  const snapshot = await readCurrentAutomationSources({
    context: params.context,
    endpointSourceInstanceId: params.input.endpoint.sourceInstanceId,
    sourceSnapshots: params.sourceSnapshots,
  });
  const definitions = snapshot.definitions.filter((definition) => (
    isMatchingAutomationDefinition(definition, params.normalized.sourceInstanceId)
  ));
  if (definitions.length === 0) {
    return PluginWebhookActionResultSchema.parse({ kind: 'settled', disposition: 'ignored' });
  }

  try {
    params.context.signal.throwIfAborted();
    const admitted = await params.context.services.actions.execute('automation.event.admit', {
      eventRef: {
        pluginId: GITHUB_PLUGIN_ID,
        localId: GITHUB_AUTOMATION_REPOSITORY_EVENT_ID,
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
      return PluginWebhookActionResultSchema.parse({
        kind: 'retry',
        code: 'github.automation-unavailable',
      });
    }
  } catch (error) {
    if (params.context.signal.aborted) throw error;
    return PluginWebhookActionResultSchema.parse({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
  }
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
  if (normalized.comment !== null) {
    return PluginWebhookActionResultSchema.parse({ kind: 'retry', code: 'github.consumer-unavailable' });
  }
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
