import { describe, expect, it } from 'vitest';

import { createPiRuntimeEventProjector } from './events.js';

const context = {
  turnId: 'turn-1',
  agentSessionId: 'pi-session-1',
  nowMs: () => 1,
} as const;

type ProjectedEvents = ReturnType<ReturnType<typeof createPiRuntimeEventProjector>['project']>;

describe('host idle compaction correlation', () => {
  it('retains the idle origin while matching the native manual lifecycle exactly once', () => {
    const projector = createPiRuntimeEventProjector();
    const idleContext = { ...context, turnId: null };
    projector.expectHostCompaction({ compactionId: 'idle-compact', trigger: 'idle' });
    const started = projector.project({ type: 'compaction_start', reason: 'manual' }, idleContext);
    expect(started).toMatchObject([{ kind: 'context-compaction', phase: 'started', trigger: 'idle', compactionId: 'idle-compact' }]);
    expect(started[0]).not.toHaveProperty('turnId');
    for (const reason of ['auto', 'threshold', 'overflow']) {
      expect(projector.project({ type: 'compaction_end', reason, aborted: true }, idleContext)).toEqual([]);
    }
    const terminal = { type: 'compaction_end', reason: 'manual', aborted: true };
    expect(projector.project(terminal, idleContext)).toMatchObject([
      { kind: 'context-compaction', phase: 'cancelled', trigger: 'idle', compactionId: 'idle-compact' },
    ]);
    expect(projector.project(terminal, idleContext)).toEqual([]);
  });
});

function channelTexts(events: ProjectedEvents, channel: 'assistant' | 'reasoning'): string[] {
  return events
    .filter((event) => event.kind === 'message-delta' && event.channel === channel)
    .map((event) => event.text);
}

function reasoningTexts(events: ProjectedEvents): string[] {
  return channelTexts(events, 'reasoning');
}

function assistantTexts(events: ProjectedEvents): string[] {
  return channelTexts(events, 'assistant');
}

describe('createPiRuntimeEventProjector assistant snapshots', () => {
  it('commits an empty final snapshot to remove a streamed draft', () => {
    const projector = createPiRuntimeEventProjector();
    const draft = projector.project({
      type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Removed draft' },
    }, context);
    const completed = projector.project({
      type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
    }, context);
    expect(completed).toMatchObject([{
      kind: 'transcript-message-committed', role: 'assistant', text: '',
      messageId: expect.any(String),
    }]);
    const committed = completed.find((event) => event.kind === 'transcript-message-committed');
    expect(draft).toMatchObject([{ kind: 'message-delta', messageId: committed?.messageId }]);
  });

  it('publishes the corrected final artifact under the streamed message identity without appending a divergent draft', () => {
    const projector = createPiRuntimeEventProjector();
    projector.project({ type: 'message_start', message: { role: 'assistant', content: [] } }, context);
    const draft = projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Draft report' },
    }, context);
    const correction = projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Corrected report' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'Corrected report' }] },
    }, context);
    expect(assistantTexts(correction)).toEqual([]);
    const completed = projector.project({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Corrected report' }] },
    }, context);
    expect(completed).toMatchObject([{
      kind: 'transcript-message-committed', role: 'assistant', text: 'Corrected report',
      messageId: expect.any(String),
    }]);
    const committed = completed.find((event) => event.kind === 'transcript-message-committed');
    expect(draft).toMatchObject([{ kind: 'message-delta', messageId: committed?.messageId }]);

    projector.project({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: {} }, context);
    projector.project({ type: 'message_start', message: { role: 'assistant', content: [] } }, context);
    const acknowledgment = projector.project({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Artifact delivered.' }] },
    }, context);
    expect(acknowledgment).toMatchObject([{
      kind: 'transcript-message-committed', text: 'Artifact delivered.',
    }]);
    const later = acknowledgment.find((event) => event.kind === 'transcript-message-committed');
    expect(later?.messageId).not.toBe(committed?.messageId);
    projector.resetTurn();
    const nextTurn = projector.project({
      type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Next turn' }] },
    }, { ...context, turnId: 'turn-2' });
    const nextCommitted = nextTurn.find((event) => event.kind === 'transcript-message-committed');
    expect(nextCommitted?.messageId).not.toBe(committed?.messageId);
    expect(nextCommitted?.messageId).not.toBe(later?.messageId);
  });

  it('reconciles authoritative snapshots within each assistant segment across tool boundaries', () => {
    const projector = createPiRuntimeEventProjector();

    expect(assistantTexts(projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Progress update.' },
    }, context))).toEqual(['Progress update.']);
    expect(assistantTexts(projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Progress update.' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'Progress update.' }] },
    }, context))).toEqual([]);
    expect(assistantTexts(projector.project({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Progress update.' }] },
    }, context))).toEqual([]);

    projector.project({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'Read',
      args: {},
    }, context);

    expect(assistantTexts(projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Final answer.' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] },
    }, context))).toEqual(['Final answer.']);
  });

  it('does not treat a shared prefix from an earlier assistant segment as streamed current text', () => {
    const projector = createPiRuntimeEventProjector();

    const earlier = projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Shared prefix' },
    }, context);
    projector.project({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'Read',
      args: {},
    }, context);

    const current = projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Shared prefix continued' },
    }, context);
    expect(assistantTexts(current)).toEqual(['Shared prefix continued']);
    expect(current).toMatchObject([{ messageId: expect.any(String) }]);
    const currentDelta = current.find((event) => event.kind === 'message-delta');
    const earlierDelta = earlier.find((event) => event.kind === 'message-delta');
    expect(currentDelta?.messageId).not.toBe(earlierDelta?.messageId);

    expect(projector.project({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Shared prefix continued' }] },
    }, context)).toMatchObject([{
      kind: 'transcript-message-committed', role: 'assistant', text: 'Shared prefix continued',
    }]);
  });
});

describe('createPiRuntimeEventProjector reasoning', () => {
  it('streams thinking deltas and appends only the missing authoritative suffix', () => {
    const projector = createPiRuntimeEventProjector();

    expect(reasoningTexts(projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'I should ' },
    }, context))).toEqual(['I should ']);

    expect(reasoningTexts(projector.project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'I should finish.' }],
      },
    }, context))).toEqual(['finish.']);
  });

  it('publishes a complete snapshot when no thinking deltas were observed', () => {
    const projector = createPiRuntimeEventProjector();

    expect(reasoningTexts(projector.project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'final thought' }],
      },
    }, context))).toEqual(['final thought']);
  });

  it('surfaces divergent snapshots and clears reconciliation state between messages and turns', () => {
    const projector = createPiRuntimeEventProjector();

    projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'partial' },
    }, context);
    expect(reasoningTexts(projector.project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'authoritative' }],
      },
    }, context))).toEqual(['\n\nauthoritative']);

    expect(reasoningTexts(projector.project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'next message' }],
      },
    }, context))).toEqual(['next message']);

    projector.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'old turn' },
    }, context);
    projector.resetTurn();
    expect(reasoningTexts(projector.project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'new turn' }],
      },
    }, context))).toEqual(['new turn']);
  });
});
