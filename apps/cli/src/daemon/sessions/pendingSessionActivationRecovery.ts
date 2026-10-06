import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import { fetchSessionsPage as fetchSessionsPageDefault } from '@/session/transport/http/sessionsHttp';

export type PendingSessionActivationInput = Readonly<{
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  source: 'live' | 'changes' | 'scan';
}>;

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
}>): Readonly<{
  activateHint: (input: PendingSessionActivationInput) => Promise<void>;
  recoverAfterConnect: () => Promise<void>;
}> {
  return {
    activateHint: params.activate,
    recoverAfterConnect: async () => {
      await recoverPendingSessionActivations(params);
    },
  };
}
