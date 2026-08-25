import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as React from 'react';
import { act } from 'react-test-renderer';
import {
  buildQualifiedPluginContributionKey,
  createFeatureDecision,
  createRecipientContractDigestV1,
  type PluginPermissionGrantRequestV1,
  type PluginPermissionGrantV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import type {
  RpcHandlerMap,
  RpcHandlerRegistrar,
} from '../../../../apps/cli/src/api/rpc/types';
import { createMachineVoiceClientCredentialAuthorizationService } from '../../../../apps/cli/src/api/machine/rpcHandlers.voiceClientCredentialAuthorization';
import { registerMachineVoiceClientCredentialRpcHandlers } from '../../../../apps/cli/src/api/machine/rpcHandlers.voiceClientCredentials';
import { registerMachineVoiceSpeechRpcHandlers } from '../../../../apps/cli/src/api/machine/rpcHandlers.voiceSpeech';
import { createDaemonArchivePluginChangePreparer } from '../../../../apps/cli/src/plugins/daemon/archiveChangePreparer';
import { createDaemonPluginChangeService } from '../../../../apps/cli/src/plugins/daemon/changeService';
import { readCurrentDaemonPluginCatalog } from '../../../../apps/cli/src/plugins/daemon/currentCatalog';
import { createDaemonPathPluginChangePreparer } from '../../../../apps/cli/src/plugins/daemon/pathChangePreparer';
import { loadInstalledPlugins } from '../../../../apps/cli/src/plugins/discovery/load/installed';
import { packLocalPlugin } from '../../../../apps/cli/src/plugins/packaging/pack';
import { resolveExecutablePluginRuntimeRegistry } from '../../../../apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '../../../../apps/cli/src/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '../../../../apps/cli/src/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginRegistryStateStore } from '../../../../apps/cli/src/plugins/store/registry/currentState';
import { createRegistryInstallReviewPrincipalReader } from '../../../../apps/cli/src/plugins/runtime/credentials/registryInstallReviewPrincipalReader';
import {
  invalidateDaemonContributionRegistryProjectionCache,
  registerDaemonContributionRegistryProjectionHandler,
} from '../../../../apps/cli/src/rpc/handlers/daemonContributionRegistryProjection';
import { createReactNativeWebLoaderBackend } from '../../../../apps/ui/sources/components/plugins/reactNative/webLoaderBackend.web';
import { resolvePluginUiClientActionRegistration } from '../../../../apps/ui/sources/components/plugins/reactNative/clientExecutableContributions';
import { AppPaneProvider } from '../../../../apps/ui/sources/components/appShell/panes/AppPaneProvider';
import {
  CurrentUiContextProvider,
  type CurrentUiContextReader,
  useOptionalCurrentUiContextReader,
} from '../../../../apps/ui/sources/components/appShell/currentUiContext/CurrentUiContextProvider';
import { PluginSurfaceFocusEligibilityProvider } from '../../../../apps/ui/sources/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PluginSurfacePlacementHost } from '../../../../apps/ui/sources/components/plugins/surfaces/PluginSurfaceHost';
import {
  PluginSurfaceDestinationNavigationBindingProvider,
  type PluginSurfaceDestinationContainerHandler,
  usePluginSurfaceDestinationNavigationBindingForScope,
  useRegisterPluginSurfaceDestinationNavigationOwner,
} from '../../../../apps/ui/sources/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { flushHookEffects, renderScreen, standardCleanup } from '../../../../apps/ui/sources/dev/testkit';
import { settingsParse } from '../../../../apps/ui/sources/sync/domains/settings/settings';
import type { VoiceSettings } from '../../../../apps/ui/sources/sync/domains/settings/voiceSettings';
import {
  normalizeVoiceSettingsLocalDelta,
} from '../../../../apps/ui/sources/sync/domains/settings/voiceSettingsPersistence';
import {
  machineContributionRegistryProjectionDescribe,
  publishMachineContributionRegistryProjectionInvalidation,
} from '../../../../apps/ui/sources/sync/ops/machineContributionRegistryProjection';
import {
  clearPluginAccountAvailabilityProjection,
  replacePluginAccountAvailabilityProjection,
} from '../../../../apps/ui/sources/sync/domains/plugins/availability/projection';
import type {
  PluginAccountAvailabilitySnapshot,
} from '../../../../apps/ui/sources/sync/domains/plugins/availability/reader';
import type { PluginUiActionProjection } from '../../../../apps/ui/sources/sync/domains/plugins/ui/projection';
import {
  isAccountVoiceCredentialRecipientApprovalRequired,
} from '../../../../apps/ui/sources/voice/credentials/accountVoiceCredential';
import { BundledSpeechDaemonClient } from '../../../../apps/ui/sources/voice/credentials/bundledSpeechClient';
import { createDefaultVoiceProviderRegistry } from '../../../../apps/ui/sources/voice/registry/defaultRegistry';
import { getExternalVoiceProviderRegistration } from '../../../../apps/ui/sources/voice/registry/externalVoiceProviderRegistrations';
import { getVoiceAdapterRegistry } from '../../../../apps/ui/sources/voice/session/voiceAdapterRegistry';
import { getVoiceSessionLifecycleController } from '../../../../apps/ui/sources/voice/session/voiceSessionLifecycleControllerStore';
import { loadPackedNovelConnectedAccountQaHandoff } from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  activate as activatePublicAuthoringDaemon,
  manifest as publicAuthoringManifest,
} from '../../../plugin-sdk/examples/public-authoring';
import { activate as activatePublicAuthoringReviewClientActions } from '../../../plugin-sdk/examples/public-authoring/ui/reviewClientActions';
import { activate as activatePublicAuthoringConversationProviders } from '../../../plugin-sdk/examples/public-authoring/voiceProvider';

const FIXTURE_PLUGIN_ID = 'examples.public-sdk-review-assistant';
const FIXTURE_PROVIDER_LOCAL_ID = 'credentialed-browser';
const FIXTURE_PROVIDER_ID = `${FIXTURE_PLUGIN_ID}/${FIXTURE_PROVIDER_LOCAL_ID}`;
const FIXTURE_RAW_PROVIDER_ID = `${FIXTURE_PLUGIN_ID}/raw-browser`;
const FIXTURE_STT_PROVIDER_ID = `${FIXTURE_PLUGIN_ID}/speech-stt`;
const FIXTURE_TTS_PROVIDER_ID = `${FIXTURE_PLUGIN_ID}/speech-tts`;
const FIXTURE_PROVIDER_CONTRIBUTION = Object.freeze({
  pluginId: FIXTURE_PLUGIN_ID,
  localId: FIXTURE_PROVIDER_LOCAL_ID,
});
const FIXTURE_RAW_PROVIDER_CONTRIBUTION = Object.freeze({
  pluginId: FIXTURE_PLUGIN_ID,
  localId: 'raw-browser',
});
const REVIEW_STATUS_ACTION_ID = Object.freeze({
  pluginId: FIXTURE_PLUGIN_ID,
  localId: 'open-review-status',
});
const REVIEW_STATUS_ACTION_KEY = buildQualifiedPluginContributionKey(REVIEW_STATUS_ACTION_ID);
const MACHINE_ID = 'machine-packed-voice';
const SERVER_ID = 'server-packed-voice';
const SOURCE_CREDENTIAL = 'source-account-secret';

type RpcBoundaryHandler = (
  payload: unknown,
  context?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown> | unknown;

const composedBoundary = vi.hoisted(() => ({
  handlers: new Map<string, RpcBoundaryHandler>(),
  audioSessionAcquireRequests: [] as Array<Record<string, unknown>>,
  audioSessionReleaseCount: 0,
  loaderBackend: null as ReturnType<typeof createReactNativeWebLoaderBackend> | null,
  machines: [] as Array<Record<string, unknown>>,
  settings: null as ReturnType<typeof settingsParse> | null,
  latestHarnessVoice: null as VoiceSettings | null,
  settingsScope: Object.freeze({
    serverId: 'server-packed-voice',
    accountId: 'account-packed-voice',
  }),
  latestAppShellProjection: null as Readonly<{
    interactionEnabled: boolean;
    machineId: string | null;
    pluginUiProjection: Readonly<{
      generation: number | null;
      actionsById: Readonly<Record<string, PluginUiActionProjection>>;
      voiceProvidersById: Readonly<Record<string, unknown>>;
    }> | null;
  }> | null,
}));

vi.mock('@happier-dev/audio-stream-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/audio-stream-native')>();
  const coordinator = {
    acquire: async (request: Record<string, unknown>) => {
      composedBoundary.audioSessionAcquireRequests.push(request);
      let released = false;
      return {
        id: `packed-voice-audio-session-${composedBoundary.audioSessionAcquireRequests.length}`,
        capabilities: {
          aecAvailable: true,
          aecActive: true,
          route: 'test',
        },
        release: async () => {
          if (released) return;
          released = true;
          composedBoundary.audioSessionReleaseCount += 1;
        },
      };
    },
    subscribe: () => ({ remove: () => undefined }),
    getSnapshot: () => ({
      generation: 0,
      leaseCount: 0,
      pendingReleaseCount: 0,
      configuration: null,
      capabilities: null,
    }),
    dispose: async () => undefined,
  };
  return {
    ...actual,
    getSharedVoiceAudioSessionCoordinator: () => coordinator,
  };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: async (input: Readonly<{
    method: string;
    payload: unknown;
    signal?: AbortSignal;
  }>) => {
    if (input.signal?.aborted) {
      throw Object.assign(new Error('machine_rpc_aborted'), { code: 'MACHINE_RPC_ABORTED' });
    }
    const handler = composedBoundary.handlers.get(input.method);
    if (!handler) throw new Error(`unregistered_machine_rpc:${input.method}`);
    return await handler(input.payload, { signal: input.signal });
  },
}));

vi.mock('@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend', () => ({
  resolveDefaultReactNativeLoaderBackend: () => {
    if (!composedBoundary.loaderBackend) {
      throw new Error('packed_voice_loader_backend_unavailable');
    }
    return composedBoundary.loaderBackend;
  },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
  useActiveServerSnapshot: () => ({
    serverId: SERVER_ID,
    serverUrl: 'https://server.example.test',
    generation: 1,
  }),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/ui/sources/sync/store/hooks')>(),
  // VoiceProviderSection reads the same profile projection through this legacy
  // hook barrel; the composed boundary keeps the actual settings/selection and
  // lifecycle owners real.
  useProfile: () => ({
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
  }),
  useSettings: () => composedBoundary.settings ?? settingsParse({}),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  const readState = () => ({
    machines: Object.fromEntries(
      composedBoundary.machines.map((machine) => [String(machine.id), machine]),
    ),
    settings: composedBoundary.settings,
    settingsScope: composedBoundary.settingsScope,
    profile: {
      id: composedBoundary.settingsScope.accountId,
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    },
    profileScope: composedBoundary.settingsScope,
    isDataReady: true,
    sessions: {},
    sessionMessages: {},
    applyMessagesLoaded: () => undefined,
    applyMessages: () => undefined,
    evictSessionMessages: () => undefined,
    setRealtimeStatus: () => undefined,
    setRealtimeMode: () => undefined,
    clearRealtimeModeDebounce: () => undefined,
  });
  const storage = Object.assign(
    (selector: (state: ReturnType<typeof readState>) => unknown) => selector(readState()),
    {
      getState: readState,
      getInitialState: readState,
      setState: () => undefined,
      subscribe: () => () => undefined,
      destroy: () => undefined,
    },
  );
  return createStorageModuleStub({
    storage,
    useSettings: () => composedBoundary.settings ?? settingsParse({}),
    useSetting: (key: keyof ReturnType<typeof settingsParse>) =>
      composedBoundary.settings?.[key],
    useProfile: () => ({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    }),
    useAllMachines: () => composedBoundary.machines,
    useEndpointStatus: () => 'online',
    useMachineCliDetectionTarget: (machineId: string | null) => ({
      daemonStateVersion: machineId === MACHINE_ID ? 1 : 0,
      isOnline: machineId === MACHINE_ID,
    }),
  });
});

type VoiceNormalSurfaceModules = Readonly<{
  VoiceProviderSection:
    typeof import('../../../../apps/ui/sources/voice/settings/panels/VoiceProviderSection')['VoiceProviderSection'];
  VoiceSessionRuntime:
    typeof import('../../../../apps/ui/sources/voice/session/VoiceSessionRuntime')['VoiceSessionRuntime'];
}>;

let voiceNormalSurfaceModules: VoiceNormalSurfaceModules | null = null;

function requireVoiceNormalSurfaceModules(): VoiceNormalSurfaceModules {
  if (!voiceNormalSurfaceModules) throw new Error('voice_normal_surface_modules_unavailable');
  return voiceNormalSurfaceModules;
}

function VoiceNormalSurfaceHarness(props: Readonly<{
  settingsRevision: number;
}>): React.ReactElement {
  const { VoiceProviderSection, VoiceSessionRuntime } = requireVoiceNormalSurfaceModules();
  const initialSettings = composedBoundary.settings;
  if (!initialSettings) throw new Error('packed_voice_settings_unavailable');
  const [voice, setVoiceState] = React.useState<VoiceSettings>(initialSettings.voice);
  composedBoundary.latestHarnessVoice = voice;
  React.useEffect(() => {
    const current = composedBoundary.settings;
    if (!current) throw new Error('packed_voice_settings_unavailable');
    setVoiceState(current.voice);
  }, [props.settingsRevision]);
  const setVoice = React.useCallback((next: VoiceSettings) => {
    const current = composedBoundary.settings;
    if (!current) throw new Error('packed_voice_settings_unavailable');
    composedBoundary.settings = settingsParse({
      ...current,
      ...normalizeVoiceSettingsLocalDelta({ voice: next }, current),
    });
    setVoiceState(next);
  }, []);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(VoiceSessionRuntime),
    React.createElement(VoiceProviderSection, {
      voice,
      setVoice,
      happierVoiceSupported: true,
      platformOs: 'web',
      executionMachineId: MACHINE_ID,
    }),
  );
}

function createRegistrar(): Readonly<{
  handlers: RpcHandlerMap;
  registrar: RpcHandlerRegistrar;
}> {
  const handlers: RpcHandlerMap = new Map();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return Object.freeze({ handlers, registrar });
}

function createEnabledReactNativeBundlesFeatureDecision() {
  return createFeatureDecision({
    featureId: 'plugins.ui.reactNativeBundles',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 0,
    scope: { scopeKind: 'runtime' },
  });
}

async function waitForReact(assertion: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(async () => {
    await flushHookEffects({ cycles: 1 });
    await assertion();
  }, { timeout: 15_000, interval: 20 });
}

function AppShellProjectionProbe(): React.ReactElement | null {
  const { useAppShellPluginUiProjection } = requireAppShellProjectionModule();
  const projection = useAppShellPluginUiProjection();
  composedBoundary.latestAppShellProjection = projection;
  return null;
}

function readCurrentReviewActionRegistration() {
  const projection = composedBoundary.latestAppShellProjection?.pluginUiProjection;
  const generation = projection?.generation;
  const action = projection?.actionsById[REVIEW_STATUS_ACTION_KEY];
  if (typeof generation !== 'number' || !action) return null;
  return resolvePluginUiClientActionRegistration({
    action,
    projectionGeneration: generation,
    platform: 'web',
  });
}

function CurrentUiContextReaderProbe(props: Readonly<{
  onReader: (reader: CurrentUiContextReader | null) => void;
}>): null {
  const reader = useOptionalCurrentUiContextReader();
  React.useLayoutEffect(() => {
    props.onReader(reader);
  }, [props.onReader, reader]);
  return null;
}

/**
 * The Session host is deliberately a thin composition of existing owners:
 * AppShell projects the exact installed archive, PluginSurfacePlacementHost
 * mounts its authored surface, CurrentUiContextProvider owns its one record,
 * and this scope contributes only the existing details-tab navigation edge.
 */
function PackedCandidateVoiceCurrentUiSessionHarness(props: Readonly<{
  contextRevision: number;
  settingsRevision: number;
  onReader: (reader: CurrentUiContextReader | null) => void;
  onOpenDetails: PluginSurfaceDestinationContainerHandler;
}>): React.ReactElement {
  const { useAppShellPluginUiProjection } = requireAppShellProjectionModule();
  const projection = useAppShellPluginUiProjection();
  const placements = React.useMemo(
    () => Object.values(projection.pluginUiProjection?.surfacePlacementsById ?? {}),
    [projection.pluginUiProjection],
  );
  const activityPlacement = React.useMemo(() => placements.find((placement) => (
    placement.binding.targetKind === 'session'
    && placement.binding.destination.pluginId === FIXTURE_PLUGIN_ID
    && placement.binding.destination.localId === 'project-companion-activity-log'
  )) ?? null, [placements]);
  const navigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
    placements,
    targetKind: 'session',
    scopedLaunchFacts: {
      serverId: projection.serverId,
      machineId: projection.machineId,
      generation: projection.pluginUiProjection?.generation ?? null,
      interactionEnabled: projection.interactionEnabled,
    },
    runtimeAdmission: { platform: 'web', formFactor: 'tablet' },
  });
  const detailsOwner = React.useMemo(() => ({
    container: 'detailsTab' as const,
    handler: props.onOpenDetails,
  }), [props.onOpenDetails]);
  useRegisterPluginSurfaceDestinationNavigationOwner(detailsOwner, navigationBinding);

  return React.createElement(
    PluginSurfaceDestinationNavigationBindingProvider,
    { binding: navigationBinding },
    React.createElement(
      PluginSurfaceFocusEligibilityProvider,
      { active: true, currentUiContextActive: true },
      React.createElement(
        React.Fragment,
        null,
        activityPlacement
          ? React.createElement(PluginSurfacePlacementHost, {
              key: `packed-candidate-current-ui-${props.contextRevision}`,
              placement: activityPlacement,
              machineId: projection.machineId,
              serverId: projection.serverId,
              sessionId: 'packed-candidate-current-ui-session',
              pluginUiProjection: projection.pluginUiProjection,
              platform: projection.platform,
              projectionInteractionEnabled: projection.interactionEnabled,
            })
          : null,
        React.createElement(VoiceNormalSurfaceHarness, { settingsRevision: props.settingsRevision }),
        React.createElement(CurrentUiContextReaderProbe, { onReader: props.onReader }),
      ),
    ),
  );
}

function renderPackedCandidateVoiceCurrentUiComposition(input: Readonly<{
  contextRevision: number;
  settingsRevision: number;
  onReader: (reader: CurrentUiContextReader | null) => void;
  onOpenDetails: PluginSurfaceDestinationContainerHandler;
}>): React.ReactElement {
  const { AppShellPluginUiProjectionProvider } = requireAppShellProjectionModule();
  return React.createElement(
    AppPaneProvider,
    null,
    React.createElement(
      CurrentUiContextProvider,
      null,
      React.createElement(
        AppShellPluginUiProjectionProvider,
        null,
        React.createElement(AppShellProjectionProbe),
        React.createElement(PackedCandidateVoiceCurrentUiSessionHarness, input),
      ),
    ),
  );
}

let appShellProjectionModule:
  | typeof import('../../../../apps/ui/sources/components/appShell/plugins/AppShellPluginUiProjection')
  | null = null;

function requireAppShellProjectionModule():
  typeof import('../../../../apps/ui/sources/components/appShell/plugins/AppShellPluginUiProjection') {
  if (!appShellProjectionModule) throw new Error('app_shell_projection_module_unavailable');
  return appShellProjectionModule;
}

async function packVoiceFixtureVariant(input: Readonly<{
  fixtureRoot: string;
  temporaryRoot: string;
  variant: string;
  version: string;
  daemonSource?: string;
  daemonRelativePath?: string;
}>): Promise<string> {
  const variantRoot = join(input.temporaryRoot, input.variant);
  const archivePath = join(input.temporaryRoot, `${input.variant}.tgz`);
  await cp(input.fixtureRoot, variantRoot, { recursive: true });
  for (const relativePath of ['package.json', '.happier-plugin/plugin.json']) {
    const path = join(variantRoot, relativePath);
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    value.version = input.version;
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  if (input.daemonSource !== undefined) {
    await writeFile(
      join(variantRoot, input.daemonRelativePath ?? 'dist/daemon.js'),
      input.daemonSource,
    );
  }
  const packed = await packLocalPlugin({
    locator: variantRoot,
    outPath: archivePath,
  });
  if (!packed.ok) {
    throw new Error(packed.diagnostics.map((entry) => entry.message).join('\n'));
  }
  return archivePath;
}

const PACKED_CANDIDATE_HANDOFF_MANIFEST =
  process.env.HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST?.trim() || null;

const describePackedCandidate = PACKED_CANDIDATE_HANDOFF_MANIFEST
  ? describe
  : process.env.HAPPIER_E2E_PACKED_VOICE_REQUIRE_HANDOFF === '1'
    ? describe
    : describe.skip;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`packed_voice_${label}_invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

describe('retained public-authoring Voice fixture contract', () => {
  it('registers the shared client Action separately from the web-only Voice fixture, exactly two conversation providers, two speech providers, and executes raw materialization', async () => {
    const registrations = new Map<string, Readonly<Record<string, unknown>>>();
    const clientActionIds: string[] = [];
    const api = {
      actions: {
        register(localId: string) {
          clientActionIds.push(localId);
        },
      },
      voiceProviders: {
        register(localId: string, runtime: Readonly<Record<string, unknown>>) {
          if (registrations.has(localId)) throw new Error(`duplicate_voice_provider:${localId}`);
          registrations.set(localId, runtime);
        },
      },
    };
    activatePublicAuthoringReviewClientActions(api as never);
    expect(clientActionIds).toEqual(['open-review-status']);
    activatePublicAuthoringConversationProviders(api as never);
    expect(clientActionIds).toEqual([
      'open-review-status',
      'open-review-status-web-only-fixture',
    ]);
    const testkit = await createPluginTestkit({
      manifest: publicAuthoringManifest,
      module: { activate: activatePublicAuthoringDaemon },
    });
    try {
      const stt = testkit.registration('voiceProviders', 'speech-stt');
      const tts = testkit.registration('voiceProviders', 'speech-tts');
      if (!stt || !tts) {
        throw new Error('public_authoring_speech_runtime_missing');
      }
      registrations.set('speech-stt', stt);
      registrations.set('speech-tts', tts);
      expect([...registrations.keys()].sort()).toEqual([
        'credentialed-browser',
        'raw-browser',
        'speech-stt',
        'speech-tts',
      ]);
      expect(Object.fromEntries([...registrations].map(([localId, runtime]) => [
        localId,
        runtime.kind,
      ]))).toEqual({
        'credentialed-browser': 'conversation',
        'raw-browser': 'conversation',
        'speech-stt': 'speech',
        'speech-tts': 'speech',
      });

      const raw = registrations.get('raw-browser');
      const createConnection = raw?.createConnection;
      if (typeof createConnection !== 'function') {
        throw new Error('public_authoring_raw_connection_missing');
      }
      const materialize = vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { authorization: 'raw-boundary-value' },
      }));
      const signal = new AbortController().signal;
      const connection = await createConnection({
        credentials: {
          phase: 'connection',
          mediated: null,
          raw: { materialize },
        },
        signal,
      } as never) as Readonly<{
        connect(signal: AbortSignal): Promise<void>;
        close(): Promise<void>;
      }>;
      await connection.connect(signal);
      await connection.close();
      expect(materialize).toHaveBeenCalledOnce();
      expect(materialize).toHaveBeenCalledWith({
        kind: 'httpHeaders',
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      }, { signal });
    } finally {
      await testkit.dispose();
    }
  });
});

describePackedCandidate('candidate-bound packed public-authoring Voice lifecycle', () => {
  it('reuses the exact candidate archive through review, both credential paths, speech, replacement, retirement, and uninstall', async () => {
    if (!PACKED_CANDIDATE_HANDOFF_MANIFEST) {
      throw new Error('packed_voice_candidate_handoff_required');
    }
    const handoff = await loadPackedNovelConnectedAccountQaHandoff({
      manifestPath: PACKED_CANDIDATE_HANDOFF_MANIFEST,
    });
    expect(handoff.publicAuthoring).toMatchObject({
      pluginId: FIXTURE_PLUGIN_ID,
      version: '0.1.0',
      archive: {
        integrity: expect.stringMatching(/^sha512-/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeBytes: expect.any(Number),
      },
    });
    expect(handoff.candidate).toMatchObject({
      sdk: { packageName: '@happier-dev/plugin-sdk', integrity: expect.stringMatching(/^sha512-/) },
      pluginUi: { packageName: '@happier-dev/plugin-ui', integrity: expect.stringMatching(/^sha512-/) },
      cli: { packageName: '@happier-dev/cli', integrity: expect.stringMatching(/^sha512-/) },
    });

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-packed-candidate-voice-'));
    const happyHomeDir = join(temporaryRoot, 'happy-home');
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    const prepareArchiveChange = createDaemonArchivePluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
    });
    const prepareStateChange = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
    });
    let pendingChangeSequence = 0;
    const changeService = createDaemonPluginChangeService({
      prepare: async (request) => request.kind === 'installArchive'
        ? await prepareArchiveChange(request)
        : await prepareStateChange(request),
      createPendingChangeId: () => `packed-candidate-voice-review-${++pendingChangeSequence}`,
    });
    const originalFetch = globalThis.fetch;
    let appShell: Awaited<ReturnType<typeof renderScreen>> | null = null;
    let speechRpcRegistration: ReturnType<typeof registerMachineVoiceSpeechRpcHandlers> | null = null;
    let credentialRpcRegistration: ReturnType<typeof registerMachineVoiceClientCredentialRpcHandlers> | null = null;
    let activeRawGrant: PluginPermissionGrantV1 | null = null;
    let pendingRawRequest: PluginPermissionGrantRequestV1 | null = null;
    const rawGrantListInputs: unknown[] = [];
    const rawMaterializeRpcInputs: unknown[] = [];
    const providerRequests: Array<Readonly<{
      method: string;
      url: string;
      authorization: string | null;
    }>> = [];
    let currentUiReader: CurrentUiContextReader | null = null;
    const onCurrentUiReader = (reader: CurrentUiContextReader | null) => {
      currentUiReader = reader;
    };
    const openReviewStatusDetails = vi.fn<PluginSurfaceDestinationContainerHandler>(
      async () => ({ ok: true as const }),
    );

    try {
      // Keep the selected Voice machine outside the app-wide presence union so
      // AppShell exercises its dedicated, user-selected Voice projection path.
      composedBoundary.machines = [{
        id: MACHINE_ID,
        active: true,
        activeAt: 0,
        lastSeen: 0,
        daemonStateVersion: 1,
        metadata: { host: 'packed-candidate-voice-host' },
      }];
      composedBoundary.settings = settingsParse({
        voice: {
          providerId: 'off',
          executionMachine: { mode: 'fixed', machineId: MACHINE_ID },
        },
      });
      composedBoundary.audioSessionAcquireRequests = [];
      composedBoundary.audioSessionReleaseCount = 0;

      const stateStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
      await stateStore.initialize();
      const initialRuntimeLease = await reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir,
          generation: reloadController.getState().generation + 1,
        }),
      });
      await initialRuntimeLease.release();

      const requested = await changeService.requestPluginChange({
        kind: 'installArchive',
        locator: handoff.publicAuthoring.archivePath,
      });
      expect(requested).toMatchObject({
        kind: 'reviewRequired',
        review: {
          pluginId: FIXTURE_PLUGIN_ID,
          packageIdentity: { version: '0.1.0' },
          source: { kind: 'archive', locator: handoff.publicAuthoring.archivePath },
          contributions: expect.arrayContaining([{ family: 'voiceProviders', count: 4 }]),
          uiArtifacts: {
            status: 'verified',
            contributionIds: expect.arrayContaining([
              'review-native',
              'review-web',
              'voice-runtime-web',
            ]),
          },
          requiredHostAccess: expect.arrayContaining([
            expect.objectContaining({ id: 'voice-client-auth', capability: 'network' }),
            expect.objectContaining({ id: 'voice-catalog', capability: 'network' }),
          ]),
        },
      });
      if (requested.kind !== 'reviewRequired') {
        throw new Error(`packed_voice_review_missing:${requested.kind}`);
      }
      const committed = await changeService.decidePluginChange({
        pendingChangeId: requested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'packed-candidate-voice-install',
          occurredAtMs: 35,
        },
      });
      expect(committed).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: expect.any(String),
        appliedGeneration: expect.any(String),
      });
      if (committed.kind !== 'committed' || !committed.appliedGeneration) {
        throw new Error(`packed_voice_install_not_current:${committed.kind}`);
      }
      const loaded = await loadInstalledPlugins({ happyHomeDir });
      expect(loaded.loadedPlugins).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          pluginRootPath: expect.stringContaining(committed.appliedGeneration),
          sourceSpec: expect.objectContaining({ kind: 'archive', trustPolicy: 'prompt' }),
        }),
      ]);
      const installedFixtureRoot = loaded.loadedPlugins[0]?.pluginRootPath;
      if (!installedFixtureRoot) throw new Error('packed_voice_installed_root_missing');

      const { handlers, registrar } = createRegistrar();
      composedBoundary.handlers = handlers as Map<string, RpcBoundaryHandler>;
      const installReviewPrincipal = createRegistryInstallReviewPrincipalReader();
      credentialRpcRegistration = registerMachineVoiceClientCredentialRpcHandlers({
        rpcHandlerManager: registrar,
        machineId: MACHINE_ID,
        resolveRawCredentialDependencies: async () => ({
          currentInstallReviewPrincipal: installReviewPrincipal,
          grants: {
            list: async (input) => {
              rawGrantListInputs.push(input);
              return { grants: activeRawGrant ? [activeRawGrant] : [], pendingRequests: [] };
            },
          },
          getAccountSettingsSnapshot: () => composedBoundary.settings
            ? {
                source: 'network',
                scopeKey: composedBoundary.settingsScope.accountId,
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                settings: composedBoundary.settings as never,
              }
            : null,
        }),
      });
      const rawMaterializeHandler = handlers.get(
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
      );
      if (!rawMaterializeHandler) {
        throw new Error('packed_voice_raw_materialize_rpc_missing');
      }
      handlers.set(
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
        async (payload, context) => {
          rawMaterializeRpcInputs.push(payload);
          return await rawMaterializeHandler(payload, context);
        },
      );
      speechRpcRegistration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager: registrar,
        machineId: MACHINE_ID,
        resolveSpeechRuntime: async (target) => {
          const registry = reloadController.getState().activeRegistry;
          if (!registry) throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
          await registry.activateContributionsOnDemand([{
            pluginId: target.pluginId,
            family: 'voiceProviders',
            localId: target.localId,
          }]);
          const speech = registry.voiceSpeechProviders?.read(target) ?? null;
          if (!speech?.isCurrent()) {
            throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
          }
          const settingsSnapshot = composedBoundary.settings;
          const envelope = settingsSnapshot?.voice.providers[`${target.pluginId}/${target.localId}`];
          if (!settingsSnapshot || !envelope) {
            throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
          }
          return Object.freeze({
            runtime: speech.runtime,
            contribution: speech.contribution,
            readSettings: () => Object.freeze({
              settings: envelope.config,
              resolveCredentials: () => Object.freeze({ phase: 'speech' as const, mediated: null, raw: null }),
              isCurrent: () => composedBoundary.settings === settingsSnapshot && speech.isCurrent(),
            }),
            createHttp: speech.createHttp,
            isCurrent: speech.isCurrent,
            retirementSignal: speech.retirementSignal,
            release: async () => undefined,
          });
        },
      });
      registerDaemonContributionRegistryProjectionHandler(registrar, {
        resolveRuntimeRegistry: async () => {
          const registry = reloadController.getState().activeRegistry;
          if (!registry) throw new Error('packed_voice_runtime_registry_unavailable');
          return registry;
        },
        resolveInstalledPackages: async () => await readCurrentDaemonPluginCatalog({
          happyHomeDir,
          reloadController,
        }),
        resolveGeneration: async () => reloadController.getState().generation,
        resolveReactNativeBundlesFeatureDecision:
          async () => createEnabledReactNativeBundlesFeatureDecision(),
        installedReactNativeArtifactLoaderAvailable: true,
        reactNativeScriptManagerRuntimeIntegrated: true,
        reactNativeHostRuntime: { platform: 'web', channel: 'internal' },
      });
      invalidateDaemonContributionRegistryProjectionCache();
      composedBoundary.loaderBackend = createReactNativeWebLoaderBackend({
        importModule: async (blobUrl) => {
          const source = await (await originalFetch(blobUrl)).text();
          return await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`);
        },
      });

      const initialProjection = await machineContributionRegistryProjectionDescribe(MACHINE_ID, {
        serverId: SERVER_ID,
      });
      expect(initialProjection).toMatchObject({ supported: true });
      if (!initialProjection.supported) throw new Error('packed_voice_projection_unavailable');
      const initialVoiceEntries = record(
        record(initialProjection.projection.familiesById.voiceProviders, 'voice_family').entriesById,
        'voice_entries',
      );
      expect(Object.keys(initialVoiceEntries)
        .filter((id) => id.startsWith(`${FIXTURE_PLUGIN_ID}/`))
        .sort())
        .toEqual([
          FIXTURE_PROVIDER_ID,
          FIXTURE_RAW_PROVIDER_ID,
          FIXTURE_STT_PROVIDER_ID,
          FIXTURE_TTS_PROVIDER_ID,
        ].sort());
      const publishAvailability = async () => {
        const inventory = await stateStore.readAvailabilityInventory();
        if (inventory.materializations.length === 0) {
          clearPluginAccountAvailabilityProjection();
          return;
        }
        expect(inventory.releasePublications).toHaveLength(1);
        expect(inventory.materializations).toHaveLength(1);
        const release = inventory.releasePublications[0]?.facts;
        const materialization = inventory.materializations[0];
        if (!release || !materialization) {
          throw new Error('packed_voice_canonical_availability_incomplete');
        }
        expect(materialization).toMatchObject({
          pluginId: release.ref.pluginId,
          version: release.ref.version,
          archiveDigestSha256: release.archiveDigestSha256,
        });
        const snapshot = {
          availabilityCursor: inventory.revision,
          intentReads: [{
            pluginId: FIXTURE_PLUGIN_ID,
            response: {
              availabilityCursor: inventory.revision,
              hostingCapability: { enabled: false },
              intent: {
                pluginId: FIXTURE_PLUGIN_ID,
                desiredVersion: release.ref.version,
                enabled: materialization.enabled,
                offlineUiHosting: 'disabled',
                writableCollections: [],
                revision: `packed-voice-${inventory.revision}`,
              },
              release,
              uiArtifacts: [],
            },
          }],
          materializations: [{
            ...materialization,
            serverIdentityId: 'srv_packed_voice',
            machineId: MACHINE_ID,
          }],
        } satisfies PluginAccountAvailabilitySnapshot;
        replacePluginAccountAvailabilityProjection({
          scope: composedBoundary.settingsScope,
          snapshot,
        });
      };
      await publishAvailability();

      appShellProjectionModule = await import(
        '../../../../apps/ui/sources/components/appShell/plugins/AppShellPluginUiProjection'
      );
      voiceNormalSurfaceModules = {
        VoiceProviderSection: (await import(
          '../../../../apps/ui/sources/voice/settings/panels/VoiceProviderSection'
        )).VoiceProviderSection,
        VoiceSessionRuntime: (await import(
          '../../../../apps/ui/sources/voice/session/VoiceSessionRuntime'
        )).VoiceSessionRuntime,
      };
      appShell = await renderScreen(renderPackedCandidateVoiceCurrentUiComposition({
        contextRevision: 0,
        settingsRevision: 0,
        onReader: onCurrentUiReader,
        onOpenDetails: openReviewStatusDetails,
      }));
      await flushHookEffects({ cycles: 10 });
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).not.toBeNull();
        expect(getExternalVoiceProviderRegistration(FIXTURE_RAW_PROVIDER_ID)).not.toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_STT_PROVIDER_ID)).not.toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_TTS_PROVIDER_ID)).not.toBeNull();
      });

      const mediatedRegistration = getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID);
      const rawRegistration = getExternalVoiceProviderRegistration(FIXTURE_RAW_PROVIDER_ID);
      expect(rawRegistration).toMatchObject({
        pluginId: FIXTURE_PLUGIN_ID,
        localId: 'raw-browser',
        descriptor: {
          declaration: {
            credentials: {
              sources: expect.arrayContaining([
                expect.objectContaining({
                  kind: 'savedSecret',
                  rawGrants: [expect.objectContaining({ realm: 'web', phase: 'connection' })],
                }),
              ]),
            },
          },
        },
      });
      if (!mediatedRegistration?.descriptor || !mediatedRegistration.settingsOperations?.listCatalog) {
        throw new Error('packed_voice_mediated_registration_incomplete');
      }
      const recipientContract = mediatedRegistration.descriptor.accountCredentialSlot?.recipientContract;
      if (!recipientContract) throw new Error('packed_voice_recipient_contract_missing');
      const recipientContractDigest = createRecipientContractDigestV1(recipientContract);
      expect(mediatedRegistration.descriptor.accountCredentialSlot?.recipientContractDigest)
        .toBe(recipientContractDigest);

      composedBoundary.settings = settingsParse({
        secrets: [
          {
            id: 'packed-voice-mediated-secret',
            name: 'Packed Voice mediated',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: SOURCE_CREDENTIAL },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'packed-voice-raw-secret',
            name: 'Packed Voice raw',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'raw-source-account-secret' },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        voice: {
          providerId: FIXTURE_PROVIDER_ID,
          executionMachine: { mode: 'fixed', machineId: MACHINE_ID },
          providers: {
            [FIXTURE_STT_PROVIDER_ID]: {
              schemaVersion: 2,
              config: { model: 'synthetic-stt-v1' },
            },
            [FIXTURE_TTS_PROVIDER_ID]: {
              schemaVersion: 2,
              config: { voice: 'synthetic-voice' },
            },
          },
          credentialBindings: [
            {
              contribution: FIXTURE_PROVIDER_CONTRIBUTION,
              credentialSlotId: 'api_key',
              credentialSource: { kind: 'savedSecret' },
              approvedRecipientContractDigest: recipientContractDigest,
              credentialBindings: { account: { api_key: 'packed-voice-mediated-secret' } },
            },
            {
              contribution: FIXTURE_RAW_PROVIDER_CONTRIBUTION,
              credentialSlotId: 'raw_key',
              credentialSource: { kind: 'savedSecret' },
              credentialBindings: { account: { raw_key: 'packed-voice-raw-secret' } },
            },
          ],
        },
      });
      await appShell.update(renderPackedCandidateVoiceCurrentUiComposition({
        contextRevision: 0,
        settingsRevision: 1,
        onReader: onCurrentUiReader,
        onOpenDetails: openReviewStatusDetails,
      }));
      await flushHookEffects({ cycles: 5 });
      await waitForReact(() => {
        const snapshot = currentUiReader?.readCurrentUiContext();
        expect(snapshot?.entity?.label).toBe('Project Companion activity');
        expect(snapshot?.detail).toEqual({
          source: 'public-authoring-project-companion-activity',
        });
        expect(readCurrentReviewActionRegistration()).not.toBeNull();
      });
      const commandA = currentUiReader?.readCurrentUiContext()?.commands[0]?.id;
      if (!commandA) throw new Error('packed_voice_current_ui_command_a_missing');
      expect(commandA).toMatch(/^current-ui-command:/);

      globalThis.fetch = vi.fn(async (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        const headers = new Headers(init?.headers);
        providerRequests.push({
          method: init?.method ?? 'GET',
          url,
          authorization: headers.get('authorization'),
        });
        if (url === 'https://voice.example.test/v1/catalog') {
          return new Response(JSON.stringify({
            voices: [{
              voiceId: 'synthetic-voice',
              displayName: 'Synthetic Voice',
              locale: 'en',
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url === 'https://voice.example.test/v1/session') {
          return new Response(JSON.stringify({
            sessionToken: 'synthetic-short-lived-client-artifact',
            expiresAtMs: Date.now() + 60_000,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected_packed_voice_fetch:${url}`);
      }) as typeof fetch;

      await expect(mediatedRegistration.settingsOperations.listCatalog({
        catalog: 'voices',
        providerConfig: {},
        signal: new AbortController().signal,
      })).resolves.toEqual([{
        id: 'synthetic-voice',
        name: 'Synthetic Voice',
        metadata: { locale: 'en' },
      }]);

      const registry = createDefaultVoiceProviderRegistry();
      const sttEntry = registry.get(FIXTURE_STT_PROVIDER_ID);
      const ttsEntry = registry.get(FIXTURE_TTS_PROVIDER_ID);
      if (!sttEntry || !ttsEntry) throw new Error('packed_voice_speech_projection_incomplete');
      const speechClient = new BundledSpeechDaemonClient({
        resolveMachineId: () => MACHINE_ID,
        machineRpc: async (input) => {
          const handler = handlers.get(input.method);
          if (!handler) throw new Error(`unregistered_machine_rpc:${input.method}`);
          return await handler(input.payload, { signal: input.signal });
        },
      });
      await expect(speechClient.transcribe({
        entry: sttEntry,
        source: { kind: 'memory', bytes: new Uint8Array([82, 73, 70, 70]) },
        mimeType: 'audio/wav',
        fileName: 'synthetic.wav',
        model: 'synthetic-stt-v1',
        language: 'en',
      })).resolves.toBe('synthetic transcript');
      await expect(speechClient.synthesize({
        entry: ttsEntry,
        input: 'synthetic speech',
        model: null,
        voiceName: 'synthetic-voice',
        languageCode: 'en',
        format: 'wav',
        speakingRate: null,
        pitch: null,
      })).resolves.toEqual({
        bytes: new Uint8Array([82, 73, 70, 70]),
        mimeType: 'audio/wav',
      });

      const lifecycle = getVoiceSessionLifecycleController();
      await lifecycle.toggle('packed-candidate-mediated-session');
      await waitForReact(() => {
        expect(lifecycle.getSnapshot()).toMatchObject({
          adapterId: FIXTURE_PROVIDER_ID,
          status: 'connected',
        });
      });
      // Opening a provider connection remains inert. The exact packed client
      // artifact receives its conformance turn only through the real adapter.
      expect(openReviewStatusDetails).not.toHaveBeenCalled();
      const mediatedAdapter = getVoiceAdapterRegistry().get(FIXTURE_PROVIDER_ID);
      if (!mediatedAdapter?.sendContextText) {
        throw new Error('packed_voice_current_ui_adapter_send_text_missing');
      }
      mediatedAdapter.sendContextText({
        sessionId: 'packed-candidate-mediated-session',
        text: 'run current UI context conformance',
      });
      await waitForReact(() => {
        expect(openReviewStatusDetails).toHaveBeenCalledTimes(1);
      });
      expect(openReviewStatusDetails).toHaveBeenCalledWith(expect.objectContaining({
        placement: expect.objectContaining({
          binding: expect.objectContaining({
            destination: {
              pluginId: FIXTURE_PLUGIN_ID,
              localId: 'review-session-status-details',
            },
          }),
        }),
      }));
      // The provider emits the same stable effect call id for a repeated
      // normal control. The incumbent barrier must redeliver its outcome
      // without navigating a second time.
      mediatedAdapter.sendContextText({
        sessionId: 'packed-candidate-mediated-session',
        text: 'run current UI context conformance',
      });
      await flushHookEffects({ cycles: 10 });
      expect(openReviewStatusDetails).toHaveBeenCalledTimes(1);

      // A fresh current-UI command makes the same provider effect call id
      // conflict with its first arguments. The incumbent barrier rejects that
      // conflict instead of re-running the navigation effect.
      await appShell.update(renderPackedCandidateVoiceCurrentUiComposition({
        contextRevision: 1,
        settingsRevision: 1,
        onReader: onCurrentUiReader,
        onOpenDetails: openReviewStatusDetails,
      }));
      await flushHookEffects({ cycles: 5 });
      await waitForReact(() => {
        const command = currentUiReader?.readCurrentUiContext()?.commands[0]?.id;
        expect(command).toMatch(/^current-ui-command:/);
        expect(command).not.toBe(commandA);
      });
      const commandAfterConflict = currentUiReader?.readCurrentUiContext()?.commands[0]?.id;
      if (!commandAfterConflict) {
        throw new Error('packed_voice_current_ui_command_after_conflict_missing');
      }
      mediatedAdapter.sendContextText({
        sessionId: 'packed-candidate-mediated-session',
        text: 'run current UI context conformance',
      });
      await flushHookEffects({ cycles: 10 });
      expect(openReviewStatusDetails).toHaveBeenCalledTimes(1);
      await lifecycle.interrupt('packed-candidate-mediated-session');
      expect(providerRequests).toEqual([
        {
          method: 'GET',
          url: 'https://voice.example.test/v1/catalog',
          authorization: `Bearer ${SOURCE_CREDENTIAL}`,
        },
        {
          method: 'POST',
          url: 'https://voice.example.test/v1/session',
          authorization: `Bearer ${SOURCE_CREDENTIAL}`,
        },
      ]);

      const authorizationService = createMachineVoiceClientCredentialAuthorizationService({
        machineId: MACHINE_ID,
        currentInstallReviewPrincipal: installReviewPrincipal,
        readStoredCredentials: async () => ({ token: 'test-system-boundary-token' } as never),
        createGrantRequester: () => ({
          request: async (input) => {
            pendingRawRequest = {
              v: 1,
              id: `packed-raw-request-${pendingChangeSequence}`,
              accountId: composedBoundary.settingsScope.accountId,
              ...input,
              authoritySource: { kind: 'bundled' },
              status: 'pending',
              createdAt: 2,
              updatedAt: 2,
            };
            return { pendingRequest: pendingRawRequest };
          },
        }),
      });
      const inspectedRaw = await authorizationService.inspect({
        contribution: FIXTURE_RAW_PROVIDER_CONTRIBUTION,
      });
      expect(inspectedRaw).toMatchObject({
        authorization: {
          pluginId: FIXTURE_PLUGIN_ID,
          capability: 'credentials.materialize.raw',
          targetScope: { kind: 'account' },
          subject: {
            contribution: FIXTURE_RAW_PROVIDER_CONTRIBUTION,
            credentialSlotId: 'raw_key',
            purpose: 'voice.raw-client',
          },
          disclosures: expect.arrayContaining([
            expect.objectContaining({
              sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
              realm: 'web',
              phase: 'connection',
              materialization: 'httpHeaders',
              origin: 'https://voice.example.test',
              destination: 'authorization',
            }),
          ]),
        },
        review: {
          plugin: { id: FIXTURE_PLUGIN_ID, version: '0.1.0' },
          contribution: { identity: FIXTURE_RAW_PROVIDER_CONTRIBUTION },
          credentialSlot: { id: 'raw_key', purpose: 'voice.raw-client' },
        },
      });
      const requestedRaw = await authorizationService.request({
        contribution: FIXTURE_RAW_PROVIDER_CONTRIBUTION,
      });
      if (requestedRaw.authorization.subject.kind !== 'credential_access_disclosure') {
        throw new Error('packed_voice_raw_authorization_subject_invalid');
      }
      expect(requestedRaw.pendingRequest).toBe(pendingRawRequest);
      activeRawGrant = {
        v: 1,
        id: 'packed-raw-grant-1',
        accountId: composedBoundary.settingsScope.accountId,
        pluginId: requestedRaw.authorization.pluginId,
        capability: requestedRaw.authorization.capability,
        targetScope: requestedRaw.authorization.targetScope,
        subject: requestedRaw.authorization.subject,
        authoritySource: { kind: 'bundled' },
        status: 'active',
        requestId: requestedRaw.pendingRequest.id,
        grantedByUserId: 'packed-voice-user',
        grantedAt: 3,
        createdAt: 3,
        updatedAt: 3,
      };

      const settingsBeforeRaw = composedBoundary.settings;
      if (!settingsBeforeRaw) throw new Error('packed_voice_settings_missing');
      composedBoundary.settings = settingsParse({
        ...settingsBeforeRaw,
        voice: { ...settingsBeforeRaw.voice, providerId: FIXTURE_RAW_PROVIDER_ID },
      });
      await appShell.update(renderPackedCandidateVoiceCurrentUiComposition({
        contextRevision: 1,
        settingsRevision: 2,
        onReader: onCurrentUiReader,
        onOpenDetails: openReviewStatusDetails,
      }));
      await flushHookEffects({ cycles: 4 });
      await lifecycle.toggle('packed-candidate-raw-session');
      await waitForReact(() => {
        expect(lifecycle.getSnapshot()).toMatchObject({
          adapterId: FIXTURE_RAW_PROVIDER_ID,
          status: 'connected',
        });
      });
      expect(rawMaterializeRpcInputs).toHaveLength(1);
      expect(rawMaterializeRpcInputs[0]).toMatchObject({
        phase: 'connection',
        request: {
          kind: 'httpHeaders',
          origin: 'https://voice.example.test',
          headerNames: ['authorization'],
        },
      });
      expect(rawGrantListInputs).toHaveLength(2);
      expect(rawGrantListInputs).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          capability: 'credentials.materialize.raw',
          subject: requestedRaw.authorization.subject,
        }),
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          capability: 'credentials.materialize.raw',
          subject: requestedRaw.authorization.subject,
        }),
      ]);
      expect(JSON.stringify(rawGrantListInputs)).not.toContain('raw-source-account-secret');

      const failedUpdateArchivePath = await packVoiceFixtureVariant({
        fixtureRoot: installedFixtureRoot,
        temporaryRoot,
        variant: 'packed-candidate-voice-failed-update',
        version: '0.1.1',
        daemonRelativePath: 'daemon.js',
        daemonSource: 'export function activate() { throw new Error("packed_candidate_voice_update_rejected"); }\n',
      });
      const failedRequested = await changeService.requestPluginChange({
        kind: 'installArchive',
        locator: failedUpdateArchivePath,
      });
      if (failedRequested.kind !== 'reviewRequired') {
        throw new Error(`packed_voice_failed_review_missing:${failedRequested.kind}`);
      }
      await expect(changeService.decidePluginChange({
        pendingChangeId: failedRequested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'packed-candidate-voice-failed-update',
          occurredAtMs: 36,
        },
      })).resolves.toMatchObject({ kind: 'failed', code: 'plugin_install_failed' });
      expect(await readCurrentDaemonPluginCatalog({ happyHomeDir, reloadController }))
        .toEqual([expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          desiredGeneration: committed.desiredGeneration,
          appliedGeneration: committed.appliedGeneration,
        })]);
      expect(lifecycle.getSnapshot()).toMatchObject({
        adapterId: FIXTURE_RAW_PROVIDER_ID,
        status: 'connected',
      });
      expect(rawMaterializeRpcInputs).toHaveLength(1);
      expect(rawGrantListInputs).toHaveLength(2);

      const commandBeforeReplacement = currentUiReader?.readCurrentUiContext()?.commands[0]?.id;
      if (!commandBeforeReplacement) {
        throw new Error('packed_voice_current_ui_command_before_replacement_missing');
      }
      expect(commandBeforeReplacement).toBe(commandAfterConflict);

      const replacementArchivePath = await packVoiceFixtureVariant({
        fixtureRoot: installedFixtureRoot,
        temporaryRoot,
        variant: 'packed-candidate-voice-replacement',
        version: '0.1.2',
      });
      const replacementRequested = await changeService.requestPluginChange({
        kind: 'installArchive',
        locator: replacementArchivePath,
      });
      if (replacementRequested.kind !== 'reviewRequired') {
        throw new Error(`packed_voice_replacement_review_missing:${replacementRequested.kind}`);
      }
      const replacement = await changeService.decidePluginChange({
        pendingChangeId: replacementRequested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'packed-candidate-voice-replacement',
          occurredAtMs: 37,
        },
      });
      expect(replacement).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: expect.any(String),
        appliedGeneration: expect.any(String),
      });
      if (replacement.kind !== 'committed' || !replacement.appliedGeneration) {
        throw new Error(`packed_voice_replacement_not_current:${replacement.kind}`);
      }
      expect(replacement.appliedGeneration).not.toBe(committed.appliedGeneration);
      await publishAvailability();
      invalidateDaemonContributionRegistryProjectionCache();
      await act(async () => {
        publishMachineContributionRegistryProjectionInvalidation({
          machineId: MACHINE_ID,
          serverId: SERVER_ID,
        });
      });
      await flushHookEffects({ cycles: 10 });
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).not.toBeNull();
        expect(getExternalVoiceProviderRegistration(FIXTURE_RAW_PROVIDER_ID)).not.toBeNull();
        expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected',
          canStop: false,
        });
      });
      await waitForReact(() => {
        const snapshot = currentUiReader?.readCurrentUiContext();
        expect(snapshot?.entity?.label).toBe('Project Companion activity');
        expect(snapshot?.commands).toHaveLength(1);
        expect(snapshot?.commands[0]?.id).not.toBe(commandA);
        expect(snapshot?.commands[0]?.id).not.toBe(commandBeforeReplacement);
        expect(currentUiReader?.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(currentUiReader?.resolveCurrentUiCommand(commandBeforeReplacement)).toBeNull();
        expect(readCurrentReviewActionRegistration()).not.toBeNull();
      });
      const commandB = currentUiReader?.readCurrentUiContext()?.commands[0]?.id;
      if (!commandB) throw new Error('packed_voice_current_ui_command_b_missing');
      expect(commandB).toMatch(/^current-ui-command:/);
      expect(rawMaterializeRpcInputs).toHaveLength(1);
      expect(rawGrantListInputs).toHaveLength(2);
      expect(composedBoundary.audioSessionReleaseCount)
        .toBe(composedBoundary.audioSessionAcquireRequests.length);
      const replacementMediated = getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID);
      expect(replacementMediated?.descriptor?.accountCredentialSlot?.recipientContractDigest)
        .toBe(recipientContractDigest);
      expect(isAccountVoiceCredentialRecipientApprovalRequired({
        settings: composedBoundary.settings!,
        contribution: FIXTURE_PROVIDER_CONTRIBUTION,
        credentialSlotId: 'api_key',
        requiredRecipientContractDigest: recipientContractDigest,
      })).toBe(false);

      const replacementRawInspection = await authorizationService.inspect({
        contribution: FIXTURE_RAW_PROVIDER_CONTRIBUTION,
      });
      if (replacementRawInspection.authorization.subject.kind !== 'credential_access_disclosure') {
        throw new Error('packed_voice_replacement_raw_authorization_subject_invalid');
      }
      expect(replacementRawInspection.authorization.subject.installReviewPrincipalDigest)
        .toBe(requestedRaw.authorization.subject.installReviewPrincipalDigest);
      expect(replacementRawInspection.authorization.subject.installedGenerationId)
        .not.toBe(requestedRaw.authorization.subject.installedGenerationId);
      await expect(lifecycle.toggle('packed-candidate-raw-stale-grant-session'))
        .resolves.toBeUndefined();
      await waitForReact(() => {
        const snapshot = lifecycle.getSnapshot();
        expect(snapshot.adapterId).toBe(FIXTURE_RAW_PROVIDER_ID);
        expect(['disconnected', 'error']).toContain(snapshot.status);
        expect(snapshot).toMatchObject({
          canStop: false,
          errorCode: 'provider_auth_invalid',
        });
      });
      expect(rawMaterializeRpcInputs).toHaveLength(2);
      expect(rawGrantListInputs).toHaveLength(3);
      expect(rawGrantListInputs[2]).toMatchObject({
        pluginId: FIXTURE_PLUGIN_ID,
        capability: 'credentials.materialize.raw',
        subject: replacementRawInspection.authorization.subject,
      });

      const replacementRawRequest = await authorizationService.request({
        contribution: FIXTURE_RAW_PROVIDER_CONTRIBUTION,
      });
      activeRawGrant = {
        v: 1,
        id: 'packed-raw-grant-2',
        accountId: composedBoundary.settingsScope.accountId,
        pluginId: replacementRawRequest.authorization.pluginId,
        capability: replacementRawRequest.authorization.capability,
        targetScope: replacementRawRequest.authorization.targetScope,
        subject: replacementRawRequest.authorization.subject,
        authoritySource: { kind: 'bundled' },
        status: 'active',
        requestId: replacementRawRequest.pendingRequest.id,
        grantedByUserId: 'packed-voice-user',
        grantedAt: 4,
        createdAt: 4,
        updatedAt: 4,
      };
      lifecycle.rearmAfterCredentialAuthorityChange();
      await lifecycle.toggle('packed-candidate-raw-replacement-session');
      await waitForReact(() => {
        expect(lifecycle.getSnapshot()).toMatchObject({
          adapterId: FIXTURE_RAW_PROVIDER_ID,
          status: 'connected',
        });
      });
      expect(rawMaterializeRpcInputs).toHaveLength(3);
      expect(rawGrantListInputs).toHaveLength(5);
      expect(rawGrantListInputs.slice(3)).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          capability: 'credentials.materialize.raw',
          subject: replacementRawRequest.authorization.subject,
        }),
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          capability: 'credentials.materialize.raw',
          subject: replacementRawRequest.authorization.subject,
        }),
      ]);

      const disabled = await changeService.requestPluginChange({
        kind: 'disable',
        pluginId: FIXTURE_PLUGIN_ID,
      });
      expect(disabled).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        appliedGeneration: null,
      });
      await publishAvailability();
      invalidateDaemonContributionRegistryProjectionCache();
      await act(async () => {
        publishMachineContributionRegistryProjectionInvalidation({ machineId: MACHINE_ID, serverId: SERVER_ID });
      });
      await flushHookEffects({ cycles: 8 });
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).toBeNull();
        expect(getExternalVoiceProviderRegistration(FIXTURE_RAW_PROVIDER_ID)).toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_STT_PROVIDER_ID)).toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_TTS_PROVIDER_ID)).toBeNull();
        expect(currentUiReader?.resolveCurrentUiCommand(commandB)).toBeNull();
        const snapshot = currentUiReader?.readCurrentUiContext();
        expect(snapshot?.entity).toBeUndefined();
        expect(snapshot?.detail).toBeUndefined();
        expect(snapshot?.commands).toEqual([]);
        expect(readCurrentReviewActionRegistration()).toBeNull();
        expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected',
          canStop: false,
        });
      });
      expect(rawMaterializeRpcInputs).toHaveLength(3);
      expect(rawGrantListInputs).toHaveLength(5);
      expect(composedBoundary.audioSessionReleaseCount)
        .toBe(composedBoundary.audioSessionAcquireRequests.length);

      const enabled = await changeService.requestPluginChange({
        kind: 'enable',
        pluginId: FIXTURE_PLUGIN_ID,
      });
      expect(enabled).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        appliedGeneration: replacement.appliedGeneration,
      });
      await publishAvailability();
      invalidateDaemonContributionRegistryProjectionCache();
      await act(async () => {
        publishMachineContributionRegistryProjectionInvalidation({ machineId: MACHINE_ID, serverId: SERVER_ID });
      });
      await flushHookEffects({ cycles: 8 });
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).not.toBeNull();
        expect(getExternalVoiceProviderRegistration(FIXTURE_RAW_PROVIDER_ID)).not.toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_STT_PROVIDER_ID)).not.toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_TTS_PROVIDER_ID)).not.toBeNull();
        expect(readCurrentReviewActionRegistration()).not.toBeNull();
      });
      const reenabledSpeech = createDefaultVoiceProviderRegistry().get(FIXTURE_STT_PROVIDER_ID);
      if (!reenabledSpeech) throw new Error('packed_voice_reenabled_speech_missing');
      await expect(speechClient.transcribe({
        entry: reenabledSpeech,
        source: { kind: 'memory', bytes: new Uint8Array([82, 73, 70, 70]) },
        mimeType: 'audio/wav',
        fileName: 'synthetic-reenabled.wav',
        model: 'synthetic-stt-v1',
        language: 'en',
      })).resolves.toBe('synthetic transcript');

      const settingsBeforeReenabledStart = composedBoundary.settings;
      if (!settingsBeforeReenabledStart) throw new Error('packed_voice_reenabled_settings_missing');
      composedBoundary.settings = settingsParse({
        ...settingsBeforeReenabledStart,
        voice: { ...settingsBeforeReenabledStart.voice, providerId: FIXTURE_PROVIDER_ID },
      });
      await appShell.update(renderPackedCandidateVoiceCurrentUiComposition({
        contextRevision: 1,
        settingsRevision: 3,
        onReader: onCurrentUiReader,
        onOpenDetails: openReviewStatusDetails,
      }));
      await flushHookEffects({ cycles: 4 });
      await waitForReact(() => {
        const snapshot = currentUiReader?.readCurrentUiContext();
        expect(snapshot?.entity?.label).toBe('Project Companion activity');
        expect(snapshot?.detail).toEqual({
          source: 'public-authoring-project-companion-activity',
        });
        expect(snapshot?.commands).toHaveLength(1);
        expect(snapshot?.commands[0]?.id).not.toBe(commandB);
        expect(currentUiReader?.resolveCurrentUiCommand(commandB)).toBeNull();
      });
      const commandC = currentUiReader?.readCurrentUiContext()?.commands[0]?.id;
      if (!commandC) throw new Error('packed_voice_current_ui_command_c_missing');
      expect(commandC).toMatch(/^current-ui-command:/);
      lifecycle.rearmAfterCredentialAuthorityChange();
      await lifecycle.toggle('packed-candidate-mediated-reenabled-session');
      await waitForReact(() => {
        expect(lifecycle.getSnapshot()).toMatchObject({
          adapterId: FIXTURE_PROVIDER_ID,
          status: 'connected',
        });
      });
      const reenabledMediatedAdapter = getVoiceAdapterRegistry().get(FIXTURE_PROVIDER_ID);
      if (!reenabledMediatedAdapter?.sendContextText) {
        throw new Error('packed_voice_reenabled_current_ui_adapter_send_text_missing');
      }
      reenabledMediatedAdapter.sendContextText({
        sessionId: 'packed-candidate-mediated-reenabled-session',
        text: 'run current UI context conformance',
      });
      await waitForReact(() => {
        expect(openReviewStatusDetails).toHaveBeenCalledTimes(2);
      });
      expect(providerRequests.filter((request) => request.method === 'POST')).toHaveLength(2);

      const uninstalled = await changeService.requestPluginChange({
        kind: 'uninstall',
        pluginId: FIXTURE_PLUGIN_ID,
      });
      expect(uninstalled).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: null,
        appliedGeneration: null,
      });
      await publishAvailability();
      invalidateDaemonContributionRegistryProjectionCache();
      await act(async () => {
        publishMachineContributionRegistryProjectionInvalidation({ machineId: MACHINE_ID, serverId: SERVER_ID });
      });
      await flushHookEffects({ cycles: 8 });
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).toBeNull();
        expect(getExternalVoiceProviderRegistration(FIXTURE_RAW_PROVIDER_ID)).toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_STT_PROVIDER_ID)).toBeNull();
        expect(createDefaultVoiceProviderRegistry().get(FIXTURE_TTS_PROVIDER_ID)).toBeNull();
        expect(currentUiReader?.resolveCurrentUiCommand(commandC)).toBeNull();
        const snapshot = currentUiReader?.readCurrentUiContext();
        expect(snapshot?.entity).toBeUndefined();
        expect(snapshot?.detail).toBeUndefined();
        expect(snapshot?.commands).toEqual([]);
        expect(readCurrentReviewActionRegistration()).toBeNull();
        expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected',
          canStop: false,
        });
      });
      expect(composedBoundary.audioSessionAcquireRequests.length).toBeGreaterThan(0);
      expect(composedBoundary.audioSessionReleaseCount)
        .toBe(composedBoundary.audioSessionAcquireRequests.length);
      expect(providerRequests.filter((request) => request.method === 'POST')).toHaveLength(2);
      expect(await readCurrentDaemonPluginCatalog({ happyHomeDir, reloadController })).toEqual([]);
      expect((await loadInstalledPlugins({ happyHomeDir })).loadedPlugins).toEqual([]);
      // The genuine network boundary necessarily receives the mediated secret;
      // UI projections, lifecycle state, and grant inspection must not.
      expect(JSON.stringify({
        projection: composedBoundary.latestAppShellProjection,
        lifecycle: lifecycle.getSnapshot(),
        rawGrantListInputs,
        rawMaterializeRpcInputs,
      })).not.toContain(SOURCE_CREDENTIAL);
      expect(JSON.stringify({
        projection: composedBoundary.latestAppShellProjection,
        lifecycle: lifecycle.getSnapshot(),
        rawGrantListInputs,
        rawMaterializeRpcInputs,
      })).not.toContain('raw-source-account-secret');
    } finally {
      globalThis.fetch = originalFetch;
      standardCleanup();
      appShell = null;
      await flushHookEffects({ cycles: 2 }).catch(() => undefined);
      const { getInstalledPluginUiExecutableModuleHost } = await import(
        '../../../../apps/ui/sources/components/plugins/reactNative/executableModuleHost'
      );
      await getInstalledPluginUiExecutableModuleHost().unload().catch(() => undefined);
      await speechRpcRegistration?.dispose().catch(() => undefined);
      await credentialRpcRegistration?.dispose().catch(() => undefined);
      await changeService.shutdown().catch(() => undefined);
      await reloadController.shutdown({ timeoutMs: 5_000 }).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
      invalidateDaemonContributionRegistryProjectionCache();
      clearPluginAccountAvailabilityProjection();
      composedBoundary.handlers.clear();
      composedBoundary.loaderBackend = null;
      composedBoundary.machines = [];
      composedBoundary.settings = null;
      composedBoundary.latestHarnessVoice = null;
      composedBoundary.latestAppShellProjection = null;
      appShellProjectionModule = null;
      voiceNormalSurfaceModules = null;
    }
  }, 180_000);
});
