import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { fetchSessionsPage as fetchSessionsPageDefault } from '@/session/transport/http/sessionsHttp';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

export type PendingSessionActivationInput = Readonly<{
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  source: 'live' | 'changes' | 'scan';
  target?: SessionInputMachineTargetV1;
  requestedAt?: number;
}>;

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
    () => fetchSessionById({ token: bootstrap.credentials.token, sessionId, serverUrl: bootstrap.serverHttpBaseUrl }));
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
  visitOwnedSession?: (sessionId: string) => Promise<void>;
}>): Promise<void> {
  const fetchSessionsPage = params.fetchSessionsPage ?? fetchSessionsPageDefault;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await fetchSessionsPage({
      token: params.token,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const session of page.sessions) {
      if (!isOwnedSessionForPendingActivation(session)) continue;
      if ((session.pendingCount ?? 0) > 0) {
        await params.visitOwnedSession?.(session.id);
      }
      const authorization = session.pendingActivationAuthorization;
      if (!authorization || authorization.status !== 'waiting') continue;
      const input: PendingSessionActivationInput = {
        sessionId: session.id,
        requestId: authorization.requestId,
        pendingVersion: typeof session.pendingVersion === 'number' ? session.pendingVersion : 0,
        source: 'scan',
      };
      await params.activate(input).catch((error) => {
        params.warn('Pending session activation reconnect item failed; waiting custody retained', input, error);
      });
    }
    if (!page.hasNext || !page.nextCursor || seenCursors.has(page.nextCursor)) return;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function createPendingSessionActivationRecovery(params: Readonly<{
  token: string;
  activate: (input: PendingSessionActivationInput) => Promise<void>;
  warn: (message: string, input: PendingSessionActivationInput, error: unknown) => void;
  fetchSessionsPage?: typeof fetchSessionsPageDefault;
  visitOwnedSession?: (sessionId: string) => Promise<void>;
  /** Host composition discovers only already-held protected requester Session refs. */
  recoverRequesterSessions?: () => Promise<void>;
}>): Readonly<{
  activateHint: (input: PendingSessionActivationInput) => Promise<void>;
  recoverAfterConnect: () => Promise<void>;
}> {
  return {
    activateHint: params.activate,
    recoverAfterConnect: async () => {
      await recoverPendingSessionActivations(params);
      await params.recoverRequesterSessions?.();
    },
  };
}
