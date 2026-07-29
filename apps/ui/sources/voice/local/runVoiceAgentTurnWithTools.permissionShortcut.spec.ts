import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  sessionRpcWithServerScope,
} from './localVoiceEngine.testHarness';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { runVoiceAgentTurnWithTools } from './runVoiceAgentTurnWithTools';

describe('runVoiceAgentTurnWithTools permission shortcuts', () => {
  // This owner is stateless; retaining its module graph avoids charging the
  // large shared Voice harness import to every individual permission assertion.
  registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });

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
      concurrentSessionListCacheByServerId: {
        'server-a': {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        },
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'The coding session needs permission. Should I approve or deny it?',
      actions: [],
    }));

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Describe the pending permission request and ask me to approve or deny it.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['The coding session needs permission. Should I approve or deny it?']);
  });

  it('never turns a spoken approval utterance into a permission response', async () => {
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
      concurrentSessionListCacheByServerId: {
        'server-a': {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        },
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'Use the permission approval control in the session.',
      actions: [],
    }));

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['Use the permission approval control in the session.']);
  });

  it('rejects a model-generated permission response action without calling the permission RPC', async () => {
    const sendTurn = vi.fn()
      .mockResolvedValueOnce({
        assistantText: '',
        actions: [{ t: 'processPermissionRequest', args: { decision: 'allow' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Use the permission approval control in the session.',
        actions: [],
      });

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve it.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'processPermissionRequest',
      result: { ok: false, errorCode: 'tool_not_supported' },
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
      concurrentSessionListCacheByServerId: {
        'server-a': {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        },
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const sendTurn = vi.fn(async () => ({
      assistantText: 'model fallback should not run',
      actions: [],
    }));
    const commitUserTranscript = vi.fn(async () => {});

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Deny the pending permission request.',
      durableLocalId: ' opaque-permission-id ',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn, commitUserTranscript },
    });

    expect(sendTurn).not.toHaveBeenCalled();
    expect(commitUserTranscript).toHaveBeenCalledWith(
      'voice-hidden-s1',
      'Deny the pending permission request.',
      ' opaque-permission-id ',
    );
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
        payload: {
          id: 'req_question',
          approved: false,
          answers: { 'May I create QA_DENY_PATH.txt?': [`No, don't create it`] },
        },
      }),
    );
    expect(commitUserTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      sessionRpcWithServerScope.mock.invocationCallOrder[0]!,
    );
    expect(result.totalActions).toBe(1);
    expect(result.assistantTurns).toEqual(['Denied the pending request.']);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'answerUserActionRequest',
      result: { ok: true, status: 'done', sessionId: 's1', requestId: 'req_question' },
    });
  });

  it('does not approve a request from another session', async () => {
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
      concurrentSessionListCacheByServerId: {
        'server-a': {
          serverName: null,
          sessions: {
            sys_voice: { id: 'sys_voice', presence: 'online', active: true },
            s_other: { id: 's_other', presence: 'online', active: true },
          },
        },
      },
    });

    const sendTurn = vi.fn(async () => ({
      assistantText: 'Open that session to review its permission request.',
      actions: [],
    }));

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 'sys_voice',
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['Open that session to review its permission request.']);
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
      concurrentSessionListCacheByServerId: {
        'server-a': {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
              presence: 'online',
              active: true,
            },
          },
        },
      },
    });

    const sendTurn = vi.fn(async () => ({
      assistantText: 'I approved it and summarized the request.',
      actions: [],
    }));

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText: 'Approve the pending write permission request and then summarize it.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['I approved it and summarized the request.']);
  });
});
