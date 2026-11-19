import { isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AccountSettings } from '@happier-dev/protocol';
import { ReviewEngineListItemSchema, ReviewEngineScopeSchema, type ReviewEngineListItem, type ReviewEngineProfileSelection, type ReviewEngineScope } from '@happier-dev/protocol/reviews/reviewEngines';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AGENT_IDS, isBundledAgentId } from '@happier-dev/agents/agent-ids';
import type { MachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { isAgentStartReadinessBlockingV1 } from '@happier-dev/protocol/actions/executor/agents/agentBackendReadiness';

import { readAgentContributionDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { resolveExecutionRunAgentDefaultSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { isNativeAutomaticModelSelectionInputV1 } from '@happier-dev/protocol/providers/selection/v1';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import {
  resolveExecutionRunProfileSelectionForAgent,
  resolveExecutionRunProfileContributionDescriptor,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { readAgentExecutionRunCapabilities, readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type {
  ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';

import { buildConfiguredAcpBackendInventoryItems } from './buildAgentBackendInventoryItems';

export type ActionReviewEngineInventoryItem = ReviewEngineListItem & Readonly<{
  value: string;
  backendId: string;
}>;

export type { ReviewEngineScope } from '@happier-dev/protocol/reviews/reviewEngines';

type ReviewAgentCatalog = Pick<ReturnType<typeof readAgentCatalogSnapshot>, 'agentDefinitionsById' | 'executionRunProfiles'>;

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The Agent's declared title is owned by `readAgentContributionDisplayTitle`;
 * only the review-engine subtitle is read locally.
 */
function readReviewEngineDescription(
  agent: ResolvedAgentContribution,
): string | undefined {
  const definitions: readonly unknown[] = [
    agent.richDefinition?.definition,
    agent.definition,
  ];
  for (const definition of definitions) {
    const value = isRecord(definition) ? readTrimmedString(definition.subtitle) : '';
    if (value) return value;
  }
  return undefined;
}

function selectReviewEngineAgents(
  registry: ReviewAgentCatalog,
  scope?: ReviewEngineScope,
  profileCatalog?: ExecutionRunProfileContributionCatalog,
) {
  const agents = new Map<string, ReturnType<typeof resolveReviewProfileFacts>>();
  for (const agent of registry.agentDefinitionsById.values()) {
    if (agent.identity && listAgentExecutionTargetsV1(agent.identity).length === 0) continue;
    const definition = agent.richDefinition?.definition;
    if (!readAgentExecutionRunCapabilities(definition)?.open.includes('create')) continue;
    const facts = resolveReviewProfileFacts(agent.id, profileCatalog);
    if (scope && !facts.reviewScopes.includes(scope)) continue;
    agents.set(agent.id, facts);
  }
  return agents;
}

function resolveReviewProfileFacts(
  agentId: string,
  catalog?: ExecutionRunProfileContributionCatalog,
  selection?: ReviewEngineProfileSelection,
): Pick<ReviewEngineListItem, 'retentionPolicy' | 'profileId' | 'profileSourceCustody' | 'costConsent'> & {
  reviewScopes: ReviewEngineScope[];
  sessionTranscript: boolean;
} {
  const selected = catalog ? resolveExecutionRunProfileSelectionForAgent(catalog, { intent: 'review', agentId, ...selection }) : null;
  const profile = selected && catalog ? resolveExecutionRunProfileContributionDescriptor(catalog, selected.profileId) : null;
  const consentOptionKey = readTrimmedString(profile?.metadata?.reviewCostConsentOption);
  const consentOption = profile?.optionsSchema?.properties?.[consentOptionKey];
  const consentTitle = readTrimmedString(consentOption?.title);
  const consentDescription = readTrimmedString(consentOption?.description);
  const declaredScopes = profile?.metadata?.reviewScopes;
  const reviewScopes = Array.isArray(declaredScopes)
    ? declaredScopes.filter((scope): scope is ReviewEngineScope => ReviewEngineScopeSchema.safeParse(scope).success)
    : [...ReviewEngineScopeSchema.options];
  return { reviewScopes, retentionPolicy: profile?.defaults.retention ?? 'resumable',
    ...(consentOption?.type === 'boolean' && consentTitle ? { costConsent: {
      optionKey: consentOptionKey, title: consentTitle,
      ...(consentDescription ? { description: consentDescription } : {}),
    } } : {}),
    sessionTranscript: profile?.metadata?.reviewInstructionsInput !== 'unsupported',
    ...(selected ? { profileId: selected.profileId,
      ...(selected.profileSourceCustody ? { profileSourceCustody: selected.profileSourceCustody } : {}) } : {}) };
}

/** Shared selector; contributed behavior comes only from the selected catalog profile. */
export function selectReviewEngineAgentIds(
  registry: ReviewAgentCatalog,
  scope?: ReviewEngineScope,
  profileCatalog?: ExecutionRunProfileContributionCatalog,
): ReadonlySet<string> {
  return new Set(selectReviewEngineAgents(registry, scope, profileCatalog).keys());
}

export async function buildReviewEngineInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  scope?: ReviewEngineScope;
  registrySnapshot?: ReviewAgentCatalog;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  /** One batched observation from the existing Machine inventory readiness owner. */
  readReadiness?: (targetKeys: readonly string[]) => Promise<readonly (MachineAgentExecutionStateV1 | undefined)[] | null>;
}>): Promise<readonly ActionReviewEngineInventoryItem[]> {
  const accountSettings = params.accountSettings ?? null;
  const includeDisabled = params.includeDisabled === true;
  const limit = normalizeLimit(params.limit);
  const registry = params.registrySnapshot ?? readAgentCatalogSnapshot();
  const reviewAgents = selectReviewEngineAgents(registry, params.scope, params.profileCatalog);
  // Match the shared Agent catalog's display/default order; installed Agents retain their registry order.
  const orderedReviewAgentIds = [
    ...AGENT_IDS.filter((agentId) => reviewAgents.has(agentId)),
    ...[...reviewAgents.keys()].filter((agentId) => !isBundledAgentId(agentId)),
  ];
  const agentItems = orderedReviewAgentIds
    .flatMap((agentId) => {
      const agent = registry.agentDefinitionsById.get(agentId);
      if (!agent) return [];
      const description = readReviewEngineDescription(agent);
      const { sessionTranscript, ...profileFacts } = reviewAgents.get(agent.id)!;
      return [{
        engineId: agent.id,
        value: buildBackendTargetKeyV2(agent.identity
          ? { kind: 'agent', identity: agent.identity }
          : { kind: 'backend', backendId: agent.id }),
        label: readAgentContributionDisplayTitle(agent, agent.id) ?? agent.id,
        ...(description ? { description } : {}),
        enabled: !isBackendTargetDisabledByAccountSettings(accountSettings, { kind: 'backend', backendId: agent.id }),
        backendId: agent.id,
        ...profileFacts,
        capabilities: { structuredNarration: readAgentStructuredOutputCapabilities(agent.richDefinition?.definition)?.formats.includes('json') === true,
          sessionTranscript },
      }];
    });
  const configuredItems = (await buildConfiguredAcpBackendInventoryItems(accountSettings, params.acpCatalogSnapshot, registry))
    .filter((item): item is typeof item & { backendId: string } => typeof item.backendId === 'string')
    .map((item): ActionReviewEngineInventoryItem => ({
      engineId: item.targetKey,
      value: item.targetKey,
      label: item.label,
      enabled: item.enabled,
      backendId: item.backendId,
      capabilities: { structuredNarration: false, sessionTranscript: true },
      retentionPolicy: 'resumable',
      reviewScopes: [...ReviewEngineScopeSchema.options],
      ...(item.description ? { description: item.description } : {}),
    }));
  const roster = [...agentItems, ...configuredItems];
  const readiness = roster.length > 0 ? await params.readReadiness?.(roster.map(item => item.value)) : null;
  const items = roster
    .map((item, index): ActionReviewEngineInventoryItem => {
      const selection = resolveExecutionRunAgentDefaultSelection({
        backendTarget: item.engineId === item.backendId ? { kind: 'backend', backendId: item.backendId } : item.value,
        accountSettings,
      });
      const launchModelId = selection && !isNativeAutomaticModelSelectionInputV1(selection) ? selection.modelId : undefined;
      const state = readiness?.[index];
      const unavailableCode = !item.enabled ? 'account_disabled'
        : isAgentStartReadinessBlockingV1(state) ? state : undefined;
      return { ...ReviewEngineListItemSchema.parse({ ...item, enabled: !unavailableCode, available: !unavailableCode,
        ...(state ? { readiness: state } : {}), ...(unavailableCode ? { unavailableCode } : {}),
        ...(launchModelId ? { launchModelId } : {}) }),
        value: item.value, backendId: item.backendId };
    })
    .filter((_item, index) => includeDisabled || roster[index]?.enabled !== false);

  return limit ? items.slice(0, limit) : items;
}

export async function buildReviewEngineInventory(
  params: Parameters<typeof buildReviewEngineInventoryItems>[0] & Readonly<{
    profileSelections?: readonly ReviewEngineProfileSelection[];
  }>,
): Promise<Readonly<{ items: readonly ActionReviewEngineInventoryItem[]; selectionItems?: readonly ActionReviewEngineInventoryItem[] }>> {
  if (!params.profileSelections?.length) return { items: await buildReviewEngineInventoryItems(params) };
  // An authored profile can support a scope that this Agent's default profile does not.
  // Read Machine facts once for the roster, then project each selection's own scope.
  const roster = await buildReviewEngineInventoryItems({ ...params, scope: undefined });
  const items = roster.filter(item => !params.scope || item.reviewScopes?.includes(params.scope));
  const selectionItems = params.profileSelections.flatMap(selection => {
    const item = roster.find(row => row.engineId === selection.engineId || row.value === selection.engineId);
    if (!item) return [];
    const { sessionTranscript, ...facts } = resolveReviewProfileFacts(item.backendId, params.profileCatalog, selection);
    if (params.scope && !facts.reviewScopes.includes(params.scope)) return [];
    const { costConsent: _defaultCostConsent, ...selectionItem } = item;
    return [{ ...selectionItem, ...facts, capabilities: { ...item.capabilities, sessionTranscript } }];
  });
  return { items, selectionItems };
}
