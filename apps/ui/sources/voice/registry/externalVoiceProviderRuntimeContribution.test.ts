import { readFile } from 'node:fs/promises';

import type {
  BundledRealtimeProviderRuntimeHost,
} from '@/voice/registry/bundledConversationRuntimeContract';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { VoiceCredentialAccess } from '@happier-dev/plugin-sdk/voice';
import type {
  RealtimeVoiceProviderRuntime,
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';
import {
  createVoiceProviderRecipientContractFromCredentialsV1,
  PluginContributesV2Schema,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
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
import type { VoiceSessionSnapshot } from '@/voice/session/types';
import { storage } from '@/sync/domains/state/storage';
import { createVoiceClientRawCredentialAccess } from '@/voice/credentials/rawCredentialClient';

import {
  bindVoiceProviderSettingsActions,
  bindVoiceProviderSettingsOperations,
  createExternalProtocol,
  createExternalVoiceProviderActivationScope,
  createExternalVoiceProviderRuntimeContribution,
} from './externalVoiceProviderActivation';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
} from '../settings/externalProviderSettings';

const mediatedCredentialMachineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: mediatedCredentialMachineRpc,
}));
vi.mock('@/voice/settings/executionMachine', () => ({
  resolveVoiceExecutionMachineId: () => 'machine-1',
}));

const providerId = 'acme.synthetic-voice/conversation';
const parsedDeclaration = PluginContributesV2Schema.parse({ voiceProviders: [{
  id: 'conversation', title: 'Synthetic Conversation', kind: 'conversation',
  roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
  platforms: ['web'],
  capabilities: {
    turn: { cancelResponse: true, bargeIn: false },
  },
  credentials: {
    slot: {
      id: 'api_key',
      purpose: 'voice.client-auth',
      title: 'Synthetic credential',
    },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      operationProjections: [{
        kind: 'recipientCredential',
        operation: 'client-auth',
        phase: 'prepare',
        format: 'bearer',
      }],
    }],
    hostMediated: { operations: [{
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
    }] },
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
    runCurrentGenerationEffect(callback: () => void): boolean {
      callback();
      return true;
    },
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
    openLevelWriter: () => ({ write: () => {}, reset: () => {}, close: () => {} }),
    projectTranscript: ({ event }: Readonly<{ event: unknown }>) => {
      input.transcriptEvents.push(event);
      return null;
    },
    admitTranscriptPersistenceEvent: () => null,
    commitAdmittedTranscriptPersistenceEvent: () => null,
    releaseAdmittedTranscriptPersistenceEvent: () => false,
    settleTranscriptPersistence: async () => {},
    beginTranscriptAttempt: () => ({
      epoch: 1,
      attemptIdentity: 'attempt-1',
    }),
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
  it('retires retained settings raw credentials when their host invocation settles or aborts', async () => {
    const clientInvoke = vi.fn(async () => Object.freeze({
      ok: true,
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        headers: Object.freeze({ authorization: 'Bearer retained' }),
      }),
      credentialRevision: null,
    }));
    const retained: NonNullable<VoiceCredentialAccess<'settings'>['raw']>[] = [];
    const invocationSignals: AbortSignal[] = [];
    const settingsOperations = bindVoiceProviderSettingsOperations({
      operations: Object.freeze({
        async listCatalog(input): Promise<readonly VoiceRealtimeJsonValue[]> {
          if (!input.credentials.raw) throw new Error('expected raw credentials');
          retained.push(input.credentials.raw);
          if (retained.length === 2) {
            await new Promise<never>((_resolve, reject) => {
              const rejectAbort = () => reject(Object.assign(new Error('settings cancelled'), {
                name: 'AbortError',
              }));
              if (input.signal.aborted) rejectAbort();
              else input.signal.addEventListener('abort', rejectAbort, { once: true });
            });
          }
          return [];
        },
      }),
      createCredentials: (signal) => {
        invocationSignals.push(signal);
        return Object.freeze({
          phase: 'settings' as const,
          mediated: null,
          raw: createVoiceClientRawCredentialAccess({
            identity: Object.freeze({
              pluginId: 'acme.synthetic-voice',
              contributionId: 'conversation',
              artifactDigest: `sha256:${'b'.repeat(64)}`,
              hostAppVersion: '2.0.0',
              hostUiApiVersion: '1.0.0',
              reactVersion: '19.0.0',
              reactNativeVersion: '0.83.4',
              platform: 'web' as const,
              channel: 'internal' as const,
              nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
              projectionGeneration: 12,
            }),
            phase: 'settings',
            isCurrent: () => true,
            isInvocationCurrent: () => true,
            client: { invoke: clientInvoke },
            signal,
          }),
        });
      },
      isCurrent: () => true,
    });
    const rawRequest = Object.freeze({
      kind: 'httpHeaders' as const,
      origin: 'https://voice.example.test',
      headerNames: Object.freeze(['authorization']),
    });

    await expect(settingsOperations.listCatalog?.({
      catalog: 'voices',
      providerConfig: Object.freeze({}),
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
    expect(invocationSignals[0]?.aborted).toBe(true);
    await expect(retained[0]!.materialize(rawRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(clientInvoke).not.toHaveBeenCalled();

    const caller = new AbortController();
    const cancelled = settingsOperations.listCatalog?.({
      catalog: 'voices',
      providerConfig: Object.freeze({}),
      signal: caller.signal,
    });
    await Promise.resolve();
    caller.abort();
    await expect(cancelled).rejects.toHaveProperty('name', 'AbortError');
    expect(invocationSignals[1]?.aborted).toBe(true);
    await expect(retained[1]!.materialize(rawRequest)).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(clientInvoke).not.toHaveBeenCalled();
  });

  it('retires retained prepare and connection raw credentials when each host leaf returns', async () => {
    const invocationSignals: { prepare: AbortSignal | null; connection: AbortSignal | null } = {
      prepare: null,
      connection: null,
    };
    let prepareRaw: VoiceCredentialAccess<'prepare'>['raw'] = null;
    let connectionRaw: VoiceCredentialAccess<'connection'>['raw'] = null;
    const createInvocationRawCredentials = (
      phase: 'prepare' | 'connection',
      signal: AbortSignal,
    ) => {
      invocationSignals[phase] = signal;
      return Object.freeze({
        async materialize() {
          if (signal.aborted) {
            throw Object.assign(new Error('raw credential access unavailable'), {
              code: 'plugin_voice_credential_access_unavailable',
            });
          }
          return Object.freeze({
            kind: 'httpHeaders' as const,
            headers: Object.freeze({ authorization: 'Bearer live' }),
          });
        },
      });
    };
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({ transcriptEvents: [], lifecycleEvents: [] }),
      platform: 'web',
      providerId,
      declaration,
      createInvocationRawCredentials,
      runtime: {
        kind: 'conversation',
        protocol: {
          async prepare(input) {
            prepareRaw = input.credentials.raw;
            return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
          },
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        async createConnection(input) {
          connectionRaw = input.credentials.raw;
          return {
            kind: 'sdk_handle' as const,
            async connect() {},
            async sendControl() {},
            controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
            transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
            async close() {},
            state: () => 'closed' as const,
            currentProviderSessionId: () => null,
            playbackCursorMs: () => null,
            beginOutputInterruptionCandidate: () => 'unsupported' as const,
            resolveOutputInterruptionCandidate() {},
          };
        },
        encodeToolResults: () => [],
        encodeToolContinuation: () => null,
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
        microphoneMode: 'provider_managed',
      },
    });
    const rawRequest = Object.freeze({
      kind: 'httpHeaders' as const,
      origin: 'https://voice.example.test',
      headerNames: Object.freeze(['authorization']),
    });

    try {
      await runtime.adapter.start({ sessionId: 'raw-invocation-lifetime' });

      expect(invocationSignals.prepare?.aborted).toBe(true);
      expect(invocationSignals.connection?.aborted).toBe(true);
      await expect(prepareRaw!.materialize(rawRequest)).rejects.toMatchObject({
        code: 'plugin_voice_credential_access_unavailable',
      });
      await expect(connectionRaw!.materialize(rawRequest)).rejects.toMatchObject({
        code: 'plugin_voice_credential_access_unavailable',
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('bounds final catalog responses exposed by provider settings operations', async () => {
    const oversizedCatalog = bindVoiceProviderSettingsOperations({
      operations: Object.freeze({
        async listCatalog(): Promise<readonly VoiceRealtimeJsonValue[]> {
          return Array.from({ length: 1_001 }, (_, index) => Object.freeze({ id: String(index) }));
        },
      }),
      createCredentials: (signal) => Object.freeze({
        phase: 'settings' as const,
        mediated: Object.freeze({
          request: vi.fn(async () => {
            signal.throwIfAborted();
            throw new Error('unexpected_account_request');
          }),
        }),
        raw: null,
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
      createCredentials: () => Object.freeze({
        phase: 'settings' as const,
        mediated: Object.freeze({
          request: vi.fn(async () => {
            throw new Error('unexpected_account_request');
          }),
        }),
        raw: null,
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
    const leaf: RealtimeVoiceProviderRuntime['protocol'] = {
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
    type PrepareInput = Parameters<RealtimeVoiceProviderRuntime['protocol']['prepare']>[0];
    const lifecycleEvents: string[] = [];
    const materializeAccountSecret = vi.fn(async () => 'account-secret');
    const request = vi.fn(async (
      _input: Parameters<NonNullable<PrepareInput['credentials']['mediated']>['request']>[0],
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
        kind: 'conversation',
        protocol: {
          async prepare(input: PrepareInput) {
            expect(input.providerConversation).toBeNull();
            const response = await input.credentials.mediated!.request({
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
        encodeContextUpdate: () => [], encodeTextTurn: () => [], microphoneMode: 'provider_managed',
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

  it.each(['prepare', 'connection'] as const)(
    'stamps default host-mediated account operations with their declared %s phase only',
    async (declaredPhase) => {
    const parsedPhaseDeclaration = PluginContributesV2Schema.parse({
      voiceProviders: [{
        ...declaration,
        id: `${declaredPhase}-credential-conversation`,
        credentials: {
          ...declaration.credentials,
          sources: [{
            kind: 'connectedAccount' as const,
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            operationProjections: [{
              kind: 'materializedHttpHeaders' as const,
              operation: 'client-auth',
              phase: declaredPhase,
              request: {
                kind: 'httpHeaders' as const,
                origin: 'https://voice.example.test',
                headerNames: ['authorization'],
              },
              allowedHeaderNames: ['authorization'],
            }],
          }],
        },
      }],
    }).voiceProviders[0]!;
    if (parsedPhaseDeclaration.kind !== 'conversation' || !parsedPhaseDeclaration.credentials?.hostMediated) {
      throw new Error('expected conversation declaration');
    }
    const pluginId = 'acme.synthetic-voice';
    const contribution = Object.freeze({
      pluginId,
      localId: parsedPhaseDeclaration.id,
    });
    const phaseProviderId = `${pluginId}/${parsedPhaseDeclaration.id}`;
    const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
      package: {
        pluginId,
        source: { kind: 'package', locator: pluginId },
      },
      publisher: {
        trust: 'verified',
        identity: `package:${pluginId}`,
      },
      contribution,
      credentials: {
        slot: parsedPhaseDeclaration.credentials.slot,
        hostMediated: parsedPhaseDeclaration.credentials.hostMediated,
      },
      presentation: { title: parsedPhaseDeclaration.title },
    });
    const previousSettings = storage.getState().settings;
    storage.setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        voiceSettingsV1: {
          ...current.settings.voiceSettingsV1,
          credentialBindings: [{
            contribution,
            credentialSlotId: 'api_key',
            credentialSource: { kind: 'connectedAccount' as const },
            credentialBindings: { account: {} },
          }],
        },
        connectedAccountPurposeBindingsV1: {
          v: 1 as const,
          bindings: [{
            purpose: { consumer: contribution, purpose: 'voice.client-auth' },
            target: {
              kind: 'account' as const,
              account: {
                service: {
                  pluginId: 'happier.agent.codex',
                  localId: 'openai-codex',
                },
                accountId: 'codex-work',
              },
            },
          }],
        },
      },
    }) as never);
    mediatedCredentialMachineRpc.mockResolvedValue({
      ok: true,
      headers: { authorization: 'Bearer connected-account-token' },
    });
    const providerFetch = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', providerFetch);
    const accountRequests: Array<'prepare' | 'connection'> = [];
    const observedCredentialAccess: Array<Readonly<{
      phase: 'prepare' | 'connection';
      mediated: boolean;
    }>> = [];
    const requestAccountOperation = async (
      credentials: VoiceCredentialAccess<'prepare' | 'connection'>,
    ) => {
      expect(credentials.phase).toBe(declaredPhase);
      expect(credentials.mediated).not.toBeNull();
      accountRequests.push(credentials.phase);
      await credentials.mediated!.request({
        operationId: 'client-auth',
        parameters: {},
        signal: new AbortController().signal,
      });
    };
    const host = Object.freeze({
      ...createHostFixture({ transcriptEvents: [], lifecycleEvents: [] }),
      projectVoiceSettings: () => ({ providerId: phaseProviderId, providerConfig: {} }),
    });
    const scope = createExternalVoiceProviderActivationScope({
      pluginId,
      declarations: [parsedPhaseDeclaration],
      hostPlatform: 'web',
      runtimeHost: host,
      isRuntimeHostCurrent: () => true,
      recipientContractsByLocalId: {
        [parsedPhaseDeclaration.id]: recipientContract,
      },
    });
    try {
      scope.api.voiceProviders.register(parsedPhaseDeclaration.id, {
        kind: 'conversation',
        protocol: {
          async prepare(input) {
            observedCredentialAccess.push({
              phase: input.credentials.phase,
              mediated: input.credentials.mediated !== null,
            });
            expect(input.credentials.phase).toBe('prepare');
            if (declaredPhase === 'prepare') await requestAccountOperation(input.credentials);
            else expect(input.credentials.mediated).toBeNull();
            return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
          },
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        async createConnection(input) {
          observedCredentialAccess.push({
            phase: input.credentials.phase,
            mediated: input.credentials.mediated !== null,
          });
          expect(input.credentials.phase).toBe('connection');
          if (declaredPhase === 'connection') await requestAccountOperation(input.credentials);
          else expect(input.credentials.mediated).toBeNull();
          return {
            kind: 'sdk_handle' as const, async connect() {}, async sendControl() {},
            controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
            transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }), async close() {},
            state: () => 'closed' as const, currentProviderSessionId: () => null, playbackCursorMs: () => null,
            beginOutputInterruptionCandidate: () => 'unsupported' as const, resolveOutputInterruptionCandidate() {},
          };
        },
        encodeToolResults: () => [], encodeToolContinuation: () => null,
        encodeContextUpdate: () => [], encodeTextTurn: () => [], microphoneMode: 'provider_managed',
      });
      await scope.commit();
      const registration = getExternalVoiceProviderRegistration(phaseProviderId);
      if (!registration?.adapter) throw new Error('expected external Voice registration');
      await registration.adapter.start({ sessionId: `${declaredPhase}-account-operation-context` });

      expect(observedCredentialAccess).toEqual(declaredPhase === 'prepare'
        ? [{ phase: 'prepare', mediated: true }, { phase: 'connection', mediated: false }]
        : [{ phase: 'prepare', mediated: false }, { phase: 'connection', mediated: true }]);
      expect(accountRequests).toEqual([declaredPhase]);
      expect(mediatedCredentialMachineRpc).toHaveBeenCalledTimes(1);
      expect(mediatedCredentialMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
        method: RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE,
        payload: expect.objectContaining({
          contribution,
          phase: declaredPhase,
          operationId: 'client-auth',
        }),
      }));
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      await scope.unwind();
      storage.setState((current) => ({ ...current, settings: previousSettings }));
      vi.unstubAllGlobals();
      mediatedCredentialMachineRpc.mockReset();
    }
  });

  it('fails provider account preparation before acquiring the microphone', async () => {
    const lifecycleEvents: string[] = [];
    const ensureMicActive = vi.fn(async () => {});
    const request = vi.fn(async () => {
      throw Object.assign(new Error('voice_account_operation_unavailable'), {
        code: 'voice_account_operation_unavailable',
      });
    });
    const providerPrepare = vi.fn(async (
      input: Parameters<RealtimeVoiceProviderRuntime['protocol']['prepare']>[0],
    ) => {
      await input.credentials.mediated!.request({
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
      runtime: {
        kind: 'conversation',
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
        microphoneMode: 'host_webrtc',
      },
    });

    await expect(runtime.adapter.start({ sessionId: 'account-readiness' }))
      .rejects.toMatchObject({ code: 'voice_account_operation_unavailable' });

    expect(ensureMicActive).not.toHaveBeenCalled();
    expect(providerPrepare).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(lifecycleEvents).toEqual(['connecting', 'error']);
    await runtime.dispose();
  });

  it('declines a selected Connected Service source with no binding before microphone, audio, or provider construction', async () => {
    const lifecycleEvents: string[] = [];
    const ensureMicActive = vi.fn(async () => {});
    const acquireAudioMode = vi.fn(async () => ({
      release: async () => {},
    }));
    const createMachineError = vi.fn(
      (
        input: Parameters<
          BundledRealtimeProviderRuntimeHost['createMachineError']
        >[0],
      ) => ({
        ...input,
        phase: 'preflight' as const,
        retryPolicy: 'user_action' as const,
        recoveryAction: 'review_credentials' as const,
        presentation: 'error' as const,
        recoverable: false,
      }),
    );
    const request = vi.fn(async () => {
      throw Object.assign(new Error('credential_unavailable'), {
        code: 'credential_unavailable',
      });
    });
    const providerPrepare = vi.fn(async (
      input: Parameters<RealtimeVoiceProviderRuntime['protocol']['prepare']>[0],
    ) => {
      await input.credentials.mediated!.request({
        operationId: 'client-auth',
        parameters: {},
        signal: input.signal,
      });
      return {
        kind: 'prepared' as const,
        session: { config: {}, safeMetadata: null },
      };
    });
    const createConnection = vi.fn(async () => {
      throw new Error('provider_connection_must_not_run');
    });
    const baseHost = createHostFixture({
      transcriptEvents: [],
      lifecycleEvents,
      ensureMicActive,
      readProviderConfig: () => ({
        authentication: { source: 'connected_service_api_key' },
      }),
    });
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: Object.freeze({
        ...baseHost,
        acquireAudioMode,
        createMachineError,
      }),
      platform: 'web',
      providerId,
      declaration,
      createInvocationAccountOperations: () => Object.freeze({ request }),
      runtime: {
        kind: 'conversation',
        protocol: {
          preflight: async () => ({ kind: 'ready' as const }),
          prepare: providerPrepare,
          decodeControl: () => [],
          encodeTurnControl: () => null,
        },
        createConnection,
        encodeToolResults: () => [],
        encodeToolContinuation: () => null,
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
        microphoneMode: 'provider_managed',
      },
    });

    await expect(runtime.adapter.start({ sessionId: 'missing-connected-account' }))
      .resolves.toBeUndefined();

    expect(createMachineError).toHaveBeenCalledWith({
      kind: 'provider_auth_invalid',
      reason: 'credential_unavailable',
    });
    expect(ensureMicActive).not.toHaveBeenCalled();
    expect(acquireAudioMode).not.toHaveBeenCalled();
    expect(providerPrepare).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(createConnection).not.toHaveBeenCalled();
    expect(lifecycleEvents).toEqual(['connecting', 'disconnected']);
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
    const leaf: RealtimeVoiceProviderRuntime['protocol'] = {
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
    const leaf: RealtimeVoiceProviderRuntime['protocol'] = {
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
    const executionOrigin = Object.freeze({
      serverIdentityId: 'server-1',
      materializationRef: Object.freeze({
        pluginId: 'acme.synthetic-voice',
        machineId: 'machine-1',
        materializationId: 'materialization-voice-current',
      }),
    });
    const createInvocationUi = vi.fn((signal: AbortSignal) => createAppShellPluginUiInvocationHost({
      pluginId: 'acme.synthetic-voice', contributionId: 'conversation', generation: '12',
      machineId: 'machine-1', executionOrigin, signal, isCurrent: () => true, execute,
    }));
    const createConnection = vi.fn(async (input: Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]) => {
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
        kind: 'conversation',
        protocol: {
          async prepare() { return { kind: 'prepared', session: { config: {}, safeMetadata: null } }; },
          decodeControl: () => [], encodeTurnControl: () => null,
        },
        createConnection,
        encodeToolResults: () => [], encodeToolContinuation: () => null,
        encodeContextUpdate: () => [], encodeTextTurn: () => [], microphoneMode: 'provider_managed',
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

  it('keeps the unavailable Voice invocation UI conformant without adding a content reader', async () => {
    const lifecycleEvents: string[] = [];
    const createConnection = vi.fn(async (input: Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]) => {
      await expect(input.ui.statOpenableContent({ kind: 'workspaceFile', handle: 'viewer-file-1' }))
        .rejects.toMatchObject({ code: 'plugin_ui_action_host_unavailable' });
      await expect(input.ui.readOpenableContent({
        ref: { kind: 'workspaceFile', handle: 'viewer-file-1' },
        expectedRevision: 'revision-1',
        maxBytes: 1_024,
      })).rejects.toMatchObject({ code: 'plugin_ui_action_host_unavailable' });
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
      runtime: {
        kind: 'conversation',
        protocol: {
          async prepare() { return { kind: 'prepared', session: { config: {}, safeMetadata: null } }; },
          decodeControl: () => [], encodeTurnControl: () => null,
        },
        createConnection,
        encodeToolResults: () => [], encodeToolContinuation: () => null,
        encodeContextUpdate: () => [], encodeTextTurn: () => [], microphoneMode: 'provider_managed',
      },
    });

    await runtime.adapter.start({ sessionId: 'operation-context' });
    expect(createConnection).toHaveBeenCalledTimes(1);
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
      Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]['media']['createPcmConnection']
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
      input: Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0],
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
        kind: 'conversation',
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
        microphoneMode: 'host_pcm',
      },
    });

    await runtime.adapter.start({ sessionId: 'public-raw-pcm' });

    expect(lifecycleEvents).toEqual(expect.arrayContaining(['connecting', 'connected']));
    expect(lifecycleEvents).not.toContain('acquiring-mic');
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
    expect(lifecycleEvents).toContain('disconnected');
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
      config: { profile: 'unsupported', enableProvisioning: true },
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
    let registration: RealtimeVoiceProviderRuntime | null = null;
    const activationApi: Pick<PluginApi, 'voiceProviders'> = Object.freeze({
      voiceProviders: Object.freeze({
        register(id: string, runtime: RealtimeVoiceProviderRuntime) {
          if (id === packedDeclaration.id) registration = runtime;
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
    const packedRuntime = registration as unknown as RealtimeVoiceProviderRuntime & Readonly<{
      settingsActions?: Parameters<typeof bindVoiceProviderSettingsActions>[0]['actions'];
    }>;
    let settingsGenerationCurrent = true;
    const settingsAccountOperationSignals: AbortSignal[] = [];
    const createSettingsCredentials = vi.fn((signal: AbortSignal) => {
      settingsAccountOperationSignals.push(signal);
      return Object.freeze({
        phase: 'settings' as const,
        mediated: Object.freeze({ request: accountOperationRequest }),
        raw: null,
      });
    });
    const boundSettingsOperations = bindVoiceProviderSettingsOperations({
      operations: packedRuntime.settingsOperations!,
      createCredentials: createSettingsCredentials,
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
    expect(createSettingsCredentials).toHaveBeenCalledTimes(1);
    expect(settingsAccountOperationSignals).toHaveLength(1);
    expect(accountOperationRequest.mock.calls[0]?.[0].signal).toBe(settingsAccountOperationSignals[0]);
    if (!packedRuntime.settingsActions || !packedDeclaration.settings?.actions) {
      throw new Error('packed_voice_settings_action_missing');
    }
    const boundSettingsActions = bindVoiceProviderSettingsActions({
      actions: packedRuntime.settingsActions,
      declaredActions: packedDeclaration.settings.actions,
      createCredentials: createSettingsCredentials,
      createInteractions: () => Object.freeze({
        askQuestions: async () => {
          throw new Error('unexpected_packed_voice_settings_question');
        },
      }),
      getRealtimeClientToolDefinitions: () => [],
      isCurrent: () => settingsGenerationCurrent,
    });
    await expect(boundSettingsActions.execute({
      actionId: 'provision-voice',
      settings: packedProviderSettings.defaultConfig,
      signal: new AbortController().signal,
    })).resolves.toEqual({ patch: { profile: 'expressive' } });
    settingsGenerationCurrent = false;
    await expect(boundSettingsOperations.listCatalog?.({
      catalog: 'voices',
      providerConfig: packedProviderSettings.defaultConfig,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_account_operation_cancelled' });
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
    expect(lifecycleEvents).toContain('disconnected');
  });

  it('fails closed when a provider leaf returns a malformed connection', async () => {
    const lifecycleEvents: string[] = [];
    const runtime = createExternalVoiceProviderRuntimeContribution({
      host: createHostFixture({ transcriptEvents: [], lifecycleEvents }),
      platform: 'web',
      providerId,
      declaration,
      runtime: {
        kind: 'conversation',
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
        microphoneMode: 'provider_managed',
      },
    });

    await expect(runtime.adapter.start({ sessionId: 'malformed-connection' }))
      .rejects.toMatchObject({ code: 'invalid_external_voice_provider_connection' });
    expect(lifecycleEvents).toContain('error');
    expect(lifecycleEvents).not.toContain('connected');
    await runtime.dispose();
  });
});
