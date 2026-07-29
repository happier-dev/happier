import {
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
} from '@happier-dev/protocol';
import {
  PluginUiArtifactsManifestEntryV1Schema,
  type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
  fetchReactNativeInstalledArtifactBytesViaMachineRpc,
  getInstalledPluginReactNativeBundleCache,
  preloadReactNativeInstalledArtifactBytes,
  type PluginReactNativeBundleCache,
  type PluginReactNativeBundleArtifactByteFetcher,
} from '@/components/plugins/reactNative/bundleCache';
import {
  getInstalledPluginUiExecutableModuleHost,
  type PluginUiExecutableAuthority,
  type PluginUiExecutableModuleActivationResult,
  type PluginUiExecutableModuleHost,
} from '@/components/plugins/reactNative/executableModuleHost';
import {
  derivePluginUiFederatedContainerName,
  type PluginReactNativeLoaderBackend,
  type RepackInstalledArtifactModuleReference,
} from '@/components/plugins/reactNative/loader';
import { resolveDefaultReactNativeLoaderBackend } from '@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createAppShellPluginUiInvocationHost } from '@/components/appShell/plugins/pluginUiInvocationHost';

import {
  createExternalVoiceProviderActivationScope,
  type PluginVoiceConversationProviderContributionV1,
} from './externalVoiceProviderActivation';

type ActivationAttempt = Readonly<{
  providerId: string;
  result: PluginUiExecutableModuleActivationResult;
}>;

type ValidProjectedVoiceProvider = Readonly<{
  entry: PluginUiProjectionModel['voiceProvidersById'][string];
  declaration: PluginVoiceConversationProviderContributionV1;
  identity: ReturnType<typeof DaemonPluginReactNativeBundleCacheIdentityV1Schema.parse>;
  artifactGraph: PluginUiArtifactsManifestEntryV1;
  moduleReference: RepackInstalledArtifactModuleReference;
}>;

type ExternalVoiceProviderHostPlatform = 'web' | 'ios' | 'android';

function isExternalVoiceProviderHostPlatform(value: string): value is ExternalVoiceProviderHostPlatform {
  return value === 'web' || value === 'ios' || value === 'android';
}

/**
 * Production F35 consumer. The generic projection/artifact owners establish
 * identity, integrity, currentness, and bytes; this adapter only maps the
 * declared Voice registration right into the canonical Voice activation scope.
 */
export async function activateProjectedExternalVoiceProviders(input: Readonly<{
  projection: PluginUiProjectionModel;
  machineId: string;
  serverId?: string | null;
  hostPlatform: string;
  executableHost?: PluginUiExecutableModuleHost;
  cache?: PluginReactNativeBundleCache;
  loaderBackend?: PluginReactNativeLoaderBackend;
  fetchArtifactBytes?: PluginReactNativeBundleArtifactByteFetcher;
  createInvocationUi?: typeof createAppShellPluginUiInvocationHost;
}>): Promise<readonly ActivationAttempt[]> {
  const executableHost = input.executableHost ?? getInstalledPluginUiExecutableModuleHost();
  const cache = input.cache ?? getInstalledPluginReactNativeBundleCache();
  const authority: PluginUiExecutableAuthority = Object.freeze({
    serverId: input.serverId ?? null,
    machineId: input.machineId,
    projectionGeneration: input.projection.generation,
  });
  await executableHost.replaceAuthority(authority);
  if (!isExternalVoiceProviderHostPlatform(input.hostPlatform) || input.projection.generation === null) {
    return Object.freeze([]);
  }

  const loaderBackend = input.loaderBackend ?? resolveDefaultReactNativeLoaderBackend();
  const attempts: ActivationAttempt[] = [];
  const groups = new Map<string, ValidProjectedVoiceProvider[]>();
  for (const entry of Object.values(input.projection.voiceProvidersById)) {
    const declaration = entry.definition;
    if (declaration.kind !== 'conversation') continue;
    if (!declaration.platforms.includes(input.hostPlatform)) continue;
    const contributionId = declaration.id;
    const bundle = input.projection.reactNativeBundlesById[`reactNativeBundle:${entry.pluginId}:${contributionId}`];
    const runtime = bundle?.runtime;
    const runtimeRecord = runtime && typeof runtime === 'object' && !Array.isArray(runtime)
      ? runtime as Readonly<Record<string, unknown>>
      : null;
    const decision = runtimeRecord?.decision;
    const decisionRecord = decision && typeof decision === 'object' && !Array.isArray(decision)
      ? decision as Readonly<Record<string, unknown>>
      : null;
    const loadPolicy = runtimeRecord?.loadPolicy;
    const loadPolicyRecord = loadPolicy && typeof loadPolicy === 'object' && !Array.isArray(loadPolicy)
      ? loadPolicy as Readonly<Record<string, unknown>>
      : null;
    const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.safeParse(bundle?.artifactGraph);
    const identity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(runtimeRecord?.cacheIdentity);
    if (
      bundle?.pluginId !== entry.pluginId
      || bundle?.contributionId !== contributionId
      || !artifactGraph.success
      || artifactGraph.data.contributionId !== declaration.client.artifactId
      || artifactGraph.data.platform !== input.hostPlatform
      || decisionRecord?.state !== 'load'
      || loadPolicyRecord?.source !== 'installedArtifact'
      || !identity.success
      || identity.data.pluginId !== entry.pluginId
      || identity.data.contributionId !== contributionId
      || identity.data.projectionGeneration !== input.projection.generation
      || identity.data.platform !== input.hostPlatform
      || identity.data.artifactDigest !== artifactGraph.data.digest
    ) continue;

    const moduleReference = artifactGraph.data.repack ?? Object.freeze({
      containerName: derivePluginUiFederatedContainerName({
        pluginId: entry.pluginId,
        contributionId: declaration.client.artifactId,
      }),
      modulePath: declaration.client.modulePath,
      exportName: declaration.client.exportName,
    });
    const groupKey = [
      entry.pluginId,
      declaration.client.artifactId,
      moduleReference.containerName,
      moduleReference.modulePath,
      moduleReference.exportName,
    ].join('\u0000');
    const group = groups.get(groupKey) ?? [];
    group.push(Object.freeze({
      entry,
      declaration,
      identity: identity.data,
      artifactGraph: artifactGraph.data,
      moduleReference,
    }));
    groups.set(groupKey, group);
  }

  for (const unorderedGroup of groups.values()) {
    const group = [...unorderedGroup].sort((left, right) => left.entry.id.localeCompare(right.entry.id));
    const first = group[0];
    if (!first) continue;
    if (group.some((candidate) => candidate.artifactGraph.digest !== first.artifactGraph.digest)) continue;

    const preload = await preloadReactNativeInstalledArtifactBytes({
      cache,
      identity: first.identity,
      artifactGraph: first.artifactGraph,
      fetchArtifactBytes: input.fetchArtifactBytes ?? (() => fetchReactNativeInstalledArtifactBytesViaMachineRpc({
          machineId: input.machineId,
          serverId: input.serverId ?? null,
          identity: first.identity,
        })),
    });
    if (!preload.ok) continue;

    const result = await executableHost.activate({
      cache,
      identity: first.identity,
      moduleReference: first.moduleReference,
      backend: loaderBackend,
      hostPlatform: input.hostPlatform,
      authority,
      createScope: () => createExternalVoiceProviderActivationScope({
        pluginId: first.entry.pluginId,
        generation: String(first.identity.projectionGeneration),
        declarations: group.map((candidate) => candidate.declaration),
        recipientContractsByLocalId: Object.freeze(Object.fromEntries(group.flatMap((candidate) => (
          candidate.entry.recipientContract
            ? [[candidate.declaration.id, candidate.entry.recipientContract] as const]
            : []
        )))),
        hostPlatform: input.hostPlatform,
        createInvocationUi: (operation) => (input.createInvocationUi ?? createAppShellPluginUiInvocationHost)({
          ...operation,
          machineId: input.machineId,
          serverId: input.serverId ?? null,
        }),
      }),
    });
    for (const candidate of group) {
      attempts.push(Object.freeze({ providerId: candidate.entry.id, result }));
    }
  }
  return Object.freeze(attempts);
}
