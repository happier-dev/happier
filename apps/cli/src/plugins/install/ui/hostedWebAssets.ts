import { isPluginUiHostApiVersionCompatibleV1 } from '@happier-dev/protocol/plugins/ui/hostApi';
import { PluginHostedWebRuntimeModeV1Schema } from '@happier-dev/protocol/plugins/ui/hostedWebBuild';
import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import type { PluginHostedWebRuntimeModeV1, PluginUiHostedStaticArtifactV2, PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';

export type HostedWebAssetRuntimeResolutionCode =
  | 'invalid_runtime_mode'
  | 'invalid_artifact_manifest'
  | 'artifact_entry_missing'
  | 'artifact_id_mismatch'
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
  manifest: PluginUiArtifactsManifestV2,
  artifactId: string,
): PluginUiHostedStaticArtifactV2 | null {
  return manifest.entries.find((entry) => (
    entry.artifactId === artifactId && entry.tier === 'hostedWeb'
  )) as PluginUiHostedStaticArtifactV2 | undefined ?? null;
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

  const manifest = PluginUiArtifactsManifestV2Schema.safeParse(params.manifest);
  if (!manifest.success) {
    return Object.freeze({
      ok: false,
      code: 'invalid_artifact_manifest',
      diagnostics: Object.freeze(['ui_artifacts_manifest_invalid']),
    });
  }

  return resolveParsedHostedWebAssetRuntime({
    contributionId: params.contributionId,
    runtimeMode: runtimeMode.data,
    manifest: manifest.data,
  });
}

function resolveParsedHostedWebAssetRuntime(params: Readonly<{
  contributionId: string;
  runtimeMode: PluginHostedWebRuntimeModeV1;
  manifest: PluginUiArtifactsManifestV2;
}>): HostedWebAssetRuntimeResolutionResult {
  if (params.runtimeMode.kind === 'registeredSessionEndpoint') {
    return Object.freeze({
      ok: false,
      code: 'registered_endpoint_requires_lsv3',
      diagnostics: Object.freeze(['lsv3_endpoint_projection_required']),
    });
  }

  const entry = findHostedWebManifestEntry(params.manifest, params.runtimeMode.artifactId);
  if (!entry) {
    return Object.freeze({
      ok: false,
      code: 'artifact_entry_missing',
      diagnostics: Object.freeze(['hosted_web_artifact_entry_missing']),
    });
  }
  if (!isPluginUiHostApiVersionCompatibleV1(entry.hostUiApiRange)) {
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
