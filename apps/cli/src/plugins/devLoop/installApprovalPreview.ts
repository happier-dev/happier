import { resolve } from 'node:path';

import { resolvePluginAuthoringSource } from '@/plugins/authoring/sourceModule';
import { projectPluginInstallationReviewHostAccess } from '@/plugins/daemon/installationReview';
import { resolveLocalPluginInstallTrust } from '@/plugins/store/install/trustPolicy';
import type { PluginChangePendingReviewResult } from '@happier-dev/protocol/marketplace/internal';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol';

type PluginInstallApprovalInput = Readonly<Record<string, unknown>>;

type PluginInstallApprovalPreviewParams = Readonly<{
  input: unknown;
  defaultPreview: unknown;
  workspaceRoot?: string;
  daemonEvaluation?: PluginChangePendingReviewResult;
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

function daemonDisclosure(evaluation: PluginChangePendingReviewResult | undefined): Readonly<Record<string, unknown>> {
  return evaluation?.reviewKind === 'installation'
    ? { permissionsDisclosure: 'daemonEvaluated', pendingReview: evaluation,
        // Approval previews are retained snapshots, not a live inspect connection.
        daemonAuthority: presentMachineAuthorityV1({ observation: evaluation.review.daemonRights?.observation, freshness: 'stale' }) }
    : { permissionsDisclosure: 'pendingDaemonEvaluation', daemonAuthority: presentMachineAuthorityV1({}) };
}

/**
 * The Agent-facing `plugins.install` approval preview. A daemon-evaluated
 * candidate is the exact disclosure and later apply authority. Before that
 * evaluation exists, local sources use the canonical author-source resolver
 * so code-defined roots still preview as real project sources.
 */
export async function buildPluginInstallApprovalPreview(params: PluginInstallApprovalPreviewParams): Promise<unknown> {
  const input = readInput(params.input);
  const requestedSourceInput = readInput(input.source);
  if (readString(requestedSourceInput, 'kind') === 'marketplace' || readString(requestedSourceInput, 'kind') === 'installed') {
    return withDefaultPreview(params.defaultPreview, {
      ok: true,
      source: requestedSourceInput,
      machineId: readString(input, 'machineId'),
      ...daemonDisclosure(params.daemonEvaluation),
    });
  }
  const locator = readString(input, 'path');
  const explicitSourceKind = readString(input, 'kind');
  const dev = readBoolean(input, 'dev');
  const force = readBoolean(input, 'force');
  const dryRun = readBoolean(input, 'dryRun');
  if (explicitSourceKind === 'archive' || explicitSourceKind === 'npm') {
    return withDefaultPreview(params.defaultPreview, {
      ok: true,
      source: {
        kind: explicitSourceKind,
        locator,
        ...(explicitSourceKind === 'archive' && readString(input, 'integrity')
          ? { integrity: readString(input, 'integrity') }
          : {}),
        ...(explicitSourceKind === 'npm' && readString(input, 'selector')
          ? { selector: readString(input, 'selector') }
          : {}),
        force,
        dryRun,
      },
      ...daemonDisclosure(params.daemonEvaluation),
    });
  }
  const requestedSource = { kind: 'path' as const, locator, dev, force, dryRun };
  if (params.daemonEvaluation?.reviewKind === 'installation') {
    // The daemon retained this exact evaluated generation for the later decision/apply.
    // Re-reading the mutable author source here can only be slower or disclose bytes
    // other than the candidate the human is actually deciding.
    return withDefaultPreview(params.defaultPreview, {
      ok: true,
      source: requestedSource,
      ...daemonDisclosure(params.daemonEvaluation),
    });
  }
  const resolved = await resolvePluginAuthoringSource(locator);

  if (!resolved.ok) {
    return withDefaultPreview(params.defaultPreview, {
      ok: false,
      source: requestedSource,
      diagnostics: resolved.diagnostics,
      ...daemonDisclosure(params.daemonEvaluation),
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
      ...daemonDisclosure(params.daemonEvaluation),
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
    ...daemonDisclosure(params.daemonEvaluation),
  });
}
