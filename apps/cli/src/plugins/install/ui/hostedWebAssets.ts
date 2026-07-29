import {
  PluginHostedWebRuntimeModeV1Schema,
  PluginUiArtifactsManifestV1Schema,
  type PluginHostedWebRuntimeModeV1,
  type PluginUiArtifactsManifestEntryV1,
  type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

import { validateInstalledPluginUiArtifactManifest } from './artifacts';

export type HostedWebAssetRuntimeResolutionCode =
  | 'invalid_runtime_mode'
  | 'invalid_artifact_manifest'
  | 'artifact_entry_missing'
  | 'artifact_id_mismatch'
  | 'artifact_platform_mismatch'
  | 'artifact_digest_mismatch'
  | 'contribution_id_mismatch'
  | 'invalid_artifact_manifest'
  | 'plugin_id_mismatch'
  | 'asset_root_mismatch'
  | 'managed_service_requires_lsv2'
  | 'registered_endpoint_requires_lsv3';

export type HostedWebAssetRuntimeResolutionResult =
  | Readonly<{
    ok: true;
    artifactId: string;
    assetRootId: string;
    entryPath: string;
    files: readonly string[];
    digest: string;
    cacheKey?: string;
    integrity?: Readonly<{
      digest: string;
      pluginId: string;
      contributionId: string;
      artifactKind: 'hostedWebAsset';
    }>;
  }>
  | Readonly<{
    ok: false;
    code: HostedWebAssetRuntimeResolutionCode;
    diagnostics: readonly string[];
  }>;

function findHostedWebManifestEntry(
  manifest: PluginUiArtifactsManifestV1,
  contributionId: string,
): PluginUiArtifactsManifestEntryV1 | null {
  return manifest.entries.find((entry) => (
    entry.contributionId === contributionId && entry.tier === 'hostedWeb'
  )) ?? null;
}

function normalizeArtifactPath(path: string): string {
  return path.trim().replace(/\/+$/u, '');
}

function isDeclaredUnderAssetRoot(path: string, assetRootId: string): boolean {
  const normalizedPath = normalizeArtifactPath(path);
  const normalizedRoot = normalizeArtifactPath(assetRootId);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function resolveHostedWebAssetRuntime(params: Readonly<{
  pluginId?: string;
  contributionId: string;
  manifestContributionId?: string;
  runtimeMode: unknown;
  manifest: unknown;
  artifact?: unknown;
}>): HostedWebAssetRuntimeResolutionResult {
  const runtimeMode = PluginHostedWebRuntimeModeV1Schema.safeParse(params.runtimeMode);
  if (!runtimeMode.success) {
    return Object.freeze({
      ok: false,
      code: 'invalid_runtime_mode',
      diagnostics: Object.freeze(['hosted_web_runtime_mode_invalid']),
    });
  }

  const manifest = PluginUiArtifactsManifestV1Schema.safeParse(params.manifest);
  if (!manifest.success) {
    return Object.freeze({
      ok: false,
      code: 'invalid_artifact_manifest',
      diagnostics: Object.freeze(['ui_artifacts_manifest_invalid']),
    });
  }

  return resolveParsedHostedWebAssetRuntime({
    contributionId: params.contributionId,
    manifestContributionId: params.manifestContributionId,
    pluginId: params.pluginId,
    runtimeMode: runtimeMode.data,
    manifest: manifest.data,
    artifact: params.artifact,
  });
}

function resolveParsedHostedWebAssetRuntime(params: Readonly<{
  pluginId?: string;
  contributionId: string;
  manifestContributionId?: string;
  runtimeMode: PluginHostedWebRuntimeModeV1;
  manifest: PluginUiArtifactsManifestV1;
  artifact?: unknown;
}>): HostedWebAssetRuntimeResolutionResult {
  if (params.runtimeMode.kind === 'managedLocalService') {
    return Object.freeze({
      ok: false,
      code: 'managed_service_requires_lsv2',
      diagnostics: Object.freeze(['lsv2_runtime_required']),
    });
  }

  if (params.runtimeMode.kind === 'registeredSessionEndpoint') {
    return Object.freeze({
      ok: false,
      code: 'registered_endpoint_requires_lsv3',
      diagnostics: Object.freeze(['lsv3_endpoint_projection_required']),
    });
  }

  const manifestContributionId = params.manifestContributionId ?? params.contributionId;
  const entry = findHostedWebManifestEntry(params.manifest, manifestContributionId);
  if (!entry) {
    return Object.freeze({
      ok: false,
      code: 'artifact_entry_missing',
      diagnostics: Object.freeze(['hosted_web_artifact_entry_missing']),
    });
  }
  if (params.manifestContributionId !== undefined && entry.platform !== 'web') {
    return Object.freeze({
      ok: false,
      code: 'artifact_platform_mismatch',
      diagnostics: Object.freeze(['hosted_web_artifact_platform_mismatch']),
    });
  }
  if (params.manifestContributionId !== undefined && params.runtimeMode.artifactId !== manifestContributionId) {
    return Object.freeze({
      ok: false,
      code: 'artifact_id_mismatch',
      diagnostics: Object.freeze(['hosted_web_artifact_id_mismatch']),
    });
  }

  const artifactValidation = validateHostedWebArtifactIfProvided({
    artifact: params.artifact,
    pluginId: params.pluginId,
    contributionId: params.contributionId,
    runtimeMode: params.runtimeMode,
    manifestEntry: entry,
  });
  if (!artifactValidation.ok) {
    return artifactValidation;
  }

  const assetRootId = normalizeArtifactPath(params.runtimeMode.assetRootId);
  const entryIsInAssetRoot = isDeclaredUnderAssetRoot(entry.entry, assetRootId)
    && entry.files.every((file) => isDeclaredUnderAssetRoot(file.relativePath, assetRootId));
  if (!entryIsInAssetRoot) {
    return Object.freeze({
      ok: false,
      code: 'asset_root_mismatch',
      diagnostics: Object.freeze(['hosted_web_asset_root_mismatch']),
    });
  }

  return Object.freeze({
    ok: true,
    artifactId: params.runtimeMode.artifactId,
    assetRootId,
    entryPath: entry.entry,
    files: Object.freeze(entry.files.map((file) => file.relativePath)),
    digest: entry.digest,
    ...artifactValidation.data,
  });
}

function validateHostedWebArtifactIfProvided(params: Readonly<{
  artifact: unknown;
  pluginId: string | undefined;
  contributionId: string;
  runtimeMode: Extract<PluginHostedWebRuntimeModeV1, { kind: 'installedStaticAssets' }>;
  manifestEntry: PluginUiArtifactsManifestEntryV1;
}>): Readonly<{ ok: true; data: Record<string, never> | Pick<Extract<HostedWebAssetRuntimeResolutionResult, { ok: true }>, 'cacheKey' | 'integrity'> }>
  | Extract<HostedWebAssetRuntimeResolutionResult, { ok: false }> {
  if (params.artifact === undefined) {
    return Object.freeze({ ok: true, data: {} });
  }
  if (!params.pluginId) {
    return Object.freeze({
      ok: false,
      code: 'invalid_artifact_manifest',
      diagnostics: Object.freeze(['hosted_web_artifact_plugin_id_required']),
    });
  }
  const validation = validateInstalledPluginUiArtifactManifest({
    artifact: params.artifact,
    expectedPluginId: params.pluginId,
    expectedContributionId: params.contributionId,
  });
  if (!validation.ok) {
    const diagnosticsByCode: Record<typeof validation.code, string> = {
      invalid_manifest: 'hosted_web_artifact_manifest_invalid',
      plugin_id_mismatch: 'hosted_web_artifact_plugin_mismatch',
      contribution_id_mismatch: 'hosted_web_artifact_contribution_mismatch',
    };
    return Object.freeze({
      ok: false,
      code: validation.code === 'invalid_manifest' ? 'invalid_artifact_manifest' : validation.code,
      diagnostics: Object.freeze([diagnosticsByCode[validation.code]]),
    });
  }
  if (validation.artifact.id !== params.runtimeMode.artifactId) {
    return Object.freeze({
      ok: false,
      code: 'artifact_id_mismatch',
      diagnostics: Object.freeze(['hosted_web_artifact_id_mismatch']),
    });
  }
  if (validation.artifact.artifactKind !== 'hostedWebAsset' || validation.artifact.contributionFamily !== 'hostedWeb') {
    return Object.freeze({
      ok: false,
      code: 'invalid_artifact_manifest',
      diagnostics: Object.freeze(['hosted_web_artifact_kind_invalid']),
    });
  }
  if (validation.artifact.integrity.digest !== params.manifestEntry.digest) {
    return Object.freeze({
      ok: false,
      code: 'artifact_digest_mismatch',
      diagnostics: Object.freeze(['hosted_web_artifact_digest_mismatch']),
    });
  }
  return Object.freeze({
    ok: true,
    data: {
      cacheKey: validation.cacheKey,
      integrity: Object.freeze({
        digest: validation.artifact.integrity.digest,
        pluginId: validation.artifact.pluginId,
        contributionId: validation.artifact.contributionId,
        artifactKind: 'hostedWebAsset' as const,
      }),
    },
  });
}
