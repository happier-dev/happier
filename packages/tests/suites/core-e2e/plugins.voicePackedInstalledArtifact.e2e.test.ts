import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { act } from 'react-test-renderer';
import {
  createFeatureDecision,
  createRecipientContractDigestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  RpcHandlerMap,
  RpcHandlerRegistrar,
} from '../../../../apps/cli/src/api/rpc/types';
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
import {
  invalidateDaemonContributionRegistryProjectionCache,
  registerDaemonContributionRegistryProjectionHandler,
} from '../../../../apps/cli/src/rpc/handlers/daemonContributionRegistryProjection';
import { createReactNativeWebLoaderBackend } from '../../../../apps/ui/sources/components/plugins/reactNative/webLoaderBackend.web';
import { flushHookEffects, renderScreen, standardCleanup } from '../../../../apps/ui/sources/dev/testkit';
import { settingsParse } from '../../../../apps/ui/sources/sync/domains/settings/settings';
import type { VoiceSettings } from '../../../../apps/ui/sources/sync/domains/settings/voiceSettings';
import {
  normalizeVoiceSettingsLocalDelta,
} from '../../../../apps/ui/sources/sync/domains/settings/voiceSettingsPersistence';
import {
  publishMachineContributionRegistryProjectionInvalidation,
} from '../../../../apps/ui/sources/sync/ops/machineContributionRegistryProjection';
import { voiceSessionBindingStore } from '../../../../apps/ui/sources/voice/binding/voiceConversationBindingStore';
import {
  isAccountVoiceCredentialRecipientApprovalRequired,
  upsertAccountVoiceCredential,
} from '../../../../apps/ui/sources/voice/credentials/accountVoiceCredential';
import { createDefaultVoiceProviderRegistry } from '../../../../apps/ui/sources/voice/registry/defaultRegistry';
import { getExternalVoiceProviderRegistration } from '../../../../apps/ui/sources/voice/registry/externalVoiceProviderRegistrations';
import { projectVoiceProviderSettings } from '../../../../apps/ui/sources/voice/registry/providerRegistry';
import { projectVoiceProviderSelectionRows } from '../../../../apps/ui/sources/voice/registry/providerSelection';
import { getVoiceSessionLifecycleController } from '../../../../apps/ui/sources/voice/session/voiceSessionLifecycleControllerStore';
import { readCanonicalVoiceTranscriptSnapshot } from '../../../../apps/ui/sources/voice/transcript/voiceConversationTranscript';

const FIXTURE_PLUGIN_ID = 'acme.packed-voice';
const FIXTURE_PROVIDER_LOCAL_ID = 'conversation';
const FIXTURE_PROVIDER_ID = `${FIXTURE_PLUGIN_ID}/${FIXTURE_PROVIDER_LOCAL_ID}`;
const MACHINE_ID = 'machine-packed-voice';
const SERVER_ID = 'server-packed-voice';
const SOURCE_CREDENTIAL = 'source-account-secret';

type RpcBoundaryHandler = (payload: unknown) => Promise<unknown> | unknown;

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
    return await handler(input.payload);
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
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    },
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

function readFixtureEvents(): readonly unknown[] {
  const value = (globalThis as typeof globalThis & {
    __HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__?: unknown;
  }).__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__;
  if (!Array.isArray(value)) throw new Error('packed_voice_fixture_events_unavailable');
  return value;
}

function readPackedProviderSelectionTrace(renderedChecked: unknown): Readonly<Record<string, unknown>> {
  const settings = composedBoundary.settings;
  const persistedVoice = settings?.voiceSettingsV1;
  const harnessVoice = composedBoundary.latestHarnessVoice;
  const registration = getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID);
  const descriptor = registration?.descriptor ?? null;
  const runtimeEnvelope = settings?.voice.providers[FIXTURE_PROVIDER_ID] ?? null;
  const projectedSettings = descriptor
    ? projectVoiceProviderSettings(descriptor, runtimeEnvelope)
    : null;
  const row = settings
    ? projectVoiceProviderSelectionRows(
        settings.voice,
        createDefaultVoiceProviderRegistry(),
      ).find((candidate) => (
        candidate.providerId === FIXTURE_PROVIDER_ID
        && candidate.optionId === 'default'
      )) ?? null
    : null;
  return Object.freeze({
    runtimeProviderId: settings?.voice.providerId ?? null,
    persistedProviderId: persistedVoice?.providerId ?? null,
    harnessProviderId: harnessVoice?.providerId ?? null,
    runtimeEnvelope,
    persistedEnvelope: persistedVoice?.providers[FIXTURE_PROVIDER_ID] ?? null,
    harnessEnvelope: harnessVoice?.providers[FIXTURE_PROVIDER_ID] ?? null,
    descriptorProjection: projectedSettings,
    row: row
      ? {
          providerId: row.providerId,
          optionId: row.optionId,
          modeId: row.modeId,
          selected: row.selected,
        }
      : null,
    renderedChecked: renderedChecked ?? null,
  });
}

function AppShellProjectionProbe(): React.ReactElement | null {
  const { useAppShellPluginUiProjection } = requireAppShellProjectionModule();
  const projection = useAppShellPluginUiProjection();
  composedBoundary.latestAppShellProjection = projection;
  return null;
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
    await writeFile(join(variantRoot, 'dist/daemon.js'), input.daemonSource);
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

describe('packed installed-artifact external Voice provider', () => {
  it('runs through normal settings and lifecycle across replacement, disable/re-enable, and uninstall', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-packed-voice-composed-'));
    const happyHomeDir = join(temporaryRoot, 'happy-home');
    const archivePath = join(temporaryRoot, 'packed-voice.tgz');
    const fixtureRoot = fileURLToPath(new URL(
      '../../../../apps/cli/src/plugins/testkit/fixtures/packed-external-voice-provider/',
      import.meta.url,
    ));
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
    const changeService = createDaemonPluginChangeService({
      prepare: async (request) => request.kind === 'installArchive'
        ? await prepareArchiveChange(request)
        : await prepareStateChange(request),
      createPendingChangeId: () => 'packed-voice-install-review',
    });
    const originalFetch = globalThis.fetch;
    let appShell: Awaited<ReturnType<typeof renderScreen>> | null = null;

    try {
      composedBoundary.machines = [{
        id: MACHINE_ID,
        active: true,
        activeAt: Date.now(),
        lastSeen: Date.now(),
        daemonStateVersion: 1,
        metadata: {
          host: 'packed-voice-safe-host',
          privatePath: '/Users/alice/private-voice-workspace',
        },
        privateSessionSummary: 'private packed Voice session summary',
      }];
      composedBoundary.settings = settingsParse({
        voice: {
          providerId: 'off',
          executionMachine: {
            mode: 'fixed',
            machineId: MACHINE_ID,
          },
          privacy: {
            shareDeviceInventory: true,
            shareFilePaths: false,
            shareSessionSummary: false,
            sharePermissionRequests: false,
            shareRecentMessages: false,
          },
        },
      });
      composedBoundary.audioSessionAcquireRequests = [];
      composedBoundary.audioSessionReleaseCount = 0;

      const stateStore = createPluginRegistryStateStore({
        happyHomeDir,
        runtimeLifecycle,
      });
      await stateStore.initialize();
      const initialRuntimeLease = await reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir,
          generation: reloadController.getState().generation + 1,
        }),
      });
      await initialRuntimeLease.release();

      const packed = await packLocalPlugin({
        locator: fixtureRoot,
        outPath: archivePath,
      });
      expect(
        packed,
        packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n'),
      ).toMatchObject({ ok: true });
      if (!packed.ok) return;

      const requested = await changeService.requestPluginChange({
        kind: 'installArchive',
        locator: archivePath,
      });
      expect(requested).toMatchObject({
        kind: 'reviewRequired',
        review: {
          pluginId: FIXTURE_PLUGIN_ID,
          source: {
            kind: 'archive',
            locator: expect.stringMatching(/packed-voice\.tgz$/),
          },
          executableRealms: ['daemon'],
          contributions: expect.arrayContaining([
            { family: 'voiceProviders', count: 1 },
          ]),
          uiArtifacts: {
            status: 'verified',
            contributionIds: expect.arrayContaining(['voice-runtime-web']),
          },
          requiredHostAccess: [{
            id: 'voice-provider-api',
            capability: 'network',
            reason: 'Read, provision, and authenticate a bounded Voice session',
            authorizationClass: 'cooperativeDisclosure',
            normalizedScope: expect.objectContaining({
              methods: expect.arrayContaining(['GET', 'PATCH', 'POST']),
            }),
          }],
        },
      });
      if (requested.kind !== 'reviewRequired') {
        throw new Error(`expected_packed_voice_review:${requested.kind}`);
      }

      const committed = await changeService.decidePluginChange({
        pendingChangeId: requested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'packed-voice-install',
          occurredAtMs: 35,
        },
      });
      expect(committed).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: expect.any(String),
        appliedGeneration: expect.any(String),
        pendingSurfaces: [],
      });
      if (committed.kind !== 'committed' || !committed.appliedGeneration) {
        throw new Error(`packed_voice_install_not_current:${committed.kind}`);
      }

      const loaded = await loadInstalledPlugins({ happyHomeDir });
      expect(loaded.loadedPlugins).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          pluginRootPath: expect.stringContaining(committed.appliedGeneration),
          sourceSpec: expect.objectContaining({
            kind: 'archive',
            trustPolicy: 'prompt',
          }),
        }),
      ]);
      const currentCatalog = await readCurrentDaemonPluginCatalog({
        happyHomeDir,
        reloadController,
      });
      expect(currentCatalog).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          enabled: true,
          desiredGeneration: committed.desiredGeneration,
          appliedGeneration: committed.appliedGeneration,
          install: expect.objectContaining({
            trust: expect.objectContaining({
              pluginId: FIXTURE_PLUGIN_ID,
              state: 'trusted',
              approvedAtMs: 35,
            }),
          }),
        }),
      ]);
      expect(reloadController.getState()).toMatchObject({
        generation: expect.any(Number),
        activeRegistry: expect.objectContaining({
          generation: expect.any(Number),
        }),
      });

      const { handlers, registrar } = createRegistrar();
      composedBoundary.handlers = handlers as Map<string, RpcBoundaryHandler>;
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
          return await import(
            /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
          );
        },
      });
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
      // Packing and installation can outlive the real machine-online grace
      // period; refresh this synthetic presence at the UI boundary it drives.
      const appShellRenderStartedAt = Date.now();
      composedBoundary.machines = composedBoundary.machines.map((machine) => (
        machine.id === MACHINE_ID
          ? {
              ...machine,
              activeAt: appShellRenderStartedAt,
              lastSeen: appShellRenderStartedAt,
            }
          : machine
      ));
      appShell = await renderScreen(React.createElement(
        appShellProjectionModule.AppShellPluginUiProjectionProvider,
        null,
        React.createElement(AppShellProjectionProbe),
        React.createElement(VoiceNormalSurfaceHarness, { settingsRevision: 0 }),
      ));
      await flushHookEffects({ cycles: 8 });
      await waitForReact(() => {
        expect(
          getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID),
          JSON.stringify(composedBoundary.latestAppShellProjection, null, 2),
        ).not.toBeNull();
      });

      const appProjection = composedBoundary.latestAppShellProjection;
      expect(appProjection).toMatchObject({
        interactionEnabled: true,
        machineId: MACHINE_ID,
        pluginUiProjection: {
          generation: reloadController.getState().generation,
          voiceProvidersById: {
            [FIXTURE_PROVIDER_ID]: expect.objectContaining({
              pluginId: FIXTURE_PLUGIN_ID,
              definition: expect.objectContaining({
                id: FIXTURE_PROVIDER_LOCAL_ID,
                kind: 'conversation',
                platforms: ['web'],
              }),
              recipientContract: expect.objectContaining({
                operations: expect.arrayContaining([
                  expect.objectContaining({ id: 'list-voices', effect: 'read' }),
                  expect.objectContaining({ id: 'provision-voice', effect: 'mutation' }),
                  expect.objectContaining({ id: 'client-auth', effect: 'read' }),
                ]),
              }),
            }),
          },
        },
      });

      const registration = getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID);
      if (
        !registration?.descriptor
        || !registration.adapter
        || !registration.settingsOperations?.listCatalog
        || !registration.settingsOperations.provision
      ) {
        throw new Error('packed_voice_registration_incomplete');
      }
      const descriptor = registration.descriptor;
      const listCatalog = registration.settingsOperations.listCatalog;
      const provision = registration.settingsOperations.provision;
      const recipientContract = descriptor.accountCredentialSlot?.recipientContract;
      if (!recipientContract) throw new Error('packed_voice_recipient_contract_missing');
      const recipientContractDigest = createRecipientContractDigestV1(recipientContract);
      expect(descriptor.accountCredentialSlot?.recipientContractDigest)
        .toBe(recipientContractDigest);

      composedBoundary.settings = settingsParse({
        secrets: [{
          id: 'packed-voice-secret',
          name: 'Packed Voice',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: SOURCE_CREDENTIAL },
          createdAt: 1,
          updatedAt: 1,
        }],
        voice: {
          providerId: null,
          executionMachine: {
            mode: 'fixed',
            machineId: MACHINE_ID,
          },
          privacy: {
            shareDeviceInventory: true,
            shareFilePaths: false,
            shareSessionSummary: false,
            sharePermissionRequests: false,
            shareRecentMessages: false,
          },
          providers: {
            [FIXTURE_PROVIDER_ID]: {
              schemaVersion: 2,
              config: {
                mode: 'default',
                profile: 'balanced',
                enableProvisioning: true,
              },
            },
          },
          credentialBindings: [{
            providerId: FIXTURE_PROVIDER_ID,
            approvedRecipientContractDigest: recipientContractDigest,
            credentialBindings: {
              account: { api_key: 'packed-voice-secret' },
            },
          }],
        },
      });

      await appShell.update(React.createElement(
        appShellProjectionModule.AppShellPluginUiProjectionProvider,
        null,
        React.createElement(AppShellProjectionProbe),
        React.createElement(VoiceNormalSurfaceHarness, { settingsRevision: 1 }),
      ));
      await flushHookEffects({ cycles: 4 });
      const providerSelectionTestId =
        `settings.voice.provider.${encodeURIComponent(FIXTURE_PROVIDER_ID)}.default`;
      await waitForReact(() => {
        const rows = appShell?.findAll((node) => (
          typeof node.props.testID === 'string'
          && node.props.testID.startsWith('settings.voice.provider.')
        )).map((node) => ({
          testID: node.props.testID,
          ariaChecked: node.props['aria-checked'],
          ariaDisabled: node.props['aria-disabled'],
        })) ?? [];
        expect(rows).toEqual(expect.arrayContaining([
          {
            testID: providerSelectionTestId,
            ariaChecked: false,
            ariaDisabled: undefined,
          },
        ]));
      });
      await appShell.pressByTestIdAsync(providerSelectionTestId);
      await flushHookEffects({ cycles: 2 });
      const lifecycle = getVoiceSessionLifecycleController();
      if (!lifecycle) throw new Error('packed_voice_lifecycle_unavailable');
      await waitForReact(() => {
        expect(lifecycle.getConfiguredProviderId()).toBe(FIXTURE_PROVIDER_ID);
        expect(appShell?.findByTestId(providerSelectionTestId)?.props['aria-checked']).toBe(true);
      });

      const providerRequests: Array<Readonly<{
        method: string;
        url: string;
        authorization: string | null;
        body: string | null;
      }>> = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method ?? 'GET');
        const body = init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(init.body))
          : null;
        providerRequests.push(Object.freeze({
          method,
          url,
          authorization: new Headers(init?.headers).get('authorization'),
          body,
        }));
        const responseBody = method === 'GET'
          ? {
              voices: [{
                voice_id: 'packed-voice-primary',
                name: 'Packed Primary',
                language: 'en',
              }],
            }
          : method === 'PATCH'
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
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      await expect(listCatalog({
        catalog: 'voices',
        providerConfig: {
          mode: 'default',
          profile: 'balanced',
          enableProvisioning: true,
        },
        signal: new AbortController().signal,
      })).resolves.toEqual([{
        id: 'packed-voice-primary',
        name: 'Packed Primary',
        metadata: { language: 'en' },
      }]);
      await expect(provision({
        request: {
          kind: 'provision_selected_voice',
          voiceId: 'packed-voice-primary',
        },
        providerConfig: {
          mode: 'default',
          profile: 'balanced',
          enableProvisioning: true,
        },
        disabledActionIds: [],
        extraSystemAppendBlocks: [],
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        selectedVoiceId: 'packed-voice-primary',
        profile: 'balanced',
      });

      const controlSessionId = 'packed-voice-control-session';
      await lifecycle.toggle(controlSessionId);
      await waitForReact(() => {
        expect(JSON.stringify(readFixtureEvents())).toContain('fixture_continue');
      });
      expect(lifecycle.getSnapshot()).toMatchObject({
        adapterId: FIXTURE_PROVIDER_ID,
        status: 'connected',
      });
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId);
      expect(binding).toMatchObject({
        adapterId: FIXTURE_PROVIDER_ID,
        controlSessionId,
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
      });
      if (!binding) throw new Error('packed_voice_runtime_binding_missing');
      const transcriptSnapshot = readCanonicalVoiceTranscriptSnapshot(binding.conversationSessionId);
      expect(transcriptSnapshot).toEqual([
        expect.objectContaining({
          role: 'user',
          text: 'packed provider transcript',
          final: true,
        }),
      ]);

      expect(readFixtureEvents()).toEqual(expect.arrayContaining([
        { kind: 'activated' },
        { kind: 'catalog', selectedVoiceId: 'packed-voice-primary' },
        {
          kind: 'provisioned',
          selectedVoiceId: 'packed-voice-primary',
          profile: 'balanced',
        },
        expect.objectContaining({
          kind: 'client_auth',
          artifact: expect.objectContaining({
            kind: 'bearer_token',
            placement: 'authorization_header',
          }),
        }),
        { kind: 'prepared', profile: 'balanced' },
        expect.objectContaining({
          kind: 'attempt_tool',
          toolName: 'listMachines',
          result: expect.objectContaining({
            items: [expect.objectContaining({
              machineId: MACHINE_ID,
              host: 'packed-voice-safe-host',
            })],
          }),
        }),
        { kind: 'connection_created' },
        { kind: 'host_media_opened' },
        expect.objectContaining({ kind: 'sent', event: expect.objectContaining({ kind: 'fixture_tool_results' }) }),
        expect.objectContaining({ kind: 'sent', event: expect.objectContaining({ kind: 'fixture_continue' }) }),
      ]));

      await lifecycle.interrupt(controlSessionId);
      expect(readFixtureEvents()).toEqual(expect.arrayContaining([
        {
          kind: 'sent',
          event: { kind: 'fixture_cancel' },
        },
      ]));

      expect(providerRequests).toEqual([
        {
          method: 'GET',
          url: 'https://voice.example.test/v1/voices',
          authorization: `Bearer ${SOURCE_CREDENTIAL}`,
          body: null,
        },
        {
          method: 'PATCH',
          url: 'https://voice.example.test/v1/voices/packed-voice-primary',
          authorization: `Bearer ${SOURCE_CREDENTIAL}`,
          body: '{"profile":"balanced"}',
        },
        {
          method: 'POST',
          url: 'https://voice.example.test/v1/session',
          authorization: `Bearer ${SOURCE_CREDENTIAL}`,
          body: '{"audience":"realtime","voiceId":"packed-voice-primary"}',
        },
      ]);
      expect(JSON.stringify(readFixtureEvents())).not.toContain(SOURCE_CREDENTIAL);
      expect(JSON.stringify(readFixtureEvents())).not.toContain('short-lived-packed-artifact');
      expect(JSON.stringify(readFixtureEvents())).not.toContain('/Users/alice');
      expect(JSON.stringify(readFixtureEvents())).not.toContain('private packed Voice session summary');
      expect(JSON.stringify(transcriptSnapshot)).not.toContain(SOURCE_CREDENTIAL);

      const failedUpdateArchivePath = await packVoiceFixtureVariant({
        fixtureRoot,
        temporaryRoot,
        variant: 'packed-voice-failed-update',
        version: '1.0.1',
        daemonSource:
          'export function activate() { throw new Error("packed_voice_update_rejected"); }\n',
      });
      const failedUpdateRequested = await changeService.requestPluginChange({
        kind: 'installArchive',
        locator: failedUpdateArchivePath,
      });
      expect(failedUpdateRequested).toMatchObject({
        kind: 'reviewRequired',
        review: {
          pluginId: FIXTURE_PLUGIN_ID,
          packageIdentity: { version: '1.0.1' },
        },
      });
      if (failedUpdateRequested.kind !== 'reviewRequired') {
        throw new Error(`expected_packed_voice_failed_update_review:${failedUpdateRequested.kind}`);
      }
      const failedUpdate = await changeService.decidePluginChange({
        pendingChangeId: failedUpdateRequested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'packed-voice-failed-update',
          occurredAtMs: 36,
        },
      });
      expect(failedUpdate).toMatchObject({
        kind: 'failed',
        code: 'plugin_install_failed',
      });
      expect(await readCurrentDaemonPluginCatalog({
        happyHomeDir,
        reloadController,
      })).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          enabled: true,
          desiredGeneration: committed.desiredGeneration,
          appliedGeneration: committed.appliedGeneration,
        }),
      ]);
      expect(lifecycle.getSnapshot()).toMatchObject({
        adapterId: FIXTURE_PROVIDER_ID,
        status: 'connected',
      });

      const replacementArchivePath = await packVoiceFixtureVariant({
        fixtureRoot,
        temporaryRoot,
        variant: 'packed-voice-replacement',
        version: '1.0.2',
      });
      const replacementRequested = await changeService.requestPluginChange({
        kind: 'installArchive',
        locator: replacementArchivePath,
      });
      expect(replacementRequested).toMatchObject({
        kind: 'reviewRequired',
        review: {
          pluginId: FIXTURE_PLUGIN_ID,
          packageIdentity: { version: '1.0.2' },
        },
      });
      if (replacementRequested.kind !== 'reviewRequired') {
        throw new Error(`expected_packed_voice_replacement_review:${replacementRequested.kind}`);
      }
      const replacement = await changeService.decidePluginChange({
        pendingChangeId: replacementRequested.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'packed-voice-replacement',
          occurredAtMs: 37,
        },
      });
      expect(replacement).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: expect.any(String),
        appliedGeneration: expect.any(String),
        pendingSurfaces: ['reconciliation'],
      });
      if (replacement.kind !== 'committed' || !replacement.appliedGeneration) {
        throw new Error(`packed_voice_replacement_not_current:${replacement.kind}`);
      }
      expect(replacement.appliedGeneration).not.toBe(committed.appliedGeneration);

      const publishProjectionInvalidation = async () => {
        invalidateDaemonContributionRegistryProjectionCache();
        await act(async () => {
          publishMachineContributionRegistryProjectionInvalidation({
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
          });
        });
        await flushHookEffects({ cycles: 8 });
      };
      await publishProjectionInvalidation();
      await waitForReact(() => {
        expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected',
          canStop: false,
        });
        expect(appShell?.findByTestId(providerSelectionTestId)).toBeTruthy();
        expect(JSON.stringify(readFixtureEvents())).toContain('runtime_disposed');
      });
      await expect(listCatalog({
        catalog: 'voices',
        providerConfig: {
          mode: 'default',
          profile: 'balanced',
          enableProvisioning: true,
        },
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'voice_account_operation_cancelled',
      });

      const replacementRegistration =
        getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID);
      const replacementRecipientContractDigest =
        replacementRegistration?.descriptor?.accountCredentialSlot?.recipientContractDigest;
      expect(replacementRecipientContractDigest).toEqual(expect.any(String));
      expect(replacementRecipientContractDigest).not.toBe(recipientContractDigest);
      const credentialItemTestId =
        `settings.voice.externalCredential.${encodeURIComponent(FIXTURE_PROVIDER_ID)}.api_key`;
      await waitForReact(() => {
        const credentialItem = appShell?.findByTestId(credentialItemTestId);
        expect(credentialItem).toBeTruthy();
        expect(isAccountVoiceCredentialRecipientApprovalRequired({
          settings: composedBoundary.settings!,
          providerId: FIXTURE_PROVIDER_ID,
          credentialSlotId: 'api_key',
          requiredRecipientContractDigest: replacementRecipientContractDigest,
        })).toBe(true);
      });
      const selectionBeforeRecipientApproval = readPackedProviderSelectionTrace(
        appShell?.findByTestId(providerSelectionTestId)?.props['aria-checked'],
      );
      if (!replacementRecipientContractDigest) {
        throw new Error('packed_voice_replacement_recipient_contract_missing');
      }
      const settingsBeforeRecipientApproval = composedBoundary.settings;
      if (!settingsBeforeRecipientApproval) {
        throw new Error('packed_voice_settings_unavailable');
      }
      composedBoundary.settings = upsertAccountVoiceCredential({
        settings: settingsBeforeRecipientApproval,
        providerId: FIXTURE_PROVIDER_ID,
        credentialSlotId: 'api_key',
        value: SOURCE_CREDENTIAL,
        generateId: () => 'packed-voice-secret-reapproved',
        now: 2,
        expectedSecretId: 'packed-voice-secret',
        expectedSecretUpdatedAt: 1,
        approvedRecipientContractDigest: replacementRecipientContractDigest,
      }).settings;
      await appShell.update(React.createElement(
        appShellProjectionModule.AppShellPluginUiProjectionProvider,
        null,
        React.createElement(AppShellProjectionProbe),
        React.createElement(VoiceNormalSurfaceHarness, { settingsRevision: 2 }),
      ));
      await flushHookEffects({ cycles: 4 });
      await waitForReact(() => {
        const selectionAfterRecipientApproval = readPackedProviderSelectionTrace(
          appShell?.findByTestId(providerSelectionTestId)?.props['aria-checked'],
        );
        const selectionTrace = JSON.stringify({
          beforeRecipientApproval: selectionBeforeRecipientApproval,
          afterRecipientApproval: selectionAfterRecipientApproval,
        });
        expect(isAccountVoiceCredentialRecipientApprovalRequired({
          settings: composedBoundary.settings!,
          providerId: FIXTURE_PROVIDER_ID,
          credentialSlotId: 'api_key',
          requiredRecipientContractDigest: replacementRecipientContractDigest,
        })).toBe(false);
        expect(
          selectionAfterRecipientApproval.runtimeProviderId,
          selectionTrace,
        ).toBe(FIXTURE_PROVIDER_ID);
        expect(
          selectionAfterRecipientApproval.persistedProviderId,
          selectionTrace,
        ).toBe(FIXTURE_PROVIDER_ID);
        expect(
          selectionAfterRecipientApproval.harnessProviderId,
          selectionTrace,
        ).toBe(FIXTURE_PROVIDER_ID);
        expect(
          selectionAfterRecipientApproval.descriptorProjection,
          selectionTrace,
        ).toMatchObject({ status: 'ready', modeId: 'default' });
        expect(
          selectionAfterRecipientApproval.row,
          selectionTrace,
        ).toMatchObject({ selected: true, modeId: 'default' });
        expect(
          selectionAfterRecipientApproval.renderedChecked,
          selectionTrace,
        ).toBe(true);
        expect(appShell?.findByTestId(credentialItemTestId)).toBeTruthy();
      });

      await lifecycle.toggle(controlSessionId);
      await waitForReact(() => {
        const snapshot = lifecycle.getSnapshot();
        expect(snapshot, JSON.stringify(snapshot)).toMatchObject({
          adapterId: FIXTURE_PROVIDER_ID,
          status: 'connected',
        });
      });

      const disabled = await changeService.requestPluginChange({
        kind: 'disable',
        pluginId: FIXTURE_PLUGIN_ID,
      });
      expect(disabled).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: replacement.desiredGeneration,
        appliedGeneration: null,
      });
      await publishProjectionInvalidation();
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).toBeNull();
        expect(appShell?.findByTestId(providerSelectionTestId)).toBeNull();
        expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected',
          canStop: false,
        });
      });
      expect((await loadInstalledPlugins({ happyHomeDir })).loadedPlugins).toEqual([]);
      expect(await readCurrentDaemonPluginCatalog({
        happyHomeDir,
        reloadController,
      })).toEqual([
        expect.objectContaining({
          pluginId: FIXTURE_PLUGIN_ID,
          enabled: false,
          desiredGeneration: replacement.desiredGeneration,
          appliedGeneration: null,
        }),
      ]);

      const enabled = await changeService.requestPluginChange({
        kind: 'enable',
        pluginId: FIXTURE_PLUGIN_ID,
      });
      expect(enabled).toMatchObject({
        kind: 'committed',
        pluginId: FIXTURE_PLUGIN_ID,
        desiredGeneration: replacement.desiredGeneration,
        appliedGeneration: replacement.appliedGeneration,
      });
      await publishProjectionInvalidation();
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).not.toBeNull();
        expect(appShell?.findByTestId(providerSelectionTestId)).toBeTruthy();
      });
      expect(lifecycle.getConfiguredProviderId()).toBe(FIXTURE_PROVIDER_ID);
      await lifecycle.toggle(controlSessionId);
      await waitForReact(() => {
        expect(lifecycle.getSnapshot()).toMatchObject({
          adapterId: FIXTURE_PROVIDER_ID,
          status: 'connected',
        });
      });

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
      await publishProjectionInvalidation();
      await waitForReact(() => {
        expect(getExternalVoiceProviderRegistration(FIXTURE_PROVIDER_ID)).toBeNull();
        expect(appShell?.findByTestId(providerSelectionTestId)).toBeNull();
        expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected',
          canStop: false,
        });
      });
      expect(composedBoundary.settings?.voice.providerId).toBe(FIXTURE_PROVIDER_ID);
      expect(await readCurrentDaemonPluginCatalog({
        happyHomeDir,
        reloadController,
      })).toEqual([]);
      expect((await loadInstalledPlugins({ happyHomeDir })).loadedPlugins).toEqual([]);
      expect(providerRequests.filter((request) => request.method === 'POST')).toHaveLength(3);
      expect(composedBoundary.audioSessionAcquireRequests).toEqual([
        {
          ownerId: `realtime-provider:${FIXTURE_PROVIDER_ID}`,
          mode: 'conversation',
          input: true,
          output: true,
          aec: 'preferred',
          capture: 'provider_managed_exclusive',
        },
        {
          ownerId: `realtime-provider:${FIXTURE_PROVIDER_ID}`,
          mode: 'conversation',
          input: true,
          output: true,
          aec: 'preferred',
          capture: 'provider_managed_exclusive',
        },
        {
          ownerId: `realtime-provider:${FIXTURE_PROVIDER_ID}`,
          mode: 'conversation',
          input: true,
          output: true,
          aec: 'preferred',
          capture: 'provider_managed_exclusive',
        },
      ]);
      expect(composedBoundary.audioSessionReleaseCount).toBe(3);
      expect(readFixtureEvents().filter((event) => (
        typeof event === 'object'
        && event !== null
        && 'kind' in event
        && event.kind === 'runtime_disposed'
      ))).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
      standardCleanup();
      appShell = null;
      await flushHookEffects({ cycles: 2 }).catch(() => undefined);
      const { getInstalledPluginUiExecutableModuleHost } = await import(
        '../../../../apps/ui/sources/components/plugins/reactNative/executableModuleHost'
      );
      await getInstalledPluginUiExecutableModuleHost().unload().catch(() => undefined);
      await changeService.shutdown().catch(() => undefined);
      await reloadController.shutdown({ timeoutMs: 5_000 }).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
      invalidateDaemonContributionRegistryProjectionCache();
      composedBoundary.handlers.clear();
      composedBoundary.loaderBackend = null;
      composedBoundary.machines = [];
      composedBoundary.settings = null;
      composedBoundary.latestHarnessVoice = null;
      composedBoundary.latestAppShellProjection = null;
      appShellProjectionModule = null;
      voiceNormalSurfaceModules = null;
      Reflect.deleteProperty(globalThis, '__HAPPIER_PACKED_VOICE_FIXTURE_EVENTS__');
    }
  }, 180_000);
});
