import { describe, expect, it } from 'vitest';

import { readClaudeTranscriptTurnSignal } from './readClaudeTranscriptTurnSignal';

describe('readClaudeTranscriptTurnSignal', () => {
  it('detects root user prompts as turn starts', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'user',
        uuid: 'u1',
        message: { content: 'hello' },
      } as any),
    ).toEqual({ type: 'turn_started', providerTurnId: null, source: 'claude_transcript_user_prompt' });
  });

  it('detects assistant end_turn as a completion candidate', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'assistant',
        uuid: 'a1',
        isSidechain: false,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
      } as any),
    ).toEqual({ type: 'completion_candidate', providerTurnId: null, source: 'claude_transcript_assistant_end_turn' });
  });

  it('detects exact Stop hook feedback meta records as continuation', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'user',
        uuid: 'u2',
        isMeta: true,
        message: {
          content: [{ type: 'text', text: 'Stop hook feedback:\nPlease continue.' }],
        },
      } as any),
    ).toEqual({ type: 'continuation_detected', providerTurnId: null, source: 'claude_transcript_stop_hook_feedback' });

    expect(
      readClaudeTranscriptTurnSignal({
        type: 'user',
        uuid: 'u3',
        isMeta: true,
        message: {
          content: [{ type: 'text', text: 'prefix Stop hook feedback:\nnot a provider feedback record' }],
        },
      } as any),
    ).toBeNull();
  });

  it('detects request interruption transcript records as aborted terminal events', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'user',
        uuid: 'u4',
        message: { content: '[Request interrupted by user]' },
      } as any),
    ).toEqual({
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'aborted',
      source: 'claude_transcript_request_interrupted',
    });
  });

  it('ignores sidechain and tool result records for main turn lifecycle', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'assistant',
        uuid: 'a-side',
        isSidechain: true,
        message: { stop_reason: 'end_turn' },
      } as any),
    ).toBeNull();

    expect(
      readClaudeTranscriptTurnSignal({
        type: 'user',
        uuid: 'tool-result',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }],
        },
      } as any),
    ).toBeNull();
  });
});
