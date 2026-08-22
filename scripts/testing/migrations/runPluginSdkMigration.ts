import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runPluginSdkMigration,
  type PluginSdkMigrationRunResult,
} from './lib/pluginSdkMigration.ts';

export interface PluginSdkMigrationCliOptions {
  rootDir: string;
  mapPath?: string;
  outputPath?: string;
  write: boolean;
}

export interface PluginSdkMigrationReport {
  schemaVersion: 1;
  mode: 'dry-run' | 'write';
  ok: boolean;
  rootDir: string;
  mapPath: string;
  scope: {
    searchRoots: readonly string[];
    filesScanned: number;
    candidateFilesScanned: number;
  };
  summary: {
    mapRowsByAction: PluginSdkMigrationRunResult['adaptedMap']['actionCounts'];
    rewriteRows: number;
    additions: number;
    nonInputs: number;
    mapRefusals: number;
    matchedBindings: number;
    declarationRefusals: number;
    fileEdits: number;
    declarationEdits: number;
    appliedFileEdits: number;
    skippedFileEdits: number;
    secondDryRunFileEdits: number | null;
    idempotent: boolean | null;
  };
  editPlan: readonly {
    filePath: string;
  }[];
  declarationEdits: PluginSdkMigrationRunResult['plan']['declarationEdits'];
  matches: PluginSdkMigrationRunResult['plan']['matches'];
  refusals: {
    map: PluginSdkMigrationRunResult['adaptedMap']['mapRefusals'];
    declarations: PluginSdkMigrationRunResult['plan']['refusals'];
  };
  applyResult: PluginSdkMigrationRunResult['applyResult'];
  secondDryRun: null | {
    fileEdits: number;
    declarationEdits: number;
    refusals: number;
  };
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePluginSdkMigrationCliArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): PluginSdkMigrationCliOptions {
  let rootDir = cwd;
  let mapPath: string | undefined;
  let outputPath: string | undefined;
  let write = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--write') {
      write = true;
      continue;
    }
    if (argument === '--root') {
      rootDir = resolve(cwd, readValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--map') {
      mapPath = resolve(cwd, readValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--output') {
      outputPath = resolve(cwd, readValue(args, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`Unknown Plugin SDK migration argument: ${argument}`);
  }

  return {
    rootDir,
    ...(mapPath === undefined ? {} : { mapPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    write,
  };
}

export function formatPluginSdkMigrationReport(
  result: PluginSdkMigrationRunResult,
): PluginSdkMigrationReport {
  return {
    schemaVersion: 1,
    mode: result.mode,
    ok: result.ok,
    rootDir: result.rootDir,
    mapPath: result.mapPath,
    scope: {
      searchRoots: result.searchRoots,
      filesScanned: result.filesScanned,
      candidateFilesScanned: result.candidateFilesScanned,
    },
    summary: {
      mapRowsByAction: result.adaptedMap.actionCounts,
      rewriteRows: result.adaptedMap.rewriteRows.length,
      additions: result.adaptedMap.additions.length,
      nonInputs: result.adaptedMap.nonInputs.length,
      mapRefusals: result.adaptedMap.mapRefusals.length,
      matchedBindings: result.plan.matches.length,
      declarationRefusals: result.plan.refusals.length,
      fileEdits: result.plan.edits.length,
      declarationEdits: result.plan.declarationEdits.length,
      appliedFileEdits: result.applyResult?.appliedEdits.length ?? 0,
      skippedFileEdits: result.applyResult?.skippedEdits.length ?? 0,
      secondDryRunFileEdits: result.secondDryRun?.edits.length ?? null,
      idempotent: result.idempotent,
    },
    editPlan: result.plan.edits.map(({ filePath }) => ({ filePath })),
    declarationEdits: result.plan.declarationEdits,
    matches: result.plan.matches,
    refusals: {
      map: result.adaptedMap.mapRefusals,
      declarations: result.plan.refusals,
    },
    applyResult: result.applyResult,
    secondDryRun: result.secondDryRun === null
      ? null
      : {
          fileEdits: result.secondDryRun.edits.length,
          declarationEdits: result.secondDryRun.declarationEdits.length,
          refusals: result.secondDryRun.refusals.length,
        },
  };
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const options = parsePluginSdkMigrationCliArgs(args);
  const result = runPluginSdkMigration(options);
  const serialized = `${JSON.stringify(formatPluginSdkMigrationReport(result), null, 2)}\n`;
  if (options.outputPath) {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
