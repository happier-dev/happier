import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { DirectSourceValidationResult } from '@/session/external/sourceValidation';

export async function validateDirectMachineSource(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  source: ExternalSessionsSource;
  env: NodeJS.ProcessEnv;
}>): Promise<DirectSourceValidationResult> {
  const { agentId, source, env } = params;
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(agentId)).externalSession;
  if (!providerOps?.validateSource) {
    return { ok: false, error: `Unsupported direct-session provider: ${agentId}` };
  }
  return await providerOps.validateSource({ source, env });
}
