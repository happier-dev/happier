import type { CatalogAgentId } from '@/agent/catalog/ids';
import { readConnectedServiceUxDiagnosticFromError } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { buildConnectedServiceCredentialSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { VoiceAgentError } from './voiceAgentTypes';

/** Keep the credential owner's result when adapting runtime startup to Voice. */
export function toVoiceAgentStartError(
  error: unknown,
  agentId: CatalogAgentId,
  fallback: string,
  fallbackCode: 'VOICE_AGENT_START_FAILED' | 'VOICE_AGENT_UNSUPPORTED' = 'VOICE_AGENT_START_FAILED',
): VoiceAgentError {
  if (error instanceof VoiceAgentError) return error;
  let diagnostic = readConnectedServiceUxDiagnosticFromError(error);
  if (!diagnostic) {
    const result = buildConnectedServiceCredentialSpawnErrorResult({ agentId, error });
    if (result?.errorDetail?.kind === 'connected_service_ux_diagnostic') diagnostic = result.errorDetail.uxDiagnostic;
  }
  if (diagnostic) {
    return new VoiceAgentError(diagnostic.code, diagnostic.code, diagnostic);
  }
  return new VoiceAgentError(fallbackCode, error instanceof Error ? error.message : fallback);
}
