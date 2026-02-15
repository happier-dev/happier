import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { formatMessage, formatSessionFull, type VoiceContextFormatterPrefs } from './contextFormatters';

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
});
