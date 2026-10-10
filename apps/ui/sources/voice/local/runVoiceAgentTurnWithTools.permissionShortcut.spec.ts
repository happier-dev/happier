import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceAgentSendTurnOptions } from '@/voice/agent/types';

import {
  getStorage,
  installLocalVoiceActionHomeForTests,
  registerLocalVoiceEngineHarnessHooks,
  sessionRpcWithServerScope,
} from './localVoiceEngine.testHarness';
const actionHome = await installLocalVoiceActionHomeForTests();
const currentToolSessionAddress = { serverId: actionHome.homes.voice!.id, sessionId: 's1' };
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const {
  runVoiceAgentTurnWithTools,
} = await import('./runVoiceAgentTurnWithTools');
afterAll(() => actionHome.dispose());

describe('runVoiceAgentTurnWithTools permission shortcuts', () => {
  // This owner is stateless; retaining its module graph avoids charging the
  // large shared Voice harness import to every individual permission assertion.
  registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });
  beforeEach(() => actionHome.restore());

  it('does not treat neutral approve-or-deny wording as a deny command', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        experiments: true,
        featureToggles: {
          ...storage.getState().settings.featureToggles,
          voice: true,
          'execution.runs': true,
        },
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          serverId: currentToolSessionAddress.serverId,
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
        [currentToolSessionAddress.serverId]: {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
          serverId: currentToolSessionAddress.serverId,
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
      currentToolSessionId: 's1', currentToolSessionAddress,
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
          serverId: currentToolSessionAddress.serverId,
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
        [currentToolSessionAddress.serverId]: {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
          serverId: currentToolSessionAddress.serverId,
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
      currentToolSessionId: 's1', currentToolSessionAddress,
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
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'processPermissionRequest',
      result: { ok: false, errorCode: 'tool_not_supported' },
    });
  });

  it.each([
    { userText: 'yes', cancel: false },
    { userText: 'Deny the pending permission request.', cancel: false },
    { userText: 'Deny the pending permission request.', cancel: true },
  ])('keeps the request pending with one ordinary transcript for "$userText" (cancel=$cancel)', async ({ userText, cancel }) => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        experiments: true,
        featureToggles: {
          ...storage.getState().settings.featureToggles,
          voice: true,
          'execution.runs': true,
        },
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          serverId: currentToolSessionAddress.serverId,
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
        [currentToolSessionAddress.serverId]: {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
          serverId: currentToolSessionAddress.serverId,
              presence: 'online',
              active: true,
            },
          },
        },
      },
    });

    sessionRpcWithServerScope.mockResolvedValue({ ok: true });
    const controller = new AbortController();
    const committed: Array<Readonly<{ text: string; localId: string }>> = [];
    const accepted = vi.fn();
    const assistant = vi.fn();
    // sendTurn is the daemon/provider boundary; model the daemon's persist directive,
    // leaving local orchestration and the shared request refusal real.
    const sendTurn = vi.fn(async (_sessionId: string, text: string, opts?: VoiceAgentSendTurnOptions) => {
      if (opts?.userTranscript?.mode === 'persist') {
        committed.push({ text, localId: opts.userTranscript.localId });
        await opts.onUserTranscriptAccepted?.();
      }
      if (cancel) controller.abort();
      return { assistantText: 'Review this request in the session.', actions: [] };
    });
    const commitUserTranscript = vi.fn(async () => {});

    const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
    const tools = createVoiceToolHandlers({ currentSessionAddress: currentToolSessionAddress, resolveSessionId: () => 's1' });
    const refusal = await tools.answerUserActionRequest({ decision: 'reject', currentSessionOnly: true });
    expect(JSON.parse(refusal), refusal).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question' });

    const pendingRequest = structuredClone(storage.getState().sessions.s1?.agentState?.requests.req_question);
    const turn = runVoiceAgentTurnWithTools({
      sessionId: 'voice-hidden-s1',
      userText,
      durableLocalId: ' opaque-permission-id ',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: { sendTurn, commitUserTranscript },
      signal: controller.signal,
      onUserTranscriptAccepted: accepted,
      onAssistantTurn: assistant,
    });
    if (cancel) {
      await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
      expect(assistant).not.toHaveBeenCalled();
    } else {
      const result = await turn;
      expect(result.totalActions).toBe(0);
      expect(result.assistantTurns).toEqual(['Review this request in the session.']);
      expect(result.toolResultBatches).toEqual([]);
    }
    expect(storage.getState().sessions.s1?.agentState?.requests.req_question).toEqual(pendingRequest);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(committed).toEqual([{ text: userText, localId: ' opaque-permission-id ' }]);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(commitUserTranscript).not.toHaveBeenCalled();
    expect(sendTurn).toHaveBeenCalledWith(
      'voice-hidden-s1',
      userText,
      expect.objectContaining({ userTranscript: { mode: 'persist', localId: ' opaque-permission-id ' } }),
    );
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
          serverId: currentToolSessionAddress.serverId,
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/voice-home', host: 'test-machine' },
        },
        s_other: {
          id: 's_other',
          serverId: currentToolSessionAddress.serverId,
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
        [currentToolSessionAddress.serverId]: {
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
      currentToolSessionAddress: { ...currentToolSessionAddress, sessionId: 'sys_voice' },
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
          serverId: currentToolSessionAddress.serverId,
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
        [currentToolSessionAddress.serverId]: {
          serverName: null,
          sessions: {
            s1: {
              id: 's1',
          serverId: currentToolSessionAddress.serverId,
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
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: { sendTurn, commitUserTranscript: vi.fn(async () => {}) },
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['I approved it and summarized the request.']);
  });
});
