import { expect } from 'vitest';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity, type PluginMachineExecutionOriginV1, type TargetActionApprovalReplayPlacementV1, type PluginActionContributionV2, type PluginHostAccessRequestV2, type PluginSourceCustodyV1 } from '@happier-dev/protocol';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId, type PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createTargetActionHostBindingResolver, createTargetActionHostPolicyResolver } from '@/plugins/runtime/hostAccess/resolve';
import { buildTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/buildTargetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import type { PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { unexpectedProjectNativeAdapterResolution } from '@/plugins/testkit/unexpectedProjectNativeAdapterResolution';
import { unexpectedCaptureSourceResolution } from '@/plugins/testkit/unexpectedCaptureSourceResolution';

export function createExternalActionRuntime(
  scope: 'global' | 'session' = 'session',
  pluginId = 'acme.external',
  onActionInvocation?: (context: PluginInvocationContext) => void | Promise<void>,
  resolveCurrentPluginExecutionOrigin?: (
    pluginId: string,
  ) => PluginMachineExecutionOriginV1 | null,
  resolveCurrentPluginApprovalReplayPlacement?: (
    pluginId: string,
  ) => TargetActionApprovalReplayPlacementV1 | null,
  onServicesSeed?: (seed: PluginActionsServiceSeed) => void,
  serviceOwners?: Pick<ReturnType<typeof createProductionPluginInvocationServiceOwners>, 'createServices' | 'resolveHostBinding'>,
  dangerLevel: 'safe' | 'writesRemote' = 'safe',
  activationOnly?: () => void,
  actionOptions: Readonly<{
    localId?: string; surfaces?: readonly ('cli' | 'mcp' | 'agent' | 'plugin' | 'ui')[]; overlappingTool?: true; unavailable?: true;
    pluginVersion?: string; inputSchema?: object; resultSchema?: object; occurrenceId?: PluginRuntimeOccurrenceId;
    sourceCustody?: PluginSourceCustodyV1;
    inputHints?: { fields: readonly { path: string; title: string; widget: 'secret' }[] };
    onInput?: (input: JsonValue) => void;
    confirmationWhen?: PluginActionContributionV2['confirmationWhen'];
    confirmation?: PluginActionContributionV2['confirmation'];
    sessionTarget?: PluginActionContributionV2['sessionTarget'];
    placementBindings?: PluginActionContributionV2['placementBindings'];
    executionTarget?: 'account';
    operation?: PluginActionContributionV2['operation'];
    hostAccess?: readonly PluginHostAccessRequestV2[];
  }> = {},
): ResolvedExecutablePluginRuntimeRegistry & Readonly<{ manifest: LoadedPlugin['manifest'] }> {
  const localId = actionOptions.localId ?? 'inspect';
  const plugin = {
    pluginId,
    pluginRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
    daemonEntryPath: `/plugins/${pluginId}/daemon.mjs`,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: pluginId,
      version: actionOptions.pluginVersion ?? '1.0.0',
      displayName: 'External Action Fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      ...(actionOptions.hostAccess ? { hostAccess: { required: actionOptions.hostAccess } } : {}),
      contributes: {
        actions: (actionOptions.overlappingTool ? ['inspect', 'actions/inspect'] : [localId]).map((id) => ({
          id,
          title: 'Inspect',
          scopes: [scope],
          // `api` deliberately is not an author-visible Action surface.
          surfaces: actionOptions.surfaces ?? ['cli'],
          execution: actionOptions.executionTarget === 'account'
            ? { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } }
            : { target: 'daemon' },
          dangerLevel,
          ...(actionOptions.operation ? { operation: actionOptions.operation } : {}),
          ...(actionOptions.sessionTarget ? { sessionTarget: actionOptions.sessionTarget } : {}),
          ...(actionOptions.placementBindings === undefined ? {} : { placementBindings: actionOptions.placementBindings }),
          ...(actionOptions.overlappingTool && id === 'actions/inspect'
            ? { tool: { name: 'acme_inspect', title: 'Inspect nested Action' }, toolExposure: { cli: 'direct' } } : {}),
          ...(actionOptions.hostAccess ? { hostAccess: actionOptions.hostAccess.map(request => request.id) } : {}),
          ...(actionOptions.inputSchema === undefined ? {} : { inputSchema: actionOptions.inputSchema }),
          ...(actionOptions.resultSchema === undefined ? {} : { resultSchema: actionOptions.resultSchema }),
          ...(actionOptions.inputHints === undefined ? {} : { inputHints: actionOptions.inputHints }),
          ...(actionOptions.confirmationWhen === undefined ? {} : { confirmationWhen: actionOptions.confirmationWhen }),
          ...(actionOptions.unavailable ? { availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: false } } } : {}),
          ...(dangerLevel === 'safe' ? {} : { confirmation: actionOptions.confirmation ?? { title: 'Write', body: 'Write provider state?', confirmLabel: 'Write' } }),
        })),
      },
    }),
  } satisfies LoadedPlugin;
  const normalized = buildPluginContributionRegistry({
    loadedPlugins: [plugin],
  });
  const normalizedAction = normalized.actions[0];
  if (!normalizedAction) throw new Error('Expected normalized external Action contribution');
  const resolvedActions = normalized.actions.map((entry): ResolvedActionContribution => ({
    provenance: 'external', source: { kind: entry.sourceSpec.kind },
    ...entry,
  }));
  const contributes = createResolvedContributionRegistry({
    actions: resolvedActions,
    activationTargets: [{
      provenance: 'external',
      source: { kind: normalizedAction.sourceSpec.kind },
      pluginId,
      manifestPath: normalizedAction.manifestPath,
      daemonEntryPath: normalizedAction.daemonEntryPath,
      devDaemonEntryPath: normalizedAction.devDaemonEntryPath,
      sourceSpec: normalizedAction.sourceSpec,
      manifest: plugin.manifest,
    }],
  });
  const actionRegistryKey = buildQualifiedPluginContributionKey(
    createPluginContributionIdentity({ pluginId, localId }),
  );
  expect(actionRegistryKey).toBe(`${pluginId}/${localId}`);
  const actionsById = contributes.actionsById;
  if (!actionsById) throw new Error('Expected indexed external Action contributions');
  const registeredAction = actionsById.get(actionRegistryKey);
  if (!registeredAction) throw new Error('Expected parsed external Action contribution');
  const sourceCustody = actionOptions.sourceCustody ?? (pluginId === 'happier.channels'
    ? {
      kind: 'bundled_first_party',
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture-cli-root' },
    } as const
    : pluginId === 'acme.managed'
      ? { kind: 'managed', immutableGenerationId: 'fixture-immutable-generation', installSource: 'localPath' } as const
    : { kind: 'development', registeredRootId: `fixture-root:${pluginId}` } as const);
  const fixtureOccurrenceId = actionOptions.occurrenceId ?? createPluginRuntimeOccurrenceId(pluginId);
  const targetActionInvocations = buildTargetActionInvocationRegistry({
    ...(actionOptions.executionTarget === 'account' ? { executionRealm: 'account' as const } : {}),
    contributes,
    targetRegistrations: activationOnly ? [] : resolvedActions.map((entry) => ({
      pluginId,
      occurrenceId: fixtureOccurrenceId,
      registration: {
        family: 'actions' as const,
        localId: entry.definition.id,
        value: async (_input: JsonValue, context: PluginInvocationContext) => {
          actionOptions.onInput?.(_input);
          await onActionInvocation?.(context);
          return {
            surface: context.surface,
            caller: context.caller?.kind ?? null,
            sessionId: context.session?.id ?? null,
            ...(actionOptions.overlappingTool ? { localId: entry.definition.id } : {}),
          };
        },
      },
    })),
    readCurrentPluginOccurrenceId: (currentPluginId) => (
      currentPluginId === pluginId ? fixtureOccurrenceId : null
    ),
    readCurrentPluginSourceCustody: (currentPluginId) => (
      currentPluginId === pluginId ? sourceCustody : null
    ),
    readTargetActivationFacts: () => activationOnly ? [] : [{
      pluginId,
      pluginVersion: plugin.manifest.version,
      source: 'localPath',
      occurrenceId: fixtureOccurrenceId,
      host: 'daemon',
      platform: 'darwin',
      occurredAtMs: 1,
      status: 'active',
      required: resolvedActions.map((entry) => ({ family: 'actions' as const, localId: entry.definition.id })),
      bound: resolvedActions.map((entry) => ({ family: 'actions' as const, localId: entry.definition.id })),
      diagnostics: [],
    }],
    resolveAuthorizationFacts: (resolvedAction) => ({
      generation: {
        targetGeneration: resolvedAction.occurrenceId,
        desiredGeneration: resolvedAction.occurrenceId,
        appliedGeneration: resolvedAction.occurrenceId,
      },
      resourceSelections: [],
      scopedGrants: [],
      operatingSystemAuthorization: [],
    }),
    resolveHostBinding: serviceOwners?.resolveHostBinding ?? createTargetActionHostBindingResolver(),
    resolveHostPolicy: createTargetActionHostPolicyResolver(),
    createServices: (seed, binding) => {
      onServicesSeed?.(seed);
      return (serviceOwners?.createServices ?? createUnavailablePluginServicesFactory())(seed, binding);
    },
  });

  const runtime = {
    ...(actionOptions.executionTarget === 'account'
      ? { executionRealm: 'account' as const } : {}),
    claimReleaseLessDeclarations: async () => undefined,
    contributes,
    generation: 1,
    targetActionInvocations,
    readPluginOccurrenceId: (currentPluginId: string) => currentPluginId === pluginId ? fixtureOccurrenceId : null,
    isPluginOccurrenceCurrent: (currentPluginId: string, occurrenceId: PluginRuntimeOccurrenceId) => (
      currentPluginId === pluginId && occurrenceId === fixtureOccurrenceId
    ),
    resolveCurrentPluginExecutionOrigin: async (currentPluginId) => (
      resolveCurrentPluginExecutionOrigin
        ? resolveCurrentPluginExecutionOrigin(currentPluginId)
        : {
        serverIdentityId: 'server-external',
        materializationRef: {
          pluginId: currentPluginId,
          machineId: 'machine-local',
          materializationId: 'fixture-materialization',
        },
      }
    ),
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: {},
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => { activationOnly?.(); return []; },
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    resolveCaptureSource: unexpectedCaptureSourceResolution,
    resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
    resolvePromptAssetBlocks: async () => [],
    retireConsumers: () => {},
    retainPluginActivationComponent: () => null,
    retainPreparedActivationRegistryComponents: () => [],
    dispose: async () => {},
  } satisfies ResolvedExecutablePluginRuntimeRegistry;
  return Object.assign(runtime, {
    manifest: plugin.manifest,
    resolveCurrentPluginApprovalReplayPlacement: async (currentPluginId: string) => (
      resolveCurrentPluginApprovalReplayPlacement
        ? resolveCurrentPluginApprovalReplayPlacement(currentPluginId)
        : {
          serverId: 'server-external',
          machineId: 'machine-local',
        }
    ),
  });
}


/** Account custody over Home HTTP, published and leased by the real runtime owner. */
export async function publishAccountExternalActionRuntime(runtime: ReturnType<typeof createExternalActionRuntime>,
  archiveDigestSha256 = `sha256:${'a'.repeat(64)}`) {
  const [{ mkdtemp, rm }, { tmpdir }, { join }, { default: fastify },
    { createPluginReloadController }, { acquireAuthoritativePluginRuntimeRegistryLease },
    { resolveAccountPluginActivationSources }, { resolvePluginStorePaths },
    { installAxiosFastifyAdapter }, { createBundledActivationSourceResolver }, { activatePluginRuntimeRegistry }, availability] = await Promise.all([
      import('node:fs/promises'), import('node:os'), import('node:path'), import('fastify'),
      import('@/plugins/runtime/reload/controller'), import('@/plugins/runtime/reload/runtimeLease'),
      import('@/plugins/runtime/accountPluginActivationSource'), import('@/plugins/store/paths'),
      import('@/testkit/http/axiosAdapter'), import('@/plugins/runtime/bundledActivationSource'),
      import('@/plugins/runtime/lifecycle/manager'),
      import('@happier-dev/protocol/plugins/availability'),
    ]);
  const home = await mkdtemp(join(tmpdir(), 'account-relay-runtime-'));
  const controller = createPluginReloadController({ happyHomeDir: home });
  const app = fastify();
  const serverUrl = 'http://account-relay-custody.test';
  const release = (candidate: typeof runtime, digest: string) => availability.normalizePluginReleaseFactsV1({
    ref: { pluginId: candidate.manifest.id, version: candidate.manifest.version }, archiveDigestSha256: digest,
    normalizedManifest: candidate.manifest, collectionContracts: [], uiSlots: [],
    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
  });
  let selectedRelease = release(runtime, archiveDigestSha256);
  const response = () => availability.PluginAvailabilityIntentReadActionOutputV1Schema.parse({
    availabilityCursor: 1, hostingCapability: { enabled: false },
    intent: { pluginId: selectedRelease.ref.pluginId, desiredVersion: selectedRelease.ref.version,
      enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
    release: selectedRelease, uiArtifacts: [], packageAssets: [],
  });
  app.post(availability.PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () =>
    availability.PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
      pluginIds: [selectedRelease.ref.pluginId], failedPluginIds: [],
      intentReads: [{ pluginId: selectedRelease.ref.pluginId, response: response() }] }));
  app.post(availability.PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
    const { pluginId } = availability.PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
    if (pluginId !== selectedRelease.ref.pluginId) throw new Error('Unexpected Account fixture plugin');
    return response();
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
  const bindConsumerLifecycle = async (candidate: typeof runtime) => {
    // This target-invocation fixture has no background declarations or database
    // consumers. The real activation owner still owns their empty lifecycle.
    const activated = await activatePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}), generation: 1 });
    const dispose = candidate.dispose.bind(candidate);
    Object.assign(candidate, { retirePluginConsumers: async (pluginIds: readonly string[]) => {
      activated.retireBackgroundServices(pluginIds);
    }, dispose: async () => { await activated.dispose(); await dispose(); } });
  };
  const bind = async (candidate: typeof runtime) => {
    const sources = await resolveAccountPluginActivationSources({ contributes: createResolvedContributionRegistry({}),
      paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'fixture', encryption: null }, serverUrl,
      isCurrent: () => controller.isRuntimeRegistryCurrent(candidate),
      resolveBundledActivationSource: createBundledActivationSourceResolver({ bundledPackageNames: [] }),
    });
    Object.assign(candidate, { revalidateAccountExecution: sources.revalidate });
    return sources.readSelection(candidate.manifest.id);
  };
  try {
    await bindConsumerLifecycle(runtime);
    const lease = await controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => runtime });
    await lease.release();
    const selection = await bind(runtime);
    if (selection?.kind !== 'available') throw new Error('Account fixture custody was not admitted');
    return { controller, selection, acquire: () => acquireAuthoritativePluginRuntimeRegistryLease({ controller }),
      async adopt(candidate: typeof runtime, digest = archiveDigestSha256) {
        selectedRelease = release(candidate, digest);
        await bindConsumerLifecycle(candidate);
        const result = await controller.adoptPreparedRuntimeRegistry({ registry: candidate,
          changedPluginIds: [candidate.manifest.id], runningSessionDisposition: 'retainRunningSessions' });
        if (!result.ok) throw new Error('Account fixture runtime publication failed');
        await bind(candidate);
      },
      async dispose() { try { await controller.shutdown(); } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); } },
    };
  } catch (error) {
    try { await controller.shutdown(); } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    throw error;
  }
}
