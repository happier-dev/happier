import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecipientContractDigestV1,
  type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import type { VoiceAccountOperationService } from '@happier-dev/plugin-sdk/voice';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
  createSessionFixture,
  installVoiceWebRtcBrowserBoundary,
  renderScreen,
  TestVoiceWebRtcPeer,
} from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import {
  CurrentUiContextProvider,
  type CurrentUiContextReader,
  useOptionalCurrentUiContextReader,
  usePublishCurrentUiContext,
} from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
  createPluginSurfaceDestinationNavigationBinding,
  PluginSurfaceDestinationNavigationBindingProvider,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { encodeBase64 } from '@/encryption/base64';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { Encryption } from '@/sync/encryption/encryption';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import type {
  ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sync } from '@/sync/sync';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { handleDeleteSessionSocketUpdate } from '@/sync/engine/sessions/syncSessions';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { saveAndUseAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import {
  buildVoiceTranscriptHistorySessionMetadata,
  runVoiceTranscriptHistoryCarrierOperation,
} from '@/voice/persistence/voiceTranscriptHistorySession';
import {
  VOICE_WEBRTC_LIMITS,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import {
  voiceConversationRuntimeMachine,
} from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import * as realtimeMicSession from '@/voice/runtime/mic/createRealtimeMicSession';
import { createVoiceHistoryConsumer } from '@/voice/history/voiceHistoryConsumer';
import {
  canDeleteVoiceHistorySession,
  createDefaultVoiceHistoryConsumerFromRuntime,
  type DefaultVoiceHistoryRuntime,
} from '@/voice/history/defaultVoiceHistoryConsumer';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import {
  registerVoiceAdapters,
  resetVoiceAdapterRegistryForTests,
} from '@/voice/session/voiceAdapterRegistry';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
import {
  __resetVoiceTurnInterruptions,
} from '@/voice/transcript/voiceTurnInterruption';
import {
  selectVoiceTranscriptEntriesForConversationSession,
} from '@/voice/transcript/voiceTranscriptSelectors';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The composed gate crosses the real AppShell provider. Router, native host,
// and active-window state remain framework/host boundaries; all current-UI,
// adapter, lifecycle, and attempt logic stays real below.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    pathname: '/',
    params: {},
    segments: [],
  }).module;
});

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/utils/runtime/useHostActivelyViewed', () => ({
  readHostActivelyViewed: () => true,
  useHostActivelyViewed: () => true,
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', async () => {
  const { createMainAppTabStateProviderMock } = await import(
    '@/dev/testkit/mocks/mainAppTabState'
  );
  return createMainAppTabStateProviderMock().module;
});

function openAiEntry() {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES
    .find((candidate) => candidate.declaration.id === 'realtime-openai');
  if (!entry) throw new Error('realtime_openai bundled entry missing');
  return entry;
}

const OPENAI_HISTORY_SESSION_ID = 'voice-history-openai-composed';
const OPENAI_SOURCE_CREDENTIAL = 'sk_source_composed';

function buildToken(accountId: string): string {
  const encode = (value: unknown) =>
    encodeBase64(new TextEncoder().encode(JSON.stringify(value)), 'base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub: accountId })}.signature`;
}

function createDeferredVoid(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}> {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function createOpenAiClientAuthProviderResponse(
  value: string,
  expiresAt: number,
) {
  return Object.freeze({
    value,
    expires_at: expiresAt,
    session: Object.freeze({
      type: 'realtime',
      object: 'realtime.session',
      id: 'sess_openai_composed_gate',
      model: 'gpt-realtime',
    }),
  });
}

function installOpenAiSettings(): void {
  const entry = openAiEntry();
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId: entry.pluginId,
    declaration: entry.declaration,
  });
  if (!recipientContract) throw new Error('realtime_openai recipient contract missing');
  const voice = voiceSettingsParse({
    providerId: entry.providerId,
    providers: {
      [entry.providerId]: {
        schemaVersion: 1,
        config: {
          model: { kind: 'pinned', id: 'gpt-realtime' },
          voice: 'marin',
          instructions: '',
          turnDetection: 'server_vad',
          inputTranscriptionModel: '',
        },
      },
    },
  });
  const credentialSettings = saveAndUseAccountVoiceCredential({
    settings: settingsParse({
      ...settingsDefaults,
      voiceSettingsV1: voice,
    }),
    contribution: {
      pluginId: entry.pluginId,
      localId: entry.declaration.id,
    },
    credentialSlotId: recipientContract.credentialSlot.id,
    expectedSettingsVersion: 1,
    currentDeclaration: entry.declaration,
    value: OPENAI_SOURCE_CREDENTIAL,
    generateId: () => 'realtime-openai-composed-secret',
    now: 1,
    expectedSecretId: null,
    expectedSecretUpdatedAt: null,
    approvedRecipientContractDigest:
      createRecipientContractDigestV1(recipientContract),
  }).settings;
  storage.setState((current) => ({
    ...current,
    settings: {
      ...credentialSettings,
      voiceSettingsV1: {
        ...credentialSettings.voiceSettingsV1,
        providerId: voice.providerId,
        providers: voice.providers,
      },
      voice: {
        ...voice,
        credentialBindings: credentialSettings.voice.credentialBindings,
      },
    },
    sessions: {
      [OPENAI_HISTORY_SESSION_ID]: createSessionFixture({
        id: OPENAI_HISTORY_SESSION_ID,
        active: false,
        encryptionMode: 'plain',
        metadata: {
          path: '/voice-transcript-history',
          host: 'happier.test',
          ...buildVoiceTranscriptHistorySessionMetadata(),
        },
      }),
    },
    sessionMessages: {},
  }) as never);
}

function installOpenAiConnectedAccountSettings(): void {
  const voice = voiceSettingsParse({
    providerId: 'happier.voice.openai/realtime-openai',
    credentialBindings: [{
      contribution: {
        pluginId: 'happier.voice.openai',
        localId: 'realtime-openai',
      },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'connectedAccount' },
      credentialBindings: {},
    }],
    providers: {
      'happier.voice.openai/realtime-openai': {
        schemaVersion: 1,
        config: {
          model: { kind: 'pinned', id: 'gpt-realtime' },
          voice: 'marin',
          instructions: '',
          turnDetection: 'server_vad',
          inputTranscriptionModel: '',
        },
      },
    },
  });
  const settings = settingsParse({
    ...settingsDefaults,
    voiceSettingsV1: voice,
  });
  storage.setState((current) => ({
    ...current,
    settings: {
      ...settings,
      voice,
    },
    sessions: {
      [OPENAI_HISTORY_SESSION_ID]: createSessionFixture({
        id: OPENAI_HISTORY_SESSION_ID,
        active: false,
        encryptionMode: 'plain',
        metadata: {
          path: '/voice-transcript-history',
          host: 'happier.test',
          ...buildVoiceTranscriptHistorySessionMetadata(),
        },
      }),
    },
    sessionMessages: {},
  }) as never);
}

function installOpenAiFetchBoundary(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/realtime/client_secrets')) {
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Bearer ${OPENAI_SOURCE_CREDENTIAL}`);
      return new Response(JSON.stringify(createOpenAiClientAuthProviderResponse(
        'ek_source_composed',
        Math.floor(Date.now() / 1_000) + 60,
      )), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/realtime/calls')) {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer ek_source_composed',
      });
      return new Response('v=0\r\na=openai-answer\r\n', { status: 201 });
    }
    throw new Error(`unexpected OpenAI fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const COMPOSED_CURRENT_UI_DESTINATION = Object.freeze({
  pluginId: 'happier.current-ui-composed-gate',
  localId: 'account-bound-destination',
});

const composedCurrentUiDestinationBinding = normalizePluginUiDestinationBindingV1({
  pluginId: COMPOSED_CURRENT_UI_DESTINATION.pluginId,
  destinationId: COMPOSED_CURRENT_UI_DESTINATION.localId,
  rendererId: 'account-bound-renderer',
  container: 'appPage',
  target: { kind: 'app' },
});

if (!composedCurrentUiDestinationBinding) {
  throw new Error('Expected a normalized Account-retirement current-UI destination fixture.');
}

const composedCurrentUiPlacement = Object.freeze({
  id: 'surfacePlacement:happier.current-ui-composed-gate:account-bound-destination',
  pluginId: COMPOSED_CURRENT_UI_DESTINATION.pluginId,
  contributionKind: 'surfacePlacement',
  descriptorId: COMPOSED_CURRENT_UI_DESTINATION.localId,
  binding: composedCurrentUiDestinationBinding,
  target: composedCurrentUiDestinationBinding.target,
  renderer: { kind: 'reactNative', contributionId: 'account-bound-renderer' },
  display: { developerFallback: 'Account-bound destination' },
  availability: { state: 'available', reason: 'available', diagnostics: [] },
  headerActions: [],
  hostOrigin: {
    machineId: 'current-ui-composed-machine',
    serverId: 'current-ui-composed-server',
    generation: 1,
    phase: 'current',
    interactionEnabled: true,
    executionOrigin: {
      serverIdentityId: 'srv_current-ui-composed-server-identity',
      materializationRef: {
        pluginId: COMPOSED_CURRENT_UI_DESTINATION.pluginId,
        machineId: 'current-ui-composed-machine',
        materializationId: 'current-ui-composed-materialization',
      },
    } satisfies PluginMachineExecutionOriginV1,
  },
} satisfies PluginUiSurfacePlacementProjection);

function CurrentUiContextPublication(props: Readonly<{
  label: string;
  onReader: (reader: CurrentUiContextReader | null) => void;
}>): null {
  const enrichment = React.useMemo(() => Object.freeze({
    entity: Object.freeze({
      kind: 'issue',
      label: props.label,
      reference: Object.freeze({ number: props.label === 'Account A' ? 1 : 2 }),
    }),
    commands: Object.freeze([Object.freeze({
      title: `Open ${props.label}`,
      command: Object.freeze({
        kind: 'openSurface' as const,
        destination: COMPOSED_CURRENT_UI_DESTINATION,
      }),
    })]),
  }), [props.label]);
  usePublishCurrentUiContext(enrichment);
  const reader = useOptionalCurrentUiContextReader();
  React.useLayoutEffect(() => {
    props.onReader(reader);
  }, [props.onReader, reader]);
  return null;
}

function renderAccountRetirementVoiceComposition(input: Readonly<{
  label: string;
  navigationBinding: ReturnType<typeof createPluginSurfaceDestinationNavigationBinding>;
  onReader: (reader: CurrentUiContextReader | null) => void;
}>): React.ReactElement {
  return React.createElement(
    AppPaneProvider,
    null,
    React.createElement(
      CurrentUiContextProvider,
      null,
      React.createElement(
        PluginSurfaceDestinationNavigationBindingProvider,
        { binding: input.navigationBinding },
        React.createElement(
          PluginSurfaceFocusEligibilityProvider,
          {
            active: true,
            currentUiContextActive: true,
            children: React.createElement(
              React.Fragment,
              null,
              React.createElement(CurrentUiContextPublication, {
                label: input.label,
                onReader: input.onReader,
              }),
              React.createElement(VoiceSessionRuntime),
            ),
          },
        ),
      ),
    ),
  );
}

function readOpenAiFunctionCallOutputIds(sent: readonly string[]): readonly string[] {
  return sent.flatMap((serialized) => {
    const event = JSON.parse(serialized) as Readonly<{
      type?: unknown;
      item?: Readonly<{ type?: unknown; call_id?: unknown }>;
    }>;
    return event.type === 'conversation.item.create'
      && event.item?.type === 'function_call_output'
      && typeof event.item.call_id === 'string'
      ? [event.item.call_id]
      : [];
  });
}

function sendOpenAiCurrentUiToolCalls(input: Readonly<{
  channel: TestVoiceWebRtcPeer['channel'];
  responseId: string;
  commandId: string;
}>): void {
  input.channel.message(JSON.stringify({
    type: 'response.done',
    event_id: `${input.responseId}:done`,
    response: {
      id: input.responseId,
      object: 'realtime.response',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: `${input.responseId}:read`,
          name: 'readCurrentUiContext',
          arguments: '{}',
        },
        {
          type: 'function_call',
          call_id: `${input.responseId}:invoke`,
          name: 'invokeCurrentUiCommand',
          arguments: JSON.stringify({ commandId: input.commandId }),
        },
      ],
    },
  }));
}

function setBufferedAmount(
  channel: EventTarget,
  bufferedAmount: number,
): void {
  Object.defineProperties(channel, {
    bufferedAmount: {
      configurable: true,
      writable: true,
      value: bufferedAmount,
    },
    bufferedAmountLowThreshold: {
      configurable: true,
      writable: true,
      value: 0,
    },
  });
}

function openAiSessionUpdates(sent: readonly string[]): readonly unknown[] {
  return sent
    .map((value) => JSON.parse(value) as unknown)
    .filter((value) => (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as Readonly<{ type?: unknown }>).type === 'session.update'
    ));
}

function createSourceComposedOpenAiRuntime(
  browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>,
  options?: Readonly<{
    createInvocationAccountOperations?(
      signal: AbortSignal,
      isCurrent: () => boolean,
    ): VoiceAccountOperationService;
    beforeAcquireDirectMediaConversation?(): Promise<void>;
    readPlaybackCursorMs?(): number | null;
    initialConversationSessionId?: string;
  }>,
) {
  const hostLease = createBundledConversationRuntimeHostLease();
  const controlSessionId = hostLease.host.globalVoiceSessionId;
  const readPlaybackCursorMs = options?.readPlaybackCursorMs;
  let requestReconnect: (() => Promise<boolean>) | null = null;
  const baseHost = Object.freeze({
    ...hostLease.host,
    getPlatform: () => 'web' as const,
    createMicSession: () => browser.micSession,
    createConversationController: (
      input: Parameters<typeof hostLease.host.createConversationController>[0],
    ) => {
      const controller = hostLease.host.createConversationController(input);
      requestReconnect = () => controller.requestReconnect();
      return controller;
    },
    acquireDirectMediaConversation: async (
      input: Parameters<typeof hostLease.host.acquireDirectMediaConversation>[0],
    ) => {
      await options?.beforeAcquireDirectMediaConversation?.();
      return await hostLease.host.acquireDirectMediaConversation(input);
    },
    acquireAudioMode: async () => Object.freeze({
      release: async () => undefined,
    }),
  });
  const host = Object.freeze({
    ...baseHost,
    ...(readPlaybackCursorMs
      ? {
          createWebRtcConnection: (
            input: Parameters<typeof baseHost.createWebRtcConnection>[0],
          ) => {
            const connection = baseHost.createWebRtcConnection(input);
            return Object.freeze({
              ...connection,
              playbackCursorMs: readPlaybackCursorMs,
            });
          },
        }
      : {}),
  });
  const entry = openAiEntry();
  const providerId = entry.providerId;
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId: entry.pluginId,
    declaration: entry.declaration,
  });
  if (!recipientContract) throw new Error('realtime_openai recipient contract missing');
  const initialConversationSessionId = options?.initialConversationSessionId
    ?? OPENAI_HISTORY_SESSION_ID;
  voiceSessionBindingStore.getState().bind({
    adapterId: providerId,
    controlSessionId,
    conversationSessionId: initialConversationSessionId,
    lifetime: 'runtime_attempt',
    transcriptMode: 'synthetic',
    targetSessionId: null,
    updatedAt: 1,
  });
  const requestAccountOperation = vi.fn();
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: entry.pluginId,
    declarations: [entry.declaration],
    hostPlatform: 'web',
    runtimeHost: host,
    isRuntimeHostCurrent: () =>
      getCurrentBundledConversationRuntimeHost() === hostLease.host,
    hostBindingsByLocalId: Object.freeze({
      [entry.declaration.id]: Object.freeze({
        recipientContract,
        createInvocationAccountOperations: (
          signal: AbortSignal,
          _conversationSessionId: string | null,
          isCurrent: () => boolean,
        ) => {
          if (options?.createInvocationAccountOperations) {
            const accountOperations = options.createInvocationAccountOperations(
              signal,
              isCurrent,
            );
            requestAccountOperation.mockImplementation(accountOperations.request);
            return Object.freeze({ request: requestAccountOperation });
          }
          const accountOperations = createAccountVoiceOperationService({
            providerId,
            contribution: {
              pluginId: entry.pluginId,
              localId: entry.declaration.id,
            },
            recipientContract,
            signal,
            isCurrent,
          });
          requestAccountOperation.mockImplementation(accountOperations.request);
          return Object.freeze({ request: requestAccountOperation });
        },
        descriptor: 'bundled' as const,
      }),
    }),
  });
  entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
  const commit = scope.commit();
  if (commit) void commit.catch(() => undefined);
  const registration = getExternalVoiceProviderRegistration(
    providerId,
  );
  if (!registration?.adapter) {
    throw new Error('realtime_openai bundled activation failed');
  }
  const runtime = Object.freeze({
    adapter: registration.adapter,
    async dispose() {
      await scope.unwind();
    },
  });
  registerVoiceAdapters([runtime.adapter]);
  return Object.freeze({
    controlSessionId,
    hostLease,
    requestAccountOperation,
    async requestReconnect() {
      const request = requestReconnect;
      if (!request) throw new Error('voice conversation controller unavailable');
      return await request();
    },
    runtime,
  });
}

/**
 * The event ladder a live OpenAI Realtime WebRTC session emits over
 * `oai-events` for two complete spoken turns, including the opening
 * `session.created` boundary, per-item interim deltas, and `response.done`.
 */
function buildLiveShapedOpenAiTurnEvents(): readonly Readonly<Record<string, unknown>>[] {
  const turns = [
    Object.freeze({
      index: 1,
      userText: 'Please reply out loud with exactly these words: History Canary Delta 92.',
      assistantText: 'History canary delta 9 2',
    }),
    Object.freeze({
      index: 2,
      userText: 'Say it one more time.',
      assistantText: 'History canary delta 9 2 again',
    }),
  ] as const;
  const events: Readonly<Record<string, unknown>>[] = [
    {
      type: 'session.created',
      event_id: 'event_live_session_created',
      session: {
        id: 'sess_live_shaped',
        type: 'realtime',
        object: 'realtime.session',
        model: 'gpt-realtime',
      },
    },
    {
      type: 'session.updated',
      event_id: 'event_live_session_updated',
      session: { id: 'sess_live_shaped', type: 'realtime' },
    },
  ];
  for (const turn of turns) {
    const userItem = `item_live_user_${turn.index}`;
    const assistantItem = `item_live_assistant_${turn.index}`;
    const responseId = `resp_live_${turn.index}`;
    const prefix = `event_live_${turn.index}`;
    const userHead = turn.userText.slice(0, 8);
    const assistantHead = turn.assistantText.slice(0, 8);
    events.push(
      { type: 'input_audio_buffer.speech_started', event_id: `${prefix}_speech_started`, audio_start_ms: 120, item_id: userItem },
      { type: 'input_audio_buffer.speech_stopped', event_id: `${prefix}_speech_stopped`, audio_end_ms: 2_480, item_id: userItem },
      { type: 'input_audio_buffer.committed', event_id: `${prefix}_committed`, item_id: userItem, previous_item_id: null },
      {
        type: 'conversation.item.created',
        event_id: `${prefix}_user_item_created`,
        previous_item_id: null,
        item: { id: userItem, object: 'realtime.item', type: 'message', status: 'completed', role: 'user', content: [{ type: 'input_audio', transcript: null }] },
      },
      { type: 'conversation.item.input_audio_transcription.delta', event_id: `${prefix}_user_delta_1`, item_id: userItem, content_index: 0, delta: userHead },
      { type: 'conversation.item.input_audio_transcription.delta', event_id: `${prefix}_user_delta_2`, item_id: userItem, content_index: 0, delta: turn.userText.slice(8) },
      {
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: `${prefix}_user_final`,
        item_id: userItem,
        content_index: 0,
        transcript: turn.userText,
        usage: { type: 'tokens', total_tokens: 41, input_tokens: 39, output_tokens: 2, input_token_details: { text_tokens: 9, audio_tokens: 30 } },
      },
      { type: 'response.created', event_id: `${prefix}_response_created`, response: { id: responseId, object: 'realtime.response', status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        event_id: `${prefix}_output_item_added`,
        response_id: responseId,
        output_index: 0,
        item: { id: assistantItem, object: 'realtime.item', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      },
      { type: 'response.content_part.added', event_id: `${prefix}_content_part_added`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0, part: { type: 'audio', transcript: '' } },
      { type: 'response.output_audio_transcript.delta', event_id: `${prefix}_assistant_delta_1`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0, delta: assistantHead },
      { type: 'response.output_audio.delta', event_id: `${prefix}_audio_delta_1`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0, delta: 'AAAA' },
      { type: 'response.output_audio_transcript.delta', event_id: `${prefix}_assistant_delta_2`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0, delta: turn.assistantText.slice(8) },
      { type: 'response.output_audio.done', event_id: `${prefix}_audio_done`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0 },
      {
        type: 'response.output_audio_transcript.done',
        event_id: `${prefix}_assistant_final`,
        response_id: responseId,
        item_id: assistantItem,
        output_index: 0,
        content_index: 0,
        transcript: turn.assistantText,
      },
      { type: 'response.content_part.done', event_id: `${prefix}_content_part_done`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0, part: { type: 'audio', transcript: turn.assistantText } },
      {
        type: 'response.output_item.done',
        event_id: `${prefix}_output_item_done`,
        response_id: responseId,
        output_index: 0,
        item: { id: assistantItem, object: 'realtime.item', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'audio', transcript: turn.assistantText }] },
      },
      {
        type: 'response.done',
        event_id: `${prefix}_response_done`,
        response: {
          id: responseId,
          object: 'realtime.response',
          status: 'completed',
          output: [{ id: assistantItem, object: 'realtime.item', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'audio', transcript: turn.assistantText }] }],
          usage: { total_tokens: 120, input_tokens: 80, output_tokens: 40 },
        },
      },
    );
  }
  return Object.freeze(events);
}

function removeOpenAiSavedSecretApproval(input: Readonly<{
  removeSecret: boolean;
}>): void {
  storage.setState((current) => ({
    ...current,
    settings: {
      ...current.settings,
      secrets: input.removeSecret ? [] : current.settings.secrets,
      voiceSettingsV1: {
        ...current.settings.voiceSettingsV1,
        credentialBindings: current.settings.voiceSettingsV1.credentialBindings.map(
          (binding) => binding.contribution.pluginId === 'happier.voice.openai'
            && binding.contribution.localId === 'realtime-openai'
            ? Object.freeze({
                contribution: binding.contribution,
                credentialSlotId: binding.credentialSlotId,
                credentialSource: binding.credentialSource,
                credentialBindings: binding.credentialBindings,
              })
            : binding,
        ),
      },
    },
  }) as never);
}

describe('realtime_openai source-composed WebRTC gate', () => {
  const originalSyncEncryption = sync.encryption;
  const originalSyncCredentials = Reflect.get(sync, 'credentials');
  let transcriptRequest: ReturnType<typeof vi.fn>;

  beforeEach(async (context) => {
    await resetServerReachabilitySupervisors();
    const server = upsertServerProfile({
      serverUrl: 'https://openai-composed.example.test',
      name: 'OpenAI composed test',
    });
    setActiveServerId(server.id, { scope: 'device' });
    storage.getState().activateProfileScope({
      serverId: server.id,
      accountId: 'openai-composed-account',
    });
    const secretBytes = new Uint8Array(32).fill(8);
    const credentials: AuthCredentials = {
      token: buildToken('openai-composed-account'),
      secret: encodeBase64(secretBytes, 'base64url'),
    };
    Reflect.set(sync, 'credentials', credentials);
    sync.encryption = await Encryption.create(secretBytes);
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    __resetVoiceTurnInterruptions();
    voiceConversationRuntimeMachine.reset();
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getInitialState(),
      bind: voiceSessionBindingStore.getState().bind,
      unbind: voiceSessionBindingStore.getState().unbind,
      replacePersistedBindings: voiceSessionBindingStore.getState().replacePersistedBindings,
      getByConversationSessionId: voiceSessionBindingStore.getState().getByConversationSessionId,
      getByControlSessionId: voiceSessionBindingStore.getState().getByControlSessionId,
      list: voiceSessionBindingStore.getState().list,
    }, true);
    if (
      context.task.name.startsWith('keeps the exact minted OpenAI authority')
      || context.task.name.startsWith('fails typed before OpenAI signaling')
    ) {
      installOpenAiConnectedAccountSettings();
    } else {
      installOpenAiSettings();
    }
    installOpenAiFetchBoundary();
    let nextTranscriptSeq = 0;
    vi.spyOn(apiSocket, 'request').mockRejectedValue(
      new Error('dynamic active request must not own transcript persistence'),
    );
    transcriptRequest = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(url).toBe(
        `https://openai-composed.example.test/v2/sessions/${OPENAI_HISTORY_SESSION_ID}/messages`,
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{
        localId: string;
      }>;
      nextTranscriptSeq += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-message-${nextTranscriptSeq}`,
          seq: nextTranscriptSeq,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    setRuntimeFetch(transcriptRequest);
  });

  afterEach(async () => {
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    sync.encryption = originalSyncEncryption;
    Reflect.set(sync, 'credentials', originalSyncCredentials);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    __resetVoiceTurnInterruptions();
    voiceConversationRuntimeMachine.reset();
  });

  it('fences an Account-retired real OpenAI attempt before retained current-UI read or command tool calls can reach A or B', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const openSurface = vi.fn(async () => ({ ok: true as const }));
    const navigationBinding = createPluginSurfaceDestinationNavigationBinding({
      placements: [composedCurrentUiPlacement],
      targetKind: 'app',
      runtimeAdmission: { platform: 'web', formFactor: 'tablet' },
    });
    const unregisterNavigationOwner = navigationBinding.registerOwner({
      container: 'appPage',
      handler: openSurface,
    });
    const readerRef: { current: CurrentUiContextReader | null } = { current: null };
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

    try {
      screen = await renderScreen(renderAccountRetirementVoiceComposition({
        label: 'Account A',
        navigationBinding,
        onReader: (next) => { readerRef.current = next; },
      }));
      await vi.waitFor(() => expect(readerRef.current?.readCurrentUiContext()?.entity?.label).toBe('Account A'));
      const commandA = readerRef.current?.readCurrentUiContext()?.commands[0]?.id ?? '';
      expect(commandA).toMatch(/^current-ui-command:/);

      await vi.waitFor(() => expect(
        getExternalVoiceProviderRegistration(openAiEntry().providerId)?.adapter,
      ).not.toBeNull());
      const configuredVoice = voiceSettingsParse(storage.getState().settings.voiceSettingsV1);
      expect(configuredVoice.providerId).toBe(openAiEntry().providerId);
      await vi.waitFor(() => expect(
        getVoiceSessionLifecycleController()?.getConfiguredProviderId(),
      ).toBe(openAiEntry().providerId));
      voiceSessionBindingStore.getState().bind({
        adapterId: openAiEntry().providerId,
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: OPENAI_HISTORY_SESSION_ID,
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionId: null,
        updatedAt: 1,
      });
      const controller = getVoiceSessionLifecycleController();
      if (!controller) throw new Error('Expected the real Voice lifecycle controller.');
      const starting = controller.toggle(VOICE_AGENT_GLOBAL_SESSION_ID);
      await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      // The real assembly advertised both tools. This prevents the test from
      // passing merely because a mock or privacy branch never bound them.
      expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          session: expect.objectContaining({
            tools: expect.arrayContaining([
              expect.objectContaining({ name: 'readCurrentUiContext' }),
              expect.objectContaining({ name: 'invokeCurrentUiCommand' }),
            ]),
          }),
        }),
      ]));

      // Establish the live side of the contract through the same incoming
      // provider transport before retiring its Account. Tool advertisement
      // alone would also pass if the real handlers were inert.
      sendOpenAiCurrentUiToolCalls({
        channel: browser.peer.channel,
        responseId: 'active-account-a',
        commandId: commandA,
      });
      await vi.waitFor(() => {
        expect(readOpenAiFunctionCallOutputIds(browser.peer.channel.sent)).toEqual(
          expect.arrayContaining(['active-account-a:read', 'active-account-a:invoke']),
        );
      });
      await vi.waitFor(() => expect(openSurface).toHaveBeenCalledTimes(1));
      const functionCallOutputIdsBeforeRetirement = readOpenAiFunctionCallOutputIds(
        browser.peer.channel.sent,
      );
      openSurface.mockClear();

      // This is the deciding synchronous window: do not rerender or yield
      // before the old attempt receives real provider tool calls.
      retireActiveServerAccountScopeLifetime();
      sendOpenAiCurrentUiToolCalls({
        channel: browser.peer.channel,
        responseId: 'retired-account-a',
        commandId: commandA,
      });

      await act(async () => {
        await Promise.resolve();
      });
      expect(readOpenAiFunctionCallOutputIds(browser.peer.channel.sent))
        .toEqual(functionCallOutputIdsBeforeRetirement);
      expect(openSurface).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot().status).toBe('disconnected');
      });

      const serverB = upsertServerProfile({
        serverUrl: 'https://openai-composed-account-b.example.test',
        name: 'OpenAI composed Account B',
      });
      setActiveServerId(serverB.id, { scope: 'device' });
      storage.getState().activateProfileScope({
        serverId: serverB.id,
        accountId: 'openai-composed-account-b',
      });
      await screen.update(renderAccountRetirementVoiceComposition({
        label: 'Account B',
        navigationBinding,
        onReader: (next) => { readerRef.current = next; },
      }));
      await vi.waitFor(() => expect(readerRef.current?.readCurrentUiContext()?.entity?.label).toBe('Account B'));
      const commandB = readerRef.current?.readCurrentUiContext()?.commands[0]?.id ?? '';
      expect(commandB).toMatch(/^current-ui-command:/);

      // The same real provider transport still has the late attempt event,
      // but no former handler can follow the stable port into Account B.
      sendOpenAiCurrentUiToolCalls({
        channel: browser.peer.channel,
        responseId: 'retired-account-b',
        commandId: commandB,
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(readOpenAiFunctionCallOutputIds(browser.peer.channel.sent))
        .toEqual(functionCallOutputIdsBeforeRetirement);
      expect(openSurface).not.toHaveBeenCalled();
    } finally {
      unregisterNavigationOwner();
      if (screen) await screen.unmount();
      retireActiveServerAccountScopeLifetime();
      await vi.waitFor(() => expect(getVoiceSessionLifecycleController()).toBeNull());
      browser.restore();
    }
  });

  it('rehydrates an existing history carrier before reusing it for a new runtime attempt', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [OPENAI_HISTORY_SESSION_ID]: {
          ...current.sessions[OPENAI_HISTORY_SESSION_ID],
          encryptionMode: 'e2ee',
        },
      },
    }) as never);
    const hydrate = vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute')
      .mockResolvedValue({
        kind: 'available',
        sessionId: OPENAI_HISTORY_SESSION_ID,
      });

    try {
      await expect(composed.hostLease.host.acquireDirectMediaConversation({
        adapterId: 'happier.voice.openai/realtime-openai',
        controlSessionId: composed.controlSessionId,
        requestedTargetSessionId: null,
      })).resolves.toEqual({
        conversationSessionId: OPENAI_HISTORY_SESSION_ID,
      });
      expect(hydrate).toHaveBeenCalledWith(
        OPENAI_HISTORY_SESSION_ID,
        { forceRefresh: true },
      );
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('runs approved SavedSecret through public activation and reuses the canonical no-daemon history carrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      expect(composed.requestAccountOperation).toHaveBeenCalledTimes(1);
      expect(Object.keys(storage.getState().sessions)).toEqual([
        OPENAI_HISTORY_SESSION_ID,
      ]);
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).toMatchObject({
        adapterId: 'happier.voice.openai/realtime-openai',
        controlSessionId: composed.controlSessionId,
        lifetime: 'runtime_attempt',
        targetSessionId: null,
        transcriptMode: 'synthetic',
      });
      expect(binding?.conversationSessionId).toBe(OPENAI_HISTORY_SESSION_ID);
      expect(storage.getState().sessions[binding!.conversationSessionId]).toMatchObject({
        id: OPENAI_HISTORY_SESSION_ID,
        active: false,
      });
      await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
        openConversationSessionId: binding!.conversationSessionId,
        fallbackControlSessionId: composed.controlSessionId,
        activeAdapterId: 'happier.voice.openai/realtime-openai',
        providerId: 'happier.voice.openai/realtime-openai',
        requestedTargetSessionId: null,
      })).resolves.toEqual({ conversationSessionId: null });

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-user-final',
        item_id: 'saved-secret-user',
        content_index: 0,
        transcript: 'hello without a daemon',
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'hello without a daemon',
        }),
      ]));

      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      });

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(readCanonicalVoiceTranscriptSnapshot(
        binding!.conversationSessionId,
      )).toEqual([]);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID])
        .toBeDefined();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it.each([
    ['missing', true],
    ['review-required', false],
  ] as const)(
    'declines a %s SavedSecret before microphone or WebRTC admission',
    async (_readiness, removeSecret) => {
      removeOpenAiSavedSecretApproval({ removeSecret });
      const browser = installVoiceWebRtcBrowserBoundary();
      const composed = createSourceComposedOpenAiRuntime(browser);
      const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
      const getUserMedia = vi.mocked(
        globalThis.navigator.mediaDevices.getUserMedia,
      );
      const providerFetch = vi.mocked(globalThis.fetch);

      try {
        await composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        });

        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          status: 'error',
          errorCode: 'provider_auth_invalid',
        });
        expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(peerConstructor).not.toHaveBeenCalled();
        expect(browser.peer.createDataChannel).not.toHaveBeenCalled();
        expect(providerFetch).not.toHaveBeenCalled();
        expect(composed.requestAccountOperation).toHaveBeenCalledOnce();
      } finally {
        await composed.runtime.dispose();
        composed.hostLease.revoke();
        browser.restore();
      }
    },
  );

  it('declines a selected Connected Account without an eligible binding before microphone or WebRTC admission', async () => {
    installOpenAiConnectedAccountSettings();
    const request = vi.fn(async () => {
      throw Object.assign(new Error('credential_unavailable'), {
        code: 'credential_unavailable',
      });
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser, {
      createInvocationAccountOperations: () => Object.freeze({ request }),
    });
    const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
    const getUserMedia = vi.mocked(
      globalThis.navigator.mediaDevices.getUserMedia,
    );
    const providerFetch = vi.mocked(globalThis.fetch);

    try {
      await composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });

      expect(request).toHaveBeenCalledOnce();
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'provider_auth_invalid',
      });
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(peerConstructor).not.toHaveBeenCalled();
      expect(browser.peer.createDataChannel).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
      expect(composed.requestAccountOperation).toHaveBeenCalledOnce();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it.each([
    ['switches', 'account-b' as string | null],
    ['deletes', null],
  ] as const)(
    'fences an OpenAI Connected Account attempt that %s before client-auth issuance',
    async (_change, invalidatedBinding) => {
      installOpenAiConnectedAccountSettings();
      let binding: string | null = 'account-a';
      const authorityInvalidation = createDeferredVoid();
      const watchReady = createDeferredVoid();
      const materialize = vi.fn();
      const providerFetch = vi.fn();
      const request = vi.fn(async () => {
        const admittedBinding = binding;
        if (!admittedBinding) {
          throw Object.assign(new Error('credential_unavailable'), {
            code: 'credential_unavailable',
          });
        }
        if (admittedBinding === 'account-b') {
          materialize();
          providerFetch();
          return Object.freeze({
            status: 200,
            finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
            headers: Object.freeze({}),
            body: new TextEncoder().encode(JSON.stringify(
              createOpenAiClientAuthProviderResponse(
                'ek_source_composed',
                Math.floor(Date.now() / 1_000) + 60,
              ),
            )),
          });
        }
        watchReady.resolve();
        await authorityInvalidation.promise;
        throw new Error('unreachable_connected_account_authority');
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const composed = createSourceComposedOpenAiRuntime(browser, {
        createInvocationAccountOperations: () => Object.freeze({ request }),
      });
      const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
      const getUserMedia = vi.mocked(
        globalThis.navigator.mediaDevices.getUserMedia,
      );

      try {
        const firstStart = composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        });
        await watchReady.promise;
        binding = invalidatedBinding;
        authorityInvalidation.reject(Object.assign(
          new Error('credential_unavailable'),
          { code: 'credential_unavailable' },
        ));
        await firstStart;

        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          status: 'error',
          errorCode: 'provider_auth_invalid',
        });
        expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(peerConstructor).not.toHaveBeenCalled();
        expect(browser.peer.createDataChannel).not.toHaveBeenCalled();
        expect(materialize).not.toHaveBeenCalled();
        expect(providerFetch).not.toHaveBeenCalled();
        expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual([]);

        binding = 'account-b';
        const secondStart = composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        });
        await vi.waitFor(() => expect(
          browser.peer.createDataChannel,
        ).toHaveBeenCalledWith('oai-events'));
        expect(materialize).toHaveBeenCalledTimes(1);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual([]);
        browser.peer.channel.open();
        await secondStart;

        expect(openAiSessionUpdates(browser.peer.channel.sent)).toHaveLength(1);
      } finally {
        await composed.runtime.dispose();
        composed.hostLease.revoke();
        browser.restore();
      }
    },
  );

  it.each([
    ['switches', 'account-b' as string | null],
    ['deletes', null],
  ] as const)(
    'admits the minted OpenAI authority when its Connected Account %s before media and applies the change to the next attempt',
    async (_change, nextBinding) => {
      installOpenAiConnectedAccountSettings();
      let binding: string | null = 'account-a';
      const firstResourcePreparationEntered = createDeferredVoid();
      const releaseFirstResourcePreparation = createDeferredVoid();
      const secondResourcePreparationEntered = createDeferredVoid();
      const releaseSecondResourcePreparation = createDeferredVoid();
      let resourcePreparationCount = 0;
      const requestBindings: Array<string | null> = [];
      const materialize = vi.fn();
      const providerFetch = vi.fn();
      const request = vi.fn(async () => {
        const admittedBinding = binding;
        requestBindings.push(admittedBinding);
        if (!admittedBinding) {
          throw Object.assign(new Error('credential_unavailable'), {
            code: 'credential_unavailable',
          });
        }
        materialize(admittedBinding);
        providerFetch(admittedBinding);
        return Object.freeze({
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify(
            createOpenAiClientAuthProviderResponse(
              'ek_source_composed',
              Math.floor(Date.now() / 1_000) + 60,
            ),
          )),
        });
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const composed = createSourceComposedOpenAiRuntime(browser, {
        createInvocationAccountOperations: () => Object.freeze({ request }),
        async beforeAcquireDirectMediaConversation() {
          resourcePreparationCount += 1;
          if (resourcePreparationCount === 1) {
            firstResourcePreparationEntered.resolve();
            await releaseFirstResourcePreparation.promise;
            return;
          }
          secondResourcePreparationEntered.resolve();
          await releaseSecondResourcePreparation.promise;
        },
      });
      const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
      const getUserMedia = vi.mocked(
        globalThis.navigator.mediaDevices.getUserMedia,
      );

      try {
        const firstStart = composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        });
        await firstResourcePreparationEntered.promise;
        expect(requestBindings).toEqual(['account-a']);
        expect(materialize).toHaveBeenCalledWith('account-a');
        expect(providerFetch).toHaveBeenCalledWith('account-a');
        expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(peerConstructor).not.toHaveBeenCalled();

        binding = nextBinding;
        releaseFirstResourcePreparation.resolve();
        await vi.waitFor(() => expect(
          browser.peer.createDataChannel,
        ).toHaveBeenCalledWith('oai-events'));
        browser.peer.channel.open();
        await firstStart;

        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          status: 'connected',
        });
        expect(browser.micSession.ensureActive).toHaveBeenCalledTimes(1);
        expect(peerConstructor).toHaveBeenCalledTimes(1);
        expect(openAiSessionUpdates(browser.peer.channel.sent)).toHaveLength(1);

        await composed.runtime.adapter.stop({
          sessionId: composed.controlSessionId,
        });
        const secondStart = composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        });
        if (nextBinding === null) {
          await secondStart;
          expect(requestBindings).toEqual(['account-a', null]);
          expect(materialize).toHaveBeenCalledTimes(1);
          expect(providerFetch).toHaveBeenCalledTimes(1);
          expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
            status: 'error',
            errorCode: 'provider_auth_invalid',
          });
        } else {
          await secondResourcePreparationEntered.promise;
          expect(requestBindings).toEqual(['account-a', 'account-b']);
          expect(materialize).toHaveBeenNthCalledWith(2, 'account-b');
          expect(providerFetch).toHaveBeenNthCalledWith(2, 'account-b');
          const stopping = composed.runtime.adapter.stop({
            sessionId: composed.controlSessionId,
          });
          releaseSecondResourcePreparation.resolve();
          await Promise.all([secondStart, stopping]);
        }

        expect(browser.micSession.ensureActive).toHaveBeenCalledTimes(1);
        expect(peerConstructor).toHaveBeenCalledTimes(1);
      } finally {
        releaseFirstResourcePreparation.resolve();
        releaseSecondResourcePreparation.resolve();
        await composed.runtime.dispose();
        composed.hostLease.revoke();
        browser.restore();
      }
    },
  );

  it.each([
    ['switches', 'account-b' as string | null],
    ['deletes', null],
  ] as const)(
    'keeps the exact minted OpenAI authority when its Connected Account %s during a forced reconnect and applies the change only to the next Start',
    async (_change, nextBinding) => {
      installOpenAiConnectedAccountSettings();
      let binding: string | null = 'account-a';
      const requestBindings: Array<string | null> = [];
      const request = vi.fn(async () => {
        const admittedBinding = binding;
        requestBindings.push(admittedBinding);
        if (!admittedBinding) {
          throw Object.assign(new Error('credential_unavailable'), {
            code: 'credential_unavailable',
          });
        }
        return Object.freeze({
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify(
            createOpenAiClientAuthProviderResponse(
              `ek_${admittedBinding}`,
              Math.floor(Date.now() / 1_000) + 60,
            ),
          )),
        });
      });
      const callAuthorizations: string[] = [];
      vi.mocked(globalThis.fetch).mockImplementation(async (
        input: URL | RequestInfo,
        init?: RequestInit,
      ) => {
        const url = String(input);
        if (!url.endsWith('/v1/realtime/calls')) {
          throw new Error(`unexpected OpenAI fetch: ${url}`);
        }
        callAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response('v=0\r\na=openai-answer\r\n', { status: 201 });
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const reconnectPeer = new TestVoiceWebRtcPeer();
      const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
      peerConstructor
        .mockImplementationOnce(() => browser.peer as unknown as RTCPeerConnection)
        .mockImplementationOnce(() => reconnectPeer as unknown as RTCPeerConnection);
      const composed = createSourceComposedOpenAiRuntime(browser, {
        createInvocationAccountOperations: () => Object.freeze({ request }),
      });

      try {
        const firstStart = composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        });
        await vi.waitFor(() => expect(
          browser.peer.createDataChannel,
        ).toHaveBeenCalledWith('oai-events'));
        browser.peer.channel.open();
        await firstStart;

        expect(requestBindings).toEqual(['account-a']);
        expect(callAuthorizations).toEqual(['Bearer ek_account-a']);
        binding = nextBinding;
        const reconnect = composed.requestReconnect();

        await vi.waitFor(() => expect(
          reconnectPeer.createDataChannel,
        ).toHaveBeenCalledWith('oai-events'));
        expect(requestBindings).toEqual(['account-a']);
        expect(callAuthorizations).toEqual([
          'Bearer ek_account-a',
          'Bearer ek_account-a',
        ]);
        reconnectPeer.channel.open();
        await expect(reconnect).resolves.toBe(true);
        await vi.waitFor(() => expect(
          composed.runtime.adapter.getSnapshot().status,
        ).toBe('connected'));

        await composed.runtime.adapter.stop({
          sessionId: composed.controlSessionId,
        });
        const nextStart = composed.runtime.adapter.start({
          sessionId: '',
          initialContext: '',
        }).then(
          () => null,
          (error: unknown) => error,
        );
        if (nextBinding === null) {
          await expect(nextStart).resolves.toBeNull();
          expect(requestBindings).toEqual(['account-a', null]);
          expect(callAuthorizations).toEqual([
            'Bearer ek_account-a',
            'Bearer ek_account-a',
          ]);
          expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
            status: 'error',
            errorCode: 'provider_auth_invalid',
          });
        } else {
          await vi.waitFor(() => expect(requestBindings).toEqual([
            'account-a',
            'account-b',
          ]));
          expect(requestBindings).toEqual(['account-a', 'account-b']);
          expect(callAuthorizations).toEqual([
            'Bearer ek_account-a',
            'Bearer ek_account-a',
          ]);
          const stopping = composed.runtime.adapter.stop({
            sessionId: composed.controlSessionId,
          });
          await Promise.all([nextStart, stopping]);
        }
      } finally {
        await composed.runtime.dispose();
        composed.hostLease.revoke();
        browser.restore();
      }
    },
  );

  it('fails typed before OpenAI signaling when admitted auth expires during offer creation and requires a new Start', async () => {
    const initialNow = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
    let binding = 'account-a';
    const requestBindings: string[] = [];
    const request = vi.fn(async () => {
      requestBindings.push(binding);
      return Object.freeze({
        status: 200,
        finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
        headers: Object.freeze({}),
        body: new TextEncoder().encode(JSON.stringify(
          createOpenAiClientAuthProviderResponse(
            `ek_${binding}`,
            Math.floor((Date.now() + 60_000) / 1_000),
          ),
        )),
      });
    });
    const callAuthorizations: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (!url.endsWith('/v1/realtime/calls')) {
        throw new Error(`unexpected OpenAI fetch: ${url}`);
      }
      callAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('v=0\r\na=openai-answer\r\n', { status: 201 });
    });
    let resolveOffer!: (offer: { type: 'offer'; sdp: string }) => void;
    const delayedOffer = new Promise<{ type: 'offer'; sdp: string }>((resolve) => {
      resolveOffer = resolve;
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    browser.peer.createOffer.mockImplementationOnce(async () => await delayedOffer);
    vi.mocked(globalThis.RTCPeerConnection)
      .mockImplementationOnce(() => browser.peer as unknown as RTCPeerConnection);
    const composed = createSourceComposedOpenAiRuntime(browser, {
      createInvocationAccountOperations: () => Object.freeze({ request }),
    });

    try {
      const firstStart = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(browser.peer.createOffer).toHaveBeenCalledTimes(1));
      expect(requestBindings).toEqual(['account-a']);
      expect(callAuthorizations).toEqual([]);

      binding = 'account-b';
      nowSpy.mockReturnValue(initialNow + 59_500);
      browser.peer.channel.open();
      resolveOffer({ type: 'offer', sdp: 'v=0\r\na=delayed-offer\r\n' });

      await expect(firstStart).rejects.toMatchObject({ code: 'voice_auth_expired' });
      expect(requestBindings).toEqual(['account-a']);
      expect(callAuthorizations).toEqual([]);
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'voice_auth_expired',
      });

      const nextStart = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(requestBindings).toEqual([
        'account-a',
        'account-b',
      ]));
      expect(requestBindings).toEqual(['account-a', 'account-b']);
      expect(callAuthorizations).toEqual([]);
      const stopping = composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      });
      await Promise.all([nextStart, stopping]);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('persists standalone SavedSecret finals through canonical session-message storage', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).not.toBeNull();

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-durable-user-final',
        item_id: 'saved-secret-durable-user',
        content_index: 0,
        transcript: 'persist me without a daemon',
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'persist me without a daemon',
        }),
      ]));

      await vi.waitFor(() => {
        const state = storage.getState();
        const storedMessages = Object.keys(state.sessionMessages)
          .flatMap((sessionId) => readStoredSessionMessages(state, sessionId));
        expect(storedMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'user-text',
            text: 'persist me without a daemon',
          }),
        ]));
      });
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('persists both finals of a turn whose payloads carry fields the adapter never reads', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).not.toBeNull();

      // Billing, positional and diagnostic fields are provider-owned and never
      // read here. A live turn that omits one, or adds one this pin has never
      // seen, must still reach Voice History with the provider's exact words.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'evolving-user-final',
        item_id: 'evolving-user',
        transcript: 'hello, please reply out loud',
        unreleased_provider_field: { shape: 'unknown' },
      }));
      browser.peer.channel.message(JSON.stringify({
        type: 'response.output_audio_transcript.done',
        event_id: 'evolving-assistant-final',
        response_id: 'evolving-response',
        item_id: 'evolving-assistant',
        transcript: 'voice canary alpha seven confirmed',
        unreleased_provider_field: 7,
      }));

      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({ role: 'user', text: 'hello, please reply out loud' }),
        expect.objectContaining({ role: 'assistant', text: 'voice canary alpha seven confirmed' }),
      ]));

      await vi.waitFor(() => {
        const state = storage.getState();
        const storedMessages = Object.keys(state.sessionMessages)
          .flatMap((sessionId) => readStoredSessionMessages(state, sessionId));
        expect(storedMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'user-text',
            text: 'hello, please reply out loud',
          }),
        ]));
      });
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('transcribes and answers a committed user turn taken while the assistant is idle', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      // Without a configured transcription model the provider keeps every
      // committed input item at `transcript: null`, so Happier never receives
      // the user side of the conversation.
      expect(composed.requestAccountOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: 'client-auth',
          parameters: expect.objectContaining({
            body: expect.objectContaining({
              session: expect.objectContaining({
                audio: expect.objectContaining({
                  input: expect.objectContaining({
                    transcription: { model: expect.stringMatching(/^\S+$/u) },
                  }),
                }),
              }),
            }),
          }),
        }),
      );

      browser.peer.channel.message(JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        event_id: 'idle-turn-speech-started',
        item_id: 'idle-turn-user',
        audio_start_ms: 0,
      }));
      browser.peer.channel.message(JSON.stringify({
        type: 'input_audio_buffer.speech_stopped',
        event_id: 'idle-turn-speech-stopped',
        item_id: 'idle-turn-user',
        audio_end_ms: 1_200,
      }));

      // Response creation is client-owned for this provider, so a plain turn
      // that interrupts nothing is answered only if the host creates it.
      await vi.waitFor(() => expect(browser.peer.channel.sent.map(
        (value) => (JSON.parse(value) as Readonly<{ type?: unknown }>).type,
      )).toContain('response.create'));
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('persists every final of a live-shaped OpenAI session across two turns', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      expect(binding).not.toBeNull();

      // The real `oai-events` channel opens with `session.created` and then
      // streams a full ladder per turn. Replay that exact ordering, including
      // the epoch reset the session boundary performs, so the composed gate
      // exercises the sequence a live conversation actually produces.
      for (const event of buildLiveShapedOpenAiTurnEvents()) {
        browser.peer.channel.message(JSON.stringify(event));
      }

      await vi.waitFor(() => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          final: true,
          text: 'Please reply out loud with exactly these words: History Canary Delta 92.',
        }),
        expect.objectContaining({
          role: 'assistant',
          final: true,
          text: 'History canary delta 9 2',
        }),
        expect.objectContaining({
          role: 'user',
          final: true,
          text: 'Say it one more time.',
        }),
        expect.objectContaining({
          role: 'assistant',
          final: true,
          text: 'History canary delta 9 2 again',
        }),
      ]));

      await vi.waitFor(() => expect(readStoredSessionMessages(
        storage.getState(),
        OPENAI_HISTORY_SESSION_ID,
      )).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'Please reply out loud with exactly these words: History Canary Delta 92.',
        }),
        expect.objectContaining({ kind: 'agent-text' }),
        expect.objectContaining({
          kind: 'user-text',
          text: 'Say it one more time.',
        }),
        expect.objectContaining({ kind: 'agent-text' }),
      ]));
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('settles an admitted final before End Voice releases the direct-media carrier', async () => {
    const writeStarted = createDeferredVoid();
    const releaseWrite = createDeferredVoid();
    let transcriptSequence = 0;
    transcriptRequest.mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(url).toBe(
        `https://openai-composed.example.test/v2/sessions/${OPENAI_HISTORY_SESSION_ID}/messages`,
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{
        localId: string;
      }>;
      transcriptSequence += 1;
      writeStarted.resolve();
      await releaseWrite.promise;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-settled-${transcriptSequence}`,
          seq: transcriptSequence,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'end-voice-settlement-final',
        item_id: 'end-voice-settlement-turn',
        content_index: 0,
        transcript: 'survive immediate End Voice',
        usage: { type: 'duration', seconds: 1 },
      }));
      await writeStarted.promise;

      let stopSettled = false;
      const stopping = composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      }).then(() => {
        stopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(stopSettled).toBe(false);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).not.toBeNull();

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'late-after-end-final',
        item_id: 'late-after-end-turn',
        content_index: 0,
        transcript: 'must stay fenced',
        usage: { type: 'duration', seconds: 1 },
      }));
      releaseWrite.resolve();
      await stopping;

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(readStoredSessionMessages(
        storage.getState(),
        OPENAI_HISTORY_SESSION_ID,
      )).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'survive immediate End Voice',
        }),
      ]);
      expect(transcriptRequest.mock.calls.filter(
        ([input]) => String(input).endsWith(
          `/v2/sessions/${OPENAI_HISTORY_SESSION_ID}/messages`,
        ),
      )).toHaveLength(1);
    } finally {
      releaseWrite.resolve();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('marks an interrupted assistant turn only after its authoritative transcript row is persisted', async () => {
    const assistantWriteStarted = createDeferredVoid();
    const releaseAssistantWrite = createDeferredVoid();
    let transcriptSequence = 0;
    transcriptRequest.mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(url).toBe(
        `https://openai-composed.example.test/v2/sessions/${OPENAI_HISTORY_SESSION_ID}/messages`,
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{
        localId: string;
      }>;
      if (transcriptSequence === 0) {
        assistantWriteStarted.resolve();
        await releaseAssistantWrite.promise;
      }
      transcriptSequence += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-interrupted-${transcriptSequence}`,
          seq: transcriptSequence,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser, {
      readPlaybackCursorMs: () => 250,
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      browser.peer.channel.message(JSON.stringify({
        type: 'response.output_audio.delta',
        event_id: 'interrupted-audio-started',
        response_id: 'interrupted-response',
        item_id: 'interrupted-assistant',
        output_index: 0,
        content_index: 0,
        delta: 'AA==',
      }));
      browser.peer.channel.message(JSON.stringify({
        type: 'response.output_audio_transcript.done',
        event_id: 'interrupted-assistant-final',
        response_id: 'interrupted-response',
        item_id: 'interrupted-assistant',
        output_index: 0,
        content_index: 0,
        transcript: 'This response was interrupted.',
      }));
      await assistantWriteStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 900));

      browser.peer.channel.message(JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        event_id: 'interrupted-user-speech-started',
        item_id: 'interrupted-user',
        audio_start_ms: 250,
      }));
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'interrupted-user-final',
        item_id: 'interrupted-user',
        content_index: 0,
        transcript: 'Please stop and answer this question.',
        usage: { type: 'duration', seconds: 1 },
      }));

      await vi.waitFor(() => expect(
        browser.peer.channel.sent.some((value) => (
          (JSON.parse(value) as Readonly<{ type?: unknown }>).type === 'response.cancel'
        )),
      ).toBe(true));
      expect(readStoredSessionMessages(
        storage.getState(),
        OPENAI_HISTORY_SESSION_ID,
      )).toEqual([]);

      releaseAssistantWrite.resolve();
      await vi.waitFor(() => expect(
        readStoredSessionMessages(
          storage.getState(),
          OPENAI_HISTORY_SESSION_ID,
        ),
      ).toHaveLength(2));
      await vi.waitFor(() => expect(selectVoiceTranscriptEntriesForConversationSession(
        storage.getState(),
        OPENAI_HISTORY_SESSION_ID,
      )).toEqual([
        expect.objectContaining({
          kind: 'assistant',
          text: 'This response was interrupted.',
          interrupted: true,
        }),
        expect.objectContaining({
          kind: 'user',
          text: 'Please stop and answer this question.',
        }),
      ]));
    } finally {
      releaseAssistantWrite.resolve();
      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      }).catch(() => {});
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('refuses active-carrier clear, persists the next final once, then clears after release', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    let discoveredSessionId: string | null = OPENAI_HISTORY_SESSION_ID;
    const deleteSession = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(discoveredSessionId);
      discoveredSessionId = null;
      return { success: true };
    });
    const consumer = createVoiceHistoryConsumer({
      readScopeKey: () => 'server/account',
      captureScope: async () => ({ key: 'server/account' }),
      discoverHistorySession: async () => discoveredSessionId,
      refreshSessionMessages: async () => undefined,
      loadOlderMessages: async () => ({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
      }),
      readMessages: (sessionId) =>
        readStoredSessionMessages(storage.getState(), sessionId),
      readMessagesRevision: (sessionId) =>
        storage.getState().sessionMessages[sessionId]?.messagesVersion ?? 0,
      subscribeHistorySources: (listener) => storage.subscribe(() => { listener(); }),
      resolveProviderLabel: () => 'OpenAI Realtime',
      deleteSession,
      canDeleteSession: canDeleteVoiceHistorySession,
      retireLocalSession: (sessionId) =>
        storage.getState().deleteSession(sessionId),
      runCarrierOperation: runVoiceTranscriptHistoryCarrierOperation,
      now: () => new Date('2026-07-29T12:34:56.000Z'),
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      await consumer.open();
      await expect(consumer.clear()).rejects.toMatchObject({
        name: 'VoiceHistoryClearActiveCallError',
        code: 'voice_history_clear_active_call',
      });
      expect(deleteSession).not.toHaveBeenCalled();
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )?.conversationSessionId).toBe(OPENAI_HISTORY_SESSION_ID);

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-after-clear-final',
        item_id: 'saved-secret-after-clear',
        content_index: 0,
        transcript: 'persist after clearing history',
        usage: { type: 'duration', seconds: 1 },
      }));

      await vi.waitFor(() => expect(
        readStoredSessionMessages(
          storage.getState(),
          OPENAI_HISTORY_SESSION_ID,
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist after clearing history',
        }),
      ]));

      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      });
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();

      await expect(consumer.clear()).resolves.toEqual({ cleared: true });
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID])
        .toBeUndefined();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('serializes same-device carrier acquisition behind an in-flight whole-history clear', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    const recreatedSessionId = 'voice-history-openai-recreated';
    const deleteStarted = createDeferredVoid();
    const releaseDelete = createDeferredVoid();
    let deleteFinished = false;
    let discoveredSessionId: string | null = OPENAI_HISTORY_SESSION_ID;
    const scope = {
      serverId: 'openai-composed-server',
      accountId: 'openai-composed-account',
    } as const satisfies ServerAccountScope;
    const authority = {
      scope,
    } as unknown as ServerAccountSessionRequestAuthority;
    const ensureHistorySession = vi.spyOn(sync, 'ensureHostedSystemSession')
      .mockImplementation(async () => {
        const sessionId = deleteFinished
          ? recreatedSessionId
          : OPENAI_HISTORY_SESSION_ID;
        if (!storage.getState().sessions[sessionId]) {
          storage.setState((current) => ({
            ...current,
            sessions: {
              ...current.sessions,
              [sessionId]: createSessionFixture({
                id: sessionId,
                active: false,
                encryptionMode: 'plain',
                metadata: {
                  path: '/voice-transcript-history',
                  host: 'happier.test',
                  ...buildVoiceTranscriptHistorySessionMetadata(),
                },
              }),
            },
          }) as never);
        }
        return { sessionId };
      });
    const deleteSession = vi.fn(async () => {
      deleteStarted.resolve();
      await releaseDelete.promise;
      deleteFinished = true;
      discoveredSessionId = null;
      return { success: true };
    });
    const runtime: DefaultVoiceHistoryRuntime = {
      readActiveScope: () => scope,
      captureAuthority: async () => authority,
      prepareSessionLookup: async () => undefined,
      lookupByTags: async () => (
        discoveredSessionId ? [{ id: discoveredSessionId }] : []
      ),
      hydrateSession: async (sessionId) => ({ kind: 'available', sessionId }),
      readHydratedSession: (sessionId) =>
        storage.getState().sessions[sessionId] ?? null,
      refreshSessionMessages: async () => undefined,
      loadOlderMessages: async () => ({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
      }),
      readMessages: (sessionId) =>
        readStoredSessionMessages(storage.getState(), sessionId),
      readMessagesRevision: (sessionId) =>
        storage.getState().sessionMessages[sessionId]?.messagesVersion ?? 0,
      subscribeMessages: (listener) => storage.subscribe(() => { listener(); }),
      deleteSession,
      canDeleteSession: canDeleteVoiceHistorySession,
      retireLocalSession: (sessionId) =>
        storage.getState().deleteSession(sessionId),
    };
    const providerRegistry = {
      list: () => [],
      get: () => null,
    } as unknown as VoiceProviderRegistry;
    const consumer = createDefaultVoiceHistoryConsumerFromRuntime(
      runtime,
      providerRegistry,
    );

    try {
      voiceSessionBindingStore.getState().unbind(OPENAI_HISTORY_SESSION_ID);
      await consumer.open();

      const clearing = consumer.clear();
      await deleteStarted.promise;
      const acquiring = composed.hostLease.host.acquireDirectMediaConversation({
        adapterId: 'happier.voice.openai/realtime-openai',
        controlSessionId: composed.controlSessionId,
        requestedTargetSessionId: null,
      });

      expect(ensureHistorySession).not.toHaveBeenCalled();
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();

      releaseDelete.resolve();
      await expect(clearing).resolves.toEqual({ cleared: true });
      await expect(acquiring).resolves.toEqual({
        conversationSessionId: recreatedSessionId,
      });
      expect(ensureHistorySession).toHaveBeenCalledTimes(1);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )?.conversationSessionId).toBe(recreatedSessionId);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID])
        .toBeUndefined();
      expect(storage.getState().sessions[recreatedSessionId]).toBeDefined();
    } finally {
      releaseDelete.resolve();
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      if (binding) {
        voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
      }
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('lets a cross-device carrier deletion win without ending Voice and binds only later finals to a recreated carrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    const recreatedSessionId = 'voice-history-openai-cross-device-recreated';
    const oldWriteStarted = createDeferredVoid();
    const releaseOldWrite = createDeferredVoid();
    const rebindStarted = createDeferredVoid();
    const releaseRebind = createDeferredVoid();
    const transcriptWrites: Array<Readonly<{
      sessionId: string;
      localId: string;
    }>> = [];
    let nextTranscriptSeq = 100;
    const ensureHistorySession = vi.spyOn(sync, 'ensureHostedSystemSession')
      .mockImplementation(async () => {
        rebindStarted.resolve();
        await releaseRebind.promise;
        storage.setState((current) => ({
          ...current,
          sessions: {
            ...current.sessions,
            [recreatedSessionId]: createSessionFixture({
              id: recreatedSessionId,
              active: false,
              encryptionMode: 'plain',
              metadata: {
                path: '/voice-transcript-history',
                host: 'happier.test',
                ...buildVoiceTranscriptHistorySessionMetadata(),
              },
            }),
          },
        }) as never);
        return { sessionId: recreatedSessionId };
      });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-committed-before-delete',
        item_id: 'cross-device-committed-before-delete',
        content_index: 0,
        transcript: 'delete this committed history',
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(
        readStoredSessionMessages(
          storage.getState(),
          OPENAI_HISTORY_SESSION_ID,
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'delete this committed history',
        }),
      ]));

      transcriptRequest.mockImplementation(async (
        input: URL | RequestInfo,
        init?: RequestInit,
      ) => {
        const url = String(input);
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const match = url.match(/\/v2\/sessions\/([^/]+)\/messages$/u);
        if (!match) throw new Error(`unexpected transcript request: ${url}`);
        const sessionId = decodeURIComponent(match[1]!);
        const body = JSON.parse(String(init?.body)) as Readonly<{
          localId: string;
        }>;
        transcriptWrites.push({ sessionId, localId: body.localId });
        if (sessionId === OPENAI_HISTORY_SESSION_ID) {
          oldWriteStarted.resolve();
          await releaseOldWrite.promise;
          nextTranscriptSeq += 1;
          return new Response(JSON.stringify({
            didWrite: true,
            message: {
              id: `openai-history-deleted-late-ack-${nextTranscriptSeq}`,
              seq: nextTranscriptSeq,
              localId: body.localId,
              createdAt: Date.now(),
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        expect(sessionId).toBe(recreatedSessionId);
        nextTranscriptSeq += 1;
        return new Response(JSON.stringify({
          didWrite: true,
          message: {
            id: `openai-history-cross-device-${nextTranscriptSeq}`,
            seq: nextTranscriptSeq,
            localId: body.localId,
            createdAt: Date.now(),
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-admitted-before-delete',
        item_id: 'cross-device-admitted-before-delete',
        content_index: 0,
        transcript: 'do not retry this admitted final',
        usage: { type: 'duration', seconds: 1 },
      }));
      await oldWriteStarted.promise;

      handleDeleteSessionSocketUpdate({
        sessionId: OPENAI_HISTORY_SESSION_ID,
        deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
        removeSessionEncryption: vi.fn(),
        removeProjectManagerSession: vi.fn(),
        clearScmStatusForSession: vi.fn(),
        log: { log: vi.fn() },
      });

      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(browser.micSession.teardown).not.toHaveBeenCalled();
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID]).toBeUndefined();
      expect(storage.getState().sessionMessages[OPENAI_HISTORY_SESSION_ID]).toBeUndefined();

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-final-after-delete-1',
        item_id: 'cross-device-final-after-delete-1',
        content_index: 0,
        transcript: 'persist first after the deletion boundary',
        usage: { type: 'duration', seconds: 1 },
      }));
      await rebindStarted.promise;
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-final-after-delete-2',
        item_id: 'cross-device-final-after-delete-2',
        content_index: 0,
        transcript: 'persist second after the deletion boundary',
        usage: { type: 'duration', seconds: 1 },
      }));
      expect(ensureHistorySession).toHaveBeenCalledTimes(1);
      releaseRebind.resolve();
      releaseOldWrite.resolve();

      await vi.waitFor(() => expect(ensureHistorySession).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(
        voiceSessionBindingStore.getState().getByControlSessionId(
          composed.controlSessionId,
        )?.conversationSessionId,
      ).toBe(recreatedSessionId));
      await vi.waitFor(() => expect(
        readStoredSessionMessages(storage.getState(), recreatedSessionId),
      ).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist first after the deletion boundary',
        }),
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist second after the deletion boundary',
        }),
      ]));
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-final-after-delete-2',
        item_id: 'cross-device-final-after-delete-2',
        content_index: 0,
        transcript: 'persist second after the deletion boundary',
        usage: { type: 'duration', seconds: 1 },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(transcriptWrites.filter(
        ({ sessionId }) => sessionId === OPENAI_HISTORY_SESSION_ID,
      )).toHaveLength(1);
      expect(transcriptWrites.filter(
        ({ sessionId }) => sessionId === recreatedSessionId,
      )).toHaveLength(2);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID]).toBeUndefined();
      expect(storage.getState().sessionMessages[OPENAI_HISTORY_SESSION_ID]).toBeUndefined();
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      releaseOldWrite.resolve();
      releaseRebind.resolve();
      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      }).catch(() => {});
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('does not leave a recreated carrier bound when End Voice races cross-device deletion recovery', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    const recreatedSessionId = 'voice-history-openai-stop-during-rebind';
    const ensureStarted = createDeferredVoid();
    const releaseEnsure = createDeferredVoid();
    vi.spyOn(sync, 'ensureHostedSystemSession').mockImplementation(async () => {
      ensureStarted.resolve();
      await releaseEnsure.promise;
      storage.setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [recreatedSessionId]: createSessionFixture({
            id: recreatedSessionId,
            active: false,
            encryptionMode: 'plain',
            metadata: {
              path: '/voice-transcript-history',
              host: 'happier.test',
              ...buildVoiceTranscriptHistorySessionMetadata(),
            },
          }),
        },
      }) as never);
      return { sessionId: recreatedSessionId };
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      handleDeleteSessionSocketUpdate({
        sessionId: OPENAI_HISTORY_SESSION_ID,
        deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
        removeSessionEncryption: vi.fn(),
        removeProjectManagerSession: vi.fn(),
        clearScmStatusForSession: vi.fn(),
        log: { log: vi.fn() },
      });
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-stop-race-final',
        item_id: 'cross-device-stop-race-final',
        content_index: 0,
        transcript: 'must not outlive End Voice',
        usage: { type: 'duration', seconds: 1 },
      }));
      await ensureStarted.promise;

      let stopSettled = false;
      const stopping = composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      }).then(() => {
        stopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopSettled).toBe(false);
      releaseEnsure.resolve();
      await stopping;
      await vi.waitFor(() => expect(
        storage.getState().sessions[recreatedSessionId],
      ).toBeDefined());

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(readStoredSessionMessages(
        storage.getState(),
        recreatedSessionId,
      )).toEqual([]);
    } finally {
      releaseEnsure.resolve();
      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      }).catch(() => {});
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('commits an A final admitted before a typed acceptance barrier after B replaces its carrier authority', async () => {
    const recreatedCarrierId = 'voice-history-openai-typed-barrier-recreated';
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [recreatedCarrierId]: createSessionFixture({
          id: recreatedCarrierId,
          active: false,
          encryptionMode: 'plain',
          metadata: {
            path: '/voice-transcript-history',
            host: 'happier.test',
            ...buildVoiceTranscriptHistorySessionMetadata(),
          },
        }),
      },
    }) as never);
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser, {
      initialConversationSessionId: recreatedCarrierId,
    });
    const typedAcceptanceStarted = createDeferredVoid();
    const releaseTypedAcceptance = createDeferredVoid();
    const aWriteStarted = createDeferredVoid();
    const releaseAWrite = createDeferredVoid();
    const transcriptWrites: string[] = [];
    let nextTranscriptSequence = 800;
    let replacementAssembly: ReturnType<typeof createBuiltinVoiceAdapterAssembly> | null = null;
    let replacementAdapter: ReturnType<typeof createBuiltinVoiceAdapterAssembly>['adapters'][number] | null = null;
    let replacementBrowser: ReturnType<typeof installVoiceWebRtcBrowserBoundary> | null = null;
    let typedTurn: Promise<void> | null = null;

    transcriptRequest.mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const match = url.match(/\/v2\/sessions\/([^/]+)\/messages$/u);
      if (!match) throw new Error(`unexpected transcript request: ${url}`);
      expect(decodeURIComponent(match[1]!)).toBe(recreatedCarrierId);
      const body = JSON.parse(String(init?.body)) as Readonly<{ localId: string }>;
      transcriptWrites.push(body.localId);
      if (transcriptWrites.length === 1) {
        aWriteStarted.resolve();
        await releaseAWrite.promise;
      }
      nextTranscriptSequence += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-typed-barrier-${nextTranscriptSequence}`,
          seq: nextTranscriptSequence,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      typedTurn = composed.runtime.adapter.sendTextTurn!({
        controlSessionId: composed.controlSessionId,
        conversationSessionId: recreatedCarrierId,
        text: 'hold canonical projection until acceptance',
        localId: 'typed-barrier-a',
        deliveryCommand: 'interrupt_and_send',
        onAccepted: async () => {
          typedAcceptanceStarted.resolve();
          await releaseTypedAcceptance.promise;
        },
      });
      await typedAcceptanceStarted.promise;

      // This final is current and authoritative in A, but its visible projection
      // must remain after the typed turn's `onAccepted` boundary.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-a-final',
        item_id: 'typed-barrier-a-final',
        content_index: 0,
        transcript: 'persist admitted A final once',
        usage: { type: 'duration', seconds: 1 },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transcriptWrites).toEqual([]);

      // B replaces A through the registered OpenAI adapter, with a separate
      // peer and microphone fixture, but receives the same recreated carrier.
      replacementBrowser = installVoiceWebRtcBrowserBoundary();
      const replacementPeer = replacementBrowser.peer;
      vi.stubGlobal('window', Object.freeze({}));
      vi.stubGlobal('document', Object.freeze({}));
      vi.spyOn(realtimeMicSession, 'createRealtimeMicSession')
        .mockReturnValue(replacementBrowser.micSession);
      replacementAssembly = createBuiltinVoiceAdapterAssembly();
      const replacementHost = getCurrentBundledConversationRuntimeHost();
      if (!replacementHost) throw new Error('replacement Voice generation did not become current');
      replacementAdapter = getExternalVoiceProviderRegistration(
        openAiEntry().providerId,
      )?.adapter ?? null;
      if (!replacementAdapter) throw new Error('replacement OpenAI adapter did not register');
      expect(replacementAssembly.adapters).toContain(replacementAdapter);

      const replacementStarting = replacementAdapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        replacementPeer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      replacementPeer.channel.open();
      await replacementStarting;

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
      });
      expect(replacementAdapter.getSnapshot()).toMatchObject({
        sessionId: composed.controlSessionId,
        status: 'connected',
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });

      // A final arriving after B owns the generation must never inherit the
      // custody captured for the exact prior A event.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-a-late-final',
        item_id: 'typed-barrier-a-late-final',
        content_index: 0,
        transcript: 'late A final must stay fenced',
        usage: { type: 'duration', seconds: 1 },
      }));

      releaseTypedAcceptance.resolve();
      // OpenAI sends `response.create` after the durable user-row boundary.
      // B correctly owns the live connection by then, so A's trailing control
      // fails; that must not discard the final A admitted before the boundary.
      await expect(typedTurn).rejects.toThrow('voice_service_unavailable');
      await vi.waitFor(() => expect(transcriptWrites).toHaveLength(1), {
        timeout: 1_000,
      });
      await aWriteStarted.promise;

      replacementPeer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-b-final',
        item_id: 'typed-barrier-b-final',
        content_index: 0,
        transcript: 'persist B final once',
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(transcriptWrites).toHaveLength(2), {
        timeout: 1_000,
      });

      let oldDisposalSettled = false;
      const oldDisposal = composed.runtime.dispose().then(() => {
        oldDisposalSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(oldDisposalSettled).toBe(false);

      releaseAWrite.resolve();
      await oldDisposal;
      await vi.waitFor(() => expect(readStoredSessionMessages(
        storage.getState(),
        recreatedCarrierId,
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist admitted A final once',
        }),
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist B final once',
        }),
      ])));
      expect(transcriptWrites).toHaveLength(2);
      expect(readCanonicalVoiceTranscriptSnapshot(recreatedCarrierId)).toEqual([
        expect.objectContaining({
          itemId: 'typed-barrier-b-final',
          text: 'persist B final once',
        }),
      ]);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(replacementBrowser.micTrack.stop).not.toHaveBeenCalled();
      expect(replacementBrowser.micTrack.enabled).toBe(true);

      await replacementAdapter.stop({
        sessionId: composed.controlSessionId,
      });
      expect(replacementBrowser.micTrack.stop).toHaveBeenCalledTimes(1);
      replacementAdapter = null;
    } finally {
      releaseTypedAcceptance.resolve();
      releaseAWrite.resolve();
      await typedTurn?.catch(() => {});
      await composed.runtime.dispose().catch(() => {});
      await replacementAdapter?.stop({
        sessionId: composed.controlSessionId,
      }).catch(() => {});
      await replacementAssembly?.dispose();
      composed.hostLease.revoke();
      replacementBrowser?.restore();
      browser.restore();
    }
  });

  it('commits an A correction admitted before a typed acceptance barrier after B replaces its carrier authority', async () => {
    const recreatedCarrierId = 'voice-history-openai-typed-barrier-correction-recreated';
    const initialTranscript = 'persist initial A final once';
    const correctedTranscript = 'persist admitted A correction once';
    const aItemId = 'typed-barrier-a-correction-item';
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [recreatedCarrierId]: createSessionFixture({
          id: recreatedCarrierId,
          active: false,
          encryptionMode: 'plain',
          metadata: {
            path: '/voice-transcript-history',
            host: 'happier.test',
            ...buildVoiceTranscriptHistorySessionMetadata(),
          },
        }),
      },
    }) as never);
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser, {
      initialConversationSessionId: recreatedCarrierId,
    });
    const typedAcceptanceStarted = createDeferredVoid();
    const releaseTypedAcceptance = createDeferredVoid();
    const aCorrectionWriteStarted = createDeferredVoid();
    const releaseACorrectionWrite = createDeferredVoid();
    const transcriptWrites: string[] = [];
    const persistedCorrectionRow = {
      id: 'openai-history-typed-barrier-correction',
      seq: 901,
      createdAt: 1_700_000_000_000,
    } as const;
    let replacementAssembly: ReturnType<typeof createBuiltinVoiceAdapterAssembly> | null = null;
    let replacementAdapter: ReturnType<typeof createBuiltinVoiceAdapterAssembly>['adapters'][number] | null = null;
    let replacementBrowser: ReturnType<typeof installVoiceWebRtcBrowserBoundary> | null = null;
    let typedTurn: Promise<void> | null = null;
    let oldStopping: Promise<void> | null = null;

    transcriptRequest.mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const match = url.match(/\/v2\/sessions\/([^/]+)\/messages$/u);
      if (!match) throw new Error(`unexpected transcript request: ${url}`);
      expect(decodeURIComponent(match[1]!)).toBe(recreatedCarrierId);
      const body = JSON.parse(String(init?.body)) as Readonly<{ localId: string }>;
      transcriptWrites.push(body.localId);
      if (transcriptWrites.length === 2) {
        aCorrectionWriteStarted.resolve();
        await releaseACorrectionWrite.promise;
      }
      const isCorrection = transcriptWrites.length > 1;
      return new Response(JSON.stringify({
        didWrite: !isCorrection,
        ...(isCorrection ? { didUpdate: true } : {}),
        message: {
          ...persistedCorrectionRow,
          localId: body.localId,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      // Establish the durable row that the same-item correction must replace.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-a-correction-final',
        item_id: aItemId,
        content_index: 0,
        transcript: initialTranscript,
        usage: { type: 'duration', seconds: 1 },
      }));
      await vi.waitFor(() => expect(transcriptWrites).toHaveLength(1));
      await vi.waitFor(() => expect(readStoredSessionMessages(
        storage.getState(),
        recreatedCarrierId,
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'user-text',
          text: initialTranscript,
        }),
      ])));

      typedTurn = composed.runtime.adapter.sendTextTurn!({
        controlSessionId: composed.controlSessionId,
        conversationSessionId: recreatedCarrierId,
        text: 'hold correction projection until acceptance',
        localId: 'typed-barrier-a-correction',
        deliveryCommand: 'interrupt_and_send',
        onAccepted: async () => {
          typedAcceptanceStarted.resolve();
          await releaseTypedAcceptance.promise;
        },
      });
      await typedAcceptanceStarted.promise;

      // OpenAI emits a repeated completed event for the same item when its
      // transcript is corrected. It must be admitted synchronously while A
      // still owns the generation, then drain after the typed boundary.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-a-correction',
        item_id: aItemId,
        content_index: 0,
        transcript: correctedTranscript,
        usage: { type: 'duration', seconds: 1 },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transcriptWrites).toHaveLength(1);

      // B replaces A through the registered OpenAI adapter with a distinct
      // peer and microphone fixture, while retaining the same carrier.
      replacementBrowser = installVoiceWebRtcBrowserBoundary();
      const replacementPeer = replacementBrowser.peer;
      vi.stubGlobal('window', Object.freeze({}));
      vi.stubGlobal('document', Object.freeze({}));
      vi.spyOn(realtimeMicSession, 'createRealtimeMicSession')
        .mockReturnValue(replacementBrowser.micSession);
      replacementAssembly = createBuiltinVoiceAdapterAssembly();
      const replacementHost = getCurrentBundledConversationRuntimeHost();
      if (!replacementHost) throw new Error('replacement Voice generation did not become current');
      replacementAdapter = getExternalVoiceProviderRegistration(
        openAiEntry().providerId,
      )?.adapter ?? null;
      if (!replacementAdapter) throw new Error('replacement OpenAI adapter did not register');
      expect(replacementAssembly.adapters).toContain(replacementAdapter);

      const replacementStarting = replacementAdapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        replacementPeer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      replacementPeer.channel.open();
      await replacementStarting;

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
      });
      expect(replacementAdapter.getSnapshot()).toMatchObject({
        sessionId: composed.controlSessionId,
        status: 'connected',
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });

      // An A event arriving only after B becomes current has no captured
      // custody and must remain fenced.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-a-late-after-correction',
        item_id: 'typed-barrier-a-late-after-correction',
        content_index: 0,
        transcript: 'late A final must stay fenced',
        usage: { type: 'duration', seconds: 1 },
      }));

      releaseTypedAcceptance.resolve();
      await expect(typedTurn).rejects.toThrow('voice_service_unavailable');
      await vi.waitFor(() => expect(transcriptWrites).toHaveLength(2), {
        timeout: 1_000,
      });
      await aCorrectionWriteStarted.promise;

      let oldStopSettled = false;
      oldStopping = composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      }).then(() => {
        oldStopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(oldStopSettled).toBe(false);

      releaseACorrectionWrite.resolve();
      await oldStopping;
      await vi.waitFor(() => {
        const aRows = readStoredSessionMessages(
          storage.getState(),
          recreatedCarrierId,
        ).filter((message) => (
          message.kind === 'user-text'
          && (message.text === initialTranscript || message.text === correctedTranscript)
        ));
        expect(aRows).toEqual([
          expect.objectContaining({ text: correctedTranscript }),
        ]);
      });
      expect(transcriptWrites).toHaveLength(2);
      expect(new Set(transcriptWrites).size).toBe(1);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
      });
      expect(replacementAdapter.getSnapshot()).toMatchObject({
        sessionId: composed.controlSessionId,
        status: 'connected',
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(replacementBrowser.micTrack.stop).not.toHaveBeenCalled();
      expect(replacementBrowser.micTrack.enabled).toBe(true);

      await replacementAdapter.stop({
        sessionId: composed.controlSessionId,
      });
      expect(replacementBrowser.micTrack.stop).toHaveBeenCalledTimes(1);
      replacementAdapter = null;
    } finally {
      releaseTypedAcceptance.resolve();
      releaseACorrectionWrite.resolve();
      await typedTurn?.catch(() => {});
      await oldStopping?.catch(() => {});
      await composed.runtime.dispose().catch(() => {});
      await replacementAdapter?.stop({
        sessionId: composed.controlSessionId,
      }).catch(() => {});
      await replacementAssembly?.dispose();
      composed.hostLease.revoke();
      replacementBrowser?.restore();
      browser.restore();
    }
  });

  it('drains an admitted targetless final across generation replacement without letting retirement mutate the new binding', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = createSourceComposedOpenAiRuntime(browser);
    const recreatedCarrierId = 'voice-history-openai-generation-drain-recreated';
    const carrierEnsureStarted = createDeferredVoid();
    const releaseCarrierEnsure = createDeferredVoid();
    const persistenceStarted = createDeferredVoid();
    const releasePersistence = createDeferredVoid();
    const transcriptWrites: Array<Readonly<{
      sessionId: string;
      localId: string;
    }>> = [];
    let nextTranscriptSequence = 700;
    let replacementAssembly: ReturnType<typeof createBuiltinVoiceAdapterAssembly> | null = null;
    let replacementAdapter: ReturnType<typeof createBuiltinVoiceAdapterAssembly>['adapters'][number] | null = null;
    let replacementBrowser: ReturnType<typeof installVoiceWebRtcBrowserBoundary> | null = null;
    let oldDisposalSettled = false;

    vi.spyOn(sync, 'ensureHostedSystemSession').mockImplementation(async () => {
      carrierEnsureStarted.resolve();
      await releaseCarrierEnsure.promise;
      storage.setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [recreatedCarrierId]: createSessionFixture({
            id: recreatedCarrierId,
            active: false,
            encryptionMode: 'plain',
            metadata: {
              path: '/voice-transcript-history',
              host: 'happier.test',
              ...buildVoiceTranscriptHistorySessionMetadata(),
            },
          }),
        },
      }) as never);
      return { sessionId: recreatedCarrierId };
    });
    transcriptRequest.mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const match = url.match(/\/v2\/sessions\/([^/]+)\/messages$/u);
      if (!match) throw new Error(`unexpected transcript request: ${url}`);
      const sessionId = decodeURIComponent(match[1]!);
      expect(sessionId).toBe(recreatedCarrierId);
      const body = JSON.parse(String(init?.body)) as Readonly<{ localId: string }>;
      transcriptWrites.push({ sessionId, localId: body.localId });
      persistenceStarted.resolve();
      await releasePersistence.promise;
      nextTranscriptSequence += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `openai-history-generation-drain-${nextTranscriptSequence}`,
          seq: nextTranscriptSequence,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        initialContext: '',
      });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;
      const admittedBinding = voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      );
      if (!admittedBinding) throw new Error('old Voice generation did not own its initial carrier');
      const replacementBindingUpdatedAt = admittedBinding.updatedAt;
      vi.spyOn(Date, 'now').mockReturnValue(replacementBindingUpdatedAt);

      handleDeleteSessionSocketUpdate({
        sessionId: OPENAI_HISTORY_SESSION_ID,
        deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
        removeSessionEncryption: vi.fn(),
        removeProjectManagerSession: vi.fn(),
        clearScmStatusForSession: vi.fn(),
        log: { log: vi.fn() },
      });
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'generation-drain-admitted-final',
        item_id: 'generation-drain-admitted-final',
        content_index: 0,
        transcript: 'persist this admitted final exactly once',
        usage: { type: 'duration', seconds: 1 },
      }));
      await carrierEnsureStarted.promise;

      // A new assembly becomes the live singleton synchronously. Its registered
      // OpenAI adapter begins through the real lifecycle while A still owns the
      // carrier-operation slot; it must acquire the carrier and establish its
      // own opaque runtime binding rather than receiving either by test setup.
      replacementBrowser = installVoiceWebRtcBrowserBoundary();
      const replacementPeer = replacementBrowser.peer;
      // The source-composed gate runs in a Node test process. Establish the
      // browser host boundary so B follows the real web audio-mode branch
      // instead of asking the unavailable native coordinator for a lease.
      vi.stubGlobal('window', Object.freeze({}));
      vi.stubGlobal('document', Object.freeze({}));
      // B still goes through the registered adapter and bundled host. Supply
      // only its browser microphone boundary from the canonical WebRTC testkit;
      // the Node runner otherwise selects the native capture implementation.
      // Its fixture is intentionally distinct from A's so A disposal cannot
      // make this replacement survive merely by sharing capture ownership.
      vi.spyOn(realtimeMicSession, 'createRealtimeMicSession')
        .mockReturnValue(replacementBrowser.micSession);
      replacementAssembly = createBuiltinVoiceAdapterAssembly();
      const replacementHost = getCurrentBundledConversationRuntimeHost();
      if (!replacementHost) throw new Error('replacement Voice generation did not become current');
      replacementAdapter = getExternalVoiceProviderRegistration(
        openAiEntry().providerId,
      )?.adapter ?? null;
      if (!replacementAdapter) throw new Error('replacement OpenAI adapter did not register');
      expect(replacementAssembly.adapters).toContain(replacementAdapter);
      expect(getCurrentBundledConversationRuntimeHost()).toBe(replacementHost);

      const replacementStarting = replacementAdapter.start({
        sessionId: '',
        initialContext: '',
      });
      expect(replacementPeer.createDataChannel).not.toHaveBeenCalled();
      releaseCarrierEnsure.resolve();
      await persistenceStarted.promise;
      await vi.waitFor(() => expect(
        replacementPeer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      replacementPeer.channel.open();
      await replacementStarting;

      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
        updatedAt: replacementBindingUpdatedAt,
      });
      expect(replacementAdapter.getSnapshot()).toMatchObject({
        sessionId: composed.controlSessionId,
        status: 'connected',
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });

      // Replacement is already the sole live generation, even though its old
      // predecessor has not begun disposal yet. A late final must not join A's
      // admitted carrier rebind merely because that rebind remains pending,
      // while B's real provider final still persists exactly once.
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'generation-drain-retired-final',
        item_id: 'generation-drain-retired-final',
        content_index: 0,
        transcript: 'this post-retirement final must stay fenced',
        usage: { type: 'duration', seconds: 1 },
      }));
      replacementPeer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'generation-drain-replacement-final',
        item_id: 'generation-drain-replacement-final',
        content_index: 0,
        transcript: 'persist this replacement final exactly once',
        usage: { type: 'duration', seconds: 1 },
      }));
      // Let the real control-event pump admit or fence the message while A is
      // still undisposed; disposal must not be the fence that makes this pass.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const oldDisposal = composed.runtime.dispose().then(() => {
        oldDisposalSettled = true;
      });

      releaseCarrierEnsure.resolve();
      // B is current, connected, and has admitted its own final while A's
      // earlier write remains awaiting its ACK. Both canonical persistence
      // attempts may therefore be pending together; the late retired-A final
      // must not add a third write.
      await vi.waitFor(() => expect(transcriptWrites).toHaveLength(2), {
        timeout: 1_000,
      });
      await persistenceStarted.promise;

      expect(oldDisposalSettled).toBe(false);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
        updatedAt: replacementBindingUpdatedAt,
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });

      releasePersistence.resolve();
      await oldDisposal;
      await vi.waitFor(() => expect(readStoredSessionMessages(
        storage.getState(),
        recreatedCarrierId,
      )).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist this admitted final exactly once',
        }),
        expect.objectContaining({
          kind: 'user-text',
          text: 'persist this replacement final exactly once',
        }),
      ]));
      expect(transcriptWrites).toHaveLength(2);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toMatchObject({
        conversationSessionId: recreatedCarrierId,
        adapterId: openAiEntry().providerId,
        updatedAt: replacementBindingUpdatedAt,
      });
      expect(replacementHost.machine.getSnapshot()).toMatchObject({
        controlSessionId: composed.controlSessionId,
        adapterId: openAiEntry().providerId,
        state: 'connected',
      });
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(replacementBrowser.micTrack.stop).not.toHaveBeenCalled();
      expect(replacementBrowser.micTrack.enabled).toBe(true);

      await replacementAdapter.stop({
        sessionId: composed.controlSessionId,
      });
      expect(replacementBrowser.micTrack.stop).toHaveBeenCalledTimes(1);
      replacementAdapter = null;
    } finally {
      releaseCarrierEnsure.resolve();
      releasePersistence.resolve();
      await composed.runtime.dispose().catch(() => {});
      await replacementAdapter?.stop({
        sessionId: composed.controlSessionId,
      }).catch(() => {});
      await replacementAssembly?.dispose();
      composed.hostLease.revoke();
      replacementBrowser?.restore();
      browser.restore();
    }
  });

  it('awaits real session.update send acceptance before publishing connected', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    setBufferedAmount(browser.peer.channel, VOICE_WEBRTC_LIMITS.outboundBufferedBytes);
    const composed = createSourceComposedOpenAiRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', initialContext: '' });
      await vi.waitFor(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connecting');

      browser.peer.channel.open();
      await vi.waitFor(() => expect(
        (browser.peer.channel as unknown as RTCDataChannel).bufferedAmountLowThreshold,
      ).toBeGreaterThan(0));

      await expect(Promise.race([
        starting.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 50);
        }),
      ])).resolves.toBe('pending');
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connecting');
      expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual([]);

      (browser.peer.channel as unknown as { bufferedAmount: number }).bufferedAmount = 0;
      browser.peer.channel.dispatchEvent(new Event('bufferedamountlow'));
      await starting;

      expect(openAiSessionUpdates(browser.peer.channel.sent)).toEqual([
        expect.objectContaining({ type: 'session.update' }),
      ]);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('closes the peer and never publishes connected when session.update is rejected', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    vi.spyOn(browser.peer.channel, 'send').mockImplementation(() => {
      throw new Error('data channel rejected session.update');
    });
    const composed = createSourceComposedOpenAiRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', initialContext: '' });
      await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
      browser.peer.channel.open();

      await expect(starting).rejects.toThrow();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(statuses).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connected');
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('closes the peer and never publishes connected when aborted at the session.update barrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    setBufferedAmount(browser.peer.channel, VOICE_WEBRTC_LIMITS.outboundBufferedBytes);
    const composed = createSourceComposedOpenAiRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', initialContext: '' });
      await vi.waitFor(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
      browser.peer.channel.open();
      await vi.waitFor(() => expect(
        (browser.peer.channel as unknown as RTCDataChannel).bufferedAmountLowThreshold,
      ).toBeGreaterThan(0));

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      await starting;

      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(statuses).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connected');
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });
});
