import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    readAcpConfiguredBackendV1FromMetadata,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import {
    isAgentId,
    type AgentId,
} from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type ResolvedSessionActionDefaultBackend = Readonly<{
  backendTarget: BackendTargetRefV2;
  defaultBackendId: string | null;
  displayAgentType: AgentId | null;
}>;

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
  if (sessionAgent && isAgentId(sessionAgent) && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(sessionAgent))) {
    return sessionAgent;
  }

  const metadata = params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
    ? (params.metadata as Record<string, unknown>)
    : null;
  const metadataAgentId = resolveAgentIdFromSessionMetadata(metadata);
  if (metadataAgentId && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(metadataAgentId))) {
    return metadataAgentId;
  }

  const fallbackAgentId = typeof params.fallbackAgentId === 'string' && params.fallbackAgentId.trim().length > 0
    ? params.fallbackAgentId
    : null;
  if (fallbackAgentId && (params.enabledAgentIds.length === 0 || params.enabledAgentIds.includes(fallbackAgentId))) {
    return fallbackAgentId;
  }

  return params.enabledAgentIds[0] ?? metadataAgentId ?? fallbackAgentId ?? null;
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
  defaultBuiltInAgentId: AgentId | null;
}>): AgentId | null {
  return params.defaultBuiltInAgentId;
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
  const displayAgentType = resolveDisplayAgentType({
    defaultBuiltInAgentId,
  });

  if (configuredBackend?.backendId) {
    return {
      backendTarget: {
        kind: 'backend',
        backendId: configuredBackend.backendId,
        configuredBackendId: configuredBackend.backendId,
        sourceKind: 'configured',
      },
      defaultBackendId,
      displayAgentType,
    };
  }

  if (!defaultBuiltInAgentId) return null;
  return {
    backendTarget: { kind: 'backend', backendId: defaultBuiltInAgentId },
    defaultBackendId,
    displayAgentType,
  };
}
