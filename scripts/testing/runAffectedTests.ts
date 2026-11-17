import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import { discoverWorkspaceManifests, resolveOwningWorkspaceDirectory } from './lib/workspaceManifests.ts';
import { resolveRootUnitCommandOwners, runRootTests } from './runRootTests.ts';

/**
 * `pnpm test:affected`: the tests that reach a change, selected by Vitest's own related mode
 * (the import graph of every test file), run through each suite's existing runner.
 *
 * Journey tests (packages/tests: contracts, core-layer, core-e2e fast and slow, ui-e2e) and the
 * owner unit tests in the changed files' folders are selected. The import graph stops at a
 * process boundary: code a test reaches only through a spawned server, daemon or browser is not
 * selected here; the nightly full run covers it.
 */

const TESTS_DIR = 'packages/tests';
const UI_E2E_PREFIX = `${TESTS_DIR}/suites/ui-e2e/`;
const SLOW_SUFFIX = '.slow.e2e.test.ts';
const VITEST_CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.mjs', 'vitest.config.js'];

type AffectedCommand = CommandSuiteEntry & { rootUnitFiles?: readonly string[] };

function toTestsRelative(file: string): string {
  return file.slice(TESTS_DIR.length + 1);
}

/** Repo-relative selected files → one command per owning suite runner. */
export function planAffectedTestCommands(selection: Readonly<{
  journeyFiles: readonly string[];
  unitFiles: readonly string[];
}>): AffectedCommand[] {
  const journey = [...new Set(selection.journeyFiles)].sort();
  const ui = journey.filter(file => file.startsWith(UI_E2E_PREFIX));
  const slow = journey.filter(file => !file.startsWith(UI_E2E_PREFIX) && file.endsWith(SLOW_SUFFIX));
  const fast = journey.filter(file => !ui.includes(file) && !slow.includes(file));
  const commands: AffectedCommand[] = [];
  if (fast.length) commands.push({ id: 'core-e2e fast',
    args: ['--dir', TESTS_DIR, 'run', 'test:core:fast', ...fast.map(toTestsRelative)] });
  if (slow.length) commands.push({ id: 'core-e2e slow', args: ['--dir', TESTS_DIR, 'exec', 'node',
    'scripts/run-vitest-with-heartbeat.mjs', '--config', 'vitest.core.slow.config.ts', ...slow.map(toTestsRelative)] });
  if (ui.length) commands.push({ id: 'ui-e2e', args: ['--dir', TESTS_DIR, 'run', 'test:ui:e2e', ...ui.map(toTestsRelative)] });
  if (selection.unitFiles.length) commands.push({ id: 'owner unit', rootUnitFiles: [...selection.unitFiles].sort(), args: [] });
  return commands;
}

const OPTIONS_WITH_VALUES = new Set(['--commit', '--base']);

function readOption(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/** Explicit files (a lane's own edits in a shared tree), one commit, or every commit since a base. */
function readChangedFiles(rootDir: string, args: readonly string[]): string[] {
  const git = (gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean);
  const commit = readOption(args, '--commit');
  if (commit) return git(['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '--root', commit]);
  const base = readOption(args, '--base');
  if (base) return git(['diff', '--no-renames', '--name-only', base, 'HEAD']);
  return args.filter((arg, index) => !arg.startsWith('--') && !OPTIONS_WITH_VALUES.has(args[index - 1] ?? ''));
}

/** Vitest's related mode over one config; returns repo-relative test files. */
async function selectRelated(params: Readonly<{
  rootDir: string; workspaceDir: string; config: string; related: readonly string[]; include?: readonly string[];
  /** Absolute directory filters bounding which test files' graphs are walked. */
  filters?: readonly string[];
}>): Promise<string[]> {
  const started = Date.now();
  const { createVitest } = await import('vitest/node');
  const root = resolve(params.rootDir, params.workspaceDir);
  const vitest = await createVitest('test', {
    root, config: resolve(root, params.config), related: [...params.related], watch: false, run: true,
    // macOS AppleDouble metadata (`._name.test.ts`) copied into a tree is not a test; one such file
    // must not abort the whole graph walk. The suite runners report it themselves.
    cliExclude: ['**/._*'],
    ...(params.include ? { include: [...params.include] } : {}),
  });
  try {
    // One related walk per test file, so a file that cannot be transformed (another lane's
    // mid-edit in the shared tree, a copied non-source file) fails only the walks through it.
    // Those tests are reported, not run: selecting every importer of one broken module ran 147
    // files instead of 9 for one server file (2026-11-16). The nightly full run still covers them.
    const candidates = await vitest.globTestSpecifications([...(params.filters ?? [])]);
    const selected = new Set<string>();
    const unreadable = new Map<string, number>();
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < candidates.length) {
        const { moduleId } = candidates[next++];
        try {
          if ((await vitest.getRelevantTestSpecifications([moduleId])).some(spec => spec.moduleId === moduleId)) selected.add(moduleId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const broken = /^(\/[^\s:]+):\d+:\d+: ERROR/mu.exec(message)?.[1] ?? message.split('\n')[0];
          unreadable.set(broken, (unreadable.get(broken) ?? 0) + 1);
        }
      }
    }));
    for (const [broken, count] of unreadable) {
      process.stderr.write(`[affected] not selected: ${count} test file(s) import ${relative(params.rootDir, broken) || broken}, which does not transform\n`);
    }
    process.stderr.write(`[affected] ${params.workspaceDir}: ${selected.size} of ${candidates.length} test file(s) reach the change (${Math.round((Date.now() - started) / 1000)}s)\n`);
    return [...selected].map(moduleId => relative(params.rootDir, moduleId).split(sep).join('/')).sort();
  } finally {
    await vitest.close();
  }
}

export async function selectAffectedTests(rootDir: string, changedFiles: readonly string[], options: Readonly<{ journeysOnly?: boolean }> = {}) {
  const related = changedFiles.map(file => resolve(rootDir, file)).filter(existsSync);
  if (related.length === 0) return { journeyFiles: [], unitFiles: [] };
  const journeyFiles = await selectRelated({ rootDir, workspaceDir: TESTS_DIR, config: 'vitest.core.config.ts', related, include: [
    'suites/contracts/**/*.test.ts', 'suites/core-layer/**/*.test.ts', 'suites/core-e2e/**/*.test.ts',
    'suites/runtime-unification/**/*.test.ts', 'src/testkit/**/*.{test,spec}.ts', 'suites/ui-e2e/**/*.spec.ts',
  ] });
  if (options.journeysOnly) return { journeyFiles, unitFiles: [] };
  const manifests = await discoverWorkspaceManifests(rootDir);
  const unitOwners = new Set(resolveRootUnitCommandOwners(manifests).map(({ owner }) => owner).filter(Boolean));
  const owners = new Set(changedFiles
    .map(file => resolveOwningWorkspaceDirectory(file, manifests.map(manifest => manifest.workspaceDirectory)))
    .filter((owner): owner is string => owner !== null && owner !== TESTS_DIR && unitOwners.has(owner)));
  const unitFiles: string[] = [];
  for (const owner of [...owners].sort()) {
    const config = VITEST_CONFIG_NAMES.find(name => existsSync(resolve(rootDir, owner, name)));
    if (!config) continue;
    // Owner tests sit beside their owner: walk only the changed files' own folders. A whole
    // UI or CLI package graph walk (thousands of test files) ran out of a 4 GiB heap.
    const filters = [...new Set(changedFiles
      .filter(file => file.startsWith(`${owner}/`))
      .map(file => `${dirname(resolve(rootDir, file))}${sep}`))];
    unitFiles.push(...await selectRelated({ rootDir, workspaceDir: owner, config, related, filters }));
  }
  return { journeyFiles, unitFiles };
}

export async function runAffectedTests(args: readonly string[], rootDir = process.cwd()): Promise<void> {
  const changedFiles = readChangedFiles(rootDir, args);
  if (changedFiles.length === 0 && !args.includes('--base')) {
    throw new Error('Usage: pnpm test:affected -- <changed file>... | --commit <sha> | --base <ref> [--journeys] [--list | --plan]');
  }
  const selection = await selectAffectedTests(rootDir, changedFiles, { journeysOnly: args.includes('--journeys') });
  if (args.includes('--plan')) {
    // CI: one JSON line for the journey jobs; UI specs come pre-sharded by the UI shard owner.
    const { listUiE2eSpecs, planSelectedUiE2eShards } = await import('../ci/select-ui-e2e-shard.mjs');
    const ui = selection.journeyFiles.filter(file => file.startsWith(UI_E2E_PREFIX));
    const core = selection.journeyFiles.filter(file => !ui.includes(file)).sort();
    process.stdout.write(`${JSON.stringify({
      coreFast: core.filter(file => !file.endsWith(SLOW_SUFFIX)),
      coreSlow: core.filter(file => file.endsWith(SLOW_SUFFIX)),
      uiShards: planSelectedUiE2eShards({ selected: ui, all: listUiE2eSpecs(rootDir) }),
    })}\n`);
    return;
  }
  const commands = planAffectedTestCommands(selection);
  for (const command of commands) {
    const files = command.rootUnitFiles ?? command.args.filter(arg => /\.(?:test|spec)\.ts$/u.test(arg));
    process.stdout.write(`[affected] ${command.id}: ${files.length} file(s)\n`);
  }
  if (commands.length === 0) {
    process.stdout.write('[affected] no test reaches these files through imports\n');
    return;
  }
  if (args.includes('--list')) {
    for (const command of commands) process.stdout.write(`${command.id}\n  ${(command.rootUnitFiles ?? command.args).join('\n  ')}\n`);
    return;
  }
  // Journeys start the CLI from source, as dev stacks do, unless the caller chose: a CLI dist
  // rebuild in the e2e global setup waited 47 min for package-dist admission on nl1 and then
  // failed (2026-11-16 baseline).
  const env = { ...process.env, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT ?? '1' };
  await runCommandSuite<AffectedCommand>({
    commands,
    suiteName: 'Affected tests',
    runCommand: command => command.rootUnitFiles
      ? runRootTests('unit', command.rootUnitFiles, rootDir)
      : runPnpmCommand(command, rootDir, env),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runAffectedTests(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
