import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { fetchSessionsPage as fetchSessionsPageDefault } from '@/session/transport/http/sessionsHttp';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionCredentialBinding, RequesterSessionRuntimeContext,
  ResolveRequesterSessionRuntimeContext, ReleaseRequesterSessionRuntimeContext, RequesterSessionRecoveryRefusal } from '../sessionEncryption/requesterSessionCredentials';
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
  retryAfterEndpointPublication?: Promise<boolean>;
}>): Promise<void> {
  const { binding, hint } = params;
  if (binding.attribution.machineId !== params.machineId) return;
  const activate = async (context: RequesterSessionRuntimeContext) => {
    const { bootstrap } = context;
    const isCurrent = () => context.isCurrent();
    if (!await isCurrent()) return;
    const current = await readRequesterPendingSessionActivation({ sessionId: binding.sessionId, bootstrap,
      resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext });
    if (!await isCurrent() || !current || hint && (hint.requestId !== current.requestId
      || hint.requestedAt !== undefined && hint.requestedAt !== current.requestedAt)) return;
    const result = await activatePendingInactiveSession({ credentials: bootstrap.credentials,
      machineId: params.machineId, sessionId: current.sessionId, requestId: current.requestId,
      pendingVersion: hint?.pendingVersion ?? current.pendingVersion, requester: bootstrap,
      retryAfterEndpointPublication: params.retryAfterEndpointPublication,
      expectedTarget: current.target,
      resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext,
      onActivationRejected: params.onActivationRejected,
      spawnSessionForInternalResume: (options, pendingActivation) => params.spawnSessionForInternalResume({ ...options, requesterSessionBootstrap: bootstrap,
        requesterSessionRuntimeContext: context }, pendingActivation) });
    if (result.status === 'rejected') logger.warn('[DAEMON RUN] Requester Pending activation rejected; custody retained', {
      sessionId: current.sessionId, requestId: current.requestId, reason: result.reason, failureDetails: result.failureDetails,
    });
  };
  const context = await params.resolveRequesterSessionRuntimeContext(binding.sessionId, binding.attribution, undefined,
    async refusal => {
      if (refusal.sessionId !== binding.sessionId) return;
      await settleRequesterPendingSessionPreparationRefusal({ refusal, hint, onActivationRejected: params.onActivationRejected });
    });
  if (!context) return;
  try { await activate(context); }
  finally { await params.releaseRequesterSessionRuntimeContext(context); }
}

/** Every cold requester recovery settles an existing Pending refusal through its original owner. */
export async function settleRequesterPendingSessionPreparationRefusal(params: Readonly<{
  refusal: RequesterSessionRecoveryRefusal;
  hint?: PendingSessionActivationInput;
  onActivationRejected?: (event: PendingInactiveSessionActivationRejected) => Promise<void>;
}>): Promise<void> {
  const { refusal, hint } = params;
  await runWithServerHttpBaseUrl(refusal.serverHttpBaseUrl, async () => {
    // A stamped live hint needs no executable admission to report failure.
    // Reconnect scans obtain the stamp through the same retained owner bearer.
    const authorization = hint?.requestedAt !== undefined ? hint
      : (await fetchSessionById({ reason: 'session-control', token: refusal.credentials.token,
        sessionId: refusal.sessionId, serverUrl: refusal.serverHttpBaseUrl }))?.pendingActivationAuthorization;
    if (refusal.signal?.aborted || !authorization || authorization.requestedAt === undefined) return;
    let didFail: boolean | null = null;
    try {
      ({ didFail } = await reportPendingSessionActivationFailure({ token: refusal.credentials.token,
        sessionId: refusal.sessionId, requestId: authorization.requestId, requestedAt: authorization.requestedAt,
        failureCode: 'runtime_start_failed' }));
      if (didFail) await params.onActivationRejected?.({ sessionId: refusal.sessionId,
        reason: 'identity-unavailable', requester: refusal.attribution });
    } finally {
      logger.infoFile('[DAEMON RUN] Requester Pending preparation refused', {
        sessionId: refusal.sessionId, requestId: authorization.requestId, code: 'session_input_target_unavailable', didFail,
      });
    }
  });
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
        // Each Session retains its own Pending recovery and activation order;
        // its startup must not hold discovery or recovery of another Session.
        recoveries.push((async () => {
          // Follow discovers its own Account work set in visitOwnedSessions;
          // it does not require an authored Pending row on a dormant receiver.
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
  activate: (input: PendingSessionActivationInput, retryAfterEndpointPublication?: Promise<boolean>) => Promise<void>;
  warn: (message: string, input: PendingSessionActivationInput, error: unknown) => void;
  fetchSessionsPage?: typeof fetchSessionsPageDefault;
  visitOwnedSession?: (sessionId: string, session: RawSessionListRow) => Promise<void>;
  visitOwnedSessions?: (sessions: readonly RawSessionListRow[]) => Promise<void>;
  /** Host composition discovers only already-held protected requester Session refs. */
  recoverRequesterSessions?: (retryAfterEndpointPublication?: Promise<boolean>) => Promise<void>;
}>): Readonly<{
  activateHint: (input: PendingSessionActivationInput) => Promise<void>;
  recoverAfterConnect: (retryAfterEndpointPublication?: Promise<boolean>) => Promise<void>;
}> {
  return {
    activateHint: params.activate,
    recoverAfterConnect: async retryAfterEndpointPublication => {
      await Promise.all([
        recoverPendingSessionActivations({ ...params,
          activate: input => params.activate(input, retryAfterEndpointPublication) }),
        params.recoverRequesterSessions?.(retryAfterEndpointPublication),
      ]);
    },
  };
}
