import { readFile } from 'node:fs/promises';

import type {
  BundledRealtimeProviderRuntimeHost,
  VoiceRealtimeConnection,
  VoiceSessionSnapshot,
} from '@happier-dev/bundled-voice-runtime-contract';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { PluginVoiceProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/runtime';
import {
  PluginContributesV2Schema,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
  createAppShellPluginUiInvocationHost,
  type AppShellPluginUiActionExecute,
} from '@/components/appShell/plugins/pluginUiInvocationHost';
import { loadPluginReactNativeBundleExport } from '@/components/plugins/reactNative/loader';
import { createReactNativeWebLoaderBackend } from '@/components/plugins/reactNative/webLoaderBackend.web';
import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import {
  createSdkHandleConnection,
  createWebRtcConnection,
  createWebSocketPcmConnection,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import { createRealtimeToolBarrierForVoiceHandlers } from '@/voice/tools/defaultRealtimeToolBarrier';

import {
  bindVoiceProviderSettingsOperations,
  createExternalProtocol,
  createExternalVoiceProviderRuntimeContribution,
} from './externalVoiceProviderActivation';
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
} from '../settings/externalProviderSettings';

const providerId = 'acme.synthetic-voice/conversation';
const parsedDeclaration = PluginContributesV2Schema.parse({ voiceProviders: [{
  id: 'conversation', title: 'Synthetic Conversation', kind: 'conversation',
  roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
  platforms: ['web'],
  capabilities: {
    readiness: { requirements: ['credential'] },
    turn: { cancelResponse: true, bargeIn: false },
  },
  accountMediation: {
    credentialSlots: [{ id: 'api_key', scope: 'account' }],
    operations: [{
      id: 'client-auth',
      purpose: 'voice.client-auth',
      credentialSlotId: 'api_key',
      effect: 'read',
      request: {
        origin: 'https://voice.example.test',
        pathTemplate: '/v1/session',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'none' },
        method: 'POST',
        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        redirect: 'error',
        maxBodyBytes: 0,
        contentTypes: [],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
    }],
  },
  client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
}] }).voiceProviders[0]!;
if (parsedDeclaration.kind !== 'conversation') throw new Error('expected conversation declaration');
const declaration = parsedDeclaration;

function createHostFixture(input: Readonly<{
  transcriptEvents: unknown[];
  lifecycleEvents: string[];
  ensureMicActive?: () => Promise<void>;
  createWebSocketPcmMedia?: BundledRealtimeProviderRuntimeHost['createWebSocketPcmMedia'];
  createSdkHandleConnection?: BundledRealtimeProviderRuntimeHost['createSdkHandleConnection'];
  getRealtimeClientToolDefinitions?: BundledRealtimeProviderRuntimeHost['getRealtimeClientToolDefinitions'];
  readProviderConfig?: () => unknown;
  readProviderConversationState?: BundledRealtimeProviderRuntimeHost['readProviderConversationState'];
  writeProviderConversationState?: BundledRealtimeProviderRuntimeHost['writeProviderConversationState'];
  canPersistProviderConversationState?: (input: Readonly<{
    providerId: string;
    conversationSessionId: string;
  }>) => boolean;
}>): BundledRealtimeProviderRuntimeHost {
  let snapshot: VoiceSessionSnapshot = Object.freeze({
    adapterId: null,
    sessionId: null,
    status: 'disconnected',
    mode: 'idle',
    canStop: false,
  });
  const setSnapshot = (next: VoiceSessionSnapshot) => { snapshot = Object.freeze(next); };
  const host = {
    globalVoiceSessionId: 'voice-global',
    getPlatform: () => 'web' as const,
    getRealtimeClientToolDefinitions: input.getRealtimeClientToolDefinitions ?? (() => []),
    getSettings: () => ({ voice: {
      providerId,
      providers: { [providerId]: {
        schemaVersion: 1,
        config: input.readProviderConfig?.() ?? { mode: 'default' },
      } },
    } }),
    projectVoiceSettings: () => ({
      providerId,
      providerConfig: input.readProviderConfig?.() ?? { mode: 'default' },
    }),
    machine: {
      transitionToAcquiringMic: () => { input.lifecycleEvents.push('acquiring-mic'); },
      transitionToConnecting: (controlSessionId: string, adapterId: string) => {
        input.lifecycleEvents.push('connecting');
        setSnapshot({ adapterId, sessionId: controlSessionId, status: 'connecting', mode: 'idle', canStop: true });
      },
      setReconnecting: () => {},
      transitionToConnected: (controlSessionId: string, adapterId: string) => {
        input.lifecycleEvents.push('connected');
        setSnapshot({ adapterId, sessionId: controlSessionId, status: 'connected', mode: 'listening', canStop: true });
      },
      transitionToSpeaking: () => {},
      transitionToEnding: () => { input.lifecycleEvents.push('ending'); },
      transitionToDisconnected: () => {
        input.lifecycleEvents.push('disconnected');
        setSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      },
      setError: () => { input.lifecycleEvents.push('error'); },
      setMuted: () => {},
      getSnapshot: () => snapshot,
      projectSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    createConversationController: createVoiceConversationController,
    createMicSession: () => ({
      ensureActive: input.ensureMicActive ?? (async () => {}),
      setMuted: () => {},
      isMuted: () => false,
      teardown: async () => {},
      getStream: () => null,
    }),
    createWebRtcConnection,
    createSdkHandleConnection: input.createSdkHandleConnection ?? createSdkHandleConnection,
    createWebSocketPcmConnection,
    createWebSocketPcmMedia: input.createWebSocketPcmMedia ?? (() => {
      throw new Error('unexpected_pcm_media_creation');
    }),
    ensureBound: async () => {},
    resolveConversationSessionId: () => 'conversation-session-1',
    canPersistProviderConversationState: input.canPersistProviderConversationState ?? (() => true),
    readProviderConversationState: input.readProviderConversationState ?? (async () => null),
    writeProviderConversationState: input.writeProviderConversationState ?? (async () => {}),
    acquireDirectMediaConversation: ({ controlSessionId }) => ({
      conversationSessionId: controlSessionId,
    }),
    releaseDirectMediaConversation: () => {},
    applyTargetSelection: async () => {},
    acquireAudioMode: async () => ({ release: async () => {} }),
    createStorageMirror: () => () => { input.lifecycleEvents.push('mirror-disposed'); },
    openLevelWriter: () => ({ write: () => {}, reset: () => {}, close: () => {} }),
    projectTranscript: ({ event }: Readonly<{ event: unknown }>) => {
      input.transcriptEvents.push(event);
      return null;
    },
    beginTranscriptAttempt: () => 1,
    presentHostedLeaseNotice: vi.fn(),
    presentAttemptDiagnostic: () => {},
    clearAttemptStatus: () => {},
    createToolBarrier: (barrierInput) => createRealtimeToolBarrierForVoiceHandlers({
      handlers: {
        listMachines: async () => JSON.stringify({
          ok: true,
          machineId: 'machine-visible',
          title: 'private session summary',
          locationLabel: '/Users/alice/private-repo',
        }),
      },
      readRedactionPrefs: () => ({
        shareFilePaths: false,
        shareSessionSummary: false,
        sharePermissionRequests: false,
        shareDeviceInventory: true,
        shareRecentMessages: true,
      }),
      submitResults: barrierInput.submitResults,
      continueResponse: barrierInput.continueResponse,
    }),
    voiceHooks: { onStarted: () => '', onStopped: () => {} },
    createMachineError: ({ kind, reason }) => ({
      kind,
      reason,
      phase: 'runtime' as const,
      retryPolicy: 'never' as const,
      recoveryAction: 'none' as const,
      presentation: 'error' as const,
      recoverable: false,
    }),
  } satisfies BundledRealtimeProviderRuntimeHost;
  return Object.freeze(host);
}

describe('external Voice provider host composition', () => {
  it('bounds provisioning context and aborts the exact leaf/account signal when registration retires', async () => {
    const revocation = new AbortController();
    let observedSignal: AbortSignal | null = null;
    let accountSignal: AbortSignal | null = null;
    const provision = vi.fn(async (input: Readonly<{ signal: AbortSignal }>) => {
      observedSignal = input.signal;
      return await new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(
          Object.assign(new Error('aborted'), { code: 'aborted' }),
        ), { once: true });
      });
    });
    const createAccountOperations = vi.fn((signal: AbortSignal) => {
      accountSignal = signal;
      return Object.freeze({
        request: vi.fn(async () => {
          throw new Error('unexpected_account_request');
        }),
      });
    });
    const bound = bindVoiceProviderSettingsOperations({
      operations: Object.freeze({ provision }),
      createAccountOperations,
      isCurrent: () => !revocation.signal.aborted,
      revocationSignal: revocation.signal,
    });
    const pending = bound.provision!({
      request: Object.freeze({ kind: 'test' }),
      providerConfig: Object.freeze({ mode: 'default' }),
      disabledActionIds: ['session.message.send', 'session.message.send'],
      extraSystemAppendBlocks: ['  approved context  '],
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    expect(accountSignal).toBe(observedSignal);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      disabledActionIds: ['session.message.send'],
      extraSystemAppendBlocks: ['approved context'],
      signal: observedSignal,
    }));
    revocation.abort();
    expect(observedSignal).toMatchObject({ aborted: true });
    await expect(pending).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });

    await expect(bound.provision!({
      request: Object.freeze({ kind: 'test' }),
      providerConfig: Object.freeze({ mode: 'default' }),
      disabledActionIds: ['not.a.canonical.voice.action'],
      extraSystemAppendBlocks: [],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_provider_settings_context_invalid' });
    await expect(bound.provision!({
      request: Object.freeze({ kind: 'test' }),
      providerConfig: Object.freeze({ mode: 'default' }),
      disabledActionIds: [],
      extraSystemAppendBlocks: ['x'.repeat(16_385)],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_provider_settings_context_invalid' });

    const oversizedCatalog = bindVoiceProviderSettingsOperations({
      operations: Object.freeze({
        async listCatalog(): Promise<readonly VoiceRealtimeJsonValue[]> {
          return Array.from({ length: 1_001 }, (_, index) => Object.freeze({ id: String(index) }));
        },
      }),
      createAccountOperations: (signal) => Object.freeze({
        request: vi.fn(async () => {
          signal.throwIfAborted();
          throw new Error('unexpected_account_request');
        }),
      }),
      isCurrent: () => true,
    });
    await expect(oversizedCatalog.listCatalog!({
      catalog: 'voices',
      providerConfig: Object.freeze({ mode: 'default' }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_provider_settings_response_invalid' });

    const maliciousPreviewCatalog = bindVoiceProviderSettingsOperations({
      operations: Object.freeze({
        async listCatalog(): Promise<readonly VoiceRealtimeJsonValue[]> {
          return Object.freeze([
            { id: 'file', name: 'File', previewUrl: 'file:///tmp/secret.wav' },
            { id: 'custom', name: 'Custom', metadata: { previewUrl: 'voice-preview://track' } },
            { id: 'credentials', name: 'Credentials', metadata: { previewUrl: 'https://user:pass@example.test/a.mp3' } },
            { id: 'safe', name: 'Safe', metadata: { previewUrl: 'https://cdn.example.test/a.mp3' } },
          ].map((item) => VoiceRealtimeJsonValueSchema.parse(item)));
        },
      }),
      createAccountOperations: () => Object.freeze({
        request: vi.fn(async () => {
          throw new Error('unexpected_account_request');
        }),
      }),
      isCurrent: () => true,
    });
    await expect(maliciousPreviewCatalog.listCatalog!({
      catalog: 'voices',
      providerConfig: Object.freeze({ mode: 'default' }),
      signal: new AbortController().signal,
    })).resolves.toEqual([
      { id: 'file', name: 'File' },
      { id: 'custom', name: 'Custom', metadata: {} },
      { id: 'credentials', name: 'Credentials', metadata: {} },
      { id: 'safe', name: 'Safe', metadata: { previewUrl: 'https://cdn.example.test/a.mp3' } },
    ]);
  });

  it('hands initial prepare one immutable preflight snapshot and consumes it before every settlement', async () => {
    let currentConfig: unknown = { mode: 'default', voice: 'calm' };
    let preflightResult: 'ready' | 'declined' | 'aborted' = 'ready';
    let throwNextPrepare = false;
    const preflightConfigs: unknown[] = [];
    const prepareConfigs: unknown[] = [];
    const leaf: PluginVoiceProviderRuntimeRegistration['protocol'] = {
      async preflight(input) {
        preflightConfigs.push(input.providerConfig);
        return preflightResult === 'ready'
          ? { kind: 'ready' }
          : preflightResult === 'declined'
            ? { kind: 'declined', code: 'test_declined' }
            : { kind: 'aborted' };
      },
      async prepare(input) {
        prepareConfigs.push(input.providerConfig);
        if (throwNextPrepare) {
          throwNextPrepare = false;
          throw new Error('test_prepare_failure');
        }
        return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    };
    const protocol = createExternalProtocol(
      createHostFixture({
        transcriptEvents: [],
        lifecycleEvents: [],
        readProviderConfig: () => currentConfig,
      }),
      providerId,
      'web',
      declaration,
      leaf,
    );
    const signal = new AbortController().signal;
    const preflightInput = {
      controlSessionId: 'snapshot-session',
      attemptId: 1,
      request: {},
      signal,
    } as const;
    const prepareInput = {
      controlSessionId: 'snapshot-session',
      attemptId: 1,
      reason: 'initial' as const,
      request: {},
      signal,
    };

    await expect(protocol.preflight?.(preflightInput)).resolves.toEqual({ kind: 'ready' });
    currentConfig = { mode: 'default', voice: 'bright' };
    await expect(protocol.prepare(prepareInput)).resolves.toMatchObject({ kind: 'prepared' });
    expect(preflightConfigs[0]).toEqual({ mode: 'default', voice: 'calm' });
    expect(prepareConfigs[0]).toBe(preflightConfigs[0]);
    expect(Object.isFrozen(prepareConfigs[0])).toBe(true);

    currentConfig = { mode: 'default', voice: 'latest' };
    await expect(protocol.prepare(prepareInput)).resolves.toMatchObject({ kind: 'prepared' });
    expect(prepareConfigs[1]).toEqual({ mode: 'default', voice: 'latest' });

    currentConfig = { mode: 'default', voice: 'replacement' };
    await expect(protocol.preflight?.({ ...preflightInput, attemptId: 2 })).resolves.toEqual({
      kind: 'ready',
    });
    await protocol.releasePrepared?.({
      controlSessionId: 'snapshot-session',
      attemptId: 1,
      reason: { code: 'replaced' },
    });
    currentConfig = { mode: 'default', voice: 'changed-after-replacement-preflight' };
    await expect(protocol.prepare({ ...prepareInput, attemptId: 2 })).resolves.toMatchObject({
      kind: 'prepared',
    });
    expect(prepareConfigs[2]).toEqual({ mode: 'default', voice: 'replacement' });

    currentConfig = { mode: 'default', voice: 'reconnect' };
    await expect(protocol.prepare({ ...prepareInput, reason: 'reconnect' })).resolves.toMatchObject({
      kind: 'prepared',
    });
    expect(prepareConfigs[3]).toEqual({ mode: 'default', voice: 'reconnect' });

    for (const terminalPreflight of ['declined', 'aborted'] as const) {
      preflightResult = terminalPreflight;
      currentConfig = { mode: 'default', voice: `${terminalPreflight}-preflight` };
      await protocol.preflight?.(preflightInput);
      currentConfig = { mode: 'default', voice: `${terminalPreflight}-prepare` };
      await protocol.prepare(prepareInput);
      expect(prepareConfigs.at(-1)).toEqual({
        mode: 'default',
        voice: `${terminalPreflight}-prepare`,
      });
    }

    preflightResult = 'ready';
    currentConfig = { mode: 'default', voice: 'throwing' };
    await protocol.preflight?.(preflightInput);
    throwNextPrepare = true;
    await expect(protocol.prepare(prepareInput)).rejects.toThrow(/test_prepare_failure/u);
    currentConfig = { mode: 'default', voice: 'after-throw' };
    await protocol.prepare(prepareInput);
    expect(prepareConfigs.at(-1)).toEqual({ mode: 'default', voice: 'after-throw' });
  });

  it('binds account operations to protocol preparation without routing through the selected daemon', async () => {
    type PrepareInput = Parameters<PluginVoiceProviderRuntimeRegistration['protocol']['prepare']>[0];
    const lifecycleEvents: string[] = [];
    const materializeAccountSecret = vi.fn(async () => 'account-secret');
    const request = vi.fn(async (
      _input: Parameters<PrepareInput['accountOperations']['request']>[0],
    ) => {
      const secret = await materializeAccountSecret();
      expect(secret).toBe('account-secret');
      return Object.freeze({
        status: 200,
        finalUrl: 'https://voice.example.test/v1/session',
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          kind: 'bearer_token',
          value: 'short-lived-artifact',
          expiresAtMs: Date.now() + 60_000,
          placement: 'authorization_header',
        })),
      });
    });
    const accountOperations = Object.freeze({ request });
    const createInvocationAccountOperations = vi.fn(() => accountOperations);
    const executeSelectedDaemonAction = vi.fn(async () => {
      throw new Error('selected_daemon_must_not_be_used');
    });
    const runtimeInput = {
      host: createHostFixture({ transcriptEvents: [], lifecycleEvents }),
      platform: 'web' as const,
      providerId,
      declaration,
      createInvocationAccountOperations,
      createInvocationUi: (signal: AbortSignal) => createAppShellPluginUiInvocationHost({
        pluginId: 'acme.synthetic-voice',
        contributionId: 'conversation',
        generation: '12',
        machineId: 'selected-machine',
        signal,
        isCurrent: () => true,
        execute: executeSelectedDaemonAction,
      }),
      runtime: {
        protocol: {
          async prepare(input: PrepareInput) {
            expect(input.providerConversation).toBeNull();
            const response = await input.accountOperations.request({
              operationId: 'client-auth',
              parameters: {},
              signal: input.signal,
            });
            expect(new TextDecoder().decode(response.body)).toContain('short-lived-artifact');
            return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
          },
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        async createConnection() {
          return {
            kind: 'sdk_handle' as const, async connect() {}, async sendControl() {},
            controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
            transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }), async close() {},
            state: () => 'closed' as const, currentProviderSessionId: () => null, playbackCursorMs: () => null,
            beginOutputInterruptionCandidate: () => 'unsupported' as const, resolveOutputInterruptionCandidate() {},
          };
        },
        encodeToolResults: () => [], encodeToolContinuation: () => null,
        encodeContextUpdate: () => [], encodeTextTurn: () => [], requiresMicForConnection: false,
      },
    } satisfies Parameters<typeof createExternalVoiceProviderRuntimeContribution>[0];
    const runtime = createExternalVoiceProviderRuntimeContribution(runtimeInput);

    expect(materializeAccountSecret).not.toHaveBeenCalled();
    await runtime.adapter.start({ sessionId: 'account-operation-context' });

    expect(createInvocationAccountOperations).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(materializeAccountSecret).toHaveBeenCalledTimes(1);
    expect(executeSelectedDaemonAction).not.toHaveBeenCalled();
    expect(lifecycleEvents).toContain('connected');
    await runtime.dispose();
  });

  it('fails account-operation readiness before acquiring the microphone or preparing the provider', async () => {
    const lifecycleEvents: string[] = [];
    const ensureMicActive = vi.fn(async () => {});
    const inspectAvailability = vi.fn(async () => {
      throw Object.assign(new Error('voice_account_operation_unavailable'), {
        code: 'voice_account_operation_unavailable',
      });
    });
    const request = vi.fn(async () => {
      throw new Error('provider_prepare_must_not_run');
    });
    const providerPrepare = vi.fn(async (
      input: Parameters<PluginVoiceProviderRuntimeRegistration['protocol']['prepare']>[0],
    ) => {
      await input.accountOperations.request({
        operationId: 'client-auth',
        parameters: {},
        signal: input.signal,
      });
      return {
        kind: 'prepared' as const,
        session: { config: {}, safeMetadata: null },
      };
    });
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({
        transcriptEvents: [],
        lifecycleEvents,
        ensureMicActive,
      }),
      platform: 'web',
      providerId,
      declaration,
      createInvocationAccountOperations: () => Object.freeze({
        request,
      }),
      inspectInvocationAccountOperations: inspectAvailability,
      runtime: {
        protocol: {
          preflight: async () => ({ kind: 'ready' as const }),
          prepare: providerPrepare,
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        async createConnection() {
          throw new Error('provider_connection_must_not_run');
        },
        encodeToolResults: () => [],
        encodeToolContinuation: () => null,
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
      },
    });

    await expect(runtime.adapter.start({ sessionId: 'account-readiness' }))
      .rejects.toMatchObject({ code: 'voice_account_operation_unavailable' });

    expect(inspectAvailability).toHaveBeenCalledOnce();
    expect(ensureMicActive).not.toHaveBeenCalled();
    expect(providerPrepare).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(lifecycleEvents).toEqual(['connecting', 'error']);
    await runtime.dispose();
  });

  it('offers host-owned provider conversation state only to a declared resumable leaf', async () => {
    const readProviderConversationState = vi.fn(async () => ({
      conversationId: 'provider-conversation-1',
    }));
    const writeProviderConversationState = vi.fn(async (
      _input: Parameters<NonNullable<BundledRealtimeProviderRuntimeHost['writeProviderConversationState']>>[0],
    ) => {});
    const resumableDeclaration = Object.freeze({
      ...declaration,
      capabilities: Object.freeze({
        ...declaration.capabilities,
        turn: Object.freeze({
          ...declaration.capabilities.turn,
          resumption: 'resume' as const,
        }),
      }),
    });
    const leaf: PluginVoiceProviderRuntimeRegistration['protocol'] = {
      async prepare(input) {
        await expect(input.providerConversation?.read()).resolves.toBe('provider-conversation-1');
        await input.providerConversation?.write('provider-conversation-2');
        await input.providerConversation?.forget();
        return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    };
    const protocol = createExternalProtocol(
      createHostFixture({
        transcriptEvents: [],
        lifecycleEvents: [],
        readProviderConversationState,
        writeProviderConversationState,
      }),
      providerId,
      'web',
      resumableDeclaration,
      leaf,
    );

    await protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      signal: new AbortController().signal,
    });

    expect(readProviderConversationState).toHaveBeenCalledWith({
      providerId,
      conversationSessionId: 'conversation-session-1',
    });
    expect(writeProviderConversationState.mock.calls.map(([input]) => input)).toEqual([
      {
        providerId,
        conversationSessionId: 'conversation-session-1',
        state: { conversationId: 'provider-conversation-2' },
      },
      {
        providerId,
        conversationSessionId: 'conversation-session-1',
        state: null,
      },
    ]);
  });

  it('withholds provider conversation persistence from a resumable leaf without a persistent session owner', async () => {
    const readProviderConversationState = vi.fn(async () => ({
      conversationId: 'must-not-resume',
    }));
    const writeProviderConversationState = vi.fn(async (
      _input: Parameters<NonNullable<BundledRealtimeProviderRuntimeHost['writeProviderConversationState']>>[0],
    ) => {});
    const resumableDeclaration = Object.freeze({
      ...declaration,
      capabilities: Object.freeze({
        ...declaration.capabilities,
        turn: Object.freeze({
          ...declaration.capabilities.turn,
          resumption: 'resume' as const,
        }),
      }),
    });
    const leaf: PluginVoiceProviderRuntimeRegistration['protocol'] = {
      async prepare(input) {
        expect(input.providerConversation).toBeNull();
        return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    };
    const canPersistProviderConversationState = vi.fn(() => false);
    const protocol = createExternalProtocol(
      createHostFixture({
        transcriptEvents: [],
        lifecycleEvents: [],
        canPersistProviderConversationState,
        readProviderConversationState,
        writeProviderConversationState,
      }),
      providerId,
      'web',
      resumableDeclaration,
      leaf,
    );

    await protocol.prepare({
      controlSessionId: 'voice',
      attemptId: 1,
      reason: 'initial',
      request: null,
      signal: new AbortController().signal,
    });

    expect(canPersistProviderConversationState).toHaveBeenCalledWith({
      providerId,
      conversationSessionId: 'conversation-session-1',
    });
    expect(readProviderConversationState).not.toHaveBeenCalled();
    expect(writeProviderConversationState).not.toHaveBeenCalled();
  });

  it('materializes the generic UI action host only for a real Voice connection operation', async () => {
    const lifecycleEvents: string[] = [];
    const execute = vi.fn(async () => ({
      supported: true as const,
      result: { ok: true as const, result: { token: 'short-lived' } },
    }));
    const createInvocationUi = vi.fn((signal: AbortSignal) => createAppShellPluginUiInvocationHost({
      pluginId: 'acme.synthetic-voice', contributionId: 'conversation', generation: '12',
      machineId: 'machine-1', signal, isCurrent: () => true, execute,
    }));
    const createConnection = vi.fn(async (input: Parameters<PluginVoiceProviderRuntimeRegistration['createConnection']>[0]) => {
      expect(input.signal).toBeInstanceOf(AbortSignal);
      await expect(input.ui.executeAction('mint-session', { mode: 'realtime' }))
        .resolves.toEqual({ token: 'short-lived' });
      return {
        kind: 'sdk_handle' as const, async connect() {}, async sendControl() {},
        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }), async close() {},
        state: () => 'closed' as const, currentProviderSessionId: () => null, playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported' as const, resolveOutputInterruptionCandidate() {},
      };
    });
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({ transcriptEvents: [], lifecycleEvents }),
      platform: 'web',
      providerId,
      declaration,
      createInvocationUi,
      runtime: {
        protocol: {
          async prepare() { return { kind: 'prepared', session: { config: {}, safeMetadata: null } }; },
          decodeControl: () => [], encodeTurnControl: () => null,
        },
        createConnection,
        encodeToolResults: () => [], encodeToolContinuation: () => null,
        encodeContextUpdate: () => [], encodeTextTurn: () => [], requiresMicForConnection: false,
      },
    });

    await runtime.adapter.start({ sessionId: 'operation-context' });
    expect(createInvocationUi).toHaveBeenCalledTimes(1);
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('machine-1', expect.objectContaining({
      qualifiedActionId: 'acme.synthetic-voice/mint-session',
      executionSurface: 'ui',
      input: { mode: 'realtime' },
    }));
    expect(lifecycleEvents).toContain('connected');
    await runtime.dispose();
  });

  it('lets an external public runtime compose canonical raw-PCM capture and connection ownership', async () => {
    const lifecycleEvents: string[] = [];
    const pcmStart = vi.fn(async (_signal: AbortSignal) => {});
    const pcmStop = vi.fn(async () => {});
    const enqueueOutput = vi.fn((_base64Pcm16Le: string) => true);
    const clearOutput = vi.fn(() => {});
    const waitForOutputDrain = vi.fn(async () => {});
    const onInputChunk = vi.fn((_base64Pcm16Le: string) => {});
    const onInputError = vi.fn((_error: unknown) => {});
    const driverOpen = vi.fn(async () => {});
    const driverSendControl = vi.fn(async () => {});
    const driverClose = vi.fn(async () => {});
    let mediaConnection: ReturnType<
      Parameters<PluginVoiceProviderRuntimeRegistration['createConnection']>[0]['media']['createPcmConnection']
    > | null = null;
    const createWebSocketPcmMedia = vi.fn((input: Parameters<
      BundledRealtimeProviderRuntimeHost['createWebSocketPcmMedia']
    >[0]) => {
      input.onInputChunk('AQID');
      return Object.freeze({
        pcm: Object.freeze({ start: pcmStart, stop: pcmStop }),
        enqueueOutput,
        clearOutput,
        waitForOutputDrain,
      });
    });
    const createConnection = vi.fn(async (
      input: Parameters<PluginVoiceProviderRuntimeRegistration['createConnection']>[0],
    ) => {
      mediaConnection = input.media.createPcmConnection({
        driver: Object.freeze({
          open: driverOpen,
          sendControl: driverSendControl,
          close: driverClose,
        }),
        input: Object.freeze({ sampleRate: 24_000, chunkMs: 100 }),
        output: Object.freeze({ sampleRate: 24_000, maxBufferedMs: 240 }),
        onInputChunk,
        onInputError,
      });
      return mediaConnection.connection;
    });
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({
        transcriptEvents: [],
        lifecycleEvents,
        createWebSocketPcmMedia,
      }),
      platform: 'web',
      providerId,
      declaration,
      runtime: {
        protocol: {
          async prepare() {
            return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
          },
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        createConnection,
        encodeToolResults: () => [],
        encodeToolContinuation: () => null,
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
        requiresMicForConnection: true,
      },
    });

    await runtime.adapter.start({ sessionId: 'public-raw-pcm' });

    expect(lifecycleEvents).toEqual(expect.arrayContaining(['acquiring-mic', 'connecting', 'connected']));
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(createWebSocketPcmMedia).toHaveBeenCalledTimes(1);
    expect(onInputChunk).toHaveBeenCalledWith('AQID');
    expect(pcmStart).toHaveBeenCalledTimes(1);
    expect(driverOpen).toHaveBeenCalledTimes(1);
    expect(mediaConnection).not.toBeNull();
    expect(mediaConnection!.enqueueOutput('BAU=')).toBe(true);
    mediaConnection!.clearOutput();
    await mediaConnection!.waitForOutputDrain(new AbortController().signal);
    expect(enqueueOutput).toHaveBeenCalledWith('BAU=');
    expect(clearOutput).toHaveBeenCalledTimes(1);
    expect(waitForOutputDrain).toHaveBeenCalledTimes(1);

    await runtime.dispose();

    expect(pcmStop).toHaveBeenCalledTimes(1);
    expect(driverClose).toHaveBeenCalledTimes(1);
    expect(lifecycleEvents).toContain('ending');
    expect(lifecycleEvents.at(-1)).toBe('mirror-disposed');
  });

  it('loads the packed public activation leaf and routes transcript, tools, privacy, cancellation, and teardown through canonical host owners', async () => {
    const transcriptEvents: unknown[] = [];
    const lifecycleEvents: string[] = [];
    const fixtureRoot = new URL(
      '../../../../cli/src/plugins/testkit/fixtures/packed-external-voice-provider/',
      import.meta.url,
    );
    const [artifactBytes, manifestText] = await Promise.all([
      readFile(new URL(
        'dist/happier-plugin-ui/react-native/voice-runtime-web/index.js',
        fixtureRoot,
      )),
      readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8'),
    ]);
    const bytes = new Uint8Array(artifactBytes);
    const manifest = JSON.parse(manifestText) as Readonly<{ contributes?: unknown }>;
    const packedContributes = PluginContributesV2Schema.parse(manifest.contributes);
    const packedDeclaration = packedContributes.voiceProviders[0];
    if (packedDeclaration?.kind !== 'conversation') {
      throw new Error('packed_voice_conversation_declaration_required');
    }
    const packedProviderSettings = createExternalVoiceProviderSettingsDescriptor(
      packedDeclaration.settings,
    );
    expect(packedProviderSettings).toMatchObject({
      schemaVersion: 2,
      defaultConfig: {
        mode: 'default',
        profile: 'balanced',
        enableProvisioning: true,
      },
    });
    expect(projectExternalVoiceProviderSettings(null, packedProviderSettings))
      .toEqual({ status: 'needs_migration', modeId: null });
    expect(projectExternalVoiceProviderSettings({
      schemaVersion: 1,
      config: packedProviderSettings.defaultConfig,
    }, packedProviderSettings)).toEqual({ status: 'unsupported_version', modeId: null });
    expect(projectExternalVoiceProviderSettings({
      schemaVersion: 2,
      config: { mode: 'default', profile: 'unsupported', enableProvisioning: true },
    }, packedProviderSettings)).toEqual({ status: 'invalid', modeId: null });
    expect(projectExternalVoiceProviderSettings({
      schemaVersion: 2,
      config: packedProviderSettings.defaultConfig,
    }, packedProviderSettings)).toEqual({ status: 'ready', modeId: 'default' });
    const digest = computePluginUiArtifactSha256DigestV1(bytes);
    const identity = Object.freeze({
      pluginId: 'acme.packed-voice', contributionId: 'voice-runtime-bundle', artifactDigest: digest,
      hostAppVersion: '2.0.0', hostUiApiVersion: '1.0.0', reactVersion: '19.0.0', reactNativeVersion: '0.83.4',
      platform: 'web', channel: 'internal', nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`, projectionGeneration: 12,
    });
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
    const source = new TextDecoder().decode(bytes);
    const backend = createReactNativeWebLoaderBackend({
      importModule: async () => import(
        /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}#${digest}`
      ) as Promise<Readonly<{ default?: unknown } & Record<string, unknown>>>,
    });
    expect(packedDeclaration.platforms).toEqual(['web']);
    await expect(loadPluginReactNativeBundleExport({
      cache,
      identity,
      moduleReference: { containerName: 'acme_packed_voice', modulePath: './voiceRuntime', exportName: 'activate' },
      backend,
      hostPlatform: 'ios',
    })).resolves.toMatchObject({
      ok: false,
      code: 'platform_mismatch',
    });
    const loaded = await loadPluginReactNativeBundleExport({
      cache,
      identity,
      moduleReference: { containerName: 'acme_packed_voice', modulePath: './voiceRuntime', exportName: 'activate' },
      backend,
      hostPlatform: 'web',
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    let registration: PluginVoiceProviderRuntimeRegistration | null = null;
    const activationApi: Pick<PluginApi, 'voiceProviders'> = Object.freeze({
      voiceProviders: Object.freeze({
        register(id: string, runtime: PluginVoiceProviderRuntimeRegistration) {
          expect(id).toBe('conversation');
          registration = runtime;
        },
        registerSpeech(id: string): never {
          throw new Error(`unexpected_voice_speech_provider_registration:${id}`);
        },
      }),
    });
    await Reflect.apply(loaded.exported, undefined, [activationApi]);
    expect(registration).not.toBeNull();
    const fixtureEvents = (globalThis as Readonly<Record<string, unknown>>)
      .__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__ as unknown[];
    const attemptToolExecute = vi.fn(async () => ({
      ok: true,
      machineId: 'machine-visible',
    }));
    const accountOperationRequest = vi.fn(async (
      request: Parameters<
        ReturnType<NonNullable<
          Parameters<typeof createExternalVoiceProviderRuntimeContribution>[0]['createInvocationAccountOperations']
        >>['request']
      >[0],
    ) => {
      const body = request.operationId === 'list-voices'
        ? {
            voices: [{
              voice_id: 'packed-voice-primary',
              name: 'Fixture Voice',
              language: 'en',
              preview_url: 'https://malicious.example.invalid/voice?credential=leak',
              provider_only: true,
            }],
            provider_only: true,
          }
        : request.operationId === 'provision-voice'
          ? {
              provisioned_voice_id: 'packed-voice-primary',
              profile: 'balanced',
            }
          : {
              client_secret: {
                value: 'short-lived-packed-artifact',
                expires_at_ms: Date.now() + 60_000,
              },
            };
      return Object.freeze({
        status: 200,
        finalUrl: `https://voice.example.test/${request.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });
    const packedRuntime = registration as unknown as PluginVoiceProviderRuntimeRegistration;
    let settingsGenerationCurrent = true;
    const settingsAccountOperationSignals: AbortSignal[] = [];
    const createSettingsAccountOperations = vi.fn((signal: AbortSignal) => {
      settingsAccountOperationSignals.push(signal);
      return Object.freeze({ request: accountOperationRequest });
    });
    const boundSettingsOperations = bindVoiceProviderSettingsOperations({
      operations: packedRuntime.settingsOperations!,
      createAccountOperations: createSettingsAccountOperations,
      isCurrent: () => settingsGenerationCurrent,
    });
    const settingsOperationSignal = new AbortController().signal;
    await expect(boundSettingsOperations.listCatalog?.({
      catalog: 'voices',
      providerConfig: packedProviderSettings.defaultConfig,
      signal: settingsOperationSignal,
    })).resolves.toEqual([{
      id: 'packed-voice-primary',
      name: 'Fixture Voice',
      metadata: { language: 'en' },
    }]);
    await expect(boundSettingsOperations.provision?.({
      request: { kind: 'provision_selected_voice', voiceId: 'packed-voice-primary' },
      providerConfig: packedProviderSettings.defaultConfig,
      disabledActionIds: ['machines.list'],
      extraSystemAppendBlocks: ['private session summary'],
      signal: settingsOperationSignal,
    })).resolves.toEqual({
      selectedVoiceId: 'packed-voice-primary',
      profile: 'balanced',
      disabledActionIds: ['machines.list'],
      extraSystemAppendBlockCount: 1,
    });
    expect(createSettingsAccountOperations).toHaveBeenCalledTimes(2);
    expect(settingsAccountOperationSignals).toHaveLength(2);
    expect(accountOperationRequest.mock.calls[0]?.[0].signal).toBe(settingsAccountOperationSignals[0]);
    expect(accountOperationRequest.mock.calls[1]?.[0].signal).toBe(settingsAccountOperationSignals[1]);
    settingsGenerationCurrent = false;
    await expect(boundSettingsOperations.listCatalog?.({
      catalog: 'voices',
      providerConfig: packedProviderSettings.defaultConfig,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    const abortedSettingsOperation = new AbortController();
    abortedSettingsOperation.abort();
    settingsGenerationCurrent = true;
    await expect(boundSettingsOperations.provision?.({
      request: { kind: 'provision_selected_voice', voiceId: 'packed-voice-primary' },
      providerConfig: packedProviderSettings.defaultConfig,
      disabledActionIds: [],
      extraSystemAppendBlocks: [],
      signal: abortedSettingsOperation.signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
    const settingsRetirement = new AbortController();
    let pendingMutationSignal: AbortSignal | null = null;
    const retirementBoundSettingsOperations = bindVoiceProviderSettingsOperations({
      operations: packedRuntime.settingsOperations!,
      createAccountOperations: () => Object.freeze({
        request: async (request) => {
          if (request.operationId !== 'provision-voice') {
            throw new Error(`unexpected_pending_operation:${request.operationId}`);
          }
          pendingMutationSignal = request.signal;
          return await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('voice_account_operation_cancelled'), {
                code: 'voice_account_operation_cancelled',
              }));
            }, { once: true });
          });
        },
      }),
      isCurrent: () => !settingsRetirement.signal.aborted,
      revocationSignal: settingsRetirement.signal,
    });
    const pendingMutation = retirementBoundSettingsOperations.provision!({
      request: { kind: 'provision_selected_voice', voiceId: 'packed-voice-primary' },
      providerConfig: packedProviderSettings.defaultConfig,
      disabledActionIds: [],
      extraSystemAppendBlocks: [],
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(pendingMutationSignal).not.toBeNull());
    settingsRetirement.abort();
    await expect(pendingMutation).rejects.toMatchObject({
      code: 'voice_account_operation_cancelled',
    });
    expect(pendingMutationSignal).toMatchObject({ aborted: true });
    const createInvocationAccountOperations = vi.fn(() => Object.freeze({
      request: accountOperationRequest,
    }));
    const hostCreateSdkHandleConnection = vi.fn(createSdkHandleConnection);
    const executeImpl: AppShellPluginUiActionExecute = async (_machineId, request) => {
      throw new Error(`unexpected_voice_ui_action:${request.qualifiedActionId}`);
    };
    const execute = vi.fn(executeImpl);
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({
        transcriptEvents,
        lifecycleEvents,
        createSdkHandleConnection: hostCreateSdkHandleConnection,
        getRealtimeClientToolDefinitions: () => [Object.freeze({
          name: 'listMachines',
          description: 'List available machines',
          parameters: Object.freeze({
            type: 'object',
            properties: Object.freeze({
              limit: Object.freeze({ type: 'number' }),
            }),
          }),
          execute: attemptToolExecute,
        })],
        readProviderConfig: () => packedProviderSettings.defaultConfig,
      }),
      platform: 'web',
      providerId,
      declaration: packedDeclaration,
      providerSettings: packedProviderSettings,
      createInvocationAccountOperations,
      createInvocationUi: (signal) => createAppShellPluginUiInvocationHost({
        pluginId: 'acme.packed-voice',
        contributionId: 'conversation',
        generation: '12',
        machineId: 'machine-1',
        signal,
        isCurrent: () => true,
        execute,
      }),
      runtime: packedRuntime,
    });

    await runtime.adapter.start({ sessionId: 'control-session-1' });
    await vi.waitFor(() => {
      expect(JSON.stringify(fixtureEvents)).toContain('fixture_continue');
    });
    expect(transcriptEvents).toEqual([expect.objectContaining({ text: 'packed provider transcript' })]);
    expect(lifecycleEvents).toContain('connected');
    expect(createInvocationAccountOperations).toHaveBeenCalledTimes(1);
    expect(accountOperationRequest.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        operationId: 'list-voices',
        parameters: {},
      }),
      expect.objectContaining({
        operationId: 'provision-voice',
        parameters: {
          voiceId: 'packed-voice-primary',
          body: { profile: 'balanced' },
        },
      }),
      expect.objectContaining({
        operationId: 'client-auth',
        parameters: { body: { audience: 'realtime', voiceId: 'packed-voice-primary' } },
      }),
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(hostCreateSdkHandleConnection).toHaveBeenCalledTimes(1);
    expect(attemptToolExecute).toHaveBeenCalledWith({ limit: 10 });
    expect(fixtureEvents).toContainEqual({
      kind: 'catalog',
      selectedVoiceId: 'packed-voice-primary',
    });
    expect(fixtureEvents).toContainEqual({
      kind: 'provisioned',
      selectedVoiceId: 'packed-voice-primary',
      profile: 'balanced',
    });
    expect(fixtureEvents).toContainEqual(expect.objectContaining({
      kind: 'client_auth',
      artifact: expect.objectContaining({
        kind: 'bearer_token',
        placement: 'authorization_header',
      }),
    }));
    expect(fixtureEvents).toContainEqual({
      kind: 'attempt_tool',
      toolName: 'listMachines',
      result: {
        ok: true,
        machineId: 'machine-visible',
      },
    });
    expect(JSON.stringify(fixtureEvents)).toContain('machine-visible');
    expect(JSON.stringify(fixtureEvents)).not.toContain('short-lived-packed-artifact');
    expect(JSON.stringify(fixtureEvents)).not.toContain('malicious.example.invalid');
    expect(JSON.stringify(fixtureEvents)).not.toContain('private session summary');
    expect(JSON.stringify(fixtureEvents)).not.toContain('/Users/alice');

    await runtime.adapter.interrupt({ sessionId: 'control-session-1' });
    expect(JSON.stringify(fixtureEvents)).toContain('fixture_cancel');
    await runtime.dispose();
    expect(JSON.stringify(fixtureEvents)).toContain('user_stop');
    expect(JSON.stringify(fixtureEvents)).toContain('runtime_disposed');
    expect(lifecycleEvents.at(-1)).toBe('mirror-disposed');
  });

  it('fails closed when a provider leaf returns a malformed connection', async () => {
    const lifecycleEvents: string[] = [];
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({ transcriptEvents: [], lifecycleEvents }),
      platform: 'web',
      providerId,
      declaration,
      runtime: {
        protocol: {
          async prepare() {
            return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
          },
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        // Deliberately malformed external-boundary fixture.
        createConnection: async () => ({ kind: 'sdk_handle' }) as VoiceRealtimeConnection,
        encodeToolResults: () => [],
        encodeToolContinuation: (responseId) => ({ kind: 'continue', responseId }),
        encodeContextUpdate: (text) => [{ kind: 'context', text }],
        encodeTextTurn: (text) => [{ kind: 'text', text }],
        requiresMicForConnection: false,
      },
    });

    await expect(runtime.adapter.start({ sessionId: 'malformed-connection' }))
      .rejects.toMatchObject({ code: 'invalid_external_voice_provider_connection' });
    expect(lifecycleEvents).toContain('error');
    expect(lifecycleEvents).not.toContain('connected');
    await runtime.dispose();
  });
});
