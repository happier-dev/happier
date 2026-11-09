import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';

import {
  bindVoiceRuntimeAttemptBinding,
  createVoiceRuntimeAttemptBindingOwner,
  createVoiceSessionBindingStore,
  unbindVoiceRuntimeAttemptBindingIfOwned,
} from './voiceConversationBindingStore';

// Transform the real storage/resolver graph as suite setup, outside the cost scenario.
const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

describe('createVoiceSessionBindingStore', () => {
  it('refreshes admitted lookup metadata when a retained Home spelling becomes canonical', async () => {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const profile = await profiles.upsertServerProfile({ serverUrl: 'https://voice-perf-binding.example.test', source: 'manual' });
    const canonicalHome = 'srv_voice_perf_binding';
    try {
      const store = createVoiceSessionBindingStore();
      const metadata = writeVoiceConversationBindingMetadata(
        { path: '/voice', host: 'test', ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        { adapterId: 'local_conversation', controlSessionId: 'voice-global', conversationSessionId: 'carrier-alias',
          conversationSessionAddress: { serverId: canonicalHome, sessionId: 'carrier-alias' },
          transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1 },
      );
      const state = {
        sessions: { 'carrier-alias': createSessionFixture({ id: 'carrier-alias', serverId: profile.id, metadata: null }) },
        sessionListRowsByServerId: { [canonicalHome]: {
          'carrier-alias': createSessionListRenderableSessionFixture({ id: 'carrier-alias', metadata }),
        } },
      };
      syncPersistedVoiceConversationBindings({ state, store });
      expect(store.getState().getByControlSessionId('voice-global')).toBeNull();
      await profiles.setServerProfileIdentityForUrl(profile.serverUrl, canonicalHome);
      syncPersistedVoiceConversationBindings({ state, store });
      expect(store.getState().getByControlSessionId('voice-global')?.conversationSessionId).toBe('carrier-alias');
    } finally {
      const installed = profiles.getServerProfileById(profile.id) ?? profiles.getServerProfileById(canonicalHome);
      if (installed) await profiles.removeServerProfile(installed.id);
    }
  });

  it('does not revisit a thousand retained Sessions for unrelated storage arrivals', async () => {
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const store = createVoiceSessionBindingStore();
    const binding = {
      adapterId: 'local_conversation', controlSessionId: 'voice-global',
      conversationSessionId: 'carrier',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier' },
      transcriptMode: 'synthetic' as const, targetSessionAddress: null, updatedAt: 1,
    };
    let inventoryScans = 0;
    const retained = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `session-${index}`, createSessionFixture({ id: `session-${index}`, serverId: 'server-1' }),
    ]));
    const carrier = createSessionFixture({ id: 'carrier', serverId: 'server-1', metadata:
      writeVoiceConversationBindingMetadata({ path: '/voice', host: 'test', ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) }, binding),
    });
    const sessions = new Proxy({ ...retained, carrier }, {
      ownKeys(target) { inventoryScans += 1; return Reflect.ownKeys(target); },
    });
    let state = { sessions, unrelatedArrival: 0 };
    const resolver = createVoiceConversationBindingResolver({ getState: () => state, store });
    syncPersistedVoiceConversationBindings({ state, store });
    expect(resolver.resolveByControlSessionId({ controlSessionId: 'voice-global' })).toEqual(binding);
    inventoryScans = 0;
    for (let index = 0; index < 20; index += 1) {
      state = { ...state, unrelatedArrival: index + 1 };
      syncPersistedVoiceConversationBindings({ state, store });
      expect(resolver.resolveByControlSessionId({ controlSessionId: 'voice-global' })).toEqual(binding);
      expect(resolver.resolveByConversationSessionId({ conversationSessionId: 'carrier' })).toEqual(binding);
      expect(resolver.resolveLatest()).toEqual(binding);
    }
    expect(inventoryScans).toBe(0);

    // A real metadata withdrawal must still retire the discovery immediately.
    state = { ...state, sessions: { ...sessions, carrier: { ...carrier, metadata: null } } };
    syncPersistedVoiceConversationBindings({ state, store });
    expect(resolver.resolveByControlSessionId({ controlSessionId: 'voice-global' })).toBeNull();
  });

  it('patches binding discovery from real Session publications without revisiting retained rows', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const initial = storage.getState();
    const store = createVoiceSessionBindingStore();
    let metadataVisits = 0;
    let inventoryScans = 0;
    const carrier = (id: string, controlSessionId: string, updatedAt: number) => createSessionFixture({
      id, serverId: 'server-1', metadata: writeVoiceConversationBindingMetadata(
        { path: '/voice', host: 'test', ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        { adapterId: 'local_conversation', controlSessionId, conversationSessionId: id,
          conversationSessionAddress: { serverId: 'server-1', sessionId: id },
          transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt },
      ),
    });
    const sessions = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
      const id = `session-${index}`;
      const row = index < 100 ? carrier(id, `control-${index}`, 1) : createSessionFixture({ id, serverId: 'server-1' });
      return [id, new Proxy(row, {
        get(target, key, receiver) {
          if (index < 100 && key === 'metadata') metadataVisits += 1;
          return Reflect.get(target, key, receiver);
        },
      })];
    }));
    let notifications = 0;
    const stop = store.subscribe(() => { notifications += 1; });
    let previousPublication: ReturnType<typeof storage.getState> | undefined;
    const publish = () => {
      const state = storage.getState();
      // Observe ingestion separately from the publisher's immutable map construction.
      const observed = {
        ...state, sessions: new Proxy(state.sessions, {
          ownKeys(target) { inventoryScans += 1; return Reflect.ownKeys(target); },
        }),
      };
      syncPersistedVoiceConversationBindings({ store, state: observed, previousState: previousPublication });
      previousPublication = observed;
      return observed;
    };
    try {
      storage.setState({ sessions, sessionListRowsByServerId: {} });
      let published = publish();
      const before = store.getState();
      const admittedRows = store.getState().readPersistedBindings(published);
      notifications = 0;
      let previousSessions = storage.getState().sessions;
      for (let index = 0; index < 20; index += 1) {
        metadataVisits = 0;
        if (index % 2 === 0) storage.getState().markSessionResuming('session-999');
        else storage.getState().clearSessionResuming('session-999');
        expect(storage.getState().sessions).not.toBe(previousSessions);
        previousSessions = storage.getState().sessions;
        inventoryScans = 0;
        published = publish();
        expect(inventoryScans).toBe(0);
        expect(metadataVisits).toBe(0);
        expect(store.getState().readPersistedBindings(published)).toBe(admittedRows);
      }
      for (const update of [
        () => storage.getState().markSessionOptimisticThinking('session-999'),
        () => storage.getState().clearSessionOptimisticThinking('session-999'),
        () => storage.getState().applySessionTerminalLifecycle('session-999', 100),
        () => storage.getState().updateSessionPermissionMode('session-999', 'default'),
        () => storage.getState().updateSessionModelMode('session-999', 'default'),
        () => storage.getState().applyMessages('session-999', [{
          id: 'ordinary-message', seq: 2, localId: null, createdAt: 100,
          isSidechain: false, role: 'agent',
          content: [{ type: 'text', text: 'Ordinary activity', uuid: 'ordinary-message', parentUUID: null }],
        }]),
      ]) {
        metadataVisits = 0;
        previousSessions = storage.getState().sessions;
        update();
        expect(storage.getState().sessions).not.toBe(previousSessions);
        inventoryScans = 0;
        published = publish();
        expect(inventoryScans).toBe(0);
        expect(metadataVisits).toBe(0);
        expect(store.getState().readPersistedBindings(published)).toBe(admittedRows);
      }

      expect(notifications).toBe(0);
      expect(store.getState()).toBe(before);

      // A real metadata advance replaces one binding; the other 99 keep their identity.
      let retainedBindingVisits = 0;
      for (const binding of admittedRows) {
        if (binding.conversationSessionId === 'session-0') continue;
        const updatedAt = binding.updatedAt;
        Object.defineProperty(binding, 'updatedAt', { get() { retainedBindingVisits += 1; return updatedAt; } });
      }
      storage.getState().applySessions([carrier('session-0', 'control-0', 2)]);
      publish();
      expect.soft(retainedBindingVisits).toBe(0);
      expect(store.getState().getByControlSessionId('control-0')?.updatedAt).toBe(2);
      expect(Object.entries(before.persistedBindingsByConversationSessionId).filter(([id, row]) =>
        store.getState().persistedBindingsByConversationSessionId[id] !== row)).toHaveLength(1);
      expect(notifications).toBe(1);
      storage.getState().applySessions([createSessionFixture({ id: 'session-0', serverId: 'server-1', metadata: null })]);
      publish();
      expect.soft(retainedBindingVisits).toBe(0);
      expect(store.getState().getByControlSessionId('control-0')).toBeNull();
      expect(notifications).toBe(2);

      // The natural grace-expiry publication must stay as narrow as explicit clearing.
      vi.useFakeTimers();
      const ordinary = storage.getState().sessions['session-999'];
      storage.getState().applySessions([{ ...ordinary, presence: 'online', thinking: true, thinkingAt: Date.now(), updatedAt: Date.now() }]);
      publish();
      storage.getState().applySessions([{ ...storage.getState().sessions['session-999'],
        presence: 'online', thinking: false, thinkingAt: Date.now() + 1, updatedAt: Date.now() + 1 }]);
      published = publish();
      const graceUntil = storage.getState().sessions['session-999'].thinkingGraceUntil;
      expect(graceUntil).toBeTypeOf('number');
      previousSessions = storage.getState().sessions;
      vi.advanceTimersByTime(graceUntil! - Date.now());
      expect(storage.getState().sessions).not.toBe(previousSessions);
      expect(storage.getState().sessions['session-999'].thinkingGraceUntil).toBeNull();
      metadataVisits = 0;
      inventoryScans = 0;
      published = publish();
      expect(inventoryScans).toBe(0);
      expect(metadataVisits).toBe(0);
      expect(notifications).toBe(2);
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      stop();
      storage.setState(initial, true);
    }
  });

  it('does not notify subscribers when a storage refresh has equivalent persisted bindings', () => {
    const store = createVoiceSessionBindingStore();
    const binding = {
      adapterId: 'local_conversation', controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-a' },
      transcriptMode: 'synthetic' as const, targetSessionAddress: null, updatedAt: 1,
    };
    store.getState().replacePersistedBindings([binding]);
    const admitted = store.getState();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.getState().replacePersistedBindings([{ ...binding }]);
    expect(store.getState()).toBe(admitted);
    expect(notifications).toBe(0);

    store.getState().replacePersistedBindings([binding, {
      ...binding, controlSessionId: 'voice-other', conversationSessionId: 'carrier-b',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-b' },
    }]);
    expect(notifications).toBe(1);
    expect(store.getState().persistedBindingsByConversationSessionId['carrier-a'])
      .toBe(admitted.persistedBindingsByConversationSessionId['carrier-a']);
    store.getState().replacePersistedBindings([]);
    expect(store.getState().list()).toEqual([]);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('does not publish equivalent runtime admission or removal of an absent binding', () => {
    const store = createVoiceSessionBindingStore();
    const binding = {
      adapterId: 'local_conversation', controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-a' },
      transcriptMode: 'synthetic' as const, targetSessionAddress: null, updatedAt: 1,
    };
    store.getState().bind(binding);
    const admitted = store.getState();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.getState().bind({ ...binding });
    store.getState().unbind('absent');
    expect(store.getState()).toBe(admitted);
    expect(notifications).toBe(0);
    store.getState().bind({ ...binding, updatedAt: 2 });
    expect(store.getState().getByConversationSessionId('carrier-a')?.updatedAt).toBe(2);
    expect(notifications).toBe(1);
    store.getState().unbind('carrier-a');
    expect(store.getState().list()).toEqual([]);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('replaces stale bindings that reuse the same control session id', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-a' },
      transcriptMode: 'synthetic',
      targetSessionAddress: { serverId: 'server-1', sessionId: 's1' },
      updatedAt: 1,
    });

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-b',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-b' },
      transcriptMode: 'synthetic',
      targetSessionAddress: { serverId: 'server-1', sessionId: 's2' },
      updatedAt: 2,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toBeNull();
    expect(store.getState().getByConversationSessionId('carrier-b')).toEqual(
      expect.objectContaining({
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-b',
        targetSessionAddress: { serverId: 'server-1', sessionId: 's2' },
      }),
    );
    expect(store.getState().list()).toHaveLength(1);
  });

  it('returns the newest matching binding from getByControlSessionId when several share a control session id', async () => {
    const store = createVoiceSessionBindingStore();
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');

    // Two persisted bindings on distinct conversation sessions share one control
    // session id (e.g. the global voice control session bound to two conversations
    // across reconnects). The newest by updatedAt must win.
    syncPersistedVoiceConversationBindings({
      store,
      state: {
        sessions: {
          'carrier-old': createSessionFixture({
            id: 'carrier-old',
            serverId: 'server-old',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-old',
                conversationSessionAddress: { serverId: 'server-old', sessionId: 'carrier-old' },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: 'server-old', sessionId: 's-old' },
                updatedAt: 100,
              },
            ),
          }),
          'carrier-new': createSessionFixture({
            id: 'carrier-new',
            serverId: 'server-new',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-new',
                conversationSessionAddress: { serverId: 'server-new', sessionId: 'carrier-new' },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: 'server-new', sessionId: 's-new' },
                updatedAt: 200,
              },
            ),
          }),
        },
      },
    });

    expect(store.getState().getByControlSessionId('__voice_agent__')).toEqual(
      expect.objectContaining({
        conversationSessionId: 'carrier-new',
        targetSessionAddress: { serverId: 'server-new', sessionId: 's-new' },
        updatedAt: 200,
      }),
    );
  });

  it('keeps the canonical control-slot winner across incremental withdrawals and full replacement', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const initial = storage.getState();
    const store = createVoiceSessionBindingStore();
    const carrier = (id: string, updatedAt: number) => createSessionFixture({
      id, serverId: 'server-1', metadata: writeVoiceConversationBindingMetadata(
        { path: '/voice', host: 'test', ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        { adapterId: 'local_conversation', controlSessionId: 'voice-global', conversationSessionId: id,
          conversationSessionAddress: { serverId: 'server-1', sessionId: id },
          transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt },
      ),
    });
    let previousPublication: ReturnType<typeof storage.getState> | undefined;
    const publish = () => {
      const state = storage.getState();
      syncPersistedVoiceConversationBindings({ store, state, previousState: previousPublication });
      previousPublication = state;
    };
    try {
      storage.setState({ sessions: { z: carrier('z', 2), a: carrier('a', 1) }, sessionListRowsByServerId: {} });
      publish();
      expect(store.getState().getByControlSessionId('voice-global')?.conversationSessionId).toBe('z');
      storage.getState().applySessions([carrier('a', 2)]);
      publish();
      expect(store.getState().getByControlSessionId('voice-global')?.conversationSessionId).toBe('z');
      storage.getState().applySessions([createSessionFixture({ id: 'z', serverId: 'server-1', metadata: null })]);
      publish();
      expect(store.getState().getByControlSessionId('voice-global')?.conversationSessionId).toBe('a');
      // No delta accompanies a structural replacement: every removed binding must disappear.
      storage.setState({ sessions: {} });
      publish();
      expect(store.getState().list()).toEqual([]);
    } finally {
      storage.setState(initial, true);
    }
  });

  it('canonicalizes binding ids when storing and looking up bindings', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: '  local_conversation  ',
      controlSessionId: '  voice-global  ',
      conversationSessionId: '  carrier-a  ',
      conversationSessionAddress: { serverId: '  server-1  ', sessionId: '  carrier-a  ' },
      transcriptMode: 'synthetic',
      targetSessionAddress: { serverId: '  server-1  ', sessionId: '  s1  ' },
      updatedAt: 1,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toEqual(
      expect.objectContaining({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-a',
        targetSessionAddress: { serverId: 'server-1', sessionId: 's1' },
      }),
    );
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(
      expect.objectContaining({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-a',
        targetSessionAddress: { serverId: 'server-1', sessionId: 's1' },
      }),
    );
  });

  it('syncs persisted bindings from direct session metadata when lookup metadata does not carry the voice binding', async () => {
    const store = createVoiceSessionBindingStore();
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');

    syncPersistedVoiceConversationBindings({
      store,
      state: {
        sessions: {
          'carrier-s1': createSessionFixture({
            id: 'carrier-s1',
            serverId: 'srv-1',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-s1',
                conversationSessionAddress: { serverId: 'srv-1', sessionId: 'carrier-s1' },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: 'srv-1', sessionId: 'root-s1' },
                updatedAt: 10,
              },
            ),
          }),
        },
        sessionListIndexByServerId: {
          'srv-1': [{ type: 'session', sessionId: 'carrier-s1', serverId: 'srv-1', serverName: 'Primary' }],
        },
        sessionListRowsByServerId: {
          'srv-1': {
            'carrier-s1': createSessionListRenderableSessionFixture({
              id: 'carrier-s1',
              metadata: { ...createSessionFixture().metadata!, summaryText: 'Cached shell metadata only', path: '/tmp/carrier-s1' },
            }),
          },
        },
        ordinarySessionListMembershipByServerId: { 'srv-1': ['carrier-s1'] },
      },
    });

    expect(
      store.getState().getByControlSessionId('__voice_agent__'),
    ).toEqual(
      expect.objectContaining({
        adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        conversationSessionId: 'carrier-s1',
        targetSessionAddress: { serverId: 'srv-1', sessionId: 'root-s1' },
      }),
    );
  });

  it('syncs a layout-v1 binding only from the owner metadata view', async () => {
    const store = createVoiceSessionBindingStore();
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const binding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'carrier-owner',
      conversationSessionAddress: { serverId: 'srv-owner', sessionId: 'carrier-owner' },
      transcriptMode: 'native_session' as const,
      targetSessionAddress: { serverId: 'srv-owner', sessionId: 'owner-target' },
      updatedAt: 20,
    };

    const session = createSessionFixture({
      id: 'carrier-owner',
      serverId: 'srv-owner',
      metadataLayoutVersion: 1,
      metadata: writeVoiceConversationBindingMetadata(
        { ...createSessionFixture().metadata!, v: 1, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        { ...binding, targetSessionAddress: { serverId: 'srv-owner', sessionId: 'shared-private-lookalike' } },
      ),
      ownerMetadataView: writeVoiceConversationBindingMetadata(
        { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        binding,
      ),
    });
    const state = {
      sessions: {
        'carrier-owner': session,
      },
    };
    syncPersistedVoiceConversationBindings({
      store,
      state,
    });

    expect(store.getState().getByControlSessionId('__voice_agent__')?.targetSessionAddress).toEqual({
      serverId: 'srv-owner',
      sessionId: 'owner-target',
    });

    const withdrawnSession = { ...session, ownerMetadataView: null };
    syncPersistedVoiceConversationBindings({ store, state: {
      ...state,
      sessions: { ...state.sessions, 'carrier-owner': withdrawnSession },
    } });
    expect(store.getState().getByControlSessionId('__voice_agent__')).toBeNull();
  });

  it('does not let stale direct-media cleanup unbind a same-carrier replacement with an equal timestamp', () => {
    const store = createVoiceSessionBindingStore();
    const retiredOwner = createVoiceRuntimeAttemptBindingOwner();
    const replacementOwner = createVoiceRuntimeAttemptBindingOwner();
    const binding = {
      adapterId: 'happier.voice.openai/realtime-openai',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-history-reused-carrier',
      conversationSessionAddress: { serverId: 'server-a', sessionId: 'voice-history-reused-carrier' },
      lifetime: 'runtime_attempt' as const,
      transcriptMode: 'synthetic' as const,
      targetSessionAddress: null,
      updatedAt: 42,
    };

    bindVoiceRuntimeAttemptBinding({
      store,
      owner: retiredOwner,
      binding,
    });
    bindVoiceRuntimeAttemptBinding({
      store,
      owner: replacementOwner,
      binding,
    });

    expect(unbindVoiceRuntimeAttemptBindingIfOwned({
      store,
      owner: retiredOwner,
      conversationSessionId: binding.conversationSessionId,
    })).toBe(false);
    expect(store.getState().getByConversationSessionId(
      binding.conversationSessionId,
    )).toMatchObject(binding);
    expect(unbindVoiceRuntimeAttemptBindingIfOwned({
      store,
      owner: replacementOwner,
      conversationSessionId: binding.conversationSessionId,
    })).toBe(true);
    expect(store.getState().getByConversationSessionId(
      binding.conversationSessionId,
    )).toBeNull();
  });

  it('keeps local custody over newer synced control-slot bindings and reveals discovery after exact cleanup', async () => {
    const store = createVoiceSessionBindingStore();
    const owner = createVoiceRuntimeAttemptBindingOwner();
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const runtimeBinding = {
      adapterId: 'happier.voice.openai/realtime-openai',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'runtime-carrier-a',
      conversationSessionAddress: { serverId: 'server-a', sessionId: 'runtime-carrier-a' },
      lifetime: 'runtime_attempt' as const,
      transcriptMode: 'synthetic' as const,
      targetSessionAddress: null,
      updatedAt: 10,
    };

    bindVoiceRuntimeAttemptBinding({
      store,
      owner,
      binding: runtimeBinding,
    });
    const locallyAdmittedBindings = store.getState().bindingsByConversationSessionId;
    syncPersistedVoiceConversationBindings({
      store,
      state: {
        sessions: {
          'persisted-carrier-b': createSessionFixture({
            id: 'persisted-carrier-b',
            serverId: 'server-a',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                ...runtimeBinding,
                conversationSessionId: 'persisted-carrier-b',
                conversationSessionAddress: { serverId: 'server-a', sessionId: 'persisted-carrier-b' },
                lifetime: undefined,
                updatedAt: 20,
              },
            ),
          }),
        },
      },
    });

    expect(store.getState().getByControlSessionId(runtimeBinding.controlSessionId))
      .toMatchObject({ conversationSessionId: 'runtime-carrier-a' });
    expect(store.getState().bindingsByConversationSessionId).toBe(locallyAdmittedBindings);
    expect(unbindVoiceRuntimeAttemptBindingIfOwned({
      store,
      owner,
      conversationSessionId: runtimeBinding.conversationSessionId,
    })).toBe(true);

    expect(store.getState().getByControlSessionId(runtimeBinding.controlSessionId))
      .toMatchObject({ conversationSessionId: 'persisted-carrier-b' });

    syncPersistedVoiceConversationBindings({ store, state: { sessions: {} } });

    expect(store.getState().getByConversationSessionId(
      runtimeBinding.conversationSessionId,
    )).toBeNull();
    expect(store.getState().getByControlSessionId(runtimeBinding.controlSessionId)).toBeNull();
  });
});
