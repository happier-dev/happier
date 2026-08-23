import {
  readIngressComposerAttachmentSelectionV1,
  type PendingRequestedActionV1,
} from '@happier-dev/protocol';

import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { enqueuePendingMessageV2 } from '@/sync/engine/pending/pendingQueueV2';
import {
  resolvePendingInputServerWireMode,
  shouldSchedulePendingOutboxTransportRetry,
  type PendingInputServerWireMode,
} from '@/sync/engine/pending/pendingInputServerWireContract';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { RawRecord } from '@/sync/typesRaw';
import { randomUUID } from '@/platform/randomUUID';

import { createSessionRequestForResolvedServerScope } from './createSessionRequestWithServerScope';
import { normalizeServerScopeId } from './localSessionRouteReadiness';
import { resolveScopedSessionDataKey } from './resolveScopedSessionDataKey';
import { resolveServerScopedSessionContext, type ResolvedServerSessionRpcContext } from './resolveServerScopedSessionContext';

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
    displayText: string | undefined,
    metaOverrides: Record<string, unknown> | undefined,
    options: Readonly<{ localId: string; requestedAction: PendingRequestedActionV1 }>,
  ) => Promise<Readonly<{ localId: string; accepted: boolean; cancelled?: true; terminal?: true }>>;
  schedulePendingOutboxRetry: (params: Readonly<{
    sessionId: string;
    localId: string;
    outboxScope: ServerAccountScope;
  }>) => void;
  markSessionLiveTailIntent: (sessionId: string) => void;
}>;

async function defaultGetScopedSessionEncryption(params: Readonly<{
  context: Awaited<ReturnType<typeof resolveServerScopedSessionContext>>;
  sessionId: string;
}>): Promise<ScopedSessionEncryptionLike> {
  if (params.context.scope !== 'scoped') throw new Error('Expected scoped context');
  const context = params.context as Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>;
  const encryption = context.encryption;
  if (!encryption) {
    throw new Error(`Session encryption is unavailable for ${params.sessionId}`);
  }
  const sessionDataKey = await resolveScopedSessionDataKey({
    serverId: context.targetServerId,
    serverUrl: context.targetServerUrl,
    token: context.token,
    sessionId: params.sessionId,
    timeoutMs: context.timeoutMs,
    decryptEncryptionKey: (value) => encryption.decryptEncryptionKey(value),
  });
  await encryption.initializeSessions(new Map([[params.sessionId, sessionDataKey]]));
  const sessionEncryption = encryption.getSessionEncryption(params.sessionId);
  if (!sessionEncryption) throw new Error(`Session encryption not found for ${params.sessionId}`);
  return sessionEncryption as unknown as ScopedSessionEncryptionLike;
}

function resolveServerScopedPendingRequestedAction(params: Readonly<{
  providerDeliveryIntent: 'immediate' | 'first_turn' | null | undefined;
  serverWireMode: PendingInputServerWireMode | null;
}>): PendingRequestedActionV1 {
  if (
    params.providerDeliveryIntent === 'first_turn'
    && params.serverWireMode !== null
    && params.serverWireMode !== 'pending_input_v1'
  ) {
    return { v: 1, kind: 'enqueue' };
  }
  return {
    v: 1,
    kind: params.providerDeliveryIntent === 'immediate' || params.providerDeliveryIntent === 'first_turn'
      ? 'send_now'
      : 'enqueue',
  };
}

/**
 * The Composer submits its raw pre-admission metadata: a media attachment still carries the
 * transfer-owned staged claim that the daemon's SessionMedia finalizer replaces during
 * admission. Reading it through the admitted-only projection dropped exactly those
 * attachments, so an image- or video-only turn looked blank and was never sent. The
 * canonical ingress-envelope owner answers the question this gate actually asks, and still
 * rejects a selection it cannot read rather than sending an empty turn.
 */
function hasSubmittableComposerAttachmentSelection(
  metaOverrides: Record<string, unknown> | null | undefined,
): boolean {
  return (readIngressComposerAttachmentSelectionV1(metaOverrides) ?? []).length > 0;
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
    messageLocalId?: string | null;
    providerDeliveryIntent?: 'immediate' | 'first_turn' | null;
    requestedAction?: PendingRequestedActionV1;
  }>) => Promise<ServerScopedSessionSendMessageResult>;
}> {
  const d: ServerScopedSessionSendMessageDeps = {
    getSession: deps?.getSession ?? ((sessionId) => storage.getState().sessions[sessionId] ?? null),
    resolveContext: deps?.resolveContext ?? resolveServerScopedSessionContext,
    getScopedSessionEncryption: deps?.getScopedSessionEncryption ?? defaultGetScopedSessionEncryption,
    enqueuePendingMessageActive: deps?.enqueuePendingMessageActive ?? (async (sessionId, message, displayText, metaOverrides, options) =>
      await getSyncSingleton().enqueuePendingMessage(sessionId, message, displayText, metaOverrides, options)),
    schedulePendingOutboxRetry: deps?.schedulePendingOutboxRetry ?? ((params) =>
      getSyncSingleton().schedulePendingOutboxOperationRetry(params)),
    markSessionLiveTailIntent: deps?.markSessionLiveTailIntent ?? ((sessionId) =>
      getSyncSingleton().markSessionLiveTailIntent(sessionId)),
  };

  return {
    async sendSessionMessageWithServerScope(args) {
      const sessionId = normalizeServerScopeId(args.sessionId);
      const message = String(args.message ?? '');
      const profileId = normalizeServerScopeId(args.profileId);
      const localId = normalizeServerScopeId(args.messageLocalId) || randomUUID();
      if (
        !sessionId
        || (!message.trim() && !hasSubmittableComposerAttachmentSelection(args.metaOverrides))
      ) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }

      const context = await d.resolveContext({
        serverId: args.serverId,
        timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000,
      });
      const session = d.getSession(sessionId);
      if (!session) return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      const displayText = typeof args.displayText === 'string' ? args.displayText : undefined;
      const metaOverrides = { ...(args.metaOverrides ?? {}), ...(profileId ? { profileId } : {}) };

      let requestedAction: PendingRequestedActionV1;
      let result: Readonly<{ localId: string; accepted: boolean; cancelled?: true; terminal?: true }>;
      let outboxScope: ServerAccountScope | null = null;
      if (context.scope === 'active') {
        const serverWireMode = args.providerDeliveryIntent === 'first_turn'
          ? resolvePendingInputServerWireMode(await getServerFeaturesSnapshot({
              serverId: normalizeServerScopeId(session.serverId) || undefined,
            }))
          : null;
        requestedAction = args.requestedAction ?? resolveServerScopedPendingRequestedAction({
          providerDeliveryIntent: args.providerDeliveryIntent,
          serverWireMode,
        });
        result = await d.enqueuePendingMessageActive(
          sessionId,
          message,
          displayText,
          Object.keys(metaOverrides).length > 0 ? metaOverrides : undefined,
          { localId, requestedAction },
        );
      } else {
        outboxScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
        if (!outboxScope) throw new Error('Scoped pending delivery requires a server-account scope');
        const serverWireMode = resolvePendingInputServerWireMode(
          await getServerFeaturesSnapshot({ serverId: outboxScope.serverId }),
        );
        requestedAction = args.requestedAction ?? resolveServerScopedPendingRequestedAction({
          providerDeliveryIntent: args.providerDeliveryIntent,
          serverWireMode,
        });
        d.markSessionLiveTailIntent(sessionId);
        result = await enqueuePendingMessageV2({
          sessionId,
          text: message,
          displayText,
          localId,
          requestedAction,
          metaOverrides: Object.keys(metaOverrides).length > 0 ? metaOverrides : undefined,
          encryption: {
            getSessionEncryption: async (candidateSessionId) => candidateSessionId === sessionId
              ? await d.getScopedSessionEncryption({ context, sessionId })
              : null,
          },
          outboxScope,
          serverWireMode,
          request: createSessionRequestForResolvedServerScope({
            context,
            activeRequest: async () => { throw new Error('Unexpected active request for scoped provider delivery'); },
          }),
        });
        if (
          !result.accepted
          && result.cancelled !== true
          && shouldSchedulePendingOutboxTransportRetry(serverWireMode)
        ) {
          d.schedulePendingOutboxRetry({ sessionId, localId: result.localId, outboxScope });
        }
      }

      if (result.cancelled === true) {
        return { ok: false, errorCode: 'PENDING_MESSAGE_CANCELLED', error: 'Pending message was cancelled before delivery' };
      }
      return {
        ok: true,
        ack: {
          ok: true,
          localId: result.localId,
          persistence: result.terminal === true ? 'terminal' : 'pending',
          accepted: result.accepted,
        },
      };
    },
  };
}

export const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage();
