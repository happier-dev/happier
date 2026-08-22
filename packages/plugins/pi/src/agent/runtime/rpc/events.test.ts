import { describe, expect, it } from 'vitest';

import { createPiRuntimeEventProjector } from './events.js';

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  agentSessionId: 'pi-session-1',
  nowMs: () => 1,
} as const;

function reasoningTexts(events: ReturnType<ReturnType<typeof createPiRuntimeEventProjector>['project']>): string[] {
  return events
    .filter((event) => event.kind === 'message-delta' && event.channel === 'reasoning')
    .map((event) => event.text);
}

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
