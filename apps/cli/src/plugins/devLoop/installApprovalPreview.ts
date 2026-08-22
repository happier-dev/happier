import { resolve } from 'node:path';

import { projectPluginInstallationReviewHostAccess } from '@/plugins/daemon/installationReview';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { resolveLocalPluginInstallTrust } from '@/plugins/store/install/trustPolicy';

type PluginInstallApprovalInput = Readonly<Record<string, unknown>>;

type PluginInstallApprovalPreviewParams = Readonly<{
  input: unknown;
  defaultPreview: unknown;
  workspaceRoot?: string;
}>;

function readInput(input: unknown): PluginInstallApprovalInput {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as PluginInstallApprovalInput
    : {};
}

function readString(input: PluginInstallApprovalInput, key: string): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

function readBoolean(input: PluginInstallApprovalInput, key: string): boolean {
  return input[key] === true;
}

function withDefaultPreview(defaultPreview: unknown, pluginInstall: unknown): unknown {
  return {
    ...(defaultPreview && typeof defaultPreview === 'object' && !Array.isArray(defaultPreview) ? defaultPreview as Record<string, unknown> : {}),
    pluginInstall,
  };
}

export async function buildPluginInstallApprovalPreview(params: PluginInstallApprovalPreviewParams): Promise<unknown> {
  const input = readInput(params.input);
  const locator = readString(input, 'path');
  const dev = readBoolean(input, 'dev');
  const force = readBoolean(input, 'force');
  const dryRun = readBoolean(input, 'dryRun');
  const resolved = await resolveLocalPathPluginSource({ locator });

  if (!resolved.ok) {
    return withDefaultPreview(params.defaultPreview, {
      ok: false,
      source: {
        kind: 'path',
        locator,
        dev,
        force,
        dryRun,
      },
      diagnostics: resolved.diagnostics,
    });
  }

  const trust = await resolveLocalPluginInstallTrust({
    dev,
    pluginRootPath: resolved.pluginRootPath,
    workspaceRoot: params.workspaceRoot,
    defaultTrustPolicy: resolved.sourceSpec.trustPolicy,
    defaultInstallPolicy: resolved.sourceSpec.installPolicy,
  });
  const title = typeof resolved.manifest.displayName === 'string'
    ? resolved.manifest.displayName
    : resolved.manifest.displayName.fallback;
  const description = typeof resolved.manifest.description === 'string'
    ? resolved.manifest.description
    : resolved.manifest.description?.fallback;

  return withDefaultPreview(params.defaultPreview, {
    ok: true,
    plugin: {
      id: resolved.manifest.id,
      version: resolved.manifest.version,
      title,
      ...(description ? { description } : {}),
    },
    source: {
      kind: 'path',
      locator: resolved.sourceSpec.locator,
      resolvedPath: resolved.pluginRootPath,
      dev,
      force,
      dryRun,
      trustPolicy: trust.trustPolicy,
      installPolicy: trust.installPolicy,
    },
    provenance: {
      sourceKind: 'path',
      locator,
      resolvedLocator: resolve(locator),
      manifestPath: resolved.manifestPath,
    },
    permissions: {
      required: projectPluginInstallationReviewHostAccess({
        pluginId: resolved.manifest.id,
        requests: resolved.manifest.hostAccess.required,
      }),
      optional: projectPluginInstallationReviewHostAccess({
        pluginId: resolved.manifest.id,
        requests: resolved.manifest.hostAccess.optional,
      }),
    },
  });
}
