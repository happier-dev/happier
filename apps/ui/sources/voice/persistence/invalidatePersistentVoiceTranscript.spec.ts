import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

afterEach(() => standardCleanup());
// Cold module transformation belongs to suite setup, not the first Forget's
// operation lifetime. Socket transport is installed by the hoisted boundary.
beforeAll(async () => { await loadSyncSingletonForTests(); });

describe('invalidatePersistentVoiceTranscript', () => {
  it.each(['plain', 'e2ee'] as const)('forgets across carriers in %s memory without writing Account preferences', async mode => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    // 0.2 HEAD 420e7887: voice.adapters.local_conversation.agent.transcript.
    const raw = { voice: {
      assistantLanguage: 'fr', privacy: { shareToolNames: false },
      adapters: { local_conversation: { agent: { transcript: { persistenceMode: 'persistent', epoch: 2 } } } },
    } };
    const account = await createVoiceSettingsAccountTestHarness(settingsParse(raw), { mode, rawSettings: raw });
    onTestFinished(account.dispose);
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');
    const { sync } = await import('@/sync/sync');
    // Account bootstrap may normalize retained 0.2 settings. Settle that separate
    // mutation before measuring the explicit Forget intent.
    await (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue();
    const initialWrites = account.writes.length;
    const initialRawSettings = account.persistedRawSettings;
    const { readLegacyVoiceTranscriptEpoch } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    expect(readLegacyVoiceTranscriptEpoch(initialRawSettings)).toBe(2);

    expect(await invalidatePersistentVoiceTranscript(account.scope)).toBe(3);
    await (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue();
    // Forget is transcript lifecycle state, never an Account-preference mutation.
    expect(account.writes).toHaveLength(initialWrites);
    const { readPersistentVoiceTranscriptEpoch, VOICE_TRANSCRIPT_MEMORY_KEY } = await import('./voiceTranscriptMemory');
    const rowRequests = account.kv.readRequests().filter(request => request.path.endsWith(encodeURIComponent(VOICE_TRANSCRIPT_MEMORY_KEY))).length;
    // Initialization on every carrier consumes the same acknowledged boundary.
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(3);
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(3);
    expect(account.kv.readRequests().filter(request => request.path.endsWith(encodeURIComponent(VOICE_TRANSCRIPT_MEMORY_KEY)))).toHaveLength(rowRequests + 2);
    expect(await invalidatePersistentVoiceTranscript(account.scope)).toBe(4);
    expect(account.writes).toHaveLength(initialWrites);
    expect(account.persistedRawSettings).toEqual(initialRawSettings);
    expect(account.kv.readRequests().filter(request => request.method === 'POST')).toHaveLength(2);

    // An obsolete captured Account must not change the currently mounted one.
    const before = account.settings;
    const writes = account.writes.length;
    const kvRequests = account.kv.readRequests().length;
    expect(await invalidatePersistentVoiceTranscript({ ...account.scope, accountId: 'other-account' })).toBeNull();
    await (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue();
    expect(account.settings).toBe(before);
    expect(account.writes).toHaveLength(writes);
    expect(account.kv.readRequests()).toHaveLength(kvRequests);
  });

  it('does not read or write memory for an ephemeral Forget', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');
    expect(await invalidatePersistentVoiceTranscript(account.scope)).toBeNull();
    expect(account.writes).toEqual([]);
    expect(account.kv.readRequests().filter(request => request.path.includes('voice'))).toEqual([]);
  });

  it('reconciles concurrent Forget intents through the existing row CAS', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providers: {
      local_conversation: { schemaVersion: 1, config: { agent: { transcript: { persistenceMode: 'persistent' } } } },
    } } }));
    onTestFinished(account.dispose);
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');
    const values = await Promise.all([invalidatePersistentVoiceTranscript(account.scope), invalidatePersistentVoiceTranscript(account.scope)]);
    expect(values.sort()).toEqual([1, 2]);
    const { readPersistentVoiceTranscriptEpoch } = await import('./voiceTranscriptMemory');
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(2);
    expect(account.writes).toHaveLength(0);
  });

  it('refuses malformed stored memory without overwriting it or falling back to preferences', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providers: {
      local_conversation: { schemaVersion: 1, config: { agent: { transcript: { persistenceMode: 'persistent' } } } },
    } } }));
    onTestFinished(account.dispose);
    const { VOICE_TRANSCRIPT_MEMORY_KEY } = await import('./voiceTranscriptMemory');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    await account.kv.handleFetch('https://fixture.test/v1/kv', { method: 'POST', body: JSON.stringify({ mutations: [{
      key: VOICE_TRANSCRIPT_MEMORY_KEY, version: -1,
      value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, epoch: 'corrupt' } }),
    }] }) });
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');
    await expect(invalidatePersistentVoiceTranscript(account.scope)).rejects.toThrow();
    expect(account.kv.readRequests().filter(request => request.method === 'POST')).toHaveLength(1);
    expect(account.writes).toHaveLength(0);
  });
});
