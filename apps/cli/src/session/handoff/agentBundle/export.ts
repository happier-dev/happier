import type { SessionHandoffAgentBundle } from '../types';

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

  const bridge = getSessionHostBridge();
  const eligibility = bridge.resolveSessionHandoffEligibility({ metadata });
  if (!eligibility.eligible) {
    throw new Error(`Session is not eligible for handoff: ${eligibility.reasonCode}`);
  }

  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  if (!targetPath) {
    throw new Error('Session path is unavailable for handoff');
  }

  const providerOps = (await bridge.resolveExecutionSurfaces(eligibility.agentId)).handoff;
  if (!providerOps) {
    throw new Error(`Unsupported handoff provider: ${eligibility.agentId}`);
  }

	  const agentBundle = await providerOps.exportBundle({
	    sessionId: eligibility.vendorHandoffId,
	    metadata,
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
