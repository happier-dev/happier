import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPublicSurfaceProgram,
  projectEntrypointExportRows,
  projectPublicDeclarationReport,
} from '../../plugin-sdk/scripts/publicDeclarationReport.mjs';

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = 'api-declarations.md';
const REPORT_TITLE = 'Plugin UI public declaration report';
const TYPES_CONDITION_TARGET = /^\.\/dist\/(?<base>[A-Za-z0-9][A-Za-z0-9._/-]*)\.d\.ts$/u;

export function parsePublicDeclarationReportCliArgs(args, cwd = process.cwd()) {
  let packageRoot = DEFAULT_PACKAGE_ROOT;
  let write = false;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--write') {
      write = true;
      continue;
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--package-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--package-root requires a value');
      packageRoot = resolve(cwd, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown Plugin UI declaration report argument: ${argument}`);
  }
  if (write && check) throw new Error('--write and --check are mutually exclusive');
  return Object.freeze({ packageRoot, write, check });
}

/**
 * The package's own `exports` map is the published entrypoint set, and each
 * `types` condition names the barrel that produced it. Reading the entrypoints
 * back out of `exports` keeps one declaration of what this package publishes.
 */
export function readPublishedEntrypoints(packageJson) {
  const packageExports = packageJson?.exports;
  if (!packageExports || typeof packageExports !== 'object' || Array.isArray(packageExports)) {
    throw new Error('Plugin UI package.json must declare an exports object');
  }
  return Object.freeze(Object.entries(packageExports).flatMap(([specifier, conditions]) => {
    // A direct file target (the conventional `"./package.json": "./package.json"`)
    // publishes no TypeScript surface, so it has nothing to record.
    if (typeof conditions === 'string') return [];
    const base = TYPES_CONDITION_TARGET.exec(conditions?.types ?? '')?.groups?.base;
    if (base === undefined) {
      throw new Error(`Plugin UI export ${specifier} must declare a ./dist/*.d.ts types condition`);
    }
    return [Object.freeze({ specifier, sourceModule: `src/${base}.ts` })];
  }).sort((left, right) => (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0)));
}

export async function runPublicDeclarationReportCli(options) {
  const packageRoot = resolve(options.packageRoot);
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const entrypoints = readPublishedEntrypoints(packageJson);
  const program = createPublicSurfaceProgram(
    entrypoints.map((entrypoint) => resolve(packageRoot, entrypoint.sourceModule)),
  );
  const contents = projectPublicDeclarationReport({
    program,
    packageRoot,
    title: REPORT_TITLE,
    rows: projectEntrypointExportRows({ program, packageRoot, entrypoints }),
    bundledDependencies: packageJson.bundledDependencies ?? [],
  });
  const reportPath = join(packageRoot, REPORT_PATH);
  const current = await readFile(reportPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const changed = current !== contents;
  if (options.write && changed) await writeFile(reportPath, contents, 'utf8');
  return Object.freeze({
    mode: options.write ? 'write' : options.check ? 'check' : 'dry-run',
    status: options.write || !changed ? 'current' : 'drift',
    path: REPORT_PATH,
    changed,
    written: options.write && changed,
  });
}

export function renderPublicDeclarationReportSummary(report) {
  return [
    `api-declarations ${report.mode}: ${report.status} (changed=${report.changed ? 1 : 0} written=${report.written ? 1 : 0})`,
    ...(report.changed ? [`  ${report.written ? 'wrote' : 'drift'} publicDeclarationReport ${report.path}`] : []),
    '',
  ].join('\n');
}

export async function main(args = process.argv.slice(2)) {
  const options = parsePublicDeclarationReportCliArgs(args);
  const report = await runPublicDeclarationReportCli(options);
  process.stdout.write(renderPublicDeclarationReportSummary(report));
  if (options.check && report.changed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
