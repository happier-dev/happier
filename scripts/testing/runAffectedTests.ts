import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { STUB_PROVIDER_PRESET_IDS, resolveProviderRunPreset } from '../../packages/tests/src/testkit/providers/presets/presets.mjs';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import { discoverWorkspaceManifests, resolveOwningWorkspaceDirectory } from './lib/workspaceManifests.ts';
import { resolveRootUnitCommandOwners, runRootTests } from './runRootTests.ts';

/**
 * `pnpm test:affected`: the tests that reach a change, selected by Vitest's own related mode
 * (the import graph of every test file), run through each suite's existing runner.
 *
 * Journey tests (packages/tests: contracts, core-layer, core-e2e fast and slow, ui-e2e, agents) and the
 * owner unit tests in the changed files' folders are selected. The import graph stops at a
 * process boundary: code a test reaches only through a spawned server, daemon or browser is not
 * selected here except for the documented stub subprocess bridges below; the nightly full run covers the rest.
 */

const TESTS_DIR = 'packages/tests';
const UI_E2E_PREFIX = `${TESTS_DIR}/suites/ui-e2e/`;
const AGENT_PREFIX = `${TESTS_DIR}/suites/agents/`;
const MATRIX_FILE = `${AGENT_PREFIX}provider.matrix.test.ts`;
type ProviderMatrixEntry = { preset: string; tier: 'smoke' | 'extended'; scenarios: string[] };

const SLOW_SUFFIX = '.slow.e2e.test.ts';
const VITEST_CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.mjs', 'vitest.config.js'];

type AffectedCommand = CommandSuiteEntry & { env?: Record<string, string>; rootUnitFiles?: readonly string[] };

function toTestsRelative(file: string): string {
  return file.slice(TESTS_DIR.length + 1);
}

/** Repo-relative selected files → one command per owning suite runner. */
export function planAffectedTestCommands(selection: Readonly<{
  journeyFiles: readonly string[];
  unitFiles: readonly string[];
  agentFiles?: readonly string[];
  providerMatrix?: readonly ProviderMatrixEntry[];
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
  if (selection.agentFiles?.length) commands.push({ id: 'agents', args: ['--dir', TESTS_DIR, 'run', 'test:agents', ...selection.agentFiles.map(toTestsRelative)], env: resolveProviderRunPreset('codex_acp_stub', 'smoke')!.env });
  for (const entry of selection.providerMatrix ?? []) commands.push({
    id: `providers:${entry.preset}:${entry.tier}`,
    args: ['--dir', TESTS_DIR, 'run', 'test:agents', toTestsRelative(MATRIX_FILE)],
    env: { ...resolveProviderRunPreset(entry.preset, entry.tier)!.env, HAPPIER_E2E_PROVIDER_SCENARIOS: entry.scenarios.join(',') },
  });
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
  const allJourneys = related.length === 0 ? [] : await selectRelated({ rootDir, workspaceDir: TESTS_DIR, config: 'vitest.core.config.ts', related, include: [
    'suites/contracts/**/*.test.ts', 'suites/core-layer/**/*.test.ts', 'suites/core-e2e/**/*.test.ts',
    'suites/runtime-unification/**/*.test.ts', 'src/testkit/**/*.{test,spec}.ts', 'suites/ui-e2e/**/*.spec.ts', 'suites/agents/**/*.test.ts',
  ] });
  const journeyFiles = allJourneys.filter(file => !file.startsWith(AGENT_PREFIX));
  const agentRelated = allJourneys.filter(file => file.startsWith(AGENT_PREFIX));
  const agentFiles = new Set(agentRelated.filter(file => file !== MATRIX_FILE));
  const providerMatrix: ProviderMatrixEntry[] = [];
  // These fixtures spawn the CLI, so Vitest cannot see the backend's imports. The fixture
  // spec owns the subcommand/traceProvider and the registry owns its scenario IDs and tier.
  // Restrict this bridge to the two existing no-credential ACP fixtures; vendor lanes stay opt-in.
  // The matrix starts a server and CLI/daemon processes; these shared owners are
  // loaded in those children, not imported by the test process.
  const runtimeChanges = changedFiles.filter(file => !/\.(test|spec)\.[cm]?[jt]sx?$/u.test(file));
  const sharedAcp = runtimeChanges.some(file => [
    'apps/cli/src/agent/acp/', 'apps/cli/src/daemon/', 'apps/cli/src/session/',
    'apps/server/sources/',
  ].some(prefix => file.startsWith(prefix)));
  for (const preset of STUB_PROVIDER_PRESET_IDS) {
    const fixture = `${TESTS_DIR}/fixtures/cli-backends/${preset}/`;
    const spec = JSON.parse(readFileSync(resolve(rootDir, fixture, 'e2e/providerSpec.json'), 'utf8')) as { traceProvider: string };
    const plugin = `packages/plugins/${spec.traceProvider}/src/agent/`;
    const boundaryReached = sharedAcp || (preset === 'codex_acp_stub' && changedFiles.some(file => file.startsWith(`${TESTS_DIR}/fixtures/acp-stub-provider/`))) || runtimeChanges.some(file => file.startsWith(plugin) || file.startsWith(fixture));
    if (!boundaryReached && !agentRelated.includes(MATRIX_FILE)) continue;
    const registry = JSON.parse(readFileSync(resolve(rootDir, fixture, 'e2e/providerScenarios.json'), 'utf8')) as { tiers: Record<'smoke' | 'extended', string[]> };
    for (const tier of ['smoke', 'extended'] as const) {
      if (registry.tiers[tier].length) providerMatrix.push({ preset, tier, scenarios: registry.tiers[tier] });
    }
    // These two composed tests launch the Codex stub's CLI rather than importing its backend.
    if (boundaryReached && preset === 'codex_acp_stub') {
      agentFiles.add(`${AGENT_PREFIX}harness.tokenTelemetry.acpStub.e2e.test.ts`);
      agentFiles.add(`${AGENT_PREFIX}harness.inFlightSteer.acpStub.e2e.test.ts`);
    }
  }
  // The SDK lifecycle test starts this executable by path, outside the import graph.
  if (changedFiles.some(file => file.startsWith(`${TESTS_DIR}/fixtures/acp-stub-provider/`))) {
    agentFiles.add(`${AGENT_PREFIX}acpStubProvider.lifecycle.test.ts`);
  }
  const providerSelection = { agentFiles: [...agentFiles].sort(), providerMatrix };
  if (options.journeysOnly) return { journeyFiles, unitFiles: [], ...providerSelection };
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
  return { journeyFiles, unitFiles, ...providerSelection };
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
      agentFiles: selection.agentFiles,
      providerMatrix: selection.providerMatrix,
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
      : runPnpmCommand(command, rootDir, { ...env, ...command.env }),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runAffectedTests(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
