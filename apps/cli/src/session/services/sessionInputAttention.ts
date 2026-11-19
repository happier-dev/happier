import type { UpdateContainer } from '@happier-dev/protocol/updates';
import { readSessionProjectedPendingRequestCount } from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';

/** Consume request-count pushes on the input observer's existing socket. */
export function createSessionInputAttentionObserver(params: Readonly<{
  token: string;
  sessionId: string;
  initialSession?: RawSessionRecord;
  signal?: AbortSignal;
  serverFeaturesSnapshot?: Parameters<typeof fetchSessionById>[0]['serverFeaturesSnapshot'];
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionById>[0]['resolveAuthorizationHeaders'];
  onAttentionRequired: (required: boolean) => Promise<void>;
}>) {
  let pendingRequests = {
    pendingPermissionRequestCount: params.initialSession?.pendingPermissionRequestCount,
    pendingUserActionRequestCount: params.initialSession?.pendingUserActionRequestCount,
  };
  let refresh = false;
  let published: boolean | undefined;
  return {
    onSessionUpdate(body: Extract<UpdateContainer['body'], { t: 'update-session' }>) {
      if (body.pendingPermissionRequestCount === undefined && body.pendingUserActionRequestCount === undefined) return;
      pendingRequests = {
        pendingPermissionRequestCount: body.pendingPermissionRequestCount ?? pendingRequests.pendingPermissionRequestCount,
        pendingUserActionRequestCount: body.pendingUserActionRequestCount ?? pendingRequests.pendingUserActionRequestCount,
      };
    },
    onConnected() { refresh = true; },
    async publish() {
      if (refresh) {
        refresh = false;
        const beforeRead = pendingRequests;
        try {
          const session = await fetchSessionById({ reason: 'session-control', token: params.token,
            sessionId: params.sessionId, serverFeaturesSnapshot: params.serverFeaturesSnapshot,
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}) });
          // A push received during the snapshot read owns the newer counts.
          if (session && pendingRequests === beforeRead) pendingRequests = {
            pendingPermissionRequestCount: session.pendingPermissionRequestCount,
            pendingUserActionRequestCount: session.pendingUserActionRequestCount,
          };
        } catch { refresh = true; }
      }
      const count = readSessionProjectedPendingRequestCount(pendingRequests);
      if (count !== null && (count > 0) !== published) {
        await params.onAttentionRequired(count > 0);
        published = count > 0;
      }
    },
  };
}
