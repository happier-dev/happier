import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
  formatMessage,
  formatSessionFull,
  summarizeAgentRequestForVoiceHuman,
  summarizeMessagesForVoiceHuman,
  formatUserActionRequest,
  type VoiceContextFormatterPrefs,
} from './contextFormatters';

function createSession(path: string | null, summaryText = 'Hello'): Session {
  return {
    id: 's1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: {
      path: path ?? '',
      host: 'localhost',
      summary: { text: summaryText, updatedAt: 0 },
    } as Session['metadata'],
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
  };
}

function createUserMessage(id: string, text: string, createdAt: number): Message {
  return {
    kind: 'user-text',
    id,
    localId: null,
    createdAt,
    text,
  };
}

function createToolCallMessage(id: string, toolName: string, createdAt: number): Message {
  return {
    kind: 'tool-call',
    id,
    localId: null,
    createdAt,
    children: [],
    tool: {
      name: toolName,
      state: 'completed',
      input: {},
      createdAt,
      startedAt: createdAt,
      completedAt: createdAt + 1,
      description: null,
    },
  };
}

function prefs(overrides: Partial<VoiceContextFormatterPrefs>): VoiceContextFormatterPrefs {
  return {
    voiceShareSessionSummary: true,
    voiceShareRecentMessages: true,
    voiceRecentMessagesCount: 10,
    voiceShareToolNames: true,
    voiceShareToolArgs: true,
    voiceShareFilePaths: true,
    ...overrides,
  };
}

describe('voice context privacy (opt-out defaults)', () => {
  it('includes local project paths by default', () => {
    const out = formatSessionFull(createSession('/Users/alice/Company/SecretRepo'), []);

    expect(out).toContain('/Users/alice/Company/SecretRepo');
    expect(out).toContain('# Session: Hello');
    expect(out).not.toContain('# Session ID: s1');
  });

  it('omits local project paths when voiceShareFilePaths is false', () => {
    const out = formatSessionFull(
      createSession('/Users/alice/Company/SecretRepo'),
      [],
      prefs({ voiceShareFilePaths: false }),
    );

    expect(out).not.toContain('/Users/alice/Company/SecretRepo');
  });

  it('omits the session summary when voiceShareSessionSummary is false', () => {
    const out = formatSessionFull(
      createSession('/tmp/repo', 'SUPER SECRET SUMMARY'),
      [],
      prefs({ voiceShareSessionSummary: false }),
    );

    expect(out).not.toContain('SUPER SECRET SUMMARY');
  });

  it('redacts file paths inside the shared session summary when voiceShareFilePaths is false', () => {
    const out = formatSessionFull(
      createSession('/tmp/repo', 'Working in /Users/alice/Company/SecretRepo/src/index.ts'),
      [],
      prefs({ voiceShareFilePaths: false }),
    );

    expect(out).toContain('## Session Summary');
    expect(out).toContain('<path_redacted>');
    expect(out).not.toContain('/Users/alice/Company/SecretRepo/src/index.ts');
  });

  it('limits recent message context to voiceRecentMessagesCount', () => {
    const out = formatSessionFull(
      createSession('/tmp/repo'),
      [
        createUserMessage('m1', 'FIRST', 1),
        createUserMessage('m2', 'SECOND', 2),
      ],
      prefs({ voiceRecentMessagesCount: 1 }),
    );

    expect(out).toContain('SECOND');
    expect(out).not.toContain('FIRST');
  });

  it('omits tool names from recent messages when voiceShareToolNames is false', () => {
    const out = formatSessionFull(
      createSession('/tmp/repo'),
      [createToolCallMessage('m_tool', 'execute', 3)],
      prefs({ voiceShareToolNames: false }),
    );

    expect(out).not.toContain('Coding assistant is using execute');
  });

  it('includes a concise sub-agent failure summary for completed tool-call messages', () => {
    const out = formatMessage({
      kind: 'tool-call',
      id: 'm_tool',
      localId: null,
      createdAt: 3,
      children: [],
      tool: {
        name: 'SubAgentRun',
        state: 'completed',
        input: { intent: 'review' },
        createdAt: 3,
        startedAt: 3,
        completedAt: 4,
        description: null,
        result: {
          status: 'failed',
          summary: 'Invalid review output (expected strict JSON).',
          error: { code: 'invalid_output' },
        },
      },
    } as Message);

    expect(out).toContain('Coding assistant reported:');
    expect(out).toContain('Invalid review output (expected strict JSON).');
    expect(out).not.toContain('"invalid_output"');
  });

  it('summarizes failed sub-agent run updates for immediate voice announcements', () => {
    const summary = summarizeMessagesForVoiceHuman([
      {
        kind: 'tool-call',
        id: 'm_tool',
        localId: null,
        createdAt: 3,
        children: [],
        tool: {
          name: 'SubAgentRun',
          state: 'completed',
          input: { intent: 'review' },
          createdAt: 3,
          startedAt: 3,
          completedAt: 4,
          description: null,
          result: {
            status: 'failed',
            summary: 'Invalid review output (expected strict JSON).',
            error: { code: 'invalid_output' },
          },
        },
      } as Message,
    ]);

    expect(summary).toContain('Invalid review output (expected strict JSON).');
    expect(summary).toContain('failed');
  });

  it('summarizes recent path discovery results with human-readable labels', () => {
    const summary = summarizeMessagesForVoiceHuman([
      {
        kind: 'tool-call',
        id: 'm_tool',
        localId: null,
        createdAt: 3,
        children: [],
        tool: {
          name: 'listRecentPaths',
          state: 'completed',
          input: {},
          createdAt: 3,
          startedAt: 3,
          completedAt: 4,
          description: null,
          result: {
            ok: true,
            items: [
              { label: 'Payments workspace' },
              { label: 'Mobile workspace' },
            ],
          },
        },
      } as Message,
    ]);

    expect(summary).toContain('Payments workspace');
    expect(summary).toContain('Mobile workspace');
  });

  it('summarizes backend discovery results with human-readable labels instead of raw ids', () => {
    const summary = summarizeMessagesForVoiceHuman([
      {
        kind: 'tool-call',
        id: 'm_tool',
        localId: null,
        createdAt: 3,
        children: [],
        tool: {
          name: 'listAgentBackends',
          state: 'completed',
          input: {},
          createdAt: 3,
          startedAt: 3,
          completedAt: 4,
          description: null,
          result: {
            ok: true,
            items: [
              { agentId: 'claude_internal', label: 'Claude Sonnet' },
              { agentId: 'codex_internal', label: 'Codex GPT-5' },
            ],
          },
        },
      } as Message,
    ]);

    expect(summary).toContain('Claude Sonnet');
    expect(summary).toContain('Codex GPT-5');
    expect(summary).not.toContain('claude_internal');
    expect(summary).not.toContain('codex_internal');
  });

  it('omits recent messages when voiceRecentMessagesCount clamps to 0', () => {
    const out = formatSessionFull(
      createSession('/tmp/repo'),
      [createUserMessage('m1', 'HELLO', 1)],
      prefs({ voiceRecentMessagesCount: -5 }),
    );

    expect(out).not.toContain('Recent messages in session');
    expect(out).not.toContain('HELLO');
  });

  it('redacts file paths in message text when voiceShareFilePaths is false', () => {
    const msg: Message = {
      kind: 'agent-text',
      id: 'm_path',
      localId: null,
      createdAt: 1,
      text: 'See /Users/alice/SecretRepo/README.md',
    };
    const out = formatMessage(msg, prefs({ voiceShareFilePaths: false }));
    expect(out).toContain('<path_redacted>');
    expect(out).not.toContain('/Users/alice/SecretRepo/README.md');
  });

  it('redacts file paths in AskUserQuestion summaries when voiceShareFilePaths is false', () => {
    const out = formatUserActionRequest(
      's1',
      'req_question',
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Confirm path',
            question: 'Should I continue in /Users/alice/SecretRepo?',
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      prefs({ voiceShareToolArgs: false, voiceShareFilePaths: false }),
    );

    expect(out).toContain('<question_text index="1">Should I continue in <path_redacted></question_text>');
    expect(out).not.toContain('/Users/alice/SecretRepo');
    expect(out).toContain('<request_payload_redacted>true</request_payload_redacted>');
  });

  it('tells the voice agent to stop and wait for the user before using more tools for user-action requests', () => {
    const out = formatUserActionRequest(
      's1',
      'req_question',
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Choice',
            question: 'Which option should I use?',
            multiSelect: false,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
      prefs({ voiceShareToolArgs: false, voiceShareFilePaths: false }),
    );

    expect(out).toContain('Interrupt your previous plan and present this request to the human now.');
    expect(out).toContain('Do not call other tools or send new coding-session work until the human answers.');
    expect(out).toContain('Ask the human for the missing input.');
  });

  it('creates a short human-facing AskUserQuestion summary without leaking redacted payloads', () => {
    const out = summarizeAgentRequestForVoiceHuman(
      'user_action',
      'req_question',
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Choice',
            question: 'Which option should I use in /Users/alice/SecretRepo?',
            multiSelect: false,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
      prefs({ voiceShareToolArgs: false, voiceShareFilePaths: false }),
    );

    expect(out).toContain('needs your input');
    expect(out).toContain('Which option should I use in');
    expect(out).toContain('<path_redacted>');
    expect(out).not.toContain('/Users/alice/SecretRepo');
    expect(out).not.toContain('req_question');
  });
});
