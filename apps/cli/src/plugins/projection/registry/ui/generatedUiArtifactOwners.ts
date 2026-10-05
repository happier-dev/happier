import {
  PluginActionExecutionV2Schema,
} from '@happier-dev/protocol';
import {
  PluginUiArtifactsManifestEntryV2Schema,
  type PluginUiArtifactsManifestEntryV2,
  type PluginUiArtifactsManifestV2,
} from '@happier-dev/protocol/plugins/ui';

import type { ResolvedContributionRegistry, ResolvedContributionSource } from '../types';

export type ResolvedGeneratedReactNativeArtifactOwner = Readonly<{
  kind: 'renderer' | 'voiceProvider';
  pluginId: string;
  pluginSource: ResolvedContributionSource;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV2;
  requiredHostMethods: readonly string[];
  declaredPlatforms?: readonly ('web' | 'ios' | 'android')[];
  expectedExecutable?: Readonly<{
    exportName: string;
  }>;
}>;

/**
 * A client executable remains owned by the contribution that selected it.
 * This is deliberately separate from renderer and Voice owner discovery:
 * sharing a generated bundle never grants one contribution another family's
 * activation or byte-read authority.
 */
export type ResolvedGeneratedReactNativeClientContributionArtifactOwner = Readonly<{
  kind: 'clientContribution';
  pluginId: string;
  pluginSource: ResolvedContributionSource;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV2;
  declaredPlatforms: readonly ('web' | 'ios' | 'android')[];
  expectedExecutable: Readonly<{
    exportName: string;
  }>;
}>;

/**
 * One host-private executable owner derived only from the Account Collection
 * declaration that names the migration Artifact. Renderers, Actions, and Voice
 * contributions cannot manufacture this authority by exporting the same name.
 */
export type ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner = Readonly<{
  kind: 'collectionMigrations';
  pluginId: string;
  pluginSource: ResolvedContributionSource;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV2;
  requiredHostMethods: readonly string[];
  declaredPlatforms: readonly ('web' | 'ios' | 'android')[];
  expectedExecutable: Readonly<{
    exportName: 'collectionMigrations';
  }>;
}>;

type ResolvedGeneratedReactNativeExecutableArtifactOwner =
  | ResolvedGeneratedReactNativeArtifactOwner
  | ResolvedGeneratedReactNativeClientContributionArtifactOwner
  | ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner;

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
      pluginSource: Object.freeze({ ...renderer.source }),
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
      pluginSource: Object.freeze({ ...provider.source }),
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
      expectedExecutable: Object.freeze({
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
    pluginSource: Object.freeze({ ...action.source }),
    ...(action.pluginVersion ? { pluginVersion: action.pluginVersion } : {}),
    contributionId: input.action.localId,
    artifactId: execution.client.artifactId,
    ...(action.pluginRootPath ? { pluginRootPath: action.pluginRootPath } : {}),
    manifestPath,
    ...(action.generatedUiArtifactsManifest
      ? { generatedUiArtifactsManifest: action.generatedUiArtifactsManifest }
      : {}),
    declaredPlatforms: Object.freeze([...execution.platforms]),
    expectedExecutable: Object.freeze({
      exportName: execution.client.exportName,
    }),
  });
}

export function collectResolvedGeneratedReactNativeClientContributionArtifactOwners(
  registry: ResolvedContributionRegistry,
): readonly ResolvedGeneratedReactNativeClientContributionArtifactOwner[] {
  const owners = (registry.actions ?? []).flatMap((action) => {
    const identity = action.identity;
    if (!identity || identity.pluginId !== action.pluginId) return [];
    const owner = findResolvedGeneratedReactNativeClientContributionArtifactOwner({
      registry,
      action: identity,
    });
    return owner ? [owner] : [];
  });
  for (const [family, contributions] of [
    ['dragSources', registry.dragSources ?? []],
    ['dropTargets', registry.dropTargets ?? []],
  ] as const) {
    for (const contribution of contributions) {
      if (contribution.identity.pluginId !== contribution.pluginId
        || contribution.identity.localId !== contribution.definition.id) continue;
      const manifestPath = contribution.manifestPath.trim();
      if (!manifestPath) continue;
      owners.push(Object.freeze({
        kind: 'clientContribution',
        pluginId: contribution.pluginId,
        pluginSource: Object.freeze({ ...contribution.source }),
        ...(contribution.pluginVersion ? { pluginVersion: contribution.pluginVersion } : {}),
        // Family namespaces preserve two client leaves with the same local id.
        contributionId: `${family}/${contribution.identity.localId}`,
        artifactId: contribution.definition.client.artifactId,
        pluginRootPath: contribution.pluginRootPath,
        manifestPath,
        ...(contribution.generatedUiArtifactsManifest
          ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
          : {}),
        declaredPlatforms: Object.freeze([...contribution.definition.platforms]),
        expectedExecutable: Object.freeze({ exportName: contribution.definition.client.exportName }),
      }));
    }
  }
  return Object.freeze(owners);
}

export function collectResolvedGeneratedReactNativeCollectionMigrationArtifactOwners(
  registry: ResolvedContributionRegistry,
): readonly ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner[] {
  const owners: ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner[] = [];
  const candidatesByPlugin = new Map<string, NonNullable<ResolvedContributionRegistry['accountCollections']>>();
  for (const contribution of registry.accountCollections ?? []) {
    if (contribution.definition.migrations.length === 0 || !contribution.migrationArtifact) continue;
    const candidates = candidatesByPlugin.get(contribution.pluginId) ?? [];
    candidatesByPlugin.set(contribution.pluginId, [...candidates, contribution]);
  }
  for (const candidates of candidatesByPlugin.values()) {
    // Candidate preparation carries one exact Artifact digest for the complete
    // target contract set. Conflicting per-Collection Artifact owners are not
    // silently merged into a second executable registry.
    if (candidates.length !== 1) continue;
    const contribution = candidates[0]!;
    const migrationArtifact = contribution.migrationArtifact!;
    owners.push(Object.freeze({
      kind: 'collectionMigrations' as const,
      pluginId: contribution.pluginId,
      pluginSource: Object.freeze({ ...contribution.source }),
      ...(contribution.pluginVersion ? { pluginVersion: contribution.pluginVersion } : {}),
      contributionId: contribution.identity.localId,
      artifactId: migrationArtifact.artifactId,
      ...(contribution.pluginRootPath ? { pluginRootPath: contribution.pluginRootPath } : {}),
      manifestPath: contribution.manifestPath,
      ...(contribution.generatedUiArtifactsManifest
        ? { generatedUiArtifactsManifest: contribution.generatedUiArtifactsManifest }
        : {}),
      requiredHostMethods: Object.freeze([]),
      declaredPlatforms: Object.freeze(['web', 'ios', 'android'] as const),
      expectedExecutable: Object.freeze({ exportName: migrationArtifact.exportName }),
    }));
  }
  return Object.freeze(owners);
}

export function findGeneratedReactNativeArtifactEntry(input: Readonly<{
  owner: ResolvedGeneratedReactNativeExecutableArtifactOwner;
  platform: string | undefined;
}>): Readonly<{
  entry: PluginUiArtifactsManifestEntryV2 | null;
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
    entry.artifactId === input.owner.artifactId && entry.tier === 'reactNative'
  )) ?? [];
  if (candidates.length === 0) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_missing' });
  }
  if (candidates.length !== 1) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_ambiguous' });
  }
  const entry = candidates[0]!;
  if (entry.tier !== 'reactNative') {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_graph_invalid' });
  }
  if (entry.builtWith.bundler !== 'esbuild') {
    return Object.freeze({ entry: null, failure: 'generated_react_native_bundler_mismatch' });
  }
  if (
    input.owner.expectedExecutable
    && !entry.executable.exports.includes(input.owner.expectedExecutable.exportName)
  ) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_export_missing' });
  }
  if (!PluginUiArtifactsManifestEntryV2Schema.safeParse(entry).success) {
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
  owner: ResolvedGeneratedReactNativeCollectionMigrationArtifactOwner;
  platform: string | undefined;
}>): Readonly<{
  entry: PluginUiArtifactsManifestEntryV2 | null;
  moduleReference: Readonly<{ exportName: string }> | null;
  failure: string | null;
}> {
  const resolved = findGeneratedReactNativeArtifactEntry(input);
  if (!resolved.entry) {
    return Object.freeze({ entry: null, moduleReference: null, failure: resolved.failure });
  }
  return Object.freeze({
    entry: resolved.entry,
    moduleReference: input.owner.expectedExecutable,
    failure: null,
  });
}

/**
 * The generated hosted-web renderer is the installed-artifact producer for
 * the exact daemon byte path. It owns no frame transport or Artifact cache;
 * this only resolves the verified generated graph it already produced.
 */
export type ResolvedGeneratedHostedWebArtifactOwner = Readonly<{
  pluginId: string;
  pluginSource: ResolvedContributionSource;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  source: Readonly<{
    kind: 'artifact';
    artifact: string;
  }>;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV2;
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
      pluginSource: Object.freeze({ ...renderer.source }),
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
  entry: PluginUiArtifactsManifestEntryV2 | null;
  failure: string | null;
}> {
  const candidates = input.owner.generatedUiArtifactsManifest?.entries.filter((entry) => (
    entry.artifactId === input.owner.artifactId
    && entry.tier === 'hostedWeb'
  )) ?? [];
  if (candidates.length === 0) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_missing' });
  }
  if (candidates.length !== 1) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_ambiguous' });
  }
  const entry = candidates[0]!;
  if (entry.tier !== 'hostedWeb') {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_graph_invalid' });
  }
  if (entry.builtWith.staging !== 'staticDirectory') {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_bundler_mismatch' });
  }
  if (!PluginUiArtifactsManifestEntryV2Schema.safeParse(entry).success) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_graph_invalid' });
  }
  const uniqueFiles = new Set(entry.files.map((file) => file.relativePath));
  if (uniqueFiles.size !== entry.files.length || !uniqueFiles.has(entry.entry)) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_artifact_graph_invalid' });
  }
  if (!input.owner.pluginRootPath) {
    return Object.freeze({ entry: null, failure: 'generated_hosted_web_plugin_root_unavailable' });
  }
  return Object.freeze({ entry, failure: null });
}
