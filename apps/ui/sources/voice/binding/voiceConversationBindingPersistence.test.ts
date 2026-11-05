import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { buildVoiceAgentRunMetadataV1 } from '@happier-dev/protocol/voice/voiceAgentRunMetadataV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Cold transformation of the real Account/runtime graph is suite setup, not
// part of an individual retained-identity read's finite hook budget.
const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
const { RuntimeDescriptorV1Schema } = await import('@happier-dev/protocol/sessions/metadata/runtime-descriptor');
const { AgentRuntimeFacetsV1Schema } = await import('@happier-dev/protocol/sessions/metadata/agentRuntimeFacetsV1');
const { resetPersistentUiStateForTest } = await import('@/dev/testkit/cleanup/persistentUiState');
let serverId: string;
const claudeTarget = { kind: 'builtInAgent', agentId: 'claude' } as const;

function runMetadata(runId: string, updatedAtMs: number) {
  const metadata = buildVoiceAgentRunMetadataV1({ runId, backendTarget: claudeTarget, resumeHandle: null, updatedAtMs });
  if (!metadata) throw new Error('Invalid canonical run fixture');
  return metadata;
}

afterEach(() => standardCleanup());

beforeEach(async () => {
  await resetPersistentUiStateForTest();
  const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
  onTestFinished(account.dispose);
  serverId = account.scope.serverId;
  const metadata = writeVoiceConversationBindingMetadata({ ...createSessionFixture().metadata!,
    ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.parse({ v: 1, agentId: 'claude', agent: { backendMode: 'native' } }),
    agentRuntimeCapabilitiesV1: { executionRun: { supported: true } },
    agentRuntimeFacetsV1: AgentRuntimeFacetsV1Schema.parse({ v: 1, transcriptSource: { supported: true, followLeaseSupported: true } }),
    voiceAgentRunV1: runMetadata('run_1', 222),
  }, { adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
    conversationSessionId: 'sys_voice', conversationSessionAddress: { serverId, sessionId: 'sys_voice' },
    transcriptMode: 'native_session', targetSessionAddress: { serverId, sessionId: 's1' }, updatedAt: 111 });
  storage.setState({ sessions: {
    sys_voice: createSessionFixture({ id: 'sys_voice', serverId, updatedAt: 10, metadata }),
    s1: createSessionFixture({ id: 's1', serverId, updatedAt: 5 }),
  }, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
    sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
});

describe('voiceConversationBindingPersistence', () => {
  it('VI-LIFE does not retain a device pointer after Account Session-list rows are released', async () => {
    const { voiceSessionBindingStore } = await import('./voiceConversationBindingStore');
    voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
      conversationSessionId: 'sys_voice', conversationSessionAddress: { serverId, sessionId: 'sys_voice' },
      transcriptMode: 'native_session', targetSessionAddress: { serverId, sessionId: 's1' }, updatedAt: 1 });
    voiceSessionBindingStore.getState().unbind('sys_voice');
    storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
    const { resolvePersistedDaemonConversationSessionId, resolvePersistedVoiceConversationMetadataSessionId } =
      await import('./voiceConversationBindingPersistence');
    expect(resolvePersistedDaemonConversationSessionId()).toBeNull();
    expect(resolvePersistedVoiceConversationMetadataSessionId({ managedSessionId: '__voice_agent__' })).toBeNull();
  });

  it('reads the last Account conversation independently of runtime bindings or recipe matches', async () => {
    const { voiceSessionBindingStore } = await import('./voiceConversationBindingStore');
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: {}, runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
    storage.setState({ sessions: { newer: createSessionFixture({ id: 'newer', serverId, active: true, updatedAt: 999,
      metadata: { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) } }) } });
    const { resolvePersistedDaemonConversationSessionId } = await import('./voiceConversationBindingPersistence');
    expect(resolvePersistedDaemonConversationSessionId()).toBe('newer');
  });
  it('falls back to the session-scoped metadata session for non-global managed runs', async () => {
    storage.setState(state => ({ sessions: { ...state.sessions, s1: { ...state.sessions.s1!,
      metadata: { ...state.sessions.s1!.metadata!, voiceAgentRunV1: runMetadata('run_session', 333) },
    } } }));
    const { readPersistedVoiceConversationRuntimeState } = await import('./voiceConversationBindingPersistence');
    expect(readPersistedVoiceConversationRuntimeState({ managedSessionId: 's1' })).toMatchObject({
      metadataSessionId: 's1', runMetadata: runMetadata('run_session', 333),
      runtimePublication: { descriptor: null, capabilities: null, facets: null },
    });
  });

  it('reads generic runtime publication from the real persisted binding', async () => {
    const { readPersistedVoiceConversationRuntimePublication } = await import('./voiceConversationBindingPersistence');
    expect(readPersistedVoiceConversationRuntimePublication({ managedSessionId: '__voice_agent__' })).toEqual({
      descriptor: expect.objectContaining({ agentId: 'claude' }),
      capabilities: { executionRun: { supported: true } },
      facets: expect.objectContaining({ transcriptSource: expect.objectContaining({ supported: true, followLeaseSupported: true }) }),
    });
  });

  it('reads canonical persisted runtime state without the daemon handoff DTO', async () => {
    const { readPersistedVoiceConversationRuntimeState } = await import('./voiceConversationBindingPersistence');
    expect(readPersistedVoiceConversationRuntimeState({ managedSessionId: '__voice_agent__' })).toMatchObject({
      metadataSessionId: 'sys_voice', runMetadata: runMetadata('run_1', 222),
      runtimePublication: { descriptor: expect.objectContaining({ agentId: 'claude' }),
        capabilities: { executionRun: { supported: true } },
        facets: expect.objectContaining({ transcriptSource: expect.objectContaining({ supported: true, followLeaseSupported: true }) }) },
    });
  });
});
