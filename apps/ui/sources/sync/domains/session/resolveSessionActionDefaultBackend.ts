import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    AgentExecutionTargetV1Schema,
    SessionCreationCorrespondenceV1Schema,
    agentRoutingIdAddressesContributionIdentityV1,
    readAcpConfiguredBackendV1FromMetadata,
    resolveLinkedExternalSessionMetadataV1,
    type AgentExecutionTargetV1,
    type BackendTargetRefV2,
    type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol';

import {
    isBundledAgentId,
    resolveBundledAgentIdFromContributionIdentity,
    type AgentId,
} from '@/agents/catalog/catalog';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type ResolvedSessionActionDefaultBackend = Readonly<{
  /** Current Agent identity used by fork/replay/Run and ordinary resume. */
  agentTarget: AgentExecutionTargetV1 | null;
  /** Released configured-ACP compatibility; never an Agent identity. */
  backendTarget: BackendTargetRefV2 | null;
  defaultAgentId: string | null;
  /** Legacy presentation spelling retained while consumers move to `defaultAgentId`. */
  defaultBackendId: string | null;
  displayAgentType: AgentId | null;
}>;

export function resolveSessionActionDefaultTarget(
  resolved: ResolvedSessionActionDefaultBackend | null | undefined,
): PersistedBackendTargetRefV2 | null {
  return resolved?.agentTarget ?? resolved?.backendTarget ?? null;
}

function normalizeEnabledAgentIds(enabledAgentIds: readonly AgentId[] | null | undefined): readonly AgentId[] {
  return Array.isArray(enabledAgentIds) ? enabledAgentIds.filter((value): value is AgentId => typeof value === 'string' && value.trim().length > 0) : [];
}

function readRawMetadataAgent(metadata: unknown): string | null {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
  const sessionAgent = typeof record?.agent === 'string' ? record.agent.trim() : '';
  return sessionAgent.length > 0 ? sessionAgent : null;
}

function resolveDefaultBuiltInAgentId(params: Readonly<{
  metadata: unknown;
  enabledAgentIds: readonly AgentId[];
  fallbackAgentId?: AgentId | null;
}>): AgentId | null {
  const sessionAgent = readRawMetadataAgent(params.metadata);
  if (sessionAgent && isBundledAgentId(sessionAgent) && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(sessionAgent))) {
    return sessionAgent;
  }

  const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
    ? (params.metadata as Record<string, unknown>)
    : null;
  const metadataAgentId = resolveAgentIdFromSessionMetadata(metadata);
  if (metadataAgentId && isBundledAgentId(metadataAgentId) && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(metadataAgentId))) {
    return metadataAgentId;
  }

  const fallbackAgentId = typeof params.fallbackAgentId === 'string' && params.fallbackAgentId.trim().length > 0
    ? params.fallbackAgentId
    : null;
  if (fallbackAgentId && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(fallbackAgentId))) {
    return fallbackAgentId;
  }

  return null;
}

function resolveDefaultBackendId(params: Readonly<{
  metadata: unknown;
  defaultBuiltInAgentId: AgentId | null;
  configuredBackendId: string | null;
}>): string | null {
  const sessionAgent = readRawMetadataAgent(params.metadata);
  if (sessionAgent && !(params.configuredBackendId && isLegacyCompatAgentType(sessionAgent))) {
    return sessionAgent;
  }
  return params.defaultBuiltInAgentId ?? null;
}

function resolveDisplayAgentType(params: Readonly<{
  defaultAgentId: AgentId | null;
}>): AgentId | null {
  return params.defaultAgentId;
}

function readCanonicalAgentTarget(
  metadata: unknown,
  resolvedAgentId: string | null,
): AgentExecutionTargetV1 | null {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  if (!record) return null;

  const correspondence = SessionCreationCorrespondenceV1Schema.safeParse(
    record.sessionCreationCorrespondenceV1,
  );
  const linked = resolveLinkedExternalSessionMetadataV1(record);
  const candidate = correspondence.success
    ? correspondence.data.recipe.agentTarget
    : linked.ok && linked.linkedSession.qualifiedIdentity
      ? { kind: 'agent' as const, identity: linked.linkedSession.qualifiedIdentity.agent }
      : resolvedAgentId && isBundledAgentId(resolvedAgentId)
        ? { kind: 'agent' as const, identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[resolvedAgentId] }
        : null;
  const parsed = AgentExecutionTargetV1Schema.safeParse(candidate);
  if (!parsed.success) return null;
  if (
    resolvedAgentId
    && !agentRoutingIdAddressesContributionIdentityV1(resolvedAgentId, parsed.data.identity)
    && resolveBundledAgentIdFromContributionIdentity(parsed.data.identity) !== resolvedAgentId
  ) return null;
  return parsed.data;
}

export function resolveSessionActionDefaultBackend(params: Readonly<{
  session: Session | null | undefined;
  enabledAgentIds?: readonly AgentId[] | null;
  fallbackAgentId?: AgentId | null;
}>): ResolvedSessionActionDefaultBackend | null {
  const metadata = params.session
    ? readSessionOwnerMetadataView(params.session)
    : null;
  const enabledAgentIds = normalizeEnabledAgentIds(params.enabledAgentIds);
  const configuredBackend = readAcpConfiguredBackendV1FromMetadata(metadata);
  const defaultBuiltInAgentId = resolveDefaultBuiltInAgentId({
    metadata,
    enabledAgentIds,
    fallbackAgentId: params.fallbackAgentId ?? null,
  });
  const defaultBackendId = resolveDefaultBackendId({
    metadata,
    defaultBuiltInAgentId,
    configuredBackendId: configuredBackend?.backendId ?? null,
  });
  const metadataAgentId = resolveAgentIdFromSessionMetadata(metadata);
  const linked = resolveLinkedExternalSessionMetadataV1(metadata);
  const resolvedAgentId = metadataAgentId
    ?? (linked.ok ? linked.linkedSession.agentId : null)
    ?? defaultBuiltInAgentId;
  const agentTarget = readCanonicalAgentTarget(metadata, resolvedAgentId);
  const defaultAgentId = resolvedAgentId
    ?? (agentTarget ? resolveBundledAgentIdFromContributionIdentity(agentTarget.identity) : null);
  const displayAgentType = resolveDisplayAgentType({
    defaultAgentId,
  });

  if (configuredBackend?.backendId) {
    return {
      agentTarget: null,
      backendTarget: {
        kind: 'backend',
        backendId: configuredBackend.backendId,
        configuredBackendId: configuredBackend.backendId,
        sourceKind: 'configured',
      },
      defaultAgentId: null,
      defaultBackendId,
      displayAgentType,
    };
  }

  if (!agentTarget) return null;
  return {
    agentTarget,
    backendTarget: null,
    defaultAgentId: defaultAgentId ?? defaultBackendId,
    defaultBackendId: defaultAgentId ?? defaultBackendId,
    displayAgentType,
  };
}
