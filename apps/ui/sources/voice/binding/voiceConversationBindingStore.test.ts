import { describe, expect, it } from 'vitest';

import { createVoiceSessionBindingStore } from './voiceConversationBindingStore';

describe('createVoiceSessionBindingStore', () => {
  it('replaces stale bindings that reuse the same control session id', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-b',
      transcriptMode: 'synthetic',
      targetSessionId: 's2',
      updatedAt: 2,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toBeNull();
    expect(store.getState().getByConversationSessionId('carrier-b')).toEqual(
      expect.objectContaining({
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-b',
        targetSessionId: 's2',
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
          'carrier-old': {
            metadata: writeVoiceConversationBindingMetadata(
              { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
              {
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-old',
                transcriptMode: 'synthetic',
                targetSessionId: 's-old',
                updatedAt: 100,
              },
            ),
          },
          'carrier-new': {
            metadata: writeVoiceConversationBindingMetadata(
              { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
              {
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-new',
                transcriptMode: 'synthetic',
                targetSessionId: 's-new',
                updatedAt: 200,
              },
            ),
          },
        },
      } as any,
    });

    expect(store.getState().getByControlSessionId('__voice_agent__')).toEqual(
      expect.objectContaining({
        conversationSessionId: 'carrier-new',
        targetSessionId: 's-new',
        updatedAt: 200,
      }),
    );
  });

  it('canonicalizes binding ids when storing and looking up bindings', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: '  local_conversation  ',
      controlSessionId: '  voice-global  ',
      conversationSessionId: '  carrier-a  ',
      transcriptMode: 'synthetic',
      targetSessionId: '  s1  ',
      updatedAt: 1,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toEqual(
      expect.objectContaining({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-a',
        targetSessionId: 's1',
      }),
    );
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(
      expect.objectContaining({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-a',
        targetSessionId: 's1',
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
          'carrier-s1': {
            serverId: 'srv-1',
            metadata: writeVoiceConversationBindingMetadata(
              { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
              {
                adapterId: 'realtime_elevenlabs',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-s1',
                transcriptMode: 'synthetic',
                targetSessionId: 'root-s1',
                updatedAt: 10,
              },
            ),
          },
        },
        sessionListIndexByServerId: {
          'srv-1': [{ type: 'session', sessionId: 'carrier-s1', serverId: 'srv-1', serverName: 'Primary' }],
        },
        sessionListRenderables: {
          'carrier-s1': {
            id: 'carrier-s1',
            seq: 1,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: { summaryText: 'Cached shell metadata only', path: '/tmp/carrier-s1' },
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
          },
        },
      },
    });

    expect(
      store.getState().getByControlSessionId('__voice_agent__'),
    ).toEqual(
      expect.objectContaining({
        adapterId: 'realtime_elevenlabs',
        conversationSessionId: 'carrier-s1',
        targetSessionId: 'root-s1',
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
      transcriptMode: 'native_session' as const,
      targetSessionId: 'owner-target',
      updatedAt: 20,
    };

    const state = {
      sessions: {
        'carrier-owner': {
          metadataLayoutVersion: 1,
          metadata: writeVoiceConversationBindingMetadata(
            { v: 1, systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
            { ...binding, targetSessionId: 'shared-private-lookalike' },
          ),
          ownerMetadataView: writeVoiceConversationBindingMetadata(
            { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
            binding,
          ),
        },
      },
    };
    syncPersistedVoiceConversationBindings({
      store,
      state: state as any,
    });

    expect(store.getState().getByControlSessionId('__voice_agent__')?.targetSessionId).toBe('owner-target');

    state.sessions['carrier-owner'].ownerMetadataView = null as any;
    syncPersistedVoiceConversationBindings({ store, state: state as any });
    expect(store.getState().getByControlSessionId('__voice_agent__')).toBeNull();
  });
});
