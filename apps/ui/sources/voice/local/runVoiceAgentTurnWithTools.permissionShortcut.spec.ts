import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamReadRequestSchema,
  ExecutionRunTurnStreamStartResponseSchema, ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import type { VoiceAssistantAction } from '@happier-dev/protocol';

import {
  getStorage,
  installLocalVoiceActionHomeForTests,
  registerLocalVoiceEngineHarnessHooks,
  sessionRpcWithServerScope,
  loadLocalVoiceEngineWithCompatState,
} from './localVoiceEngine.testHarness';
const actionHome = await installLocalVoiceActionHomeForTests();
const currentToolSessionAddress = { serverId: actionHome.homes.voice!.id, sessionId: 's1' };
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const {
  runVoiceAgentTurnWithTools,
} = await import('./runVoiceAgentTurnWithTools');
afterAll(() => actionHome.dispose());

async function prepareActualAgent(replies: ReadonlyArray<Readonly<{
  assistantText: string; actions: VoiceAssistantAction[];
}>>, onRead?: () => void) {
  const storage = await getStorage();
  const state = storage.getState();
  const config = readLocalConversationVoiceSettings(state.settings.voice);
  storage.__setState({ settings: { ...state.settings, voice: { ...state.settings.voice,
    providerId: 'local_conversation', providers: { ...state.settings.voice.providers,
      local_conversation: { schemaVersion: 1, config: { ...config, conversationMode: 'agent',
        agent: { ...config.agent, prewarmOnConnect: false }, tts: { ...config.tts, autoSpeakReplies: false } } } } } } });
  const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
  await voiceSessionBindingManager.ensureBound({ adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, requestedTargetSessionId: 's1' });
  const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
  await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
  const incumbent = sessionRpcWithServerScope.getMockImplementation();
  const wireTurns: Array<ReturnType<typeof ExecutionRunTurnStreamStartV2RequestSchema.parse>> = [];
  const streams = new Map<string, (typeof replies)[number]>();
  sessionRpcWithServerScope.mockClear();
  sessionRpcWithServerScope.mockImplementation(async request => {
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
      wireTurns.push(ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload));
      const streamId = `permission-turn-${wireTurns.length}`;
      const reply = replies[wireTurns.length - 1];
      if (!reply) throw new Error('Unexpected additional provider turn');
      streams.set(streamId, reply);
      return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
    }
    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
      const input = ExecutionRunTurnStreamReadRequestSchema.parse(request.payload);
      const reply = streams.get(input.streamId);
      if (!reply) throw new Error('Unknown permission stream');
      onRead?.();
      return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: input.streamId,
        events: [{ t: 'done', ...reply }], nextCursor: 1, done: true });
    }
    if (!incumbent) throw new Error('Missing genuine daemon Socket boundary');
    return incumbent(request);
  });
  return { voiceAgentSessions, wireTurns };
}

function expectOnlyOrdinaryTurnRpc() {
  for (const [request] of sessionRpcWithServerScope.mock.calls) {
    expect([SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL]).toContain(request.method);
  }
}

describe('runVoiceAgentTurnWithTools permission shortcuts', () => {
  registerLocalVoiceEngineHarnessHooks();
  beforeEach(async () => {
    // The preceding canonical teardown withdraws adapter registrations.
    await loadLocalVoiceEngineWithCompatState();
  });
  afterEach(async () => {
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    // Retire the actual Account-captured client before the Home is disconnected.
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

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
          metadata: { ...storage.getState().sessions.s1?.metadata, path: '/tmp/project-a', host: 'test-machine' },
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

    const { voiceAgentSessions, wireTurns } = await prepareActualAgent([{
      assistantText: 'The coding session needs permission. Should I approve or deny it?',
      actions: [],
    }]);

    const result = await runVoiceAgentTurnWithTools({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      userText: 'Describe the pending permission request and ask me to approve or deny it.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions,
    });

    expect(wireTurns).toHaveLength(1);
    expectOnlyOrdinaryTurnRpc();
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
          metadata: { ...storage.getState().sessions.s1?.metadata, path: '/tmp/project-a', host: 'test-machine' },
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

    const { voiceAgentSessions, wireTurns } = await prepareActualAgent([{
      assistantText: 'Use the permission approval control in the session.',
      actions: [],
    }]);

    const result = await runVoiceAgentTurnWithTools({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      userText: 'Approve the pending write permission request.',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions,
    });

    expect(wireTurns).toHaveLength(1);
    expectOnlyOrdinaryTurnRpc();
    expect(result.totalActions).toBe(0);
    expect(result.assistantTurns).toEqual(['Use the permission approval control in the session.']);
  });

  it('rejects a forbidden permission action at the actual daemon wire parser while preserving the pending request', async () => {
    const storage = await getStorage();
    const state = storage.getState();
    const config = readLocalConversationVoiceSettings(state.settings.voice);
    const target = state.sessions.s1;
    if (!target) throw new Error('Expected canonical target Session');
    storage.__setState({
      settings: { ...state.settings, voice: { ...state.settings.voice,
        providerId: 'local_conversation', providers: { ...state.settings.voice.providers,
          local_conversation: { schemaVersion: 1, config: { ...config, conversationMode: 'agent',
            agent: { ...config.agent, prewarmOnConnect: false } } } } } },
      sessions: { ...state.sessions, s1: { ...target, agentState: {
        controlledByUser: null, completedRequests: {}, requests: {
          permission_wire_refusal: { id: 'permission_wire_refusal', tool: 'write',
            arguments: { filePath: '/tmp/must-remain-pending.txt', content: 'not admitted' }, createdAt: 1 },
        },
      } } },
    });
    const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
    await voiceSessionBindingManager.ensureBound({ adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, requestedTargetSessionId: 's1' });
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
    const pendingRequest = structuredClone(storage.getState().sessions.s1?.agentState?.requests?.permission_wire_refusal);
    expect(pendingRequest).toBeDefined();
    const incumbent = sessionRpcWithServerScope.getMockImplementation();
    sessionRpcWithServerScope.mockClear();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        // Deliberately malformed external daemon output: the real client,
        // not a fixture policy, must reject this retired Voice action.
        return { streamId: 'stream-1', events: [{ t: 'done', assistantText: '',
          actions: [{ t: 'processPermissionRequest', args: { decision: 'allow' } }] }],
          nextCursor: 1, done: true };
      }
      if (!incumbent) throw new Error('Missing genuine daemon Socket boundary');
      return incumbent(request);
    });
    await expect(runVoiceAgentTurnWithTools({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      userText: 'Approve it.', durableLocalId: 'permission-wire-refusal',
      currentToolSessionAddress, voiceAgentSessions,
    })).rejects.toThrow('invalid_rpc_response');
    expect(storage.getState().sessions.s1?.agentState?.requests?.permission_wire_refusal).toEqual(pendingRequest);
    expect(sessionRpcWithServerScope.mock.calls.map(([request]) => request.method)).toEqual([
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
      SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
    ]);
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
          metadata: { ...storage.getState().sessions.s1?.metadata, path: '/tmp/project-a', host: 'test-machine' },
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

    const controller = new AbortController();
    const accepted = vi.fn();
    const assistant = vi.fn();
    const { voiceAgentSessions, wireTurns } = await prepareActualAgent([
      { assistantText: 'Review this request in the session.', actions: [] },
    ], () => { if (cancel) controller.abort(); });

    const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
    const tools = createVoiceToolHandlers({ currentSessionAddress: currentToolSessionAddress, resolveSessionId: () => 's1' });
    const proposal = JSON.parse(await tools.answerUserActionRequest({ decision: 'reject', currentSessionOnly: true }, {
      serverId: currentToolSessionAddress.serverId, effectId: 'question-answer-proposal',
    }));
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, kind: 'approval_request_created', artifactId: expect.any(String) });
    storage.__setState({ settings: { ...storage.getState().settings,
      voice: { ...storage.getState().settings.voice, canApproveRequests: false } } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor();
    expect(storage.getState().settings.voice.canApproveRequests).toBe(false);
    expect(await executor.execute('approval.request.decide', { artifactId: proposal.artifactId, decision: 'approve' }, {
      surface: 'voice', serverId: currentToolSessionAddress.serverId,
    })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await executor.execute('approval.request.get', { artifactId: proposal.artifactId }, {
      surface: 'ui', serverId: currentToolSessionAddress.serverId,
    })).toMatchObject({ ok: true, result: { request: { status: 'open', actionId: 'session.user_action.answer' } } });

    const pendingRequest = structuredClone(storage.getState().sessions.s1?.agentState?.requests?.req_question);
    expect(pendingRequest).toBeDefined();
    const turn = runVoiceAgentTurnWithTools({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      userText,
      durableLocalId: ' opaque-permission-id ',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions,
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
    expect(storage.getState().sessions.s1?.agentState?.requests?.req_question).toEqual(pendingRequest);
    expectOnlyOrdinaryTurnRpc();
    expect(wireTurns).toHaveLength(1);
    expect(wireTurns[0]).toMatchObject({ displayMessage: userText,
      userTranscript: { mode: 'suppress', localId: ' opaque-permission-id ' } });
    expect(accepted).toHaveBeenCalledTimes(1);
  });
});
