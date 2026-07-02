import type { SessionHandoffProviderBundle } from '../types';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function exportSessionHandoffProviderBundle(params: Readonly<{
  metadata: unknown;
  activeServerDir: string;
}>): Promise<Readonly<{
  providerBundle: SessionHandoffProviderBundle;
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

	  const providerBundle = await providerOps.exportBundle({
	    sessionId: eligibility.vendorHandoffId,
	    metadata,
	    directory: params.activeServerDir,
	  });
	  if (!providerBundle.ok) {
	    throw new Error(providerBundle.message ?? `Session handoff export failed: ${providerBundle.code}`);
	  }
	  return {
	    providerBundle: providerBundle.value.bundle as SessionHandoffProviderBundle,
	    targetPath,
	  };
}
