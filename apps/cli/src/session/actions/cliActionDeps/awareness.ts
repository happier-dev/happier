import type { CliActionDepsParams } from './types';
import { SessionAwarenessProjectionV1Schema } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { projectSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { waitForSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/waitV1';
import type { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { projectSessionActivityCompatibilityV1, SESSION_LIST_AWARENESS_VIEW_V1 } from '@happier-dev/protocol/sessions/awareness/action';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { buildCliSessionAwarenessInputV1 } from '@/cli/output/session/sessionAwareness';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import type { fetchSessionByIdCompat, fetchSessionTurnsProjection } from '@/session/transport/http/sessionsHttp';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
export function createCliAwarenessActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'serverId' | 'token'>,
  { resolveServerRequestHeaders, readServerFeaturesSnapshot, isSameActionHomeId }: Readonly<{
    isSameActionHomeId: (serverId: string) => boolean;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
  }>,
): Pick<ActionExecutorDeps, 'sessionAwarenessWait' | 'sessionActivityGet'> & Required<Pick<ActionExecutorDeps, 'sessionActivityGet'>> {
  return {

    sessionAwarenessWait: async ({ context, input, options, readAwareness }) => {
      if (input.target.kind !== 'session') return { disposition: 'unsupported_condition' };
      if (!params.credentials) return { disposition: 'permission_denied' };
      if (!params.serverId || !isSameActionHomeId(input.target.serverId)) return { disposition: 'permission_denied' };
      const sessionId = input.target.sessionId;
      const { openSessionEventSource } = await import("@/session/transport/socket/sessionSocketAgentState");
      return waitForSessionAwarenessV1({
        condition: input.condition, deadlineMs: options.deadlineMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
        read: async () => {
          const raw = await readAwareness();
          const parsed = SessionAwarenessProjectionV1Schema.safeParse(raw);
          if (!parsed.success) {
            if (raw && typeof raw === 'object' && 'ok' in raw && raw.ok === false) throw raw;
            throw new Error('session_awareness_wait_result_invalid');
          }
          if (input.condition.kind !== 'turn_terminal') return { awareness: parsed.data };
          const { fetchSessionTurnsProjection } = await import("@/session/transport/http/sessionsHttp");
          const turns = await fetchSessionTurnsProjection({ token: params.token, sessionId,
            ...(options.signal ? { signal: options.signal } : {}),
            resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.activity.get', request),
          });
          if (!turns) return null;
          const turn = turns.turns.find((entry) => input.condition.kind === 'turn_terminal' && entry.turnId === input.condition.turnId);
          return { awareness: parsed.data, ...(turn ? { turn } : {}) };
        },
        open: () => openSessionEventSource({ token: params.token, sessionId, scope: 'user' }),
      });
    },

    sessionActivityGet: async ({ context, sessionId, view, windowSeconds, signal }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (windowSeconds !== undefined) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          error: 'unsupported_action:session.activity.get.windowSeconds',
        };
      }
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET'; path: string;
      }>) => resolveServerRequestHeaders(context, 'session.activity.get', request);
      const currentnessAuthorizationHeaders = resolveAuthorizationHeaders({
        method: 'GET', path: '/v1/account/encryption/currentness',
      });
      if (!currentnessAuthorizationHeaders) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      signal?.throwIfAborted();
      const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
      signal?.throwIfAborted();
      const [{ fetchSessionByIdCompat }, { fetchAccountEncryptionCurrentness }, { buildCliSessionAwarenessInputV1 }] = await Promise.all([import("@/session/transport/http/sessionsHttp"), import("@/api/client/connectedServiceCredentialApi"), import("@/cli/output/session/sessionAwareness")]);
      const session = await fetchSessionByIdCompat({
        reason: 'session-action',
        token: params.credentials.token,
        sessionId,
        resolveAuthorizationHeaders,
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        signal,
      });
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found', sessionId };
      }
      const currentness = await fetchAccountEncryptionCurrentness({
        token: params.credentials.token,
        authorizationHeaders: currentnessAuthorizationHeaders,
        signal,
      });
      signal?.throwIfAborted();
      const awarenessInput = buildCliSessionAwarenessInputV1({
        credentials: params.credentials,
        accountEncryption: currentness,
        row: session,
        nowMs: Date.now(),
      });
      const awareness = projectSessionAwarenessV1(awarenessInput);
      // The requested representation, from the one projector this Action already derives its
      // released booleans from. Omission keeps the compatibility digest below.
      if (view === SESSION_LIST_AWARENESS_VIEW_V1) return awareness;
      return {
        ...projectSessionActivityCompatibilityV1({
          awareness,
          facts: {
            presence: awarenessInput.runtime.presence === 'unknown' ? null : awarenessInput.runtime.presence,
            active: session.active,
            thinking: session.thinking === true,
            updatedAt: session.updatedAt,
            // No `permissionRequestIds`: this path reads a V2 row, which carries pending counts
            // but no request identities. The released CLI/daemon response never had the field.
          },
        }),
        // cli-v0.2.11 and the current 0.2 daemon expose these ancillary raw counts.
        // Keep that response seam while status meaning comes only from awareness.
        pendingCount: session.pendingCount ?? 0,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? 0,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? 0,
      };
    },
  };
}
