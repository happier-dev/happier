import type { SessionHandoffAgentBundle } from '../types';
import {
  isBundledAgentId,
  projectSessionMetadataForAgentHandoff,
  resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  resolveLinkedExternalSessionAuthorityV1,
} from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function exportSessionHandoffAgentBundle(params: Readonly<{
  metadata: unknown;
  activeServerDir: string;
}>): Promise<Readonly<{
  agentBundle: SessionHandoffAgentBundle;
  targetPath: string;
}>> {
  const metadata = asRecord(params.metadata);
  if (!metadata) {
    throw new Error('Session metadata is unavailable');
  }

  const agentMetadata = projectSessionMetadataForAgentHandoff(metadata);
  const sessionAgentId = resolveAgentIdFromSessionMetadata(metadata);
  const bridge = getSessionHostBridge();
  const eligibility = await bridge.resolveSessionHandoffEligibility({
    metadata: agentMetadata,
    sourceMachineId: metadata.machineId,
    externalSessionLinkAuthority:
      resolveLinkedExternalSessionAuthorityV1(metadata),
    ...(!isBundledAgentId(sessionAgentId ?? '') && sessionAgentId
      ? { sessionAgentId }
      : {}),
  });
  if (!eligibility.eligible) {
    throw new Error(`Session is not eligible for handoff: ${eligibility.reasonCode}`);
  }

  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  if (!targetPath) {
    throw new Error('Session path is unavailable for handoff');
  }

  const currentExternalRuntime = eligibility.backendId
    ? await bridge.resolveCurrentExecutionSurfacesForCatalogAgent(eligibility.agentId)
    : null;
  const providerOps = currentExternalRuntime
    && currentExternalRuntime.agentId === eligibility.agentId
    && currentExternalRuntime.backendId === eligibility.backendId
    ? currentExternalRuntime.executionSurfaces.handoff
    : eligibility.backendId
      ? null
      : isBundledAgentId(eligibility.agentId)
        ? (await bridge.resolveExecutionSurfaces(eligibility.agentId)).handoff
        : null;
  if (!providerOps) {
    throw new Error(`Unsupported handoff provider: ${eligibility.agentId}`);
  }

  const agentBundle = await providerOps.exportBundle({
    sessionId: eligibility.vendorHandoffId,
    metadata: agentMetadata,
    directory: params.activeServerDir,
  });
  if (!agentBundle.ok) {
    throw new Error(agentBundle.message ?? `Session handoff export failed: ${agentBundle.code}`);
  }
  return {
    agentBundle: agentBundle.value.bundle as SessionHandoffAgentBundle,
    targetPath,
  };
}
