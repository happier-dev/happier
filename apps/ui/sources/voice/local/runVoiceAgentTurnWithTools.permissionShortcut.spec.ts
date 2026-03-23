import { describe, expect, it, vi } from 'vitest';

import {
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  sessionRpcWithServerScope,
} from './localVoiceEngine.testHarness';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

describe('runVoiceAgentTurnWithTools permission shortcuts', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('does not treat neutral approve-or-deny wording as a deny command', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
      sessionMessages: {
        ...storage.getState().sessionMessages,
        s1: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_1',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_1',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-test.txt', content: 'hello' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_1',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
      },
      sessionListViewDataByServerId: {
        'server-a': [
          {
            type: 'session',
            serverId: 'server-a',
            session: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        ],
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'The coding session needs permission. Should I approve or deny it?',
      actions: [],
    }));

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Describe the pending permission request and ask me to approve or deny it.',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['The coding session needs permission. Should I approve or deny it?']);
  });

  it('handles a direct approval utterance deterministically when there is a single pending permission request', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
      sessionMessages: {
        ...storage.getState().sessionMessages,
        s1: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_1',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_1',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-test.txt', content: 'hello' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_1',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
      },
      sessionListViewDataByServerId: {
        'server-a': [
          {
            type: 'session',
            serverId: 'server-a',
            session: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        ],
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'model fallback should not run',
      actions: [],
    }));

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request.',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn },
    });

    expect(sendTurn).not.toHaveBeenCalled();
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: 'permission',
        payload: { id: 'perm_voice_1', approved: true },
      }),
    );
    expect(result.totalActions).toBe(1);
    expect(result.assistantTurns).toEqual(['Approved the pending permission request.']);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'processPermissionRequest',
      result: { ok: true, status: 'done', sessionId: 's1', requestId: 'perm_voice_1' },
    });
  });

  it('falls back to answering a permission-labeled AskUserQuestion when no true permission request exists', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: {
            controlledByUser: null,
            requests: {
              req_question: {
                id: 'req_question',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: {
                  questions: [
                    {
                      question: 'May I create QA_DENY_PATH.txt?',
                      header: 'Permission',
                      options: [
                        { label: 'Yes, create it', description: 'Create the file' },
                        { label: `No, don't create it`, description: 'Skip file creation' },
                      ],
                      multiSelect: false,
                    },
                  ],
                },
                createdAt: 1,
              },
            },
            completedRequests: {},
          },
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
      sessionListViewDataByServerId: {
        'server-a': [
          {
            type: 'session',
            serverId: 'server-a',
            session: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        ],
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'model fallback should not run',
      actions: [],
    }));

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Deny the pending permission request.',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn },
    });

    expect(sendTurn).not.toHaveBeenCalled();
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: 'permission',
        payload: {
          id: 'req_question',
          approved: false,
          answers: { 'May I create QA_DENY_PATH.txt?': `No, don't create it` },
        },
      }),
    );
    expect(result.totalActions).toBe(1);
    expect(result.assistantTurns).toEqual(['Denied the pending request.']);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'answerUserActionRequest',
      result: { ok: true, status: 'done', sessionId: 's1', requestId: 'req_question' },
    });
  });

  it('keeps direct permission shortcuts bound to currentToolSessionId even when the global voice target store is stale', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
        s_stale: {
          id: 's_stale',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-b', host: 'test-machine' },
        },
      },
      sessionMessages: {
        ...storage.getState().sessionMessages,
        s1: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_target',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_target',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-test.txt', content: 'hello' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_target',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
        s_stale: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_stale',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_stale',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-stale.txt', content: 'stale' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_stale',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
      },
      sessionListViewDataByServerId: {
        'server-a': [
          {
            type: 'session',
            serverId: 'server-a',
            session: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
          {
            type: 'session',
            serverId: 'server-a',
            session: {
              id: 's_stale',
              presence: 'online',
              active: true,
            },
          },
        ],
      },
    });

    useVoiceTargetStore.setState({
      scope: 'global',
      primaryActionSessionId: 's_stale',
      lastFocusedSessionId: null,
    } as any);

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'model fallback should not run',
      actions: [],
    }));

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request.',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn },
    });

    expect(sendTurn).not.toHaveBeenCalled();
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: 'permission',
        payload: { id: 'perm_voice_target', approved: true },
      }),
    );
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'processPermissionRequest',
      result: { ok: true, status: 'done', sessionId: 's1', requestId: 'perm_voice_target' },
    });
  });

  it('requires disambiguation instead of approving a request from another session', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
      },
      sessions: {
        ...storage.getState().sessions,
        sys_voice: {
          id: 'sys_voice',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/voice-home', host: 'test-machine' },
        },
        s_other: {
          id: 's_other',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-other', host: 'test-machine' },
        },
      },
      sessionMessages: {
        ...storage.getState().sessionMessages,
        sys_voice: { messages: [] },
        s_other: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_other',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_other',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-other.txt', content: 'hello' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_other',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
      },
      sessionListViewDataByServerId: {
        'server-a': [
          { type: 'session', serverId: 'server-a', session: { id: 'sys_voice', presence: 'online', active: true } },
          { type: 'session', serverId: 'server-a', session: { id: 's_other', presence: 'online', active: true } },
        ],
      },
    });

    const sendTurn = vi.fn(async () => ({
      assistantText: 'model fallback should not run',
      actions: [],
    }));

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request.',
      currentToolSessionId: 'sys_voice',
      voiceAgentSessions: { sendTurn },
    });

    expect(sendTurn).not.toHaveBeenCalled();
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns[0]).toContain('current session');
  });

  it('does not treat compound approval requests as direct shortcuts', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
      sessionMessages: {
        ...storage.getState().sessionMessages,
        s1: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_1',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_1',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-test.txt', content: 'hello' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_1',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
      },
      sessionListViewDataByServerId: {
        'server-a': [
          {
            type: 'session',
            serverId: 'server-a',
            session: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        ],
      },
    });

    const sendTurn = vi.fn(async () => ({
      assistantText: 'I approved it and summarized the request.',
      actions: [],
    }));

    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request and then summarize it.',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['I approved it and summarized the request.']);
  });
});
