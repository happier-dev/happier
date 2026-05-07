import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (transcript streaming vNext)', () => {
  it('tracks the current turn assistant preview from structured model output and resets between turns', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: ' world' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Hello world');

    runtime.beginTurn();

    expect(tracker.getPreview()).toBeNull();
  });

  it('writes durable streaming checkpoints with a stable segment localId reused by the final commit', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
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

    backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: ' world' } satisfies AgentMessage);

    await runtime.flushTurn();

    expect(durableCalls.length).toBeGreaterThanOrEqual(2);
    expect(typeof durableCalls[0]?.localId).toBe('string');
    expect(durableCalls[0]!.localId).toBe(durableCalls[durableCalls.length - 1]!.localId);
    expect((durableCalls[0]!.meta as any)?.happierStreamSegmentV1?.segmentState).toBe('streaming');

    const last = durableCalls[durableCalls.length - 1]!;
    expect(last.body).toMatchObject({ type: 'message', message: 'Hello world' });
    expect(last.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({
        segmentLocalId: durableCalls[0]!.localId,
        segmentState: 'complete',
      }),
    });
  });

  it('can emit each durable checkpoint immediately when stream checkpoint buffering is disabled', async () => {
    const previousCheckpointMs = process.env.HAPPIER_STREAM_CHECKPOINT_MS;
    const previousCheckpointMinChars = process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS;
    process.env.HAPPIER_STREAM_CHECKPOINT_MS = '0';
    process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS = '1';

    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
      },
    });

    try {
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

      backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
      backend.emit({ type: 'model-output', textDelta: ' world' } satisfies AgentMessage);

      await vi.waitFor(() => {
        expect(durableCalls.length).toBeGreaterThanOrEqual(2);
      });

      expect(durableCalls.slice(0, 2).map((call) => (call.body as any)?.message)).toEqual([
        'Hello',
        'Hello world',
      ]);
      expect(durableCalls.slice(0, 2).map((call) => (call.meta as any)?.happierStreamSegmentV1?.segmentState)).toEqual([
        'streaming',
        'streaming',
      ]);
    } finally {
      if (previousCheckpointMs === undefined) {
        delete process.env.HAPPIER_STREAM_CHECKPOINT_MS;
      } else {
        process.env.HAPPIER_STREAM_CHECKPOINT_MS = previousCheckpointMs;
      }
      if (previousCheckpointMinChars === undefined) {
        delete process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS;
      } else {
        process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS = previousCheckpointMinChars;
      }
    }
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
    const forwardedBodies: ACPMessageData[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        forwardedBodies.push(body);
      },
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

    await vi.waitFor(() => {
      expect(forwardedBodies).toContainEqual(
        expect.objectContaining({
          type: 'permission-request',
          toolName: 'Write',
        }),
      );
    });

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
