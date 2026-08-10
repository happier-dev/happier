import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { RawRecord } from '@/sync/typesRaw';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { resolveScopedPendingSessionEncryption } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedPendingSessionEncryption';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { enqueuePendingMessageV2 } from '@/sync/engine/pending/pendingQueueV2';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';
import { selectSessionPendingRequestedAction } from '@/sync/domains/session/control/submitMode';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
  resolvePendingInputServerWireMode,
  type PendingInputServerWireMode,
} from '@/sync/engine/pending/pendingInputServerWireContract';

import { createSessionRequestForResolvedServerScope } from './createSessionRequestWithServerScope';

type ScopedSessionEncryptionLike = Readonly<{
  encryptRawRecord: (record: RawRecord) => Promise<string>;
}>;

export type ServerScopedSessionSendMessageResult =
  | Readonly<{ ok: true; ack?: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

export type ServerScopedSessionSendMessageDeps = Readonly<{
  getSession: (sessionId: string) => Session | null;
  resolveContext: typeof resolveServerScopedSessionContext;
  getScopedSessionEncryption: (params: Readonly<{
    context: Awaited<ReturnType<typeof resolveServerScopedSessionContext>>;
    sessionId: string;
  }>) => Promise<ScopedSessionEncryptionLike>;
  enqueuePendingMessageActive: (
    sessionId: string,
    message: string,
    displayText?: string,
    metaOverrides?: Record<string, unknown>,
    options?: Readonly<{
      localId?: string | null;
      requestedAction: import('@happier-dev/protocol').PendingRequestedActionV1;
    }>,
  ) => Promise<Readonly<{
    localId: string;
    accepted: boolean;
    cancelled?: true;
  }>>;
  schedulePendingOutboxRetry: (params: Readonly<{
    sessionId: string;
    localId: string;
    outboxScope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope;
  }>) => void;
  markSessionLiveTailIntent: (sessionId: string) => void;
}>;

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function resolveWireRequestedAction(params: Readonly<{
  requestedAction: import('@happier-dev/protocol').PendingRequestedActionV1;
  providerDeliveryIntent?: 'immediate' | 'first_turn' | null;
  wireMode: PendingInputServerWireMode;
}>): import('@happier-dev/protocol').PendingRequestedActionV1 {
  return params.providerDeliveryIntent === 'first_turn'
    && params.wireMode !== 'pending_input_v1'
    ? { v: 1, kind: 'enqueue' }
    : params.requestedAction;
}

async function defaultGetScopedSessionEncryption(params: Readonly<{
  context: Awaited<ReturnType<typeof resolveServerScopedSessionContext>>;
  sessionId: string;
}>): Promise<ScopedSessionEncryptionLike> {
  if (params.context.scope !== 'scoped') {
    throw new Error('Expected scoped context');
  }
  return await resolveScopedPendingSessionEncryption({
    context: params.context,
    sessionId: params.sessionId,
  });
}

export function createServerScopedSessionSendMessage(deps?: Partial<ServerScopedSessionSendMessageDeps>): Readonly<{
  sendSessionMessageWithServerScope: (args: Readonly<{
    sessionId: string;
    message: string;
    serverId?: string | null;
    timeoutMs?: number;
    displayText?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    profileId?: string | null;
    localId?: string | null;
    requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
    providerDeliveryIntent?: 'immediate' | 'first_turn' | null;
  }>) => Promise<ServerScopedSessionSendMessageResult>;
}> {
  const d: ServerScopedSessionSendMessageDeps = {
    getSession: deps?.getSession ?? ((sessionId) => storage.getState().sessions[sessionId] ?? null),
    resolveContext: deps?.resolveContext ?? resolveServerScopedSessionContext,
    getScopedSessionEncryption: deps?.getScopedSessionEncryption ?? defaultGetScopedSessionEncryption,
    enqueuePendingMessageActive:
      deps?.enqueuePendingMessageActive ??
      (async (sessionId, message, displayText, metaOverrides, options) =>
        await getSyncSingleton().enqueuePendingMessage(
          sessionId,
          message,
          displayText,
          metaOverrides,
          { localId: options?.localId, requestedAction: options?.requestedAction ?? { v: 1, kind: 'enqueue' } },
        )),
    schedulePendingOutboxRetry:
      deps?.schedulePendingOutboxRetry ?? ((params) => getSyncSingleton().schedulePendingOutboxOperationRetry(params)),
    markSessionLiveTailIntent:
      deps?.markSessionLiveTailIntent ?? ((sessionId) => getSyncSingleton().markSessionLiveTailIntent(sessionId)),
  };

  const sendSessionMessageWithServerScope = async (args: Readonly<{
    sessionId: string;
    message: string;
    serverId?: string | null;
    timeoutMs?: number;
    displayText?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    profileId?: string | null;
    localId?: string | null;
    requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
    providerDeliveryIntent?: 'immediate' | 'first_turn' | null;
  }>): Promise<ServerScopedSessionSendMessageResult> => {
    const sessionId = normalizeId(args.sessionId);
    const message = String(args.message ?? '');
    const profileId = normalizeId(args.profileId);
    const requestedLocalId = normalizeId(args.localId);
    const displayText = typeof args.displayText === 'string' ? args.displayText : undefined;
    const metaOverrides = {
      ...(args.metaOverrides ?? {}),
      ...(profileId ? { profileId } : {}),
    };
    if (!sessionId || !message.trim()) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }

    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
    const context = await d.resolveContext({ serverId: args.serverId, timeoutMs });
    const session = d.getSession(sessionId);
    const requestedAction = args.requestedAction ?? selectSessionPendingRequestedAction({
        session,
        firstTurn: args.providerDeliveryIntent === 'first_turn',
        timingOverride: args.providerDeliveryIntent === 'immediate' ? 'send_now' : undefined,
      });

    const completeProviderRequiredDelivery = async (result: Readonly<{
      localId: string;
      accepted: boolean;
      cancelled?: true;
      terminal?: true;
    }>): Promise<ServerScopedSessionSendMessageResult> => {
      if (result.cancelled === true) {
        return {
          ok: false,
          errorCode: 'PENDING_MESSAGE_CANCELLED',
          error: 'Pending message was cancelled before dispatch',
        };
      }
      if (!result.accepted) {
        return {
          ok: true,
          ack: { ok: true, localId: result.localId, persistence: 'pending', accepted: false },
        };
      }
      if (result.terminal === true) {
        return {
          ok: true,
          ack: { ok: true, localId: result.localId, persistence: 'terminal', accepted: true },
        };
      }
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      return {
        ok: true,
        ack: { ok: true, localId: result.localId, persistence: 'pending', accepted: false },
      };
    };

    if (context.scope === 'active') {
      const activeLocalId = requestedLocalId || randomUUID();
      const activeRequestedAction = args.providerDeliveryIntent === 'first_turn'
        ? resolveWireRequestedAction({
          requestedAction,
          providerDeliveryIntent: args.providerDeliveryIntent,
          wireMode: resolvePendingInputServerWireMode(await getServerFeaturesSnapshot()),
        })
        : requestedAction;
      const result = await d.enqueuePendingMessageActive(
        sessionId,
        message,
        displayText,
        Object.keys(metaOverrides).length > 0 ? metaOverrides : undefined,
        {
          localId: activeLocalId,
          requestedAction: activeRequestedAction,
        },
      );
      return await completeProviderRequiredDelivery(result);
    }

    if (!session) {
      return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
    }
    const outboxScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
    if (!outboxScope) throw new Error('Scoped pending delivery requires a server-account scope');
    const scopedLocalId = requestedLocalId || randomUUID();
    const wireMode = resolvePendingInputServerWireMode(await getServerFeaturesSnapshot({
      serverId: context.targetServerId,
    }));
    const wireRequestedAction = resolveWireRequestedAction({
      requestedAction,
      providerDeliveryIntent: args.providerDeliveryIntent,
      wireMode,
    });
    d.markSessionLiveTailIntent(sessionId);
    const result = await enqueuePendingMessageV2({
      sessionId,
      text: message,
      displayText,
      localId: scopedLocalId,
      metaOverrides: Object.keys(metaOverrides).length > 0 ? metaOverrides : undefined,
      encryption: {
        getSessionEncryption: async (candidateSessionId: string) => candidateSessionId === sessionId
          ? await d.getScopedSessionEncryption({ context, sessionId })
          : null,
      },
      outboxScope,
      requestedAction: wireRequestedAction,
      wireMode,
      onWireContractMismatch: async () => {
        await getServerFeaturesSnapshot({
          serverId: context.targetServerId,
          force: true,
        });
      },
      request: createSessionRequestForResolvedServerScope({
        context,
        activeRequest: async () => {
          throw new Error('Unexpected active request for scoped provider delivery');
        },
      }),
    });
    if (result.accepted === false && !result.terminal && !result.waitingForWireMode) {
      d.schedulePendingOutboxRetry({ sessionId, localId: result.localId, outboxScope });
    }
    return await completeProviderRequiredDelivery(result);
  };

  return { sendSessionMessageWithServerScope };
}

export const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage();
