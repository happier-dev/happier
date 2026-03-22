import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (transcript streaming vNext)', () => {
  it('streams transcript drafts with a stable segment localId reused by durable checkpoints', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const draftCalls: Array<{ localId: string; deltaText: string }> = [];
    const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendTranscriptDraftDelta: (_provider, params) => {
        draftCalls.push({ localId: params.localId, deltaText: params.deltaText });
      },
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
      },
    });

    vi.useFakeTimers();

    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();

      backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
      await vi.advanceTimersByTimeAsync(60);

      backend.emit({ type: 'model-output', textDelta: ' world' } satisfies AgentMessage);
      await vi.advanceTimersByTimeAsync(60);

      expect(draftCalls).toEqual([
        expect.objectContaining({ deltaText: 'Hello' }),
        expect.objectContaining({ deltaText: ' world' }),
      ]);
      expect(typeof draftCalls[0]?.localId).toBe('string');
      expect(draftCalls[0]?.localId).toBe(draftCalls[1]?.localId);

      await runtime.flushTurn();

      expect(durableCalls.length).toBeGreaterThanOrEqual(2);
      expect(durableCalls[0]!.localId).toBe(draftCalls[0]!.localId);
      expect(durableCalls[durableCalls.length - 1]!.localId).toBe(draftCalls[0]!.localId);

      const last = durableCalls[durableCalls.length - 1]!;
      expect(last.body).toMatchObject({ type: 'message', message: 'Hello world' });
      expect(last.meta).toMatchObject({
        happierStreamSegmentV1: expect.objectContaining({
          segmentLocalId: draftCalls[0]!.localId,
          segmentState: 'complete',
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('can disable draft buffering to emit each draft delta immediately', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const draftCalls: Array<{ deltaText: string }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendTranscriptDraftDelta: (_provider, params) => {
        draftCalls.push({ deltaText: params.deltaText });
      },
    });

    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      modelOutputStreaming: { deltaFlushIntervalMs: 0 },
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: ' world' } satisfies AgentMessage);

    expect(draftCalls).toEqual([{ deltaText: 'Hello' }, { deltaText: ' world' }]);
  });

  it('waits for the final durable snapshot before flushTurn resolves', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    let resolveInitialCommit: (() => void) | undefined;
    let durableCommitCount = 0;
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async () => {
        durableCommitCount += 1;
        if (durableCommitCount === 1) {
          await new Promise<void>((resolve) => {
            resolveInitialCommit = resolve;
          });
        }
      },
    });

    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'Hello world' } satisfies AgentMessage);

    let didResolveFlushTurn = false;
    const flushPromise = runtime.flushTurn().then(() => {
      didResolveFlushTurn = true;
    });

    await Promise.resolve();
    expect(didResolveFlushTurn).toBe(false);

    const releaseInitialCommit = resolveInitialCommit;
    if (!releaseInitialCommit) {
      throw new Error('expected initial durable commit resolver');
    }
    releaseInitialCommit();
    await flushPromise;

    expect(didResolveFlushTurn).toBe(true);
    expect(durableCommitCount).toBe(2);
  });

  it('flushes the active assistant segment before forwarding a permission request', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
      },
    });

    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'The' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: ' directory is empty.' } satisfies AgentMessage);
    backend.emit({
      type: 'permission-request',
      id: 'perm-1',
      reason: 'Write',
      payload: { toolName: 'Write', input: { path: '/tmp/note.txt' } },
    } satisfies AgentMessage);

    await Promise.resolve();
    await Promise.resolve();

    expect(durableCalls.length).toBeGreaterThanOrEqual(2);
    expect(durableCalls[durableCalls.length - 1]).toMatchObject({
      body: { type: 'message', message: 'The directory is empty.' },
      meta: {
        happierStreamSegmentV1: expect.objectContaining({
          segmentState: 'complete',
        }),
      },
    });
  });
});
