import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';

import { resetVoiceQaStoreForTests, useVoiceQaStore } from './voiceQaStore';
import { createVoiceQaController } from './voiceQaController';

describe('voiceQaController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVoiceQaStoreForTests();
    storage.setState({
      settings: {
        ...(storage.getState() as any).settings,
        backendEnabledById: {
          claude: true,
          codex: true,
          opencode: true,
        },
      },
    } as any);
  });

  it('starts a real local voice-agent QA run through the bound hidden voice conversation when the binding is native-session backed', async () => {
    const ensureLocalRunningAndMaybeWelcome = vi.fn(async () => 'Hey! What are we working on today?');
    const ensureSessionVisibleForMessageRoute = vi.fn(async () => {});
    const refreshSessionMessages = vi.fn(async () => {});
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome,
      ensureSessionVisibleForMessageRoute,
      refreshSessionMessages,
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's1' });

    expect(ensureLocalBinding).toHaveBeenCalledWith({
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
    });
    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1');
    expect(refreshSessionMessages).toHaveBeenCalledWith('s1');
    expect(ensureLocalRunningAndMaybeWelcome).toHaveBeenCalledWith('voice-hidden-s1');
    expect(useVoiceQaStore.getState().status).toBe('running');
    expect(useVoiceQaStore.getState().entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('What are we working on'))).toBe(true);
  });

  it('records whether pending requests were detected in the target-session context during local QA start', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
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
                input: { filePath: '/tmp/voice-permission-test.txt' },
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
    } as any);

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's1' });

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('Pending requests detected in target-session context') &&
          entry.text.includes('yes'),
      ),
    ).toBe(true);
  });

  it('waits for local bootstrap before sending target-session context updates during QA start', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: {
            requests: {
              perm_1: {
                kind: 'permission',
                tool: 'WriteFile',
                arguments: { filePath: '/tmp/qa.txt' },
                createdAt: 1,
              },
            },
            completedRequests: {},
          },
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: { messages: [] },
      },
    } as any);

    let bootstrapped = false;
    const appendLocalContextUpdate = vi.fn(() => {
      if (!bootstrapped) {
        throw new Error('context_update_sent_before_bootstrap');
      }
    });
    const ensureLocalRunningAndMaybeWelcome = vi.fn(async () => {
      bootstrapped = true;
      return null;
    });

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome,
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate,
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.start({ sessionId: 's1' })).resolves.toBeDefined();
    expect(ensureLocalRunningAndMaybeWelcome).toHaveBeenCalledWith('voice-hidden-s1');
    expect(appendLocalContextUpdate).toHaveBeenCalled();
    expect(ensureLocalRunningAndMaybeWelcome.mock.invocationCallOrder[0]).toBeLessThan(
      appendLocalContextUpdate.mock.invocationCallOrder[0],
    );
  });

  it('forces a target-session refresh when the known session state is stale before building local QA context', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: { messages: [] },
      },
    } as any);

    const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh !== true) return;
      storage.setState((state: any) => ({
        ...state,
        sessions: {
          ...(state.sessions ?? {}),
          s1: {
            ...(state.sessions?.s1 ?? {}),
            agentState: {
              requests: {
                req_question: {
                  tool: 'AskUserQuestion',
                  kind: 'user_action',
                  arguments: {
                    questions: [{ question: 'Continue with local voice QA?', options: [{ label: 'Yes' }, { label: 'No' }] }],
                  },
                  createdAt: 1,
                },
              },
              completedRequests: {},
            },
          },
        },
      }));
    });

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute,
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', { forceRefresh: true });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('Pending requests detected in target-session context') &&
          entry.text.includes('yes'),
      ),
    ).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('Pending request breakdown:') &&
          entry.text.includes('user_action=1(req_question)') &&
          entry.text.includes('permission=0(none)') &&
          entry.text.includes('transcript=0(none)'),
      ),
    ).toBe(true);
  });

  it('re-runs target-session message hydration after a forced visibility refresh when pending transcript requests only appear once the session becomes visible', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: { messages: [] },
      },
    } as any);

    let sessionVisible = false;
    const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh === true) {
        sessionVisible = true;
      }
    });
    const refreshSessionMessages = vi.fn(async (_sessionId: string) => {
      if (!sessionVisible) return;
      storage.setState((state: any) => ({
        ...state,
        sessionMessages: {
          ...(state.sessionMessages ?? {}),
          s1: {
            messages: [
              {
                kind: 'tool-call',
                id: 'tool_question_1',
                localId: null,
                createdAt: 1,
                children: [],
                tool: {
                  id: 'tool_question_1',
                  name: 'AskUserQuestion',
                  description: 'Ask the user a question',
                  state: 'running',
                  input: {
                    questions: [
                      {
                        header: 'Permission',
                        question: 'May I create QA_APPROVE_FRESH.txt?',
                        options: [
                          { label: 'Yes, go ahead', description: 'Create the file' },
                          { label: `No, don't create it`, description: 'Skip file creation' },
                        ],
                        multiSelect: false,
                      },
                    ],
                  },
                  createdAt: 1,
                  startedAt: 1,
                  completedAt: null,
                  result: undefined,
                  permission: {
                    id: 'req_question_transcript',
                    kind: 'user_action',
                    status: 'pending',
                  },
                },
              },
            ],
          },
        },
      }));
    });

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute,
      refreshSessionMessages,
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', { forceRefresh: true });
    expect(refreshSessionMessages).toHaveBeenCalledTimes(2);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('Pending requests detected in target-session context') &&
          entry.text.includes('yes'),
      ),
    ).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('transcript=1(req_question_transcript)'),
      ),
    ).toBe(true);
  });

  it('does not block local QA startup on a slow forced refresh for an already-online target session', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: { messages: [] },
      },
    } as any);

    let resolveForcedRefresh: (() => void) | null = null;
    const forcedRefresh = new Promise<void>((resolve) => {
      resolveForcedRefresh = resolve;
    });
    const ensureSessionVisibleForMessageRoute = vi.fn(async (_sessionId: string, options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh === true) {
        await forcedRefresh;
      }
    });
    const appendLocalContextUpdate = vi.fn();

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute,
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate,
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    const startPromise = controller.start({ sessionId: 's1' }).then(() => 'resolved');
    await expect(
      Promise.race([startPromise, new Promise((resolve) => setTimeout(() => resolve('pending'), 0))]),
    ).resolves.toBe('resolved');
    expect(useVoiceQaStore.getState().status).toBe('running');
    expect(appendLocalContextUpdate).toHaveBeenCalled();

    const releaseForcedRefresh: () => void = resolveForcedRefresh ?? (() => {
      throw new Error('Expected forced refresh resolver to be initialised');
    });
    releaseForcedRefresh();
    await startPromise;
  });

  it('keeps using the started target session for follow-up local QA prompts when the global voice target drifts', async () => {
    const getVoiceTargetState = vi
      .fn()
      .mockReturnValueOnce({ primaryActionSessionId: 's1', lastFocusedSessionId: null })
      .mockReturnValue({ primaryActionSessionId: 'voice-hidden-s1', lastFocusedSessionId: null });
    const ensureLocalBinding = vi
      .fn()
      .mockResolvedValue({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      });
    const sendLocalTurn = vi.fn(async () => ({ assistantText: 'Still targeting s1.', actions: [] }));

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState,
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start();
    await controller.sendPrompt({
      prompt: 'Summarize the pending request in the target session and ask me whether to approve or deny it.',
    });

    expect(ensureLocalBinding).toHaveBeenNthCalledWith(1, {
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
    });
    expect(ensureLocalBinding).toHaveBeenNthCalledWith(2, {
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
    });
    expect(sendLocalTurn).toHaveBeenCalledWith('voice-hidden-s1', expect.any(String), undefined);
    expect(useVoiceQaStore.getState().targetSessionId).toBe('s1');
    expect(useVoiceQaStore.getState().runtimeSessionId).toBe('voice-hidden-s1');
  });

  it('updates the QA target session after a global local-voice retarget even if the binding store lags behind', async () => {
    const getVoiceTargetState = vi
      .fn()
      .mockReturnValueOnce({ primaryActionSessionId: 's1', lastFocusedSessionId: null })
      .mockReturnValue({ primaryActionSessionId: 'session_matrix', lastFocusedSessionId: null });
    const binding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: null,
      updatedAt: 1,
    };
    const ensureLocalBinding = vi.fn(async () => binding);
    const getLocalBinding = vi.fn(() => binding);
    const sendLocalTurn = vi.fn(async () => ({ assistantText: 'Retargeted.', actions: [] }));

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState,
      ensureLocalBinding,
      getLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start();
    await controller.sendPrompt({
      prompt: 'Switch to Session QA Voice Matrix.',
      autoStart: false,
    });

    expect(useVoiceQaStore.getState().targetSessionId).toBe('session_matrix');
    expect(useVoiceQaStore.getState().runtimeSessionId).toBe('voice-hidden-s1');
  });

  it('ignores a hidden voice conversation session when resolving the next default local QA target', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        'voice-hidden-s1': {
          id: 'voice-hidden-s1',
          active: true,
          updatedAt: 5,
          metadata: {
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            summary: { text: 'Voice conversation (system)' },
          },
        },
      },
    } as any);

    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s2',
      transcriptMode: 'native_session' as const,
      targetSessionId: null,
      updatedAt: 1,
    }));

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: null, lastFocusedSessionId: 'voice-hidden-s1' }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'Ready.', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start();

    expect(ensureLocalBinding).toHaveBeenCalledWith({
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: null,
    });
    expect(useVoiceQaStore.getState().targetSessionId).toBe('__voice_agent__');
  });

  it('warns when the target session permission mode will auto-deny write-like actions', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          permissionMode: 'read-only',
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: { messages: [] },
      },
    } as any);

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's1' });

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('permission mode is Read Only') &&
          entry.text.includes('auto-deny'),
      ),
    ).toBe(true);
  });

  it('sends text prompts through the bound hidden voice conversation for native-session local voice agent bindings, executes tool rounds, and appends the follow-up answer', async () => {
    const sendLocalTurn = vi.fn(async (_sessionId: string, prompt: string) => {
      if (prompt.startsWith('VOICE_TOOL_RESULTS_JSON:')) {
        return {
          assistantText: 'Available backends: claude, codex, opencode.',
          actions: [],
        };
      }

      return {
        assistantText: 'I checked the tools.',
        actions: [{ t: 'listAgentBackends', args: {} }],
      };
    });
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.sendPrompt({ sessionId: 's1', prompt: 'List the available backends.' });

    expect(ensureLocalBinding).toHaveBeenCalledWith({
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
    });
    expect(sendLocalTurn).toHaveBeenNthCalledWith(1, 'voice-hidden-s1', 'List the available backends.', undefined);
    expect(sendLocalTurn).toHaveBeenNthCalledWith(
      2,
      'voice-hidden-s1',
      expect.stringContaining('VOICE_TOOL_RESULTS_JSON:'),
      undefined,
    );
    expect(useVoiceQaStore.getState().entries.some((entry) => entry.kind === 'user' && entry.text.includes('List the available backends.'))).toBe(true);
    expect(useVoiceQaStore.getState().entries.some((entry) => entry.kind === 'assistant' && entry.text === 'I checked the tools.')).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) => entry.kind === 'assistant' && entry.text === 'Available backends: claude, codex, opencode.',
      ),
    ).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('1 action') &&
          entry.text.includes('listAgentBackends') &&
          entry.text.includes('ok'),
      ),
    ).toBe(true);
  });

  it('tracks the rebound target session after a global local QA turn changes the binding', async () => {
    let currentBinding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-home-hidden',
      transcriptMode: 'native_session' as const,
      targetSessionId: null as string | null,
      updatedAt: 1,
    };
    const ensureLocalBinding = vi.fn(async () => currentBinding);
    const sendLocalTurn = vi.fn(async () => {
      currentBinding = {
        ...currentBinding,
        conversationSessionId: 'voice-hidden-s1',
        targetSessionId: 's1',
        updatedAt: 2,
      };
      return { assistantText: 'Teleported.', actions: [] };
    });
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: null, lastFocusedSessionId: null }),
      ensureLocalBinding,
      getLocalBinding: () => currentBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.sendPrompt({ prompt: 'Teleport into the active coding session.' });

    expect(useVoiceQaStore.getState().targetSessionId).toBe('s1');
    expect(useVoiceQaStore.getState().runtimeSessionId).toBe('voice-hidden-s1');
    expect(sendLocalTurn).toHaveBeenCalledWith('voice-home-hidden', 'Teleport into the active coding session.', undefined);
  });

  it('surfaces failed local voice tool results in the QA transcript', async () => {
    const ensureSessionVisibleForMessageRoute = vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute').mockResolvedValue(true);
    const refreshSessionMessages = vi.spyOn(sync, 'refreshSessionMessages').mockResolvedValue();
    const sendLocalTurn = vi.fn(async (_sessionId: string, prompt: string) => {
      if (prompt.startsWith('VOICE_TOOL_RESULTS_JSON:')) {
        return {
          assistantText: 'I could not answer that request because there is no pending user-action question.',
          actions: [],
        };
      }

      return {
        assistantText: 'I will try that now.',
        actions: [
          {
            t: 'answerUserActionRequest',
            args: {
              answers: [{ question: 'What do you want me to work on in this repo?', answer: 'Implement a feature' }],
            },
          },
        ],
      };
    });
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.sendPrompt({ sessionId: 's1', prompt: 'Answer the pending question with: Implement a feature.' });

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1');
    expect(refreshSessionMessages).toHaveBeenCalledWith('s1');
    expect(sendLocalTurn).toHaveBeenNthCalledWith(
      2,
      'voice-hidden-s1',
      expect.stringContaining('VOICE_TOOL_RESULTS_JSON:'),
      undefined,
    );
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('answerUserActionRequest') &&
          entry.text.includes('no_permission_request'),
      ),
    ).toBe(true);
  });

  it('appends local send errors to the QA transcript before rethrowing', async () => {
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => {
        throw new Error('execution_run_busy');
      }),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.sendPrompt({ sessionId: 's1', prompt: 'Answer the pending question.' })).rejects.toThrow(
      'execution_run_busy',
    );

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) => entry.kind === 'error' && entry.text.includes('execution_run_busy'),
      ),
    ).toBe(true);
  });

  it('surfaces the follow-up assistant reply when a local QA turn is interrupted by a higher-priority update', async () => {
    const sendLocalTurn = vi.fn(async () => {
      throw Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
    });
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const waitForInterruptedLocalAssistantTurn = vi.fn(async () => 'A read-only permission request is pending. Should I allow or deny it?');
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn,
      qaStore: useVoiceQaStore,
    });

    await expect(
      controller.sendPrompt({
        sessionId: 's1',
        prompt: 'Ask the coding session to create a file and then ask me for permission.',
      }),
    ).resolves.toMatchObject({ assistantText: 'A read-only permission request is pending. Should I allow or deny it?' });

    expect(waitForInterruptedLocalAssistantTurn).toHaveBeenCalledWith({
      conversationSessionId: 'voice-hidden-s1',
      timeoutMs: 20_000,
      baseline: {
        baselineCount: 0,
        baselineIds: expect.any(Set),
      },
    });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) => entry.kind === 'assistant' && entry.text === 'A read-only permission request is pending. Should I allow or deny it?',
      ),
    ).toBe(true);
  });

  it('surfaces the next hidden-session assistant reply when a local turn completes without a direct assistant response', async () => {
    const sendLocalTurn = vi.fn(async () => ({ assistantText: '', actions: [] }));
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const waitForInterruptedLocalAssistantTurn = vi.fn(async () => 'The coding session finished and needs your approval.');
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn,
      qaStore: useVoiceQaStore,
    });

    await expect(
      controller.sendPrompt({
        sessionId: 's1',
        prompt: 'Ask the coding session to create a file, then tell me when it needs approval.',
      }),
    ).resolves.toMatchObject({ assistantText: 'The coding session finished and needs your approval.' });

    expect(waitForInterruptedLocalAssistantTurn).toHaveBeenCalledWith({
      conversationSessionId: 'voice-hidden-s1',
      timeoutMs: 5_000,
      baseline: {
        baselineCount: 0,
        baselineIds: expect.any(Set),
      },
    });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) => entry.kind === 'assistant' && entry.text === 'The coding session finished and needs your approval.',
      ),
    ).toBe(true);
  });

  it('appends a later hidden-session assistant update after acknowledging sendSessionMessage', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
    } as any);
    vi.spyOn(sync, 'sendMessage').mockResolvedValue(undefined as any);
    (sync as any).encryption = { getSessionEncryption: vi.fn(() => ({ encryptRawRecord: vi.fn() })) };

    const sendLocalTurn = vi.fn(async () => ({
      assistantText: 'The message was sent to the coding assistant. Waiting for it to respond with the structured question.',
      actions: [
        {
          t: 'sendSessionMessage',
          args: {
            sessionId: 's1',
            message: 'Ask me which color I prefer using a structured question with Red and Blue options.',
          },
        },
      ],
    }));
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    }));
    const waitForInterruptedLocalAssistantTurn = vi.fn(async () => 'The coding session is now asking which color you prefer: Red or Blue.');
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn,
      qaStore: useVoiceQaStore,
    });

    await expect(
      controller.sendPrompt({
        sessionId: 's1',
        prompt: 'Ask the coding session which color I prefer.',
      }),
    ).resolves.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitForInterruptedLocalAssistantTurn).toHaveBeenCalledWith({
      conversationSessionId: 'voice-hidden-s1',
      timeoutMs: 15_000,
      baseline: {
        baselineCount: 0,
        baselineIds: expect.any(Set),
      },
    });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'assistant'
          && entry.text === 'The message was sent to the coding assistant. Waiting for it to respond with the structured question.',
      ),
    ).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'assistant'
          && entry.text === 'The coding session is now asking which color you prefer: Red or Blue.',
      ),
    ).toBe(true);
  });

  it('routes realtime text prompts through the bound hidden conversation session when available', async () => {
    const sendRealtimeTextTurn = vi.fn(async () => {});
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'realtime_elevenlabs',
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's9', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => null),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => true,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => ({
        sendTextMessage: vi.fn(),
        sendContextualUpdate: vi.fn(),
      }),
      getRealtimeBinding: () => ({
        adapterId: 'realtime_elevenlabs',
        controlSessionId: 's9',
        conversationSessionId: 'voice-hidden-s9',
        transcriptMode: 'native_session',
        targetSessionId: 's9',
        updatedAt: 1,
      }),
      sendRealtimeTextTurn,
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.sendPrompt({ prompt: 'Please list the recent workspaces.' });

    expect(sendRealtimeTextTurn).toHaveBeenCalledWith({
      controlSessionId: 's9',
      conversationSessionId: 'voice-hidden-s9',
      text: 'Please list the recent workspaces.',
    });
    expect(useVoiceQaStore.getState().entries.some((entry) => entry.kind === 'user' && entry.text.includes('recent workspaces'))).toBe(true);
  });

  it('starts realtime QA in text-only mode so the harness does not require microphone access', async () => {
    const startRealtime = vi.fn(async () => {});
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'realtime_elevenlabs',
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's9', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => null),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime,
      isRealtimeStarted: () => true,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's9', initialContext: 'ctx' });

    expect(startRealtime).toHaveBeenCalledWith('s9', 'ctx', { textOnly: true });
  });

  it('fails realtime QA start when the provider did not actually connect', async () => {
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'realtime_elevenlabs',
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's9', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => null),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.start({ sessionId: 's9' })).rejects.toThrow('realtime_voice_session_not_started');
    expect(useVoiceQaStore.getState().status).toBe('error');
  });

  it('rejects local QA when the current provider is not the local voice agent mode', async () => {
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          adapters: { local_conversation: { conversationMode: 'direct_session' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => null),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.start({ sessionId: 's1' })).rejects.toThrow('voice_qa_local_agent_requires_local_conversation_agent_mode');
    expect(useVoiceQaStore.getState().status).toBe('error');
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'error'
          && entry.text === 'Local QA requires Local voice with conversation mode set to Agent.',
      ),
    ).toBe(true);
  });

  it('surfaces a human-friendly error when global local voice has no available voice-home target', async () => {
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: null, lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => {
        throw Object.assign(new Error('voice_conversation_spawn_target_missing'), {
          code: 'VOICE_CONVERSATION_TARGET_MISSING',
        });
      }),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.start()).rejects.toThrow('voice_conversation_spawn_target_missing');

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'error'
          && entry.text === 'No local session or machine is available to start global local voice. Open or create a local session first, or enter a Session ID override.',
      ),
    ).toBe(true);
  });

  it('surfaces a human-friendly error when an explicit local target cannot resolve to a usable voice session', async () => {
    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: null, lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => {
        throw new Error('voice_conversation_session_target_missing');
      }),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.start({ sessionId: 's-explicit' })).rejects.toThrow('voice_conversation_session_target_missing');

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system'
          && entry.text === 'Starting local_voice_agent QA session for the selected session',
      ),
    ).toBe(true);

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'error'
          && entry.text === 'The selected local session or machine is unavailable for local voice. Open or create another local session, or reconnect the target machine daemon.',
      ),
    ).toBe(true);
  });

  it('uses the generic human label when a session metadata label degrades to the raw session id', async () => {
    storage.setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        's-explicit': {
          id: 's-explicit',
          presence: 'offline',
          active: true,
          updatedAt: 1,
          metadata: {
            name: 's-explicit',
          },
          agentState: null,
        },
      },
    } as any);

    const controller = createVoiceQaController({
      getSettings: () => ({
        voice: {
          providerId: 'local_conversation',
          adapters: { local_conversation: { conversationMode: 'agent' } },
        },
      }),
      getVoiceTargetState: () => ({ primaryActionSessionId: null, lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => {
        throw new Error('voice_conversation_session_target_missing');
      }),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await expect(controller.start({ sessionId: 's-explicit' })).rejects.toThrow('voice_conversation_session_target_missing');

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system'
          && entry.text === 'Starting local_voice_agent QA session for the selected session',
      ),
    ).toBe(true);
  });

  it('stops the active local QA run even if settings switched providers afterwards', async () => {
    const stopLocal = vi.fn(async () => {});
    const stopRealtime = vi.fn(async () => {});
    const settings = {
      voice: {
        providerId: 'local_conversation',
        adapters: { local_conversation: { conversationMode: 'agent' } },
      },
    };
    const controller = createVoiceQaController({
      getSettings: () => settings,
      getVoiceTargetState: () => ({ primaryActionSessionId: 's1', lastFocusedSessionId: null }),
      ensureLocalBinding: vi.fn(async () => null),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal,
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime,
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionId: 's1' });
    settings.voice.providerId = 'realtime_elevenlabs';

    await controller.stop({ sessionId: 's1' });

    expect(stopLocal).toHaveBeenCalledWith('__voice_agent__');
    expect(stopRealtime).not.toHaveBeenCalled();
  });
});
