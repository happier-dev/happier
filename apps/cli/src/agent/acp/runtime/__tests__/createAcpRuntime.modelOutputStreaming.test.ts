import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';
import { createAgentSessionMediaPersister } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { logger } from '@/ui/logger';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

describe('createAcpRuntime (transcript streaming vNext)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it.each([
    { snapshotScope: 'segment' as const, finalSnapshot: 'Final answer.' },
    { snapshotScope: 'turn' as const, finalSnapshot: 'Progress update.Final answer.' },
  ])('reconciles $snapshotScope authoritative snapshots after a tool boundary', async ({ snapshotScope, finalSnapshot }) => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
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
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Progress update.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Progress update.' } satisfies AgentMessage);
    backend.emit({ type: 'tool-call', toolName: 'Read', args: {}, callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({ type: 'tool-result', toolName: 'Read', result: 'done', callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Final answer.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: finalSnapshot, fullTextScope: snapshotScope } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Progress update.Final answer.');
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Progress update.', 'Final answer.']);
  });

  it('reconciles consecutive segment snapshots against their explicit provider boundaries', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
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
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    // A multi-message turn can contain no tool/permission boundary between assistant
    // messages, so the provider message boundary owns the per-message snapshot baseline.
    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Progress update.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Progress update.', fullTextScope: 'segment' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Final answer.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Final answer.', fullTextScope: 'segment' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Progress update.Final answer.');
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Progress update.Final answer.']);
  });

  it('preserves a new snapshot-only segment when its text matches the delivered tail', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const runtime = createAcpRuntime({
      provider: 'pi',
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

    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Echo.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Echo.', fullTextScope: 'segment' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Echo.', fullTextScope: 'segment' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Echo.Echo.');
    await runtime.flushTurn();
  });

  it('keeps resetting reconciliation for a turn snapshot that is shorter than the accumulated turn', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const messageBuffer = new MessageBuffer();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
      },
    });
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    // Turn-scoped snapshots are cumulative by contract; a shorter matching snapshot means a
    // divergent provider (restart/regeneration) and must replace the accumulated turn text.
    backend.emit({ type: 'model-output', textDelta: 'Draft.Final.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Final.', fullTextScope: 'turn' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Final.');
    expect(messageBuffer.getMessages()
      .filter((message) => message.type === 'assistant')
      .map((message) => message.content)).toEqual(['Final.']);
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Final.']);
  });

  it('replaces a divergent segment snapshot in every assistant text projection', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const messageBuffer = new MessageBuffer();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
      },
    });
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Draft.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Final.', fullTextScope: 'segment' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Final.');
    expect(messageBuffer.getMessages()
      .filter((message) => message.type === 'assistant')
      .map((message) => message.content)).toEqual(['Final.']);
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Final.']);
  });

  it('preserves earlier provider segments when a later segment snapshot diverges', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const messageBuffer = new MessageBuffer();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
      },
    });
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Progress.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Progress.', fullTextScope: 'segment' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', startsNewSegment: true } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Draft.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Final.', fullTextScope: 'segment' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Progress.Final.');
    expect(messageBuffer.getMessages()
      .filter((message) => message.type === 'assistant')
      .map((message) => message.content)).toEqual(['Progress.Final.']);
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Progress.Final.']);
  });

  it('replaces only the active durable segment when a turn snapshot diverges after a tool boundary', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
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
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Progress.' } satisfies AgentMessage);
    backend.emit({ type: 'tool-call', toolName: 'Read', args: {}, callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({ type: 'tool-result', toolName: 'Read', result: 'done', callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Draft.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Progress.Final.', fullTextScope: 'turn' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Progress.Final.');
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Progress.', 'Final.']);
  });

  it('clears a stale active segment when a turn snapshot ends at the flushed prefix', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const messageBuffer = new MessageBuffer();
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ body, meta: opts.meta });
      },
    });
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Progress.' } satisfies AgentMessage);
    backend.emit({ type: 'tool-call', toolName: 'Read', args: {}, callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: 'Draft.' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', fullText: 'Progress.', fullTextScope: 'turn' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Progress.');
    expect(messageBuffer.getMessages().map((message) => [message.type, message.content])).toEqual([
      ['assistant', 'Progress.'],
      ['tool', 'Executing: Read'],
    ]);
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages).toEqual(['Progress.', '']);
  });

  it('replaces the just-flushed durable segment when a divergent turn snapshot follows a tool boundary', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const messageBuffer = new MessageBuffer();
    const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
      },
    });
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      turnAssistantPreviewTracker: tracker,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'model-output', textDelta: 'Draft.' } satisfies AgentMessage);
    backend.emit({ type: 'tool-call', toolName: 'Read', args: {}, callId: 'tool-1' } satisfies AgentMessage);
    await expect.poll(() => durableCalls.some((call) => call.body.type === 'message')).toBe(true);
    backend.emit({ type: 'model-output', fullText: 'Final.', fullTextScope: 'turn' } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Final.');
    expect(messageBuffer.getMessages().map((message) => [message.type, message.content])).toEqual([
      ['assistant', 'Final.'],
      ['tool', 'Executing: Read'],
    ]);
    await runtime.flushTurn();

    const completedAssistantMessages = durableCalls.flatMap((call) => {
      const streamMeta = call.meta?.happierStreamSegmentV1;
      const segmentState = streamMeta && typeof streamMeta === 'object'
        ? (streamMeta as { segmentState?: unknown }).segmentState
        : undefined;
      return call.body.type === 'message' && segmentState === 'complete' ? [call.body.message] : [];
    });
    expect(completedAssistantMessages.at(-1)).toBe('Final.');
    expect(completedAssistantMessages).not.toContain('Draft.Final.');
    expect(new Set(durableCalls.map((call) => call.localId))).toHaveLength(1);
  });

  it('does not infer a segment snapshot scope from a shared prefix', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const tracker = createTurnAssistantPreviewTracker();
    const runtime = createAcpRuntime({
      provider: 'pi',
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
    backend.emit({ type: 'model-output', textDelta: 'Shared prefix' } satisfies AgentMessage);
    backend.emit({ type: 'tool-call', toolName: 'Read', args: {}, callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({
      type: 'model-output',
      fullText: 'Shared prefix continued',
      fullTextScope: 'segment',
    } satisfies AgentMessage);

    expect(tracker.getPreview()).toBe('Shared prefixShared prefix continued');
    await runtime.flushTurn();
  });

  it('closes an unflushed assistant segment before the next turn can append output', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessageCommitted: async (_provider, body, opts) => {
        durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
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

    await runtime.startOrLoad({});
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

  it('persists deduped media and commits session media metadata on mixed assistant rows', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const persisted: AgentMessage[] = [];
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const persistedMediaItem = {
      id: 'media-1',
      role: 'output',
      category: 'generated',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'generated-image.png',
      path: '.happier/uploads/generated/message-1/media-1.png',
      sizeBytes: 67,
      sha256: 'a'.repeat(64),
      origin: {
        source: 'acp-content',
        providerEventId: 'event-1',
      },
    } as const;
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
      sessionMedia: {
        persist: async (msg: AgentMessage) => {
          persisted.push(msg);
          return { media: [persistedMediaItem], unavailable: [] };
        },
      },
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const mediaMessage = {
      type: 'session-media',
      source: 'acp-content',
      media: [
        {
          kind: 'base64',
          data: 'iVBORw0KGgo=',
          mimeType: 'image/png',
          origin: {
            source: 'acp-content',
            providerEventId: 'event-1',
            contentIndex: 0,
          },
          dedupeKey: 'acp-content:event-1:0',
        },
      ],
    } satisfies AgentMessage;

    backend.emit({ type: 'model-output', textDelta: 'Here is the generated image.' } satisfies AgentMessage);
    backend.emit(mediaMessage);
    backend.emit(mediaMessage);

    await runtime.flushTurn();

    expect(persisted).toEqual([mediaMessage]);
    const finalCommit = durableCalls[durableCalls.length - 1];
    expect(finalCommit).toMatchObject({
      body: { type: 'message', message: 'Here is the generated image.' },
      meta: {
        happier: {
          kind: 'session_media.v1',
          payload: {
            media: [persistedMediaItem],
          },
        },
      },
    });
    expect(JSON.stringify(finalCommit?.meta)).not.toContain('iVBORw0KGgo=');
    expect(JSON.stringify(finalCommit?.meta)).not.toContain('attachments.v1');
  });

  it('deduplicates one generated local file across provider-extension and final-tool projections', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const persisted: AgentMessage[] = [];
    const persistedMediaItem = {
      id: 'media-image-1',
      role: 'output',
      category: 'generated',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'image.png',
      path: '.happier/uploads/generated/image-1/media-image-1.png',
      sizeBytes: 67,
      origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-1' },
    } as const;
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/workspace',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionMedia: {
        persist: async (message: AgentMessage) => {
          persisted.push(message);
          return { media: [persistedMediaItem], unavailable: [] };
        },
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();
    const path = '/workspace/generated/image.png';

    backend.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path,
        origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-1' },
      }],
    } satisfies AgentMessage);
    backend.emit({
      type: 'session-media',
      source: 'acp-tool-result',
      media: [{
        kind: 'local-file',
        path,
        origin: { source: 'tool-output', toolCallId: 'image-1', contentIndex: 0 },
      }],
    } satisfies AgentMessage);

    await runtime.flushTurn();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type === 'session-media' ? persisted[0].media : []).toHaveLength(1);
  });

  it('retries the terminal projection when an earlier duplicate media source was not persisted', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const persisted: AgentMessage[] = [];
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const persistedMediaItem = {
      id: 'media-image-1',
      role: 'output',
      category: 'generated',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'image.png',
      path: '.happier/uploads/generated/image-1/media-image-1.png',
      sizeBytes: 67,
      sha256: 'b'.repeat(64),
      origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-1' },
    } as const;
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/workspace',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessageCommitted: async (_provider, body, opts) => {
          durableCalls.push({ body, meta: opts.meta });
        },
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionMedia: {
        persist: async (message: AgentMessage) => {
          persisted.push(message);
          return persisted.length === 1
            ? {
                media: [],
                unavailable: [{
                  id: 'c'.repeat(64),
                  role: 'output',
                  category: 'generated',
                  mediaKind: 'image',
                  code: 'provider_file_unavailable',
                  origin: { source: 'provider-generated' },
                }],
              }
            : { media: [persistedMediaItem], unavailable: [] };
        },
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();
    const path = '/workspace/generated/image.png';

    backend.emit({ type: 'model-output', textDelta: 'Generated image.' } satisfies AgentMessage);
    backend.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path,
        origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'image-1' },
      }],
    } satisfies AgentMessage);
    await vi.waitFor(() => expect(persisted).toHaveLength(1));

    backend.emit({
      type: 'session-media',
      source: 'acp-tool-result',
      media: [{
        kind: 'local-file',
        path,
        origin: { source: 'tool-output', toolCallId: 'image-1', contentIndex: 0 },
      }],
    } satisfies AgentMessage);
    await runtime.flushTurn();

    expect(persisted).toHaveLength(2);
    expect(durableCalls.at(-1)?.meta).toMatchObject({
      happier: {
        kind: 'session_media.v1',
        payload: { media: [persistedMediaItem] },
      },
    });
    expect((durableCalls.at(-1)?.meta?.happier as { payload?: { unavailable?: unknown } } | undefined)?.payload?.unavailable).toBeUndefined();
  });

  it('caps one turn at the durable session-media envelope limit and releases capacity on the next turn', async () => {
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const persistedSourceIds: string[] = [];
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/workspace',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessageCommitted: async (_provider, body, opts) => {
          durableCalls.push({ body, meta: opts.meta });
        },
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionMedia: {
        persist: async (message: AgentMessage) => {
          const source = message.type === 'session-media' ? message.media[0] : undefined;
          const sourceId = source?.origin.providerEventId;
          if (!sourceId) throw new Error('expected provider event id');
          persistedSourceIds.push(sourceId);
          return {
            media: [{
              id: `media-${sourceId}`,
              role: 'output',
              category: 'generated',
              mediaKind: 'image',
              mimeType: 'image/png',
              name: `${sourceId}.png`,
              path: `.happier/uploads/generated/${sourceId}.png`,
              sizeBytes: 67,
              origin: { source: 'provider-generated', providerEventId: sourceId },
            }],
            unavailable: [],
          };
        },
      },
    });
    await runtime.startOrLoad({});

    const emitMedia = (sourceId: string) => backend.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path: `/workspace/generated/${sourceId}.png`,
        origin: { source: 'provider-generated', providerEventId: sourceId },
        dedupeKey: `cursor-generate-image:${sourceId}`,
      }],
    } satisfies AgentMessage);

    runtime.beginTurn();
    for (let index = 0; index < 257; index += 1) emitMedia(`first-${index}`);
    await runtime.flushTurn();

    const firstEnvelope = durableCalls.at(-1)?.meta?.happier;
    const { SessionMediaMessageMetaEnvelopeV1Schema } = await import('@happier-dev/protocol');
    expect(SessionMediaMessageMetaEnvelopeV1Schema.safeParse(firstEnvelope).success).toBe(true);
    expect((firstEnvelope as { payload: { media: unknown[] } }).payload.media).toHaveLength(256);
    expect(persistedSourceIds).toHaveLength(256);

    runtime.beginTurn();
    emitMedia('second-turn');
    await runtime.flushTurn();

    const secondEnvelope = durableCalls.at(-1)?.meta?.happier;
    expect(SessionMediaMessageMetaEnvelopeV1Schema.safeParse(secondEnvelope).success).toBe(true);
    expect((secondEnvelope as { payload: { media: Array<{ id: string }> } }).payload.media)
      .toEqual([expect.objectContaining({ id: 'media-second-turn' })]);
    expect(persistedSourceIds).toHaveLength(257);
    const overflowLogs = logSpy.mock.calls.filter(
      ([message]) => message === '[cursor] Bounded excess session media sources for the turn',
    );
    expect(overflowLogs).toEqual([[
      '[cursor] Bounded excess session media sources for the turn',
      { droppedCount: 1, maxEntries: 256 },
    ]]);
  });

  it('lets a later success replace an admitted unavailable item without admitting an overflowing unique source', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const attemptsBySourceId = new Map<string, number>();
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/workspace',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessageCommitted: async (_provider, body, opts) => {
          durableCalls.push({ body, meta: opts.meta });
        },
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionMedia: {
        persist: async (message: AgentMessage) => {
          const source = message.type === 'session-media' ? message.media[0] : undefined;
          const sourceId = source?.origin.providerEventId;
          if (!sourceId) throw new Error('expected provider event id');
          const attempt = (attemptsBySourceId.get(sourceId) ?? 0) + 1;
          attemptsBySourceId.set(sourceId, attempt);
          if (sourceId === 'retry' && attempt <= 2) {
            return {
              media: [],
              unavailable: [{
                id: 'unavailable-retry',
                role: 'output',
                category: 'generated',
                mediaKind: 'image',
                code: 'provider_file_unavailable',
                origin: { source: 'provider-generated' },
              }],
            };
          }
          return {
            media: [{
              id: `media-${sourceId}`,
              role: 'output',
              category: 'generated',
              mediaKind: 'image',
              mimeType: 'image/png',
              name: `${sourceId}.png`,
              path: `.happier/uploads/generated/${sourceId}.png`,
              sizeBytes: 67,
              origin: { source: 'provider-generated', providerEventId: sourceId },
            }],
            unavailable: [],
          };
        },
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();

    const emitMedia = (sourceId: string) => backend.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path: `/workspace/generated/${sourceId}.png`,
        origin: { source: 'provider-generated', providerEventId: sourceId },
        dedupeKey: `cursor-generate-image:${sourceId}`,
      }],
    } satisfies AgentMessage);

    for (let index = 0; index < 255; index += 1) emitMedia(`success-${index}`);
    emitMedia('retry');
    await vi.waitFor(() => expect(attemptsBySourceId.get('retry')).toBe(1));
    emitMedia('retry');
    await vi.waitFor(() => expect(attemptsBySourceId.get('retry')).toBe(2));
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    emitMedia('overflow');
    emitMedia('retry');
    await runtime.flushTurn();

    const envelope = durableCalls.at(-1)?.meta?.happier as {
      payload: { media: Array<{ id: string }>; unavailable?: unknown[] };
    };
    const { SessionMediaMessageMetaEnvelopeV1Schema } = await import('@happier-dev/protocol');
    expect(SessionMediaMessageMetaEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(envelope.payload.media).toHaveLength(256);
    expect(envelope.payload.media).toContainEqual(expect.objectContaining({ id: 'media-retry' }));
    expect(envelope.payload.unavailable).toBeUndefined();
    expect(attemptsBySourceId.get('retry')).toBe(3);
    expect(attemptsBySourceId.has('overflow')).toBe(false);
  });

  it('prioritizes later usable media over earlier unavailable diagnostics for distinct and retried keys', async () => {
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const attemptsBySourceId = new Map<string, number>();
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/workspace',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessageCommitted: async (_provider, body, opts) => {
          durableCalls.push({ body, meta: opts.meta });
        },
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionMedia: {
        persist: async (message: AgentMessage) => {
          const source = message.type === 'session-media' ? message.media[0] : undefined;
          const sourceId = source?.origin.providerEventId;
          if (!sourceId) throw new Error('expected provider event id');
          const attempt = (attemptsBySourceId.get(sourceId) ?? 0) + 1;
          attemptsBySourceId.set(sourceId, attempt);
          const mediaCount = sourceId === 'distinct-success'
            ? 5
            : sourceId === 'retry' && attempt > 1
              ? 10
              : 0;
          if (mediaCount > 0) {
            return {
              media: Array.from({ length: mediaCount }, (_, index) => ({
                id: `media-${sourceId}-${index}`,
                role: 'output' as const,
                category: 'generated' as const,
                mediaKind: 'image' as const,
                mimeType: 'image/png' as const,
                name: `${sourceId}-${index}.png`,
                path: `.happier/uploads/generated/${sourceId}-${index}.png`,
                sizeBytes: 67,
                origin: { source: 'provider-generated' as const, providerEventId: sourceId },
              })),
              unavailable: [],
            };
          }
          return {
            media: [],
            unavailable: [{
              id: `unavailable-${sourceId}`,
              role: 'output',
              category: 'generated',
              mediaKind: 'image',
              code: 'provider_file_unavailable',
              origin: { source: 'provider-generated' },
            }],
          };
        },
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();

    const emitMedia = (sourceId: string) => backend.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path: `/workspace/generated/${sourceId}.png`,
        origin: { source: 'provider-generated', providerEventId: sourceId },
        dedupeKey: `cursor-generate-image:${sourceId}`,
      }],
    } satisfies AgentMessage);

    emitMedia('retry');
    for (let index = 0; index < 254; index += 1) emitMedia(`unavailable-${index}`);
    await vi.waitFor(() => expect(attemptsBySourceId.size).toBe(255));
    emitMedia('distinct-success');
    await vi.waitFor(() => expect(attemptsBySourceId.get('distinct-success')).toBe(1));
    emitMedia('retry');
    await runtime.flushTurn();

    const envelope = durableCalls.at(-1)?.meta?.happier as {
      payload: { media: Array<{ id: string }>; unavailable?: Array<{ id: string }> };
    };
    const { SessionMediaMessageMetaEnvelopeV1Schema } = await import('@happier-dev/protocol');
    expect(SessionMediaMessageMetaEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(envelope.payload.media).toHaveLength(15);
    expect(envelope.payload.media.filter(({ id }) => id.startsWith('media-distinct-success-'))).toHaveLength(5);
    expect(envelope.payload.media.filter(({ id }) => id.startsWith('media-retry-'))).toHaveLength(10);
    expect(envelope.payload.unavailable).toHaveLength(241);
    expect(envelope.payload.unavailable).not.toContainEqual(expect.objectContaining({ id: 'unavailable-retry' }));
    expect(attemptsBySourceId.get('retry')).toBe(2);
    expect(logSpy.mock.calls.filter(
      ([message]) => message === '[cursor] Bounded excess session media sources for the turn',
    )).toEqual([[
      '[cursor] Bounded excess session media sources for the turn',
      { droppedCount: 13, maxEntries: 256 },
    ]]);
    logSpy.mockRestore();
  });

  it('commits a path-free unavailable-media state when generated bytes cannot be persisted', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const unavailable = {
      id: 'd'.repeat(64),
      role: 'output',
      category: 'generated',
      mediaKind: 'image',
      code: 'provider_file_unavailable',
      origin: {
        source: 'provider-generated',
        agentId: 'cursor',
        toolCallIdHash: 'e'.repeat(64),
      },
    } as const;
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/workspace',
      session: createBasicSessionClientWithOverrides({
        sendAgentMessageCommitted: async (_provider, body, opts) => {
          durableCalls.push({ body, meta: opts.meta });
        },
      }),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      sessionMedia: {
        persist: async () => ({ media: [], unavailable: [unavailable] }),
      },
    });
    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({
      type: 'session-media',
      source: 'cursor-generate-image',
      media: [{
        kind: 'local-file',
        path: '/workspace/generated/missing-secret-name.png',
        origin: { source: 'provider-generated', agentId: 'cursor', toolCallId: 'secret-call-id' },
      }],
    } satisfies AgentMessage);
    await runtime.flushTurn();

    expect(durableCalls.at(-1)).toMatchObject({
      body: { type: 'message', message: '' },
      meta: {
        happier: {
          kind: 'session_media.v1',
          payload: { media: [], unavailable: [unavailable] },
        },
      },
    });
    expect(JSON.stringify(durableCalls)).not.toContain('missing-secret-name.png');
    expect(JSON.stringify(durableCalls)).not.toContain('secret-call-id');
  });

  it('attaches ACP tool-result media to the tool-result row secondary media slot', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const persisted: AgentMessage[] = [];
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const durableCalls: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const primaryToolMeta = {
      kind: 'tool_result.structured.v1',
      payload: { callId: 'tool-1' },
    };
    const persistedMediaItem = {
      id: 'media-tool-1',
      role: 'output',
      category: 'tool-artifact',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'tool-output.png',
      path: '.happier/uploads/artifacts/tool-1/media-tool-1.png',
      sizeBytes: 67,
      sha256: 'b'.repeat(64),
      origin: {
        source: 'tool-output',
        toolCallId: 'tool-1',
      },
    } as const;
    const toolResultContent = {
      content: [
        { type: 'text', text: 'Created an image.' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png', name: 'tool-output.png' },
      ],
    };
    const toolResultMediaMessage = {
      type: 'session-media',
      source: 'acp-tool-result',
      media: [
        {
          kind: 'base64',
          data: 'iVBORw0KGgo=',
          mimeType: 'image/png',
          suggestedName: 'tool-output.png',
          origin: {
            source: 'tool-output',
            toolCallId: 'tool-1',
            contentIndex: 1,
          },
          dedupeKey: 'acp:tool-result:tool-1:929e08d597feae564ce98003c4a47ff5239a5b93681d186eda3a9871e5b62644',
        },
      ],
    } satisfies AgentMessage;
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body, opts) => {
        sent.push({ body, meta: opts?.meta });
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
      sessionMedia: {
        persist: async (msg: AgentMessage) => {
          persisted.push(msg);
          return { media: [persistedMediaItem], unavailable: [] };
        },
      },
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'tool-call', toolName: 'Read', args: {}, callId: 'tool-1' } satisfies AgentMessage);
    backend.emit({
      type: 'tool-result',
      toolName: 'Read',
      callId: 'tool-1',
      result: toolResultContent,
      meta: {
        happier: primaryToolMeta,
      },
    } as AgentMessage);
    backend.emit(toolResultMediaMessage);

    await vi.waitFor(() => {
      const toolResult = sent.find((call) => call.body.type === 'tool-result');
      expect(toolResult?.meta?.happier).toEqual(primaryToolMeta);
      expect(toolResult?.meta?.happierMedia).toMatchObject({
        kind: 'session_media.v1',
        payload: {
          media: [persistedMediaItem],
        },
      });
    });

    await runtime.flushTurn();

    expect(persisted).toHaveLength(1);
    const emptyAssistantMediaRows = durableCalls.filter(
      (call) => call.body.type === 'message' && call.body.message === '' && JSON.stringify(call.meta).includes('session_media.v1'),
    );
    expect(emptyAssistantMediaRows).toHaveLength(0);
    expect(JSON.stringify(sent)).not.toContain('attachments.v1');
    expect(JSON.stringify(sent.map((call) => call.meta))).not.toContain('iVBORw0KGgo=');
  });

  it('persists ACP media through the session media persister before committing metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-acp-session-media-'));
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
        directory: workingDirectory,
        happierSessionId: 'happy-session-1',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend,
        sessionMedia: createAgentSessionMediaPersister({
          workingDirectory,
          sessionId: 'happy-session-1',
        }),
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();

      backend.emit({ type: 'model-output', textDelta: 'Generated output:' } satisfies AgentMessage);
      backend.emit({
        type: 'session-media',
        source: 'acp-content',
        media: [
          {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            suggestedName: 'generated.png',
            origin: {
              source: 'acp-content',
              providerEventId: 'event-1',
              contentIndex: 0,
            },
            dedupeKey: 'acp-content:event-1:0',
          },
        ],
      } satisfies AgentMessage);

      await runtime.flushTurn();

      const finalCommit = durableCalls[durableCalls.length - 1];
      expect(finalCommit?.body).toEqual({ type: 'message', message: 'Generated output:' });
      const envelope = finalCommit?.meta?.happier as { kind?: string; payload?: { media?: Array<{ path?: string }> } } | undefined;
      expect(envelope?.kind).toBe('session_media.v1');
      expect(envelope?.payload?.media).toHaveLength(1);
      const mediaItem = envelope?.payload?.media?.[0];
      expect(mediaItem?.path).toMatch(/^\.happier\/uploads\/generated\//);
      expect(JSON.stringify(finalCommit?.meta)).not.toContain(pngBytes.toString('base64'));
      expect(JSON.stringify(finalCommit?.meta)).not.toContain(workingDirectory);
      expect(JSON.stringify(finalCommit?.meta)).not.toContain('file://');
      expect(JSON.stringify(finalCommit?.meta)).not.toContain('attachments.v1');
      await expect(readFile(resolve(workingDirectory, mediaItem!.path!))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
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
