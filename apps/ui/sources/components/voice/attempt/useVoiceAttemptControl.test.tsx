/** @vitest-environment jsdom */
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import * as React from 'react';
import { resolveHref } from 'expo-router/build/link/href';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  standardCleanup,
  renderHook,
  createDeferred,
  waitForTestEvent,
  createSessionMessagesFixture,
  createSessionFixture,
  createRootLayoutFeaturesResponse,
  flushHookEffects,
  type RenderHookResult,
} from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture, createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { renderScreen } from '@/dev/testkit';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { VOICE_SETTINGS_PROVIDER_FOCUS_TARGET } from '@/voice/settings/voiceSettingsRouteFocus';
import type {
  VoiceAdapterController,
  VoiceSessionSnapshot,
} from '@/voice/session/types';
import { t } from '@/text';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import 'fake-indexeddb/auto';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
  tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import {
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { settingsParse } from '@/sync/domains/settings/settings';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { PartialOptions } from '@elevenlabs/client';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { MetadataSchema } from '@happier-dev/session-core/state';

import type { VoiceAttemptIdleTarget } from './useVoiceAttemptControl';
import {
  DestinationInstanceHost,
  type DestinationNavigation,
} from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
installDisconnectedServerSocketBoundary();
// Platform crypto, vendor SDK and transport boundaries surround real Account,
// Home Artifact, Action, store, feature and admission owners.
vi.mock(
  '@more-tech/react-native-libsodium',
  () => import('libsodium-wrappers'),
);
vi.mock(
  '@/platform/cryptoRandom',
  () => import('@/platform/cryptoRandom.node'),
);
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));

const sdk = vi.hoisted(() => ({
  startSession:
    vi.fn<
      (
        options: PartialOptions,
      ) => Promise<{
        endSession: () => Promise<void>;
        setMicMuted: () => void;
        setVolume: () => void;
        sendUserMessage: () => void;
        sendContextualUpdate: () => void;
        getId: () => string;
      }>
    >(),
  endSession: vi.fn(async () => undefined),
}));
vi.mock('@elevenlabs/client', () => ({
  Conversation: { startSession: sdk.startSession },
}));
vi.mock('@elevenlabs/client/web', () => ({
  Conversation: { startSession: sdk.startSession },
}));
vi.mock('expo-audio', () => ({
  AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) },
}));
// Human confirmation is an external UI boundary; Action policy and execution stay real.
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      confirmResult: true,
    }).module,
);

const recoveryRuntime = {
  serverId: 'server-work',
  machineId: 'machine-work',
};

const platformState = vi.hoisted(() => ({
  os: 'web',
  openSettings: vi.fn(async () => undefined),
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    Linking: { ...actual.Linking, openSettings: platformState.openSettings },
    Platform: {
      ...actual.Platform,
      get OS() {
        return platformState.os;
      },
    },
  };
});

const routerMock = vi.hoisted(() => ({
  instance: null as ReturnType<
    (typeof import('@/dev/testkit/mocks/router'))['createExpoRouterMock']
  > | null,
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ pathname: () => '/' });
  routerMock.instance = mock;
  return mock.module;
});

const originalStorageState = getStorage().getState();
let initialStorageState = originalStorageState;
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let lifecycle:
  | ReturnType<
      (typeof import('@/voice/session/voiceSessionLifecycleController'))['createVoiceSessionLifecycleController']
    >
  | undefined;
let runtimeScreen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let projectionAdapters: readonly VoiceAdapterController[] = [];
let providerAssembly:
  | Awaited<ReturnType<
      (typeof import('@/dev/testkit/harness/builtinVoiceAdapters'))['createBuiltinVoiceAdapterAssembly']
    >>
  | undefined;
let sessionHttp: ReturnType<
  (typeof import('@/dev/testkit/harness/sessionMetadataHttpBoundary'))['createSessionMetadataHttpBoundary']
>;

async function installLifecycle() {
  // Runtime owns declaration readiness, activation, registration and retirement.
  await providerAssembly?.dispose();
  providerAssembly = undefined;
  const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
  runtimeScreen = await renderScreen(<VoiceSessionRuntime />);
  const { getVoiceSessionLifecycleController } =
    await import('@/voice/session/voiceSessionLifecycleControllerStore');
  lifecycle = getVoiceSessionLifecycleController() ?? undefined;
  if (!lifecycle) throw new Error('Mounted Voice lifecycle unavailable');
  const { resolveVoiceExecutionMachineSelectionFromState } = await import('@/voice/settings/executionMachine');
  expect(resolveVoiceExecutionMachineSelectionFromState(getStorage().getState())).toMatchObject({
    kind: 'resolved', machineId: recoveryRuntime.machineId,
  });
  return lifecycle;
}

async function startVoiceRuntime(target: SessionAddress | null) {
  const { voiceSessionManager } = await import('@/voice/session/voiceSession');
  await voiceSessionManager.toggle(target);
}

async function installElevenLabsLifecycle(
  target: SessionAddress | null = null,
) {
  const [
    { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES },
    { voiceConversationRuntimeMachine },
    { voiceSessionBindingStore },
    {
      buildVoiceTranscriptHistorySessionMetadata,
      VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
    },
    { TokenStorage },
  ] = await Promise.all([
    import('@/voice/registry/generatedBundledVoiceRuntimeEntries'),
    import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
    import('@/voice/binding/voiceConversationBindingStore'),
    import('@/voice/persistence/voiceTranscriptHistorySession'),
    import('@/auth/storage/tokenStorage'),
  ]);
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
    (value) => value.pluginId === 'happier.voice.elevenlabs',
  );
  if (!entry || !connection)
    throw new Error(
      'ElevenLabs fixture requires its declared adapter and Account',
    );
  // Retire the old global producer before installing this attempt's binding.
  await providerAssembly?.dispose();
  expect(await TokenStorage.getCredentials()).toEqual(connection.credentials);
  const { writeVoiceProviderSettingsConfig } =
    await import('@/sync/domains/settings/voiceSettings');
  seedVoiceSettings({
    ...writeVoiceProviderSettingsConfig(
      getStorage().getState().settings.voice,
      entry.providerId,
      ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    ),
    providerId: entry.providerId,
    ui: { activityFeedEnabled: false, scopeDefault: 'global' },
  });
  const metadata = {
    path: '/voice-history',
    host: 'test',
    ...buildVoiceTranscriptHistorySessionMetadata(),
  };
  const owner = createSessionOwnerMetadataV1({ metadata });
  if (!owner.ok)
    throw new Error('Voice History owner metadata was not admitted');
  const sharedMetadata = projectSessionSharedMetadataV1({
    metadata,
    agentState: null,
  });
  // Use the hosted producer, including its current strict display projection,
  // rather than rebuilding a tuple that drifts when the HTTP contract evolves.
  const { createSessionCreateOrLoad } =
    await import('@/sync/domains/session/hostedSystemSession');
  const created = await createSessionCreateOrLoad({
    credentials: connection.credentials,
    accountMode: 'plain',
    encryption: null,
    tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
    metadata,
    randomBytes: (length) => new Uint8Array(length),
    request: async (_path, init) =>
      sessionHttp.createSessionFromPost('attempt-history', init),
    assertCurrent() {},
  });
  // Hydrated state has the producer's actual revisions. A newer invented
  // fixture tuple correctly makes the real Retry hydration refuse this row.
  const conversation = createSessionFixture({
    id: created.session.id,
    serverId: recoveryRuntime.serverId,
    encryptionMode: 'plain',
    active: false,
    seq: created.session.seq,
    createdAt: created.session.createdAt,
    updatedAt: created.session.updatedAt,
    metadataVersion: created.session.metadataVersion,
    agentStateVersion: created.session.agentStateVersion,
    metadataLayoutVersion: 1,
    metadata: parseDecryptedSessionMetadata(sharedMetadata, 1),
    ownerMetadataView: MetadataSchema.parse(
      projectSessionOwnerCompatibilityViewV1({
        sharedMetadata,
        ownerMetadata: owner.ownerMetadata,
      }),
    ),
  });
  const targetSession = target
    ? createSessionFixture({
        id: target.sessionId,
        serverId: target.serverId,
        metadata: { path: '/repo', host: 'test', flavor: 'claude' },
      })
    : null;
  getStorage().setState((state) => ({
    sessions: {
      ...state.sessions,
      [conversation.id]: conversation,
      ...(targetSession ? { [targetSession.id]: targetSession } : {}),
    },
  }));
  voiceConversationRuntimeMachine.reset();
  voiceSessionBindingStore
    .getState()
    .bind({
      adapterId: entry.providerId,
      controlSessionId: target?.sessionId ?? VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: conversation.id,
      conversationSessionAddress: {
        serverId: recoveryRuntime.serverId,
        sessionId: conversation.id,
      },
      targetSessionAddress: target,
      lifetime: 'runtime_attempt',
      transcriptMode: 'synthetic',
      updatedAt: 1,
    });
  const controller = await installLifecycle();
  return { controller };
}

function setVoiceAgentFeature(enabled: boolean): void {
  getStorage().setState((state) => ({
    settings: {
      ...state.settings,
      experiments: true,
      featureToggles: {
        ...state.settings.featureToggles,
        voice: true,
        'execution.runs': true,
        'voice.agent': enabled,
      },
    },
  }));
}

async function restoreAttemptAccount(accountId = 'attempt-account') {
  const { loadSyncSingletonForTests } =
    await import('@/dev/testkit/harness/syncSingletonLoader');
  await loadSyncSingletonForTests();
  const features = createRootLayoutFeaturesResponse();
  if (!tryWriteServerEnabledBitInPlace(features, 'voice', true))
    throw new Error('Voice feature fixture unavailable');
  const { createSessionMetadataHttpBoundary } =
    await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
  sessionHttp = createSessionMetadataHttpBoundary(
    () => getStorage().getState().sessions,
  );
  const machine = createHydratedPlainMachineFixture({
    id: recoveryRuntime.machineId,
    accountId,
    machine: { activeAt: Date.now() },
  });
  publishMachineActivityForTest([machine]);
  const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId, machine });
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://voice-attempt.test',
    serverIdentityId: 'srv_voice_attempt_work',
    accountId,
    credentialScope: 'restored-home',
    activation: 'switch',
    request: createSessionReadBatchFetchBoundary(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/features') return Response.json(features);
      if (path === '/v1/machines') return Response.json([machineRow]);
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
        return createMachineReadBatchResponseFixture(init.body, id => id === machine.id ? machineRow : null);
      }
      if (path === `/v1/machines/${machine.id}`) return Response.json({ machine: machineRow });
      if (path === `/v1/machines/${machine.id}/access`) {
        return Response.json({ machineId: machine.id, custodian: machineRow.access!.custodian,
          access: machineRow.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
      }
      if (path.endsWith('/messages'))
        return Response.json(
          SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false }),
        );
      if (path === '/v1/sessions' && init?.method === 'POST')
        return sessionHttp.createSessionFromPost('attempt-history', init);
      const sessionResponse = sessionHttp.handle(url, init);
      if (sessionResponse) return sessionResponse;
      const preparation = answerVoiceRealtimePreparationHttpRequest(
        url,
        getStorage().getState().settings,
      );
      if (preparation) return preparation;
      if (path === '/v1/voice/token')
        return Response.json({
          allowed: true,
          token: 'hosted-token',
          leaseId: 'hosted-lease',
          bindingNonce: 'hosted-nonce',
          expiresAtMs: Date.now() + 60_000,
        });
      if (
        path === '/v1/voice/session/complete' ||
        path === '/v1/voice/session/release'
      )
        return Response.json({ ok: true });
      return null;
    }),
  });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  expect(await TokenStorage.getCredentials()).toEqual(connection.credentials);
  const { getActiveServerSnapshot } =
    await import('@/sync/domains/server/serverRuntime');
  // A profile can retain its URL alias after the active routing owner adopts
  // the advertised identity. Fresh Session fixtures use that routing owner.
  recoveryRuntime.serverId = getActiveServerSnapshot().serverId;
  primeServerFeaturesSnapshot({
    serverId: recoveryRuntime.serverId,
    snapshot: { status: 'ready', features },
  });
  const scope = {
    serverId: recoveryRuntime.serverId,
    accountId,
  };
  getStorage().setState({
    isDataReady: true,
    profileScope: scope,
    settingsScope: scope,
    settings: settingsParse({
      experiments: true,
      featureToggles: {
        voice: true,
        'execution.runs': true,
        'voice.agent': true,
      },
    }),
    machines: { [machine.id]: machine },
    machineListByServerId: { [scope.serverId]: [machine] },
  });
  // Account restoration hydrates settings asynchronously. Seed scenario
  // settings only after that authoritative first page has settled.
  await waitForTestEvent(getStorage().subscribe, getStorage().getState,
    (state) => state.settingsVersion !== null);
  initialStorageState = getStorage().getState();
  const { createBuiltinVoiceAdapterAssembly } =
    await import('@/dev/testkit/harness/builtinVoiceAdapters');
  providerAssembly = (await createBuiltinVoiceAdapterAssembly());
  projectionAdapters = providerAssembly.adapters;
  installConnectedAccountDescriptorProjection({
    scopeKey: scope.serverId,
    status: 'ready',
    descriptors: [],
    conflicts: [],
    errorReason: null,
  });
}

beforeEach(async () => {
  getStorage().setState(originalStorageState, true);
  const { resetVoiceSessionStoreForTests } =
    await import('@/voice/session/voiceSessionStore');
  resetVoiceSessionStoreForTests();
  platformState.os = 'web';
  platformState.openSettings.mockClear();
  sdk.endSession.mockReset().mockResolvedValue(undefined);
  sdk.startSession
    .mockReset()
    .mockResolvedValue({
      endSession: sdk.endSession,
      setMicMuted() {},
      setVolume() {},
      sendUserMessage() {},
      sendContextualUpdate() {},
      getId: () => 'provider-conversation',
    });
  webLocks = installWebLockManagerMock();
  await restoreAttemptAccount();
});

afterEach(async () => {
  await runtimeScreen?.unmount();
  runtimeScreen = undefined;
  standardCleanup();
  await lifecycle?.dispose();
  lifecycle = undefined;
  await providerAssembly?.dispose();
  providerAssembly = undefined;
  const { setVoiceSessionLifecycleController } =
    await import('@/voice/session/voiceSessionLifecycleControllerStore');
  setVoiceSessionLifecycleController(null);
  await connection?.dispose();
  connection = undefined;
  webLocks.restore();
});

/** Capability decisions come from the publicly activated provider, not a test copy. */
function getActivatedAdapter(id: string): VoiceAdapterController {
  const adapter = projectionAdapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`No activated provider for ${id}`);
  return adapter;
}

function seedVoiceSettings(voice: unknown): void {
  getStorage().setState((state) => ({
    isDataReady: true,
    settings: settingsParse({
      ...state.settings,
      ...normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({
        ...voiceSettingsParse(voice),
        executionMachine: {
          mode: 'fixed',
          machineId: recoveryRuntime.machineId,
        },
      }) }, state.settings),
    }),
  }));
}

/** The sidebar Horizon vessel's scope, so both owners are asked the same question. */
const GLOBAL_TARGET: VoiceAttemptIdleTarget = { kind: 'global' };

async function renderBothOwners() {
  const { useVoiceSurfaceModel } =
    await import('@/components/voice/surface/useVoiceSurfaceModel');
  const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
  return await renderHook(() => ({
    model: useVoiceSurfaceModel({ variant: 'sidebar' }),
    control: useVoiceAttemptControl(GLOBAL_TARGET),
  }));
}

/** Action navigation publishes resolved href strings through the real router boundary. */
function readLastPushedHref(): string {
  const href = routerMock.instance?.spies.push.mock.calls.at(-1)?.[0];
  if (typeof href !== 'string')
    throw new Error('Action navigation did not publish a resolved href');
  return href;
}

/**
 * §5.6 / the split-brain rule — start admission has exactly one owner, projected into Horizon and
 * the placement-free surfaces through the same attempt control. A second answer would offer a
 * Start the lifecycle owner refuses — a dead transport, which §2.2 forbids outright.
 *
 * `controlsDisabled` is the model's admission read through its public seam: with nothing running
 * (`canStop === false`) it is exactly `!canStart`.
 */
describe('useVoiceAttemptControl start admission', () => {
  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  afterEach(async () => {
    standardCleanup();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
  });

  it('does no capability or admission reprojection for unchanged parent renders and refreshes changed inputs', async () => {
    const adapterRegistry = await import('@/voice/session/voiceAdapterRegistry');
    const admissionOwner = await import('@/components/voice/surface/resolveVoiceStartAdmission');
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    adapterRegistry.registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    seedVoiceSettings({ providerId: 'local_conversation', providers: {
      local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
    } });
    // Observe real projection work without replacing either internal owner.
    const capabilities = vi.spyOn(adapterRegistry, 'resolveVoiceAdapterSurfaceCapabilities');
    const admission = vi.spyOn(admissionOwner, 'resolveVoiceStartAdmission');
    const hook = await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));
    try {
      expect(hook.getCurrent().canStart).toBe(true);
      capabilities.mockClear();
      admission.mockClear();
      for (let index = 0; index < 5; index++) await hook.rerender();
      expect(capabilities).toHaveBeenCalledTimes(0);
      expect(admission).toHaveBeenCalledTimes(0);

      await act(async () => setVoiceAgentFeature(false));
      expect(hook.getCurrent().canStart).toBe(false);
      expect(admission.mock.calls.length).toBeGreaterThan(0);
      expect(capabilities).toHaveBeenCalledTimes(0);

      await act(async () => setVoiceAgentFeature(true));
      expect(hook.getCurrent().canStart).toBe(true);
      platformState.os = 'unknown';
      await hook.rerender();
      expect(hook.getCurrent().canStart).toBe(false);
      expect(hook.getCurrent().startRefusal?.reason).toBe(t('voice.readiness.platform_unsupported'));
      platformState.os = 'web';
      await hook.rerender();
      expect(hook.getCurrent().canStart).toBe(true);
      expect(capabilities).toHaveBeenCalledTimes(0);

      adapterRegistry.registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
      await hook.rerender();
      expect(hook.getCurrent().canStart).toBe(true);
      expect(capabilities.mock.calls.length).toBeGreaterThan(0);

      capabilities.mockClear();
      admission.mockClear();
      await act(async () => seedVoiceSettings({ providerId: 'off' }));
      expect(hook.getCurrent().canStart).toBe(false);
      expect(capabilities.mock.calls.length).toBeGreaterThan(0);
      expect(admission.mock.calls.length).toBeGreaterThan(0);
    } finally {
      await hook.unmount();
      capabilities.mockRestore();
      admission.mockRestore();
    }
  });

  it('does not deliver Session writes to an unbound runtime carrier', async () => {
    const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
    const { useVoiceSetupConversationMessages } = await import('@/voice/settings/setup/useVoiceSetupItem');
    const address = { serverId: recoveryRuntime.serverId, sessionId: 'setup-conversation' };
    getStorage().setState(state => ({ sessions: {
      ...state.sessions, [address.sessionId]: createSessionFixture({ id: address.sessionId, serverId: address.serverId }),
    } }));
    const delivery = observeStorageSubscriptionDeliveries(paths => paths.length === 1
      && paths[0]?.[0] === 'state' && (paths[0]?.[1] === 'sessions' || paths[0]?.[1] === 'sessionMessages'));
    const runtime = await renderScreen(React.createElement(VoiceSessionRuntime));
    const initialProps: { conversation: SessionAddress | null } = { conversation: address };
    const setup = await renderHook(({ conversation }: { conversation: SessionAddress | null }) =>
      useVoiceSetupConversationMessages(conversation), { initialProps });
    try {
      delivery.reset();
      for (let index = 0; index < 5; index++) await act(async () => {
        getStorage().setState(state => ({
          sessions: { ...state.sessions, unrelated: createSessionFixture({ id: 'unrelated', seq: index }) },
          sessionMessages: { ...state.sessionMessages, unrelated: createSessionMessagesFixture() },
        }));
      });
      expect(delivery.count).toBe(0);
      await act(async () => { getStorage().setState(state => ({ sessions: {
        ...state.sessions, [address.sessionId]: { ...state.sessions[address.sessionId]!, seq: 42 },
      } })); });
      expect(delivery.count).toBeGreaterThan(0);
      expect(setup.getCurrent().sessionSeq).toBe(42);
      await setup.rerender({ conversation: null });
      delivery.reset();
      await act(async () => { getStorage().setState(state => ({ sessions: {
        ...state.sessions, [address.sessionId]: { ...state.sessions[address.sessionId]!, seq: 43 },
      } })); });
      expect(delivery.count).toBe(0);
      expect(setup.getCurrent().sessionSeq).toBeNull();
    } finally {
      await setup.unmount();
      await runtime.unmount();
      delivery.restore();
    }
  });

  it('projects the actual attempt voice without relabeling it from a changed Account selection', async () => {
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    const applied = {
      providerContributionId: 'happier.voice.openai/realtime',
      settingFieldPath: 'voice',
      value: 'coral',
      displayName: 'Coral',
    };
    const preparedInstructionsFor = {
      serverId: 'srv_attempt_home',
      sessionId: 'target-session',
    };
    setVoiceSessionSnapshot({
      adapterId: applied.providerContributionId,
      sessionId: 'target-session',
      status: 'connected',
      mode: 'listening',
      canStop: true,
      inUseVoice: applied,
      preparedInstructionsFor,
    });
    const hook = await renderBothOwners();
    expect(hook.getCurrent().control).toHaveProperty('inUseVoice', applied);
    expect(hook.getCurrent().control).toHaveProperty(
      'preparedInstructionsFor',
      preparedInstructionsFor,
    );
    await act(async () => seedVoiceSettings({ providerId: 'off' }));
    expect(hook.getCurrent().control).toHaveProperty('inUseVoice', applied);
    await act(async () =>
      setVoiceSessionSnapshot({
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      }),
    );
    expect(hook.getCurrent().control).toHaveProperty('inUseVoice', null);
    expect(hook.getCurrent().control).toHaveProperty(
      'preparedInstructionsFor',
      null,
    );
    await hook.unmount();
  });

  it('refuses a start the surface model refuses when the connected-services reference is missing', async () => {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([
      getActivatedAdapter('happier.agent.codex/realtime-codex'),
    ]);
    // Provider selected, but its connected-services reference was never chosen: the surface
    // keeps it visible for remediation and refuses the start.
    seedVoiceSettings({
      providerId: 'happier.agent.codex/realtime-codex',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
    });

    const hook = await renderBothOwners();
    const { model, control } = hook.getCurrent();

    expect(model).not.toBeNull();
    expect(model!.controlsDisabled).toBe(true);
    expect(control.canStart).toBe(false);

    await hook.unmount();
  });

  it('refuses a start the surface model refuses when the daemon voice agent is unavailable', async () => {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    setVoiceAgentFeature(false);
    seedVoiceSettings({
      providerId: 'local_conversation',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });

    const hook = await renderBothOwners();
    const { model, control } = hook.getCurrent();

    expect(model).not.toBeNull();
    expect(model!.controlsDisabled).toBe(true);
    expect(control.canStart).toBe(false);

    await hook.unmount();
  });

  it('admits the start both owners agree on', async () => {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    seedVoiceSettings({
      providerId: 'local_conversation',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });

    const hook = await renderBothOwners();
    const { model, control } = hook.getCurrent();

    expect(model).not.toBeNull();
    expect(model!.controlsDisabled).toBe(false);
    expect(control.canStart).toBe(true);
    expect(control.availability).toBe('ready');

    await hook.unmount();
  });
});

/**
 * The configured provider names the **next** idle admission; the published snapshot's `adapterId`
 * names the attempt running right now. Presentation must follow the attempt, because the lifecycle
 * owner keeps the source adapter live until its hand-off observes a disconnect — so a surface that
 * followed the selection would hide a still-open microphone (deleting its own Stop control) and
 * would project the newly selected provider's capabilities onto someone else's attempt.
 */
describe('presentation follows the running attempt, not the next selection', () => {
  const RUNNING_PROVIDER_ID = 'local_conversation';
  const NEXT_PROVIDER_ID = 'happier.agent.codex/realtime-codex';

  async function seedRunningAttempt() {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    registerVoiceAdapters([
      getActivatedAdapter(RUNNING_PROVIDER_ID),
      getActivatedAdapter(NEXT_PROVIDER_ID),
    ]);
    seedVoiceSettings({
      providerId: RUNNING_PROVIDER_ID,
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });
    // Mid-turn: the assistant is thinking, so the attempt owns a cancellable response.
    setVoiceSessionSnapshot({
      adapterId: RUNNING_PROVIDER_ID,
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'thinking',
      canStop: true,
    });
  }

  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  afterEach(async () => {
    standardCleanup();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    registerVoiceAdapters([]);
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    getStorage().setState(initialStorageState, true);
  });

  it('keeps a live attempt visible and stoppable after the selection changes to Off', async () => {
    await seedRunningAttempt();
    const hook = await renderBothOwners();
    expect(hook.getCurrent().model).not.toBeNull();

    await act(async () => {
      seedVoiceSettings({
        ...getStorage().getState().settings.voice,
        providerId: 'off',
      });
    });

    // Off selects the next idle admission. It does not retire the running attempt, so hiding
    // the surface would leave the microphone open with nothing left to stop it.
    expect(hook.getCurrent().model).not.toBeNull();
    // The running Local agent owns a cancellable response even when Off is selected next.
    expect(hook.getCurrent().model!.canCancelTurn).toBe(true);
    expect(hook.getCurrent().control.canStop).toBe(true);

    await hook.unmount();
  });

  it('keeps the running provider capabilities after a different provider is selected', async () => {
    await seedRunningAttempt();
    const hook = await renderBothOwners();
    expect(hook.getCurrent().model!.canCancelTurn).toBe(true);

    await act(async () => {
      seedVoiceSettings({
        ...getStorage().getState().settings.voice,
        providerId: NEXT_PROVIDER_ID,
      });
    });

    // The running Local agent's cancellation capability must not be replaced by the next selection.
    expect(hook.getCurrent().model).not.toBeNull();
    expect(hook.getCurrent().model!.canCancelTurn).toBe(true);
    expect(hook.getCurrent().control.canStop).toBe(true);

    await hook.unmount();
  });
});

/**
 * C1 parity — an external provider must reach the surface exactly like a built-in one.
 *
 * The selected provider is resolved through the same registry a plugin registers into, and that
 * registry is only populated once the plugin's runtime activates — after the first render on a cold
 * boot. Without a subscription to the registry's own revision the surface keeps its first answer
 * forever, so a persisted external selection stays permanently unrunnable until some unrelated
 * render happens to refresh it.
 */
describe('external provider registration reaches the surface', () => {
  const externalToken = Object.freeze({});
  const EXTERNAL_PROVIDER_ID = 'acme.voice.demo/realtime-elevenlabs';

  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  afterEach(async () => {
    const { removeExternalVoiceProviderRegistration } =
      await import('@/voice/registry/externalVoiceProviderRegistrations');
    await act(async () => {
      removeExternalVoiceProviderRegistration(externalToken);
    });
    standardCleanup();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
  });

  it('becomes available when the plugin registers, with no unrelated rerender', async () => {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    const {
      commitExternalVoiceProviderRegistration,
      removeExternalVoiceProviderRegistration,
    } = await import('@/voice/registry/externalVoiceProviderRegistrations');
    const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } =
      await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
    const { createBuiltinVoiceAdapterAssembly } =
      await import('@/dev/testkit/harness/builtinVoiceAdapters');
    const declared =
      BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
        (entry) => entry.pluginId === 'happier.voice.elevenlabs',
      );
    if (!declared?.declaration.settings)
      throw new Error(
        'External discovery fixture requires its public provider leaf and settings',
      );
    await providerAssembly?.dispose();
    // The public provider leaf activates against a different plugin identity.
    // Discovery exercises the actual registration/capability projection;
    // it does not claim that this external service starts a hosted call.
    providerAssembly = (await createBuiltinVoiceAdapterAssembly({
      bundledEntries: [
        {
          ...declared,
          pluginId: 'acme.voice.demo',
          providerId: EXTERNAL_PROVIDER_ID,
        },
      ],
    }));
    const adapter = providerAssembly.adapters.find(
      (candidate) => candidate.id === EXTERNAL_PROVIDER_ID,
    );
    if (!adapter) throw new Error('External provider leaf did not activate');
    removeExternalVoiceProviderRegistration(externalToken);
    registerVoiceAdapters([adapter]);
    const { projectVoiceProviderDeclarationRegistryBase } =
      await import('@/voice/registry/providerRegistry');
    const { createExternalVoiceProviderSettingsDescriptor } =
      await import('@/voice/settings/externalProviderSettings');
    const descriptor = {
      kind: 'voice.conversation-provider.v1' as const,
      pluginId: 'acme.voice.demo',
      providerId: EXTERNAL_PROVIDER_ID,
      settingsSectionId: EXTERNAL_PROVIDER_ID,
      declaration: declared.declaration,
      ...projectVoiceProviderDeclarationRegistryBase({
        declaration: declared.declaration,
        providerSettings: createExternalVoiceProviderSettingsDescriptor(
          declared.declaration.settings,
        ),
        selectionOptions: [],
      }),
      source: {
        kind: 'external' as const,
        pluginId: 'acme.voice.demo',
        localId: declared.declaration.id,
      },
    };
    seedVoiceSettings({
      providerId: EXTERNAL_PROVIDER_ID,
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        [EXTERNAL_PROVIDER_ID]: {
          schemaVersion: declared.declaration.settings.schemaVersion,
          config: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        },
      },
    });

    const hook = await renderBothOwners();
    // Cold boot: the plugin runtime has not registered its provider yet.
    expect(hook.getCurrent().model).toBeNull();

    await act(async () => {
      commitExternalVoiceProviderRegistration(
        Object.freeze({
          token: externalToken,
          pluginId: 'acme.voice.demo',
          localId: 'realtime-elevenlabs',
          providerId: EXTERNAL_PROVIDER_ID,
          descriptor,
          adapter: null,
        }),
      );
    });

    expect(hook.getCurrent().model).not.toBeNull();
    expect(hook.getCurrent().control.canStart).toBe(true);

    // Withdrawal is the same authority in the other direction.
    await act(async () => {
      removeExternalVoiceProviderRegistration(externalToken);
    });
    expect(hook.getCurrent().model).toBeNull();
    expect(hook.getCurrent().control.canStart).toBe(false);

    await hook.unmount();
  });
});

/**
 * §2.2 — the availability ladder has three rungs, and the middle one is the whole point.
 *
 * A provider the user selected but has not finished connecting cannot start, and it publishes no
 * `errorRecoveryAction` because nothing has failed yet — nothing was ever attempted. Reading that
 * as terminally unavailable renders **no transport at all**: the orb and the composer planet
 * silently disappear, and the one affordance that would fix the situation disappears with them.
 *
 * `recoverable` is the truthful answer there: the transport stays, and a tap opens the setup screen
 * through the same `onRecover` dispatch Horizon uses (§5.5) rather than a second recovery decision.
 */
describe('useVoiceAttemptControl availability ladder', () => {
  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    routerMock.instance?.spies.push.mock.calls.splice(0);
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  afterEach(async () => {
    standardCleanup();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
  });

  async function renderIncompleteSetup() {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([
      getActivatedAdapter('happier.agent.codex/realtime-codex'),
    ]);
    // The same seed as the admission test above: a provider is selected, its connected-services
    // reference was never chosen, and no attempt has failed.
    seedVoiceSettings({
      providerId: 'happier.agent.codex/realtime-codex',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
    });
    return await renderBothOwners();
  }

  it('stays present and recoverable when the selected provider is not finished being set up', async () => {
    const hook = await renderIncompleteSetup();
    const { control } = hook.getCurrent();

    expect(control.canStart).toBe(false);
    // Not 'unavailable': the orb must not vanish on a problem the user can fix.
    expect(control.availability).toBe('recoverable');
    expect(control.primaryAction).toBe('recover');
    expect(control.primaryActionLabel).toBe(t('voicePresence.recovery.setUp'));
    expect(control.recoveryIcon).toBe('gear');

    await hook.unmount();
  });

  it('routes that recovery to the canonical Voice provider-focus screen', async () => {
    const hook = await renderIncompleteSetup();

    await act(async () => {
      await hook.getCurrent().control.onPrimaryAction();
    });

    expect(
      routerMock.instance?.spies.push.mock.calls.map((call) => call[0]),
    ).toContainEqual(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);

    await hook.unmount();
  });

  it('hides the setup-pose mic once the person dismissed "Set up voice", until Voice is set up', async () => {
    const { VOICE_SETUP_STEP_ID } =
      await import('@/voice/settings/setup/useVoiceSetupItem');
    const { normalizeHomeHubLayoutV1, setHomeSetupStepHidden } =
      await import('@happier-dev/protocol/home');
    const { createHomeHubArtifactHttpBoundary } =
      await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
    const {
      installDisconnectedServerSocketBoundary,
      restoreServerAccountForTest,
    } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { installWebLockManagerMock } =
      await import('@/auth/storage/tokenStorage.web.testHelpers');
    installDisconnectedServerSocketBoundary();
    await import('@/sync/syncEngine');
    const artifact = createHomeHubArtifactHttpBoundary(
      'voice-dismissal-account',
    );
    artifact.seed(
      setHomeSetupStepHidden(
        normalizeHomeHubLayoutV1(undefined),
        VOICE_SETUP_STEP_ID,
        true,
      ),
    );
    const webLocks = installWebLockManagerMock();
    const connection = await restoreServerAccountForTest({
      serverUrl: 'https://voice-setup-dismissal.test',
      accountId: 'voice-dismissal-account',
      activation: 'switch',
      request: artifact.request,
    });
    let hook: Awaited<ReturnType<typeof renderBothOwners>> | undefined;
    try {
      const scope = {
        serverId: connection.home.id,
        accountId: 'voice-dismissal-account',
      };
      getStorage().setState({
        isDataReady: true,
        profileScope: scope,
        settingsScope: scope,
      });
      seedVoiceSettings({
        providerId: null,
        ui: {
          activityFeedEnabled: false,
          scopeDefault: 'global',
          surfaceLocation: 'auto',
        },
      });
      const { useVoiceSurfaceModel } =
        await import('@/components/voice/surface/useVoiceSurfaceModel');
      const { useVoiceAttemptControl } =
        await import('./useVoiceAttemptControl');
      hook = await renderHook(
        () => ({
          model: useVoiceSurfaceModel({ variant: 'sidebar' }),
          control: useVoiceAttemptControl(GLOBAL_TARGET),
        }),
        {
          wrapper: ({ children }) => (
            <InjectedAuthProvider credentials={connection.credentials}>
              {children}
            </InjectedAuthProvider>
          ),
        },
      );
      await waitForTestEvent(
        hook.subscribe,
        hook.getCurrent,
        (value) =>
          value.control.availability === 'unavailable' &&
          value.control.primaryAction === null,
      );
      // The same Account Artifact Home's "Get set up" reads; Settings → Voice remains reachable.
      expect(hook.getCurrent().control).toMatchObject({
        availability: 'unavailable',
        primaryAction: null,
      });
    } finally {
      await hook?.unmount();
      await connection.dispose();
      webLocks.restore();
    }
  });
  it('keeps the rest mic and opens Voice setup when the selected provider cannot run here', async () => {
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    // A server feature this provider needs is off. There is no recovery for the attempt, but
    // Voice setup is where another service is chosen, so the mic stays and opens it.
    setVoiceAgentFeature(false);
    seedVoiceSettings({
      providerId: 'local_conversation',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });

    const hook = await renderBothOwners();

    expect(hook.getCurrent().control.availability).toBe('setup');

    await hook.unmount();
  });

  it('makes Voice discoverable on a fresh Account: the rest mic opens Voice setup instead of starting', async () => {
    seedVoiceSettings({
      providerId: null,
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
    });
    const { SETTINGS_ROUTES } =
      await import('@/components/settings/catalog/routes');

    const hook = await renderBothOwners();
    const { control } = hook.getCurrent();

    expect(control).toMatchObject({
      availability: 'setup',
      primaryAction: 'setup',
      canStart: false,
      markPose: 'mic',
    });
    expect(control.primaryActionLabel).toBe(t('voicePresence.setUp'));
    control.onPrimaryAction();
    expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toBe(
      SETTINGS_ROUTES.voice,
    );

    await hook.unmount();
  });

  it('unfolds Voice setup in place from the composer mark instead of leaving the work (lab T1)', async () => {
    seedVoiceSettings({
      providerId: null,
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
    });
    const { SETTINGS_ROUTES } =
      await import('@/components/settings/catalog/routes');
    const { VoiceComposerPlanetMount } =
      await import('@/components/voice/composer/VoiceComposerPlanetMount');
    const { VoiceEnergyProvider } =
      await import('@/components/voice/light/useVoiceEnergy');
    const { InjectedAuthProvider } =
      await import('@/auth/context/AuthContext');
    const { installReactDomPortalBoundaryForTests } =
      await import('@/dev/testkit/mocks/reactDom');
    const portal = installReactDomPortalBoundaryForTests();
    const pushesBefore = routerMock.instance?.spies.push.mock.calls.length ?? 0;
    // The app's authenticated tree always provides auth; the setup readiness reads it.
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}>
        <VoiceEnergyProvider
          state={{ luminosity: 0, energized: false, direction: 'inward' }}
          activation={{ providerReady: false, attemptActive: false, micCaptureActive: false }}
        >
          <VoiceComposerPlanetMount target={GLOBAL_TARGET} />
        </VoiceEnergyProvider>
      </InjectedAuthProvider>,
    );
    try {
      expect(screen.findByTestId('voice-setup-in-place')).toBeNull();
      await act(async () => screen.tree.pressByTestId('session-composer-voice'));
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('voice-setup-in-place'),
        popover => popover !== null);
      expect(
        routerMock.instance?.spies.push.mock.calls.slice(pushesBefore).map((call) => call[0]),
      ).not.toContain(SETTINGS_ROUTES.voice);
    } finally {
      await screen.unmount();
      portal.restore();
    }
  });
});

/**
 * Recovery routing belongs to the placement-free attempt projection. Horizon used to replace its
 * `onRecover` callback locally while Orb and composer kept the generic Voice-settings fallback,
 * which made one error land in two different places depending on which surface the user touched.
 */
describe('useVoiceAttemptControl recovery routing', () => {
  const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';
  function installCodexConnectedService(): void {
    // A daemon descriptor enters the real projection owner; executable and
    // released-service routing facts are derived there, never copied here.
    const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({
      id: 'openai-codex',
      pluginId: 'happier.agent.codex',
      serviceId: 'openai-codex',
      title: 'Codex',
      provenance: 'first_party',
      sourceKind: 'bundled',
      authentication: {
        defaultModeId: 'oauth',
        modes: [
          {
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            callbackUrl: 'http://127.0.0.1:4000/auth/callback',
            pkce: 'required',
            outcomeReconciliation: 'none',
          },
        ],
      },
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    });
    installConnectedAccountDescriptorProjection({
      scopeKey: recoveryRuntime.serverId,
      status: 'ready',
      descriptors: [descriptor],
      conflicts: [],
      errorReason: null,
    });
  }
  const SELECTED_PROFILE_VOICE_SETTINGS = {
    providerId: CODEX_PROVIDER_ID,
    ui: {
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    },
    providers: {
      [CODEX_PROVIDER_ID]: {
        schemaVersion: 2,
        config: {
          globalConnectedServices: {
            v: 1,
            bindingsByServiceId: {
              'happier.agent.codex/openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'account-work',
              },
            },
          },
        },
      },
    },
  } as const;

  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    platformState.os = 'web';
    platformState.openSettings.mockClear();
    routerMock.instance?.spies.push.mock.calls.splice(0);
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
  });

  afterEach(async () => {
    standardCleanup();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
  });

  async function renderBothRecoveryOwners(
    recoveryAction: 'connect_agent' | 'update_agent_runtime' | 'open_settings',
  ) {
    const { registerVoiceAdapters, resolveVoiceAdapterSurfaceCapabilities } =
      await import('@/voice/session/voiceAdapterRegistry');
    const { captureVoiceAttemptRecoveryTarget } =
      await import('@/voice/session/voiceAttemptRecoveryTarget');
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    registerVoiceAdapters([getActivatedAdapter(CODEX_PROVIDER_ID)]);
    seedVoiceSettings(SELECTED_PROFILE_VOICE_SETTINGS);
    setVoiceSessionSnapshot({
      adapterId: CODEX_PROVIDER_ID,
      sessionId: 'voice-control-session',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorRecoveryAction: recoveryAction,
      errorPresentation: 'error',
      recoveryTarget: captureVoiceAttemptRecoveryTarget(
        resolveVoiceAdapterSurfaceCapabilities(
          CODEX_PROVIDER_ID,
          getStorage().getState().settings.voice,
        ),
        null,
      ),
    });
    return await renderBothOwners();
  }

  it('agrees with the New Action that exact Agent Voice continues a Session rather than replacing it', async () => {
    installCodexConnectedService();
    seedVoiceSettings(SELECTED_PROFILE_VOICE_SETTINGS);
    const controller = await installLifecycle();
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    const global = await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));
    expect(global.getCurrent().canStart).toBe(true);
    expect(typeof global.getCurrent().onNewConversation).toBe('function');
    await global.unmount();
    const target = {
      kind: 'session' as const,
      sessionAddress: { serverId: recoveryRuntime.serverId, sessionId: 'session-42' },
    };
    const hook = await renderHook(() => useVoiceAttemptControl(target));
    expect(hook.getCurrent().canStart).toBe(true);
    expect.soft(hook.getCurrent().onNewConversation).toBeUndefined();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().executeConfirmed('ui.voice_global.new_conversation', {
      target, expectedAttempt: null,
    }, { surface: 'ui', serverId: recoveryRuntime.serverId });
    expect(result).toMatchObject({ ok: true, result: {
      status: 'unavailable', code: 'voice_new_conversation_unavailable',
      voice: { attemptId: null, canDismissFailedAttempt: false },
    } });
    expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    await hook.unmount();
  });

  it('sends the same selected-profile Connect recovery from Horizon and placement-free consumers', async () => {
    installCodexConnectedService();
    const hook = await renderBothRecoveryOwners('connect_agent');
    const expectedRoute = {
      pathname: '/(app)/settings/connected-services/account',
      params: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
        accountId: 'account-work',
      },
    } satisfies Parameters<typeof resolveHref>[0];

    await act(async () => {
      await hook.getCurrent().control.onRecover();
    });
    expect(readLastPushedHref()).toBe(resolveHref(expectedRoute));

    routerMock.instance?.spies.push.mock.calls.splice(0);
    await act(async () => {
      await hook.getCurrent().model?.attemptControl.onRecover();
    });
    expect(readLastPushedHref()).toBe(resolveHref(expectedRoute));

    await hook.unmount();
  });

  async function renderLocalVoiceSignedOutRefusal(
    agent: Readonly<{ agentSource: 'agent' | 'session'; agentId: string }>,
  ) {
    const { registerVoiceAdapters, resolveVoiceAdapterSurfaceCapabilities } =
      await import('@/voice/session/voiceAdapterRegistry');
    const { captureVoiceAttemptRecoveryTarget } =
      await import('@/voice/session/voiceAttemptRecoveryTarget');
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    seedVoiceSettings({
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent', agent },
        },
      },
    });
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'authentication_required',
      errorMessage: 'agent_signed_out',
      errorRecoveryAction: 'connect_agent',
      errorPresentation: 'error',
      recoveryTarget: captureVoiceAttemptRecoveryTarget(
        resolveVoiceAdapterSurfaceCapabilities(
          'local_conversation',
          getStorage().getState().settings.voice,
        ),
        null,
      ),
    });
    return await renderBothOwners();
  }

  it('names the fixed Voice Agent and its machine when it is signed out, and sets that Agent up from every placement', async () => {
    const { resolveVoiceExecutionMachinePresentationFromState } =
      await import('@/voice/credentials/useExecutionMachinePresentation');
    const hook = await renderLocalVoiceSignedOutRefusal({
      agentSource: 'agent',
      agentId: 'codex',
    });
    try {
      const machine = resolveVoiceExecutionMachinePresentationFromState(
        getStorage().getState(),
      ).machineLabel;
      expect(machine).toEqual(expect.any(String));
      const message = t('settingsVoice.local.machineErrors.agent_signed_out', {
        agent: 'Codex',
        machine: machine ?? '',
      });
      expect(hook.getCurrent().control).toMatchObject({
        recoveryAvailable: true,
        surfaceState: 'error',
        captionLabel: message,
        recoveryLabel: t('voiceSurface.setUpAgent', { agent: 'Codex' }),
      });
      expect(hook.getCurrent().model?.subtitle).toBe(message);
      const expectedRoute = {
        pathname: '/(app)/settings/agents/[agentId]',
        params: {
          agentId: 'codex',
          pluginId: 'happier.agent.codex',
          machineId: 'machine-work',
          serverIdentityId: 'srv_voice_attempt_work',
        },
      } satisfies Parameters<typeof resolveHref>[0];
      expect(hook.getCurrent().control.publicPresentation).toMatchObject({
        failureKind: 'authentication_required',
        failureMessage: message,
        recovery: {
          action: 'connect_agent',
          label: hook.getCurrent().control.recoveryLabel,
          runtimeTarget: expectedRoute.params,
        },
      });
      await act(async () => {
        await hook.getCurrent().control.onRecover();
      });
      expect(readLastPushedHref()).toBe(resolveHref(expectedRoute));
      routerMock.instance?.spies.push.mock.calls.splice(0);
      await act(async () => {
        await hook.getCurrent().model?.attemptControl.onRecover();
      });
      expect(readLastPushedHref()).toBe(resolveHref(expectedRoute));
    } finally {
      await hook.unmount();
    }
  });

  it('offers Agent settings from Local Voice authentication recovery when the Voice Agent follows the session and has no exact runtime identity', async () => {
    const hook = await renderLocalVoiceSignedOutRefusal({
      agentSource: 'session',
      agentId: 'codex',
    });
    try {
      expect(hook.getCurrent().control).toMatchObject({
        recoveryAvailable: true,
        surfaceState: 'error',
        publicPresentation: { failureKind: 'authentication_required' },
        recoveryLabel: t('voiceSurface.connectAgent'),
      });
      await act(async () => {
        await hook.getCurrent().control.onRecover();
      });
      expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toBe(
        '/settings/agents',
      );
    } finally {
      await hook.unmount();
    }
  });

  it('does not reconstruct missing admitted recovery facts from the current fixed Agent preference', async () => {
    const hook = await renderLocalVoiceSignedOutRefusal({
      agentSource: 'agent',
      agentId: 'codex',
    });
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    try {
      await act(async () => {
        setVoiceSessionSnapshot({
          ...getVoiceSessionSnapshot(),
          recoveryTarget: undefined,
        });
      });
      expect(hook.getCurrent().control.recoveryLabel).toBe(
        t('voiceSurface.connectAgent'),
      );
      await act(async () => {
        await hook.getCurrent().control.onRecover();
      });
      expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toBe(
        '/settings/agents',
      );
    } finally {
      await hook.unmount();
    }
  });

  it('sends Agent runtime update recovery to the exact portable update target from every placement', async () => {
    const hook = await renderBothRecoveryOwners('update_agent_runtime');
    const expectedRoute = {
      pathname: '/(app)/settings/agents/[agentId]',
      params: {
        agentId: 'codex',
        pluginId: 'happier.agent.codex',
        machineId: 'machine-work',
        serverIdentityId: 'srv_voice_attempt_work',
        installIntent: 'update',
      },
    } satisfies Parameters<typeof resolveHref>[0];

    await act(async () => {
      await hook.getCurrent().control.onRecover();
    });
    expect(readLastPushedHref()).toBe(resolveHref(expectedRoute));

    routerMock.instance?.spies.push.mock.calls.splice(0);
    await act(async () => {
      await hook.getCurrent().model?.attemptControl.onRecover();
    });
    expect(readLastPushedHref()).toBe(resolveHref(expectedRoute));

    await hook.unmount();
  });

  it('withholds Agent runtime recovery when the routing server has no canonical portable identity', async () => {
    await connection?.dispose();
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'voice', true))
      throw new Error('Voice feature fixture unavailable');
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://unidentified-voice-home.test',
      accountId: 'attempt-account',
      credentialScope: 'restored-home',
      activation: 'switch',
      request: async (url) =>
        new URL(String(url)).pathname === '/v1/features'
          ? Response.json(features)
          : null,
    });
    primeServerFeaturesSnapshot({
      serverId: connection.home.id,
      snapshot: { status: 'ready', features },
    });
    const scope = {
      serverId: connection.home.id,
      accountId: 'attempt-account',
    };
    const machine = createHydratedPlainMachineFixture({
      id: recoveryRuntime.machineId,
      accountId: scope.accountId,
      machine: { activeAt: Date.now() },
    });
    publishMachineActivityForTest([machine]);
    getStorage().setState({
      profileScope: scope,
      settingsScope: scope,
      machines: { [machine.id]: machine },
      machineListByServerId: { [scope.serverId]: [machine] },
    });
    installCodexConnectedService();
    const hook = await renderBothRecoveryOwners('update_agent_runtime');
    const { resolveVoiceExecutionMachinePresentationFromState } =
      await import('@/voice/credentials/useExecutionMachinePresentation');
    const { resolvePortableServerIdentityForRoutingId } =
      await import('@/sync/domains/server/resolvePortableServerIdentityForRoutingId');
    expect(
      resolveVoiceExecutionMachinePresentationFromState(getStorage().getState())
        .machineId,
    ).toBe(recoveryRuntime.machineId);
    expect(
      resolvePortableServerIdentityForRoutingId(connection.home.id),
    ).toBeNull();

    // A separate incomplete Connected Services setup may still provide a recovery action,
    // but a device-local routing id must never become Agent Administration authority.
    await act(async () => {
      await hook.getCurrent().control.onRecover();
    });
    expect(
      routerMock.instance?.spies.push.mock.calls.map((call) => call[0]),
    ).not.toContainEqual(
      expect.objectContaining({ pathname: '/(app)/settings/agents/[agentId]' }),
    );

    await hook.unmount();
  });

  it('opens native platform settings through the same recovery command', async () => {
    await providerAssembly?.dispose();
    providerAssembly = undefined;
    await connection?.dispose();
    connection = undefined;
    // Storage backends and Account currentness are admitted under the native
    // platform from the start, rather than replacing web credentials mid-flow.
    platformState.os = 'ios';
    await restoreAttemptAccount();
    const hook = await renderBothRecoveryOwners('open_settings');
    try {
      await act(async () => {
        await hook.getCurrent().control.onRecover();
      });
      expect(platformState.openSettings).toHaveBeenCalledTimes(1);
    } finally {
      await hook.unmount();
    }
  });
});

/**
 * The Orb and Horizon are two placements of the same attempt, so microphone truth and the
 * placement-neutral caption must be projected once here. In particular, `muted === false` does
 * not mean capture is open: a half-duplex provider closes its input while output is speaking.
 */
describe('useVoiceAttemptControl capture and caption projection', () => {
  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    seedVoiceSettings({
      providerId: 'local_conversation',
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });
  });

  afterEach(async () => {
    standardCleanup();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
  });

  async function renderControl(
    snapshot: VoiceSessionSnapshot,
    onRender?: () => void,
  ) {
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot(snapshot);
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    const { VoiceEnergyAppProvider } =
      await import('@/components/voice/light/VoiceEnergyAppProvider');
    function VoiceEnergyHookTestProvider(
      props: React.PropsWithChildren,
    ): React.ReactElement {
      return <VoiceEnergyAppProvider>{props.children}</VoiceEnergyAppProvider>;
    }
    return await renderHook(
      () => {
        onRender?.();
        return useVoiceAttemptControl(GLOBAL_TARGET);
      },
      { wrapper: VoiceEnergyHookTestProvider },
    );
  }

  it('keeps a connected call with no reported phase live and clocks its original attempt start', async () => {
    const { getVoiceSessionAttemptStartedAt, setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    const { readVoiceElapsedStartedAt } =
      await import('@/components/voice/presence/VoiceStatusLine');
    const { resolveVoicePresenceCaption } =
      await import('@/components/voice/presence/resolveVoicePresenceCaption');
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'connected-without-phase',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
    try {
      const startedAt = getVoiceSessionAttemptStartedAt();
      expect(startedAt).toEqual(expect.any(Number));
      expect(hook.getCurrent()).toMatchObject({
        live: true,
        surfaceState: 'live',
        statusWord: 'Connected',
        statusLabel: 'Connected',
        primaryAction: 'end',
        capturing: false,
        elapsedStartedAt: startedAt,
      });
      expect(readVoiceElapsedStartedAt(hook.getCurrent())).toBe(startedAt);
      const { VoiceAttemptPresentationSchema } =
        await import('@happier-dev/protocol/voice/attemptPresentation');
      expect(VoiceAttemptPresentationSchema.parse(hook.getCurrent().publicPresentation))
        .toMatchObject({ surfaceState: 'live', live: true });
      expect(resolveVoicePresenceCaption(hook.getCurrent())).toBe(
        t('voiceSurface.a11y.microphoneInactive'),
      );
      await act(async () => setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: 'connected-without-phase',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      }));
      expect(hook.getCurrent().statusWord).toBe(t('voiceAssistant.listening'));
      expect(readVoiceElapsedStartedAt(hook.getCurrent())).toBe(startedAt);
    } finally {
      await hook.unmount();
    }
  });

  it.each([true, false])('keeps the live call phase for blocked input and real requests retain Needs you (hidden=%s)', async (hidden) => {
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    const session = createSessionFixture({
      id: 'blocked-carrier',
      serverId: recoveryRuntime.serverId,
      active: true,
      activeAt: Date.now(),
      pendingCount: 3,
      pendingBlockedCount: 3,
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      metadata: {
        ...createSessionFixture().metadata!,
        ...(hidden ? { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } : {}),
      },
    });
    getStorage().setState((state) => ({
      sessions: { ...state.sessions, [session.id]: session },
    }));
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: session.id,
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    try {
      expect(hook.getCurrent()).toMatchObject({
        statusCell: null,
        statusWord: t('voiceAssistant.listening'),
        statusLabel: t('voiceAssistant.listening'),
        primaryAction: 'end',
      });
      await act(async () =>
        setVoiceSessionSnapshot({
          adapterId: 'local_conversation',
          sessionId: session.id,
          status: 'connected',
          mode: 'speaking',
          canStop: true,
        }),
      );
      expect(hook.getCurrent()).toMatchObject({
        statusCell: null,
        statusWord: t('voiceAssistant.speaking'),
        statusLabel: t('voiceAssistant.speaking'),
      });
      await act(async () =>
        getStorage().setState((state) => ({
          sessions: {
            ...state.sessions,
            [session.id]: {
              ...session,
              pendingPermissionRequestCount: 1,
              pendingRequestObservedAt: Date.now(),
            },
          },
        })),
      );
      expect(hook.getCurrent()).toMatchObject({
        statusCell: 'needs_you',
        statusWord: t('workStatus.buckets.needs_you'),
      });
    } finally {
      await hook.unmount();
    }
  });

  it.each([
    { permissionCount: 1, thinking: false, cell: 'needs_you' },
    { permissionCount: 0, thinking: true, cell: 'working' },
  ] as const)(
    'keeps the call phase accessible alongside the shared $cell word',
    async ({ permissionCount, thinking, cell }) => {
      const { setVoiceSessionSnapshot } =
        await import('@/voice/session/voiceSessionStore');
      const session = createSessionFixture({
        id: 'attention-carrier',
        serverId: recoveryRuntime.serverId,
        active: true,
        activeAt: Date.now(),
        updatedAt: Date.now(),
        thinking,
        thinkingAt: Date.now(),
        pendingPermissionRequestCount: permissionCount,
        pendingUserActionRequestCount: 0,
        pendingRequestObservedAt: Date.now(),
      });
      getStorage().setState((state) => ({
        sessions: { ...state.sessions, [session.id]: session },
      }));
      const hook = await renderControl({
        adapterId: 'local_conversation',
        sessionId: session.id,
        status: 'connected',
        mode: 'listening',
        canStop: true,
      });
      try {
        expect(hook.getCurrent().statusCell).toBe(cell);
        expect(hook.getCurrent().statusWord).toBe(
          t(`workStatus.buckets.${cell}`),
        );
        expect(hook.getCurrent().statusLabel).toBe(
          t('voiceAssistant.listening'),
        );
        await act(async () =>
          setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: session.id,
            status: 'connected',
            mode: 'speaking',
            canStop: true,
          }),
        );
        expect(hook.getCurrent().statusCell).toBe(cell);
        expect(hook.getCurrent().statusWord).toBe(
          t(`workStatus.buckets.${cell}`),
        );
        expect(hook.getCurrent().statusLabel).toBe(
          t('voiceAssistant.speaking'),
        );
        expect(hook.getCurrent().primaryAction).toBe('end');
        await act(async () =>
          setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: session.id,
            status: 'connected',
            mode: 'speaking',
            micMuted: true,
            canStop: true,
          }),
        );
        expect(hook.getCurrent().statusWord).toBe(
          t(`workStatus.buckets.${cell}`),
        );
        expect(hook.getCurrent().statusLabel).toBe(t('voicePresence.muted'));
      } finally {
        await hook.unmount();
      }
    },
  );

  it('keeps command-only attempt consumers unchanged while canonical transcript text changes', async () => {
    seedVoiceSettings({
      providerId: 'local_conversation',
      ui: { activityFeedEnabled: true },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });
    const { voiceSessionBindingStore } =
      await import('@/voice/binding/voiceConversationBindingStore');
    const { projectCanonicalVoiceTranscriptEvent } =
      await import('@/voice/transcript/voiceConversationTranscript');
    const conversationSessionId = 'latest-line-conversation';
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'latest-line-control',
      conversationSessionId,
      conversationSessionAddress: {
        serverId: recoveryRuntime.serverId,
        sessionId: conversationSessionId,
      },
      lifetime: 'runtime_attempt',
      transcriptMode: 'synthetic',
      targetSessionAddress: null,
      updatedAt: 1,
    });
    const mergeOwner =
      await import('@/components/voice/surface/mergeVoiceSurfaceTranscriptEntries');
    const merge = vi.spyOn(mergeOwner, 'mergeVoiceSurfaceTranscriptEntries');
    let renders = 0;
    const snapshot: VoiceSessionSnapshot = {
      adapterId: 'local_conversation',
      sessionId: 'latest-line-control',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    };
    const hook = await renderControl(snapshot, () => {
      renders += 1;
    });
    const composer = await renderControl(snapshot, () => {
      renders += 1;
    });
    const closedContainer = await renderControl(snapshot, () => {
      renders += 1;
    });
    const publish = (
      itemId: string,
      sequence: number,
      revision: number,
      text: string,
    ) =>
      projectCanonicalVoiceTranscriptEvent({
        conversationSessionId,
        event: {
          v: 1,
          epoch: 1,
          type: 'voice.transcript.updated',
          itemId,
          sequence,
          revision,
          eventId: `${itemId}-${revision}`,
          role: 'assistant',
          provenance: 'live',
          text,
        },
      });
    let detail: RenderHookResult<
      ReturnType<
        typeof import('@/components/voice/surface/useVoiceSurfaceConversationState').useVoiceSurfaceConversationState
      >,
      void
    > | null = null;
    try {
      const initialControl = hook.getCurrent();
      const baselineRenders = renders;
      merge.mockClear();
      await act(async () => {
        publish('oldest', 1, 1, 'Earlier words');
        publish('latest', 2, 1, 'Newest words');
      });
      expect(hook.getCurrent()).toBe(initialControl);
      await act(async () => {
        publish('oldest', 3, 2, 'Earlier words corrected');
      });
      expect(hook.getCurrent()).toBe(initialControl);
      await act(async () => {
        publish('latest', 4, 2, 'Newest words corrected');
      });
      expect(hook.getCurrent()).toBe(initialControl);
      await act(async () => {
        getStorage().setState({
          sessionMessages: {
            ...getStorage().getState().sessionMessages,
            [conversationSessionId]: createSessionMessagesFixture({
              messageIdsOldestFirst: ['stored'],
              messagesById: {
                stored: {
                  kind: 'user-text',
                  id: 'stored',
                  localId: null,
                  createdAt: 1,
                  text: 'Persisted transcript turn',
                },
              },
            }),
          },
        });
      });
      expect(hook.getCurrent()).toBe(initialControl);
      expect(renders).toBe(baselineRenders);
      expect(merge).not.toHaveBeenCalled();
      const { useVoiceSurfaceConversationState } =
        await import('@/components/voice/surface/useVoiceSurfaceConversationState');
      detail = await renderHook(() =>
        useVoiceSurfaceConversationState({
          providerId: 'local_conversation',
          activeControlSessionId: 'latest-line-control',
          surfaceSessionId: null,
          transcriptEnabled: true,
          voiceSettings: {},
        }),
      );
      expect(detail.getCurrent().transcriptEntries.at(-1)?.text).toBe(
        'Newest words corrected',
      );
      merge.mockClear();
      await act(async () => {
        publish('latest', 5, 3, 'Newest words with open detail');
      });
      expect(detail.getCurrent().transcriptEntries.at(-1)?.text).toBe(
        'Newest words with open detail',
      );
      expect(renders).toBe(baselineRenders);
      expect(merge).toHaveBeenCalledTimes(1);
    } finally {
      await detail?.unmount();
      await hook.unmount();
      await composer.unmount();
      await closedContainer.unmount();
      merge.mockRestore();
      voiceSessionBindingStore.getState().unbind(conversationSessionId);
    }
  });

  it('demands a stable compact line and current detail independently of the attempt controls', async () => {
    const { voiceSessionBindingStore } =
      await import('@/voice/binding/voiceConversationBindingStore');
    const { projectCanonicalVoiceTranscriptEvent } =
      await import('@/voice/transcript/voiceConversationTranscript');
    const {
      useVoiceSurfaceLatestTranscriptText,
      useVoiceSurfaceConversationState,
    } =
      await import('@/components/voice/surface/useVoiceSurfaceConversationState');
    const mergeOwner =
      await import('@/components/voice/surface/mergeVoiceSurfaceTranscriptEntries');
    const merge = vi.spyOn(mergeOwner, 'mergeVoiceSurfaceTranscriptEntries');
    const latest = vi.spyOn(
      mergeOwner,
      'resolveVoiceSurfaceLatestTranscriptText',
    );
    const conversationSessionId = 'compact-line-conversation';
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'compact-line-control',
      conversationSessionId,
      conversationSessionAddress: {
        serverId: recoveryRuntime.serverId,
        sessionId: conversationSessionId,
      },
      lifetime: 'runtime_attempt',
      transcriptMode: 'synthetic',
      targetSessionAddress: null,
      updatedAt: 1,
    });
    const params = {
      providerId: 'local_conversation',
      activeControlSessionId: 'compact-line-control',
      surfaceSessionId: null,
      transcriptEnabled: true,
      voiceSettings: {},
    };
    let compactRenders = 0;
    const compact = await renderHook(
      (transcriptEnabled: boolean) => {
        compactRenders += 1;
        return useVoiceSurfaceLatestTranscriptText({
          ...params,
          transcriptEnabled,
        });
      },
      { initialProps: true },
    );
    const publish = (
      itemId: string,
      sequence: number,
      revision: number,
      text: string,
    ) =>
      projectCanonicalVoiceTranscriptEvent({
        conversationSessionId,
        event: {
          v: 1,
          epoch: 1,
          type: 'voice.transcript.updated',
          itemId,
          sequence,
          revision,
          eventId: `${itemId}-${revision}`,
          role: 'assistant',
          provenance: 'live',
          text,
        },
      });
    let detail: RenderHookResult<
      ReturnType<typeof useVoiceSurfaceConversationState>,
      void
    > | null = null;
    try {
      merge.mockClear();
      await act(async () => {
        getStorage().setState({
          sessionMessages: {
            ...getStorage().getState().sessionMessages,
            [conversationSessionId]: createSessionMessagesFixture({
              messageIdsOldestFirst: ['stored'],
              messagesById: {
                stored: {
                  kind: 'user-text',
                  id: 'stored',
                  localId: null,
                  createdAt: 1,
                  text: 'Persisted words',
                },
              },
            }),
          },
        });
      });
      expect(compact.getCurrent()).toBe('Persisted words');
      await act(async () => {
        publish('oldest', 1, 1, 'Earlier words');
        publish('latest', 2, 1, 'Newest words');
      });
      expect(compact.getCurrent()).toBe('Newest words');
      expect(merge).not.toHaveBeenCalled();
      const baselineRenders = compactRenders;
      const baselineComputations = latest.mock.calls.length;
      await act(async () => {
        getStorage().setState({
          sessionMessages: {
            ...getStorage().getState().sessionMessages,
            unrelated: createSessionMessagesFixture({
              messageIdsOldestFirst: ['unrelated'],
              messagesById: {
                unrelated: {
                  kind: 'user-text',
                  id: 'unrelated',
                  localId: null,
                  createdAt: 1,
                  text: 'Unrelated transcript',
                },
              },
            }),
          },
        });
      });
      expect(latest.mock.calls.length).toBe(baselineComputations);
      expect(compactRenders).toBe(baselineRenders);
      await act(async () => {
        publish('oldest', 3, 2, 'Earlier words corrected');
      });
      expect(compact.getCurrent()).toBe('Newest words');
      expect(compactRenders).toBe(baselineRenders);
      detail = await renderHook(() => useVoiceSurfaceConversationState(params));
      expect(
        detail.getCurrent().transcriptEntries.map((entry) => entry.text),
      ).toEqual(['Persisted words', 'Earlier words corrected', 'Newest words']);
      await act(async () => {
        publish('latest', 4, 2, 'Newest words corrected');
      });
      expect(compact.getCurrent()).toBe('Newest words corrected');
      expect(compactRenders).toBe(baselineRenders + 1);
      expect(detail.getCurrent().transcriptEntries.at(-1)?.text).toBe(
        'Newest words corrected',
      );
      await detail.unmount();
      detail = null;
      await compact.rerender(false);
      expect(compact.getCurrent()).toBeNull();
      const disabledComputations = latest.mock.calls.length;
      const disabledRenders = compactRenders;
      await act(async () => {
        publish('latest', 5, 3, 'While compact is disabled');
      });
      expect(latest.mock.calls.length).toBe(disabledComputations);
      expect(compactRenders).toBe(disabledRenders);
      await compact.rerender(true);
      expect(compact.getCurrent()).toBe('While compact is disabled');
    } finally {
      await detail?.unmount();
      await compact.unmount();
      merge.mockRestore();
      latest.mockRestore();
      voiceSessionBindingStore.getState().unbind(conversationSessionId);
    }
  });

  it('keeps compact permission status distinct from its full accessible explanation', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorPresentation: 'permission_required',
      errorRecoveryAction: 'open_settings',
    });

    expect(hook.getCurrent().statusLabel).toBe(
      t('voiceAssistant.microphonePermissionRequired'),
    );
    expect(hook.getCurrent().statusWord).not.toBe(
      hook.getCurrent().statusLabel,
    );
    // The caption says what to do about it rather than repeating the status a second time.
    expect(hook.getCurrent().captionLabel).toBe(
      t('voicePresence.captions.blocked'),
    );
    expect(hook.getCurrent().micStateLabel).toBe(hook.getCurrent().statusLabel);
    expect(hook.getCurrent().surfaceState).toBe('permission_required');
    // One recovery label for the same action in every placement, drawn and announced alike (R12b).
    expect(hook.getCurrent().recoveryLabel).toBe(
      t('voicePresence.recovery.allow'),
    );
    expect(hook.getCurrent().recoveryIcon).toBe('microphone');
    await hook.unmount();
  });

  it.each([
    { reason: 'SPAWN_FAILED', copy: 'session.startFailure.modelSelectionRequired', failureCause: {
      phase: 'client_start', failureReason: 'model_selection_required', code: 'agent_startup_model_reconciliation_failed' } },
    { reason: 'database_transaction_timeout', copy: 'session.startFailure.cause.database_transaction_timeout' },
    { reason: 'provider_response_invalid', copy: 'settingsVoice.local.machineErrors.provider_response_invalid' },
    { reason: 'runtime_refusal', copy: 'settingsVoice.local.machineErrors.provider_error' },
  ] as const)('presents the producer failure through the public Voice hook ($reason)', async (failure) => {
    const hook = await renderControl({ adapterId: 'local_conversation', sessionId: 'control-1',
      status: 'error', mode: 'idle', canStop: false, errorCode: 'provider_error', errorMessage: failure.reason,
      ...('failureCause' in failure ? { errorFailureCause: failure.failureCause } : {}), errorRecoveryAction: 'retry' });
    expect(hook.getCurrent().captionLabel).toBe(t(failure.copy));
    await hook.unmount();
  });

  it('names the unsupported Connected Services binding without offering Retry', async () => {
    const { classifyVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
    const { createRpcCallError } = await import('@/sync/runtime/rpcErrors');
    const correction = "Backend 'codex' does not support Connected Service 'happier.agent.muse/muse-account'. Remove that binding or select a backend that supports it.";
    const failure = classifyVoiceMachineError(createRpcCallError({
      error: correction, errorCode: 'connected_service_binding_unsupported',
    }));
    const hook = await renderControl({
      adapterId: 'local_conversation', sessionId: 'control-1', status: 'error', mode: 'idle',
      canStop: false, errorCode: failure.kind, errorMessage: failure.reason,
      errorProviderMessage: failure.providerMessage, errorRecoveryAction: failure.recoveryAction,
    });
    expect(hook.getCurrent().captionLabel).toBe(correction);
    expect(failure.retryPolicy).toBe('never');
    expect(hook.getCurrent().recoveryLabel).not.toBe(t('common.retry'));
    await hook.unmount();
  });

  it('names why a failed attempt failed and offers its short recovery verb', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_setup_required',
      errorMessage: '/private/provider/detail',
      errorRecoveryAction: 'open_settings',
    });

    expect(hook.getCurrent().surfaceState).toBe('error');
    expect(hook.getCurrent().captionLabel).toBe(
      t('voice.readiness.settings_missing_required_setting', {
        service: hook.getCurrent().serviceTitle ?? t('voicePresence.title'),
      }),
    );
    expect(hook.getCurrent().recoveryLabel).toBe(
      t('voicePresence.recovery.setUp'),
    );
    expect(hook.getCurrent().recoveryIcon).toBe('gear');
    const {
      VoicePresence,
      VoiceMark,
      VoiceStatusLine,
      VoiceTransport,
      VoiceCompactTranscript,
      useVoiceAttempt,
    } = await import('@happier-dev/plugin-ui');
    const { PluginUiPresentationHostProviderInternal } =
      await import('../../../../../../packages/plugin-ui/src/presentationHost/context');
    const { createPluginUiPrivatePresentationHost } =
      await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
    const { VoiceMark: HostMark } =
      await import('@/components/voice/presence/VoiceMark');
    const { VoiceStatusLine: HostStatusLine } =
      await import('@/components/voice/presence/VoiceStatusLine');
    const { VoiceTransport: HostTransport } =
      await import('@/components/voice/presence/VoiceTransport');
    const { VoiceCompactTranscript: HostCompactTranscript } =
      await import('@/components/voice/presence/VoiceCompactTranscript');
    expect(VoiceCompactTranscript).toBeTypeOf('function');
    let publicAttempt: ReturnType<typeof useVoiceAttempt> = null;
    function ReadAttempt() {
      publicAttempt = useVoiceAttempt();
      return null;
    }
    const publicScreen = await renderScreen(
      <PluginUiPresentationHostProviderInternal
        host={createPluginUiPrivatePresentationHost(undefined)}
      >
        <VoicePresence target={{ kind: 'global' }}>
          <VoiceMark size={24} />
          <VoiceStatusLine size="pill" />
          <VoiceTransport size="pill" />
          <VoiceCompactTranscript testID="plugin-voice-caption" />
          <ReadAttempt />
        </VoicePresence>
      </PluginUiPresentationHostProviderInternal>,
    );
    expect(publicAttempt).toMatchObject({
      surfaceState: 'error',
      failureKind: 'provider_setup_required',
      failureMessage: hook.getCurrent().failureMessage,
      recovery: { label: hook.getCurrent().recoveryLabel, icon: 'gear' },
    });
    // The external composition reaches the real host primitives, sharing one projection.
    expect(publicScreen.findByType(HostMark).props.voice).toBe(
      publicScreen.findByType(HostStatusLine).props.voice,
    );
    expect(publicScreen.findByType(HostTransport).props.voice).toBe(
      publicScreen.findByType(HostStatusLine).props.voice,
    );
    expect(publicScreen.findByType(HostCompactTranscript).props.voice).toBe(
      publicScreen.findByType(HostStatusLine).props.voice,
    );
    expect(publicScreen.findHostByTestId('plugin-voice-caption')?.props.children).toBe(
      hook.getCurrent().captionLabel,
    );
    expect(publicAttempt).not.toHaveProperty('onRecover');
    expect(publicAttempt).not.toHaveProperty('errorMessage');
    expect(JSON.stringify(publicAttempt)).not.toContain(
      '/private/provider/detail',
    );
    await publicScreen.unmount();
    await hook.unmount();
  });

  it.each([false, true])('keeps a provider failure status word distinct from its explanatory caption (quota title: %s)', async (hasFailureTitle) => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'provider_error',
      errorPresentation: 'error',
      errorRecoveryAction: 'retry',
      ...(hasFailureTitle ? { errorMessage: 'usage_limit', errorProviderMessage: 'The provider has no usage remaining.' } : {}),
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error',
      statusWord: hasFailureTitle ? t('session.usageLimitRecovery.banner.title') : t('common.error'),
      captionLabel: hasFailureTitle ? 'The provider has no usage remaining.' : t('settingsVoice.local.machineErrors.provider_error'),
    });
    expect(hook.getCurrent().statusWord).not.toBe(hook.getCurrent().captionLabel);
    await hook.unmount();
  });

  it.each(['voice_connection_failed', 'voice_connection_timeout'])(
    'names the explicit connection failure %s without changing its retry recovery', async (errorMessage) => {
      const hook = await renderControl({
        adapterId: 'local_conversation', sessionId: 'control-1', status: 'error', mode: 'idle', canStop: false,
        errorCode: 'provider_error', errorMessage, errorPresentation: 'error', errorRecoveryAction: 'retry',
      });
      expect(hook.getCurrent()).toMatchObject({
        surfaceState: 'error', statusWord: t('voiceAssistant.connectionError'),
        captionLabel: t('settingsVoice.local.machineErrors.provider_error'),
      });
      await hook.unmount();
    },
  );

  it('names a browser audio block in a short word and keeps Retry as the gesture that starts audio', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation', sessionId: 'control-1', status: 'error', mode: 'idle', canStop: false,
      errorCode: 'service_temporarily_unavailable', errorMessage: 'audio_user_gesture_required',
      errorPresentation: 'error', errorRecoveryAction: 'retry',
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error', statusWord: t('voice.readiness.short.audioBlocked'),
      captionLabel: t('settingsVoice.local.machineErrors.audio_user_gesture_required'),
    });
    expect(hook.getCurrent().statusWord).not.toBe(t('common.error'));
    await hook.unmount();
  });

  it('names the unreachable Machine in the top bar in a short word, the reason once in the caption', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation', sessionId: 'control-1', status: 'error', mode: 'idle', canStop: false,
      errorCode: 'execution_machine_unavailable', errorMessage: 'voice_agent_target_machine_offline',
      errorPresentation: 'error', errorRecoveryAction: 'select_execution_machine',
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error', statusWord: t('voice.readiness.short.machineUnreachable'),
      failureMessage: t('voice.readiness.execution_machine_incompatible'),
      captionLabel: t('voice.readiness.execution_machine_incompatible'),
      // The machine may come back: Retry leads, choosing another machine is the alternate (lab ST).
      recoveryLabel: t('common.retry'), recoveryIcon: 'arrow-clockwise',
      alternateRecoveryLabel: t('voice.readiness.actions.select_execution_machine'),
    });
    expect(hook.getCurrent().statusWord).not.toBe(hook.getCurrent().captionLabel);
    await hook.unmount();
  });

  it('names the unreachable Home through its label owner and leaves its Retry to the Home', async () => {
    const { resolveHomeDisplayLabel } = await import('@/components/settings/server/homeDisplayName');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const serverId = getActiveServerSnapshot().serverId;
    const home = resolveHomeDisplayLabel(getServerProfileById(serverId), serverId, serverId);
    const hook = await renderControl({
      adapterId: 'local_conversation', sessionId: 'control-1', status: 'error', mode: 'idle', canStop: false,
      errorCode: 'provider_error', errorMessage: 'server_unreachable',
      errorPresentation: 'error', errorRecoveryAction: 'retry',
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error',
      // The page and the sidebar say it in these words, with the Home's own Retry.
      captionLabel: t('sidebarFooter.homeUnreachableTitle', { home }),
      recoveryOwnedByHome: true,
    });
    await hook.unmount();
  });

  it('names the offline Machine the attempt was admitted on in the short reason', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation', sessionId: 'control-1', status: 'error', mode: 'idle', canStop: false,
      errorCode: 'execution_machine_unavailable', errorMessage: 'voice_agent_target_machine_offline',
      errorPresentation: 'error', errorRecoveryAction: 'select_execution_machine',
      recoveryTarget: { serverId: 'server-1', machineId: 'machine-studio', machineLabel: 'Studio', agentRuntime: null },
    });
    expect(hook.getCurrent()).toMatchObject({
      failureMessage: t('voice.readiness.execution_machine_offline', { machine: 'Studio' }),
      captionLabel: t('voice.readiness.execution_machine_offline', { machine: 'Studio' }),
    });
    await hook.unmount();
  });

  it('keeps speech unavailability visible with settings recovery and Dismiss', async () => {
    const hook = await renderControl({
      adapterId: 'local_direct',
      sessionId: 'control-1',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'speech_recognition_unavailable',
      errorPresentation: 'error',
      errorRecoveryAction: 'select_speech_engine',
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error',
      captionLabel: t(
        'settingsVoice.local.machineErrors.speech_recognition_unavailable',
      ),
      recoveryAvailable: true,
      recoveryLabel: t('voicePresence.recovery.setUp'),
      recoveryIcon: 'gear',
      canDismissFailedAttempt: true,
    });
    await hook.unmount();
  });

  it('keeps a disconnected playback failure presented with Retry and Dismiss', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
      errorCode: 'tts_failed',
      errorMessage: 'QA_OUTPUT_START_FAILED',
      errorPresentation: 'notice',
      errorRecoveryAction: 'retry',
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error',
      captionLabel: t('settingsVoice.local.machineErrors.tts_failed'),
      live: true,
      availability: 'recoverable',
      primaryAction: 'recover',
      primaryActionLabel: t('common.retry'),
      markPose: 'blocked',
      canStart: true,
      canStop: false,
      canMute: false,
      capturing: false,
      recoveryAvailable: true,
      recoveryLabel: t('common.retry'),
      canDismissFailedAttempt: true,
      ended: null,
    });
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    // Even a failure with no repair action remains visible and dismissible, rather than
    // looking like a clean end. A fresh Start is still admitted independently of presence.
    await act(async () =>
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: 'control-1',
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
        errorCode: 'tts_failed',
        errorPresentation: 'notice',
      }),
    );
    expect(hook.getCurrent()).toMatchObject({
      live: true,
      availability: 'recoverable',
      primaryAction: 'start',
      recoveryAvailable: false,
      canDismissFailedAttempt: true,
      ended: null,
    });
    // Only clearing the canonical failure returns every consumer to the idle start control.
    await act(async () =>
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      }),
    );
    expect(hook.getCurrent()).toMatchObject({
      live: false,
      availability: 'ready',
      primaryAction: 'start',
      markPose: 'mic',
      recoveryAvailable: false,
      canDismissFailedAttempt: false,
    });
    await hook.unmount();
  });

  it('says the previous session could not stop, with Retry, instead of the generic service message', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'error',
      mode: 'idle',
      canStop: false,
      errorCode: 'service_temporarily_unavailable',
      errorMessage: 'voice_previous_session_stop_failed',
      errorPresentation: 'error',
      errorRecoveryAction: 'retry',
    });
    expect(hook.getCurrent()).toMatchObject({
      surfaceState: 'error',
      captionLabel: t(
        'settingsVoice.local.machineErrors.previous_session_stop_failed',
      ),
      recoveryAvailable: true,
      recoveryLabel: t('common.retry'),
    });
    await hook.unmount();
  });

  it('names a muted conversation "Muted" while its mode still says it is listening or speaking', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
      micMuted: true,
    });
    expect(hook.getCurrent().statusWord).toBe(t('voicePresence.muted'));
    expect(hook.getCurrent().statusWord).not.toBe(
      t('voiceAssistant.listening'),
    );
    await hook.unmount();
  });

  it('projects an unmuted but capture-closed attempt truthfully', async () => {
    const hook = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
      micMuted: false,
    });

    expect(hook.getCurrent().muted).toBe(false);
    expect(hook.getCurrent().capturing).toBe(false);
    expect(hook.getCurrent().micStateLabel).toBe(
      t('voiceSurface.a11y.microphoneInactive'),
    );
    expect(hook.getCurrent().captionLabel).toBe(
      t('voiceSurface.a11y.microphoneInactive'),
    );

    let writer: ReturnType<typeof voiceRuntimeLevelStore.open> | null = null;
    await act(async () => {
      writer = voiceRuntimeLevelStore.open({
        channel: 'input',
        sourceId: 'attempt-control-test',
      });
    });
    expect(hook.getCurrent().capturing).toBe(true);
    expect(hook.getCurrent().micStateLabel).toBe(
      t('voiceSurface.a11y.microphoneActive'),
    );

    await act(async () => {
      writer?.close();
    });
    await hook.unmount();
  });

  it('keeps ready and connecting captions placement-neutral and privacy-safe', async () => {
    const ready = await renderControl({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
      micMuted: false,
    });
    expect(ready.getCurrent().captionLabel).toBe(
      t('voiceSurface.a11y.microphoneInactive'),
    );
    await ready.unmount();

    const connecting = await renderControl({
      adapterId: 'local_conversation',
      sessionId: 'control-1',
      status: 'connecting',
      mode: 'idle',
      canStop: true,
      micMuted: false,
    });
    expect(connecting.getCurrent().surfaceState).toBe('connecting');
    expect(connecting.getCurrent().captionLabel).toBe(
      t('voiceSurface.a11y.microphoneInactive'),
    );
    await connecting.unmount();
  });
});

/**
 * §2.5 — targeting is **explicit at the call site and never inferred**.
 *
 * The projection hardcoded Global. That is right for the orb and for New Session, and wrong for the
 * composer of an existing session: pressing its planet opened a conversation bound to nothing while
 * the user was looking at the session they meant to talk about. The idle target is now the caller's
 * statement of which conversation a *start* creates — and nothing else. Once an attempt is running
 * every surface mirrors and settles that exact attempt, so the idle target must not reach `stop`.
 */
describe('useVoiceAttemptControl idle targeting', () => {
  const READY_LOCAL_CONVERSATION = {
    providerId: 'local_conversation',
    ui: {
      activityFeedEnabled: false,
      scopeDefault: 'global',
      surfaceLocation: 'auto',
    },
    providers: {
      local_conversation: {
        schemaVersion: 1,
        config: { conversationMode: 'agent' },
      },
    },
  } as const;

  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([getActivatedAdapter('local_conversation')]);
    seedVoiceSettings(READY_LOCAL_CONVERSATION);
  });

  afterEach(async () => {
    standardCleanup();
    vi.restoreAllMocks();
    const { registerVoiceAdapters } =
      await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
  });

  async function renderControl(
    idleTarget: VoiceAttemptIdleTarget,
    wrapper?: React.ComponentType<React.PropsWithChildren>,
  ) {
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    return await renderHook(() => useVoiceAttemptControl(idleTarget), {
      wrapper,
    });
  }

  function HostedConversation({ children }: React.PropsWithChildren) {
    const [destination, setDestination] = React.useState('/settings/voice');
    const navigation = React.useMemo<DestinationNavigation>(
      () => ({
        push: (href) => setDestination(String(href)),
        replace: (href) => setDestination(String(href)),
        back: () => setDestination('/settings/voice'),
      }),
      [],
    );
    return (
      <DestinationInstanceHost
        tabId="voice-conversation-tab"
        ref={{ kind: 'voice', params: {} }}
        pathname={destination}
        focused
        visible
        navigation={navigation}
      >
        {children}
        <Text testID="voice-open-destination">{destination}</Text>
      </DestinationInstanceHost>
    );
  }

  async function installRoutingLifecycle(target: SessionAddress | null = null) {
    const runtime = await installElevenLabsLifecycle(target);
    return { ...runtime, start: sdk.startSession, stop: sdk.endSession };
  }

  it('surfaces a conversation approval while its bound coding Session has only blocked input', async () => {
    const target = { serverId: recoveryRuntime.serverId, sessionId: 'coding-target' };
    const routing = await installRoutingLifecycle(target);
    const hook = await renderControl({ kind: 'session', sessionAddress: target });
    await act(async () => { await hook.getCurrent().onToggle(); });
    expect(routing.controller.getSnapshot().status).toBe('connected');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const binding = voiceSessionBindingStore.getState().getByControlSessionId(target.sessionId);
    if (!binding) throw new Error('Expected the admitted conversation binding');
    const conversation = { serverId: target.serverId, sessionId: 'native-voice-conversation' };
    // Native Agent conversations have a distinct hidden Session; the hosted
    // fixture's default binding otherwise collapses conversation and target.
    await act(async () => {
      getStorage().setState((state) => ({ sessions: { ...state.sessions,
        [target.sessionId]: { ...state.sessions[target.sessionId]!, active: true, activeAt: Date.now(),
          pendingCount: 1, pendingBlockedCount: 1, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 },
        [conversation.sessionId]: createSessionFixture({ id: conversation.sessionId, serverId: conversation.serverId,
          metadata: { ...createSessionFixture().metadata!, systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } }),
      } }));
      voiceSessionBindingStore.getState().bind({ ...binding, conversationSessionId: conversation.sessionId,
        conversationSessionAddress: conversation, transcriptMode: 'native_session' });
    });
    try {
      expect(hook.getCurrent().pendingRequestSessionAddress).toEqual(target);
      expect(hook.getCurrent().statusCell).toBeNull();
      await act(async () => getStorage().setState((state) => ({
        sessions: {
          ...state.sessions,
          [conversation.sessionId]: {
            ...state.sessions[conversation.sessionId]!,
            active: true,
            activeAt: Date.now(),
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: Date.now(),
          },
        },
      })));
      expect(hook.getCurrent()).toMatchObject({
        statusCell: 'needs_you',
        pendingRequestSessionAddress: conversation,
      });
      // Settlement is pushed through the same Session owner. A coding request
      // remains reachable next; changing Voice's request focus decides neither.
      await act(async () => getStorage().setState((state) => ({
        sessions: {
          ...state.sessions,
          [conversation.sessionId]: { ...state.sessions[conversation.sessionId]!, pendingPermissionRequestCount: 0 },
          [target.sessionId]: { ...state.sessions[target.sessionId]!, active: true, activeAt: Date.now(),
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now() },
        },
      })));
      expect(hook.getCurrent()).toMatchObject({ statusCell: 'needs_you', pendingRequestSessionAddress: target });
    } finally {
      await act(async () => { await hook.getCurrent().onToggle(); });
      await hook.unmount();
    }
  });

  it('starts Global when the caller states the global idle target', async () => {
    const routing = await installRoutingLifecycle();
    const hook = await renderControl({ kind: 'global' });

    expect(hook.getCurrent().canStart).toBe(true);
    hook.getCurrent().onToggle();

    await waitForTestEvent(
      routing.controller.subscribe,
      routing.controller.getSnapshot,
      (snapshot) => snapshot.status === 'connected',
    );
    expect(routing.controller.getSnapshot().status).toBe('connected');
    expect(routing.controller.getAttemptTargetSessionAddress()).toBeNull();
    expect(routing.start).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it("setup's Try opened from a Session composer starts that Session's Voice (lab T1)", async () => {
    const target = { serverId: recoveryRuntime.serverId, sessionId: 'composer-session' };
    const routing = await installRoutingLifecycle(target);
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { useVoiceSetupBlock } = await import('@/voice/settings/setup/VoiceSetupItem');
    const credentials = connection?.credentials ?? null;
    const hook = await renderHook(
      () => useVoiceSetupBlock({
        layout: 'wide',
        inPlace: true,
        attemptTarget: { kind: 'session', sessionAddress: target },
      }),
      {
        wrapper: ({ children }) => (
          <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>
        ),
      },
    );
    try {
      const panel = hook.getCurrent()?.renderPanel?.({ close: () => {} });
      if (!React.isValidElement<{ model: import('@/voice/settings/setup/VoiceSetupPanel').VoiceSetupPanelModel }>(panel)) {
        throw new Error('Expected the in-place setup panel');
      }
      const { deriveVoiceSetupFacts } = await import('@/voice/settings/setup/voiceSetupFacts');
      const facts = deriveVoiceSetupFacts({ providerId: 'local_conversation', microphonePermission: 'granted', messages: [],
        readiness: { role: 'realtime_conversation', providerId: 'local_conversation', status: 'ready', code: 'ready',
          reasonKey: 'voice.readiness.ready', recoveryAction: 'none' } });
      const screen = await renderScreen(React.cloneElement(panel, { model: { ...panel.props.model, facts } }));
      try {
        expect(screen.findByTestId('voice-setup.step.first_turn.phrase')?.props.disabled).toBe(false);
        await act(async () => { screen.pressByTestId('voice-setup.step.first_turn.phrase'); });
        await waitForTestEvent(
          routing.controller.subscribe,
          routing.controller.getSnapshot,
          (snapshot) => snapshot.status === 'connected',
        );
        expect(routing.controller.getAttemptTargetSessionAddress()).toEqual(target);
      } finally { await screen.unmount(); }
    } finally {
      await hook.unmount();
    }
  });

  it.each(['setup', 'top_bar'] as const)('real setup Try refuses a targetless direct-session start with its admission reason and %s recovery', async (entry) => {
    const { setFocusedSessionId } = await import('@/sync/domains/session/sessionSurfaceVisibility');
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    setFocusedSessionId(null);
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
    seedVoiceSettings({ ...READY_LOCAL_CONVERSATION, providers: {
      local_conversation: { schemaVersion: 1, config: { conversationMode: 'direct_session' } },
    } });
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { useVoiceSetupBlock } = await import('@/voice/settings/setup/VoiceSetupItem');
    const { deriveVoiceSetupFacts } = await import('@/voice/settings/setup/voiceSetupFacts');
    const { VoiceTopBarPresence } = await import('@/components/voice/presence/VoiceTopBarPresence');
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    function Scene() {
      const block = useVoiceSetupBlock({ layout: 'wide' });
      const voice = useVoiceAttemptControl({ kind: 'default' });
      const panel = block?.renderPanel?.({ close: () => {} });
      if (!React.isValidElement<{
        model: import('@/voice/settings/setup/VoiceSetupPanel').VoiceSetupPanelModel;
      }>(panel)) throw new Error('Expected setup panel');
      // Service and microphone are ready in RUN104. Supply those independent
      // observations; keep the real block's admission and callback unchanged.
      const facts = deriveVoiceSetupFacts({ providerId: 'local_conversation', microphonePermission: 'granted', messages: [],
        readiness: { role: 'realtime_conversation', providerId: 'local_conversation', status: 'ready', code: 'ready',
          reasonKey: 'voice.readiness.ready', recoveryAction: 'none' } });
      return <>{React.cloneElement(panel, { model: { ...panel.props.model, facts } })}<VoiceTopBarPresence voice={voice} /></>;
    }
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection?.credentials ?? null}><Scene /></InjectedAuthProvider>);
    try {
      const button = screen.findByTestId('voice-setup.step.first_turn.phrase');
      expect(button).not.toBeNull();
      await act(async () => { screen.pressByTestId('voice-setup.step.first_turn.phrase'); });
      expect(button?.props.disabled).toBe(true);
      expect(screen.getTextContent()).toContain(t('commandPalette.commands.sessionRequiredBody'));
      expect(screen.findByTestId('voice-top-bar-rest')?.props.accessibilityLabel).toBe(t('commandPalette.commands.newSessionTitle'));
      await act(async () => { screen.pressByTestId(entry === 'setup'
        ? 'voice-setup.step.first_turn.recover' : 'voice-top-bar-rest'); });
      expect(readLastPushedHref()).toBe('/new');
      const { voiceSessionManager } = await import('@/voice/session/voiceSession');
      expect(voiceSessionManager.getSnapshot().status).toBe('disconnected');
    } finally { await screen.unmount(); }
  });

  it('offers New conversation only beside an admitted executable Start that would not already start fresh', async () => {
    const offered = await renderControl({ kind: 'global' });
    expect(offered.getCurrent().canStart).toBe(true);
    expect(typeof offered.getCurrent().onNewConversation).toBe('function');
    await offered.unmount();

    // Start already opens a fresh conversation each time: a second control would say the same thing.
    seedVoiceSettings({
      ...READY_LOCAL_CONVERSATION,
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: 'agent',
            agent: { rootSessionPolicy: 'new' },
          },
        },
      },
    });
    const startIsNew = await renderControl({ kind: 'global' });
    expect(startIsNew.getCurrent().canStart).toBe(true);
    expect(startIsNew.getCurrent().onNewConversation).toBeUndefined();
    await startIsNew.unmount();

    // Talking straight to a Session has no Voice conversation of its own to renew.
    seedVoiceSettings({
      ...READY_LOCAL_CONVERSATION,
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'direct_session' },
        },
      },
    });
    const direct = await renderControl({
      kind: 'session',
      sessionAddress: { serverId: 'server-b', sessionId: 'session-42' },
    });
    expect(direct.getCurrent().onNewConversation).toBeUndefined();
    await direct.unmount();
  });

  it('starts the exact session the caller states', async () => {
    const routing = await installRoutingLifecycle();
    const hook = await renderControl({
      kind: 'session',
      sessionAddress: { serverId: 'server-b', sessionId: 'session-42' },
    });

    expect(hook.getCurrent().canStart).toBe(true);
    hook.getCurrent().onToggle();

    await waitForTestEvent(
      routing.controller.subscribe,
      routing.controller.getAttemptTargetSessionAddress,
      (address) =>
        address?.serverId === 'server-b' && address.sessionId === 'session-42',
    );
    expect(routing.controller.getAttemptTargetSessionAddress()).toEqual({
      serverId: 'server-b',
      sessionId: 'session-42',
    });

    await hook.unmount();
  });

  it('reads only recovery facts from the target Session while its record changes during a turn', async () => {
    const sessionAddress = { serverId: 'server-b', sessionId: 'session-quiet' };
    const session = createSessionFixture({
      id: sessionAddress.sessionId,
      serverId: sessionAddress.serverId,
      seq: 1,
      metadata: { path: '/tmp', host: 'host', machineId: 'machine-a' },
    });
    getStorage().getState().applySessions([session]);
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    let renders = 0;
    const hook = await renderHook(() => {
      renders += 1;
      return useVoiceAttemptControl({ kind: 'session', sessionAddress });
    });
    await flushHookEffects();
    renders = 0;
    for (let write = 2; write <= 6; write += 1) {
      await act(async () => {
        const current = getStorage().getState().sessions[sessionAddress.sessionId]!;
        getStorage().getState().applySessions([{ ...current, seq: write, updatedAt: 1000 + write,
          meaningfulActivityAt: 1000 + write, lastViewedSessionSeq: write }], 'projection');
      });
    }
    expect(renders).toBe(0);
    await hook.unmount();
  });

  it('freezes the normalized idle target for the mounted attempt instead of observing later mutation', async () => {
    const routing = await installRoutingLifecycle();
    const suppliedAddress = {
      serverId: ' server-b ',
      sessionId: ' shared-session ',
    };
    const hook = await renderControl({
      kind: 'session',
      sessionAddress: suppliedAddress,
    });

    suppliedAddress.serverId = 'server-a';
    suppliedAddress.sessionId = 'different-session';
    hook.getCurrent().onToggle();

    await waitForTestEvent(
      routing.controller.subscribe,
      routing.controller.getAttemptTargetSessionAddress,
      (address) =>
        address?.serverId === 'server-b' &&
        address.sessionId === 'shared-session',
    );
    expect(routing.controller.getAttemptTargetSessionAddress()).toEqual({
      serverId: 'server-b',
      sessionId: 'shared-session',
    });
    await hook.unmount();
  });

  it('settles the running attempt’s own session, not the idle target and not Global', async () => {
    const target = {
      serverId: recoveryRuntime.serverId,
      sessionId: 'attempt-session',
    };
    const routing = await installRoutingLifecycle(target);
    await startVoiceRuntime(target);
    expect(routing.controller.getSnapshot().status).toBe('connected');
    expect(routing.controller.getSnapshot().sessionId).toBe('attempt-session');
    const starts = routing.start.mock.calls.length;
    // A session-bound surface whose own session is *not* the running attempt's: the attempt is
    // immutable, so the surface controls that one rather than retargeting it.
    const hook = await renderControl({
      kind: 'session',
      sessionAddress: { serverId: 'server-b', sessionId: 'session-42' },
    });

    expect(hook.getCurrent().canStop).toBe(true);
    hook.getCurrent().onToggle();

    await waitForTestEvent(
      routing.controller.subscribe,
      routing.controller.getSnapshot,
      (snapshot) => snapshot.status === 'disconnected',
    );
    expect(routing.controller.getSnapshot().status).toBe('disconnected');
    expect(routing.stop).toHaveBeenCalledTimes(1);
    expect(routing.start).toHaveBeenCalledTimes(starts);

    await hook.unmount();
  });

  it('honors Action admission for the visible End control before touching audio', async () => {
    const target = {
      serverId: recoveryRuntime.serverId,
      sessionId: 'attempt-session',
    };
    const routing = await installRoutingLifecycle(target);
    await startVoiceRuntime(target);
    getStorage().setState((state) => ({
      settings: {
        ...state.settings,
        actionsSettingsV1: ActionsSettingsV1Schema.parse({
          ...state.settings.actionsSettingsV1,
          actions: {
            ...state.settings.actionsSettingsV1.actions,
            'ui.voice_global.end': { disabledSurfaces: ['ui'] },
          },
        }),
      },
    }));
    const endSettled = createDeferred<void>();
    const diagnostic = vi
      .spyOn(console, 'info')
      .mockImplementation((message) => {
        if (message === '[fireAndForget] VoiceAttemptControl.stop')
          endSettled.resolve();
      });
    routing.stop.mockImplementation(async () => {
      endSettled.resolve();
    });
    const hook = await renderControl(GLOBAL_TARGET);
    hook.getCurrent().onToggle();
    // Wait for either the rejected Action's diagnostic or the incorrect audio effect.
    await endSettled.promise;
    expect(
      Number(
        diagnostic.mock.calls.some(
          ([message]) => message === '[fireAndForget] VoiceAttemptControl.stop',
        ),
      ) + routing.stop.mock.calls.length,
    ).toBeGreaterThan(0);
    expect(routing.controller.getSnapshot().status).toBe('connected');
    expect(routing.stop).not.toHaveBeenCalled();
    await act(async () =>
      getStorage().setState((state) => ({
        settings: {
          ...state.settings,
          actionsSettingsV1: {
            ...state.settings.actionsSettingsV1,
            actions: {},
          },
        },
      })),
    );
    hook.getCurrent().onToggle();
    await waitForTestEvent(
      routing.controller.subscribe,
      routing.controller.getSnapshot,
      (snapshot) => snapshot.status === 'disconnected',
    );
    expect(routing.controller.getSnapshot().status).toBe('disconnected');
    await hook.unmount();
  });

  it('opens the exact conversation bound to the active attempt, not the idle target', async () => {
    const { voiceSessionBindingStore } =
      await import('@/voice/binding/voiceConversationBindingStore');
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    routerMock.instance?.spies.push.mock.calls.splice(0);
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'active-control-session',
      conversationSessionId: 'active-conversation-session',
      conversationSessionAddress: {
        serverId: recoveryRuntime.serverId,
        sessionId: 'active-conversation-session',
      },
      lifetime: 'runtime_attempt',
      transcriptMode: 'native_session',
      targetSessionAddress: {
        serverId: recoveryRuntime.serverId,
        sessionId: 'active-conversation-session',
      },
      updatedAt: 42,
    });
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'active-control-session',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    // The surface's idle target deliberately names a different session. Once an attempt is
    // active, opening the Orb must follow its immutable canonical binding instead.
    const hook = await renderControl(
      {
        kind: 'session',
        sessionAddress: {
          serverId: recoveryRuntime.serverId,
          sessionId: 'idle-target-session',
        },
      },
      HostedConversation,
    );

    expect(hook.getCurrent().openConversationSessionId).toBe(
      'active-conversation-session',
    );
    expect(hook.getCurrent().openConversationSessionAddress).toEqual({
      serverId: recoveryRuntime.serverId,
      sessionId: 'active-conversation-session',
    });
    expect(hook.getCurrent().elapsedStartedAt).toEqual(expect.any(Number));
    await act(async () => hook.getCurrent().onOpenConversation());
    expect(
      hook.tree.root.findByProps({ testID: 'voice-open-destination' }).props
        .children,
    ).toBe(
      `/session/active-conversation-session?serverId=${recoveryRuntime.serverId}`,
    );

    await hook.unmount();
    voiceSessionBindingStore.getState().unbind('active-conversation-session');
  });

  it.each([
    'voice_conversation',
    'voice_carrier',
    'voice_conversation_retired',
  ])(
    'hides a %s target while retaining its exact request and navigation addresses',
    async (key) => {
      const { voiceSessionBindingStore } =
        await import('@/voice/binding/voiceConversationBindingStore');
      const address = {
        serverId: recoveryRuntime.serverId,
        sessionId: 'hidden-target',
      };
      const routing = await installRoutingLifecycle(address);
      await startVoiceRuntime(address);
      expect(routing.controller.getAttemptTargetSessionAddress()).toEqual(
        address,
      );
      const session = createSessionFixture({
        id: address.sessionId,
        serverId: address.serverId,
        active: true,
        activeAt: Date.now(),
        pendingCount: 3,
        pendingBlockedCount: 3,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        metadata: {
          ...createSessionFixture().metadata!,
          name: 'Voice conversation (system)',
          systemSessionV1: { v: 1, key, hidden: true },
        },
      });
      getStorage().setState((state) => ({
        sessions: { ...state.sessions, [session.id]: session },
      }));
      const binding = voiceSessionBindingStore
        .getState()
        .getByControlSessionId(address.sessionId);
      const { useVoiceAttemptControl } =
        await import('./useVoiceAttemptControl');
      const { useVoiceHistoryPendingRecovery } =
        await import('@/voice/history/useVoiceHistoryPendingRecovery');
      let renders = 0;
      const delivery = observeStorageSubscriptionDeliveries();
      const hook = await renderHook(() => {
        renders += 1;
        const control = useVoiceAttemptControl(GLOBAL_TARGET);
        const pendingRecovery = useVoiceHistoryPendingRecovery(
          control.pendingRequestSessionAddress ?? null,
        );
        return { ...control, pendingRecovery };
      });
      try {
        expect(hook.getCurrent().targetSessionAddress).toBeNull();
        expect(hook.getCurrent().statusCell).toBeNull();
        expect(hook.getCurrent().statusWord).toBe(
          hook.getCurrent().statusLabel,
        );
        expect(hook.getCurrent().pendingRecovery).toMatchObject({ address });
        const [
          { createWorkspaceState, reduceWorkspaceState },
          { createWorkspaceNavigationAdapter },
          { createWorkspaceActionAdapter },
          { resolveCompactAppDestinations },
        ] = await Promise.all([
          import('@/components/appShell/workspace/workspaceState'),
          import('@/components/appShell/workspace/workspaceNavigationAdapter'),
          import('@/components/appShell/workspace/workspaceActions'),
          import('@/components/appShell/destinations/compactAppDestinationCatalog'),
        ]);
        let workspace = createWorkspaceState({
          id: 'history-tab',
          target: { kind: 'voice', params: {} },
          pinned: false,
          preview: false,
        });
        const catalog = resolveCompactAppDestinations({
          builtins: {
            externalSessions: false,
            inbox: true,
            workflows: true,
            friends: false,
          },
          pages: [],
        });
        const navigation = createWorkspaceNavigationAdapter({
          getState: () => workspace,
          getCatalog: () => catalog,
          dispatch: (action) => {
            workspace = reduceWorkspaceState(workspace, action);
          },
          transport: { commit() {} },
          createId: () => 'recovery-tab',
          onChange() {},
        });
        const execute = createWorkspaceActionAdapter({
          getState: () => workspace,
          navigation,
          readCanvas: () => null,
          createId: () => 'recovery-tab',
        });
        const recovery = hook.getCurrent().pendingRecovery;
        if (!recovery) throw new Error('Expected canonical Pending recovery');
        expect(
          execute(recovery.openAction.actionId, recovery.openAction.input),
        ).toMatchObject({ ok: true });
        expect(
          workspace.tabs[workspace.groups[workspace.focusedGroupId].activeTabId]
            .target,
        ).toMatchObject({
          kind: 'session',
          params: { id: address.sessionId, serverId: address.serverId },
        });
        expect(hook.getCurrent().pendingRequestSessionAddress).toEqual(address);
        expect(hook.getCurrent().openConversationSessionAddress).toEqual(
          address,
        );
        expect(
          voiceSessionBindingStore
            .getState()
            .getByControlSessionId(address.sessionId),
        ).toEqual(binding);
        await flushHookEffects();
        const baseline = renders;
        delivery.reset();
        await act(async () =>
          getStorage().setState((state) => ({
            sessions: {
              ...state.sessions,
              unrelated: createSessionFixture({
                id: 'unrelated',
                serverId: address.serverId,
              }),
            },
          })),
        );
        expect(renders).toBe(baseline);
        expect(delivery.count).toBe(0);
        await act(async () =>
          getStorage().setState((state) => ({
            sessions: {
              ...state.sessions,
              [session.id]: {
                ...session,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: Date.now(),
                agentState: {
                  requests: {
                    question: { tool: 'AskUserQuestion', kind: 'user_action' as const,
                      arguments: {}, createdAt: Date.now() },
                  },
                },
              },
            },
          })),
        );
        expect(hook.getCurrent().statusCell).toBe('needs_you');
        expect(hook.getCurrent().statusWord).toBe(
          t('workStatus.buckets.needs_you'),
        );
        expect(hook.getCurrent().pendingRecovery).toMatchObject({ address });
        await act(async () =>
          getStorage().setState((state) => ({
            sessions: {
              ...state.sessions,
              [session.id]: {
                ...session,
                metadata: {
                  ...session.metadata!,
                  systemSessionV1: { v: 1, key, hidden: false },
                },
              },
            },
          })),
        );
        expect(hook.getCurrent().targetSessionAddress).toEqual(address);
        expect(hook.getCurrent().pendingRecovery).toBeNull();
        expect(hook.getCurrent().openConversationSessionAddress).toEqual(
          address,
        );
        await act(async () =>
          getStorage().setState((state) => ({
            sessions: {
              ...state.sessions,
              [session.id]: {
                ...session,
                pendingCount: 0,
                pendingBlockedCount: 0,
              },
            },
          })),
        );
        expect(hook.getCurrent().pendingRecovery).toBeNull();
      } finally {
        await hook.unmount();
        delivery.restore();
        voiceSessionBindingStore.getState().unbind(address.sessionId);
      }
    },
  );

  it('names an ended conversation from its captured provider after the live binding is removed', async () => {
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { setVoiceSessionSnapshot, dismissVoiceSessionEndedAttempt } = await import('@/voice/session/voiceSessionStore');
    const { useVoiceConversationHeaderSubtitle } = await import('@/voice/presence/useVoiceConversationHeaderSubtitle');
    const { writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
    seedVoiceSettings({
      ...writeVoiceProviderSettingsConfig(getStorage().getState().settings.voice,
        'happier.voice.elevenlabs/realtime-elevenlabs', ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS),
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    });
    const accountScope = initialStorageState.profileScope!;
    const address = { serverId: accountScope.serverId, sessionId: 'ended-local-conversation' };
    const binding = {
      adapterId: 'local_conversation', controlSessionId: 'ended-local-control',
      conversationSessionId: address.sessionId, conversationSessionAddress: address,
      transcriptMode: 'native_session' as const, targetSessionAddress: null, updatedAt: 45,
    };
    voiceSessionBindingStore.getState().bind(binding);
    setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId,
      status: 'connected', mode: 'listening', canStop: true }, binding,
      { accountScope, conversationScope: { kind: 'voice_home' } });
    const metadata = { hiddenSystemSession: true, systemSessionKind: 'voice_custody' };
    const header = await renderHook(() => useVoiceConversationHeaderSubtitle(metadata, address));
    try {
      await act(async () => {
        setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
        voiceSessionBindingStore.getState().unbind(address.sessionId);
      });
      expect(header.getCurrent()).toBe(`${t('voiceMoments.globalVoice')} · ${t('settingsVoice.mode.local')}`);
    } finally {
      await header.unmount();
      dismissVoiceSessionEndedAttempt();
      voiceSessionBindingStore.getState().unbind(address.sessionId);
    }
  });

  it('opens the retained carrier for a targetless runtime attempt without rebinding', async () => {
    const { voiceSessionBindingStore } =
      await import('@/voice/binding/voiceConversationBindingStore');
    const { setVoiceSessionSnapshot } =
      await import('@/voice/session/voiceSessionStore');
    const binding = {
      adapterId: 'local_conversation',
      controlSessionId: 'global-control',
      conversationSessionId: 'hidden-history',
      conversationSessionAddress: {
        serverId: recoveryRuntime.serverId,
        sessionId: 'hidden-history',
      },
      lifetime: 'runtime_attempt' as const,
      transcriptMode: 'synthetic' as const,
      targetSessionAddress: null,
      updatedAt: 43,
    };
    voiceSessionBindingStore.getState().bind(binding);
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: 'global-control',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    const hook = await renderControl(GLOBAL_TARGET, HostedConversation);
    expect(hook.getCurrent().canOpenConversation).toBe(true);
    expect(hook.getCurrent().openConversationSessionAddress).toEqual(binding.conversationSessionAddress);
    await act(async () => hook.getCurrent().onOpenConversation());
    expect(
      hook.tree.root.findByProps({ testID: 'voice-open-destination' }).props
        .children,
    ).toBe(`/session/hidden-history?serverId=${recoveryRuntime.serverId}`);
    expect(
      voiceSessionBindingStore
        .getState()
        .getByControlSessionId('global-control'),
    ).toEqual(binding);
    await hook.unmount();
    voiceSessionBindingStore.getState().unbind('hidden-history');
  });

  it.each([
    {
      lifetime: 'runtime_attempt' as const,
      target: { serverId: 'ended-home', sessionId: 'coding-target' },
      destination: '/session/coding-target?serverId=ended-home',
    },
    {
      lifetime: 'runtime_attempt' as const,
      target: null,
      destination: '/session/saved-conversation?serverId=ended-home',
    },
    {
      lifetime: undefined,
      target: { serverId: 'ended-home', sessionId: 'coding-target' },
      destination: '/session/saved-conversation?serverId=ended-home',
    },
  ])(
    'opens the captured ended destination from VoiceGlance after binding removal ($destination)',
    async ({ lifetime, target, destination }) => {
      const { voiceSessionBindingStore } =
        await import('@/voice/binding/voiceConversationBindingStore');
      const { setVoiceSessionSnapshot, dismissVoiceSessionEndedAttempt } =
        await import('@/voice/session/voiceSessionStore');
      const accountScope = initialStorageState.profileScope!;
      const admittedTarget = target
        ? { ...target, serverId: accountScope.serverId }
        : null;
      const binding = {
        adapterId: 'local_conversation',
        controlSessionId: 'ended-control',
        conversationSessionId: 'saved-conversation',
        conversationSessionAddress: {
          serverId: accountScope.serverId,
          sessionId: 'saved-conversation',
        },
        lifetime,
        transcriptMode: 'synthetic' as const,
        targetSessionAddress: admittedTarget,
        updatedAt: 44,
      };
      voiceSessionBindingStore.getState().bind(binding);
      setVoiceSessionSnapshot(
        {
          adapterId: binding.adapterId,
          sessionId: binding.controlSessionId,
          status: 'connected',
          mode: 'listening',
          canStop: true,
        },
        binding,
        { accountScope, conversationScope: { kind: 'voice_home' } },
      );
      const { useVoiceSurfaceModel } = await import('@/components/voice/surface/useVoiceSurfaceModel');
      const { VoiceGlance } = await import('@/components/voice/presence/VoiceGlance');
      function EndedGlance({ children }: React.PropsWithChildren) {
        const model = useVoiceSurfaceModel({ variant: 'sidebar' });
        return <>{children}{model ? <VoiceGlance model={model} presentation="popover" /> : null}</>;
      }
      const hook = await renderControl({
        kind: 'session',
        sessionAddress: { serverId: 'new-home', sessionId: 'new-target' },
      }, EndedGlance);
      try {
        await act(async () => {
          setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
          });
          voiceSessionBindingStore
            .getState()
            .unbind(binding.conversationSessionId);
        });
        expect(hook.getCurrent().canOpenConversation).toBe(true);
        expect(hook.getCurrent().targetSessionAddress).toEqual(admittedTarget);
        await act(async () => {
          await hook.tree.root.findByProps({ testID: 'voice-glance-open-conversation' }).props.onPress();
        });
        expect(routerMock.instance?.spies.push.mock.calls.at(-1)?.[0]).toBe(
          destination.replace('ended-home', accountScope.serverId),
        );
        expect(
          voiceSessionBindingStore
            .getState()
            .getByControlSessionId(binding.controlSessionId),
        ).toBeNull();
        const capturedOpenConversation = hook.getCurrent().onOpenConversation;
        await act(async () => {
          getStorage().setState({
            profileScope: { ...accountScope, accountId: 'other-account' },
          });
        });
        expect(hook.getCurrent().canOpenConversation).toBe(false);
        expect(hook.getCurrent().targetSessionAddress).toBeNull();
        const previousRoute = routerMock.instance?.spies.push.mock.calls.at(-1);
        capturedOpenConversation();
        await act(async () => {
          await hook.getCurrent().onOpenConversation();
        });
        expect(routerMock.instance?.spies.push.mock.calls.at(-1)).toBe(
          previousRoute,
        );
      } finally {
        await hook.unmount();
        dismissVoiceSessionEndedAttempt();
        voiceSessionBindingStore
          .getState()
          .unbind(binding.conversationSessionId);
      }
    },
  );
});

/**
 * An adapter reports a connection failure through the canonical lifecycle snapshot before its
 * Start promise rejects. The attempt control is the real fire-and-forget consumer shared by the
 * orb, the composer, and Horizon, so it must leave that already-visible recovery unobscured while
 * preserving unexpected rejections for diagnostics.
 */
describe('useVoiceAttemptControl terminal connection failures', () => {
  const PROVIDER_ID = 'local_conversation';

  beforeEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } =
      await import('@/voice/session/voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
    getStorage().setState(initialStorageState, true);
    setVoiceAgentFeature(true);
    seedVoiceSettings({
      providerId: PROVIDER_ID,
      ui: {
        activityFeedEnabled: false,
        scopeDefault: 'global',
        surfaceLocation: 'auto',
      },
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });
  });

  afterEach(async () => {
    standardCleanup();
    const { resetVoiceSessionRuntimeStateForTests } =
      await import('@/voice/session/voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
    getStorage().setState(initialStorageState, true);
    vi.restoreAllMocks();
  });

  it('offers Retry and Dismiss when the cold Voice Action chunk cannot be fetched', async () => {
    const { Modal } = await import('@/modal');
    const notice = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
    const { controller } = await installElevenLabsLifecycle();
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    const { getVoiceSessionPresentedAttemptId } = await import('@/voice/session/voiceSessionStore');
    const hook = await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));
    const online = vi.spyOn(navigator, 'onLine', 'get');
    try {
      expect(hook.getCurrent().canStart).toBe(true);
      online.mockReturnValue(false);
      vi.doMock('@/sync/ops/actions/voiceConversationAction', () => {
        // The installed Expo production web loader reports a failed script request this way.
        throw Object.assign(new Error('Loading module /voiceConversationAction.js failed.\n(error: /voiceConversationAction.js)'), {
          name: 'AsyncRequireError', type: 'error', request: '/voiceConversationAction.js',
        });
      });
      await act(async () => { await hook.getCurrent().onToggle(); });
      expect(getVoiceSessionPresentedAttemptId()).toBeNull();
      expect(notice).toHaveBeenCalledWith(
        t('voiceAssistant.connectionError'),
        t('settingsPlugins.targetSelection.unreachableThisHome'),
        expect.arrayContaining([
          expect.objectContaining({ text: t('common.retry'), onPress: expect.any(Function) }),
          expect.objectContaining({ text: expect.any(String), style: 'cancel' }),
        ]),
        { commandBridge: expect.any(Function) },
      );
      const dismissLabel = notice.mock.lastCall?.[2]?.find(button => button.style === 'cancel')?.text;
      expect(dismissLabel).not.toMatch(/^[\w-]+(?:\.[\w-]+)+$/);
      expect(dismissLabel).toBe(t('common.close'));
      vi.doUnmock('@/sync/ops/actions/voiceConversationAction');
      online.mockReturnValue(true);
      const retry = notice.mock.lastCall?.[2]?.find(button => button.text === t('common.retry'))?.onPress;
      await act(async () => { await retry?.(); });
      expect(controller.getSnapshot().status).toBe('connected');
    } finally {
      online.mockRestore();
      vi.doUnmock('@/sync/ops/actions/voiceConversationAction');
      await hook.unmount();
    }
  });

  it('offers Retry after a terminal SDK disconnect and starts a fresh attempt', async () => {
    const { controller } = await installElevenLabsLifecycle();
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    const { getVoiceSessionPresentedAttemptId } =
      await import('@/voice/session/voiceSessionStore');
    await startVoiceRuntime(null);
    expect(controller.getSnapshot().status).toBe('connected');
    const admittedAttempt = getVoiceSessionPresentedAttemptId();
    const hook = await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));
    try {
      const options = sdk.startSession.mock.calls[0]?.[0];
      if (!options?.onDisconnect)
        throw new Error('Vendor SDK did not receive its disconnect callback');
      await act(async () => {
        options.onDisconnect?.({
          reason: 'error',
          message: 'Transport closed',
          context: { type: 'close', code: 1006 },
        });
      });
      await waitForTestEvent(hook.subscribe, () =>
        expect(hook.getCurrent().recoveryAvailable).toBe(true),
      );
      // ElevenLabs SDK 1.18 ends the conversation after its own reconnect
      // lifecycle; the canonical SDK owner publishes a terminal failure.
      expect(controller.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'voice_service_unavailable',
        errorRecoveryAction: 'retry',
      });
      expect(sdk.startSession).toHaveBeenCalledTimes(1);
      expect(hook.getCurrent().recoveryLabel).toBe(t('common.retry'));
      expect(hook.getCurrent().recoveryIcon).toBe('arrow-clockwise');
      await act(async () => {
        await hook.getCurrent().onRecover();
      });
      await waitForTestEvent(
        controller.subscribe,
        controller.getSnapshot,
        (snapshot) => snapshot.status === 'connected',
      );
      expect(controller.getSnapshot().status).toBe('connected');
      expect(sdk.startSession).toHaveBeenCalledTimes(2);
      expect(getVoiceSessionPresentedAttemptId()).not.toBe(admittedAttempt);
      expect(controller.getAttemptTargetSessionAddress()).toBeNull();
    } finally {
      await hook.unmount();
    }
  });

  it('keeps a published connection failure recoverable without logging through fire-and-forget', async () => {
    const connectionFailure = Object.assign(
      new Error('voice_connection_failed'),
      {
        code: 'voice_connection_failed',
      },
    );
    sdk.startSession.mockRejectedValue(connectionFailure);
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { controller } = await installElevenLabsLifecycle();
    const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
    const hook = await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));

    await act(async () => {
      await hook.getCurrent().onToggle();
    });

    expect(hook.getCurrent().primaryAction).toBe('recover');
    expect(hook.getCurrent().recoveryLabel).toBe(t('common.retry'));
    await act(async () => {
      expect(await hook.getCurrent().onRecover()).toBe(true);
    });
    expect(hook.getCurrent().primaryAction).toBe('recover');
    // Retry retains the admitted Global target; the provider's synthetic carrier id
    // is not a new requested Session target.
    expect(sdk.startSession).toHaveBeenCalledTimes(2);
    expect(controller.getAttemptTargetSessionAddress()).toBeNull();
    expect(hook.getCurrent().canDismissFailedAttempt).toBe(true);
    expect(hook.getCurrent().ended).toBeNull();
    await act(async () => {
      await hook.getCurrent().onDismissFailedAttempt?.();
    });
    expect(hook.getCurrent().surfaceState).toBe('idle');
    expect(hook.getCurrent().markPose).toBe('mic');
    expect(hook.getCurrent().recoveryAvailable).toBe(false);
    expect(hook.getCurrent().canDismissFailedAttempt).toBe(false);
    expect(hook.getCurrent().ended).toBeNull();
    expect(
      consoleInfo.mock.calls.some(([entry]) =>
        String(entry).includes('[fireAndForget] VoiceAttemptControl.'),
      ),
    ).toBe(false);

    await hook.unmount();
  });

  it.each(['start', 'retry'] as const)(
    'refuses a retained %s after its Account retires without changing the next Account',
    async (operation) => {
      if (operation === 'retry') {
        sdk.startSession.mockRejectedValue(Object.assign(new Error('voice_connection_failed'), {
          code: 'voice_connection_failed',
        }));
      }
      await installElevenLabsLifecycle();
      const { useVoiceAttemptControl } = await import('./useVoiceAttemptControl');
      const hook = await renderHook(() => useVoiceAttemptControl(GLOBAL_TARGET));
      if (operation === 'retry') {
        await act(async () => { await hook.getCurrent().onToggle(); });
        expect(hook.getCurrent().primaryAction).toBe('recover');
      } else {
        expect(hook.getCurrent().canStart).toBe(true);
      }
      const retained = operation === 'retry' ? hook.getCurrent().onRecover : hook.getCurrent().onToggle;
      const starts = sdk.startSession.mock.calls.length;
      await act(async () => {
        await connection?.dispose();
        connection = undefined;
        await restoreAttemptAccount('next-attempt-account');
      });
      const { voiceSessionManager } = await import('@/voice/session/voiceSession');
      const nextSnapshot = voiceSessionManager.getSnapshot();
      await act(async () => { expect(await retained()).toBe(false); });
      expect(getStorage().getState().profileScope?.accountId).toBe('next-attempt-account');
      expect(voiceSessionManager.getSnapshot()).toEqual(nextSnapshot);
      expect(sdk.startSession).toHaveBeenCalledTimes(starts);
      await hook.unmount();
    },
  );
});

describe('Voice setup dismissal through the current Home Artifact owner', () => {
  it('hides the setup-pose mic after the real Home dismissal is persisted', async () => {
    let connection:
      | Awaited<
          ReturnType<
            (typeof import('@/dev/testkit/harness/serverAccountConnectionHarness'))['restoreServerAccountForTest']
          >
        >
      | undefined;
    let restoreActionLoader: (() => void) | undefined;
    let restoreWebLocks: (() => void) | undefined;
    let unmount: (() => Promise<void>) | undefined;
    try {
      // jsdom omits the browser LockManager used by the real Home mutation owner.
      const { installWebLockManagerMock } =
        await import('@/auth/storage/tokenStorage.web.testHelpers');
      restoreWebLocks = installWebLockManagerMock().restore;
      const { loadSyncSingletonForTests } =
        await import('@/dev/testkit/harness/syncSingletonLoader');
      await loadSyncSingletonForTests();
      const { installRealActionExecutorModuleLoader } =
        await import('@/dev/testkit/harness/actionHomesHttpHarness');
      restoreActionLoader = await installRealActionExecutorModuleLoader();
      const { createHomeHubArtifactHttpBoundary } =
        await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
      const { restoreServerAccountForTest } =
        await import('@/dev/testkit/harness/serverAccountConnectionHarness');
      const { createRootLayoutFeaturesResponse } =
        await import('@/dev/testkit/fixtures/featureFixtures');
      const { tryWriteServerEnabledBitInPlace} =
        await import('@happier-dev/protocol/features/serverEnabledBit');
      const { normalizeHomeHubLayoutV1, listHiddenHomeSetupSteps } =
        await import('@happier-dev/protocol/home');
      const artifact = createHomeHubArtifactHttpBoundary(
        'voice-dismiss-account',
      );
      artifact.seed(normalizeHomeHubLayoutV1(undefined));
      const features = createRootLayoutFeaturesResponse();
      if (!tryWriteServerEnabledBitInPlace(features, 'voice', true))
        throw new Error('Voice feature fixture unavailable');
      connection = await restoreServerAccountForTest({
        serverUrl: 'https://voice-dismiss.example.test',
        accountId: 'voice-dismiss-account',
        activation: 'switch',
        request: (input, init) =>
          new URL(String(input)).pathname === '/v1/features'
            ? Promise.resolve(Response.json(features))
            : artifact.request(input, init),
      });
      const { sync } = await import('@/sync/sync');
      const settingsQueue = Reflect.get(
        sync,
        'settingsSync',
      ) as import('@/utils/sessions/sync').InvalidateSync;
      await settingsQueue.awaitQueue();
      const { storage } = await import('@/sync/domains/state/storage');
      const { settingsParse } =
        await import('@/sync/domains/settings/settings');
      const scope = {
        serverId: connection.home.id,
        accountId: 'voice-dismiss-account',
      };
      storage.setState({
        isDataReady: true,
        profileScope: scope,
        settingsScope: scope,
        settings: settingsParse({
          featureToggles: { voice: true },
          voiceSettingsV1: {
            providerId: null,
            ui: {
              activityFeedEnabled: false,
              scopeDefault: 'global',
              surfaceLocation: 'auto',
            },
          },
        }),
      });
      const { InjectedAuthProvider } =
        await import('@/auth/context/AuthContext');
      const { useVoiceAttemptControl } =
        await import('./useVoiceAttemptControl');
      const { useVoiceSurfaceModel } =
        await import('@/components/voice/surface/useVoiceSurfaceModel');
      const { useHomeSetupDismissals } =
        await import('@/components/hub/layout/useHomeSetupDismissals');
      const { VOICE_SETUP_STEP_ID } =
        await import('@/voice/settings/setup/useVoiceSetupItem');
      const { renderHook: renderCurrentHook } =
        await import('@/dev/testkit/hooks/renderHook');
      const { flushHookEffects } = await import('@/dev/testkit');
      const credentials = connection.credentials;
      const hook = await renderCurrentHook(
        () => ({
          control: useVoiceAttemptControl(GLOBAL_TARGET),
          model: useVoiceSurfaceModel({ variant: 'sidebar' }),
          dismissals: useHomeSetupDismissals(),
        }),
        {
          wrapper: ({ children }) => (
            <InjectedAuthProvider credentials={credentials}>
              {children}
            </InjectedAuthProvider>
          ),
        },
      );
      unmount = hook.unmount;
      await flushHookEffects({ cycles: 3 });
      expect(hook.getCurrent().dismissals.hidden.has(VOICE_SETUP_STEP_ID)).toBe(
        false,
      );
      expect(hook.getCurrent().control).toMatchObject({
        availability: 'setup',
        primaryAction: 'setup',
      });

      await act(async () => {
        await hook.getCurrent().dismissals.dismiss(VOICE_SETUP_STEP_ID);
      });
      await flushHookEffects({ cycles: 3 });

      expect(artifact.writes).toHaveLength(1);
      expect(listHiddenHomeSetupSteps(artifact.layout())).toContain(
        VOICE_SETUP_STEP_ID,
      );
      expect(hook.getCurrent().dismissals.hidden.has(VOICE_SETUP_STEP_ID)).toBe(
        true,
      );
      expect(hook.getCurrent().control).toMatchObject({
        availability: 'unavailable',
        primaryAction: null,
      });
      expect(hook.getCurrent().model).toBeNull();
    } finally {
      await unmount?.();
      await connection?.dispose();
      restoreActionLoader?.();
      restoreWebLocks?.();
    }
  });
});
