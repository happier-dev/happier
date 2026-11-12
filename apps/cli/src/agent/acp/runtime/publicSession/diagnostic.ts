import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { AgentRuntimeDiagnosticDataV1Schema, AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime/agentSessionLimitsV1';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { readAcpRequestErrorCode } from '@/agent/acp/withRetry';
import { readNativeStartupFailureDetail } from '@/agent/runtime/session/errors/nativeStartupFailureDetail';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

export function createPublicAcpDiagnostic(code: string, message?: string, error?: unknown): PluginDiagnosticData {
  const errorRecord = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown> : null;
  const supplied = AgentRuntimeDiagnosticDataV1Schema.safeParse(errorRecord?.diagnostic);
  if (supplied.success) return Object.freeze(supplied.data);
  const requestErrorCode = readAcpRequestErrorCode(error);
  const issue = error === undefined ? null : classifyPrimarySessionRuntimeIssue({ cause: 'status_error', fallbackSource: 'agent_session_error', error });
  const details = {
    ...(requestErrorCode !== null ? { requestErrorCode } : {}),
    ...(issue ? { v: 1, source: issue.source,
      failureCause: issue.failureCause ?? {
        phase: 'turn', failureReason: 'unclassified_provider_error', ...readNativeStartupFailureDetail(error),
      },
      ...(issue.source === 'usage_limit' && issue.usageLimit ? { usageLimit: issue.usageLimit } : {}),
    } : {}),
  };
  return Object.freeze({
    code,
    severity: 'error' as const,
    // AcpAgentPeer owns redaction and its transport byte budget. The strict
    // runtime diagnostic has its own existing string bound; preserve its cause.
    ...(message ? { message: redactBugReportSensitiveText(message).slice(0, AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.descriptionMaxCodeUnits) } : {}),
    ...(Object.keys(details).length ? { details: AgentRuntimeJsonValueV1Schema.parse(details) } : {}),
  });
}
