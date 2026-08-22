import { describe, it, expect, vi, beforeEach } from 'vitest';

import { composeCurrentUiContextSnapshot } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { storage } from '@/sync/domains/state/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { projectParameterFreeRoute } from '@/track/parameterFreeRouteProjection';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { useVoiceContextSeenStore } from '@/voice/runtime/voiceContextSeenStore';

const { fakeSink, getVoiceContextSinkForSession } = vi.hoisted(() => {
  const fakeSink = {
    sendTextMessage: vi.fn(),
    sendContextualUpdate: vi.fn(),
  };
  return {
    fakeSink,
    getVoiceContextSinkForSession: vi.fn(() => fakeSink),
  };
});

vi.mock('@/voice/context/getVoiceContextSinkForSession', () => ({
  getVoiceContextSinkForSession,
}));

import {
  createCurrentUiContextAutomaticUpdateProjector,
  voiceHooks,
} from './voiceHooks';

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
      [sessionId]: {
        id: sessionId,
        metadata: { path: '/tmp/project', host: 'localhost', summary: { text: 'Summary', updatedAt: Date.now() } },
        presence: 'online',
      },
    },
    sessionMessages: {
      ...state.sessionMessages,
      [sessionId]: {
        messages: [],
      },
    },
  }));
}

describe('voiceHooks privacy settings (opt-out defaults)', () => {
  beforeEach(() => {
    fakeSink.sendTextMessage.mockReset();
    fakeSink.sendContextualUpdate.mockReset();
    getVoiceContextSinkForSession.mockClear();
    storage.setState((s: any) => ({
      ...s,
      settings: structuredClone(initialSettings),
      sessionListRenderables: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    }));
    seedSession('s1');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);
    useVoiceContextSeenStore.getState().clearShownSessions();
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

    (voiceHooks as any).onAgentRequest('s1', 'r1', 'permission', 'rm', { path: '/tmp' });
    expect(getVoiceContextSinkForSession).not.toHaveBeenCalled();
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalled();
  });

  it('does not leak an already-pending permission request through repeated full-session reports', () => {
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
      sessions: {
        ...s.sessions,
        s1: {
          ...s.sessions.s1,
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
    }));

    voiceHooks.onSessionFocus('s1');

    const providerBoundPayloads = fakeSink.sendContextualUpdate.mock.calls
      .map((call) => String(call[1] ?? ''))
      .join('\n');
    expect(providerBoundPayloads).toContain('# Session:');
    expect(providerBoundPayloads).not.toContain('req_report_secret');
    expect(providerBoundPayloads).not.toContain('REPORTED_PERMISSION_SECRET');
  });

  it.each(['onSessionOnline', 'onSessionOffline', 'onSessionFocus'] as const)(
    'does not leak summary or path labels through %s status updates',
    (hookName) => {
      storage.setState((s: any) => ({
        ...s,
        settings: {
          ...s.settings,
          voice: {
            ...s.settings.voice,
            privacy: {
              ...s.settings.voice.privacy,
              shareSessionSummary: false,
              shareFilePaths: false,
            },
          },
        },
      }));

      voiceHooks[hookName]('s1', {
        summary: { text: 'PRIVATE HOOK SUMMARY' },
        path: '/Users/alice/Company/PrivateHookRepo',
      });

      const payloads = fakeSink.sendContextualUpdate.mock.calls.map((call) => String(call[1] ?? '')).join('\n');
      expect(payloads).not.toContain('PRIVATE HOOK SUMMARY');
      expect(payloads).not.toContain('PrivateHookRepo');
      expect(payloads).not.toContain('/Users/alice/Company/PrivateHookRepo');
    },
  );

  it('redacts tool args in permission requests by default', () => {
    (voiceHooks as any).onAgentRequest('s1', 'r1', 'permission', 'execute', { secret: 'do_not_leak' });

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('<request_id>r1</request_id>'),
    );
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<tool_args_redacted>true</tool_args_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('do_not_leak'));
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

    (voiceHooks as any).onAgentRequest('s1', 'r1', 'permission', 'execute', { secret: 'do_not_leak' });

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<tool_args_redacted>true</tool_args_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('do_not_leak'));
  });

  it('forwards user-action requests with question details and answer guidance', () => {
    (voiceHooks as any).onAgentRequest(
      's1',
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

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<request_kind>user_action</request_kind>'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('Continue with the deployment?'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('answerUserActionRequest'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('processPermissionRequest'));
  });

  it('keeps non-AskUserQuestion user-action requests actionable when tool args are redacted', () => {
    (voiceHooks as any).onAgentRequest(
      's1',
      'req_exit_plan',
      'user_action',
      'ExitPlanMode',
      { plan: 'Review changes under /Users/alice/SecretRepo before exiting plan mode.' },
    );

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<request_kind>user_action</request_kind>'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('approve, reject, or request changes'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<request_payload_redacted>true</request_payload_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('/Users/alice/SecretRepo'));
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

    voiceHooks.onMessages('s1', [createUserTextMessage('hi', 1)]);
    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalled();
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith('s1', expect.stringContaining('hi'));
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
      sessionListRenderables: {
        s1: {
          id: 's1',
          updatedAt: 99,
          metadata: {
            ...state.sessions.s1.metadata,
            summary: { text: 'Lookup session summary', updatedAt: 2 },
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
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    const prompt = voiceHooks.onVoiceStarted('s1', 'session_context');

    expect(prompt).toContain('Lookup session summary');
    expect(prompt).not.toContain('Raw session summary');
  });

  it('contributes no host-authored startup item for a current-UI-only attempt', () => {
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    // An Agent-session realtime attachment runs against a runtime that already
    // owns the authoritative startup prompt, so Happier must add nothing.
    expect(voiceHooks.onVoiceStarted('s1', 'current_ui_only')).toBe('');
    expect(voiceHooks.onVoiceStarted('', 'current_ui_only')).toBe('');
    expect(voiceHooks.onVoiceStarted('missing_session', 'current_ui_only')).toBe('');

    // The same session still produces the stored-session prompt for a
    // direct-media provider, so the empty result above is real scoping.
    expect(voiceHooks.onVoiceStarted('s1', 'session_context')).not.toBe('');
  });

  it('does not mark activity-only sessions as shown, so later tracking can emit full context', () => {
    // Ensure s1 is not tracked, so it uses otherSessions update level (default: activity).
    useVoiceTargetStore.getState().setTrackedSessionIds([]);

    voiceHooks.onReady('s1');
    // activity-only sessions should not emit a full session context block.
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith('s1', expect.stringContaining('# Session: Summary'));

    // Now track the session and ensure full context can be emitted.
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);
    voiceHooks.onReady('s1');
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledWith('s1', expect.stringContaining('# Session: Summary'));
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
      expect(getVoiceContextSinkForSession).not.toHaveBeenCalled();
      expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalled();
      return;
    }

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[1] ?? '');
    expect(update).toContain('Session details');
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

    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[1] ?? '');
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

    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[1] ?? '');
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

    const update = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[1] ?? '');
    expect(update).toContain('HOST_SETTINGS_LABEL_SENTINEL');
  });

  it('forwards only composer-approved framework labels automatically and never a gated workspace path', () => {
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
            text: 'Review /Users/alice/SECRET_AUTOMATIC_WORKSPACE',
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

    const sessionUpdate = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[1] ?? '');
    expect(sessionUpdate).toContain('Review <path_redacted>');
    expect(sessionUpdate).not.toContain('SECRET_AUTOMATIC_WORKSPACE');

    const machineSnapshot = composeCurrentUiContextSnapshot({
      route: projectParameterFreeRoute(['machine', '[id]']),
      machineActive: true,
      machine: {
        id: 'machine-a',
        metadata: { displayName: 'AUTOMATIC_MACHINE_LABEL' },
      },
      privacy: {
        shareSessionSummary: false,
        shareFilePaths: false,
        shareDeviceInventory: true,
      },
    } as never);
    (voiceHooks as any).onCurrentUiContextChanged('s1', machineSnapshot, projector);

    const machineUpdate = String(fakeSink.sendContextualUpdate.mock.calls.at(-1)?.[1] ?? '');
    expect(machineUpdate).toContain('AUTOMATIC_MACHINE_LABEL');
    expect(machineUpdate).not.toContain('SECRET_AUTOMATIC_WORKSPACE');
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
      ['s1', navigationUpdate],
      ['s1', retiredUpdate],
    ]);
    expect(retiredUpdate).not.toContain('PRIVATE ENTITY');
    expect(retiredUpdate).not.toContain('PRIVATE DETAIL');
    expect(retiredUpdate).not.toContain('PRIVATE COMMAND');
  });
});
