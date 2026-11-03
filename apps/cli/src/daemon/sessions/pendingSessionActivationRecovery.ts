import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { fetchSessionsPage as fetchSessionsPageDefault } from '@/session/transport/http/sessionsHttp';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionCredentialBinding, RequesterSessionRuntimeContext,
  ResolveRequesterSessionRuntimeContext, ReleaseRequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { activatePendingInactiveSession, type PendingInactiveSessionActivationRejected, type PendingSessionResumePort } from './activatePendingInactiveSession';
import { logger } from '@/utils/logger';

export type PendingSessionActivationInput = Readonly<{
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  source: 'live' | 'changes' | 'scan';
  target?: SessionInputMachineTargetV1;
  requestedAt?: number;
}>;

/** Live hints and reconnect scans share exact requester recovery and failure settlement. */
export async function activateRequesterPendingSession(params: Readonly<{
  machineId: string;
  binding: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution'>;
  hint?: PendingSessionActivationInput;
  resolveRequesterSessionRuntimeContext: ResolveRequesterSessionRuntimeContext;
  releaseRequesterSessionRuntimeContext: ReleaseRequesterSessionRuntimeContext;
  resolveCurrentMachineExecutionOriginContext(): Promise<CurrentMachineExecutionOriginContext | null>;
  onActivationRejected?: (event: PendingInactiveSessionActivationRejected) => Promise<void>;
  spawnSessionForInternalResume: PendingSessionResumePort;
}>): Promise<void> {
  const { binding, hint } = params;
  if (binding.attribution.machineId !== params.machineId) return;
  const activate = async (bootstrap: AdmittedRequesterSessionBootstrap, context?: RequesterSessionRuntimeContext) => {
    const isCurrent = () => context ? context.isCurrent() : bootstrap.isCurrent();
    if (!await isCurrent()) return;
    const current = await readRequesterPendingSessionActivation({ sessionId: binding.sessionId, bootstrap,
      resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext });
    if (!await isCurrent() || !current || hint && (hint.requestId !== current.requestId
      || hint.requestedAt !== undefined && hint.requestedAt !== current.requestedAt)) return;
    const result = await activatePendingInactiveSession({ credentials: bootstrap.credentials,
      machineId: params.machineId, sessionId: current.sessionId, requestId: current.requestId,
      pendingVersion: hint?.pendingVersion ?? current.pendingVersion, requester: bootstrap,
      expectedTarget: current.target, preparationFailed: context === undefined,
      resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext,
      onActivationRejected: params.onActivationRejected,
      spawnSessionForInternalResume: (options, pendingActivation) => params.spawnSessionForInternalResume({ ...options, requesterSessionBootstrap: bootstrap,
        ...(context ? { requesterSessionRuntimeContext: context } : {}) }, pendingActivation) });
    if (result.status === 'rejected') logger.warn('[DAEMON RUN] Requester Pending activation rejected; custody retained', {
      sessionId: current.sessionId, requestId: current.requestId, reason: result.reason, failureDetails: result.failureDetails,
    });
  };
  const context = await params.resolveRequesterSessionRuntimeContext(binding.sessionId, binding.attribution, undefined,
    bootstrap => activate(bootstrap));
  if (!context) return;
  try { await activate(context.bootstrap, context); }
  finally { await params.releaseRequesterSessionRuntimeContext(context); }
}

/** A protected local ref identifies the read; only fresh requester Home facts authorize recovery. */
export async function readRequesterPendingSessionActivation(params: Readonly<{
  sessionId: string; bootstrap: AdmittedRequesterSessionBootstrap;
  resolveCurrentMachineExecutionOriginContext(): Promise<CurrentMachineExecutionOriginContext | null>;
}>): Promise<PendingSessionActivationInput | null> {
  const { bootstrap, sessionId } = params;
  const origin = await params.resolveCurrentMachineExecutionOriginContext();
  if (!origin || origin.machineId !== bootstrap.attribution.machineId
    || bootstrap.getBoundSessionId() !== sessionId || !await bootstrap.isCurrent()) return null;
  const session = await runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl,
    () => fetchSessionById({ reason: 'session-control', token: bootstrap.credentials.token, sessionId, serverUrl: bootstrap.serverHttpBaseUrl }));
  const authorization = session?.pendingActivationAuthorization;
  const target = authorization?.admittedTarget;
  const attribution = bootstrap.attribution;
  if (!session || session.id !== sessionId || !isOwnedSessionForPendingActivation(session)
    || authorization?.status !== 'waiting' || !target || target.sessionId !== sessionId
    || target.homeId !== origin.serverIdentityId || target.accountId !== attribution.accountId
    || target.machineId !== attribution.machineId || target.installationId !== attribution.installationId
    || !await bootstrap.isCurrent()) return null;
  const finalOrigin = await params.resolveCurrentMachineExecutionOriginContext();
  if (finalOrigin?.serverIdentityId !== target.homeId || finalOrigin.machineId !== target.machineId) return null;
  return { sessionId, target, requestId: authorization.requestId, requestedAt: authorization.requestedAt,
    pendingVersion: session.pendingVersion ?? 0, source: 'scan' };
}

/**
 * Owner-only pending-activation eligibility through the canonical access projection.
 * Valid current effectiveAccess wins. Released share fallback only when absent.
 * Malformed current projection fails closed, so Team/Group-only recipients never activate.
 */
function isOwnedSessionForPendingActivation(
  session: Readonly<{
    effectiveAccess?: unknown;
    share?: unknown;
    metadataLayoutVersion?: unknown;
  }>,
): boolean {
  return readSessionAccessProjectionRoleV1(session) === 'owner';
}

export async function recoverPendingSessionActivations(params: Readonly<{
  token: string;
  activate: (input: PendingSessionActivationInput) => Promise<void>;
  warn: (message: string, input: PendingSessionActivationInput, error: unknown) => void;
  fetchSessionsPage?: typeof fetchSessionsPageDefault;
  visitOwnedSession?: (sessionId: string, session: RawSessionListRow) => Promise<void>;
  visitOwnedSessions?: (sessions: readonly RawSessionListRow[]) => Promise<void>;
}>): Promise<void> {
  const fetchSessionsPage = params.fetchSessionsPage ?? fetchSessionsPageDefault;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const recoveries: Promise<void>[] = [];
  const ownedSessions: RawSessionListRow[] = [];
  const visitFailures: unknown[] = [];
  try {
    while (true) {
      const page = await fetchSessionsPage({
        token: params.token,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const session of page.sessions) {
        if (!isOwnedSessionForPendingActivation(session)) continue;
        ownedSessions.push(session);
        // Each Session retains its own Follow observation and activation order;
        // its startup must not hold discovery or recovery of another Session.
        recoveries.push((async () => {
          // Follow progress has its own source custody, so a dormant receiver need
          // not already have an authored Pending row to be observed on reconnect.
          await params.visitOwnedSession?.(session.id, session);
          const authorization = session.pendingActivationAuthorization;
          if (!authorization || authorization.status !== 'waiting') return;
          const input: PendingSessionActivationInput = {
            sessionId: session.id,
            requestId: authorization.requestId,
            pendingVersion: typeof session.pendingVersion === 'number' ? session.pendingVersion : 0,
            source: 'scan',
          };
          await params.activate(input).catch((error) => {
            params.warn('Pending session activation reconnect item failed; waiting custody retained', input, error);
          });
        })().catch(error => { visitFailures.push(error); }));
      }
      if (!page.hasNext || !page.nextCursor || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  } finally {
    await Promise.all([
      ...recoveries,
      params.visitOwnedSessions?.(ownedSessions),
    ]);
    if (visitFailures.length > 0) throw visitFailures[0];
  }
}

export function createPendingSessionActivationRecovery(params: Readonly<{
  token: string;
  activate: (input: PendingSessionActivationInput) => Promise<void>;
  warn: (message: string, input: PendingSessionActivationInput, error: unknown) => void;
  fetchSessionsPage?: typeof fetchSessionsPageDefault;
  visitOwnedSession?: (sessionId: string, session: RawSessionListRow) => Promise<void>;
  visitOwnedSessions?: (sessions: readonly RawSessionListRow[]) => Promise<void>;
  /** Host composition discovers only already-held protected requester Session refs. */
  recoverRequesterSessions?: () => Promise<void>;
}>): Readonly<{
  activateHint: (input: PendingSessionActivationInput) => Promise<void>;
  recoverAfterConnect: () => Promise<void>;
}> {
  return {
    activateHint: params.activate,
    recoverAfterConnect: async () => {
      await Promise.all([
        recoverPendingSessionActivations(params),
        params.recoverRequesterSessions?.(),
      ]);
    },
  };
}
