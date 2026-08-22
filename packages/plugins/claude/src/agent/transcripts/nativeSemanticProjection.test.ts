import { describe, expect, it } from 'vitest';

import {
  classifyClaudeNativeTranscriptRow,
  classifyClaudeNativeHookLifecycle,
  createClaudeCompactBoundaryEventId,
} from './nativeSemanticProjection.js';
import { mapClaudeUnifiedTranscriptLifecyclePayload } from '../runtime/terminal/unified/lifecycleEvents.js';
import { projectClaudeTranscriptRowToProviderPayload } from '../runtime/terminal/unified/providerTranscript.js';
import {
  projectClaudeJsonlLineToDirectMessages,
  projectClaudeJsonlLineToRawMessage,
} from './projection.js';

describe('Claude native transcript semantic projection', () => {
  it('classifies an unparsable known row from its raw body instead of leaving it unknown', () => {
    // A malformed assistant row still reaches storage as opaque content. Leaving it `unknown` is the
    // one path where an event row escapes the role filter that every other path applies.
    expect(classifyClaudeNativeTranscriptRow({
      type: 'assistant',
      uuid: 42,
      isApiErrorMessage: true,
    })).toMatchObject({ messageRole: 'event', content: { kind: 'opaque' } });
  });

  it('keeps Claude context-injection and internal state records out of the transcript', () => {
    // Claude Code started emitting these around 2026-06-19. They carry no conversation content, and
    // a row that renders as an unsupported placeholder is noise. Two separate rules keep them out:
    // `attachment` parses and is caught as an internal transcript message, while the others fail the
    // raw schema and are hidden because their type is neither `user` nor `assistant`.
    const contextInjectionRows: ReadonlyArray<Record<string, unknown>> = [
      { type: 'attachment', uuid: 'attachment-1', attachment: { type: 'queued_command', prompt: 'run the thing' } },
      { type: 'last-prompt', uuid: 'last-prompt-1' },
      { type: 'mode', uuid: 'mode-1' },
      { type: 'pr-link', uuid: 'pr-link-1' },
    ];

    for (const row of contextInjectionRows) {
      expect(classifyClaudeNativeTranscriptRow(row)).toMatchObject({ visibility: 'hidden' });
    }
  });

  it('ratifies only schema-valid progress rows as known non-transcript records', () => {
    expect(classifyClaudeNativeTranscriptRow({
      type: 'progress',
      uuid: 'progress-1',
    })).toMatchObject({
      knownNonTranscriptRecord: true,
    });
    expect(classifyClaudeNativeTranscriptRow({
      type: 'progress',
      uuid: 42,
    })).toMatchObject({
      knownNonTranscriptRecord: false,
    });
    expect(classifyClaudeNativeTranscriptRow({
      type: 'future-transcript-message',
      message: { content: 'must remain fail-closed' },
    })).toMatchObject({
      knownNonTranscriptRecord: false,
    });
  });

  it('classifies shared row semantics once while adapters keep contract-specific outputs', () => {
    const sidechainStop = {
      type: 'assistant',
      uuid: 'assistant-sidechain-stop',
      isSidechain: true,
      message: {
        content: [{ type: 'text', text: 'subagent done' }],
        stop_reason: 'end_turn',
      },
    } as const;

    expect(classifyClaudeNativeTranscriptRow(sidechainStop)).toMatchObject({
      visibility: 'visible',
      messageRole: 'agent',
      sidechain: true,
      lifecycle: {
        kind: 'assistant_stop',
        stopReason: 'end_turn',
      },
      nativeBoundary: {
        kind: 'assistant_stop',
        id: 'assistant-sidechain-stop',
      },
    });

    const external = projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 41,
      lineValue: sidechainStop,
    });
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      messageRole: 'agent',
      raw: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'claude',
          data: { type: 'message', message: 'subagent done' },
        },
      },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: sidechainStop,
      suppressPriorEraTurnClosure: false,
    })).toBeNull();
    expect(mapClaudeUnifiedTranscriptLifecyclePayload(external[0], 'happier-session')).toBeNull();

    const primaryUser = {
      type: 'user',
      uuid: 'primary-user-row',
      message: { content: 'hello' },
    } as const;
    expect(classifyClaudeNativeTranscriptRow(primaryUser)).toMatchObject({
      visibility: 'visible',
      messageRole: 'user',
      sidechain: false,
      content: { kind: 'message' },
      lifecycle: { kind: 'text', text: 'hello' },
    });
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 61,
      lineValue: primaryUser,
    })[0]).toMatchObject({
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text: 'hello' } },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: primaryUser,
      suppressPriorEraTurnClosure: false,
    })).toMatchObject({
      kind: 'text',
      text: 'hello',
    });
  });

  it('preserves sanitized visibility and stop-hook/no-response/compaction lifecycle meanings', () => {
    const compactSummary = {
      type: 'user',
      uuid: 'compact-summary-row',
      isCompactSummary: true,
      message: { content: '\u001b[32mA compact summary\u001b[0m' },
    } as const;
    const stopHookFeedback = {
      type: 'user',
      uuid: 'stop-feedback-row',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Stop hook feedback:\nkeep going' }] },
    } as const;
    const syntheticNoResponse = {
      type: 'assistant',
      uuid: 'synthetic-no-response-row',
      model: '<synthetic>',
      message: {
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    } as const;
    const compactBoundary = {
      type: 'system',
      uuid: 'compact-boundary-row',
      subtype: 'compact_boundary',
    } as const;
    const slashCommand = {
      type: 'user',
      uuid: 'slash-command-row',
      message: {
        content: '<command-name>/review</command-name><command-args>123</command-args>',
      },
    } as const;
    const localCommandOutput = {
      type: 'user',
      uuid: 'local-command-output-row',
      message: {
        content: '<local-command-stdout>first\nsecond</local-command-stdout>',
      },
    } as const;

    expect(classifyClaudeNativeTranscriptRow(compactSummary)).toMatchObject({
      visibility: 'sanitized',
      messageRole: 'agent',
      content: { kind: 'compact_summary', text: 'A compact summary' },
      lifecycle: { kind: 'none' },
    });
    expect(projectClaudeJsonlLineToRawMessage(compactSummary)).toBeNull();
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 5,
      lineValue: compactSummary,
    })[0]).toMatchObject({
      raw: {
        content: {
          type: 'acp',
          agentId: 'claude',
          data: { type: 'message', message: 'A compact summary' },
        },
      },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: compactSummary,
      suppressPriorEraTurnClosure: false,
    })).toMatchObject({
      kind: 'compact_summary',
      text: 'A compact summary',
    });
    expect(classifyClaudeNativeTranscriptRow(slashCommand)).toMatchObject({
      visibility: 'sanitized',
      messageRole: 'user',
      content: { kind: 'slash_command', text: '/review 123' },
    });
    expect(projectClaudeJsonlLineToRawMessage(slashCommand)).toBeNull();
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 8,
      lineValue: slashCommand,
    })[0]).toMatchObject({
      raw: { role: 'user', content: { type: 'text', text: '/review 123' } },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: slashCommand,
      suppressPriorEraTurnClosure: false,
    })).toMatchObject({
      kind: 'slash_command',
      text: '/review 123',
    });
    expect(classifyClaudeNativeTranscriptRow(localCommandOutput)).toMatchObject({
      visibility: 'sanitized',
      messageRole: 'agent',
      content: { kind: 'local_command_output', text: 'first\nsecond' },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: localCommandOutput,
      suppressPriorEraTurnClosure: false,
    })).toMatchObject({
      kind: 'local_command_output',
      text: 'first\nsecond',
    });

    expect(classifyClaudeNativeTranscriptRow(stopHookFeedback)).toMatchObject({
      visibility: 'visible',
      lifecycle: { kind: 'stop_hook_feedback' },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: stopHookFeedback,
      suppressPriorEraTurnClosure: false,
    })).toMatchObject({
      kind: 'stop_hook_feedback',
      turnId: 'stop-feedback-row',
    });

    expect(classifyClaudeNativeTranscriptRow(syntheticNoResponse)).toMatchObject({
      visibility: 'visible',
      lifecycle: { kind: 'synthetic_no_response' },
    });
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 17,
      lineValue: syntheticNoResponse,
    })).toHaveLength(1);
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: syntheticNoResponse,
      suppressPriorEraTurnClosure: false,
    })).toBeNull();

    expect(classifyClaudeNativeTranscriptRow(compactBoundary)).toMatchObject({
      visibility: 'visible',
      messageRole: 'event',
      lifecycle: { kind: 'compact_boundary' },
      nativeBoundary: {
        kind: 'compact_boundary',
        id: 'compact-boundary-row',
      },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: compactBoundary,
      suppressPriorEraTurnClosure: false,
    })).toMatchObject({
      kind: 'compact_boundary',
      turnId: 'compact-boundary-row',
    });
    expect(createClaudeCompactBoundaryEventId({
      providerSessionId: 'claude-session',
      nativeBoundaryId: 'compact-boundary-row',
      observedAtMs: null,
    })).toBe('claude:compact_boundary:claude-session:compact-boundary-row');
  });

  it('keeps sanitized sidechain rows externally visible without publishing parent terminal payloads', () => {
    const sidechainCompactSummary = {
      type: 'user',
      uuid: 'sidechain-compact-summary',
      isSidechain: true,
      isCompactSummary: true,
      message: { content: 'Sidechain compact summary' },
    } as const;
    const sidechainSlashCommand = {
      type: 'user',
      uuid: 'sidechain-slash-command',
      isSidechain: true,
      message: {
        content: '<command-name>/review</command-name><command-args>sidechain</command-args>',
      },
    } as const;
    const sidechainLocalCommandOutput = {
      type: 'user',
      uuid: 'sidechain-local-command-output',
      isSidechain: true,
      message: {
        content: '<local-command-stdout>sidechain output</local-command-stdout>',
      },
    } as const;

    expect(classifyClaudeNativeTranscriptRow(sidechainCompactSummary)).toMatchObject({
      visibility: 'sanitized',
      sidechain: true,
      content: { kind: 'compact_summary', text: 'Sidechain compact summary' },
    });
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 71,
      lineValue: sidechainCompactSummary,
    })[0]).toMatchObject({
      raw: {
        content: {
          type: 'acp',
          agentId: 'claude',
          data: { type: 'message', message: 'Sidechain compact summary' },
        },
      },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: sidechainCompactSummary,
      suppressPriorEraTurnClosure: false,
    })).toBeNull();

    expect(classifyClaudeNativeTranscriptRow(sidechainSlashCommand)).toMatchObject({
      visibility: 'sanitized',
      sidechain: true,
      content: { kind: 'slash_command', text: '/review sidechain' },
    });
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 81,
      lineValue: sidechainSlashCommand,
    })[0]).toMatchObject({
      raw: {
        role: 'user',
        content: { type: 'text', text: '/review sidechain' },
      },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: sidechainSlashCommand,
      suppressPriorEraTurnClosure: false,
    })).toBeNull();

    expect(classifyClaudeNativeTranscriptRow(sidechainLocalCommandOutput)).toMatchObject({
      visibility: 'sanitized',
      sidechain: true,
      content: { kind: 'local_command_output', text: 'sidechain output' },
    });
    expect(projectClaudeJsonlLineToDirectMessages({
      fileRelPath: 'projects/session.jsonl',
      lineStartOffsetBytes: 91,
      lineValue: sidechainLocalCommandOutput,
    })[0]).toMatchObject({
      raw: {
        content: {
          type: 'acp',
          agentId: 'claude',
          data: { type: 'message', message: 'sidechain output' },
        },
      },
    });
    expect(projectClaudeTranscriptRowToProviderPayload({
      providerSessionId: 'claude-session',
      row: sidechainLocalCommandOutput,
      suppressPriorEraTurnClosure: false,
    })).toBeNull();
  });

  it('keeps sidechain hook lifecycle meaning in the same Claude semantic owner', () => {
    expect(classifyClaudeNativeHookLifecycle({
      eventName: 'PostToolUse',
      payload: { agent_id: 'subagent-1' },
      primaryAgentId: 'claude',
    })).toEqual({
      kind: 'sidechain_activity',
      sidechainAgentId: 'subagent-1',
    });
    expect(classifyClaudeNativeHookLifecycle({
      eventName: 'Stop',
      payload: { agent_id: 'subagent-1' },
      primaryAgentId: 'claude',
    })).toEqual({
      kind: 'sidechain_terminal',
      sidechainAgentId: 'subagent-1',
    });
    expect(classifyClaudeNativeHookLifecycle({
      eventName: 'StopFailure',
      payload: { agent_id: 'subagent-1' },
      primaryAgentId: 'claude',
    })).toEqual({
      kind: 'primary',
      sidechainAgentId: 'subagent-1',
    });
  });
});
