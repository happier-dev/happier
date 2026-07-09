import {
  createPluginStateStore,
  PluginStateSourceRecordSchema,
  type PluginStateCompatibilityRecord,
  type PluginStateInstallRecord,
  type PluginStateRecord,
  type PluginStateSourceRecord,
} from '@/plugins/store/state';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { installPluginFromSource, type InstallPluginFromSourceResult } from '@/plugins/store/install/source';
import { removeInstalledPlugin, type RemoveInstalledPluginResult } from '@/plugins/store/install/remove';
import { resolvePluginSource } from '@/plugins/discovery/sources/resolve';
import type { ResolvedPluginSource } from '@/plugins/discovery/sources/resolve';
import { resolvePluginDaemonEntryPath } from '@/plugins/manifest/daemonEntry';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { summarizePluginContributes, type PluginCatalogContributionSummary } from './summary';

export type PluginCatalogEntry = Readonly<{
  pluginId: string;
  title: string;
  description: string | null;
  version: string;
  enabled: boolean;
  source: PluginStateSourceRecord;
  install: PluginStateInstallRecord;
  compatibility: PluginStateCompatibilityRecord;
  manifestPath: string;
  manifestDigest: string | null;
  manifest: CanonicalPluginManifest | null;
  contributionIds: PluginCatalogContributionSummary;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

export type InstallPluginFromLocatorResult =
  | Readonly<{
      ok: true;
      alreadyInstalled: boolean;
      entry: PluginCatalogEntry;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
  }>;

export type UninstallPluginFromCatalogResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      entry: PluginCatalogEntry;
      removedInstalledPath: string | null;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
  }>;

type InstallPluginFromSourceErrorCode = Extract<Extract<InstallPluginFromSourceResult, { ok: false }>, { ok: false }>['errorCode'];
type RemoveInstalledPluginErrorCode = Extract<Extract<RemoveInstalledPluginResult, { ok: false }>, { ok: false }>['errorCode'];

function mapInstallPluginErrorCodeToDiagnosticCode(errorCode: InstallPluginFromSourceErrorCode): PluginCompatibilityDiagnostic['code'] {
  switch (errorCode) {
    case 'plugin_install_failed':
      return 'plugin_manifest_invalid';
    case 'plugin_already_installed':
      return 'plugin_manifest_invalid';
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
  record: PluginStateRecord;
  manifest: CanonicalPluginManifest | null;
  manifestPath: string;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>): PluginCatalogEntry {
  const title = params.manifest?.displayName ?? params.pluginId;
  const version = params.manifest?.version ?? params.record.install.manifestVersion;
  return {
    pluginId: params.pluginId,
    title,
    description: params.manifest?.description ?? null,
    version,
    enabled: params.record.state.enabled,
    source: params.record.source,
    install: params.record.install,
    compatibility: params.record.compatibility,
    manifestPath: params.manifestPath,
    manifestDigest: params.record.install.manifestDigest ?? params.record.source.resolvedDigest ?? null,
    manifest: params.manifest,
    contributionIds: summarizePluginContributes(params.manifest),
    diagnostics: params.diagnostics,
  };
}

async function resolvePluginCatalogEntryFromRecord(
  pluginId: string,
  record: PluginStateRecord,
): Promise<PluginCatalogEntry> {
  if (record.install.mode !== 'managed_install' && record.source.kind !== 'path') {
    return buildCatalogEntry({
      pluginId,
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
    });
    if (daemonEntryResolution.ok) {
      return [];
    }
    return [daemonEntryResolution.diagnostic];
  })();
  return buildCatalogEntry({
    pluginId,
    record,
    manifest: resolvedManifest.manifest,
    manifestPath: sourceResolution.ok ? sourceResolution.manifestPath : record.source.manifestPath,
    diagnostics: [...record.compatibility.diagnostics, ...resolvedManifest.diagnostics, ...daemonEntryDiagnostics],
  });
}

export async function readInstalledPluginCatalog(params?: Readonly<{ happyHomeDir?: string }>): Promise<readonly PluginCatalogEntry[]> {
  const stateStore = createPluginStateStore({ happyHomeDir: params?.happyHomeDir });
  const state = await stateStore.read();
  const entries: PluginCatalogEntry[] = [];

  for (const [pluginId, record] of Object.entries(state.plugins)) {
    entries.push(await resolvePluginCatalogEntryFromRecord(pluginId, record));
  }

  return Object.freeze(entries.sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

export async function readInstalledPluginCatalogEntry(params: Readonly<{
  pluginId: string;
  happyHomeDir?: string;
}>): Promise<PluginCatalogEntry | null> {
  const entries = await readInstalledPluginCatalog({ happyHomeDir: params.happyHomeDir });
  return entries.find((entry) => entry.pluginId === params.pluginId) ?? null;
}

export async function installPluginFromLocator(params: Readonly<{
  locator: string;
  happyHomeDir?: string;
  skipIfInstalled: boolean;
  dryRun?: boolean;
  dev?: boolean;
  workspaceRoot?: string;
}>): Promise<InstallPluginFromLocatorResult> {
  const stateStore = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  const happyHomeDir = stateStore.paths.happyHomeDir;
  if (!happyHomeDir) {
    throw new Error('Plugin state store resolved without a happyHomeDir');
  }
  const installResult = await installPluginFromSource({
    happyHomeDir,
    locator: params.locator,
    skipIfInstalled: params.skipIfInstalled,
    dryRun: params.dryRun,
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
        manifestDigest: installResult.manifestDigest,
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

  const stateStore = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
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
  };
}
