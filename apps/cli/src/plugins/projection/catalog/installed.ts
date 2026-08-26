import {
  PluginStateSourceRecordSchema,
  type PluginStateCompatibilityRecord,
  type PluginStateInstallRecord,
  type PluginStateFileV1,
  type PluginStateRecord,
  type PluginStateSourceRecord,
} from '@/plugins/store/state';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
  inferPluginSourceInspectionKind,
  inspectPluginSource,
  type InspectPluginSourceResult,
} from '@/plugins/store/install/source';
import { resolvePluginAuthoringSource } from '@/plugins/authoring/sourceModule';
import { removeInstalledPlugin, type RemoveInstalledPluginResult } from '@/plugins/store/install/remove';
import { requestUserPluginChange, type UserPluginChangeResult } from '@/plugins/daemon/changeClient';
import type { PluginChangeRequest } from '@/plugins/daemon/changeContract';
import { resolvePluginSource } from '@/plugins/discovery/sources/resolve';
import type { ResolvedPluginSource } from '@/plugins/discovery/sources/resolve';
import {
  resolvePluginDaemonEntryPath,
  shouldResolvePluginDevelopmentEntrypoint,
} from '@/plugins/manifest/daemonEntry';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { projectPluginCatalogEntryIntrospection } from '@/plugins/projection/introspection/catalogEntry';
import type { PluginContributionIntrospectionProjectionV1 } from '@happier-dev/protocol';

export type PluginCatalogEntry = Readonly<{
  pluginId: string;
  desiredGeneration: string | null;
  appliedGeneration: string | null;
  /** Verified NPM/archive acquisition SRI; local paths use appliedGeneration custody. */
  admittedIntegrity: string | null;
  rollbackAvailability?: 'available' | 'unavailable';
  title: string;
  description: string | null;
  version: string;
  enabled: boolean;
  source: PluginStateSourceRecord;
  install: PluginStateInstallRecord;
  compatibility: PluginStateCompatibilityRecord;
  manifestPath: string;
  manifest: CanonicalPluginManifest | null;
  contributionIntrospection: PluginContributionIntrospectionProjectionV1;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

export type InstallPluginFromLocatorResult =
  | Readonly<{
      ok: true;
      alreadyInstalled: boolean;
      entry: PluginCatalogEntry;
      change?: UserPluginChangeResult;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
      change?: UserPluginChangeResult;
  }>;

export type UninstallPluginFromCatalogResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      entry: PluginCatalogEntry;
      removedInstalledPath: string | null;
      change?: UserPluginChangeResult;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
  }>;

export type RollbackPluginFromCatalogResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      entry: PluginCatalogEntry;
      change?: UserPluginChangeResult;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
  }>;

type InspectPluginSourceErrorCode = Extract<InspectPluginSourceResult, { ok: false }>['errorCode'];
type RemoveInstalledPluginErrorCode = Extract<Extract<RemoveInstalledPluginResult, { ok: false }>, { ok: false }>['errorCode'];

function mapInstallPluginErrorCodeToDiagnosticCode(errorCode: InspectPluginSourceErrorCode): PluginCompatibilityDiagnostic['code'] {
  switch (errorCode) {
    case 'plugin_install_failed':
    case 'plugin_install_conflict':
      return 'plugin_manifest_invalid';
    case 'plugin_already_installed':
      return 'plugin_manifest_invalid';
    case 'plugin_install_trust_required':
      return 'plugin_trust_approval_required';
    case 'plugin_source_invalid':
    default:
      return 'plugin_source_missing';
  }
}

function mapRemovePluginErrorCodeToDiagnosticCode(errorCode: RemoveInstalledPluginErrorCode): PluginCompatibilityDiagnostic['code'] {
  switch (errorCode) {
    case 'plugin_not_uninstallable':
      return 'plugin_source_kind_unsupported';
    case 'plugin_not_found':
    default:
      return 'plugin_source_missing';
  }
}

function pluginChangeDiagnostic(change: UserPluginChangeResult): PluginCompatibilityDiagnostic {
  return {
    code: change.kind === 'reviewRequired' ? 'plugin_trust_approval_required' : 'plugin_manifest_invalid',
    message: change.kind === 'reviewRequired'
      ? `Plugin '${change.review.pluginId}' requires an authenticated present-user Install and trust decision.`
      : `The daemon did not commit the plugin change (${change.kind}).`,
  };
}

function readResolvedManifest(
  pluginId: string,
  resolvedSource: ResolvedPluginSource,
): Readonly<{
    manifest: CanonicalPluginManifest | null;
    diagnostics: readonly PluginCompatibilityDiagnostic[];
  }> {
  if (!resolvedSource.ok) {
    return {
      manifest: null,
      diagnostics: resolvedSource.diagnostics,
    };
  }

  if (resolvedSource.manifest.id !== pluginId) {
    return {
      manifest: null,
      diagnostics: [
        {
          code: 'plugin_manifest_semantic_invalid',
          message: `Plugin state id '${pluginId}' does not match manifest id '${resolvedSource.manifest.id}'`,
        },
      ],
    };
  }

  return {
    manifest: resolvedSource.manifest,
    diagnostics: [],
  };
}

function buildCatalogEntry(params: Readonly<{
  pluginId: string;
  desiredGeneration: string | null;
  admittedIntegrity: string | null;
  rollbackAvailability: 'available' | 'unavailable';
  record: PluginStateRecord;
  manifest: CanonicalPluginManifest | null;
  manifestPath: string;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>): PluginCatalogEntry {
  const readText = (value: string | Readonly<{ fallback: string }> | undefined): string | undefined => (
    typeof value === 'string' ? value : value?.fallback
  );
  const title = readText(params.manifest?.displayName) ?? params.pluginId;
  const version = params.manifest?.version ?? params.record.install.manifestVersion;
  return {
    pluginId: params.pluginId,
    desiredGeneration: params.desiredGeneration,
    appliedGeneration: null,
    admittedIntegrity: params.admittedIntegrity,
    rollbackAvailability: params.rollbackAvailability,
    title,
    description: readText(params.manifest?.description) ?? null,
    version,
    enabled: params.record.state.enabled,
    source: params.record.source,
    install: params.record.install,
    compatibility: params.record.compatibility,
    manifestPath: params.manifestPath,
    manifest: params.manifest,
    contributionIntrospection: projectPluginCatalogEntryIntrospection({
      pluginId: params.pluginId,
      pluginVersion: version,
      source: params.record.source,
      manifest: params.manifest,
      generation: 0,
      host: 'cli',
      platform: process.platform,
      occurredAtMs: params.record.compatibility.checkedAtMs
        ?? params.record.source.installedAt
        ?? params.record.state.lastLoadedAtMs
        ?? 0,
      diagnostics: params.diagnostics,
    }),
    diagnostics: params.diagnostics,
  };
}

export function projectBundledPluginCatalogEntries(params: Readonly<{
  loadedPlugins: readonly LoadedPlugin[];
  desiredGenerationByPluginId?: Readonly<Record<string, string>>;
  excludedPluginIds?: ReadonlySet<string>;
}>): readonly PluginCatalogEntry[] {
  const entries = params.loadedPlugins.flatMap((plugin) => {
    if (params.excludedPluginIds?.has(plugin.pluginId)) return [];
    if (plugin.sourceSpec.kind !== 'bundled') {
      throw new Error(`Expected bundled source for current catalog plugin '${plugin.pluginId}'`);
    }
    const record = {
      source: {
        ...plugin.sourceSpec,
        resolvedPath: plugin.pluginRootPath,
        manifestPath: plugin.manifestPath,
      },
      compatibility: { status: 'compatible', diagnostics: [] },
      install: { mode: 'link', manifestVersion: plugin.manifest.version },
      state: { enabled: true },
    } satisfies PluginStateRecord;
    return [buildCatalogEntry({
      pluginId: plugin.pluginId,
      desiredGeneration: params.desiredGenerationByPluginId?.[plugin.pluginId] ?? null,
      admittedIntegrity: null,
      rollbackAvailability: 'unavailable',
      record,
      manifest: plugin.manifest,
      manifestPath: plugin.manifestPath,
      diagnostics: [],
    })];
  });
  return Object.freeze(entries.sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

async function resolvePluginCatalogEntryFromRecord(
  pluginId: string,
  record: PluginStateRecord,
  desiredGeneration: string | null = null,
  rollbackAvailability: 'available' | 'unavailable' = 'unavailable',
  admittedIntegrity: string | null = null,
): Promise<PluginCatalogEntry> {
  if (record.install.mode !== 'managed_install' && record.source.kind !== 'path') {
    return buildCatalogEntry({
      pluginId,
      desiredGeneration,
      admittedIntegrity,
      rollbackAvailability,
      record,
      manifest: null,
      manifestPath: record.source.manifestPath,
      diagnostics: [
        ...record.compatibility.diagnostics,
        {
          code: 'plugin_source_kind_unsupported',
          message: `Plugin state source kind '${record.source.kind}' is unsupported for non-managed installs; expected 'path'`,
        },
      ],
    });
  }

  const preferredLocator = record.install.mode === 'managed_install'
    ? record.install.installedPath ?? record.source.resolvedPath ?? null
    : record.source.kind === 'path'
      ? record.source.manifestPath
      : record.source.resolvedPath ?? null;

  const sourceResolution = typeof preferredLocator === 'string' && preferredLocator.trim().length > 0
    ? await resolvePluginSource({
      source: record.source.kind === 'path'
        ? record.source
        : {
            ...record.source,
            kind: 'path',
            locator: preferredLocator,
            installPolicy: 'link',
          },
      manifestPathHint: record.source.manifestPath,
    })
    : {
        ok: false,
        diagnostics: [
          {
            code: 'plugin_source_missing',
            message: `Plugin state for '${pluginId}' is missing a resolvable install path`,
          },
        ],
      } satisfies ResolvedPluginSource;

  const resolvedManifest = readResolvedManifest(pluginId, sourceResolution);
  const daemonEntryDiagnostics = await (async (): Promise<readonly PluginCompatibilityDiagnostic[]> => {
    if (!sourceResolution.ok) {
      return [];
    }
    if (!resolvedManifest.manifest) {
      return [];
    }

    const daemonEntryResolution = await resolvePluginDaemonEntryPath({
      pluginRootPath: sourceResolution.pluginRootPath,
      manifest: sourceResolution.manifest,
      resolveDevEntrypoint: shouldResolvePluginDevelopmentEntrypoint(record),
    });
    if (daemonEntryResolution.ok) {
      return [];
    }
    return [daemonEntryResolution.diagnostic];
  })();
  return buildCatalogEntry({
    pluginId,
    desiredGeneration,
    admittedIntegrity,
    rollbackAvailability,
    record,
    manifest: resolvedManifest.manifest,
    manifestPath: sourceResolution.ok ? sourceResolution.manifestPath : record.source.manifestPath,
    diagnostics: [
      ...record.compatibility.diagnostics,
      ...resolvedManifest.diagnostics,
      ...daemonEntryDiagnostics,
    ],
  });
}

async function projectInstalledPluginCatalog(
  state: PluginStateFileV1,
  pluginGenerations: Readonly<Record<string, Readonly<{ immutableGenerationId: string }>>>,
  rollbackAvailabilityByPluginId: Readonly<Record<string, 'available' | 'unavailable'>>,
  admittedIntegrityByPluginId: Readonly<Record<string, string>>,
): Promise<readonly PluginCatalogEntry[]> {
  const entries: PluginCatalogEntry[] = [];

  for (const [pluginId, record] of Object.entries(state.plugins)) {
    entries.push(await resolvePluginCatalogEntryFromRecord(
      pluginId,
      record,
      pluginGenerations[pluginId]?.immutableGenerationId ?? null,
      rollbackAvailabilityByPluginId[pluginId] ?? 'unavailable',
      admittedIntegrityByPluginId[pluginId] ?? null,
    ));
  }

  return Object.freeze(entries.sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

export async function readInstalledPluginCatalogSnapshot(params?: Readonly<{
  happyHomeDir?: string;
}>): Promise<Readonly<{ revision: number; entries: readonly PluginCatalogEntry[] }>> {
  const stateStore = createPluginRegistryStateStore({ happyHomeDir: params?.happyHomeDir });
  const snapshot = await stateStore.readSnapshot();
  return Object.freeze({
    revision: snapshot.revision,
    entries: await projectInstalledPluginCatalog(
      snapshot.state,
      snapshot.pluginGenerations,
      snapshot.rollbackAvailabilityByPluginId,
      snapshot.admittedIntegrityByPluginId,
    ),
  });
}

export async function readInstalledPluginCatalog(params?: Readonly<{ happyHomeDir?: string }>): Promise<readonly PluginCatalogEntry[]> {
  return (await readInstalledPluginCatalogSnapshot(params)).entries;
}

export async function readInstalledPluginCatalogEntry(params: Readonly<{
  pluginId: string;
  happyHomeDir?: string;
}>): Promise<PluginCatalogEntry | null> {
  const entries = await readInstalledPluginCatalog({ happyHomeDir: params.happyHomeDir });
  return entries.find((entry) => entry.pluginId === params.pluginId) ?? null;
}

/**
 * The one client-side commit path for an install the daemon owns. Both the
 * manifest-rooted and code-defined sources reach the registry through it, so
 * the committed plugin identity always comes from the daemon's own result
 * rather than from a second client-side resolution of the same source.
 */
async function submitPluginInstallChange(params: Readonly<{
  request: Extract<
    PluginChangeRequest,
    Readonly<{ kind: 'installPath' | 'installArchive' }>
  >;
  happyHomeDir?: string;
}>): Promise<InstallPluginFromLocatorResult> {
  const change = await requestUserPluginChange({
    request: params.request,
    approval: 'none',
  });
  if (change.kind !== 'committed') {
    return {
      ok: false,
      diagnostics: [pluginChangeDiagnostic(change)],
      change,
    };
  }

  const entry = await readInstalledPluginCatalogEntry({
    pluginId: change.pluginId,
    ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
  });
  if (!entry) {
    return {
      ok: false,
      diagnostics: [{
        code: 'plugin_source_missing',
        message: `Daemon committed plugin '${change.pluginId}', but its installed catalog entry is not yet readable.`,
      }],
      change,
    };
  }
  return { ok: true, alreadyInstalled: false, entry, change };
}

export async function installPluginFromLocator(params: Readonly<{
  locator: string;
  happyHomeDir?: string;
  skipIfInstalled: boolean;
  dryRun?: boolean;
  dev?: boolean;
  workspaceRoot?: string;
}>): Promise<InstallPluginFromLocatorResult> {
  const stateStore = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const happyHomeDir = stateStore.paths.happyHomeDir;
  if (!happyHomeDir) {
    throw new Error('Plugin state store resolved without a happyHomeDir');
  }
  if (inferPluginSourceInspectionKind(params.locator) === 'path') {
    const authoringSource = await resolvePluginAuthoringSource(params.locator);
    if (authoringSource.ok && authoringSource.kind === 'code') {
      // A code-defined author source carries no on-disk manifest, and only the
      // daemon may evaluate one — inside an owned immutable generation behind
      // its integrity fence. Submitting the canonical installPath request keeps
      // that evaluation with its single owner instead of pre-judging the source
      // against a manifest that legitimately does not exist.
      if (params.dryRun) {
        return {
          ok: false,
          diagnostics: [{
            code: 'plugin_source_kind_unsupported',
            message: `A dry-run install preview is unavailable for the code-defined plugin source at '${params.locator}': only the daemon may evaluate it.`,
          }],
        };
      }
      return await submitPluginInstallChange({
        request: {
          kind: 'installPath',
          locator: params.locator,
          development: params.dev === true,
        },
        ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
      });
    }
  }
  const installResult = await inspectPluginSource({
    happyHomeDir,
    locator: params.locator,
    skipIfInstalled: params.skipIfInstalled,
    dev: params.dev,
    workspaceRoot: params.workspaceRoot,
  });

  if (!installResult.ok) {
    return {
      ok: false,
      diagnostics: [
        {
          code: mapInstallPluginErrorCodeToDiagnosticCode(installResult.errorCode),
          message: installResult.errorMessage,
        },
      ],
    };
  }

  if (params.dryRun && !installResult.alreadyInstalled) {
    const parsedSource = PluginStateSourceRecordSchema.safeParse(installResult.source);
    if (!parsedSource.success) {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'plugin_source_missing',
            message: 'Dry-run plugin install did not return a resolvable source record',
          },
        ],
      };
    }

    const previewEntry = await resolvePluginCatalogEntryFromRecord(installResult.pluginId, {
      source: parsedSource.data,
      compatibility: {
        status: 'compatible',
        diagnostics: [],
      },
      install: {
        mode: 'link',
        manifestVersion: installResult.manifestVersion,
        installedPath: installResult.installedPath,
      },
      state: {
        enabled: true,
      },
    });

    return {
      ok: true,
      alreadyInstalled: false,
      entry: previewEntry,
    };
  }

  if (!params.dryRun && !(params.skipIfInstalled && installResult.alreadyInstalled)) {
    return await submitPluginInstallChange({
      request: installResult.sourceKind === 'archive'
        ? { kind: 'installArchive', locator: params.locator }
        : { kind: 'installPath', locator: params.locator, development: params.dev === true },
      ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
    });
  }

  return {
    ok: true,
    alreadyInstalled: installResult.alreadyInstalled,
    entry: await readInstalledPluginCatalogEntry({
      pluginId: installResult.pluginId,
      happyHomeDir: params.happyHomeDir,
    }).then((entry) => {
      if (!entry) {
        throw new Error(`Installed plugin '${installResult.pluginId}' could not be re-read from state`);
      }
      return entry;
    }),
  };
}

export async function uninstallPluginFromCatalog(params: Readonly<{
  pluginId: string;
  happyHomeDir?: string;
}>): Promise<UninstallPluginFromCatalogResult> {
  const pluginId = params.pluginId.trim();
  if (!pluginId) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_manifest_semantic_invalid',
          message: 'plugins.uninstall requires a non-empty pluginId',
        },
      ],
    };
  }

  const stateStore = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const happyHomeDir = stateStore.paths.happyHomeDir;
  if (!happyHomeDir) {
    throw new Error('Plugin state store resolved without a happyHomeDir');
  }

  const entry = await readInstalledPluginCatalogEntry({
    pluginId,
    happyHomeDir,
  });
  if (!entry) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_source_missing',
          message: `Installed plugin '${pluginId}' was not found`,
        },
      ],
    };
  }

  if (entry.source.kind === 'bundled') {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_source_kind_unsupported',
          message: `Bundled first-party plugin '${pluginId}' cannot be removed from the local installed plugin catalog`,
        },
      ],
    };
  }

  const removed = await removeInstalledPlugin({
    happyHomeDir,
    pluginId,
  });
  if (!removed.ok) {
    return {
      ok: false,
      diagnostics: [
        {
          code: mapRemovePluginErrorCodeToDiagnosticCode(removed.errorCode),
          message: removed.errorMessage,
        },
      ],
    };
  }

  return {
    ok: true,
    pluginId: removed.pluginId,
    entry,
    removedInstalledPath: removed.removedInstalledPath,
    change: removed.change,
  };
}

export async function rollbackPluginFromCatalog(params: Readonly<{
  pluginId: string;
  happyHomeDir?: string;
}>): Promise<RollbackPluginFromCatalogResult> {
  const pluginId = params.pluginId.trim();
  if (!pluginId) {
    return {
      ok: false,
      diagnostics: [{
        code: 'plugin_manifest_semantic_invalid',
        message: 'plugins.rollback requires a non-empty pluginId',
      }],
    };
  }

  const stateStore = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const current = await readInstalledPluginCatalogEntry({
    pluginId,
    happyHomeDir: stateStore.paths.happyHomeDir,
  });
  if (!current) {
    return {
      ok: false,
      diagnostics: [{ code: 'plugin_source_missing', message: `Installed plugin '${pluginId}' was not found` }],
    };
  }
  if (current.source.kind === 'bundled') {
    return {
      ok: false,
      diagnostics: [{
        code: 'plugin_source_kind_unsupported',
        message: `Bundled first-party plugin '${pluginId}' has no user-managed rollback generation`,
      }],
    };
  }

  const change = await requestUserPluginChange({
    request: { kind: 'rollback', pluginId },
    approval: 'none',
  });
  if (change.kind !== 'committed') {
    return {
      ok: false,
      diagnostics: [pluginChangeDiagnostic(change)],
    };
  }

  const entry = await readInstalledPluginCatalogEntry({
    pluginId,
    happyHomeDir: stateStore.paths.happyHomeDir,
  });
  if (!entry) {
    throw new Error(`Rolled-back plugin '${pluginId}' could not be re-read from the committed registry`);
  }
  return { ok: true, pluginId, entry, change };
}
