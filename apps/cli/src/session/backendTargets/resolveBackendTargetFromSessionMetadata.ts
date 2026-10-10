import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { isConcreteLegacyConfiguredBackendId } from '@/session/backendTargets/compat/legacyConfiguredBackend';

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBuiltInBackendTarget(backendId: unknown): BackendTargetRefV2 | null {
  const normalized = readNonEmptyString(backendId);
  if (!normalized || !isConcreteLegacyConfiguredBackendId(normalized)) return null;

  try {
    return readBackendTargetRefV2({
      kind: 'backend',
      backendId: normalized,
      sourceKind: 'built_in',
    });
  } catch {
    return null;
  }
}

function resolveBackendTargetFromSessionMetadataWithAgentId(
  metadata: Record<string, unknown> | null | undefined,
  agentId: unknown,
): BackendTargetRefV2 | null {
  const configuredBackendId = readNonEmptyString(
    readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId,
  );
  if (configuredBackendId) {
    return {
      kind: 'backend',
      backendId: configuredBackendId,
      configuredBackendId,
      sourceKind: 'configured',
    };
  }

  const runtimeDescriptorBackendTarget = readBuiltInBackendTarget(
    readRuntimeDescriptorV1FromMetadata(metadata)?.agentId,
  );
  if (runtimeDescriptorBackendTarget) return runtimeDescriptorBackendTarget;

  return readBuiltInBackendTarget(agentId);
}

/**
 * The one backend target a Session's metadata declares, or `null`.
 *
 * There is no separate "explicit" reading any more: Agent identity is read once
 * through `resolveAgentIdFromSessionMetadata`, which answers `null` for an
 * unknown or ambiguous Session instead of naming the default Agent.
 */
export function resolveBackendTargetFromSessionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): BackendTargetRefV2 | null {
  return resolveBackendTargetFromSessionMetadataWithAgentId(
    metadata,
    resolveAgentIdFromSessionMetadata(metadata),
  );
}
