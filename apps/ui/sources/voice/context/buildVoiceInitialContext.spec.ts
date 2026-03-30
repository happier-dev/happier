import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import { buildVoiceInitialContext } from './buildVoiceInitialContext';

function createSession(summaryText: string): Session {
  return {
    id: 's1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: {
      path: '/tmp/project',
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

function createUserMessage(text: string): Message {
  return {
    kind: 'user-text',
    id: 'm1',
    localId: null,
    createdAt: 1,
    text,
  };
}

describe('buildVoiceInitialContext', () => {
  beforeEach(() => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...settingsDefaults,
        voice: {
          ...settingsDefaults.voice,
          ui: {
            ...settingsDefaults.voice.ui,
            updates: {
              ...settingsDefaults.voice.ui.updates,
              activeSession: 'snippets',
              otherSessions: 'activity',
            },
          },
        },
      },
      sessions: { s1: createSession('Summary visible only for tracked sessions') },
      sessionMessages: { s1: { messages: [createUserMessage('Recent context')] } },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds([]);
  });

  it('respects other-session policy when the session is not tracked', () => {
    const out = buildVoiceInitialContext('s1');

    expect(out).toContain('THIS IS AN ACTIVE SESSION:');
    expect(out).toContain('# Session:');
    expect(out).not.toContain('# Session: Summary visible only for tracked sessions');
    expect(out).not.toContain('Summary visible only for tracked sessions');
    expect(out).not.toContain('# Session ID: s1');
    expect(out).not.toContain('## Session Summary');
    expect(out).not.toContain('Recent messages in session');
    expect(out).not.toContain('Recent context');
  });

  it('includes summary and recent messages when the session is tracked', () => {
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const out = buildVoiceInitialContext('s1');

    expect(out).toContain('## Session Summary');
    expect(out).toContain('Summary visible only for tracked sessions');
    expect(out).toContain('## Recent Messages');
    expect(out).toContain('Recent messages in');
    expect(out).toContain('Recent context');
  });

  it('treats an explicit target session as tracked during initial bootstrap', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        hidden_voice: {
          ...createSession('Hidden voice session summary'),
          id: 'hidden_voice',
          metadata: {
            ...createSession('Hidden voice session summary').metadata,
            path: '/tmp/voice',
          },
        },
        s1: createSession('Target session summary'),
      },
      sessionMessages: {
        hidden_voice: { messages: [createUserMessage('Hidden transcript')] },
        s1: {
          messageIdsOldestFirst: ['m1'],
          messagesById: { m1: createUserMessage('Target transcript') },
          messagesMap: { m1: createUserMessage('Target transcript') },
        },
      },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds([]);

    const out = buildVoiceInitialContext('hidden_voice', { targetSessionId: 's1' });

    expect(out).toContain('THIS IS THE CURRENT TARGET SESSION:');
    expect(out).toContain('## Session Summary');
    expect(out).toContain('# Session: Target session summary');
    expect(out).not.toContain('# Session ID: s1');
    expect(out).toContain('Target session summary');
    expect(out).toContain('Target transcript');
    expect(out).not.toContain('Hidden voice session summary');
    expect(out).not.toContain('Hidden transcript');
  });

  it('includes already-pending user-action requests from the current target session', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        hidden_voice: {
          ...createSession('Hidden voice session summary'),
          id: 'hidden_voice',
          metadata: {
            ...createSession('Hidden voice session summary').metadata,
            path: '/tmp/voice',
          },
        },
        s1: {
          ...createSession('Target session summary'),
          agentState: {
            requests: {
              req_question: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: {
                  questions: [
                    {
                      header: 'What',
                      question: 'What do you want me to work on in this repo?',
                      options: [
                        { label: 'Implement a feature', description: 'Build new functionality' },
                        { label: 'Review code changes', description: 'Inspect a diff' },
                      ],
                    },
                  ],
                },
                createdAt: 1,
              },
            },
            completedRequests: {},
          },
        },
      },
      sessionMessages: {
        hidden_voice: { messages: [createUserMessage('Hidden transcript')] },
        s1: { messages: [createUserMessage('Target transcript')] },
      },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const out = buildVoiceInitialContext('hidden_voice', { targetSessionId: 's1' });

    expect(out).toContain('## Pending Requests');
    expect(out).toContain('Coding assistant needs user input to continue');
    expect(out).not.toContain('(session s1)');
    expect(out).toContain('What do you want me to work on in this repo?');
    expect(out).toContain('Reply with answerUserActionRequest');
  });

  it('includes already-pending permission requests from transcript tool calls when agentState is missing', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        hidden_voice: {
          ...createSession('Hidden voice session summary'),
          id: 'hidden_voice',
          metadata: {
            ...createSession('Hidden voice session summary').metadata,
            path: '/tmp/voice',
          },
        },
        s1: {
          ...createSession('Target session summary'),
          agentState: null,
        },
      },
      sessionMessages: {
        hidden_voice: { messages: [createUserMessage('Hidden transcript')] },
        s1: {
          messages: [
            createUserMessage('Target transcript'),
            {
              kind: 'tool-call',
              id: 'tool_perm_1',
              localId: null,
              createdAt: 2,
              children: [],
              tool: {
                id: 'tool_perm_1',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-test.txt', content: 'hello' },
                createdAt: 2,
                startedAt: 2,
                completedAt: 3,
                result: {},
                permission: {
                  id: 'perm_voice_1',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            } as any,
          ],
        },
      },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const out = buildVoiceInitialContext('hidden_voice', { targetSessionId: 's1' });

    expect(out).toContain('## Pending Requests');
    expect(out).toContain('Coding assistant is requesting permission to use write in');
    expect(out).toContain('<request_id>perm_voice_1</request_id>');
    expect(out).toContain('Ask the human to say approve or deny.');
  });

  it('includes already-pending user-action requests from transcript tool calls when agentState is missing', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        hidden_voice: {
          ...createSession('Hidden voice session summary'),
          id: 'hidden_voice',
          metadata: {
            ...createSession('Hidden voice session summary').metadata,
            path: '/tmp/voice',
          },
        },
        s1: {
          ...createSession('Target session summary'),
          agentState: null,
        },
      },
      sessionMessages: {
        hidden_voice: { messages: [createUserMessage('Hidden transcript')] },
        s1: {
          messages: [
            createUserMessage('Target transcript'),
            {
              kind: 'tool-call',
              id: 'tool_question_1',
              localId: null,
              createdAt: 2,
              children: [],
              tool: {
                id: 'tool_question_1',
                name: 'AskUserQuestion',
                description: 'Ask the user a question',
                state: 'completed',
                input: {
                  questions: [
                    {
                      header: 'What',
                      question: 'What should I work on next?',
                      options: [{ label: 'Fix bugs', description: 'Resolve current issues' }],
                    },
                  ],
                },
                createdAt: 2,
                startedAt: 2,
                completedAt: 3,
                result: {},
                permission: {
                  id: 'ua_voice_1',
                  kind: 'user_action',
                  status: 'pending',
                },
              },
            } as any,
          ],
        },
      },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const out = buildVoiceInitialContext('hidden_voice', { targetSessionId: 's1' });

    expect(out).toContain('## Pending Requests');
    expect(out).toContain('Coding assistant needs user input to continue in');
    expect(out).toContain('What should I work on next?');
    expect(out).toContain('Reply with answerUserActionRequest');
  });

  it('omits pending requests entirely when the target session is inactive', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        hidden_voice: {
          ...createSession('Hidden voice session summary'),
          id: 'hidden_voice',
          metadata: {
            ...createSession('Hidden voice session summary').metadata,
            path: '/tmp/voice',
          },
        },
        s1: {
          ...createSession('Target session summary'),
          active: false,
          agentState: {
            requests: {
              req_inactive: {
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: 'pwd' },
                createdAt: 1,
              },
            },
            completedRequests: {},
          },
        },
      },
      sessionMessages: {
        hidden_voice: { messages: [createUserMessage('Hidden transcript')] },
        s1: {
          messages: [
            createUserMessage('Target transcript'),
            {
              kind: 'tool-call',
              id: 'tool_inactive_1',
              localId: null,
              createdAt: 2,
              children: [],
              tool: {
                id: 'tool_inactive_1',
                name: 'Bash',
                description: 'Run a shell command',
                state: 'running',
                input: { command: 'pwd' },
                createdAt: 2,
                startedAt: 2,
                completedAt: null,
                result: null,
                permission: {
                  id: 'req_inactive',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            } as any,
          ],
        },
      },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const out = buildVoiceInitialContext('hidden_voice', { targetSessionId: 's1' });

    expect(out).not.toContain('## Pending Requests');
    expect(out).not.toContain('<request_id>req_inactive</request_id>');
    expect(out).not.toContain('Ask the human to say approve or deny.');
    expect(out).toContain('# Session: Target session summary');
  });

  it('fails closed for file paths when shareFilePaths is omitted from voice privacy settings', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ui: state.settings.voice.ui,
          privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 3,
            shareToolNames: true,
          },
          adapters: state.settings.voice.adapters,
        },
      },
      sessions: {
        s1: createSession('Summary mentions /Users/alice/SecretRepo/src/index.ts'),
      },
      sessionMessages: {
        s1: {
          messages: [createUserMessage('Look at /Users/alice/SecretRepo/src/index.ts')],
        },
      },
    }));
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const out = buildVoiceInitialContext('s1');

    expect(out).not.toContain('/Users/alice/SecretRepo/src/index.ts');
    expect(out).toContain('Recent messages in');
  });
});
