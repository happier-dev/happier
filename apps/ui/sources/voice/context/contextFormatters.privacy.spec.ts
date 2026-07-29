import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
  formatMessage,
  formatPermissionRequest,
  formatReadyEvent,
  formatSessionFocus,
  formatSessionFull,
  formatSessionOffline,
  formatSessionOnline,
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
    voiceSharePermissionRequests: true,
    voiceShareDeviceInventory: true,
    ...overrides,
  };
}

describe('voice context privacy (opt-out defaults)', () => {
  beforeEach(() => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {},
      sessionListRenderables: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    }));
  });

  it.each([undefined, null, 'true', 1, {}, []])(
    'fails closed for omitted or malformed formatter prefs=%p',
    (formatterPrefs) => {
      const session = createSession(
        '/Users/alice/Company/PrivateProject',
        'PRIVATE SESSION SUMMARY',
      );
      const inventoryMessage = createToolCallMessage('m_private_tool', 'listMachines', 2);
      if (inventoryMessage.kind !== 'tool-call') throw new Error('Expected tool-call fixture');
      const messages = [
        createUserMessage('m_private', 'PRIVATE RECENT MESSAGE', 1),
        {
          ...inventoryMessage,
          tool: {
            ...inventoryMessage.tool,
            result: { items: [{ label: 'PRIVATE DEVICE' }] },
          },
        } satisfies Message,
      ];
      const full = Reflect.apply(formatSessionFull, undefined, [session, messages, formatterPrefs]);
      const permission = Reflect.apply(formatPermissionRequest, undefined, [
        's1',
        'req_private',
        'PRIVATE TOOL NAME',
        { secret: 'PRIVATE TOOL ARG' },
        formatterPrefs,
      ]);
      const inventory = Reflect.apply(summarizeMessagesForVoiceHuman, undefined, [
        [messages[1]],
        formatterPrefs,
      ]);

      expect(full).not.toContain('PRIVATE SESSION SUMMARY');
      expect(full).not.toContain('/Users/alice/Company/PrivateProject');
      expect(full).not.toContain('PRIVATE RECENT MESSAGE');
      expect(full).not.toContain('PRIVATE DEVICE');
      expect(permission).not.toContain('PRIVATE TOOL NAME');
      expect(permission).not.toContain('PRIVATE TOOL ARG');
      expect(inventory ?? '').not.toContain('PRIVATE DEVICE');
    },
  );

  it('prefers visible lookup session metadata over stale raw session metadata when formatting the full session', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s1: {
          id: 's1',
          seq: 0,
          createdAt: 0,
          updatedAt: 1,
          active: true,
          activeAt: 0,
          metadata: {
            path: '/Users/alice/Company/RawRepo',
            host: 'localhost',
            summary: { text: 'Raw session summary', updatedAt: 0 },
          },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          thinking: false,
          thinkingAt: 0,
          presence: 'online',
        },
      },
      sessionListRenderables: {
        s1: {
          id: 's1',
          updatedAt: 99,
          metadata: {
            path: '/Users/alice/Company/LookupRepo',
            host: 'localhost',
            summary: { text: 'Lookup session summary', updatedAt: 0 },
          },
        },
      },
      sessionListIndexByServerId: {
        'active-server': [
          {
            type: 'session',
            sessionId: 's1',
            serverId: 'active-server',
            serverName: 'Active',
          },
        ],
      },
    }));

    const out = formatSessionFull(
      {
        id: 's1',
        seq: 0,
        createdAt: 0,
        updatedAt: 1,
        active: true,
        activeAt: 0,
        metadata: {
          path: '/Users/alice/Company/RawRepo',
          host: 'localhost',
          summary: { text: 'Raw session summary', updatedAt: 0 },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
      } as Session,
      [],
      prefs({}),
    );

    expect(out).toContain('Lookup session summary');
    expect(out).toContain('/Users/alice/Company/LookupRepo');
    expect(out).not.toContain('Raw session summary');
    expect(out).not.toContain('/Users/alice/Company/RawRepo');
  });

  it('includes canonical owner project paths when sharing is explicitly enabled', () => {
    const session = createSession('/shared/private-lookalike');
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s1: {
          ...session,
          metadataLayoutVersion: 1,
          ownerMetadataView: {
            path: '/Users/alice/Company/SecretRepo',
          },
        },
      },
    }));

    const out = formatSessionFull(
      session,
      [],
      prefs({}),
    );

    expect(out).toContain('/Users/alice/Company/SecretRepo');
    expect(out).not.toContain('/shared/private-lookalike');
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

  it.each([
    ['online', formatSessionOnline],
    ['offline', formatSessionOffline],
    ['focus', formatSessionFocus],
  ] as const)('applies real summary and path prefs to the %s session label', (_name, formatter) => {
    const out = formatter(
      's_private',
      {
        summary: { text: 'PRIVATE STATUS SUMMARY' },
        path: '/Users/alice/Company/PrivateStatusRepo',
      },
      prefs({ voiceShareSessionSummary: false, voiceShareFilePaths: false }),
    );

    expect(out).not.toContain('PRIVATE STATUS SUMMARY');
    expect(out).not.toContain('PrivateStatusRepo');
    expect(out).not.toContain('/Users/alice/Company/PrivateStatusRepo');
  });

  it('omits pending permission requests when voiceSharePermissionRequests is false', () => {
    const session = {
      ...createSession('/tmp/repo'),
      agentState: {
        requests: {
          req_secret: {
            tool: 'write',
            kind: 'permission',
            arguments: { filePath: '/tmp/private.txt', content: 'SECRET_PERMISSION_PAYLOAD' },
            createdAt: 1,
          },
        },
        completedRequests: {},
      },
    } as Session;

    const out = formatSessionFull(session, [], prefs({ voiceSharePermissionRequests: false }));

    expect(out).not.toContain('## Pending Requests');
    expect(out).not.toContain('req_secret');
    expect(out).not.toContain('SECRET_PERMISSION_PAYLOAD');
  });

  it('includes pending permission requests only with an explicit true permission-sharing preference', () => {
    const session = {
      ...createSession('/tmp/repo'),
      agentState: {
        requests: {
          req_shared: {
            tool: 'write',
            kind: 'permission',
            arguments: { filePath: '/tmp/shared.txt' },
            createdAt: 1,
          },
        },
        completedRequests: {},
      },
    } as Session;

    expect(formatSessionFull(session, [], prefs({ voiceSharePermissionRequests: true })))
      .toContain('<request_id>req_shared</request_id>');
    expect(formatSessionFull(session, []))
      .not.toContain('<request_id>req_shared</request_id>');
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
    } as Message, prefs({}));

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
    ], prefs({}));

    expect(summary).toContain('Invalid review output (expected strict JSON).');
    expect(summary).toContain('failed');
  });

  it('omits immediate tool-result summaries when tool-name sharing is disabled', () => {
    const summary = summarizeMessagesForVoiceHuman([
      {
        kind: 'tool-call',
        id: 'm_private_tool',
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
          result: { status: 'failed', summary: 'PRIVATE TOOL SUMMARY' },
        },
      } as Message,
    ], prefs({ voiceShareToolNames: false }));

    expect(summary).toBeNull();
  });

  it('applies summary privacy to immediate tool-result aliases', () => {
    const summary = summarizeMessagesForVoiceHuman([
      {
        kind: 'tool-call',
        id: 'm_private_session_tool',
        localId: null,
        createdAt: 3,
        children: [],
        tool: {
          name: 'listSessions',
          state: 'completed',
          input: {},
          createdAt: 3,
          startedAt: 3,
          completedAt: 4,
          description: null,
          result: { ok: true, sessions: [{ id: 's1', label: 'PRIVATE SESSION ALIAS' }] },
        },
      } as Message,
    ], prefs({ voiceShareSessionSummary: false }));

    expect(summary).toBeNull();
  });

  it('omits immediate inventory summaries when device-inventory sharing is disabled', () => {
    const summary = summarizeMessagesForVoiceHuman([
      {
        kind: 'tool-call',
        id: 'm_private_inventory',
        localId: null,
        createdAt: 3,
        children: [],
        tool: {
          name: 'listMachines',
          state: 'completed',
          input: {},
          createdAt: 3,
          startedAt: 3,
          completedAt: 4,
          description: null,
          result: { ok: true, items: [{ label: 'PRIVATE MACHINE' }] },
        },
      } as Message,
    ], prefs({ voiceShareDeviceInventory: false }));

    expect(summary).toBeNull();
  });

  it('omits tool names from provider-bound permission summaries and payloads', () => {
    const formatterPrefs = prefs({ voiceShareToolNames: false });
    const spoken = summarizeAgentRequestForVoiceHuman(
      'permission',
      'req_private_tool',
      'PRIVATE_TOOL_NAME',
      {},
      formatterPrefs,
    );
    const contextual = formatPermissionRequest(
      's1',
      'req_private_tool',
      'PRIVATE_TOOL_NAME',
      {},
      formatterPrefs,
    );

    expect(spoken).not.toContain('PRIVATE_TOOL_NAME');
    expect(contextual).not.toContain('PRIVATE_TOOL_NAME');
  });

  it('omits ready-event assistant text when recent-message sharing is disabled', () => {
    const out = formatReadyEvent(
      's1',
      [{ kind: 'agent-text', id: 'm_ready', localId: null, createdAt: 1, text: 'PRIVATE READY TEXT' }],
      prefs({ voiceShareRecentMessages: false }),
    );

    expect(out).not.toContain('PRIVATE READY TEXT');
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
    ], prefs({}));

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
    ], prefs({}));

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

  it('creates a short human-facing ask_user_question summary without leaking redacted payloads', () => {
    const out = summarizeAgentRequestForVoiceHuman(
      'user_action',
      'req_question',
      'ask_user_question',
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
