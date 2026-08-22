import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (transcript streaming vNext)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes durable streaming checkpoints with a stable segment localId reused by the final commit', async () => {
    const previousInitialCheckpointMs = process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS;
    process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS = '0';

    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      enqueueAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
        return { persisted: true, delivered: false };
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

      await runtime.sendTurnPrompt('session setup');
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
    } finally {
      if (previousInitialCheckpointMs === undefined) {
        delete process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS;
      } else {
        process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS = previousInitialCheckpointMs;
      }
    }
  });

  it('closes an unflushed assistant segment before the next turn can append output', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      enqueueAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
        return { persisted: true, delivered: false };
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'First answer' } satisfies AgentMessage);

    await vi.waitFor(() => {
      expect(durableCalls.some((call) => call.body.type === 'message' && call.body.message === 'First answer')).toBe(true);
    });
    const firstTurnLocalId = durableCalls.find(
      (call) => call.body.type === 'message' && call.body.message === 'First answer',
    )?.localId;

    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'Second answer' } satisfies AgentMessage);
    await runtime.flushTurn();

    let secondTurnFinal: { localId: string; body: ACPMessageData; meta?: Record<string, unknown> } | undefined;
    for (let i = durableCalls.length - 1; i >= 0; i -= 1) {
      const call = durableCalls[i]!;
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      if (
        call.body.type === 'message'
        && call.body.message === 'Second answer'
        && segmentState === 'complete'
      ) {
        secondTurnFinal = call;
        break;
      }
    }
    expect(firstTurnLocalId).toEqual(expect.any(String));
    expect(secondTurnFinal?.localId).toEqual(expect.any(String));
    expect(secondTurnFinal?.localId).not.toBe(firstTurnLocalId);
    expect(durableCalls.some((call) => call.body.type === 'message' && call.body.message === 'First answerSecond answer')).toBe(false);
  });

  it('emits live snapshots through the explicit transcript session port', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const liveCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
    });
    const transcriptSession = {
      sendAgentMessageEphemeral: vi.fn((_provider: string, body: ACPMessageData, opts: { meta?: Record<string, unknown> }) => {
        liveCalls.push({ body, meta: opts.meta });
      }),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
    };

    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session,
      transcriptSession: transcriptSession as any,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    } as any);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);

    await Promise.resolve();

    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]).toMatchObject({
      body: { type: 'message', message: 'Hello' },
      meta: {
        happierStreamSegmentV1: expect.objectContaining({
          segmentState: 'streaming',
        }),
      },
    });
  });

  it('can emit each durable checkpoint immediately when stream checkpoint buffering is disabled', async () => {
    const previousInitialCheckpointMs = process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS;
    const previousCheckpointMs = process.env.HAPPIER_STREAM_CHECKPOINT_MS;
    const previousCheckpointMinChars = process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS;
    process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS = '0';
    process.env.HAPPIER_STREAM_CHECKPOINT_MS = '0';
    process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS = '1';

    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      enqueueAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
        return { persisted: true, delivered: false };
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

      await runtime.sendTurnPrompt('session setup');
      runtime.beginTurn();

      backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
      await vi.waitFor(() => {
        expect(durableCalls.length).toBeGreaterThanOrEqual(1);
      });
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
      if (previousInitialCheckpointMs === undefined) {
        delete process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS;
      } else {
        process.env.HAPPIER_STREAM_INITIAL_CHECKPOINT_MS = previousInitialCheckpointMs;
      }
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
      enqueueAgentMessageCommitted: async () => {
        durableCommitCount += 1;
        if (durableCommitCount === 1) {
          await new Promise<void>((resolve) => {
            resolveInitialCommit = resolve;
          });
        }
        return { persisted: true, delivered: false };
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

    await runtime.sendTurnPrompt('session setup');
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
      enqueueAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
        return { persisted: true, delivered: false };
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

    await runtime.sendTurnPrompt('session setup');
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

    await vi.waitFor(() => {
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

  it('persists ACP text and session media events through one central transcript bridge row request', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const sessionMediaCalls: unknown[] = [];
    let resolveMediaAdmission!: () => void;
    const mediaAdmission = new Promise<void>((resolve) => {
      resolveMediaAdmission = resolve;
    });
    const session = createBasicSessionClientWithOverrides({
      enqueueAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
        return { persisted: true, delivered: false };
      },
      sendAgentSessionMediaCommitted: async (_provider, request) => {
        sessionMediaCalls.push(request);
        await mediaAdmission;
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    backend.emit({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: 'media-row-1',
        role: 'output',
        category: 'generated',
        messageText: 'Generated image:',
        media: [{
          source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'generated.png' },
          origin: { source: 'acp-content' },
        }],
      },
    } as AgentMessage);

    await vi.waitFor(() => {
      expect(sessionMediaCalls).toHaveLength(1);
    });
    const flush = runtime.flushTurn();
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushSettled).toBe(false);

    resolveMediaAdmission();
    await flush;
    expect(sessionMediaCalls[0]).toMatchObject({
      localId: 'media-row-1',
      role: 'output',
      category: 'generated',
      messageText: 'Generated image:',
      media: [{
        source: { kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'generated.png' },
        origin: { source: 'acp-content' },
      }],
    });
    expect(durableCalls).toEqual([]);
  });

  it('deduplicates repeated ACP session media events before persistence', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const sessionMediaCalls: unknown[] = [];
    let mediaAttempt = 0;
    const session = createBasicSessionClientWithOverrides({
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
      sendAgentSessionMediaCommitted: async (_provider, request) => {
        sessionMediaCalls.push(request);
        mediaAttempt += 1;
        if (mediaAttempt === 1) {
          throw new Error('durable custody closed before admission');
        }
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    const media = [{
      source: { kind: 'base64' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png', fileNameHint: 'generated.png' },
      origin: { source: 'acp-content' as const, agentEventId: 'final-message-1' },
    }];

    backend.emit({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: 'media-row-chunk',
        role: 'output',
        category: 'generated',
        media,
      },
    } satisfies AgentMessage);

    await vi.waitFor(() => {
      expect(sessionMediaCalls).toHaveLength(1);
    });

    backend.emit({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: 'media-row-final',
        role: 'output',
        category: 'generated',
        media,
      },
    } satisfies AgentMessage);

    await vi.waitFor(() => {
      expect(sessionMediaCalls).toHaveLength(2);
    });
    expect(sessionMediaCalls[1]).toMatchObject({
      localId: 'media-row-final',
      media,
    });

    backend.emit({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: 'media-row-duplicate-after-success',
        role: 'output',
        category: 'generated',
        media,
      },
    } satisfies AgentMessage);
    await Promise.resolve();
    expect(sessionMediaCalls).toHaveLength(2);
  });
});
