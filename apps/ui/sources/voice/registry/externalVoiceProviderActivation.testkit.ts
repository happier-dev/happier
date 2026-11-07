import { expect, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import type { RealtimeVoiceProviderRuntime, VoiceSdkHandleConnectionDriver } from '@happier-dev/plugin-sdk/voice/client';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol/plugins/contributions/catalog';

import {
  createPluginUiClientExecutableRegistrationIndex,
} from '@/components/plugins/reactNative/clientExecutableContributions';

import {
  createExternalVoiceProviderActivationScope as createProductionExternalVoiceProviderActivationScope,
  type ExternalVoiceProviderActivationScope,
  type VoiceConversationProviderContribution,
} from './externalVoiceProviderActivation';

type ProductionInput = Parameters<typeof createProductionExternalVoiceProviderActivationScope>[0];
type TestInput = Omit<ProductionInput, 'registrationScope' | 'occurrenceId'> & Readonly<{
  occurrenceId: string;
}>;

function testClientPlatform(
  declaration: VoiceConversationProviderContribution,
): PluginContributionClientPlatform {
  return declaration.platforms.find((platform): platform is PluginContributionClientPlatform => (
    platform === 'web' || platform === 'ios' || platform === 'android'
  )) ?? 'web';
}

/** Independently authored public SDK provider; host policy and media owners remain real. */
export async function createPublicPcmVoiceConversationForTest(
  registerCleanup: (cleanup: () => Promise<void>) => void,
  options: Readonly<{
    autoStart?: boolean;
    inputCommitRequired?: boolean;
  }> = {},
) {
  const { createOpenAiVoiceRuntimeEnvironment } = await import('@/dev/testkit/harness/openAiVoiceRuntime');
  const { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
  const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
  const { createVoiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
  const environment = await createOpenAiVoiceRuntimeEnvironment();
  let retireOwner = async () => {};
  let restoreBrowser = () => {};
  let restoreLocks = () => {};
  let restoreClock = () => {};
  registerCleanup(async () => {
    try {
      await retireOwner();
    } finally {
      try { await environment.dispose(); }
      finally {
        restoreLocks();
        restoreBrowser();
        restoreClock();
        vi.useRealTimers();
      }
    }
  });
  const contexts: Array<InstanceType<typeof TestVoiceAudioContext>> = [];
  const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => {
    const context = new TestVoiceAudioContext();
    contexts.push(context);
    return context as unknown as AudioContext;
  } });
  restoreBrowser = browser.restore;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  const locks = installWebLockManagerMock();
  restoreLocks = locks.restore;
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  const { PluginContributesV2Schema} = await import('@happier-dev/protocol/plugins/contributions/v2');
  const { createVoiceTranscriptLadderMapper, VoiceTranscriptCanonicalEventV1Schema } = await import('@happier-dev/plugin-sdk/voice/client');
  const { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } = await import('@/voice/registry/bundledConversationRuntimeHost');
  const { getExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
  const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
  const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
  const { storage } = await import('@/sync/domains/state/storage');
  const { resolveVoiceTranscriptEntryId } = await import('@/voice/transcript/voiceTranscriptEntryIdentity');
  const { isVoiceTurnInterrupted } = await import('@/voice/transcript/voiceTurnInterruption');
  const { readCanonicalVoiceTranscriptSnapshot } = await import('@/voice/transcript/voiceConversationTranscript');
  const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
    id: 'pcm', title: 'Public PCM conformance', kind: 'conversation',
    roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'], platforms: ['web'],
    capabilities: { turn: { cancelResponse: true, bargeIn: true, interruptionPolicy: 'client_two_stage',
      ...(options.inputCommitRequired === true ? { clearInput: true } : {}),
    } },
    client: { artifactId: 'pcm-client', exportName: 'activate' },
  }] }).voiceProviders[0]!;
  if (declaration.kind !== 'conversation') throw new Error('Expected the public conversation declaration');
  const pluginId = 'conformance.voice.pcm';
  const providerId = `${pluginId}/${declaration.id}`;
  let callbacks: Parameters<VoiceSdkHandleConnectionDriver['open']>[0] | null = null;
  let receiveAudio: ((audio: string, item: string | null) => boolean) | null = null;
  let pcm: ReturnType<Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]['media']['createPcmConnection']> | null = null;
  const sent: unknown[] = [];
  const sendEvents = new EventTarget();
  const pendingOpenGates: Array<Readonly<{
    promise: Promise<void>;
    release(): void;
    reject(error: unknown): void;
    entered: ReturnType<typeof createDeferred<void>>;
  }>> = [];
  let sdkOpenCount = 0;
  const ladder = createVoiceTranscriptLadderMapper();
  const publicRuntime: RealtimeVoiceProviderRuntime = {
    kind: 'conversation', microphoneMode: 'host_pcm', outputLevelMeter: 'measured',
    protocol: {
      async prepare({ signal }) {
        if (signal.aborted) return { kind: 'aborted' };
        return { kind: 'prepared', session: { config: null, safeMetadata: null,
          ...(options.inputCommitRequired === true ? { inputCommitRequired: true } : {}),
        } };
      },
      decodeControl(event) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
        const wire = event as Readonly<Record<string, unknown>>;
        if (wire.kind === 'audio.started') return [{ type: 'assistant_output_started', ...(typeof wire.item === 'string' ? { itemId: wire.item } : {}) }];
        if (wire.kind === 'audio.stopped') return [{ type: 'assistant_output_stopped' }];
        if (wire.kind === 'speech.started') return [{ type: 'input_speech_started' }];
        if (wire.kind === 'speech.stopped') return [{ type: 'input_speech_stopped' }];
        if (wire.kind !== 'final' || typeof wire.item !== 'string' || typeof wire.id !== 'string'
          || typeof wire.text !== 'string' || (wire.role !== 'user' && wire.role !== 'assistant')) return [];
        const transcript = ladder.map({ itemId: wire.item, eventId: wire.id, role: wire.role, incoming: wire.text, mode: 'final' });
        return transcript ? [{ type: 'transcript', event: VoiceTranscriptCanonicalEventV1Schema.parse(transcript) }] : [];
      },
      encodeTurnControl: action => {
        if (action === 'cancel_response') return { kind: 'cancel' };
        if (options.inputCommitRequired === true) {
          if (action === 'clear_input') return { kind: 'input.clear' };
          if (action === 'commit_input') return { kind: 'input.commit' };
        }
        return null;
      },
      ...(options.inputCommitRequired === true ? {
        encodePostInputCommitControls: () => [{ kind: 'continue' }],
      } : {}),
    },
    async createConnection({ media }) {
      pcm = media.createPcmConnection({
        driver: {
          async open(input) {
            sdkOpenCount += 1;
            const gate = pendingOpenGates.shift();
            gate?.entered.resolve();
            if (gate && !input.signal.aborted) {
              let onAbort = () => {};
              const aborted = new Promise<void>(resolve => {
                onAbort = resolve;
                input.signal.addEventListener('abort', onAbort, { once: true });
              });
              try { await Promise.race([gate.promise, aborted]); }
              finally { input.signal.removeEventListener('abort', onAbort); }
            }
            if (input.signal.aborted) return;
            callbacks = input;
            // This is the authored provider's native SDK audio callback. The
            // host still owns PCM decoding, scheduling, cursor and retention.
            receiveAudio = (audio, item) => {
              const accepted = pcm?.enqueueOutput(audio) ?? false;
              if (accepted) input.onControl({ kind: 'audio.started', ...(item ? { item } : {}) });
              return accepted;
            };
          },
          async sendControl(event) { sent.push(event); sendEvents.dispatchEvent(new Event('send')); },
          async close() { callbacks = null; receiveAudio = null; },
        },
        input: { sampleRate: 24_000, chunkMs: 100 }, output: { sampleRate: 24_000 },
        onInputChunk: audio => { sent.push({ kind: 'input.audio', audio }); sendEvents.dispatchEvent(new Event('send')); },
      });
      return pcm.connection;
    },
    encodeToolResults: () => [], encodeToolContinuation: () => ({ kind: 'continue' }),
    encodeContextUpdate: text => [{ kind: 'context', text }],
    encodeTextTurn: text => [{ kind: 'text', text }],
  };
  const hostLease = createBundledConversationRuntimeHostLease();
  let controller: ReturnType<typeof hostLease.host.createConversationController> | null = null;
  let scope: ExternalVoiceProviderActivationScope | null = null;
  retireOwner = async () => {
    try { await scope?.unwind(); }
    finally { hostLease.revoke(); }
  };
  scope = createExternalVoiceProviderActivationScope({
    pluginId, occurrenceId: 'public-pcm-occurrence', declarations: [declaration], hostPlatform: 'web',
    runtimeHost: { ...hostLease.host, createMicSession: browser.createMicSession,
      createConversationController(input) {
        controller = hostLease.host.createConversationController(input);
        return controller;
      },
    },
    isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
  });

  scope.api.voiceProviders.register(declaration.id, publicRuntime);
  await scope.commit();
  const registration = getExternalVoiceProviderRegistration(providerId);
  if (!registration?.adapter) throw new Error('Public PCM activation did not register its adapter');
  registerVoiceAdapters([registration.adapter]);
  await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
    providers: { ...environment.persistedAccountSettings.voice.providers, [providerId]: { schemaVersion: 1, config: {} } } });
  if (options.autoStart !== false) await registration.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
  let sequence = 0;
  const emit = (event: Readonly<Record<string, unknown>>) => {
    if (!callbacks) throw new Error('Vendor SDK is not open');
    callbacks.onControl({ id: `pcm-event-${++sequence}`, ...event });
  };
  const startOutput = async (item: string | null = 'turn-n') => {
    if (!receiveAudio) throw new Error('The vendor SDK audio callback is absent');
    const bytes = new Int16Array(24_000).fill(2_000);
    expect(receiveAudio(Buffer.from(bytes.buffer).toString('base64'), item)).toBe(true);
    const { useVoiceConversationRuntimeStore } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => createVoiceConversationRuntimeMachine().getSnapshot().state, state => state === 'speaking');
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'speaking' });
  };
  const finalizeAssistant = async (item = 'turn-n', text = 'current response') => {
    emit({ kind: 'final', role: 'assistant', item, text });
    let entryId: string | null = null;
    const readEntryId = () => {
      const message = readStoredSessionMessages(storage.getState(), environment.historySessionId).find(message => (
        message && typeof message === 'object' && 'kind' in message && message.kind === 'agent-text'
        && 'text' in message && message.text === text
      ));
      return resolveVoiceTranscriptEntryId(message);
    };
    entryId = await waitForTestEvent(storage.subscribe, readEntryId, id => id !== null);
    expect(entryId).not.toBeNull();
    return entryId!;
  };
  return { sent, emit, startOutput, finalizeAssistant,
    isVoiceTurnInterrupted: (entryId: string) => isVoiceTurnInterrupted(entryId, environment.historySessionId), providerId,
    browser,
    adapter: registration.adapter,
    getController() {
      if (!controller) throw new Error('The actual conversation controller is absent');
      return controller;
    },
    getConnection: () => pcm?.connection ?? null,
    sdk: {
      get openCount() { return sdkOpenCount; },
      async controlSent(kind: string, after = 0) {
        await waitForTestEvent(notify => {
          sendEvents.addEventListener('send', notify);
          return () => sendEvents.removeEventListener('send', notify);
        }, () => sent.slice(after), events => events.some(event => (
          event !== null && typeof event === 'object' && 'kind' in event && event.kind === kind
        )));
      },
      holdNextOpen() {
        const pending = createDeferred<void>();
        const entered = createDeferred<void>();
        const gate = { promise: pending.promise, release: () => pending.resolve(), reject: pending.reject, entered };
        pendingOpenGates.push(gate);
        return { release: gate.release, reject: gate.reject, entered: entered.promise };
      },
    },
    readMessages: () => readStoredSessionMessages(storage.getState(), environment.historySessionId),
    waitForUser: async (text: string) => {
      await waitForTestEvent(storage.subscribe, () => readCanonicalVoiceTranscriptSnapshot(environment.historySessionId), entries => entries.some(entry => entry.role === 'user' && entry.text === text));
      expect(readCanonicalVoiceTranscriptSnapshot(environment.historySessionId)).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', text })]));
    },
    get context() {
      const context = contexts[contexts.length - 1];
      if (!context) throw new Error('The real mic owner has not acquired its AudioContext');
      return context;
    },
    playbackCursorMs: () => pcm?.connection.playbackCursorMs() ?? null,
    async requestReconnect() {
      if (!controller) throw new Error('The actual conversation controller is absent');
      return await controller.requestReconnect();
    },
    controlSessionId: hostLease.host.globalVoiceSessionId, advanceClock: (milliseconds: number) => { now += milliseconds; } };
}

/**
 * Direct Voice-owner tests still execute through the real generic client
 * registration transaction. Production activation receives this scope from
 * the executable composition rather than constructing it itself.
 */
export function createExternalVoiceProviderActivationScope(
  input: TestInput,
): ExternalVoiceProviderActivationScope {
  const declaration = input.declarations[0];
  if (!declaration) {
    throw new Error('external_voice_provider_declaration_required');
  }
  const controller = new AbortController();
  const registrationScope = createPluginUiClientExecutableRegistrationIndex().createScope({
    pluginId: input.pluginId,
    contributes: Object.freeze({ voiceProviders: input.declarations }),
    target: Object.freeze({
      artifactId: declaration.client.artifactId,
      exportName: declaration.client.exportName,
      platform: testClientPlatform(declaration),
    }),
    executionOrigin: Object.freeze({
      serverIdentityId: 'srv_test',
      materializationRef: Object.freeze({
        machineId: 'machine-test',
        materializationId: 'materialization-test',
        pluginId: input.pluginId,
      }),
    }),
    occurrenceId: input.occurrenceId,
    lifecycle: Object.freeze({
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    }),
  });
  const scope = createProductionExternalVoiceProviderActivationScope({
    ...input,
    registrationScope,
  });
  let committed = false;
  let unwound = false;
  return Object.freeze({
    ...scope,
    isCurrent: () => (
      !unwound
      && registrationScope.isCurrent()
      && (!committed || (scope.isCurrent?.() ?? true))
    ),
    async commit() {
      await scope.commit();
      committed = true;
    },
    async unwind() {
      unwound = true;
      await registrationScope.unwind();
      await scope.unwind();
    },
  });
}
