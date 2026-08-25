import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import {
  bindVoiceRuntimeAttemptBinding,
  createVoiceRuntimeAttemptBindingOwner,
  voiceSessionBindingStore,
} from '@/voice/binding/voiceConversationBindingStore';

const rpcCalls = vi.hoisted(() => [] as Array<Readonly<{
  sessionId: string;
  method: string;
  serverId: unknown;
}>>);

vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc',
  async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
      ...original,
      sessionRpcWithServerScope: vi.fn(async (params: Readonly<{
        sessionId: string;
        method: string;
        serverId?: unknown;
      }>) => {
        rpcCalls.push({
          sessionId: params.sessionId,
          method: params.method,
          serverId: params.serverId,
        });
        switch (params.method) {
          case 'session.agentRealtime.inspect':
            return { ok: true, status: 'available', transport: 'webrtc' };
          case 'session.agentRealtime.start':
            return {
              ok: true,
              status: 'started',
              transport: { kind: 'webrtc', answerSdp: 'v=0' },
            };
          case 'session.agentRealtime.stop':
            return { ok: true, status: 'stopped' };
          case 'session.agentRealtime.watch':
            // The daemon holds WATCH open until the attempt goes terminal.
            return await new Promise(() => {});
          default:
            throw new Error(`unexpected rpc ${params.method}`);
        }
      }),
    };
  },
);

const PROVIDER = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'realtime-codex' });
const AGENT = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' });
const ADAPTER_ID = 'happier.agent.codex/realtime-codex';
const SESSION_ID = 'agent-realtime-server-authority-session';

function agentSessionOn(serverId: string): Session {
  return createSessionFixture({
    id: SESSION_ID,
    active: true,
    serverId,
    metadataLayoutVersion: 1,
    metadata: {
      path: '/Users/tester/project',
      host: 'tester.local',
      agentType: 'codex',
    } as Session['metadata'],
    ownerMetadataView: {
      path: '/Users/tester/project',
      host: 'tester.local',
      agentType: 'codex',
    } as Session['metadata'],
  });
}

function installSessionOn(serverId: string): void {
  storage.setState((current) => ({
    ...current,
    sessions: { [SESSION_ID]: agentSessionOn(serverId) },
  }) as never);
}

describe('Agent-realtime voice RPCs keep the server they were bound to', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    voiceSessionBindingStore.setState((current) => ({
      ...current,
      runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {},
    }) as never);
    storage.setState((current) => ({ ...current, sessions: {} }) as never);
  });

  it('inspects the session on its own server rather than whichever server is active', async () => {
    installSessionOn('server-a');
    const { createBundledConversationRuntimeHostLease } = await import('./bundledConversationRuntimeHost');
    const lease = createBundledConversationRuntimeHostLease();
    try {
      await lease.host.resolveAgentRealtimeVoiceConversationBinding!({
        provider: PROVIDER,
        agent: AGENT,
        controlSessionId: SESSION_ID,
        requestedTargetSessionId: null,
        settings: {},
      });
    } finally {
      lease.revoke();
    }

    expect(rpcCalls).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        method: 'session.agentRealtime.inspect',
        serverId: 'server-a',
      }),
    ]);
  });

  it('keeps start, watch and cleanup stop on the server captured when the attempt bound', async () => {
    installSessionOn('server-a');
    bindVoiceRuntimeAttemptBinding({
      owner: createVoiceRuntimeAttemptBindingOwner(),
      binding: {
        adapterId: ADAPTER_ID,
        controlSessionId: SESSION_ID,
        conversationSessionId: SESSION_ID,
        lifetime: 'runtime_attempt',
        transcriptMode: 'native_session',
        targetSessionId: null,
        updatedAt: 1,
      },
    });

    const { createBundledConversationRuntimeHostLease } = await import('./bundledConversationRuntimeHost');
    const lease = createBundledConversationRuntimeHostLease();
    const attempt = new AbortController();
    try {
      const service = await lease.host.createAgentSessionRealtimeService!({
        provider: PROVIDER,
        agent: AGENT,
        adapterId: ADAPTER_ID,
        controlSessionId: SESSION_ID,
        applicationAttemptId: 'attempt-1',
        signal: attempt.signal,
        onStarted: () => {},
      });
      if (!service) throw new Error('agent realtime service was not created');

      // The user switches to Account B on another server: this session's local
      // record is replaced by the new Account's projection.
      installSessionOn('server-b');

      const started = await service.start({
        transport: { kind: 'webrtc', offerSdp: 'v=0' },
      });
      if (started.status !== 'started') {
        throw new Error(`agent realtime start did not start: ${started.status}`);
      }
      await started.handle.stop();
    } finally {
      attempt.abort();
      lease.revoke();
    }

    expect(rpcCalls.length).toBeGreaterThan(0);
    expect(rpcCalls.map((call) => call.method).sort()).toEqual([
      'session.agentRealtime.start',
      'session.agentRealtime.stop',
      'session.agentRealtime.watch',
    ]);
    for (const call of rpcCalls) {
      expect({ method: call.method, serverId: call.serverId })
        .toEqual({ method: call.method, serverId: 'server-a' });
    }
  });
});
