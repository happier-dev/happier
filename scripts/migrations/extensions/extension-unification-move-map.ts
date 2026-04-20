import { type InventoryFile, type RewriteRule } from '../../testing/migrations/lib/migrationTypes.ts';

export interface ExtensionUnificationMoveMapEntry {
  from: string;
  to: string;
  exportRenames?: Readonly<Record<string, string>>;
  notes?: string;
  removeWhenEmpty?: boolean;
}

export interface ForbiddenExtensionUnificationFinding {
  filePath: string;
  pattern: string;
  replacement: string;
}

export const EXTENSION_UNIFICATION_MOVE_MAP: readonly ExtensionUnificationMoveMapEntry[] = Object.freeze([
  {
    from: 'apps/cli/src/extensions/plugins/store/pluginPaths.ts',
    to: 'apps/cli/src/extensions/store/paths.ts',
    notes: 'Preserve extensions/plugins on-disk state and install paths while removing source nesting.',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/store/pluginStateStore.ts',
    to: 'apps/cli/src/extensions/store/state.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/store/pluginStateStore.test.ts',
    to: 'apps/cli/src/extensions/store/state.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/store/setInstalledPluginEnabled.ts',
    to: 'apps/cli/src/extensions/store/enabled.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/store/marketplaceSourceRegistryStore.ts',
    to: 'apps/cli/src/extensions/marketplace/sources/store.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/store/marketplaceSourceRegistryStore.test.ts',
    to: 'apps/cli/src/extensions/marketplace/sources/store.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/sources/resolvePluginSource.ts',
    to: 'apps/cli/src/extensions/sources/resolve.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/sources/resolveLocalPathPluginSource.ts',
    to: 'apps/cli/src/extensions/sources/localPath.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/sources/resolveLocalPathPluginSource.test.ts',
    to: 'apps/cli/src/extensions/sources/localPath.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/install/downloadRemoteArchiveToTempFile.ts',
    to: 'apps/cli/src/extensions/install/archive/download.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/install/installPluginFromSource.ts',
    to: 'apps/cli/src/extensions/install/source.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/install/installPluginFromSource.remoteArchive.test.ts',
    to: 'apps/cli/src/extensions/install/source.remoteArchive.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/install/removeInstalledPlugin.ts',
    to: 'apps/cli/src/extensions/install/remove.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/manifest/readPluginManifest.ts',
    to: 'apps/cli/src/extensions/manifest/read.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/manifest/readPluginManifest.test.ts',
    to: 'apps/cli/src/extensions/manifest/read.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/manifest/validatePluginManifest.ts',
    to: 'apps/cli/src/extensions/manifest/validate.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/manifest/backendRuntimeAdapterOperationIdValidation.ts',
    to: 'apps/cli/src/extensions/manifest/adapters.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/shared/resolvePluginDaemonEntryPath.ts',
    to: 'apps/cli/src/extensions/manifest/daemonEntry.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/shared/resolvePluginDaemonEntryPath.test.ts',
    to: 'apps/cli/src/extensions/manifest/daemonEntry.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/shared/pluginDiagnostics.ts',
    to: 'apps/cli/src/extensions/diagnostics/types.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/catalog/pluginCatalog.ts',
    to: 'apps/cli/src/extensions/catalog/installed.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/catalog/pluginCatalog.test.ts',
    to: 'apps/cli/src/extensions/catalog/installed.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/catalog/pluginCatalogSummary.ts',
    to: 'apps/cli/src/extensions/catalog/summary.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/catalog/marketplaceCatalog.ts',
    to: 'apps/cli/src/extensions/marketplace/catalog.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/catalog/marketplaceCatalog.test.ts',
    to: 'apps/cli/src/extensions/marketplace/catalog.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/testkit/samplePluginFixture.ts',
    to: 'apps/cli/src/extensions/testkit/samplePackage.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/__fixtures__/sample-plugin/daemon.mjs',
    to: 'apps/cli/src/extensions/testkit/fixtures/sample-package/daemon.mjs',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/__fixtures__/sample-plugin/.happier-plugin/plugin.json',
    to: 'apps/cli/src/extensions/testkit/fixtures/sample-package/.happier-plugin/plugin.json',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/loader/loadInstalledPlugins.ts',
    to: 'apps/cli/src/extensions/load/installed.ts',
    notes: 'Loader replacement path; current behavior is preserved for this packaging move.',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/loader/loadInstalledPlugins.test.ts',
    to: 'apps/cli/src/extensions/load/installed.test.ts',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/loader/buildPluginContributionRegistry.ts',
    to: 'apps/cli/src/extensions/registry/normalize/package.ts',
    notes: 'Registry lane may replace internals later; this move removes plugin package nesting.',
    removeWhenEmpty: true,
  },
  {
    from: 'apps/cli/src/extensions/plugins/loader/buildPluginContributionRegistry.test.ts',
    to: 'apps/cli/src/extensions/registry/normalize/package.test.ts',
    removeWhenEmpty: true,
  },
]);

function removeKnownExtension(filePath: string): string {
  return filePath.replace(/\.(?:test\.)?tsx?$/u, (extension) => {
    if (extension.startsWith('.test.')) {
      return '.test';
    }
    return '';
  });
}

function toAliasSpecifier(filePath: string): string | null {
  const prefix = 'apps/cli/src/';
  if (!filePath.startsWith(prefix) || filePath.endsWith('.mjs') || filePath.endsWith('.json')) {
    return null;
  }
  return `@/${removeKnownExtension(filePath.slice(prefix.length))}`;
}

const RELATIVE_REWRITE_RULES: readonly RewriteRule[] = Object.freeze([
  { id: 'extension-relative-store-state-parent', from: '../store/pluginStateStore', to: '../store/state' },
  { id: 'extension-relative-store-state-sibling', from: './pluginStateStore', to: './state' },
  { id: 'extension-relative-store-state-deep-runtime', from: '../../../extensions/plugins/store/pluginStateStore', to: '../../../extensions/store/state' },
  { id: 'extension-relative-store-paths-parent', from: '../store/pluginPaths', to: '../store/paths' },
  { id: 'extension-relative-store-paths-sibling', from: './pluginPaths', to: './paths' },
  { id: 'extension-relative-marketplace-sources-store-sibling', from: './marketplaceSourceRegistryStore', to: './store' },
  { id: 'extension-relative-diagnostics-parent', from: '../shared/pluginDiagnostics', to: '../diagnostics/types' },
  { id: 'extension-relative-diagnostics-manifest', from: '../shared/pluginDiagnostics', to: '../diagnostics/types' },
  { id: 'extension-relative-diagnostics-sibling', from: './pluginDiagnostics', to: '../diagnostics/types' },
  { id: 'extension-relative-local-path-sibling', from: './resolveLocalPathPluginSource', to: './localPath' },
  { id: 'extension-relative-local-path-parent', from: '../sources/resolveLocalPathPluginSource', to: '../sources/localPath' },
  { id: 'extension-relative-source-resolve-sibling', from: './resolvePluginSource', to: './resolve' },
  { id: 'extension-relative-source-resolve-parent', from: '../sources/resolvePluginSource', to: '../sources/resolve' },
  { id: 'extension-relative-manifest-read-parent', from: '../manifest/readPluginManifest', to: '../manifest/read' },
  { id: 'extension-relative-manifest-read-sibling', from: './readPluginManifest', to: './read' },
  { id: 'extension-relative-manifest-validate-sibling', from: './validatePluginManifest', to: './validate' },
  { id: 'extension-relative-manifest-validate-parent', from: '../manifest/validatePluginManifest', to: '../manifest/validate' },
  { id: 'extension-relative-manifest-adapters-sibling', from: './backendRuntimeAdapterOperationIdValidation', to: './adapters' },
  { id: 'extension-relative-manifest-daemon-parent', from: '../shared/resolvePluginDaemonEntryPath', to: '../manifest/daemonEntry' },
  { id: 'extension-relative-manifest-daemon-sibling', from: './resolvePluginDaemonEntryPath', to: './daemonEntry' },
  { id: 'extension-relative-install-source-parent', from: '../install/installPluginFromSource', to: '../install/source' },
  { id: 'extension-relative-install-source-sibling', from: './installPluginFromSource', to: './source' },
  { id: 'extension-relative-install-download-sibling', from: './downloadRemoteArchiveToTempFile', to: './archive/download' },
  { id: 'extension-relative-loader-installed-parent', from: '../loader/loadInstalledPlugins', to: '../load/installed' },
  { id: 'extension-relative-catalog-installed-sibling', from: './pluginCatalog', to: './installed' },
  { id: 'extension-relative-marketplace-catalog-sibling', from: './marketplaceCatalog', to: './catalog' },
  { id: 'extension-relative-normalize-package-sibling', from: './buildPluginContributionRegistry', to: './package' },
]);

export function buildExtensionUnificationRewriteRules(): RewriteRule[] {
  const aliasRules = EXTENSION_UNIFICATION_MOVE_MAP.flatMap((entry): RewriteRule[] => {
    const from = toAliasSpecifier(entry.from);
    const to = toAliasSpecifier(entry.to);
    if (!from || !to) {
      return [];
    }
    return [
      {
        id: `extension-unification:${from}`,
        from,
        to,
        namedImportMap: entry.exportRenames,
      },
    ];
  });

  return [...aliasRules, ...RELATIVE_REWRITE_RULES];
}

function isMigrationAssetPath(filePath: string): boolean {
  return filePath.startsWith('scripts/migrations/extensions/');
}

export function collectForbiddenExtensionUnificationFindings(files: readonly InventoryFile[]): ForbiddenExtensionUnificationFinding[] {
  const rules = buildExtensionUnificationRewriteRules();
  const findings: ForbiddenExtensionUnificationFinding[] = [];

  for (const file of files) {
    if (isMigrationAssetPath(file.filePath)) {
      continue;
    }

    for (const rule of rules) {
      if (file.content.includes(rule.from)) {
        findings.push({
          filePath: file.filePath,
          pattern: rule.from,
          replacement: rule.to,
        });
      }
    }

    const staleMove = EXTENSION_UNIFICATION_MOVE_MAP.find((entry) => entry.from === file.filePath);
    if (staleMove) {
      findings.push({
        filePath: file.filePath,
        pattern: staleMove.from,
        replacement: staleMove.to,
      });
    }
  }

  return findings.sort((left, right) => (
    left.filePath.localeCompare(right.filePath)
    || left.pattern.localeCompare(right.pattern)
  ));
}
