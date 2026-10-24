import { buildUsageLimitIssueFingerprint, ConnectedServiceCredentialRevisionV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { classifyProviderLimitEvidence } from '@/daemon/connectedServices/quotas/normalization';
import type { ConnectedServiceRuntimeFailureInput, ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { logger } from '@/ui/logger';

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

/** Exact rendered diagnostic from Antigravity ACP 1.3.0 ccpa_connection/quota_errors.py.
 * This admits an unstructured provider message; quoted text and general quota discussion
 * have no failure provenance. Reset prose is advisory, not an exact reset instant.
 */
function diagnostic(value: unknown): string | null {
  const message = typeof value === 'string' ? value : value instanceof Error ? value.message : text(record(value)?.message);
  if (!message) return null;
  const normalized = message.trim().replace(/\r\n/g, '\n');
  const signature = /^Usage Limit Reached\n\nYou have reached your current quota for this period\.(?: Your limit will reset (?:in \d+ (?:days?|hours?|minutes?|seconds?)(?:, \d+ (?:days?|hours?|minutes?|seconds?))?|on [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2} UTC)\.)?$/u;
  return signature.test(normalized) ? normalized : null;
}

export function classifyAgyRuntimeQuotaFailure(input: ConnectedServiceRuntimeFailureInput): ConnectedServiceRuntimeFailureClassification | null {
  const message = diagnostic(input.error);
  if (!message) return null;
  const category = classifyProviderLimitEvidence(message);
  if (category !== 'usage_limit') return null;
  const selection = record(input.selection);
  const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selection?.credentialRevision);
  return {
    kind: 'usage_limit', limitCategory: category, serviceId: 'antigravity',
    profileId: text(selection?.activeProfileId ?? selection?.profileId), groupId: text(selection?.groupId),
    groupGeneration: typeof selection?.generation === 'number' ? selection.generation : null,
    credentialRevision: revision.success ? revision.data : null,
    sourceProviderAccountId: text(selection?.providerAccountId), sourceAccountLabel: text(selection?.providerEmail),
    failingAccessTokenFingerprint: text(selection?.credentialFingerprint),
    resetsAtMs: null, retryAfterMs: null, quotaScope: 'account', planType: null,
    rateLimits: { limitCategory: category, resetAtMs: null, retryAfterMs: null, quotaScope: 'account' },
    source: 'stable_provider_message',
  };
}
export function classifyAgyAssistantTurnFailure(params: Readonly<{ text: string; lastMessageText?: string; processEnv?: NodeJS.ProcessEnv }>): Error | null {
  // The server can emit its complete error chunk after earlier assistant text.
  // Segment reconciliation also admits a diagnostic split across transport chunks.
  const message = diagnostic(params.text) ?? diagnostic(params.lastMessageText);
  if (!message) return null;
  const selection = findConnectedServiceChildSelection(params.processEnv ?? process.env, 'antigravity');
  const classification = classifyAgyRuntimeQuotaFailure({ target: { agentId: 'agy' }, error: message, ...(selection ? { selection } : {}) });
  return classification ? Object.assign(new Error(message), { runtimeAuthClassification: classification }) : null;
}

/** Report the accepted ACP failure occurrence; the daemon owns recovery. */
export async function reportAgyTurnFailure(params: Readonly<{ error: unknown; issue?: SessionRuntimeIssueV1 | null; sessionId: string | null; session: AcpRuntimeSessionClient; processEnv: NodeJS.ProcessEnv }>): Promise<void> {
  const selection = findConnectedServiceChildSelection(params.processEnv, 'antigravity');
  if (!selection || !params.sessionId) return;
  const classified = classifyAgyRuntimeQuotaFailure({ target: { agentId: 'agy' }, error: params.error, selection });
  const classification = classified && params.issue ? { ...classified, runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(params.issue) } : classified;
  if (!classification) return;
  const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({ sessionId: params.sessionId, classification, switchesThisTurn: 0, logPrefix: '[agy]' });
  if (report.report === null) logger.warn('[agy] Connected-account quota recovery could not reach the daemon');
  projectConnectedServiceRuntimeAuthRecoveryReport({ report, classification, sendGenericStatusMessage: (message) => {
    if (!params.session.sendSessionEvent) return false;
    params.session.sendSessionEvent({ type: 'message', message });
    return true;
  } });
}
