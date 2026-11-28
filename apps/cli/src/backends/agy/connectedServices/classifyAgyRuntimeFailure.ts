import { isConnectedServiceAccountReadConsented } from '@/daemon/connectedServices/consent/isConnectedServiceAccountReadConsented';
import { buildUsageLimitIssueFingerprint, ConnectedServiceCredentialRevisionV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeFailureClassification, ConnectedServiceRuntimeFailureInput } from '@/daemon/connectedServices/runtimeAuth/types';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { logger } from '@/ui/logger';
import { readGoogleAccountLink } from './codeAssistEntitlement';

type Kind = ConnectedServiceRuntimeFailureClassification['kind'];
type LimitCategory = NonNullable<ConnectedServiceRuntimeFailureClassification['limitCategory']>;
type NativeFailure = Readonly<{ kind: Kind; limitCategory: LimitCategory; quotaScope: 'account' | 'organization' | 'model'; linkAction?: true }>;

/**
 * `agy acp` reports no structured error for a failed turn: it sends one assistant chunk
 * `\n⚠ <error>\n` and answers `session/prompt` with `end_turn` (observed on 1.5.18 for an
 * invalid API key and an executor failure). The sign-in eligibility outcomes (verification,
 * Terms of Service block) are typed in the CLI (`AuthResult.verification_required`,
 * `tos_violation` with `appeal_url`) but how they reach ACP was not observed.
 */
const FAILURE_RECORD = /(?:^|\n)⚠ ([^\n]+)\s*$/u;

/** Matched against the failure text, in order. Messages are the CLI's own literals (binary + changelog). */
const NATIVE_FAILURES: ReadonlyArray<readonly [RegExp, NativeFailure]> = [
  // Observed: Gemini API executor error carrying google.rpc.ErrorInfo reason API_KEY_INVALID.
  [/\breason:API_KEY_INVALID\b/u, { kind: 'auth_expired', limitCategory: 'auth_invalid', quotaScope: 'account' }],
  // Observed (agy acp, 2026-11-27): "Individual quota reached. Please upgrade your subscription to
  // increase your limits. Resets in 142h7m6s." — the account's plan quota, with its reset countdown.
  [/Individual quota reached\./u, { kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account' }],
  // Inferred rendering: CLI literal for an exhausted model quota.
  [/You have exhausted your quota on this model\./u, { kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'model' }],
  // Inferred rendering: the observed executor-error format with the google.rpc status of a 429.
  [/\bStatus: RESOURCE_EXHAUSTED\b/u, { kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account' }],
  // Inferred rendering: CLI literal for an empty Gemini Enterprise prepaid wallet.
  [/Your organization's prepaid balance is insufficient\./u, { kind: 'plan', limitCategory: 'plan_invalid', quotaScope: 'organization' }],
  // Recoverable identity verification (VALIDATION_REQUIRED). Observed (agy acp, 2026-11-27, new account):
  // the bare line "Verification required" with no link; the longer forms are the CLI's own literals.
  [/^Verification required\.?$|Verification required\. Please complete verification in your browser to continue\.|Verify your account to continue\./iu,
    { kind: 'validation', limitCategory: 'validation_failed', quotaScope: 'account', linkAction: true }],
  // Inferred rendering: CLI literal for the permanent Terms of Service block; the appeal link is the action.
  [/Your account is blocked due to a Terms of Service violation\./u,
    { kind: 'account_disabled', limitCategory: 'disabled', quotaScope: 'account', linkAction: true }],
];

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

function failureText(error: unknown): string | null {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : text(record(error)?.message);
}

/** "Resets in 142h7m6s" (observed) as an absolute reset time; null when the message has no countdown. */
function readResetsAtMs(message: string): number | null {
  const match = /\bResets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/u.exec(message);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const seconds = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0);
  return Date.now() + seconds * 1000;
}

/** The verification or appeal link the CLI prints with the message (inferred: the first https URL). */
function readLink(message: string): string | null {
  const url = message.match(/https:\/\/[^\s<>"']+/u)?.[0]?.replace(/[.,;:)\]]+$/u, '');
  return url && URL.canParse(url) ? url : null;
}

export function classifyAgyRuntimeFailure(input: ConnectedServiceRuntimeFailureInput): ConnectedServiceRuntimeFailureClassification | null {
  const message = failureText(input.error);
  if (!message) return null;
  const failure = NATIVE_FAILURES.find(([pattern]) => pattern.test(message))?.[1];
  if (!failure) return null;
  const selection = record(input.selection);
  const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(selection?.credentialRevision);
  const link = failure.linkAction ? readLink(message) : null;
  const resetsAtMs = failure.kind === 'usage_limit' ? readResetsAtMs(message) : null;
  return {
    kind: failure.kind, limitCategory: failure.limitCategory, serviceId: 'antigravity',
    profileId: text(selection?.activeProfileId ?? selection?.profileId), groupId: text(selection?.groupId),
    groupGeneration: typeof selection?.generation === 'number' ? selection.generation : null,
    credentialRevision: revision.success ? revision.data : null,
    sourceProviderAccountId: text(selection?.providerAccountId), sourceAccountLabel: text(selection?.providerEmail),
    failingAccessTokenFingerprint: text(selection?.credentialFingerprint),
    resetsAtMs, retryAfterMs: null, quotaScope: failure.quotaScope, planType: null,
    rateLimits: { limitCategory: failure.limitCategory, resetAtMs: resetsAtMs, retryAfterMs: null, quotaScope: failure.quotaScope },
    ...(link ? { action: { kind: 'open_url', url: link } as const } : {}),
    source: 'stable_provider_message',
  };
}

/** Admit only the CLI's terminal failure chunk; quoted or discussed text never fails a turn. */
export function classifyAgyAssistantTurnFailure(params: Readonly<{ text: string; lastMessageText?: string; processEnv?: NodeJS.ProcessEnv }>): Error | null {
  const message = FAILURE_RECORD.exec(params.text)?.[1] ?? FAILURE_RECORD.exec(params.lastMessageText ?? '')?.[1];
  if (!message) return null;
  const selection = findConnectedServiceChildSelection(params.processEnv ?? process.env, 'antigravity');
  const classification = classifyAgyRuntimeFailure({ target: { agentId: 'agy' }, error: message, ...(selection ? { selection } : {}) });
  return classification ? Object.assign(new Error(message), { runtimeAuthClassification: classification }) : null;
}

/** Report the accepted failure of a connected-account turn; the daemon owns recovery. */
export async function reportAgyTurnFailure(params: Readonly<{ error: unknown; issue?: SessionRuntimeIssueV1 | null; sessionId: string | null; session: AcpRuntimeSessionClient; processEnv: NodeJS.ProcessEnv }>): Promise<void> {
  const selection = findConnectedServiceChildSelection(params.processEnv, 'antigravity');
  if (!selection || !params.sessionId) return;
  const classified = classifyAgyRuntimeFailure({ target: { agentId: 'agy' }, error: params.error, selection });
  if (!classified) return;
  const classification = params.issue ? { ...classified, runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(params.issue) } : classified;
  const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({ sessionId: params.sessionId, classification, switchesThisTurn: 0, logPrefix: '[agy]' });
  if (report.report === null) logger.warn('[agy] Connected-account recovery could not reach the daemon');
  const send = (message: string) => {
    if (!params.session.sendSessionEvent) return false;
    params.session.sendSessionEvent({ type: 'message', message });
    return true;
  };
  // A pool that moved the session to another account keeps its own switch message.
  if (classification.kind === 'validation' && report.statusCode !== 'switch_attempted_switched') {
    // Duplicate triggers of one failure coalesce onto the same daemon report.
    if (verificationReportsShown.has(report)) return;
    verificationReportsShown.add(report);
    send(await buildVerificationMessage(classification, params.processEnv));
    return;
  }
  projectConnectedServiceRuntimeAuthRecoveryReport({ report, classification, sendGenericStatusMessage: send });
}

const verificationReportsShown = new WeakSet<object>();

/**
 * Google's link comes from the failure text when agy printed one. Otherwise only a pool member's
 * entitlement is looked up (pool consent); any other account is told where to verify instead.
 */
async function buildVerificationMessage(classification: ConnectedServiceRuntimeFailureClassification, processEnv: NodeJS.ProcessEnv): Promise<string> {
  let url = readGoogleAccountLink(classification.action?.url);
  const lookupAllowed = isConnectedServiceAccountReadConsented({ serviceId: 'antigravity', poolMember: Boolean(classification.groupId) });
  if (!url && lookupAllowed) {
    const { readAgyVerificationLink } = await import('./readAgyVerificationLink');
    const link = await readAgyVerificationLink(processEnv);
    url = link.url;
    if (link.url === null) logger.warn(`[agy] Verification link unavailable: ${link.reason}`);
  }
  const intro = 'Google needs to verify this Antigravity account before it can be used.';
  if (url) return `${intro} Open ${url} to verify, then resend your message.`;
  return lookupAllowed
    ? `${intro} Verify the account with Google, then resend your message.`
    : `${intro} Sign in with this account in the Antigravity app or \`agy\` to complete verification, then resend your message.`;
}
