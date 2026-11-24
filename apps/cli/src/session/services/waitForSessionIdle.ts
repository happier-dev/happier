import type { StoredCredentials } from '@/persistence';
import { waitForSessionIdle as waitForObservedSessionIdle } from '@happier-dev/session-core/transcript';
import { detectLatestSessionTurnActivity } from '@/session/query/detectLatestSessionTurnActivity';
import { detectSessionTurnActivity } from '@/session/query/detectSessionTurnInFlight';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export async function waitForSessionIdle(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  timeoutMs: number;
  signal?: AbortSignal;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  resolveAuthorizationHeaders?: Parameters<typeof resolveSessionTransportContext>[0]['resolveAuthorizationHeaders'];
}>) {
  return await waitForObservedSessionIdle({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    readTarget: async ({ signal, remainingTimeoutMs }) => {
      const session = await resolveSessionTransportContext({
        reason: 'session-control', credentials: params.credentials, idOrPrefix: params.idOrPrefix, signal,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
      });
      if (!session.ok) return session;
      const connection = { token: params.credentials.token, sessionId: session.sessionId,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}) };
      const value = session.rawSession.agentState;
      const activityParams = {
        ...connection, signal, encryptionMode: session.mode,
        encryptionKey: session.ctx?.encryptionKey ?? null, encryptionVariant: session.ctx?.encryptionVariant ?? null,
      };
      return {
        ok: true, sessionId: session.sessionId, projection: session.rawSession,
        readInitialTurnActivity: () => detectSessionTurnActivity({
          ...activityParams, transcriptFetchTimeoutMs: remainingTimeoutMs(),
        }),
        readTurnActivity: () => detectLatestSessionTurnActivity({
          ...activityParams, transcriptFetchTimeoutMs: remainingTimeoutMs(),
        }),
        waitForObservation: options => waitForIdleViaSocket({
          ...connection, ...options, ctx: session.ctx, sessionEncryptionMode: session.mode,
          initialAgentStateCiphertextBase64: typeof value === 'string' ? value.trim() || null : null,
        }),
      };
    },
  });
}
