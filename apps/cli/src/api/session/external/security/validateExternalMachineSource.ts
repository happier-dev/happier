import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { resolveExternalSessionSourceSurface } from '@/session/actions/externalSessions/providerOpsResolution';
import type { DirectSourceValidationResult } from '@/session/external/sourceValidation';

export async function validateExternalMachineSource(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  source: ExternalSessionsSource;
  env: NodeJS.ProcessEnv;
}>): Promise<DirectSourceValidationResult> {
  const { agentId, source, env } = params;
  const resolved = await resolveExternalSessionSourceSurface(agentId, source);
  if (!resolved.ok) {
    return {
      ok: false,
      errorCode: resolved.code === 'agent_unavailable' ? 'agent_unavailable' : 'invalid_request',
      error: `external_session_${resolved.code}`,
    };
  }
  if (!resolved.providerOps.validateSource) {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    };
  }
  return await resolved.providerOps.validateSource({ source: resolved.source, env });
}
