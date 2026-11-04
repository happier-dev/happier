import { waitForTestEvent } from '@/dev/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXaiVoiceRuntimeEnvironment, XaiVoiceWebSocket as FakeWebSocket, XAI_VOICE_HISTORY_SESSION_ID as XAI_HISTORY_SESSION_ID, type XaiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/xaiVoiceRuntime';
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (
  await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-audio', async () => (
  await import('@/dev/testkit/mocks/expoAudio')
).expoAudioModuleMock());
import { createSessionFixture } from "@/dev/testkit/fixtures/sessionFixtures";
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { getActiveServerSnapshot } from "@/sync/domains/server/serverRuntime";
import { storage } from "@/sync/domains/state/storage";
import { readVoiceSettingsInput, voiceSettingsParse } from "@/sync/domains/settings/voiceSettings";
import { normalizeVoiceSettingsLocalDelta } from "@/sync/domains/settings/voiceSettingsPersistence";
import { sync } from "@/sync/sync";
import { voiceSessionBindingManager } from "@/voice/binding/voiceConversationBindingRuntime";
import { voiceSessionBindingStore } from "@/voice/binding/voiceConversationBindingStore";
import { readVoiceProviderConversationMetadata, writeVoiceProviderConversationMetadata } from "@/voice/persistence/voiceProviderConversationMetadata";
import { performVoiceAdapterRuntimeAction } from "@/voice/session/voiceAdapterRegistry";
import { readCanonicalVoiceTranscriptSnapshot } from "@/voice/transcript/voiceConversationTranscript";
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

let environment: XaiVoiceRuntimeEnvironment;

describe('realtime_grok source-composed direct-media persistence gate', () => {
  beforeEach(async () => {
    environment = await createXaiVoiceRuntimeEnvironment();
  });

  afterEach(async () => {
    await environment.dispose();
    vi.restoreAllMocks();
  });

  it('refreshes expired xAI client authority while retaining the actually persisted provider conversation', async () => {
    await environment.installSettings(true);
    const composed = await environment.createRuntime();
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      const first = FakeWebSocket.instances[0]!;
      first.emitConversationId('conv-auth-refresh');
      await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID), environment.xaiEntry().providerId,
      )?.conversationId).toBe('conv-auth-refresh'));
      first.emit('message', { data: JSON.stringify({
        type: 'error', event_id: 'auth-expiration-initial', error: { code: 'client_secret_expired' },
      }) });
      await waitForTestEvent(FakeWebSocket.subscribe, () => expect(FakeWebSocket.instances).toHaveLength(2));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(composed.runtime.adapter.getSnapshot().status).toBe('connected'));
      const replacement = FakeWebSocket.instances[1]!;
      expect(new URL(replacement.url).searchParams.get('conversation_id')).toBe('conv-auth-refresh');
      expect(composed.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(2);
      expect(first.readyState).toBe(3);
      expect(replacement.readyState).toBe(FakeWebSocket.OPEN);
      expect(composed.getController().getOwnedAttemptId()).not.toBeNull();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it.each(['first_message_after_open', 'after_reconnect_settles'] as const)(
    'paces repeated successful xAI auth refresh through visible cancellable backoff (%s)', async timing => {
      await environment.installSettings(true);
      const composed = await environment.createRuntime();
      const emitSecondExpiration = (socket: FakeWebSocket) => socket.emit('message', { data: JSON.stringify({
        type: 'error', event_id: `auth-expiration-${FakeWebSocket.instances.indexOf(socket)}`,
        error: { code: 'client_secret_expired' },
      }) });
      const emit = FakeWebSocket.prototype.emit;
      if (timing === 'first_message_after_open') {
        vi.spyOn(FakeWebSocket.prototype, 'emit').mockImplementation(function (this: FakeWebSocket, type, event) {
          emit.call(this, type, event);
          if (type === 'open' && FakeWebSocket.instances[1] === this) emitSecondExpiration(this);
        });
      }
      try {
        await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
        const first = FakeWebSocket.instances[0]!;
        const attemptId = composed.getController().getOwnedAttemptId();
        first.emitConversationId('conv-auth-refresh-repeated');
        await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
          environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID), environment.xaiEntry().providerId,
        )?.conversationId).toBe('conv-auth-refresh-repeated'));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const backoffMs = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs;
        first.emit('message', { data: JSON.stringify({
          type: 'error', event_id: 'auth-expiration-first', error: { code: 'client_secret_expired' },
        }) });
        await vi.advanceTimersByTimeAsync(backoffMs);
        expect(FakeWebSocket.instances).toHaveLength(2);
        const second = FakeWebSocket.instances[1]!;
        // The WebSocket boundary dispatches open/message in later tasks,
        // after the reconnect slot constructs the replacement socket.
        await vi.advanceTimersByTimeAsync(1);
        if (timing === 'after_reconnect_settles') {
          await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(composed.runtime.adapter.getSnapshot().status).toBe('connected'));
          emitSecondExpiration(second);
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          presentationState: 'reconnecting', reconnectRetryAvailable: true, canStop: true,
        });
        // A newly issued credential rejected again waits on the same visible
        // scheduler; successful refresh must not create a hot reconnect loop.
        await vi.advanceTimersByTimeAsync(backoffMs - 2);
        expect(FakeWebSocket.instances).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeWebSocket.instances).toHaveLength(3);
        const third = FakeWebSocket.instances[2]!;
        expect(new URL(third.url).searchParams.get('conversation_id')).toBe('conv-auth-refresh-repeated');
        await vi.advanceTimersByTimeAsync(1);
        await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(composed.runtime.adapter.getSnapshot().status).toBe('connected'));
        expect(composed.getController().getOwnedAttemptId()).toBe(attemptId);
        emitSecondExpiration(third);
        await vi.advanceTimersByTimeAsync(0);
        expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
        // A deliberate Start replaces the retrying attempt without awaiting
        // its backoff. Fresh admission uses the real Account/transport owners.
        vi.useRealTimers();
        await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
        expect(composed.getController().getOwnedAttemptId()).not.toBe(attemptId);
        expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
        const fresh = FakeWebSocket.instances.at(-1)!;
        expect(fresh).not.toBe(third);
        const openedAfterStart = FakeWebSocket.instances.length;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        emitSecondExpiration(fresh);
        await vi.advanceTimersByTimeAsync(0);
        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          presentationState: 'reconnecting', reconnectRetryAvailable: true, canStop: true,
        });
        await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
        await vi.advanceTimersByTimeAsync(backoffMs);
        expect(FakeWebSocket.instances).toHaveLength(openedAfterStart);
        expect(composed.getController().getOwnedAttemptId()).toBeNull();
      } finally {
        vi.useRealTimers();
        await composed.runtime.dispose();
        composed.hostLease.revoke();
      }
    },
  );

  it.each([
    [true, 'buffer_full'], [false, 'buffer_full'], [true, 'closed_after_send'],
  ] as const)('keeps settled xAI tool custody only when actual preparation retains the provider conversation (%s/%s)', async (resumed, transportLoss) => {
    await environment.installSettings(true);
    storage.setState(current => {
      const voice = voiceSettingsParse(readVoiceSettingsInput(current.settings));
      const next = { ...voice, privacy: { ...voice.privacy, shareDeviceInventory: true } };
      return { settings: { ...current.settings, ...normalizeVoiceSettingsLocalDelta({ voice: next }, current.settings) } };
    });
    const composed = await environment.createRuntime();
    const inventoryRequest = vi.fn(async () => {
      // The actual xAI driver, not a replaced sendControl decision, observes
      // the browser SDK's full send buffer before attempting result delivery.
      if (transportLoss === 'buffer_full') FakeWebSocket.instances[0]!.bufferedAmount = 512 * 1024 + 1;
      return Response.json([]);
    });
    const deliveryAttempts: string[] = [];
    const send = FakeWebSocket.prototype.send;
    vi.spyOn(FakeWebSocket.prototype, 'send').mockImplementation(function (this: FakeWebSocket, value) {
      const event = JSON.parse(value);
      if (this === FakeWebSocket.instances[0] && event.item?.type === 'function_call_output') {
        deliveryAttempts.push(event.item.call_id);
        send.call(this, value);
        if (transportLoss === 'closed_after_send') this.emit('close', { code: 1006, reason: '' });
        return;
      }
      send.call(this, value);
    });
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected' });
      const first = FakeWebSocket.instances[0]!;
      first.emitConversationId('conv-stable-tool');
      await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID), environment.xaiEntry().providerId,
      )?.conversationId).toBe('conv-stable-tool'));
      if (!resumed) {
        // The declaration remains resumable, but the actual current saved
        // settings tell the provider producer to create a fresh conversation.
        storage.setState(current => {
          const voice = voiceSettingsParse(readVoiceSettingsInput(current.settings));
          const providerId = environment.xaiEntry().providerId;
          const saved = voice.providers[providerId]!;
          const next = { ...voice, providers: { ...voice.providers, [providerId]: { ...saved,
            config: { ...saved.config as Readonly<Record<string, unknown>>, resumptionEnabled: false },
          } } };
          return { settings: { ...current.settings, ...normalizeVoiceSettingsLocalDelta({ voice: next }, current.settings) } };
        });
      }
      environment.machineInventoryRequest = inventoryRequest;
      first.emit('message', { data: JSON.stringify({
        type: 'response.function_call_arguments.done', event_id: 'stable-tool-arguments', response_id: 'stable-tool-response',
        call_id: 'stable-tool-call', name: 'listMachines', arguments: JSON.stringify({ refresh: true }),
      }) });
      first.emit('message', { data: JSON.stringify({
        type: 'response.done', event_id: 'stable-tool-done', response: { id: 'stable-tool-response', status: 'completed' },
      }) });
      await waitForTestEvent(FakeWebSocket.subscribe, () => expect(FakeWebSocket.instances).toHaveLength(2));
      const second = FakeWebSocket.instances[1]!;
      const delivered = () => second.sent.map(value => JSON.parse(value)).filter(event => (
        event.item?.type === 'function_call_output'
      ));
      if (transportLoss === 'closed_after_send') {
        // Browser send accepts synchronously. A later close task must not turn
        // an already-submitted result into a detached delivery or repeat it.
        expect(delivered()).toEqual([]);
        expect(new URL(second.url).searchParams.get('conversation_id')).toBe('conv-stable-tool');
        await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(composed.runtime.adapter.getSnapshot().status).toBe('connected'));
      } else if (resumed) {
        await waitForTestEvent(FakeWebSocket.subscribe, () => expect(delivered()).toEqual([expect.objectContaining({ item: expect.objectContaining({
          call_id: 'stable-tool-call', output: expect.stringContaining('items'),
        }) })]));
        expect(new URL(second.url).searchParams.get('conversation_id')).toBe('conv-stable-tool');
        await waitForTestEvent(FakeWebSocket.subscribe, () => expect(second.sent.map(value => JSON.parse(value)).filter(event => event.type === 'response.create')).toHaveLength(1));
        expect(second.sent.map(value => JSON.parse(value)).filter(event => event.type === 'response.create')).toHaveLength(1);
        expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      } else {
        await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          status: 'error', errorCode: 'voice_tool_result_delivery_unrecoverable',
        }));
        expect(new URL(second.url).searchParams.get('conversation_id')).toBeNull();
        expect(delivered()).toEqual([]);
        expect(second.sent.map(value => JSON.parse(value)).filter(event => event.type === 'response.create')).toEqual([]);
        await waitForTestEvent(FakeWebSocket.subscribe, () => expect(second.readyState).toBe(3));
      }
      expect(deliveryAttempts).toEqual(transportLoss === 'closed_after_send' ? ['stable-tool-call'] : []);
      expect(first.sent.map(value => JSON.parse(value)).filter(event => (
        event.item?.type === 'function_call_output'
      ))).toHaveLength(transportLoss === 'closed_after_send' ? 1 : 0);
      expect(inventoryRequest).toHaveBeenCalledOnce();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('delivers the exact pending Home read result once on the surviving xAI carrier after reconnect', async () => {
    await environment.installSettings(true);
    storage.setState(current => {
      const voice = voiceSettingsParse(readVoiceSettingsInput(current.settings));
      const next = { ...voice, privacy: { ...voice.privacy, shareDeviceInventory: true } };
      return { settings: { ...current.settings, ...normalizeVoiceSettingsLocalDelta({ voice: next }, current.settings) } };
    });
    let resolveInventory!: (response: Response) => void;
    const pendingInventory = new Promise<Response>(resolve => { resolveInventory = resolve; });
    const inventoryRequest = vi.fn(async () => await pendingInventory);
    const machineRow = createPlainMachineRowFixture({ id: 'pending-read-machine', accountId: 'xai-composed-account' });
    const composed = await environment.createRuntime();
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      const first = FakeWebSocket.instances[0]!;
      first.emitConversationId('conv-pending-read');
      await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID), environment.xaiEntry().providerId,
      )?.conversationId).toBe('conv-pending-read'));
      environment.machineInventoryRequest = inventoryRequest;
      first.emit('message', { data: JSON.stringify({
        type: 'response.function_call_arguments.done', event_id: 'pending-read-arguments', response_id: 'pending-read-response',
        call_id: 'pending-read-call', name: 'listMachines', arguments: JSON.stringify({ refresh: true }),
      }) });
      first.emit('message', { data: JSON.stringify({
        type: 'response.done', event_id: 'pending-read-done', response: { id: 'pending-read-response', status: 'completed' },
      }) });
      await waitForTestEvent(environment.subscribeNetwork, () => expect(inventoryRequest).toHaveBeenCalledOnce());
      first.emit('close', { code: 1006, reason: '' });
      await waitForTestEvent(FakeWebSocket.subscribe, () => expect(FakeWebSocket.instances).toHaveLength(2));
      const second = FakeWebSocket.instances[1]!;
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(composed.runtime.adapter.getSnapshot().status).toBe('connected'));
      expect(new URL(second.url).searchParams.get('conversation_id')).toBe('conv-pending-read');
      resolveInventory(Response.json([machineRow]));
      const deliveredResults = () => FakeWebSocket.instances.flatMap(socket => socket.sent.map(value => ({
        socket, event: JSON.parse(value),
      }))).filter(({ event }) => event.item?.type === 'function_call_output');
      await waitForTestEvent(FakeWebSocket.subscribe, () => {
        expect(deliveredResults()).toHaveLength(1);
        const delivery = deliveredResults()[0]!;
        expect(delivery.event.item.call_id).toBe('pending-read-call');
        expect(JSON.parse(delivery.event.item.output)).toMatchObject({ items: [expect.objectContaining({
          machineId: machineRow.id, host: 'tester.local',
        })] });
        expect(delivery.socket.readyState).toBe(FakeWebSocket.OPEN);
        expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      });
      expect(inventoryRequest).toHaveBeenCalledOnce();
      const surviving = deliveredResults()[0]!.socket;
      expect(surviving).toBe(FakeWebSocket.instances.at(-1));
      expect(new URL(surviving.url).searchParams.get('conversation_id')).toBe('conv-pending-read');
      await waitForTestEvent(FakeWebSocket.subscribe, () => expect(surviving.sent.map(value => JSON.parse(value)).filter(event => event.type === 'response.create')).toHaveLength(1));
      expect(surviving.sent.map(value => JSON.parse(value)).filter(event => event.type === 'response.create')).toHaveLength(1);
      expect(first.sent.map(value => JSON.parse(value)).filter(event => event.item?.type === 'function_call_output')).toEqual([]);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      resolveInventory(Response.json([]));
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('runs approved SavedSecret through public activation, host PCM/WebSocket, and the canonical history carrier', async () => {
    await environment.installSettings(false);
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = await environment.createRuntime();

    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });

      expect(composed.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
      expect(environment.audioContexts.some(context => context.createMediaStreamSource.mock.calls.some(([stream]) => stream === environment.browser.micStream))).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.protocols).toEqual([
        'xai-client-secret.source-composed',
      ]);
      const captureContext = environment.audioContexts.find(context => context.processor.onaudioprocess !== null);
      if (!captureContext) throw new Error('The real PCM capture did not subscribe to browser input');
      captureContext.emitInput(new Float32Array(2_400).fill(0.25));
      await waitForTestEvent(FakeWebSocket.subscribe, () => expect(FakeWebSocket.instances[0]!.sent.map(value => JSON.parse(value))).toContainEqual(
        expect.objectContaining({ type: 'input_audio_buffer.append', audio: expect.any(String) }),
      ));
      FakeWebSocket.instances[0]!.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AQACAA==' }) });
      await captureContext.sourceCreated();
      expect(captureContext.sources).toHaveLength(1);
      expect(captureContext.sources[0]?.buffer?.samples).toEqual(new Float32Array([1 / 32_767, 2 / 32_767]));
      expect(Object.keys(storage.getState().sessions)).toEqual([
        XAI_HISTORY_SESSION_ID,
      ]);
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).toMatchObject({
        adapterId: 'happier.voice.xai/realtime-grok',
        lifetime: 'runtime_attempt',
        targetSessionAddress: null,
      });
      expect(binding?.conversationSessionId).toBe(XAI_HISTORY_SESSION_ID);
      expect(storage.getState().sessions[binding!.conversationSessionId]).toMatchObject({
        id: XAI_HISTORY_SESSION_ID,
        active: false,
      });
      await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
        openConversationSessionId: binding!.conversationSessionId,
        fallbackControlSessionId: composed.controlSessionId,
        activeAdapterId: 'happier.voice.xai/realtime-grok',
        providerId: 'happier.voice.xai/realtime-grok',
        requestedTargetSessionId: null,
      })).resolves.toEqual({
        conversationSessionId: null,
        conversationServerId: null,
      });

      FakeWebSocket.instances[0]!.emitConversationId('conv-runtime-only');
      await Promise.resolve();
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(patchSessionMetadata).not.toHaveBeenCalled();

      FakeWebSocket.instances[0]!.emit('message', {
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 'xai-source-composed-user-final',
          item_id: 'xai-source-composed-user',
          transcript: 'hello through Grok Voice',
        }),
      });
      await waitForTestEvent(storage.subscribe, () => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'hello through Grok Voice',
        }),
      ]));
      await waitForTestEvent(storage.subscribe, () => {
        expect(readStoredSessionMessages(storage.getState(), binding!.conversationSessionId)).toEqual([
          expect.objectContaining({
            kind: 'user-text',
            text: 'hello through Grok Voice',
          }),
        ]);
      });

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(environment.browser.micTrack.stop).toHaveBeenCalled();
      expect(environment.audioContexts.every(context => context.close.mock.calls.length > 0)).toBe(true);
      expect(captureContext.sources[0]?.stop).toHaveBeenCalled();
      expect(captureContext.processor.disconnect).toHaveBeenCalled();
      expect(readCanonicalVoiceTranscriptSnapshot(
        binding!.conversationSessionId,
      )).toEqual([]);
      expect(storage.getState().sessions[binding!.conversationSessionId])
        .toBeDefined();
      expect(readStoredSessionMessages(storage.getState(), binding!.conversationSessionId)).toEqual([
        expect.objectContaining({ kind: 'user-text', text: 'hello through Grok Voice' }),
      ]);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('persists and resumes the provider conversation on the durable history carrier', async () => {
    await environment.installSettings(true);
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = await environment.createRuntime();

    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });

      expect(composed.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
      expect(FakeWebSocket.instances).toHaveLength(1);
      FakeWebSocket.instances[0]!.emitConversationId('conv-durable');
      await waitForTestEvent(environment.subscribeNetwork, () => expect(patchSessionMetadata).toHaveBeenCalledTimes(1));
      await patchSessionMetadata.mock.results[0]?.value;
      expect(storage.getState().sessions[XAI_HISTORY_SESSION_ID]?.metadata).not.toHaveProperty('voiceProviderConversationsV1');
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({
        conversationId: 'conv-durable',
      });

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      voiceSessionBindingStore.getState().bind({
        adapterId: 'happier.voice.xai/realtime-grok',
        controlSessionId: composed.controlSessionId,
        conversationSessionId: XAI_HISTORY_SESSION_ID,
        conversationSessionAddress: {
          serverId: getActiveServerSnapshot().serverId,
          sessionId: XAI_HISTORY_SESSION_ID,
        },
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionAddress: null,
        updatedAt: 2,
      });
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });

      expect(composed.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(2);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(new URL(FakeWebSocket.instances[1]!.url).searchParams.get(
        'conversation_id',
      )).toBe('conv-durable');
      expect(composed.hostLease.host.canPersistProviderConversationState?.({
        providerId: 'happier.voice.openai/realtime-openai',
        conversationSessionId: XAI_HISTORY_SESSION_ID,
      })).toBe(false);

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(composed.hostLease.host.canPersistProviderConversationState?.({
        providerId: 'happier.voice.xai/realtime-grok',
        conversationSessionId: XAI_HISTORY_SESSION_ID,
      })).toBe(false);
      const writeProviderConversationState =
        composed.hostLease.host.writeProviderConversationState;
      if (!writeProviderConversationState) {
        throw new Error('provider conversation persistence host missing');
      }
      await expect(writeProviderConversationState({
        providerId: 'happier.voice.xai/realtime-grok',
        conversationSessionId: XAI_HISTORY_SESSION_ID,
        state: { conversationId: 'stale-after-stop' },
      })).rejects.toThrow('voice_provider_conversation_persistence_unavailable');
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({
        conversationId: 'conv-durable',
      });
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('forgets only Happier-owned xAI resumption metadata without a provider request', async () => {
    await environment.installSettings(true);
    environment.mockHistoryCarrierDiscovery();
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = await environment.createRuntime();

    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      const socket = FakeWebSocket.instances[0]!;
      socket.emitConversationId('conv-forget-local-only');
      await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({
        conversationId: 'conv-forget-local-only',
      }));
      const accountRequestCount = composed.providerFetch.mock.calls.length;
      const providerMessagesBeforeForget = [...socket.sent];

      await expect(performVoiceAdapterRuntimeAction(
        'happier.voice.xai/realtime-grok',
        'forget_provider_conversation',
      )).resolves.toEqual({ status: 'completed' });

      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toBeNull();
      expect(patchSessionMetadata).toHaveBeenCalledTimes(2);
      expect(composed.providerFetch).toHaveBeenCalledTimes(accountRequestCount);
      expect(socket.sent).toEqual(providerMessagesBeforeForget);

      socket.emitConversationId('conv-late-after-forget');
      await Promise.resolve();
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toBeNull();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('forgets only the fixed history carrier after a retained direct-session attempt', async () => {
    await environment.installSettings(true);
    environment.installProviderConversationMetadata(XAI_HISTORY_SESSION_ID, 'conv-history-before-direct');
    const directTargetSessionId = 'direct-target-before-forget';
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [directTargetSessionId]: createSessionFixture({
          id: directTargetSessionId,
          serverId: getActiveServerSnapshot().serverId,
          active: true,
          encryptionMode: 'plain',
          metadata: writeVoiceProviderConversationMetadata({
            path: '/direct-target',
            host: 'happier.test',
          }, {
            providerId: 'happier.voice.xai/realtime-grok',
            state: { conversationId: 'conv-direct-before' },
            updatedAt: Date.now(),
          }),
        }),
      },
    }) as never);
    environment.mockHistoryCarrierDiscovery([directTargetSessionId, XAI_HISTORY_SESSION_ID]);
    const composed = await environment.createRuntime();

    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      const historySocket = FakeWebSocket.instances[0]!;
      historySocket.emitConversationId('conv-history-current');
      await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({ conversationId: 'conv-history-current' }));
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });

      voiceSessionBindingStore.getState().bind({
        adapterId: 'happier.voice.xai/realtime-grok',
        controlSessionId: directTargetSessionId,
        conversationSessionId: directTargetSessionId,
        conversationSessionAddress: {
          serverId: getActiveServerSnapshot().serverId,
          sessionId: directTargetSessionId,
        },
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionAddress: {
          serverId: getActiveServerSnapshot().serverId,
          sessionId: directTargetSessionId,
        },
        updatedAt: 2,
      });
      await composed.runtime.adapter.start({
        sessionId: directTargetSessionId,
        requestedTargetSessionAddress: {
          serverId: getActiveServerSnapshot().serverId,
          sessionId: directTargetSessionId,
        },
        initialContext: '',
      });
      const directSocket = FakeWebSocket.instances[1]!;
      expect(new URL(directSocket.url).searchParams.get('conversation_id'))
        .toBe('conv-direct-before');
      directSocket.emitConversationId('conv-direct-current');
      await waitForTestEvent(storage.subscribe, () => expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(directTargetSessionId),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({ conversationId: 'conv-direct-current' }));
      await composed.runtime.adapter.stop({ sessionId: directTargetSessionId });

      await expect(performVoiceAdapterRuntimeAction(
        'happier.voice.xai/realtime-grok',
        'forget_provider_conversation',
      )).resolves.toEqual({ status: 'completed' });

      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toBeNull();
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(directTargetSessionId),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({ conversationId: 'conv-direct-current' });

      historySocket.emitConversationId('conv-history-late-after-forget');
      await Promise.resolve();
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toBeNull();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('forgets persisted history-carrier metadata before any Voice attempt after a fresh composition', async () => {
    await environment.installSettings(true);
    environment.installProviderConversationMetadata(XAI_HISTORY_SESSION_ID, 'conv-from-prior-process');
    const directTargetSessionId = 'direct-target-with-independent-state';
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [directTargetSessionId]: createSessionFixture({
          id: directTargetSessionId,
          active: true,
          encryptionMode: 'plain',
          metadata: writeVoiceProviderConversationMetadata({
            path: '/direct-target',
            host: 'happier.test',
          }, {
            providerId: 'happier.voice.xai/realtime-grok',
            state: { conversationId: 'conv-direct-target' },
            updatedAt: 1,
          }),
        }),
      },
    }) as never);
    environment.mockHistoryCarrierDiscovery([directTargetSessionId, XAI_HISTORY_SESSION_ID]);
    const providerFetch = environment.installProviderFetchBoundary();
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = await environment.createRuntime();
    voiceSessionBindingStore.getState().unbind(XAI_HISTORY_SESSION_ID);

    try {
      await expect(performVoiceAdapterRuntimeAction(
        'happier.voice.xai/realtime-grok',
        'forget_provider_conversation',
      )).resolves.toEqual({ status: 'completed' });

      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toBeNull();
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(directTargetSessionId),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({ conversationId: 'conv-direct-target' });
      expect(patchSessionMetadata).toHaveBeenCalledTimes(1);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(composed.providerFetch).not.toHaveBeenCalled();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('treats an already-absent persisted ID as successful without a metadata mutation', async () => {
    await environment.installSettings(true);
    environment.mockHistoryCarrierDiscovery();
    const providerFetch = environment.installProviderFetchBoundary();
    const patchSessionMetadata = vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    const composed = await environment.createRuntime();
    voiceSessionBindingStore.getState().unbind(XAI_HISTORY_SESSION_ID);

    try {
      await expect(performVoiceAdapterRuntimeAction(
        'happier.voice.xai/realtime-grok',
        'forget_provider_conversation',
      )).resolves.toEqual({ status: 'completed' });
      expect(patchSessionMetadata).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(0);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });

  it('does not report completed when the durable metadata clear fails', async () => {
    await environment.installSettings(true);
    environment.installProviderConversationMetadata(XAI_HISTORY_SESSION_ID, 'conv-mutation-fails');
    environment.mockHistoryCarrierDiscovery();
    environment.sessionHttp.rejectNextPatch(XAI_HISTORY_SESSION_ID);
    const composed = await environment.createRuntime();
    voiceSessionBindingStore.getState().unbind(XAI_HISTORY_SESSION_ID);

    try {
      await expect(performVoiceAdapterRuntimeAction(
        'happier.voice.xai/realtime-grok',
        'forget_provider_conversation',
      )).resolves.toEqual({
        status: 'failed',
        code: 'voice_runtime_action_failed',
      });
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(XAI_HISTORY_SESSION_ID),
        'happier.voice.xai/realtime-grok',
      )).toMatchObject({ conversationId: 'conv-mutation-fails' });
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(composed.providerFetch).not.toHaveBeenCalled();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
    }
  });
});
