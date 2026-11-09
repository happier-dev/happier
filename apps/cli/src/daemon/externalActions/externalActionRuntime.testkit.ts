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
    executionTarget?: 'account';
    hostAccess?: readonly PluginHostAccessRequestV2[];
  }> = {},
): ResolvedExecutablePluginRuntimeRegistry {
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
      ? { executionRealm: 'account' as const, revalidateAccountExecution: async () => true } : {}),
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

