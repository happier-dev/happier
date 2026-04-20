import { pathToFileURL } from 'node:url';

import { collectFileInventory } from '../../testing/migrations/lib/collectFileInventory.ts';
import {
  applyRewritePlan,
  planImportRewrites,
} from '../../testing/migrations/lib/rewriteImports.ts';
import { type InventoryFile, type RewritePlan, type RewriteRule } from '../../testing/migrations/lib/migrationTypes.ts';

import { buildExtensionUnificationRewriteRules } from './extension-unification-move-map.ts';

const SOURCE_AWARE_RULES: readonly (RewriteRule & { filePathSuffixes: readonly string[] })[] = Object.freeze([
  {
    id: 'extension-source-aware-store-state-utils',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/store/pluginStateStore.ts',
      'apps/cli/src/extensions/store/state.ts',
    ],
    from: '../../../utils/fs/writeJsonAtomic',
    to: '../../utils/fs/writeJsonAtomic',
  },
  {
    id: 'extension-source-aware-store-paths-config',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/store/pluginPaths.ts',
      'apps/cli/src/extensions/store/paths.ts',
    ],
    from: '../../../configuration',
    to: '../../configuration',
  },
  {
    id: 'extension-source-aware-manifest-validate-config',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/manifest/validatePluginManifest.ts',
      'apps/cli/src/extensions/manifest/validate.ts',
    ],
    from: '../../../configuration',
    to: '../../configuration',
  },
  {
    id: 'extension-source-aware-marketplace-sources-paths',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/store/marketplaceSourceRegistryStore.ts',
      'apps/cli/src/extensions/marketplace/sources/store.ts',
    ],
    from: './paths',
    to: '../../store/paths',
  },
  {
    id: 'extension-source-aware-marketplace-summary',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/catalog/marketplaceCatalog.ts',
      'apps/cli/src/extensions/marketplace/catalog.ts',
    ],
    from: './pluginCatalogSummary',
    to: '../catalog/summary',
  },
  {
    id: 'extension-source-aware-catalog-summary',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/catalog/pluginCatalog.ts',
      'apps/cli/src/extensions/catalog/installed.ts',
    ],
    from: './pluginCatalogSummary',
    to: './summary',
  },
  {
    id: 'extension-source-aware-load-installed-test',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/loader/loadInstalledPlugins.test.ts',
      'apps/cli/src/extensions/load/installed.test.ts',
    ],
    from: './loadInstalledPlugins',
    to: './installed',
  },
  {
    id: 'extension-source-aware-normalize-load-installed',
    filePathSuffixes: [
      'apps/cli/src/extensions/plugins/loader/buildPluginContributionRegistry.ts',
      'apps/cli/src/extensions/registry/normalize/package.ts',
    ],
    from: './loadInstalledPlugins',
    to: '../../load/installed',
  },
]);

function rewriteModuleSpecifier(content: string, from: string, to: string): string {
  const fromStatementPattern = /(^|\n)(\s*(?:import|export)\b[\s\S]*?\bfrom\s*)(['"])([^'"]+)(\3)/g;
  const bareImportPattern = /(^|\n)(\s*import\s*)(['"])([^'"]+)(\3)/g;

  const rewrite = (
    _match: string,
    linePrefix: string,
    statementPrefix: string,
    quote: string,
    specifier: string,
    closingQuote: string,
  ): string => {
    if (specifier !== from) {
      return `${linePrefix}${statementPrefix}${quote}${specifier}${closingQuote}`;
    }
    return `${linePrefix}${statementPrefix}${quote}${to}${closingQuote}`;
  };

  return content.replace(fromStatementPattern, rewrite).replace(bareImportPattern, rewrite);
}

function applySourceAwareRewrites(files: readonly InventoryFile[], plan: RewritePlan): RewritePlan {
  const editByFilePath = new Map(plan.edits.map((edit) => [edit.filePath, edit]));

  const edits = files.flatMap((file) => {
    const existing = editByFilePath.get(file.filePath);
    const before = existing?.before ?? file.content;
    const genericAfter = existing?.after ?? file.content;
    const after = SOURCE_AWARE_RULES.reduce((current, rule) => {
      if (!rule.filePathSuffixes.some((suffix) => file.filePath.endsWith(suffix))) {
        return current;
      }
      return rewriteModuleSpecifier(current, rule.from, rule.to);
    }, genericAfter);

    if (after === before) {
      return [];
    }
    return [{ filePath: file.filePath, before, after }];
  });

  return { edits };
}

export function planExtensionUnificationImportRewrites(files: readonly InventoryFile[]): RewritePlan {
  return applySourceAwareRewrites(files, planImportRewrites(files, buildExtensionUnificationRewriteRules()));
}

function parseCliArgs(argv: readonly string[]): Readonly<{ mode: 'dry-run' | 'write'; rootDir: string; searchRoots: readonly string[] }> {
  let mode: 'dry-run' | 'write' = 'dry-run';
  let rootDir = process.cwd();
  const searchRoots: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      mode = 'dry-run';
      continue;
    }
    if (arg === '--write') {
      mode = 'write';
      continue;
    }
    if (arg === '--root') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --root');
      }
      rootDir = next;
      index += 1;
      continue;
    }
    if (arg === '--scope') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --scope');
      }
      searchRoots.push(next);
      index += 1;
      continue;
    }
    searchRoots.push(arg);
  }

  return {
    mode,
    rootDir,
    searchRoots: searchRoots.length > 0 ? searchRoots : ['apps', 'packages', 'scripts'],
  };
}

function printUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/extensions/rewrite-extension-imports.ts [--dry-run|--write] [--root DIR] [--scope PATH...]',
    '',
    'Rewrites imports for the CLI extension packaging move map. Defaults to dry-run.',
  ].join('\n'));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const files = collectFileInventory({
    rootDir: options.rootDir,
    searchRoots: options.searchRoots,
    include: /\.[cm]?[jt]sx?$/,
  });
  const plan = planExtensionUnificationImportRewrites(files);

  if (options.mode === 'write') {
    const result = applyRewritePlan(options.rootDir, plan);
    console.log(`extension import rewrite: applied ${result.appliedEdits.length} edit(s), skipped ${result.skippedEdits.length}`);
    if (result.skippedEdits.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(`extension import rewrite dry-run: ${plan.edits.length} file(s) would change`);
  for (const edit of plan.edits) {
    console.log(edit.filePath);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
