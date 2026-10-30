import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol';

import { composeCurrentUiContextSnapshot } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Message } from "@happier-dev/session-core/messages";
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);

installDisconnectedServerSocketBoundary();

const { storage } = await import('@/sync/domains/state/storage');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { createCurrentUiContextAutomaticUpdateProjector, voiceHooks } = await import('./voiceHooks');

const TEST_SERVER_ID = getActiveServerSnapshot().serverId;
const fakeSink = {
  sendTextMessage: vi.fn<(text: string) => void>(),
  sendContextualUpdate: vi.fn<(text: string, contextClass?: import('@/voice/session/types').HostAuthoredContextClass) => void>(),
};

const initialSettings = structuredClone(storage.getState().settings);

function createUserTextMessage(text: string, createdAt: number): Message {
  return {
    kind: 'user-text',
    id: `msg_${createdAt}`,
    localId: null,
    createdAt,
    text,
  };
}

function seedSession(sessionId: string) {
  storage.setState((state: any) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: createSessionFixture({
        id: sessionId,
        serverId: TEST_SERVER_ID,
        // Readability is evidence: without a declared mode the awareness owner projects
        // `locked` and Voice withholds every detail these privacy cases assert on.
        encryptionMode: 'plain',
        metadata: { path: '/tmp/project', host: 'localhost', summary: { text: 'Summary', updatedAt: Date.now() } },
        presence: 'online',
      }),
    },
    sessionMessages: {
      ...state.sessionMessages,
      [sessionId]: createSessionMessagesFixture(),
    },
  }));
}

describe('voiceHooks privacy settings (opt-out defaults)', () => {
  afterEach(() => {
    voiceHooks.onVoiceStopped();
    resetVoiceAdapterRegistryForTests();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
  });
  beforeEach(() => {
    // Reset attempt-local disclosure state through its public lifecycle owner.
    voiceHooks.onVoiceStopped();
    fakeSink.sendTextMessage.mockReset();
    fakeSink.sendContextualUpdate.mockReset();
    resetVoiceAdapterRegistryForTests();
    const snapshot = { adapterId: 'test.privacy', sessionId: 's1', status: 'connected' as const, mode: 'idle' as const, canStop: true };
    // Observe the provider output boundary through the real adapter registry
    // and context sink, rather than substituting the disclosure owner.
    registerVoiceAdapters([{
      id: snapshot.adapterId, engineKind: 'realtime', start: async () => {}, stop: async () => {},
      toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
      getSnapshot: () => snapshot,
      resolveContextChannel: () => ({ hostAuthoredContext: 'session_context', ...fakeSink }),
    }]);
    setVoiceSessionSnapshot(snapshot);
    storage.setState((s: any) => ({
      ...s,
      settings: structuredClone(initialSettings),
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    }));
    seedSession('s1');
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{ serverId: TEST_SERVER_ID, sessionId: 's1' }]);
    // The local voice target must be re-established by each case, otherwise a
    // previous case's focus makes a target assertion pass without the code
    // under test ever running.
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
  });

  it('does not forward permission requests when sharePermissionRequests is false', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            sharePermissionRequests: false,
          },
        },
      },
    }));

    (voiceHooks as any).onAgentRequest({ serverId: TEST_SERVER_ID, sessionId: 's1' }, 'r1', 'permission', 'rm', { path: '/tmp' });
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalled();
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalled();
  });

  it('keeps automatic session focus local instead of reporting stored session context', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            sharePermissionRequests: false,
            // The automatic mode activates the dedicated navigation channel;
            // a session-focus signal itself must remain local.
            currentUiContextMode: 'automatic',
          },
        },
      },
      sessions: {
        ...s.sessions,
        s1: {
          ...s.sessions.s1,
          metadata: {
            ...s.sessions.s1.metadata,
            path: '/Users/alice/SESSION_FOCUS_PATH_SENTINEL',
            machineId: 'SESSION_FOCUS_MACHINE_SENTINEL',
            summary: { text: 'SESSION_FOCUS_SUMMARY_SENTINEL', updatedAt: 1 },
          },
          seq: 0,
          createdAt: 0,
          updatedAt: 0,
          active: true,
          activeAt: 0,
          metadataVersion: 1,
          agentStateVersion: 1,
          thinking: false,
          thinkingAt: 0,
          presence: 'online',
          agentState: {
            requests: {
              req_report_secret: {
                tool: 'write',
                kind: 'permission',
                arguments: { content: 'REPORTED_PERMISSION_SECRET' },
                createdAt: 1,
              },
            },
            completedRequests: {},
          },
        },
      },
      sessionMessages: {
        ...s.sessionMessages,
        s1: {
          ...s.sessionMessages.s1,
          messages: [createUserTextMessage('SESSION_FOCUS_TRANSCRIPT_SENTINEL', 1)],
        },
      },
    }));

    voiceHooks.onSessionFocus({ serverId: TEST_SERVER_ID, sessionId: 's1' });

    const providerBoundPayloads = fakeSink.sendContextualUpdate.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('\n');
    expect(providerBoundPayloads).toBe('');
    expect(providerBoundPayloads).not.toContain('SESSION_FOCUS_PATH_SENTINEL');
    expect(providerBoundPayloads).not.toContain('SESSION_FOCUS_MACHINE_SENTINEL');
    expect(providerBoundPayloads).not.toContain('SESSION_FOCUS_SUMMARY_SENTINEL');
    expect(providerBoundPayloads).not.toContain('SESSION_FOCUS_TRANSCRIPT_SENTINEL');
    expect(providerBoundPayloads).not.toContain('REPORTED_PERMISSION_SECRET');
  });

  it.each([
    ['off'],
    ['on_demand'],
    ['automatic'],
  ] as const)(
    'keeps session focus local in every current-UI mode (%s)',
    (currentUiContextMode) => {
      storage.setState((state: any) => ({
        ...state,
        settings: {
          ...state.settings,
          voice: {
            ...state.settings.voice,
            privacy: {
              ...state.settings.voice.privacy,
              currentUiContextMode,
            },
          },
        },
      }));

      voiceHooks.onSessionFocus({ serverId: TEST_SERVER_ID, sessionId: 's1' }, { summary: { text: 'Summary' } });

      // Focusing a session is an observation of this device's UI, so it always
      // updates the local voice target. The dedicated current-UI subscription
      // is the only automatic provider disclosure path.
      expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual({
        serverId: TEST_SERVER_ID,
        sessionId: 's1',
      });
      expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalled();
    },
  );

  it('redacts tool args in permission requests by default', () => {
    (voiceHooks as any).onAgentRequest({ serverId: TEST_SERVER_ID, sessionId: 's1' }, 'r1', 'permission', 'execute', { secret: 'do_not_leak' });
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('<request_id>r1</request_id>'),
    );
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('<tool_args_redacted>true</tool_args_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith(expect.stringContaining('do_not_leak'));
  });

  it('still redacts tool args when a raw voice privacy blob tries to enable shareToolArgs', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            shareToolArgs: true,
          },
        },
      },
    }));

    (voiceHooks as any).onAgentRequest({ serverId: TEST_SERVER_ID, sessionId: 's1' }, 'r1', 'permission', 'execute', { secret: 'do_not_leak' });
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('<tool_args_redacted>true</tool_args_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith(expect.stringContaining('do_not_leak'));
  });

  it('forwards user-action requests with question details and answer guidance', () => {
    (voiceHooks as any).onAgentRequest(
      { serverId: TEST_SERVER_ID, sessionId: 's1' },
      'req_question',
      'user_action',
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Confirm',
            question: 'Continue with the deployment?',
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
    );
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('<request_kind>user_action</request_kind>'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('Continue with the deployment?'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('answerUserActionRequest'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith(expect.stringContaining('processPermissionRequest'));
  });

  it('keeps non-AskUserQuestion user-action requests actionable when tool args are redacted', () => {
    (voiceHooks as any).onAgentRequest(
      { serverId: TEST_SERVER_ID, sessionId: 's1' },
      'req_exit_plan',
      'user_action',
      'ExitPlanMode',
      { plan: 'Review changes under /Users/alice/SecretRepo before exiting plan mode.' },
    );
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('<request_kind>user_action</request_kind>'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('approve, reject, or request changes'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('<request_payload_redacted>true</request_payload_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith(expect.stringContaining('/Users/alice/SecretRepo'));
  });

  it('still forwards activity-only message updates when shareRecentMessages is false (no transcript content)', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            shareRecentMessages: false,
          },
        },
      },
    }));

    voiceHooks.onMessages({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [createUserTextMessage('hi', 1)]);
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalled();
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith(expect.stringContaining('hi'));
  });

  it('returns a global boot prompt when voice starts without a session id', () => {
    expect(() => voiceHooks.onVoiceStarted('', 'session_context')).not.toThrow();
    const prompt = voiceHooks.onVoiceStarted('', 'session_context');
    expect(prompt).toContain('<session_context>none</session_context>');
  });

  it('returns a safe boot prompt when voice starts with an unknown session id', () => {
    expect(() => voiceHooks.onVoiceStarted('missing_session', 'session_context')).not.toThrow();
    const prompt = voiceHooks.onVoiceStarted('missing_session', 'session_context');
    expect(prompt).toContain('<session_not_found>true</session_not_found>');
  });

  it('prefers visible lookup session metadata over stale raw session metadata when voice starts', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s1: {
          ...state.sessions.s1,
          metadata: {
            ...state.sessions.s1.metadata,
            summary: { text: 'Raw session summary', updatedAt: 1 },
          },
        },
      },
      sessionListRowsByServerId: {
        [TEST_SERVER_ID]: {
          s1: {
            id: 's1',
            updatedAt: 99,
            encryptionMode: 'plain',
            metadata: {
              ...state.sessions.s1.metadata,
              summary: { text: 'Lookup session summary', updatedAt: 2 },
            },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {
        [TEST_SERVER_ID]: ['s1'],
      },
      sessionListIndexByServerId: {
        [TEST_SERVER_ID]: [
          {
            type: 'session',
            sessionId: 's1',
            serverId: TEST_SERVER_ID,
            serverName: 'Active',
          },
        ],
      },
    }));
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{ serverId: TEST_SERVER_ID, sessionId: 's1' }]);

    const prompt = voiceHooks.onVoiceStarted('s1', 'session_context');

    expect(prompt).toContain('Lookup session summary');
    expect(prompt).not.toContain('Raw session summary');
  });

  it('contributes no host-authored startup item for a current-UI-only attempt', () => {
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{ serverId: TEST_SERVER_ID, sessionId: 's1' }]);

    // An Agent-session realtime attachment runs against a runtime that already
    // owns the authoritative startup prompt, so Happier must add nothing.
    expect(voiceHooks.onVoiceStarted('s1', 'current_ui_only')).toBe('');
    expect(voiceHooks.onVoiceStarted('', 'current_ui_only')).toBe('');
    expect(voiceHooks.onVoiceStarted('missing_session', 'current_ui_only')).toBe('');

    // The same session still produces the stored-session prompt for a
    // direct-media provider, so the empty result above is real scoping.
    expect(voiceHooks.onVoiceStarted('s1', 'session_context')).not.toBe('');
  });

  it('does not mark activity-only sessions as shown, so later Account Follow consent can emit full context', () => {
    // s1 is neither the attempt target nor included in Account Voice.
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    // activity-only sessions should not emit a full session context block.
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );

    // Synchronized Include in Voice consent admits its full context.
    storage.setState((state) => ({ sessions: {
      ...state.sessions,
      s1: {
        ...state.sessions.s1,
        viewer: SessionViewerProjectionV1Schema.parse({
          latestFailureSeq: null,
          readState: { state: 'not_started' },
          relevance: { relevant: true, reasons: ['followed_by_me'] },
          attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
          follow: { follows: true, notificationLevel: 'important', includeInVoice: true },
          notification: { level: 'important', source: 'preference' },
        }),
      },
    } }));
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );
  });

  it('does not mark activity-only sessions as shown, so later target selection can emit full context', () => {
    // Neither a current target nor Include in Voice grants s1 the active-session policy.
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    // activity-only sessions should not emit a full session context block.
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );

    // Selecting this exact target grants the active policy, independently of the readback cache.
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );
  });

  it('dedupes full session context within an attempt and clears it at both lifecycle boundaries', () => {
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{ serverId: TEST_SERVER_ID, sessionId: 's1' }]);

    expect(voiceHooks.onVoiceStarted('s1', 'session_context')).toContain('# Session: Summary');
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );

    voiceHooks.onVoiceStopped();
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(1);
    expect(fakeSink.sendContextualUpdate).toHaveBeenLastCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );

    voiceHooks.onVoiceStarted('s1', 'current_ui_only');
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(2);
    expect(fakeSink.sendContextualUpdate).toHaveBeenLastCalledWith(
      expect.stringContaining('# Session: Summary'),
      'session_context',
    );
  });

  it.each([
    ['off', false],
    ['on_demand', false],
    ['automatic', true],
  ] as const)('forwards only automatic-safe navigation context in %s mode', (currentUiContextMode, shouldForward) => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode,
          },
        },
      },
    }));

    const automaticUpdateProjector = createCurrentUiContextAutomaticUpdateProjector();
    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      navigation: {
        area: 'session',
        screen: 'details',
        title: 'Session details',
        presentation: 'pane',
      },
      entity: { kind: 'private_entity', label: 'PRIVATE ENTITY' },
      detail: { kind: 'private_detail', payload: 'PRIVATE DETAIL' },
      commands: [{ id: 'private-command', title: 'PRIVATE COMMAND' }],
    }, automaticUpdateProjector);

    if (!shouldForward) {
      expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalled();
      return;
    }
    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[0] ?? '');
    expect(update).toContain('"area":"session"');
    expect(update).toContain('"screen":"details"');
    expect(update).toContain('"presentation":"pane"');
    expect(update).not.toContain('Session details');
    expect(update).not.toContain('PRIVATE ENTITY');
    expect(update).not.toContain('PRIVATE DETAIL');
    expect(update).not.toContain('PRIVATE COMMAND');
  });

  it('keeps a plugin page label on demand but omits it from automatic navigation updates', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      navigation: {
        area: 'plugin',
        screen: 'page',
        title: 'PLUGIN_LABEL_SENTINEL',
        presentation: 'screen',
      },
      commands: [],
    }, createCurrentUiContextAutomaticUpdateProjector());

    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[0] ?? '');
    expect(update).toContain('"area":"plugin"');
    expect(update).not.toContain('PLUGIN_LABEL_SENTINEL');
  });

  it('keeps a plugin Settings label on demand but omits it from automatic navigation updates', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      navigation: {
        area: 'settings',
        screen: 'settings.plugin_page',
        title: 'PLUGIN_SETTINGS_LABEL_SENTINEL',
        presentation: 'screen',
      },
      commands: [],
    }, createCurrentUiContextAutomaticUpdateProjector());

    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[0] ?? '');
    expect(update).toContain('"area":"settings"');
    expect(update).toContain('"screen":"settings.plugin_page"');
    expect(update).not.toContain('PLUGIN_SETTINGS_LABEL_SENTINEL');
  });

  it('retains a host-owned Settings label in automatic navigation updates', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      navigation: {
        area: 'settings',
        screen: 'settings_page',
        title: 'HOST_SETTINGS_LABEL_SENTINEL',
        presentation: 'screen',
      },
      commands: [],
    }, createCurrentUiContextAutomaticUpdateProjector());

    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[0] ?? '');
    expect(update).toContain('"area":"settings"');
    expect(update).toContain('"screen":"settings_page"');
    expect(update).toContain('"presentation":"screen"');
    expect(update).toContain('HOST_SETTINGS_LABEL_SENTINEL');
  });

  it('strips session and machine identity titles from automatic context while retaining structural navigation metadata', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    const projector = createCurrentUiContextAutomaticUpdateProjector();
    const sessionSnapshot = composeCurrentUiContextSnapshot({
      route: projectParameterFreeRoute(['session', '[id]']),
      sessionActive: true,
      session: {
        id: 'session-a',
        metadata: {
          summary: {
            text: 'SESSION_CONTENT_SENTINEL /Users/alice/SECRET_AUTOMATIC_WORKSPACE',
            updatedAt: 1,
          },
        },
      },
      privacy: {
        shareSessionSummary: true,
        shareFilePaths: false,
        shareDeviceInventory: false,
      },
    } as never);
    (voiceHooks as any).onCurrentUiContextChanged('s1', sessionSnapshot, projector);

    const sessionUpdate = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[0] ?? '');
    expect(sessionUpdate).toContain(`"area":"${sessionSnapshot.navigation.area}"`);
    expect(sessionUpdate).toContain(`"screen":"${sessionSnapshot.navigation.screen}"`);
    expect(sessionUpdate).toContain(`"presentation":"${sessionSnapshot.navigation.presentation}"`);
    expect(sessionUpdate).not.toContain('"title":');
    expect(sessionUpdate).not.toContain('SESSION_CONTENT_SENTINEL');
    expect(sessionUpdate).not.toContain('SECRET_AUTOMATIC_WORKSPACE');

    const machineSnapshot = composeCurrentUiContextSnapshot({
      route: projectParameterFreeRoute(['machine', '[id]']),
      machineActive: true,
      machine: {
        id: 'machine-a',
        metadata: { displayName: 'AUTOMATIC_MACHINE_DEVICE_IDENTITY_SENTINEL' },
      },
      privacy: {
        shareSessionSummary: false,
        shareFilePaths: false,
        shareDeviceInventory: true,
      },
    } as never);
    (voiceHooks as any).onCurrentUiContextChanged('s1', machineSnapshot, projector);

    const machineUpdate = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[0] ?? '');
    expect(machineUpdate).toContain(`"area":"${machineSnapshot.navigation.area}"`);
    expect(machineUpdate).toContain(`"screen":"${machineSnapshot.navigation.screen}"`);
    expect(machineUpdate).toContain(`"presentation":"${machineSnapshot.navigation.presentation}"`);
    expect(machineUpdate).not.toContain('"title":');
    expect(machineUpdate).not.toContain('AUTOMATIC_MACHINE_DEVICE_IDENTITY_SENTINEL');
  });

  it('sends an automatic update only on a real navigation transition, and again for a new attempt', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    const triageList = {
      navigation: {
        area: 'plugin' as const,
        screen: 'plugin_page',
        title: 'Triage',
        presentation: 'screen' as const,
      },
      commands: [],
    };

    const firstAttemptProjector = createCurrentUiContextAutomaticUpdateProjector();
    (voiceHooks as any).onCurrentUiContextChanged('s1', triageList, firstAttemptProjector);
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(1);

    // Selecting issue A then issue B replaces only the mounted semantic
    // enrichment. Navigation is unchanged, so no new transition exists.
    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      ...triageList,
      entity: { kind: 'issue', label: 'Issue A' },
      commands: [{ id: 'current-ui-command:1', title: 'Open issue B' }],
    }, firstAttemptProjector);
    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      ...triageList,
      entity: { kind: 'issue', label: 'Issue B' },
      commands: [{ id: 'current-ui-command:2', title: 'Open issue A' }],
    }, firstAttemptProjector);
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(1);

    // A real navigation transition is still delivered.
    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      navigation: {
        area: 'settings' as const,
        screen: 'settings_page',
        title: 'Voice',
        presentation: 'screen' as const,
      },
      commands: [],
    }, firstAttemptProjector);
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(2);

    // A later attempt must be told where the user is, even when the previous
    // attempt already reported that exact navigation.
    voiceHooks.onVoiceStopped();
    voiceHooks.onVoiceStarted('s1', 'current_ui_only');
    const secondAttemptProjector = createCurrentUiContextAutomaticUpdateProjector();
    (voiceHooks as any).onCurrentUiContextChanged('s1', {
      navigation: {
        area: 'settings' as const,
        screen: 'settings_page',
        title: 'Voice',
        presentation: 'screen' as const,
      },
      commands: [],
    }, secondAttemptProjector);
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(3);
  });

  it('keeps automatic navigation dedupe scoped to the current Voice attempt', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    const snapshot = {
      navigation: { area: 'session' as const, screen: 'overview' },
      commands: [],
    };

    const firstAttempt = createCurrentUiContextAutomaticUpdateProjector();
    const secondAttempt = createCurrentUiContextAutomaticUpdateProjector();
    (voiceHooks as any).onCurrentUiContextChanged('s1', snapshot, firstAttempt);
    (voiceHooks as any).onCurrentUiContextChanged('s1', snapshot, secondAttempt);

    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledTimes(2);
  });

  it('sends one metadata-only retirement after a delivered automatic UI context', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          privacy: {
            ...state.settings.voice.privacy,
            currentUiContextMode: 'automatic',
          },
        },
      },
    }));

    const navigationUpdate = 'CURRENT UI CONTEXT\n\n{"navigation":{"area":"session","screen":"overview"}}';
    const retiredUpdate = 'CURRENT UI CONTEXT\n\n{"navigation":{"state":"unavailable"}}';
    const projector = createCurrentUiContextAutomaticUpdateProjector();
    const snapshot = {
      navigation: { area: 'session' as const, screen: 'overview' },
      entity: { kind: 'private_entity', label: 'PRIVATE ENTITY' },
      detail: { kind: 'private_detail', payload: 'PRIVATE DETAIL' },
      commands: [{ id: 'private-command', title: 'PRIVATE COMMAND' }],
    };

    (voiceHooks as any).onCurrentUiContextChanged('s1', snapshot, projector);
    (voiceHooks as any).onCurrentUiContextChanged('s1', null, projector);
    (voiceHooks as any).onCurrentUiContextChanged('s1', null, projector);

    expect(fakeSink.sendContextualUpdate.mock.calls).toEqual([
      [navigationUpdate, 'current_ui'],
      [retiredUpdate, 'current_ui'],
    ]);
    expect(retiredUpdate).not.toContain('PRIVATE ENTITY');
    expect(retiredUpdate).not.toContain('PRIVATE DETAIL');
    expect(retiredUpdate).not.toContain('PRIVATE COMMAND');
  });
});
