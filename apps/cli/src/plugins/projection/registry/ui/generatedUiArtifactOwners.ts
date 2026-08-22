import {
  PluginActionExecutionV2Schema,
} from '@happier-dev/protocol';
import {
  deriveGeneratedHostedWebAssetPolicyV1,
  PluginUiArtifactsManifestEntryV1Schema,
  type PluginUiArtifactsManifestEntryV1,
  type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ResolvedContributionRegistry } from '../types';

export type ResolvedGeneratedReactNativeArtifactOwner = Readonly<{
  kind: 'renderer' | 'voiceProvider';
  pluginId: string;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
  requiredHostMethods: readonly string[];
  declaredPlatforms?: readonly ('web' | 'ios' | 'android')[];
  expectedRepackModule?: Readonly<{
    modulePath: string;
    exportName: string;
  }>;
}>;

/**
 * A generic client executable remains owned by the Action that selected it.
 * This is deliberately separate from renderer and Voice owner discovery:
 * sharing a generated bundle never grants one contribution another family's
 * activation or byte-read authority.
 */
export type ResolvedGeneratedReactNativeClientContributionArtifactOwner = Readonly<{
  kind: 'clientContribution';
  pluginId: string;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
  declaredPlatforms: readonly ('web' | 'ios' | 'android')[];
  expectedRepackModule: Readonly<{
    modulePath: string;
    exportName: string;
  }>;
}>;

type ResolvedGeneratedReactNativeExecutableArtifactOwner =
  | ResolvedGeneratedReactNativeArtifactOwner
  | ResolvedGeneratedReactNativeClientContributionArtifactOwner;

function readClientActionExecution(execution: unknown) {
  const parsed = PluginActionExecutionV2Schema.safeParse(execution);
  return parsed.success && parsed.data.target === 'client' ? parsed.data : null;
}

export function collectResolvedGeneratedReactNativeArtifactOwners(
  registry: ResolvedContributionRegistry,
): readonly ResolvedGeneratedReactNativeArtifactOwner[] {
  const owners: ResolvedGeneratedReactNativeArtifactOwner[] = [];
  for (const renderer of registry.uiRenderersV2 ?? []) {
    if (renderer.definition.kind !== 'reactNative') continue;
    owners.push(Object.freeze({
      kind: 'renderer',
      pluginId: renderer.pluginId,
      ...(renderer.pluginVersion ? { pluginVersion: renderer.pluginVersion } : {}),
      contributionId: renderer.definition.id,
      artifactId: renderer.definition.artifact,
      ...(renderer.pluginRootPath ? { pluginRootPath: renderer.pluginRootPath } : {}),
      manifestPath: renderer.manifestPath,
      ...(renderer.generatedUiArtifactsManifest
        ? { generatedUiArtifactsManifest: renderer.generatedUiArtifactsManifest }
        : {}),
      requiredHostMethods: Object.freeze([...(renderer.definition.requiredHostMethods ?? [])]),
    }));
  }
  for (const provider of registry.voiceProviders ?? []) {
    if (provider.definition.kind !== 'conversation') continue;
    owners.push(Object.freeze({
      kind: 'voiceProvider',
      pluginId: provider.pluginId,
      ...(provider.pluginVersion ? { pluginVersion: provider.pluginVersion } : {}),
      contributionId: provider.definition.id,
      artifactId: provider.definition.client.artifactId,
      ...(provider.pluginRootPath ? { pluginRootPath: provider.pluginRootPath } : {}),
      manifestPath: provider.manifestPath,
      ...(provider.generatedUiArtifactsManifest
        ? { generatedUiArtifactsManifest: provider.generatedUiArtifactsManifest }
        : {}),
      requiredHostMethods: Object.freeze([]),
      declaredPlatforms: Object.freeze([...provider.definition.platforms]),
      expectedRepackModule: Object.freeze({
        modulePath: provider.definition.client.modulePath,
        exportName: provider.definition.client.exportName,
      }),
    }));
  }
  return Object.freeze(owners);
}

export function findResolvedGeneratedReactNativeArtifactOwner(input: Readonly<{
  registry: ResolvedContributionRegistry;
  pluginId: string;
  contributionId: string;
}>): ResolvedGeneratedReactNativeArtifactOwner | null {
  const matching = collectResolvedGeneratedReactNativeArtifactOwners(input.registry).filter((owner) => (
    owner.pluginId === input.pluginId && owner.contributionId === input.contributionId
  ));
  return matching.length === 1 ? matching[0]! : null;
}

/**
 * Resolve exactly one current Action declaration to its generated client
 * Artifact. The action's qualified identity anchors the lookup; its declared
 * client target supplies every artifact/module/platform fact. No renderer or
 * Voice registration participates in this resolution.
 */
export function findResolvedGeneratedReactNativeClientContributionArtifactOwner(input: Readonly<{
  registry: ResolvedContributionRegistry;
  action: Readonly<{ pluginId: string; localId: string }>;
}>): ResolvedGeneratedReactNativeClientContributionArtifactOwner | null {
  const matching = (input.registry.actions ?? []).filter((action) => (
    action.pluginId === input.action.pluginId
    && action.identity?.pluginId === input.action.pluginId
    && action.identity.localId === input.action.localId
    && action.definition.id === input.action.localId
    && readClientActionExecution(action.definition.execution) !== null
  ));
  if (matching.length !== 1) return null;
  const action = matching[0]!;
  const execution = readClientActionExecution(action.definition.execution);
  if (!execution) return null;
  const manifestPath = action.manifestPath?.trim();
  if (!manifestPath) return null;
  return Object.freeze({
    kind: 'clientContribution',
    pluginId: input.action.pluginId,
    ...(action.pluginVersion ? { pluginVersion: action.pluginVersion } : {}),
    contributionId: input.action.localId,
    artifactId: execution.client.artifactId,
    ...(action.pluginRootPath ? { pluginRootPath: action.pluginRootPath } : {}),
    manifestPath,
    ...(action.generatedUiArtifactsManifest
      ? { generatedUiArtifactsManifest: action.generatedUiArtifactsManifest }
      : {}),
    declaredPlatforms: Object.freeze([...execution.platforms]),
    expectedRepackModule: Object.freeze({
      modulePath: execution.client.modulePath,
      exportName: execution.client.exportName,
    }),
  });
}

export function findGeneratedReactNativeArtifactEntry(input: Readonly<{
  owner: ResolvedGeneratedReactNativeExecutableArtifactOwner;
  platform: string | undefined;
}>): Readonly<{
  entry: PluginUiArtifactsManifestEntryV1 | null;
  failure: string | null;
}> {
  if (
    input.owner.kind !== 'renderer'
    && input.platform
    && !input.owner.declaredPlatforms?.includes(input.platform as 'web' | 'ios' | 'android')
  ) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_platform_undeclared' });
  }
  const candidates = input.owner.generatedUiArtifactsManifest?.entries.filter((entry) => (
    entry.contributionId === input.owner.artifactId && entry.tier === 'reactNative'
  )) ?? [];
  if (candidates.length === 0) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_missing' });
  }
  if (!input.platform) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_platform_unresolved' });
  }
  const matching = candidates.filter((entry) => entry.platform === input.platform);
  if (matching.length !== 1) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_platform_mismatch' });
  }
  const entry = matching[0]!;
  const expectedBundler = entry.platform === 'web' ? 'vite' : 'repack';
  if (entry.builtWith.bundler !== expectedBundler) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_bundler_mismatch' });
  }
  if (entry.platform !== 'web' && !entry.repack) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_repack_identity_missing' });
  }
  if (entry.platform === 'web' && entry.repack) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_repack_identity_unexpected' });
  }
  if (
    entry.repack
    && input.owner.expectedRepackModule
    && (
      entry.repack.modulePath !== input.owner.expectedRepackModule.modulePath
      || entry.repack.exportName !== input.owner.expectedRepackModule.exportName
    )
  ) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_repack_identity_mismatch' });
  }
  if (!PluginUiArtifactsManifestEntryV1Schema.safeParse(entry).success) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_graph_invalid' });
  }
  const uniqueFiles = new Set(entry.files.map((file) => file.relativePath));
  if (uniqueFiles.size !== entry.files.length || !uniqueFiles.has(entry.entry)) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_graph_invalid' });
  }
  if (!input.owner.pluginRootPath) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_plugin_root_unavailable' });
  }
  return Object.freeze({ entry, failure: null });
}

/**
 * Candidate Collection preparation may use a generated React Native Artifact
 * only when its signed graph names one exact migration export. A renderer's
 * ordinary render export never confers that host-private authority.
 */
export function findGeneratedReactNativeCollectionMigrationsModule(input: Readonly<{
  owner: ResolvedGeneratedReactNativeArtifactOwner;
  platform: string | undefined;
}>): Readonly<{
  entry: PluginUiArtifactsManifestEntryV1 | null;
  moduleReference: NonNullable<PluginUiArtifactsManifestEntryV1['collectionMigrations']> | null;
  failure: string | null;
}> {
  const resolved = findGeneratedReactNativeArtifactEntry(input);
  if (!resolved.entry) {
    return Object.freeze({ entry: null, moduleReference: null, failure: resolved.failure });
  }
  const moduleReference = resolved.entry.collectionMigrations;
  if (!moduleReference) {
    return Object.freeze({
      entry: null,
      moduleReference: null,
      failure: 'generated_react_native_collection_migrations_module_missing',
    });
  }
  if (
    resolved.entry.platform !== 'web'
    && (
      !('containerName' in moduleReference)
      || !('modulePath' in moduleReference)
      ||
      !resolved.entry.repack
      || moduleReference.containerName !== resolved.entry.repack.containerName
      || moduleReference.modulePath !== resolved.entry.repack.modulePath
    )
  ) {
    return Object.freeze({
      entry: null,
      moduleReference: null,
      failure: 'generated_react_native_collection_migrations_module_mismatch',
    });
  }
  if (
    resolved.entry.platform === 'web'
    && ('containerName' in moduleReference || 'modulePath' in moduleReference)
  ) {
    return Object.freeze({
      entry: null,
      moduleReference: null,
      failure: 'generated_react_native_collection_migrations_module_mismatch',
    });
  }
  return Object.freeze({ entry: resolved.entry, moduleReference, failure: null });
}

/**
 * The generated hosted-web renderer is the installed-artifact producer for
 * the exact daemon byte path. It owns no frame transport or Artifact cache;
 * this only resolves the verified generated graph it already produced.
 */
export type ResolvedGeneratedHostedWebArtifactOwner = Readonly<{
  pluginId: string;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  source: Readonly<{
    kind: 'artifact';
    artifact: string;
  }>;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
  requiredHostMethods: readonly string[];
}>;

export function collectResolvedGeneratedHostedWebArtifactOwners(
  registry: ResolvedContributionRegistry,
): readonly ResolvedGeneratedHostedWebArtifactOwner[] {
  const owners: ResolvedGeneratedHostedWebArtifactOwner[] = [];
  for (const renderer of registry.uiRenderersV2 ?? []) {
    if (renderer.definition.kind !== 'hostedWeb') continue;
    owners.push(Object.freeze({
      pluginId: renderer.pluginId,
      ...(renderer.pluginVersion ? { pluginVersion: renderer.pluginVersion } : {}),
      contributionId: renderer.definition.id,
      artifactId: renderer.definition.source.artifact,
      source: Object.freeze({ ...renderer.definition.source }),
      ...(renderer.pluginRootPath ? { pluginRootPath: renderer.pluginRootPath } : {}),
      manifestPath: renderer.manifestPath,
      ...(renderer.generatedUiArtifactsManifest
        ? { generatedUiArtifactsManifest: renderer.generatedUiArtifactsManifest }
        : {}),
      requiredHostMethods: Object.freeze([...(renderer.definition.requiredHostMethods ?? [])]),
    }));
  }
  return Object.freeze(owners);
}

export function findResolvedGeneratedHostedWebArtifactOwner(input: Readonly<{
  registry: ResolvedContributionRegistry;
  pluginId: string;
  contributionId: string;
}>): ResolvedGeneratedHostedWebArtifactOwner | null {
  const matching = collectResolvedGeneratedHostedWebArtifactOwners(input.registry).filter((owner) => (
    owner.pluginId === input.pluginId && owner.contributionId === input.contributionId
  ));
  return matching.length === 1 ? matching[0]! : null;
}

export function findGeneratedHostedWebArtifactEntry(input: Readonly<{
  owner: ResolvedGeneratedHostedWebArtifactOwner;
}>): Readonly<{
  entry: PluginUiArtifactsManifestEntryV1 | null;
  failure: string | null;
}> {
  const candidates = input.owner.generatedUiArtifactsManifest?.entries.filter((entry) => (
    entry.contributionId === input.owner.artifactId
    && entry.tier === 'hostedWeb'
    && entry.platform === 'web'
  )) ?? [];
  if (candidates.length === 0) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_missing' });
  }
  if (candidates.length !== 1) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_ambiguous' });
  }
  const entry = candidates[0]!;
  if (entry.builtWith.bundler !== 'vite' || entry.repack) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_bundler_mismatch' });
  }
  if (!PluginUiArtifactsManifestEntryV1Schema.safeParse(entry).success) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_graph_invalid' });
  }
  const uniqueFiles = new Set(entry.files.map((file) => file.relativePath));
  if (uniqueFiles.size !== entry.files.length || !uniqueFiles.has(entry.entry)) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_graph_invalid' });
  }
  if (!deriveGeneratedHostedWebAssetPolicyV1(entry)) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_root_invalid' });
  }
  if (!input.owner.pluginRootPath) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_plugin_root_unavailable' });
  }
  return Object.freeze({ entry, failure: null });
}
