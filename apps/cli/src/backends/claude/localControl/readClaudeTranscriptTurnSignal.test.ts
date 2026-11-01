import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '../types';
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

  it.each([
    '<bash-stdout>hi\n</bash-stdout><bash-stderr></bash-stderr>',
    '<bash-stderr>Command failed: exit 1</bash-stderr>',
  ])('does not start a turn from visible shell output (%s)', (text) => {
    for (const content of [text, [{ type: 'text', text }]]) {
      expect(readClaudeTranscriptTurnSignal({ type: 'user', uuid: 'shell-output',
        message: { role: 'user', content } } satisfies RawJSONLines)).toBeNull();
    }
  });

  it('preserves native shell input as a turn start', () => {
    expect(readClaudeTranscriptTurnSignal({ type: 'user', uuid: 'shell-input',
      message: { role: 'user', content: '<bash-input> echo hi</bash-input>' } } satisfies RawJSONLines))
      .toEqual({ type: 'turn_started', providerTurnId: null, source: 'claude_transcript_user_prompt' });
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

  it('ignores Claude synthetic no-response closures as provider activity', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'assistant',
        uuid: 'synthetic-no-response',
        model: '<synthetic>',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      } satisfies RawJSONLines),
    ).toBeNull();
  });

  it('detects compact boundaries as completion candidates', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'system',
        uuid: 'compact-boundary-1',
        subtype: 'compact_boundary',
        session_id: 'claude-session-after-compact',
      } as any),
    ).toEqual({ type: 'completion_candidate', providerTurnId: null, source: 'claude_transcript_compact_boundary' });
  });

  it('treats auto compact boundaries as continuation instead of completion', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'system',
        uuid: 'auto-compact-boundary-1',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto' },
        session_id: 'claude-session-after-auto-compact',
      } as any),
    ).toEqual({ type: 'continuation_detected', providerTurnId: null, source: 'claude_transcript_auto_compact_boundary' });

    expect(
      readClaudeTranscriptTurnSignal({
        type: 'system',
        uuid: 'auto-compact-boundary-2',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto' },
        session_id: 'claude-session-after-auto-compact',
      } as any),
    ).toEqual({ type: 'continuation_detected', providerTurnId: null, source: 'claude_transcript_auto_compact_boundary' });
  });

  it('detects synthetic assistant API-error rate-limit records as failed terminal events', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'assistant',
        uuid: 'api-error-assistant-1',
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        error: 'rate_limit',
        message: {
          type: 'message',
          role: 'assistant',
          content: [],
        },
      } as any),
    ).toEqual({
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'failed',
      detail: 'rate_limit',
      source: 'claude_transcript_api_error_rate_limit',
    });
  });

  it('detects synthetic assistant provider API-error records as failed terminal events', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'assistant',
        uuid: 'api-error-assistant-overload',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
        },
      } as any),
    ).toEqual({
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'failed',
      detail: 'api_error',
      source: 'claude_transcript_api_error',
    });
  });

  it('detects Claude Code transcript authentication_failed rows as failed terminal events', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'assistant',
        uuid: 'api-error-assistant-auth',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      } as any),
    ).toEqual({
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'failed',
      detail: 'authentication_failed',
      source: 'claude_transcript_api_error_authentication',
    });
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

  it('ignores Claude local-command transcript rows as user turn starts', () => {
    for (const message of [
      {
        type: 'user',
        uuid: 'local-command-caveat-1',
        isMeta: true,
        message: {
          content: '<local-command-caveat>Generated by a local command.</local-command-caveat>',
        },
      },
      {
        type: 'user',
        uuid: 'compact-command-1',
        message: {
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      },
      {
        type: 'user',
        uuid: 'model-empty-args-command-1',
        message: {
          content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
        },
      },
      {
        type: 'user',
        uuid: 'compact-stdout-1',
        message: {
          content: [
            {
              type: 'text',
              text: [
                '<local-command-stdout>Compacted',
                'PreCompact [hook] completed successfully',
                'PostCompact [hook] completed successfully',
                'Additional genuine multi-line Claude local-command stdout</local-command-stdout>',
              ].join('\n'),
            },
          ],
        },
      },
    ]) {
      expect(readClaudeTranscriptTurnSignal(message as any)).toBeNull();
    }
  });

  it('keeps a plain slash compact prompt as a user turn start', () => {
    expect(
      readClaudeTranscriptTurnSignal({
        type: 'user',
        uuid: 'plain-compact-prompt-1',
        message: {
          content: '/compact',
        },
      } as any),
    ).toEqual({
      type: 'turn_started',
      providerTurnId: null,
      source: 'claude_transcript_user_prompt',
    });
  });

  it.each([
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
  ])('detects %s as an aborted terminal event', (text) => {
    for (const content of [text, [{ type: 'text', text }]]) {
      expect(
        readClaudeTranscriptTurnSignal({
          type: 'user',
          uuid: 'u4',
          message: { role: 'user', content },
        } satisfies RawJSONLines),
      ).toEqual({
        type: 'turn_terminal',
        providerTurnId: null,
        reason: 'aborted',
        source: 'claude_transcript_request_interrupted',
      });
    }
  });

  it('keeps quoted interruption markers as ordinary user prompts', () => {
    expect(readClaudeTranscriptTurnSignal({
      type: 'user', uuid: 'quoted-interruption',
      message: { role: 'user', content: 'Explain [Request interrupted by user for tool use]' },
    } satisfies RawJSONLines)).toMatchObject({ type: 'turn_started' });
  });

  it('does not abort the main turn for a sidechain interruption or tool-result text', () => {
    const text = '[Request interrupted by user for tool use]';
    expect(readClaudeTranscriptTurnSignal({
      type: 'user', uuid: 'sidechain-interruption', isSidechain: true,
      message: { role: 'user', content: [{ type: 'text', text }] },
    } satisfies RawJSONLines)).toBeNull();
    expect(readClaudeTranscriptTurnSignal({
      type: 'user', uuid: 'tool-result-interruption',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: text }] },
    } satisfies RawJSONLines)).toBeNull();
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
        type: 'system',
        uuid: 'sidechain-compact-boundary',
        isSidechain: true,
        subtype: 'compact_boundary',
        session_id: 'claude-sidechain-session',
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
