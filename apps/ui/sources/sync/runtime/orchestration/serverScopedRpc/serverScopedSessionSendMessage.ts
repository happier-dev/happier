import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import { storage } from '@/sync/domains/state/storage';
import { resolveSentFrom } from '@/sync/domains/messages/sentFrom';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';
import { buildSessionAppendSystemPrompt } from '@/agents/prompt/buildSessionAppendSystemPrompt';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { RawRecord } from '@/sync/typesRaw';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveScopedSessionDataKey } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { randomUUID } from '@/platform/randomUUID';

import type { ResolvedServerSessionRpcContext } from './resolveServerScopedSessionContext';

type ScopedSocketClientLike = Readonly<{
  timeout: (ms: number) => { emitWithAck: (event: string, payload: any) => Promise<unknown> };
  disconnect: () => void;
}>;

type ScopedSessionEncryptionLike = Readonly<{
  encryptRawRecord: (record: RawRecord) => Promise<string>;
}>;

export type ServerScopedSessionSendMessageResult =
  | Readonly<{ ok: true; ack?: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type Deps = Readonly<{
  resolveContext: typeof resolveServerScopedSessionContext;
  resolveSessionDataKey: typeof resolveScopedSessionDataKey;
  createSocket: (params: Readonly<{ serverUrl: string; token: string; timeoutMs: number }>) => Promise<ScopedSocketClientLike>;
  getScopedSessionEncryption: (params: Readonly<{
    context: Awaited<ReturnType<typeof resolveServerScopedSessionContext>>;
    sessionId: string;
  }>) => Promise<ScopedSessionEncryptionLike>;
  sendMessageActive: (sessionId: string, message: string) => Promise<void>;
}>;

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

async function defaultGetScopedSessionEncryption(params: Readonly<{
  context: Awaited<ReturnType<typeof resolveServerScopedSessionContext>>;
  sessionId: string;
}>): Promise<ScopedSessionEncryptionLike> {
  if (params.context.scope !== 'scoped') {
    throw new Error('Expected scoped context');
  }

  const context = params.context as Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>;
  const sessionDataKey = await resolveScopedSessionDataKey({
    serverId: context.targetServerId,
    serverUrl: context.targetServerUrl,
    token: context.token,
    sessionId: params.sessionId,
    timeoutMs: context.timeoutMs,
    decryptEncryptionKey: (value) => context.encryption.decryptEncryptionKey(value),
  });

  await context.encryption.initializeSessions(new Map([[params.sessionId, sessionDataKey]]));
  const sessionEncryption = context.encryption.getSessionEncryption(params.sessionId);
  if (!sessionEncryption) {
    throw new Error(`Session encryption not found for ${params.sessionId}`);
  }
  return sessionEncryption as unknown as ScopedSessionEncryptionLike;
}

export function createServerScopedSessionSendMessage(deps?: Partial<Deps>): Readonly<{
  sendSessionMessageWithServerScope: (args: Readonly<{
    sessionId: string;
    message: string;
    serverId?: string | null;
    timeoutMs?: number;
  }>) => Promise<ServerScopedSessionSendMessageResult>;
}> {
  const d: Deps = {
    resolveContext: deps?.resolveContext ?? resolveServerScopedSessionContext,
    resolveSessionDataKey: deps?.resolveSessionDataKey ?? resolveScopedSessionDataKey,
    createSocket: deps?.createSocket ?? (async (params) => await createEphemeralServerSocketClient(params)),
    getScopedSessionEncryption: deps?.getScopedSessionEncryption ?? defaultGetScopedSessionEncryption,
    sendMessageActive:
      deps?.sendMessageActive ??
      (async (sessionId, message) => {
        const { sync } = await import('@/sync/sync');
        await sync.sendMessage(sessionId, message);
      }),
  };

  const sendSessionMessageWithServerScope = async (args: Readonly<{
    sessionId: string;
    message: string;
    serverId?: string | null;
    timeoutMs?: number;
  }>): Promise<ServerScopedSessionSendMessageResult> => {
    const sessionId = normalizeId(args.sessionId);
    const message = String(args.message ?? '');
    if (!sessionId || !message.trim()) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }

    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
    const context = await d.resolveContext({ serverId: args.serverId, timeoutMs });

    if (context.scope === 'active') {
      await d.sendMessageActive(sessionId, message);
      return { ok: true, ack: { ok: true } };
    }

    // Scoped path: build + encrypt record, then emit `message` over an ephemeral scoped socket.
    const state: any = storage.getState();
    const session: any = state?.sessions?.[sessionId] ?? null;
    if (!session) {
      return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
    }

    const permissionMode = (session.permissionMode || 'default') as string;
    const flavor = session.metadata?.flavor;
    const agentId = resolveAgentIdFromFlavor(flavor);
    const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
    const model =
      agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;

    const sentFrom = resolveSentFrom();
    const appendSystemPrompt = buildSessionAppendSystemPrompt({ settings: state?.settings });

    const meta = buildSendMessageMeta({
      sentFrom,
      permissionMode: permissionMode || 'default',
      model,
      appendSystemPrompt,
      displayText: undefined,
      agentId: agentId ?? null,
      settings: state?.settings ?? {},
      session,
      metaOverrides: undefined,
    });

    const record: RawRecord = {
      role: 'user',
      content: { type: 'text', text: message },
      meta,
    };

    const sessionEncryption = await d.getScopedSessionEncryption({ context, sessionId });
    const encryptedRawRecord = await sessionEncryption.encryptRawRecord(record);
    const localId = randomUUID();

    const payload = {
      sid: sessionId,
      message: encryptedRawRecord,
      localId,
      sentFrom,
      permissionMode: permissionMode || 'default',
    };

    const socket = await d.createSocket({ serverUrl: context.targetServerUrl, token: context.token, timeoutMs: context.timeoutMs });
    try {
      const rawAck = await socket.timeout(context.timeoutMs).emitWithAck('message', payload);
      const parsed = MessageAckResponseSchema.safeParse(rawAck);
      if (!parsed.success) {
        return { ok: false, errorCode: 'send_failed', error: 'send_failed' };
      }
      if (parsed.data.ok !== true) {
        return { ok: false, errorCode: 'send_failed', error: parsed.data.error ?? 'send_failed' };
      }
      return { ok: true, ack: parsed.data };
    } catch (e: any) {
      return { ok: false, errorCode: 'send_failed', error: e instanceof Error ? e.message : 'send_failed' };
    } finally {
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
    }
  };

  return { sendSessionMessageWithServerScope };
}

export const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage();
