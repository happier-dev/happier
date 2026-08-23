import { resolve } from 'node:path';

import { resolvePluginAuthoringSource } from '@/plugins/authoring/sourceModule';
import { projectPluginInstallationReviewHostAccess } from '@/plugins/daemon/installationReview';
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

/**
 * The Agent-facing `plugins.install` approval preview. It resolves the author
 * source through the same canonical resolver the install itself uses, so an
 * ordinary code-defined author root — the shape `plugins.scaffold` produces —
 * previews as a real source-root approval instead of failing on a legacy
 * descriptor it was never supposed to have.
 */
export async function buildPluginInstallApprovalPreview(params: PluginInstallApprovalPreviewParams): Promise<unknown> {
  const input = readInput(params.input);
  const locator = readString(input, 'path');
  const dev = readBoolean(input, 'dev');
  const force = readBoolean(input, 'force');
  const dryRun = readBoolean(input, 'dryRun');
  const requestedSource = { kind: 'path' as const, locator, dev, force, dryRun };
  const resolved = await resolvePluginAuthoringSource(locator);

  if (!resolved.ok) {
    return withDefaultPreview(params.defaultPreview, {
      ok: false,
      source: requestedSource,
      diagnostics: resolved.diagnostics,
    });
  }

  if (resolved.kind === 'code') {
    const trust = await resolveLocalPluginInstallTrust({
      dev,
      pluginRootPath: resolved.entry.packageRoot,
      workspaceRoot: params.workspaceRoot,
      defaultTrustPolicy: 'prompt',
      defaultInstallPolicy: 'link',
    });
    return withDefaultPreview(params.defaultPreview, {
      ok: true,
      authoring: 'code',
      source: {
        ...requestedSource,
        locator: resolved.entry.locator,
        resolvedPath: resolved.entry.packageRoot,
        trustPolicy: trust.trustPolicy,
        installPolicy: trust.installPolicy,
      },
      provenance: {
        sourceKind: 'path',
        locator,
        resolvedLocator: resolve(locator),
        entryPath: resolved.entry.entryPath,
      },
      // Identity and declared host access exist only once the daemon has
      // evaluated this source inside an owned immutable generation. Emitting
      // an empty permission set here would read as "requires nothing", so the
      // preview states the disclosure is still pending instead.
      permissionsDisclosure: 'pendingDaemonEvaluation',
    });
  }

  const source = resolved.source;
  const trust = await resolveLocalPluginInstallTrust({
    dev,
    pluginRootPath: source.pluginRootPath,
    workspaceRoot: params.workspaceRoot,
    defaultTrustPolicy: source.sourceSpec.trustPolicy,
    defaultInstallPolicy: source.sourceSpec.installPolicy,
  });
  const title = typeof source.manifest.displayName === 'string'
    ? source.manifest.displayName
    : source.manifest.displayName.fallback;
  const description = typeof source.manifest.description === 'string'
    ? source.manifest.description
    : source.manifest.description?.fallback;

  return withDefaultPreview(params.defaultPreview, {
    ok: true,
    authoring: 'manifest',
    plugin: {
      id: source.manifest.id,
      version: source.manifest.version,
      title,
      ...(description ? { description } : {}),
    },
    source: {
      ...requestedSource,
      locator: source.sourceSpec.locator,
      resolvedPath: source.pluginRootPath,
      trustPolicy: trust.trustPolicy,
      installPolicy: trust.installPolicy,
    },
    provenance: {
      sourceKind: 'path',
      locator,
      resolvedLocator: resolve(locator),
      manifestPath: source.manifestPath,
    },
    permissions: {
      required: projectPluginInstallationReviewHostAccess({
        pluginId: source.manifest.id,
        requests: source.manifest.hostAccess.required,
      }),
      optional: projectPluginInstallationReviewHostAccess({
        pluginId: source.manifest.id,
        requests: source.manifest.hostAccess.optional,
      }),
    },
  });
}
