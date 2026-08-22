import {
  PLUGIN_UI_HOST_API_VERSION_V1,
  PluginHostedWebRuntimeModeV1Schema,
  PluginUiArtifactsManifestV1Schema,
  type PluginHostedWebRuntimeModeV1,
  type PluginUiArtifactsManifestEntryV1,
  type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

export type HostedWebAssetRuntimeResolutionCode =
  | 'invalid_runtime_mode'
  | 'invalid_artifact_manifest'
  | 'artifact_entry_missing'
  | 'artifact_id_mismatch'
  | 'artifact_platform_mismatch'
  | 'asset_root_mismatch'
  | 'hosted_web_static_artifact_host_api_mismatch'
  | 'registered_endpoint_requires_lsv3';

export type HostedWebAssetRuntimeResolutionResult =
  | Readonly<{
    ok: true;
    artifactId: string;
    assetRootId: string;
    entryPath: string;
    files: readonly string[];
    digest: string;
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
  contributionId: string;
  manifestContributionId?: string;
  runtimeMode: unknown;
  manifest: unknown;
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
    runtimeMode: runtimeMode.data,
    manifest: manifest.data,
  });
}

function resolveParsedHostedWebAssetRuntime(params: Readonly<{
  contributionId: string;
  manifestContributionId?: string;
  runtimeMode: PluginHostedWebRuntimeModeV1;
  manifest: PluginUiArtifactsManifestV1;
}>): HostedWebAssetRuntimeResolutionResult {
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
  if (entry.hostUiApiVersion !== PLUGIN_UI_HOST_API_VERSION_V1) {
    return Object.freeze({
      ok: false,
      code: 'hosted_web_static_artifact_host_api_mismatch',
      diagnostics: Object.freeze(['hosted_web_static_artifact_host_api_mismatch']),
    });
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
  });
}
