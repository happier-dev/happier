import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { collectFileInventory } from '../../testing/migrations/lib/collectFileInventory.ts';

import {
  EXTENSION_UNIFICATION_MOVE_MAP,
  collectForbiddenExtensionUnificationFindings,
} from './extension-unification-move-map.ts';
import { collectForbiddenBundledExtensionMigrationFindings } from './validateBundledExtensionMigration.ts';

function parseCliArgs(argv: readonly string[]): Readonly<{ rootDir: string; searchRoots: readonly string[] }> {
  let rootDir = process.cwd();
  const searchRoots: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
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
    rootDir,
    searchRoots: searchRoots.length > 0 ? searchRoots : ['apps', 'packages', 'scripts'],
  };
}

function printUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/plugins/validate-extension-unification.ts [--root DIR] [--scope PATH...]',
    '',
    'Fails when old CLI extension packaging imports or moved source files remain.',
  ].join('\n'));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const files = collectFileInventory({
    rootDir: options.rootDir,
    searchRoots: options.searchRoots,
    include: /\.[cm]?[jt]sx?$/,
  });
  const findings = [
    ...collectForbiddenExtensionUnificationFindings(files),
    ...collectForbiddenBundledExtensionMigrationFindings(files),
  ];
  const staleFiles = EXTENSION_UNIFICATION_MOVE_MAP.filter((entry) => existsSync(`${options.rootDir}/${entry.from}`));

  if (findings.length === 0 && staleFiles.length === 0) {
    console.log('extension unification validation passed');
    return;
  }

  for (const finding of findings) {
    console.error(`${finding.filePath}: forbidden ${finding.pattern}; ${finding.replacement}`);
  }
  for (const staleFile of staleFiles) {
    console.error(`${staleFile.from}: stale moved file remains; use ${staleFile.to}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
