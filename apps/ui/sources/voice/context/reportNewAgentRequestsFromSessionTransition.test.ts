import { afterEach, expect, it } from 'vitest';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceHooks } from './voiceHooks';
import { reportNewAgentRequestsFromSessionTransition } from './reportNewAgentRequestsFromSessionTransition';

const token = {};
afterEach(() => {
  removeExternalVoiceProviderRegistration(token);
  voiceHooks.onVoiceStopped();
  useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
  setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
});

it('discloses a request only for its qualified Home without the active duplicate context', () => {
  const active = { serverId: getActiveServerSnapshot().serverId, sessionId: 'collision' };
  const remote = { serverId: 'remote-home', sessionId: 'collision' };
  const received: string[] = [];
  const providerId = 'test.external/voice';
  const snapshot = { adapterId: providerId, sessionId: 'voice-runtime', status: 'connected' as const, mode: 'idle' as const, canStop: true };
  commitExternalVoiceProviderRegistration({
    token, pluginId: 'test.external', localId: 'voice', providerId, descriptor: null,
    adapter: {
      id: providerId, engineKind: 'realtime', start: async () => {}, stop: async () => {},
      toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
      getSnapshot: () => snapshot,
      resolveContextChannel: () => ({ hostAuthoredContext: 'session_context',
        sendContextualUpdate: (text) => received.push(text), sendTextMessage: (text) => received.push(text),
      }),
    },
  });
  setVoiceSessionSnapshot(snapshot);
  const activeSession = createSessionFixture({ id: active.sessionId, serverId: active.serverId,
    metadata: { ...createSessionFixture().metadata!, name: 'ACTIVE PRIVATE TITLE' } });
  const remoteSession = createSessionFixture({ id: remote.sessionId, serverId: remote.serverId,
    metadata: { ...createSessionFixture().metadata!, name: 'REMOTE TITLE' },
    agentState: { requests: { request: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'REMOTE REQUEST SECRET', options: [{ label: 'Continue' }] }] }, createdAt: 1 } } },
  });
  storage.setState({ settings: settingsParse({ voice: { providerId,
    privacy: { sharePermissionRequests: true, shareToolArgs: true, shareToolNames: true, shareSessionSummary: true, shareRecentMessages: true },
    ui: { updates: { activeSession: 'snippets', otherSessions: 'none' } },
  } }), sessions: { collision: activeSession },
    sessionMessages: { collision: createSessionMessagesFixture({ messageIdsOldestFirst: ['active-message'], messagesById: { 'active-message': { kind: 'agent-text', id: 'active-message', localId: null, createdAt: 1, text: 'ACTIVE PRIVATE MESSAGE' } } }) },
    sessionListRowsByServerId: { [remote.serverId]: { collision: remoteSession } },
  });
  useVoiceTargetStore.getState().setPrimaryActionSessionAddress(active);
  useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([active]);
  reportNewAgentRequestsFromSessionTransition(null, remoteSession);
  expect(received).toEqual([]);
  useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([remote]);
  reportNewAgentRequestsFromSessionTransition(null, remoteSession);
  expect(received).toEqual([]);
  storage.setState((state) => ({ sessionListRowsByServerId: {
    ...state.sessionListRowsByServerId,
    [remote.serverId]: { collision: {
      ...remoteSession,
      viewer: SessionViewerProjectionV1Schema.parse({
        readState: { state: 'not_started' },
        relevance: { relevant: true, reasons: ['followed_by_me'] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: true, notificationLevel: 'important', includeInVoice: true },
        notification: { level: 'important', source: 'preference' },
      }),
    } },
  } }));
  reportNewAgentRequestsFromSessionTransition(null, remoteSession);
  expect(received.join('\n')).toContain('REMOTE REQUEST SECRET');
  expect(received.join('\n')).toContain('REMOTE TITLE');
  expect(received.join('\n')).not.toContain('ACTIVE PRIVATE TITLE');
  expect(received.join('\n')).not.toContain('ACTIVE PRIVATE MESSAGE');
});
