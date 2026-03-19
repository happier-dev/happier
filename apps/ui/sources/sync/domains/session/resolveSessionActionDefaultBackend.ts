import { readAcpConfiguredBackendV1FromMetadata, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import type { Session } from '@/sync/domains/state/storageTypes';

export type ResolvedSessionActionDefaultBackend = Readonly<{
  backendTarget: BackendTargetRefV1;
  defaultBackendId: string | null;
}>;

function normalizeEnabledAgentIds(enabledAgentIds: readonly AgentId[] | null | undefined): readonly AgentId[] {
  return Array.isArray(enabledAgentIds) ? enabledAgentIds.filter((value): value is AgentId => typeof value === 'string' && value.trim().length > 0) : [];
}

function resolveDefaultBuiltInAgentId(params: Readonly<{
  metadata: unknown;
  enabledAgentIds: readonly AgentId[];
  fallbackAgentId?: AgentId | null;
}>): AgentId | null {
  const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
    ? (params.metadata as Record<string, unknown>)
    : null;
  const sessionAgent = typeof metadata?.agent === 'string' ? metadata.agent.trim() : '';
  if (sessionAgent && params.enabledAgentIds.includes(sessionAgent as AgentId)) {
    return sessionAgent as AgentId;
  }

  const flavorAgentId = resolveAgentIdFromFlavor(typeof metadata?.flavor === 'string' ? metadata.flavor : null);
  if (flavorAgentId && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(flavorAgentId))) {
    return flavorAgentId;
  }

  const fallbackAgentId = typeof params.fallbackAgentId === 'string' && params.fallbackAgentId.trim().length > 0
    ? params.fallbackAgentId
    : null;
  if (fallbackAgentId && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(fallbackAgentId))) {
    return fallbackAgentId;
  }

  return params.enabledAgentIds[0] ?? (flavorAgentId ?? fallbackAgentId ?? DEFAULT_AGENT_ID);
}

function resolveDefaultBackendId(params: Readonly<{
  metadata: unknown;
  defaultBuiltInAgentId: AgentId | null;
}>): string | null {
  const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
    ? (params.metadata as Record<string, unknown>)
    : null;
  const sessionAgent = typeof metadata?.agent === 'string' ? metadata.agent.trim() : '';
  if (sessionAgent) return sessionAgent;
  return params.defaultBuiltInAgentId ?? null;
}

export function resolveSessionActionDefaultBackend(params: Readonly<{
  session: Session | null | undefined;
  enabledAgentIds?: readonly AgentId[] | null;
  fallbackAgentId?: AgentId | null;
}>): ResolvedSessionActionDefaultBackend | null {
  const metadata = params.session?.metadata ?? null;
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
  });

  if (configuredBackend?.backendId) {
    return {
      backendTarget: { kind: 'configuredAcpBackend', backendId: configuredBackend.backendId },
      defaultBackendId,
    };
  }

  if (!defaultBuiltInAgentId) return null;
  return {
    backendTarget: { kind: 'builtInAgent', agentId: defaultBuiltInAgentId },
    defaultBackendId,
  };
}
