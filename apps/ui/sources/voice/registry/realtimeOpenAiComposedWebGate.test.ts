import { waitForTestEvent } from '@/dev/testkit';
import * as React from 'react';
import { createOpenAiVoiceRuntimeEnvironment, type OpenAiMintTransport } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { z } from 'zod/mini';
import { type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { log } from '@/log';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { sync } from '@/sync/sync';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-audio', async () => (await import('@/dev/testkit/mocks/expoAudio')).expoAudioModuleMock());
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
  installVoiceWebRtcBrowserBoundary,
  TestVoiceWebRtcPeer,
} from '@/dev/testkit/harness/voiceWebRtcHarness';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
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
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
  captureServerRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import '@/sync/syncEngine';

import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { handleDeleteSessionSocketUpdate } from '@/sync/engine/sessions/syncSessions';

import {
  buildVoiceTranscriptHistorySessionMetadata,
  runVoiceTranscriptHistoryCarrierOperation,
} from '@/voice/persistence/voiceTranscriptHistorySession';
import {
  VOICE_WEBRTC_LIMITS,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';

import * as realtimeMicSession from '@/voice/runtime/mic/createRealtimeMicSession';
import { createVoiceHistoryConsumer } from '@/voice/history/voiceHistoryConsumer';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { VoiceSessionRuntime } from '@/voice/session/VoiceSessionRuntime';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createBuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';

import {
  selectVoiceTranscriptEntriesForConversationSession,
} from '@/voice/transcript/voiceTranscriptSelectors';
import { getCurrentBundledConversationRuntimeHost } from './bundledConversationRuntimeHost';

import { getExternalVoiceProviderRegistration, subscribeExternalVoiceProviderRegistrations } from './externalVoiceProviderRegistrations';
import { subscribeToVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';

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

const OPENAI_HISTORY_SESSION_ID = 'voice-history-openai-composed';
const OPENAI_CREDENTIAL_MACHINE_ID = 'openai-credential-machine';
function readMintRequestAccount(request: Parameters<OpenAiMintTransport>[0]): string {
  expect(request).toMatchObject({
    contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
    platform: 'web', phase: 'prepare', operationId: 'client-auth',
    declarationAuthority: { kind: 'bundled' },
    expectedSelection: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } } },
  });
  if (request.expectedSelection.kind !== 'account') throw new Error('Expected an Account mint request');
  return request.expectedSelection.account.accountId;
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
  occurrenceId: 'happier-current-ui-composed-gate-occurrence-1',
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
  credentials: AuthCredentials;
  navigationBinding: ReturnType<typeof createPluginSurfaceDestinationNavigationBinding>;
  onReader: (reader: CurrentUiContextReader | null) => void;
}>): React.ReactElement {
  return React.createElement(InjectedAuthProvider, {
    credentials: input.credentials,
    children: React.createElement(MainAppTabStateProvider, null,
      React.createElement(AppPaneProvider, null,
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
      ),
    ),
  });
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
  channel: TestVoiceWebRtcPeer['channel'],
  bufferedAmount: number,
): void {
  channel.bufferedAmountLowThreshold = 0;
  Object.defineProperties(channel, {
    bufferedAmount: {
      configurable: true,
      writable: true,
      value: bufferedAmount,
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
      { type: 'output_audio_buffer.started', event_id: `${prefix}_audio_buffer_started`, response_id: responseId },
      { type: 'response.output_audio_transcript.delta', event_id: `${prefix}_assistant_delta_2`, response_id: responseId, item_id: assistantItem, output_index: 0, content_index: 0, delta: turn.assistantText.slice(8) },
      { type: 'output_audio_buffer.stopped', event_id: `${prefix}_audio_buffer_stopped`, response_id: responseId },
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

function removeOpenAiSavedSecret(): void {
  storage.setState((current) => ({
    ...current,
    settings: {
      ...current.settings,
      secrets: [],
    },
  }) as never);
}

const CONNECTED_ACCOUNT_CREDENTIAL_SUITE = 'with a Connected Account credential source';

describe('realtime_openai source-composed WebRTC gate', () => {
  let environment: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>;
  const openAiEntry = () => environment.entry;
  const createOpenAiClientAuthProviderResponse = (...args: Parameters<typeof environment.createClientAuthProviderResponse>) => environment.createClientAuthProviderResponse(...args);
  const transcriptMessageUrl = (sessionId: string) => environment.transcriptMessageUrl(sessionId);
  let transcriptRequest: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>['transcriptRequest'];
  let sessionHttp: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>['sessionHttp'];
  let homeRequest: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>['homeRequest'];
  let allowedTranscriptMessageUrls: Set<string>;
  let accountConnection: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>['accountConnection'];
  let purposes: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>['purposes'];
  // Connected Account credential tests live in the nested suite below; every other
  // case composes the approved SavedSecret source.
  beforeEach(async context => {
    environment = await createOpenAiVoiceRuntimeEnvironment({
      credentialSource: context.task.suite?.name === CONNECTED_ACCOUNT_CREDENTIAL_SUITE ? 'connectedAccount' : 'savedSecret',
    });
    ({ transcriptRequest, sessionHttp, homeRequest, allowedTranscriptMessageUrls, accountConnection, purposes } = environment);
  });
  afterEach(async () => { await environment?.dispose(); });

  it('fences an Account-retired real OpenAI attempt before retained current-UI read or command tool calls can reach A or B', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    // The real web Home mutation owner also reaches the browser Web Locks API.
    const webLocks = installWebLockManagerMock();
    storage.setState((current) => ({
      settings: {
        ...current.settings,
        experiments: true,
        featureToggles: { ...current.settings.featureToggles, voice: true },
      },
    }));
    // This composed test mounts the real AppShell runtime in the Node runner.
    // Keep its real web path while supplying only the browser-owned boundaries
    // that the runner cannot select through platform file resolution.
    vi.stubGlobal('window', Object.freeze({}));
    vi.stubGlobal('document', Object.freeze({}));
    vi.spyOn(realtimeMicSession, 'createRealtimeMicSession')
      .mockImplementation(browser.createMicSession);
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
    let accountB: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
    const readerRef: { current: CurrentUiContextReader | null } = { current: null };
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

    try {
      screen = await renderScreen(renderAccountRetirementVoiceComposition({
        label: 'Account A',
        credentials: accountConnection!.credentials,
        navigationBinding,
        onReader: (next) => { readerRef.current = next; },
      }));
      await waitForTestEvent(screen!.subscribe, () => expect(readerRef.current?.readCurrentUiContext()?.entity?.label).toBe('Account A'));
      const commandA = readerRef.current?.readCurrentUiContext()?.commands[0]?.id ?? '';
      expect(commandA).toMatch(/^current-ui-command:/);

      await waitForTestEvent(subscribeExternalVoiceProviderRegistrations, () => expect(
        getExternalVoiceProviderRegistration(openAiEntry().providerId)?.adapter,
      ).not.toBeNull());
      const configuredVoice = voiceSettingsParse(storage.getState().settings.voiceSettingsV1);
      expect(configuredVoice.providerId).toBe(openAiEntry().providerId);
      await waitForTestEvent(subscribeToVoiceSessionSnapshot, () => expect(
        getVoiceSessionLifecycleController()?.getConfiguredProviderId(),
      ).toBe(openAiEntry().providerId));
      voiceSessionBindingStore.getState().bind({
        adapterId: openAiEntry().providerId,
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: OPENAI_HISTORY_SESSION_ID,
        conversationSessionAddress: {
          serverId: getActiveServerSnapshot().serverId,
          sessionId: OPENAI_HISTORY_SESSION_ID,
        },
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionAddress: null,
        updatedAt: 1,
      });
      const controller = getVoiceSessionLifecycleController();
      if (!controller) throw new Error('Expected the real Voice lifecycle controller.');
      const tools = getCurrentBundledConversationRuntimeHost()?.getRealtimeClientToolDefinitions({
        effectCalls: 'stable_ids',
        exposure: 'voice_assistant',
      }) ?? [];
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'readCurrentUiContext',
        'invokeCurrentUiCommand',
      ]));
      const starting = controller.toggle(null);
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
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
      await waitForTestEvent(browser.peer.channel.subscribe, () => {
        expect(readOpenAiFunctionCallOutputIds(browser.peer.channel.sent)).toEqual(
          expect.arrayContaining(['active-account-a:read', 'active-account-a:invoke']),
        );
      });
      expect(openSurface).toHaveBeenCalledTimes(1);
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
      await waitForTestEvent(controller.subscribe!, () => {
        expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot().status).toBe('disconnected');
      });

      accountB = await restoreServerAccountForTest({
        serverUrl: 'https://openai-composed-account-b.example.test',
        accountId: 'openai-composed-account-b',
        activation: 'switch',
        additionalRequestOrigins: [accountConnection.home.serverUrl],
        request: async (input, init) => {
          const url = new URL(String(input));
          if (url.origin === new URL(accountConnection.home.serverUrl).origin) return homeRequest(input, init);
          if (url.pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'openai-composed-account-b' }));
          if (url.pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: OPENAI_CREDENTIAL_MACHINE_ID, accountId: 'openai-composed-account-b' })]);
          if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => id === OPENAI_CREDENTIAL_MACHINE_ID ? createPlainMachineRowFixture({ id, accountId: 'openai-composed-account-b' }) : null);
          if (url.pathname === `/v1/machines/${OPENAI_CREDENTIAL_MACHINE_ID}`) return Response.json({ machine: createPlainMachineRowFixture({ id: OPENAI_CREDENTIAL_MACHINE_ID, accountId: 'openai-composed-account-b' }) });
          return homeRequest(input, init);
        },
      });
      await sync.refreshProfile();
      expect(storage.getState().profileScope).toEqual({ serverId: accountB.home.id, accountId: 'openai-composed-account-b' });
      expect(storage.getState().profile.id).toBe('openai-composed-account-b');
      await screen.update(renderAccountRetirementVoiceComposition({
        label: 'Account B',
        credentials: accountB.credentials,
        navigationBinding,
        onReader: (next) => { readerRef.current = next; },
      }));
      await waitForTestEvent(screen!.subscribe, () => expect(readerRef.current?.readCurrentUiContext()?.entity?.label).toBe('Account B'));
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
      const retiringController = getVoiceSessionLifecycleController();
      if (screen) await screen.unmount();
      await retiringController?.dispose();
      await accountB?.dispose();
      retireActiveServerAccountScopeLifetime();
      expect(getVoiceSessionLifecycleController()).toBeNull();
      webLocks.restore();
      browser.restore();
    }
  });

  it('rehydrates a persisted history carrier missing from local state before reusing it for a new runtime attempt', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    // The persisted plain owner tuple remains present at the Home boundary.
    // Eviction exercises real rehydration without inventing an E2EE→plain transition.
    storage.setState((current) => {
      const sessions = { ...current.sessions };
      delete sessions[OPENAI_HISTORY_SESSION_ID];
      return { ...current, sessions };
    });

    try {
      await expect(composed.hostLease.host.acquireDirectMediaConversation({
        adapterId: 'happier.voice.openai/realtime-openai',
        controlSessionId: composed.controlSessionId,
        requestedTargetSessionAddress: null,
      })).resolves.toEqual({
        conversationSessionId: OPENAI_HISTORY_SESSION_ID,
      });
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID]?.encryptionMode).toBe('plain');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('runs approved SavedSecret through public activation and reuses the canonical no-daemon history carrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
        targetSessionAddress: null,
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
      })).resolves.toEqual({
        conversationSessionId: null,
        conversationServerId: null,
      });

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'saved-secret-user-final',
        item_id: 'saved-secret-user',
        content_index: 0,
        transcript: 'hello without a daemon',
        usage: { type: 'duration', seconds: 1 },
      }));
      await waitForTestEvent(storage.subscribe, () => expect(
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

  it('declines a missing SavedSecret before microphone or WebRTC admission', async () => {
    removeOpenAiSavedSecret();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
    const getUserMedia = vi.mocked(
      globalThis.navigator.mediaDevices.getUserMedia,
    );
    const providerFetch = vi.mocked(globalThis.fetch);

    try {
      await composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });

      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'provider_auth_invalid',
        errorMessage: 'credential_unavailable',
        errorRecoveryAction: 'review_credentials',
        errorPresentation: 'error',
      });
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(peerConstructor).not.toHaveBeenCalled();
      expect(browser.peers).toEqual([]);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(composed.requestAccountOperation).toHaveBeenCalledOnce();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('reports an indeterminate selected Connected Account binding before microphone or WebRTC admission', async () => {
    await environment.installConnectedAccountSettings();
    // Invalid stored selection is indeterminate, unlike an acknowledged source removal.
    environment.persistedAccountSettings = storage.getState().settings;
    purposes.replace({ v: 1, bindings: [] });
    await purposes.hydrate({ serverId: getActiveServerSnapshot().serverId, accountId: 'openai-composed-account' });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
    const getUserMedia = vi.mocked(
      globalThis.navigator.mediaDevices.getUserMedia,
    );
    const providerFetch = vi.mocked(globalThis.fetch);

    try {
      await expect(composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      })).rejects.toMatchObject({ code: 'service_temporarily_unavailable' });

      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'service_temporarily_unavailable',
        errorMessage: 'service_temporarily_unavailable',
      });
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(peerConstructor).not.toHaveBeenCalled();
      expect(browser.peers).toEqual([]);
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
      await environment.installConnectedAccountSettings();
      await environment.selectConnectedAccount('account-a');
      let binding: string | null = 'account-a';
      const authorityInvalidation = createDeferredVoid();
      const watchReady = createDeferredVoid();
      const request = vi.fn(async (packet: Parameters<OpenAiMintTransport>[0]) => {
        const admittedBinding = readMintRequestAccount(packet);
        if (admittedBinding === 'account-b') {
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
      const peerCreated = createDeferredVoid();
      const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: () => peerCreated.resolve() });
      const composed = await environment.createRuntime(browser, {
        respondToDaemonAccountOperation: request,
      });
      const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
      const getUserMedia = vi.mocked(
        globalThis.navigator.mediaDevices.getUserMedia,
      );

      try {
        const firstStart = composed.runtime.adapter.start({
          sessionId: '',
          requestedTargetSessionAddress: null,
          initialContext: '',
        }).then(() => null, (error: unknown) => error);
        await watchReady.promise;
        binding = invalidatedBinding;
        await environment.selectConnectedAccount(binding);
        authorityInvalidation.reject(Object.assign(
          new Error('credential_unavailable'),
          { code: 'credential_unavailable' },
        ));
        await expect(firstStart).resolves.toMatchObject({ code: 'voice_account_operation_cancelled' });

        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          status: 'error',
          errorCode: 'voice_account_operation_cancelled',
          errorMessage: 'voice_account_operation_cancelled',
        });
        expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(peerConstructor).not.toHaveBeenCalled();
        expect(browser.peers).toEqual([]);
        expect(request).toHaveBeenCalledOnce();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(openAiSessionUpdates(browser.peers.flatMap(peer => peer.channel.sent))).toEqual([]);

        binding = 'account-b';
        await environment.selectConnectedAccount(binding);
        const secondStart = composed.runtime.adapter.start({
          sessionId: '',
          requestedTargetSessionAddress: null,
          initialContext: '',
        });
        await Promise.race([peerCreated.promise, secondStart]);
        await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
          browser.peer.createDataChannel,
        ).toHaveBeenCalledWith('oai-events'));
        expect(request).toHaveBeenCalledTimes(2);
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
      await environment.installConnectedAccountSettings();
      await environment.selectConnectedAccount('account-a');
      let binding: string | null = 'account-a';
      const firstResourcePreparationEntered = createDeferredVoid();
      const releaseFirstResourcePreparation = createDeferredVoid();
      const secondResourcePreparationEntered = createDeferredVoid();
      const releaseSecondResourcePreparation = createDeferredVoid();
      let resourcePreparationCount = 0;
      const requestBindings: Array<string | null> = [];
      const request = vi.fn(async (packet: Parameters<OpenAiMintTransport>[0]) => {
        const admittedBinding = readMintRequestAccount(packet);
        requestBindings.push(admittedBinding);
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
      const composed = await environment.createRuntime(browser, {
        respondToDaemonAccountOperation: request,
      });
      const peerConstructor = vi.mocked(globalThis.RTCPeerConnection);
      const getUserMedia = vi.mocked(
        globalThis.navigator.mediaDevices.getUserMedia,
      );
      const acquireMedia = getUserMedia.getMockImplementation();
      if (!acquireMedia) throw new Error('Browser capture boundary is missing');
      getUserMedia.mockImplementation(async constraints => {
        resourcePreparationCount += 1;
        if (resourcePreparationCount === 1) {
          firstResourcePreparationEntered.resolve();
          await releaseFirstResourcePreparation.promise;
        } else {
          secondResourcePreparationEntered.resolve();
          await releaseSecondResourcePreparation.promise;
        }
        return acquireMedia(constraints);
      });

      try {
        const firstStart = composed.runtime.adapter.start({
          sessionId: '',
          requestedTargetSessionAddress: null,
          initialContext: '',
        });
        await firstResourcePreparationEntered.promise;
        expect(requestBindings).toEqual(['account-a']);
        expect(request).toHaveBeenCalledOnce();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(browser.micSession.ensureActive).toHaveBeenCalledOnce();
        expect(getUserMedia).toHaveBeenCalledOnce();
        expect(peerConstructor).not.toHaveBeenCalled();

        binding = nextBinding;
        await environment.selectConnectedAccount(binding);
        releaseFirstResourcePreparation.resolve();
        await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
          requestedTargetSessionAddress: null,
          initialContext: '',
        });
        if (nextBinding === null) {
          await secondStart;
          expect(requestBindings).toEqual(['account-a']);
          expect(request).toHaveBeenCalledOnce();
          expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
            status: 'error',
            errorCode: 'provider_auth_invalid',
          });
        } else {
          await secondResourcePreparationEntered.promise;
          expect(requestBindings).toEqual(['account-a', 'account-b']);
          expect(request).toHaveBeenCalledTimes(2);
          const stopping = composed.runtime.adapter.stop({
            sessionId: composed.controlSessionId,
          });
          releaseSecondResourcePreparation.resolve();
          await Promise.all([secondStart, stopping]);
        }

        expect(browser.micSession.ensureActive).toHaveBeenCalledTimes(nextBinding === null ? 1 : 2);
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

  describe(CONNECTED_ACCOUNT_CREDENTIAL_SUITE, () => {
    it.each([
      ['switches', 'account-b' as string | null],
      ['deletes', null],
    ] as const)(
      'keeps the exact minted OpenAI authority when its Connected Account %s during a forced reconnect and applies the change only to the next Start',
      async (_change, nextBinding) => {
        await environment.installConnectedAccountSettings();
        await environment.selectConnectedAccount('account-a');
        let binding: string | null = 'account-a';
        const requestBindings: Array<string | null> = [];
        const request = vi.fn(async (packet: Parameters<OpenAiMintTransport>[0]) => {
          const admittedBinding = readMintRequestAccount(packet);
          requestBindings.push(admittedBinding);
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
        const releaseNextOffer = createDeferredVoid();
        let peerNumber = 0;
        const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => {
          peerNumber += 1;
          if (peerNumber === 3) peer.createOffer.mockImplementation(async () => {
            await releaseNextOffer.promise;
            return { type: 'offer', sdp: 'v=0\r\na=next-attempt-offer\r\n' };
          });
        } });
        const composed = await environment.createRuntime(browser, {
          respondToDaemonAccountOperation: request,
        });

        try {
          const firstStart = composed.runtime.adapter.start({
            sessionId: '',
            requestedTargetSessionAddress: null,
            initialContext: '',
          });
          await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
            browser.peer.createDataChannel,
          ).toHaveBeenCalledWith('oai-events'));
          browser.peer.channel.open();
          await firstStart;
          const firstPeer = browser.peer;
          const firstTrack = browser.micTrack;
          const firstStream = browser.micStream;

          expect(requestBindings).toEqual(['account-a']);
          expect(callAuthorizations).toEqual(['Bearer ek_account-a']);
          binding = nextBinding;
          await environment.selectConnectedAccount(binding);
          const reconnect = composed.requestReconnect();
          await Promise.resolve(browser.peerCreated(1)).then(() => expect(browser.peers).toHaveLength(2));
          const reconnectPeer = browser.peers[1]!;
          await Promise.resolve(reconnectPeer.dataChannelCreated).then(() => expect(
            reconnectPeer.createDataChannel,
          ).toHaveBeenCalledWith('oai-events'));
          expect(reconnectPeer).not.toBe(firstPeer);
          await reconnectPeer.remoteDescriptionSet;
          expect(reconnectPeer.channel).not.toBe(firstPeer.channel);
          expect(firstPeer.close).toHaveBeenCalledOnce();
          expect(requestBindings).toEqual(['account-a']);
          expect(callAuthorizations).toEqual([
            'Bearer ek_account-a',
            'Bearer ek_account-a',
          ]);
          reconnectPeer.channel.open();
          await expect(reconnect).resolves.toBe(true);
          await waitForTestEvent(composed.runtime.adapter.subscribe!, () => expect(
            composed.runtime.adapter.getSnapshot().status,
          ).toBe('connected'));

          await composed.runtime.adapter.stop({
            sessionId: composed.controlSessionId,
          });
          expect(firstTrack.readyState).toBe('ended');
          const nextStart = composed.runtime.adapter.start({
            sessionId: '',
            requestedTargetSessionAddress: null,
            initialContext: '',
          }).then(
            () => null,
            (error: unknown) => error,
          );
          if (nextBinding === null) {
            await expect(nextStart).resolves.toBeNull();
            expect(requestBindings).toEqual(['account-a']);
            expect(callAuthorizations).toEqual([
              'Bearer ek_account-a',
              'Bearer ek_account-a',
            ]);
            expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
              status: 'error',
              errorCode: 'provider_auth_invalid',
            });
          } else {
            await waitForTestEvent(environment.subscribeNetwork, () => expect(requestBindings).toEqual([
              'account-a',
              'account-b',
            ]));
            await Promise.resolve(browser.peerCreated(2)).then(() => expect(browser.peers).toHaveLength(3));
            expect(browser.micStream).not.toBe(firstStream);
            expect(browser.micTrack).not.toBe(firstTrack);
            expect(browser.micTrack.readyState).toBe('live');
            expect(requestBindings).toEqual(['account-a', 'account-b']);
            expect(callAuthorizations).toEqual([
              'Bearer ek_account-a',
              'Bearer ek_account-a',
            ]);
            const stopping = composed.runtime.adapter.stop({
              sessionId: composed.controlSessionId,
            });
            releaseNextOffer.resolve();
            await Promise.all([nextStart, stopping]);
          }
        } finally {
          releaseNextOffer.resolve();
          await composed.runtime.dispose();
          composed.hostLease.revoke();
          browser.restore();
        }
      },
    );

    it('fails typed before OpenAI signaling when admitted auth expires during offer creation and requires a new Start', async () => {
      const initialNow = 1_800_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
      await environment.selectConnectedAccount('account-a');
      let binding = 'account-a';
      const requestBindings: string[] = [];
      const request = vi.fn(async (packet: Parameters<OpenAiMintTransport>[0]) => {
        const admittedBinding = readMintRequestAccount(packet);
        requestBindings.push(admittedBinding);
        return Object.freeze({
          status: 200,
          finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: Object.freeze({}),
          body: new TextEncoder().encode(JSON.stringify(
            createOpenAiClientAuthProviderResponse(
              `ek_${admittedBinding}`,
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
      let resolveNextOffer!: (offer: { type: 'offer'; sdp: string }) => void;
      const nextOffer = new Promise<{ type: 'offer'; sdp: string }>((resolve) => {
        resolveNextOffer = resolve;
      });
      let offerNumber = 0;
      const offerEntered = createDeferredVoid();
      const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => {
        offerNumber += 1;
        const offer = offerNumber === 1 ? delayedOffer : nextOffer;
        peer.createOffer.mockImplementation(async () => { offerEntered.resolve(); return await offer; });
      } });
      const composed = await environment.createRuntime(browser, {
        respondToDaemonAccountOperation: request,
      });

      try {
        const firstStart = composed.runtime.adapter.start({
          sessionId: '',
          requestedTargetSessionAddress: null,
          initialContext: '',
        });
        await offerEntered.promise;
        expect(browser.peer.createOffer).toHaveBeenCalledTimes(1);
        const failedPeer = browser.peer;
        const failedStream = browser.micStream;
        const failedTrack = browser.micTrack;
        expect(requestBindings).toEqual(['account-a']);
        expect(callAuthorizations).toEqual([]);

        binding = 'account-b';
        await environment.selectConnectedAccount(binding);
        nowSpy.mockReturnValue(initialNow + 59_500);
        browser.peer.channel.open();
        resolveOffer({ type: 'offer', sdp: 'v=0\r\na=delayed-offer\r\n' });

        await expect(firstStart).rejects.toMatchObject({ code: 'voice_auth_expired' });
        expect(failedPeer.close).toHaveBeenCalledOnce();
        expect(failedTrack.readyState).toBe('ended');
        expect(requestBindings).toEqual(['account-a']);
        expect(callAuthorizations).toEqual([]);
        expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
          status: 'error',
          errorCode: 'voice_auth_expired',
        });

        const nextStart = composed.runtime.adapter.start({
          sessionId: '',
          requestedTargetSessionAddress: null,
          initialContext: '',
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await waitForTestEvent(environment.subscribeNetwork, () => expect(requestBindings).toEqual([
          'account-a',
          'account-b',
        ]));
        await Promise.resolve(browser.peerCreated(1)).then(() => expect(browser.peers).toHaveLength(2));
        expect(browser.peer).not.toBe(failedPeer);
        expect(browser.peer.channel).not.toBe(failedPeer.channel);
        expect(browser.micStream).not.toBe(failedStream);
        expect(browser.micTrack).not.toBe(failedTrack);
        expect(browser.micTrack.readyState).toBe('live');
        expect(requestBindings).toEqual(['account-a', 'account-b']);
        expect(callAuthorizations).toEqual([]);
        const stopping = composed.runtime.adapter.stop({
          sessionId: composed.controlSessionId,
        });
        resolveNextOffer({ type: 'offer', sdp: 'v=0\r\na=cancelled-next-offer\r\n' });
        await Promise.all([nextStart, stopping]);
      } finally {
        resolveNextOffer({ type: 'offer', sdp: 'v=0\r\na=cleanup-next-offer\r\n' });
        await composed.runtime.dispose();
        composed.hostLease.revoke();
        browser.restore();
      }
    });
  });

  it('persists both finals of a turn whose payloads carry fields the adapter never reads', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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

      await waitForTestEvent(storage.subscribe, () => expect(
        readCanonicalVoiceTranscriptSnapshot(binding!.conversationSessionId),
      ).toEqual([
        expect.objectContaining({ role: 'user', text: 'hello, please reply out loud' }),
        expect.objectContaining({ role: 'assistant', text: 'voice canary alpha seven confirmed' }),
      ]));

      await waitForTestEvent(storage.subscribe, () => {
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

  it.each(['manual', 'server_vad'] as const)('submits captured input only for the admitted %s turn mode without ending Voice', async (turnDetection) => {
    const browser = installVoiceWebRtcBrowserBoundary();
    storage.setState((current) => {
      const voice = voiceSettingsParse(current.settings.voiceSettingsV1);
      const providerId = openAiEntry().providerId;
      const selected = voice.providers[providerId]!;
      const config = selected.config as Readonly<Record<string, unknown>>;
      const updatedVoice = { ...voice, providers: { ...voice.providers, [providerId]: {
        ...selected, config: { ...config, turnDetection },
      } } };
      return { ...current, settings: { ...current.settings, voiceSettingsV1: updatedVoice,
        voice: { ...updatedVoice, credentialBindings: current.settings.voice.credentialBindings } } };
    });
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;
      expect(composed.runtime.adapter.getSnapshot().canCommitInput).toBe(turnDetection === 'manual');
      const sentBefore = browser.peer.channel.sent.length;
      await composed.runtime.adapter.commitInput?.({ sessionId: composed.controlSessionId });
      const submitted = browser.peer.channel.sent.slice(sentBefore).map((value) => JSON.parse(value));
      expect(submitted).toEqual(turnDetection === 'manual'
        ? [{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }]
        : []);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(browser.micSession.teardown).not.toHaveBeenCalled();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it.each([false, true])('temporarily opens held capture and restores prior user Mute (%s)', async (userMuted) => {
    const browser = installVoiceWebRtcBrowserBoundary();
    storage.setState((current) => {
      const voice = voiceSettingsParse(current.settings.voiceSettingsV1);
      const providerId = openAiEntry().providerId;
      const selected = voice.providers[providerId]!;
      const updatedVoice = { ...voice, providers: { ...voice.providers, [providerId]: {
        ...selected, config: { ...selected.config as Readonly<Record<string, unknown>>, turnDetection: 'manual' },
      } } };
      return { ...current, settings: { ...current.settings, voiceSettingsV1: updatedVoice,
        voice: { ...updatedVoice, credentialBindings: current.settings.voice.credentialBindings } } };
    });
    const composed = await environment.createRuntime(browser);
    let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController> | null = null;
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalled());
      browser.peer.channel.open();
      await starting;
      await composed.runtime.adapter.setMuted({ sessionId: composed.controlSessionId, muted: userMuted });
      expect(composed.runtime.adapter.getSnapshot().canHoldToTalk).toBe(true);
      const send = browser.peer.channel.send.bind(browser.peer.channel);
      browser.peer.channel.send = (value: string) => {
        const event = JSON.parse(value);
        if (event.type === 'input_audio_buffer.clear' || event.type === 'input_audio_buffer.commit') {
          expect(browser.micTrack.enabled).toBe(false);
        }
        if (event.type === 'input_audio_buffer.commit') {
          expect(browser.micSession.setMuted).toHaveBeenLastCalledWith(true);
        }
        send(value);
      };
      const sentBefore = browser.peer.channel.sent.length;
      const held = composed.runtime.adapter.beginHoldToTalk?.({ sessionId: composed.controlSessionId });
      expect(held).toBeTruthy();
      expect(await held!.ready).toBe(true);
      expect(browser.micSession.setMuted).toHaveBeenLastCalledWith(false);
      expect(composed.runtime.adapter.getSnapshot().micMuted ?? false).toBe(userMuted);
      await held!.release();
      await held!.release();
      expect(browser.micSession.setMuted).toHaveBeenLastCalledWith(userMuted);
      expect(composed.runtime.adapter.getSnapshot().micMuted ?? false).toBe(userMuted);
      expect(browser.peer.channel.sent.slice(sentBefore).map((value) => JSON.parse(value))).toEqual([
        { type: 'input_audio_buffer.clear' }, { type: 'input_audio_buffer.commit' }, { type: 'response.create' },
      ]);
      if (userMuted) {
        lifecycle = createVoiceSessionLifecycleController({ getRegistry: getVoiceAdapterRegistry });
        lifecycle.setConfiguredProviderId(composed.runtime.adapter.id);
        const nextHold = composed.runtime.adapter.beginHoldToTalk?.({ sessionId: composed.controlSessionId });
        expect(await nextHold!.ready).toBe(true);
        const suspension = await lifecycle.suspendInput(composed.controlSessionId);
        expect(suspension).not.toBeNull();
        await nextHold!.release();
        expect(browser.peer.channel.sent.filter((value) => JSON.parse(value).type === 'input_audio_buffer.commit')).toHaveLength(1);
        expect(browser.micTrack.enabled).toBe(false);
        await suspension!.release();
      }
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      await lifecycle?.dispose();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it.each(['cancel', 'stale', 'early_release', 'stopped', 'pending_capture', 'reconnected'] as const)(
    'retires held capture without committing a cancelled turn through the real owner (%s)', async (outcome) => {
      const browser = installVoiceWebRtcBrowserBoundary();
      storage.setState(current => {
        const voice = voiceSettingsParse(current.settings.voiceSettingsV1);
        const providerId = openAiEntry().providerId;
        const selected = voice.providers[providerId]!;
        const updated = { ...voice, providers: { ...voice.providers, [providerId]: {
          ...selected, config: { ...selected.config as Readonly<Record<string, unknown>>, turnDetection: 'manual' },
        } } };
        return { ...current, settings: { ...current.settings, voiceSettingsV1: updated,
          voice: { ...updated, credentialBindings: current.settings.voice.credentialBindings } } };
      });
      const composed = await environment.createRuntime(browser);
      const captureOpening = createDeferredVoid();
      try {
        const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
        await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
        browser.peer.channel.open();
        await starting;
        await composed.runtime.adapter.setMuted({ sessionId: composed.controlSessionId, muted: true });
        const attemptPeer = browser.peer;
        const attemptTrack = browser.micTrack;
        expect(attemptTrack.enabled).toBe(false);
        const sentBefore = attemptPeer.channel.sent.length;

        if (outcome === 'pending_capture') {
          // Observe the physical track write without replacing WebMicSession.
          // Release runs in the following browser microtask, before the real
          // async hold-admission operation has acknowledged capture readiness.
          let enabled = attemptTrack.enabled;
          Object.defineProperty(attemptTrack, 'enabled', {
            configurable: true,
            get: () => enabled,
            set: (value: boolean) => { enabled = value; if (value) captureOpening.resolve(); },
          });
        }
        if (outcome === 'early_release') {
          attemptPeer.channel.bufferedAmount = VOICE_WEBRTC_LIMITS.outboundBufferedBytes;
        }
        const held = composed.runtime.adapter.beginHoldToTalk?.({ sessionId: composed.controlSessionId });
        expect(held).toBeTruthy();
        if (outcome === 'early_release') {
          await waitForTestEvent(attemptPeer.channel.subscribe, () => expect(attemptPeer.channel.bufferedAmountLowThreshold).toBeGreaterThan(0));
          const release = held!.release();
          attemptPeer.channel.drainTo(0);
          await release;
          expect(await held!.ready).toBe(false);
        } else if (outcome === 'pending_capture') {
          await captureOpening.promise;
          await held!.release();
          expect(await held!.ready).toBe(false);
        } else {
          expect(await held!.ready).toBe(true);
          expect(attemptTrack.enabled).toBe(true);
          if (outcome === 'cancel') await held!.cancel();
          if (outcome === 'stale') {
            storage.setState(current => {
              const voice = voiceSettingsParse(current.settings.voiceSettingsV1);
              const updated = { ...voice, providerId: null };
              return { ...current, settings: { ...current.settings, voiceSettingsV1: updated,
                voice: { ...updated, credentialBindings: current.settings.voice.credentialBindings } } };
            });
          }
          if (outcome === 'stopped') await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
          if (outcome === 'reconnected') {
            const reconnect = composed.requestReconnect();
            await Promise.resolve(browser.peerCreated(1)).then(() => expect(browser.peers).toHaveLength(2));
            const reconnectPeer = browser.peers[1]!;
            await Promise.resolve(reconnectPeer.dataChannelCreated).then(() => expect(reconnectPeer.createDataChannel).toHaveBeenCalledWith('oai-events'));
            expect(reconnectPeer).not.toBe(attemptPeer);
            expect(reconnectPeer.channel).not.toBe(attemptPeer.channel);
            reconnectPeer.channel.open();
            await expect(reconnect).resolves.toBe(true);
          }
          await held!.release();
        }
        await held!.release();
        await held!.cancel();
        const heldControls = attemptPeer.channel.sent.slice(sentBefore).map(value => JSON.parse(value));
        expect(heldControls.length).toBeGreaterThanOrEqual(1);
        expect(heldControls.every(event => event.type === 'input_audio_buffer.clear')).toBe(true);
        expect(browser.peers.slice(1).flatMap(peer => peer.channel.sent).map(value => JSON.parse(value)).filter(event => (
          event.type === 'input_audio_buffer.commit' || event.type === 'response.create'
        ))).toEqual([]);
        if (outcome === 'stopped') {
          expect(browser.micSession.getStream()).toBeNull();
          // MediaStreamTrack.stop ends capture; its enabled flag may remain
          // true and is not an activity oracle once the owning stream is gone.
          expect(attemptTrack.stop).toHaveBeenCalledOnce();
          expect(attemptTrack.readyState).toBe('ended');
          expect(attemptPeer.close).toHaveBeenCalledOnce();
        } else {
          expect(attemptTrack.enabled).toBe(false);
          expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
          expect(browser.micSession.getStream()).not.toBeNull();
          expect(browser.peer.channel.readyState).toBe('open');
        }
      } finally {
        browser.peers.forEach(peer => peer.channel.drainTo(0));
        await composed.runtime.dispose();
        composed.hostLease.revoke();
        browser.restore();
      }
    },
  );

  it('transcribes and answers a committed user turn taken while the assistant is idle', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
      await waitForTestEvent(browser.peer.channel.subscribe, () => expect(browser.peer.channel.sent.map(
        (value) => (JSON.parse(value) as Readonly<{ type?: unknown }>).type,
      )).toContain('response.create'));
      expect(browser.peer.channel.sent.filter(
        (value) => (JSON.parse(value) as Readonly<{ type?: unknown }>).type === 'response.create',
      )).toHaveLength(1);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('persists every final of a live-shaped OpenAI session across two turns', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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

      await waitForTestEvent(storage.subscribe, () => expect(
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

      await waitForTestEvent(storage.subscribe, () => expect(readStoredSessionMessages(
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
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
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
    const composed = await environment.createRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
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
    const composed = await environment.createRuntime(browser, {
      readPlaybackCursorMs: () => 250,
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      const cancellationSent = createDeferredVoid();
      const send = browser.peer.channel.send.bind(browser.peer.channel);
      vi.spyOn(browser.peer.channel, 'send').mockImplementation(value => {
        send(value);
        if ((JSON.parse(value) as Readonly<{ type?: unknown }>).type === 'response.cancel') {
          cancellationSent.resolve();
        }
      });
      browser.peer.channel.message(JSON.stringify({
        type: 'output_audio_buffer.started',
        event_id: 'interrupted-audio-started',
        response_id: 'interrupted-response',
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

      await cancellationSent.promise;
      expect(
        browser.peer.channel.sent.some((value) => (
          (JSON.parse(value) as Readonly<{ type?: unknown }>).type === 'response.cancel'
        )),
      ).toBe(true);
      expect(readStoredSessionMessages(
        storage.getState(),
        OPENAI_HISTORY_SESSION_ID,
      )).toEqual([]);

      releaseAssistantWrite.resolve();
      await waitForTestEvent(storage.subscribe, () => expect(
        readStoredSessionMessages(
          storage.getState(),
          OPENAI_HISTORY_SESSION_ID,
        ),
      ).toHaveLength(2));
      await waitForTestEvent(storage.subscribe, () => expect(selectVoiceTranscriptEntriesForConversationSession(
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

  it('clears the active carrier without ending the retained Voice attempt', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
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
      retireLocalSession: (sessionId) =>
        storage.getState().deleteSession(sessionId),
      runCarrierOperation: runVoiceTranscriptHistoryCarrierOperation,
      now: () => new Date('2026-07-29T12:34:56.000Z'),
    });

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      await consumer.open();
      await expect(consumer.clear()).resolves.toEqual({ cleared: true });
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )?.conversationSessionId).toBe(OPENAI_HISTORY_SESSION_ID);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID])
        .toBeUndefined();

      await composed.runtime.adapter.stop({
        sessionId: composed.controlSessionId,
      });
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('lets a cross-device carrier deletion win without ending Voice and binds only later finals to a recreated carrier', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
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
    const ensureHistorySession = vi.fn(async (init: RequestInit) => {
        rebindStarted.resolve();
        await releaseRebind.promise;
        return sessionHttp.createSessionFromPost(recreatedSessionId, init);
      });
    environment.historySessionPost = ensureHistorySession;

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
      await waitForTestEvent(storage.subscribe, () => expect(
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
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
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
        serverId: null,
        deleteSession: (sessionId, serverId) => storage.getState().deleteSession(sessionId, serverId),
        removeSessionEncryption: vi.fn(),
        removeProjectManagerSession: vi.fn(),
        clearScmStatusForSession: vi.fn(),
        log: { log: vi.fn() },
      });

      sessionHttp.replaceSession(OPENAI_HISTORY_SESSION_ID);
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

      await waitForTestEvent(environment.subscribeNetwork, () => expect(ensureHistorySession).toHaveBeenCalledTimes(1));
      await waitForTestEvent(voiceSessionBindingStore.subscribe, () => expect(
        voiceSessionBindingStore.getState().getByControlSessionId(
          composed.controlSessionId,
        )?.conversationSessionId,
      ).toBe(recreatedSessionId));
      await waitForTestEvent(storage.subscribe, () => expect(
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

  it('drains an admitted final through End Voice without leaving its recreated carrier bound', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const recreatedSessionId = 'voice-history-openai-stop-during-rebind';
    const recreatedTranscriptMessageUrl = transcriptMessageUrl(recreatedSessionId);
    const ensureStarted = createDeferredVoid();
    const releaseEnsure = createDeferredVoid();
    environment.historySessionPost = async (init: RequestInit) => {
      ensureStarted.resolve();
      await releaseEnsure.promise;
      return sessionHttp.createSessionFromPost(recreatedSessionId, init);
    };

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      handleDeleteSessionSocketUpdate({
        sessionId: OPENAI_HISTORY_SESSION_ID,
        serverId: null,
        deleteSession: (sessionId, serverId) => storage.getState().deleteSession(sessionId, serverId),
        removeSessionEncryption: vi.fn(),
        removeProjectManagerSession: vi.fn(),
        clearScmStatusForSession: vi.fn(),
        log: { log: vi.fn() },
      });
      sessionHttp.replaceSession(OPENAI_HISTORY_SESSION_ID);
      allowedTranscriptMessageUrls.add(recreatedTranscriptMessageUrl);
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'cross-device-stop-race-final',
        item_id: 'cross-device-stop-race-final',
        content_index: 0,
        transcript: 'drain through End Voice',
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
      await waitForTestEvent(storage.subscribe, () => expect(
        storage.getState().sessions[recreatedSessionId],
      ).toBeDefined());

      await waitForTestEvent(storage.subscribe, () => expect(readStoredSessionMessages(
        storage.getState(),
        recreatedSessionId,
      )).toEqual([
        expect.objectContaining({
          kind: 'user-text',
          text: 'drain through End Voice',
        }),
      ]));
      expect(transcriptRequest.mock.calls.filter(
        ([input]) => String(input) === recreatedTranscriptMessageUrl,
      )).toHaveLength(1);
      expect(transcriptRequest.mock.calls.filter(
        ([input]) => String(input) === transcriptMessageUrl(OPENAI_HISTORY_SESSION_ID),
      )).toHaveLength(0);
      expect(storage.getState().sessions[OPENAI_HISTORY_SESSION_ID]).toBeUndefined();
      expect(storage.getState().sessionMessages[OPENAI_HISTORY_SESSION_ID]).toBeUndefined();
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        composed.controlSessionId,
      )).toBeNull();
      expect(voiceSessionBindingStore.getState().getByConversationSessionId(
        recreatedSessionId,
      )).toBeNull();
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

  it('persists a final and its correction in order when both arrive before typed-turn acceptance', async () => {
    const carrierId = 'voice-history-openai-typed-barrier-final-correction';
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [carrierId]: createSessionFixture({
          id: carrierId,
          serverId: getActiveServerSnapshot().serverId,
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
    allowedTranscriptMessageUrls.add(transcriptMessageUrl(carrierId));
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser, {
      initialConversationSessionId: carrierId,
    });
    const acceptanceStarted = createDeferredVoid();
    const releaseAcceptance = createDeferredVoid();
    let typedTurn: Promise<void> | null = null;

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      typedTurn = composed.runtime.adapter.sendTextTurn!({
        controlSessionId: composed.controlSessionId,
        conversationSessionId: carrierId,
        text: 'hold final and correction until accepted',
        localId: 'typed-barrier-final-correction',
        deliveryCommand: 'interrupt_and_send',
        onAccepted: async () => {
          acceptanceStarted.resolve();
          await releaseAcceptance.promise;
        },
      });
      await acceptanceStarted.promise;

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-chain-final',
        item_id: 'typed-chain-item',
        content_index: 0,
        transcript: 'provider final A',
        usage: { type: 'duration', seconds: 1 },
      }));
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-chain-correction',
        item_id: 'typed-chain-item',
        content_index: 0,
        transcript: 'provider corrected B before acceptance',
        usage: { type: 'duration', seconds: 1 },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(transcriptRequest.mock.calls.filter(
        ([input]) => String(input) === transcriptMessageUrl(carrierId),
      )).toHaveLength(0);

      releaseAcceptance.resolve();
      await typedTurn;
      await waitForTestEvent(environment.subscribeNetwork, () => expect(transcriptRequest.mock.calls.filter(
        ([input]) => String(input) === transcriptMessageUrl(carrierId),
      )).toHaveLength(2));
      const writes = transcriptRequest.mock.calls
        .filter(([input]) => String(input) === transcriptMessageUrl(carrierId))
        .map(([, init]) => JSON.parse(String(init?.body)) as Readonly<{
          content: Readonly<{
            t: 'plain';
            v: Readonly<{ content: Readonly<{ text: string }> }>;
          }>;
        }>);
      expect(writes.map((write) => write.content.v.content.text)).toEqual([
        'provider final A',
        'provider corrected B before acceptance',
      ]);
      expect(readCanonicalVoiceTranscriptSnapshot(carrierId)).toEqual([
        expect.objectContaining({
          itemId: 'typed-chain-item',
          text: 'provider corrected B before acceptance',
          revision: 2,
          corrected: true,
        }),
      ]);
    } finally {
      releaseAcceptance.resolve();
      await typedTurn?.catch(() => {});
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId }).catch(() => {});
      await composed.runtime.dispose().catch(() => {});
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('surfaces a real offline Home transcript refusal through the existing failure owner', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;

      const home = getActiveServerSnapshot();
      const beforeRows = readStoredSessionMessages(storage.getState(), OPENAI_HISTORY_SESSION_ID);
      const beforeLogs = log.getCount();
      const beforeWrites = transcriptRequest.mock.calls.length;
      // A genuine HTTP transport failure drives the real supervisor/storage
      // projection; neither scoped admission nor transcript persistence is mocked.
      setRuntimeFetch(async () => { throw new TypeError('offline Home boundary'); });
      await expect(runtimeFetchWithServerReachability({
        serverUrl: home.serverUrl,
        token: accountConnection!.credentials.token,
        url: `${home.serverUrl}/v1/artifacts`,
        init: { method: 'GET' },
      })).rejects.toThrow('offline Home boundary');
      await waitForTestEvent(storage.subscribe, () => expect(storage.getState().endpointStatus).toBe('offline'));

      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'offline-final',
        item_id: 'offline-final',
        content_index: 0,
        transcript: 'private offline words',
        usage: { type: 'duration', seconds: 1 },
      }));
      await waitForTestEvent(notify => log.onChange(notify), () => {
        const failures = log.getLogs().slice(beforeLogs)
          .filter(line => line.startsWith('[voiceRuntimeFailure] '))
          .map(line => JSON.parse(line.slice('[voiceRuntimeFailure] '.length)) as unknown);
        expect(failures).toContainEqual(expect.objectContaining({
          outcome: 'transcript_dropped',
          kind: 'transcript_persist_failed',
        }));
      });
      expect(log.getLogs().slice(beforeLogs).join('\n')).not.toContain('private offline words');
      expect(transcriptRequest.mock.calls.length).toBe(beforeWrites);
      expect(readStoredSessionMessages(storage.getState(), OPENAI_HISTORY_SESSION_ID)).toEqual(beforeRows);
    } finally {
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId }).catch(() => {});
      await composed.runtime.dispose().catch(() => {});
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
          serverId: getActiveServerSnapshot().serverId,
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
    const composed = await environment.createRuntime(browser, {
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
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
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
      // Concurrent Sync domain reads must be HTTP responses, not synthetic
      // network failures that revoke this fixture Home's transcript admission.
      const home = getActiveServerSnapshot();
      const response = await runtimeFetchWithServerReachability({
        serverUrl: home.serverUrl,
        token: accountConnection!.credentials.token,
        url: `${home.serverUrl}/v1/artifacts`,
        init: { method: 'GET' },
      });
      expect(response.status).toBe(404);
      const starting = composed.runtime.adapter.start({
        sessionId: '',
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
      vi.stubGlobal('window', Object.freeze({}));
      vi.stubGlobal('document', Object.freeze({}));
      vi.spyOn(realtimeMicSession, 'createRealtimeMicSession')
        .mockImplementation(replacementBrowser.createMicSession);
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
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(replacementBrowser!.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        replacementBrowser!.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      const replacementPeer = replacementBrowser.peer;
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
      await aWriteStarted.promise;
      expect(transcriptWrites).toHaveLength(1);

      replacementPeer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'typed-barrier-b-final',
        item_id: 'typed-barrier-b-final',
        content_index: 0,
        transcript: 'persist B final once',
        usage: { type: 'duration', seconds: 1 },
      }));
      await waitForTestEvent(environment.subscribeNetwork, () => expect(transcriptWrites).toHaveLength(2));

      let oldDisposalSettled = false;
      const oldDisposal = composed.runtime.dispose().then(() => {
        oldDisposalSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(oldDisposalSettled).toBe(false);

      releaseAWrite.resolve();
      await oldDisposal;
      await waitForTestEvent(storage.subscribe, () => expect(readStoredSessionMessages(
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
          serverId: getActiveServerSnapshot().serverId,
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
    const composed = await environment.createRuntime(browser, {
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
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
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
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
      await waitForTestEvent(environment.subscribeNetwork, () => expect(transcriptWrites).toHaveLength(1));
      await waitForTestEvent(storage.subscribe, () => expect(readStoredSessionMessages(
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
      vi.stubGlobal('window', Object.freeze({}));
      vi.stubGlobal('document', Object.freeze({}));
      vi.spyOn(realtimeMicSession, 'createRealtimeMicSession')
        .mockImplementation(replacementBrowser.createMicSession);
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
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(replacementBrowser!.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        replacementBrowser!.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      const replacementPeer = replacementBrowser.peer;
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
      await waitForTestEvent(environment.subscribeNetwork, () => expect(transcriptWrites).toHaveLength(2));
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
      await waitForTestEvent(storage.subscribe, () => {
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
    const composed = await environment.createRuntime(browser);
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

    environment.historySessionPost = async (init: RequestInit) => {
      carrierEnsureStarted.resolve();
      await releaseCarrierEnsure.promise;
      return sessionHttp.createSessionFromPost(recreatedCarrierId, init);
    };
    transcriptRequest.mockImplementation(async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const homeResponse = await homeRequest(input, init);
      if (homeResponse) return homeResponse;
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
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
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
        serverId: null,
        deleteSession: (sessionId, serverId) => storage.getState().deleteSession(sessionId, serverId),
        removeSessionEncryption: vi.fn(),
        removeProjectManagerSession: vi.fn(),
        clearScmStatusForSession: vi.fn(),
        log: { log: vi.fn() },
      });
      sessionHttp.replaceSession(OPENAI_HISTORY_SESSION_ID);
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
        .mockImplementation(replacementBrowser.createMicSession);
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
        requestedTargetSessionAddress: null,
        initialContext: '',
      });
      expect(replacementBrowser.peers).toEqual([]);
      releaseCarrierEnsure.resolve();
      await persistenceStarted.promise;
      await Promise.resolve(replacementBrowser!.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        replacementBrowser!.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      const replacementPeer = replacementBrowser.peer;
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
      await waitForTestEvent(environment.subscribeNetwork, () => expect(transcriptWrites).toHaveLength(2));
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
      await waitForTestEvent(storage.subscribe, () => expect(readStoredSessionMessages(
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
    const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => {
      setBufferedAmount(peer.channel, VOICE_WEBRTC_LIMITS.outboundBufferedBytes);
    } });
    const composed = await environment.createRuntime(browser);

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(
        browser.peer.createDataChannel,
      ).toHaveBeenCalledWith('oai-events'));
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connecting');

      browser.peer.channel.open();
      await waitForTestEvent(browser.peer.channel.subscribe, () => expect(
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
      const update = browser.peer.channel.sent.find((frame) => JSON.parse(frame).type === 'session.update');
      if (!update) throw new Error('Expected accepted OpenAI tool catalog');
      expect(new TextEncoder().encode(update).byteLength).toBeLessThanOrEqual(VOICE_WEBRTC_LIMITS.outboundControlBytes);
      const { parameters: { body: { session: { instructions } } } } = z.object({
        parameters: z.object({ body: z.object({ session: z.object({ instructions: z.string().check(z.minLength(1)) }) }) }),
      }).parse(composed.requestAccountOperation.mock.calls[0]?.[0]);
      const { session: { tools } } = z.object({ session: z.object({ tools: z.array(z.looseObject({ name: z.string() })) }) }).parse(JSON.parse(update));
      // OpenAI's published instructions + tools ceiling is 16,384 tokens:
      // https://developers.openai.com/blog/realtime-api#long-conversations-and-context-handling
      // Reserve a quarter for provider framing, user instructions and context.
      // These two real encodings are regression measurements, not a claim
      // that OpenAI exposes gpt-realtime's internal schema tokenization.
      const budgetWithHeadroom = 16_384 * 0.75;
      const measurements = (['o200k_base', 'cl100k_base'] as const).map((encoding) => {
        const tokenizer = getEncoding(encoding);
        const instructionTokens = tokenizer.encode(instructions).length;
        const toolTokens = tokenizer.encode(JSON.stringify(tools)).length;
        return { encoding, instructionTokens, toolTokens, combined: instructionTokens + toolTokens,
          tools: tools.map((tool) => ({ name: tool.name, tokens: tokenizer.encode(JSON.stringify(tool)).length })) };
      });
      console.info('OPENAI_DEFAULT_TOKEN_BUDGET', JSON.stringify({
        frameBytes: new TextEncoder().encode(update).byteLength, budgetWithHeadroom, measurements,
      }));
      for (const measurement of measurements) {
        expect(measurement.combined, measurement.encoding).toBeLessThanOrEqual(budgetWithHeadroom);
      }
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
    }
  });

  it('closes the peer and never publishes connected when session.update is rejected', async () => {
    const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => {
      vi.spyOn(peer.channel, 'send').mockImplementation(() => {
        throw new Error('data channel rejected session.update');
      });
    } });
    const composed = await environment.createRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
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
    const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => {
      setBufferedAmount(peer.channel, VOICE_WEBRTC_LIMITS.outboundBufferedBytes);
    } });
    const composed = await environment.createRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});

    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null, initialContext: '' });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1));
      browser.peer.channel.open();
      await waitForTestEvent(browser.peer.channel.subscribe, () => expect(
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
