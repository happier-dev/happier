import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { readPersistentVoiceTranscriptEpoch } from './voiceTranscriptMemory';
import { buildVoiceAgentRunMetadataV1 } from '@happier-dev/protocol/voice/voiceAgentRunMetadataV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Cold module loading belongs to collection, before the timed Account-restoration hook.
// The hoisted Socket boundary is already installed; HTTP is installed by this harness.
const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');

let account: Awaited<ReturnType<typeof import('@/voice/settings/panels/voiceSettingsAccountTestHarness').createVoiceSettingsAccountTestHarness>>;
let storage: typeof import('@/sync/domains/state/storage').storage;
let sessionHttp: ReturnType<typeof import('@/dev/testkit/harness/sessionMetadataHttpBoundary').createSessionMetadataHttpBoundary>;

async function conversation(id: string, updatedAt: number, runId: string, bound = false) {
  const run = buildVoiceAgentRunMetadataV1({ runId, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    resumeHandle: null, updatedAtMs: updatedAt });
  if (!run) throw new Error('Invalid canonical run fixture');
  let metadata = { ...createSessionFixture().metadata!,
    ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }), voiceAgentRunV1: run };
  if (bound) {
    const { writeVoiceConversationBindingMetadata } = await import('@/voice/binding/voiceConversationBindingMetadata');
    metadata = writeVoiceConversationBindingMetadata(metadata, { adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__', conversationSessionId: id,
      conversationSessionAddress: { serverId: account.scope.serverId, sessionId: id },
      transcriptMode: 'native_session', targetSessionAddress: null, updatedAt });
  }
  return createSessionFixture({ id, serverId: account.scope.serverId, updatedAt, metadata });
}

afterEach(() => standardCleanup());

beforeEach(async () => {
  account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providers: {
    local_conversation: { schemaVersion: 1, config: { agent: { transcript: { persistenceMode: 'ephemeral', epoch: 1 } } } },
  } } }));
  onTestFinished(account.dispose);
  ({ storage } = await import('@/sync/domains/state/storage'));
  storage.setState({ sessions: {
    sys_bound: await conversation('sys_bound', 10, 'run_bound', true),
    sys_newer: await conversation('sys_newer', 20, 'run_newer'),
  }, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
    sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
  const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
  sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
  const request = account.request.getMockImplementation();
  if (!request) throw new Error('Account HTTP boundary missing');
  account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init) ?? request(input, init)));
});

describe('resetVoiceAgentPersistenceState', () => {
  it('clears the bound global conversation while retaining a newer unrelated hidden run', async () => {
    const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
    const local = readLocalConversationVoiceSettings(account.settings.voice);
    account.replaceVoice(writeLocalConversationVoiceSettings(account.settings.voice, { ...local,
      agent: { ...local.agent, transcript: { ...local.agent.transcript, persistenceMode: 'persistent' } },
    }));
    const { resetVoiceAgentPersistenceState } = await import('./resetVoiceAgentPersistenceState');
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    let stopped = false;
    await resetVoiceAgentPersistenceState({ stop: async () => {
      expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_bound' })?.runId).toBe('run_bound');
      expect(sessionHttp.writes).toEqual([]);
      expect(await readPersistentVoiceTranscriptEpoch()).toBe(0);
      stopped = true;
    } });
    expect(stopped).toBe(true);
    expect(sessionHttp.writes).toContain('sys_bound');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_bound' })).toBeNull();
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_newer' })?.runId).toBe('run_newer');
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(1);
    expect(account.writes).toHaveLength(0);
    const { sync } = await import('@/sync/sync');
    storage.setState({ sessions: {} });
    expect(await sync.ensureSessionVisibleForMessageRoute('sys_bound', { forceRefresh: true, serverId: account.scope.serverId }))
      .toMatchObject({ kind: 'available', sessionId: 'sys_bound' });
    expect(await sync.ensureSessionVisibleForMessageRoute('sys_newer', { forceRefresh: true, serverId: account.scope.serverId }))
      .toMatchObject({ kind: 'available', sessionId: 'sys_newer' });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_bound' })).toBeNull();
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_newer' })?.runId).toBe('run_newer');
  });

  it('VI-LIFE leaves unrelated hidden runs untouched when no exact binding exists', async () => {
    const unbound = await conversation('sys_bound', 10, 'run_bound');
    storage.setState(state => ({ sessions: { ...state.sessions, sys_bound: unbound } }));
    sessionHttp.replaceSession('sys_bound');
    const { resetVoiceAgentPersistenceState } = await import('./resetVoiceAgentPersistenceState');
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await resetVoiceAgentPersistenceState({ stop: async () => {} });
    expect(sessionHttp.writes).toEqual([]);
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_newer' })?.runId).toBe('run_newer');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_bound' })?.runId).toBe('run_bound');
  });

  it('refuses transcript and run writes after the captured Home and Account lifetime changes during Stop', async () => {
    const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
    const local = readLocalConversationVoiceSettings(account.settings.voice);
    account.replaceVoice(writeLocalConversationVoiceSettings(account.settings.voice, { ...local,
      agent: { ...local.agent, transcript: { ...local.agent.transcript, persistenceMode: 'persistent' } },
    }));
    const { resetVoiceAgentPersistenceState } = await import('./resetVoiceAgentPersistenceState');
    const nextSession = await conversation('sys_bound', 30, 'account-b-run', true);
    const before = account.settings;
    const replacement: { current?: typeof account } = {};
    await resetVoiceAgentPersistenceState({ stop: async () => {
      replacement.current = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providers: {
        local_conversation: { schemaVersion: 1, config: { agent: { transcript: { persistenceMode: 'persistent', epoch: 9 } } } },
      } } }));
      onTestFinished(replacement.current.dispose);
      storage.setState({ sessions: { sys_bound: { ...nextSession, serverId: replacement.current.scope.serverId } } });
    } });
    const { sync } = await import('@/sync/sync');
    await (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue();
    expect(account.writes).toEqual([]);
    expect(account.persistedSettings).toEqual(before);
    if (!replacement.current) throw new Error('Replacement Home was not mounted');
    expect(replacement.current.writes).toEqual([]);
    expect(replacement.current.kv.readRequests().filter(request => request.path.includes('voice'))).toEqual([]);
    expect(sessionHttp.writes).toEqual([]);
    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_bound' })?.runId).toBe('account-b-run');
  });

});
