import {
  isLegacyCustomAcpId,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import {
  isCatalogAgentId,
  resolveAgentCliSubcommand,
} from '@/agent/catalog/resolution';
import {
  resolveConcreteBackendTargetRefV2,
  resolveConcreteCompatBackendTargetRefs,
} from '@/session/backendTargets/resolveConcreteBackendTargetRefs';

function resolveActiveCatalogAgentId(parsed: BackendTargetRefV2): CatalogAgentId | null {
  return parsed.backendId !== 'customAcp' && isCatalogAgentId(parsed.backendId)
    ? parsed.backendId
    : null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeDaemonBackendTargetV2Input(target: BackendTargetRefV2 | unknown): BackendTargetRefV2 | null {
  // Transport/daemon ingress may still carry legacy backend-target carriers (V1 shapes and
  // key strings). Canonicalize those inputs to the V2 transport shape here so downstream
  // routing stays V2-only.
  const compat = resolveConcreteCompatBackendTargetRefs(target as any);
  if (compat) {
    return compat.backendTargetV2;
  }

  const parsed = resolveConcreteBackendTargetRefV2(target as BackendTargetRefV2 | undefined);
  if (parsed) {
    return parsed;
  }

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }

  const record = target as Record<string, unknown>;
  if (record.kind !== 'backend' || record.sourceKind !== 'configured') {
    return null;
  }

  const backendId = readStringField(record, 'backendId');
  const configuredBackendId = readStringField(record, 'configuredBackendId');
  if (!isLegacyCustomAcpId(backendId) || !configuredBackendId || isLegacyCustomAcpId(configuredBackendId)) {
    return null;
  }

  return {
    kind: 'backend',
    backendId: configuredBackendId,
    configuredBackendId,
    sourceKind: 'configured',
  };
}

export function resolveDaemonCatalogAgentIdFromBackendTarget(
  target: BackendTargetRefV2 | undefined,
): CatalogAgentId | null {
  const parsed = normalizeDaemonBackendTargetV2Input(target);
  if (!parsed) {
    return null;
  }
  if (parsed.sourceKind === 'configured') {
    // Configured ACP backends are not a built-in catalog agent identity. The daemon must route them
    // by backend-target identity (configuredBackendId) rather than a synthetic `customAcp` agent id.
    return null;
  }
  if (parsed.sourceKind !== 'built_in') {
    return null;
  }
  return resolveActiveCatalogAgentId(parsed);
}

export function resolveDaemonCliSubcommandFromBackendTarget(
  target: BackendTargetRefV2 | undefined,
): CatalogAgentId | 'acp-catalog' | null {
  const parsed = normalizeDaemonBackendTargetV2Input(target);
  if (!parsed) {
    return null;
  }
  if (parsed.sourceKind === 'configured') {
    return 'acp-catalog';
  }
  if (parsed.sourceKind !== 'built_in') {
    return null;
  }
  const agentId = resolveActiveCatalogAgentId(parsed);
  return agentId ? resolveAgentCliSubcommand(agentId) : null;
}
