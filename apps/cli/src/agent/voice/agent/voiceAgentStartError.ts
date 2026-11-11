import type { CatalogAgentId } from '@/agent/catalog/ids';
import { readConnectedServiceUxDiagnosticFromError } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { buildConnectedServiceCredentialSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { VoiceAgentError } from './voiceAgentTypes';
import { readExecutionRunErrorCode } from '@/agent/runtime/bridges/executionRun/errors';
import { isPluginError } from '@happier-dev/cli-common/plugins/errors';

/** Keep the runtime and credential owners' results when adapting startup to Voice. */
export function toVoiceAgentStartError(
  error: unknown,
  agentId: CatalogAgentId,
  fallback: string,
  fallbackCode: 'VOICE_AGENT_START_FAILED' | 'VOICE_AGENT_UNSUPPORTED' = 'VOICE_AGENT_START_FAILED',
): VoiceAgentError {
  if (error instanceof VoiceAgentError) return error;
  if (isPluginError(error)) return new VoiceAgentError(error.code, error.message, undefined, error.details);
  let diagnostic = readConnectedServiceUxDiagnosticFromError(error);
  if (!diagnostic) {
    const result = buildConnectedServiceCredentialSpawnErrorResult({ agentId, error });
    if (result?.errorDetail?.kind === 'connected_service_ux_diagnostic') diagnostic = result.errorDetail.uxDiagnostic;
  }
  if (diagnostic) {
    return new VoiceAgentError(diagnostic.code, diagnostic.code, diagnostic);
  }
  return new VoiceAgentError(readExecutionRunErrorCode(error) ?? fallbackCode,
    error instanceof Error ? error.message : fallback);
}
