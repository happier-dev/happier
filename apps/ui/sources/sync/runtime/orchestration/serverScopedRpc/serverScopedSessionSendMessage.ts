import { readIngressComposerAttachmentSelectionV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionInputAdmissionRejectionCodeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { SessionMessageHostAdmissionOrigin } from '@/sync/domains/session/input/types';
import { loadSessionModelModes, loadSessionModelModeUpdatedAts, loadSessionPermissionModes, loadSessionPermissionModeUpdatedAts } from '@/sync/domains/state/sessionPersistence';
import { resolveSessionInputModes } from '@/sync/store/domains/resolveSessionInputModes';
import { nowServerMs } from '@/sync/runtime/time';
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
import type { RawRecord } from "@happier-dev/session-core/raw";
import { randomUUID } from '@/platform/randomUUID';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';

import { createServerRequestForResolvedServerScope } from './createServerRequestWithServerScope';
import { normalizeServerScopeId } from './localSessionRouteReadiness';
import { resolveScopedSessionEncryption } from './resolveScopedSessionDataKey';
import { resolveServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { fetchSessionByIdWithServerScope } from './fetchSessionByIdWithServerScope';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';

type ScopedSessionEncryptionLike = Readonly<{
  encryptRawRecord: (record: RawRecord) => Promise<string>;
}>;

export type ServerScopedSessionSendMessageResult =
  | Readonly<{ ok: true; ack?: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

export type ServerScopedSessionSendMessageDeps = Readonly<{
  getSession: (sessionId: string) => Session | null;
  resolveContext: typeof resolveServerAccountRequestContext;
  getScopedSessionEncryption: (params: Readonly<{
    context: Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
    sessionId: string;
  }>) => Promise<ScopedSessionEncryptionLike>;
  enqueuePendingMessageActive: (
    sessionId: string,
    message: string,
    displayText: string | undefined,
    metaOverrides: Record<string, unknown> | undefined,
    options: Readonly<{ localId: string; requestedAction: PendingRequestedActionV1; recipient?: ParticipantRecipientV1; hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin }>,
  ) => Promise<Readonly<{ localId: string; accepted: boolean; cancelled?: true; terminal?: true }>>;
  schedulePendingOutboxRetry: (params: Readonly<{
    sessionId: string;
    localId: string;
    outboxScope: ServerAccountScope;
  }>) => void;
  markSessionLiveTailIntent: (sessionId: string) => void;
}>;

async function defaultGetScopedSessionEncryption(params: Readonly<{
  context: Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
  sessionId: string;
}>): Promise<ScopedSessionEncryptionLike> {
  if (params.context.scope !== 'scoped') throw new Error('Expected scoped context');
  return await resolveScopedSessionEncryption({ context: params.context, sessionId: params.sessionId });
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
    recipient?: ParticipantRecipientV1;
    hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
    signal?: AbortSignal;
  }>) => Promise<ServerScopedSessionSendMessageResult>;
}> {
  const d: ServerScopedSessionSendMessageDeps = {
    getSession: deps?.getSession ?? ((sessionId) => storage.getState().sessions[sessionId] ?? null),
    resolveContext: deps?.resolveContext ?? resolveServerAccountRequestContext,
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
      if (args.signal?.aborted) {
        return { ok: false, errorCode: 'tool_cancelled', error: 'tool_cancelled' };
      }

      const context = await d.resolveContext({
        serverId: args.serverId,
        timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
      });
      try {
      if (args.signal?.aborted) {
        return { ok: false, errorCode: 'tool_cancelled', error: 'tool_cancelled' };
      }
      const displayText = typeof args.displayText === 'string' ? args.displayText : undefined;
      const metaOverrides = { ...(args.metaOverrides ?? {}), ...(profileId ? { profileId } : {}) };

      let requestedAction: PendingRequestedActionV1;
      let result: Readonly<{ localId: string; accepted: boolean; cancelled?: true; terminal?: true }>;
      let outboxScope: ServerAccountScope | null = null;
      if (context.scope === 'active') {
        const session = d.getSession(sessionId);
        if (!session) return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
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
          {
            localId,
            requestedAction,
            ...(args.recipient ? { recipient: args.recipient } : {}),
            ...(args.hostAdmissionOrigin ? { hostAdmissionOrigin: args.hostAdmissionOrigin } : {}),
          },
        );
      } else {
        outboxScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
        if (!outboxScope) throw new Error('Scoped pending delivery requires a server-account scope');
        if (!context.credentials) throw new Error('Scoped pending delivery requires target Account credentials');
        const request = createServerRequestForResolvedServerScope({
          context,
          activeRequest: async () => { throw new Error('Unexpected active request for scoped provider delivery'); },
        });
        const acquired: Session[] = [];
        const fetched = await fetchSessionByIdWithServerScope({
          sessionId,
          serverId: context.targetServerId,
          activeCredentials: context.credentials,
          sessionDataKeys: new Map(),
          sessionDataKeyEnvelopes: new Map(),
          activeRequest: request,
          authority: { scope: outboxScope, context, request, release: async () => {} },
          applySessions: (sessions) => {
            for (const session of sessions) acquired.push(session);
          },
          log: { log: () => {} },
          timeoutMs: context.timeoutMs,
        });
        const acquiredSession = acquired.find((session) => session.id === sessionId && session.serverId === context.targetServerId);
        if (!fetched.ok) {
          const errorCode = fetched.errorCode ?? 'session_fetch_failed';
          return { ok: false, errorCode, error: errorCode };
        }
        if (!acquiredSession) return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
        // Fetching exact-Home Session facts is read-only and can complete after
        // the invoking Voice/Action was cancelled. Stop before creating local
        // outbox custody or issuing the Pending mutation; cancellation must not
        // become a delayed send merely because discovery already started.
        if (args.signal?.aborted) {
          return { ok: false, errorCode: 'tool_cancelled', error: 'tool_cancelled' };
        }
        const session: Session = {
          ...acquiredSession,
          ...resolveSessionInputModes({
            session: acquiredSession,
            saved: {
              permissionMode: loadSessionPermissionModes(outboxScope)[sessionId],
              permissionModeUpdatedAt: loadSessionPermissionModeUpdatedAts(outboxScope)[sessionId],
              modelMode: loadSessionModelModes(outboxScope)[sessionId],
              modelModeUpdatedAt: loadSessionModelModeUpdatedAts(outboxScope)[sessionId],
            },
            nowMs: nowServerMs(),
          }),
        };
        const serverWireMode = resolvePendingInputServerWireMode(
          await getServerFeaturesSnapshot({ serverId: outboxScope.serverId }),
        );
        requestedAction = args.requestedAction ?? resolveServerScopedPendingRequestedAction({
          providerDeliveryIntent: args.providerDeliveryIntent,
          serverWireMode,
        });
        if (areServerAccountScopesEqual(getActiveServerAccountScope(), outboxScope)) d.markSessionLiveTailIntent(sessionId);
        result = await enqueuePendingMessageV2({
          sessionId,
          session,
          ...(args.recipient ? {
            recipient: args.recipient,
            targetMachineId: readMachineControlTargetForSession({ sessionId, ...outboxScope })?.machineId
              ?? resolveSessionMachineId(readSessionOwnerMetadataView(session))
              ?? undefined,
          } : {}),
          text: message,
          displayText,
          localId,
          requestedAction,
          hostAdmissionOrigin: args.hostAdmissionOrigin,
          metaOverrides: Object.keys(metaOverrides).length > 0 ? metaOverrides : undefined,
          encryption: {
            getSessionEncryption: async (candidateSessionId) => candidateSessionId === sessionId
              ? await d.getScopedSessionEncryption({ context, sessionId })
              : null,
          },
          outboxScope,
          serverWireMode,
          request,
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
      } catch (error) {
        const rejection = SessionInputAdmissionRejectionCodeV1Schema.safeParse(
          error && typeof error === 'object' && 'code' in error
            ? (error as Readonly<{ code?: unknown }>).code
            : undefined,
        );
        if (rejection.success) {
          return { ok: false, errorCode: rejection.data, error: rejection.data };
        }
        throw error;
      } finally {
        if (context.scope === 'scoped') await context.release?.();
      }
    },
  };
}

export const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage();
