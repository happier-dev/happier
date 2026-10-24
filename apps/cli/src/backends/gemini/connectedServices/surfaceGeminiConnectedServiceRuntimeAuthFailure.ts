import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol';
import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  reportConnectedServiceRuntimeAuthFailureToDaemon,
  type ConnectedServiceRuntimeAuthFailureDaemonReport,
} from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { logger } from '@/ui/logger';

import { createGeminiConnectedServiceRuntimeAuthAdapter } from './createGeminiConnectedServiceRuntimeAuthAdapter';
import {
  GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT_ENV,
  GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID_ENV,
  GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL_ENV,
} from './materializeGeminiConnectedServiceAuth';

/**
 * Gemini producer for the connected-services reactive recovery contract (RD-OPI-2).
 *
 * Mirrors the Claude/Codex/Pi/OpenCode suppression contract: raw provider errors are never
 * rendered from here; only the STRUCTURED classification is reported to the daemon
 * (`reportConnectedServiceRuntimeAuthFailureToDaemon`) and only the daemon's typed recovery
 * projection (transcript event / status message) is committed back to the session.
 */
export type GeminiRuntimeAuthFailureSessionClient = Readonly<{
  sessionId: string;
  sessionTurnLifecycle?: SessionTurnLifecycle;
  sendSessionEvent?: (event: Readonly<{ type: 'message'; message: string }>) => void;
}>;

type ReportNotify = NonNullable<Parameters<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>[0]['notify']>;

const geminiRuntimeAuthAdapter = createGeminiConnectedServiceRuntimeAuthAdapter();

export type GeminiConnectedServiceRuntimeAuthFailureReportResult = Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  recoveryReport: ConnectedServiceRuntimeAuthFailureDaemonReport | null;
}>;

/**
 * Classify a Gemini runtime failure against the session's gemini connected-service selection.
 *
 * Reactive recovery reporting is a connected-services contract: a native (non-connected) Gemini
 * session has no selection to refresh/switch, so it classifies to `null` and keeps its existing
 * error surfaces untouched.
 */
export function classifyGeminiConnectedServiceRuntimeAuthFailure(params: Readonly<{
  error: unknown;
  env?: NodeJS.ProcessEnv;
  targetId?: string | null;
}>): ConnectedServiceRuntimeFailureClassification | null {
  const env = params.env ?? process.env;
  const selection = findConnectedServiceChildSelection(env, 'gemini');
  if (!selection) return null;
  return geminiRuntimeAuthAdapter.classifyRuntimeAuthFailure({
    target: { agentId: 'gemini', targetId: params.targetId ?? null },
    error: params.error,
    selection: {
      ...selection,
      providerAccountId: env[GEMINI_CONNECTED_SERVICE_PROVIDER_ACCOUNT_ID_ENV] ?? null,
      providerEmail: env[GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL_ENV] ?? null,
      credentialFingerprint: env[GEMINI_CONNECTED_SERVICE_CREDENTIAL_FINGERPRINT_ENV] ?? null,
    },
  });
}

/**
 * Report a classified Gemini connected-service runtime failure to the daemon. The daemon report
 * remains the canonical recovery result; this leaf only projects its generic status fallback when
 * the daemon did not already own a typed transcript projection.
 */
export async function surfaceGeminiConnectedServiceRuntimeAuthFailure(params: Readonly<{
  session: GeminiRuntimeAuthFailureSessionClient;
  classification: ConnectedServiceRuntimeFailureClassification;
  failedTurn?: Readonly<{ sessionSeq?: number | null }>;
  logPrefix?: string;
  /** Boundary injection for tests: daemon local-control notify + outbox dir. */
  notify?: ReportNotify;
  reportOutboxDir?: string;
}>): Promise<ConnectedServiceRuntimeAuthFailureDaemonReport> {
  const logPrefix = params.logPrefix ?? '[gemini]';
  let classification = params.classification;
  if (params.failedTurn) {
    // Canonical terminal admission is synchronous; recovery must not wait for its durable write.
    void surfacePrimarySessionRuntimeIssue({ provider: 'gemini', cause: 'status_error', session: params.session,
      error: { runtimeAuthClassification: classification }, sessionSeq: params.failedTurn.sessionSeq,
      suppressUntrustedDuplicate: true,
      onFailureTurn: ({ issue }) => { classification = { ...classification, runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(issue) }; },
    }).catch((error) => { logger.debug(`${logPrefix} Failed to persist accepted turn failure (non-fatal)`, error); });
  }
  const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
    sessionId: params.session.sessionId,
    switchesThisTurn: 0,
    classification,
    logPrefix,
    ...(params.notify ? { notify: params.notify } : {}),
    ...(params.reportOutboxDir ? { reportOutboxDir: params.reportOutboxDir } : {}),
  });
  projectConnectedServiceRuntimeAuthRecoveryReport({
    report: recoveryReport,
    classification,
    sendGenericStatusMessage: (message) => {
      if (!params.session.sendSessionEvent) return false;
      params.session.sendSessionEvent({ type: 'message', message });
      return true;
    },
  });
  return recoveryReport;
}

/**
 * Provider runtime entry point for Gemini failures. Callers await the daemon report so a handled
 * recovery outcome can suppress their raw provider-error fallback.
 */
export async function reportGeminiConnectedServiceRuntimeAuthFailureBestEffort(params: Readonly<{
  session: GeminiRuntimeAuthFailureSessionClient;
  error: unknown;
  failedTurn?: Readonly<{ sessionSeq?: number | null }>;
  env?: NodeJS.ProcessEnv;
  logPrefix?: string;
}>): Promise<GeminiConnectedServiceRuntimeAuthFailureReportResult | null> {
  const classification = classifyGeminiConnectedServiceRuntimeAuthFailure({
    error: params.error,
    ...(params.env ? { env: params.env } : {}),
  });
  if (!classification) return null;
  try {
    const recoveryReport = await surfaceGeminiConnectedServiceRuntimeAuthFailure({
      session: params.session,
      classification,
      ...(params.failedTurn ? { failedTurn: params.failedTurn } : {}),
      ...(params.logPrefix ? { logPrefix: params.logPrefix } : {}),
    });
    return { classification, recoveryReport };
  } catch (error) {
    logger.debug(`${params.logPrefix ?? '[gemini]'} Failed to surface connected-service runtime auth failure (non-fatal)`, error);
    return { classification, recoveryReport: null };
  }
}
