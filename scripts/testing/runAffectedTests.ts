import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
 * owner unit tests whose import graph reaches a changed file (selectGraphUnitTests) are selected. The import graph stops at a
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

const OPTIONS_WITH_VALUES = new Set(['--commit', '--base', '--owners']);

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

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u;

/**
 * Owner unit tests whose import graph reaches a change. The graph is the real one: every test
 * file's imports (static, dynamic and require, read by the TypeScript preprocessor) resolved by
 * the suite's own Vite resolver, aliases and stub plugins included, followed across workspaces
 * and stopping at node_modules. Only resolution runs, no transform, so the whole UI suite fits
 * where a related-mode walk ran out of heap. Inputs the graph cannot place widen to the whole
 * package: the import closures of the config and the setup files every test loads, a removed module,
 * an unread asset.
 */
export async function selectGraphUnitTests(params: Readonly<{
  rootDir: string; workspaceDir: string; config: string; changedFiles: readonly string[];
  /** Every workspace directory: a changed workspace whose built output this suite imports widens it. */
  workspaceDirectories?: readonly string[];
}>): Promise<{ full: true; reason: string } | { full: false; files: string[]; total: number }> {
  const started = Date.now();
  const { default: ts } = await import('typescript');
  const { createVitest } = await import('vitest/node');
  const root = resolve(params.rootDir, params.workspaceDir);
  const configPath = resolve(root, params.config);
  const ownerPrefix = `${params.workspaceDir}/`;
  // Changes in other workspaces reach this suite through the same resolved graph (workspace
  // packages resolve to their sources); only this owner's own non-code inputs widen it.
  const allChanged = params.changedFiles.map(file => file.replaceAll('\\', '/'));
  const own = allChanged.filter(file => file.startsWith(ownerPrefix));
  const changed = allChanged.filter(file => file.startsWith(ownerPrefix) || CODE_FILE.test(file));
  if (changed.length === 0) return { full: false, files: [], total: 0 };
  const toRepo = (file: string) => relative(params.rootDir, file).split(sep).join('/');
  for (const file of own) {
    const path = resolve(params.rootDir, file);
    if (path === configPath || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/u.test(file)) return { full: true, reason: `${file} configures the suite` };
  }
  // A removed module's importers cannot be found from the module itself.
  const removed = changed.find(file => !existsSync(resolve(params.rootDir, file)));
  if (removed) return { full: true, reason: `${removed} was removed` };
  const vitest = await createVitest('test', { root, config: configPath, watch: false, run: true, cliExclude: ['**/._*'] });
  try {
    const specifications = await vitest.globTestSpecifications();
    const importers = new Map<string, Set<string>>();
    const visited = new Set<string>();
    const walk = async (project: (typeof specifications)[number]['project'], entries: readonly string[]) => {
      const queue = entries.filter(entry => !visited.has(entry));
      for (const entry of queue) visited.add(entry);
      while (queue.length) {
        const importer = queue.pop()!;
        if (!CODE_FILE.test(importer)) continue;
        const { importedFiles } = ts.preProcessFile(await readFile(importer, 'utf8'), true, true);
        for (const { fileName } of importedFiles) {
          const resolved = await project.vite.pluginContainer.resolveId(fileName, importer, { ssr: true }).catch(() => null);
          const id = resolved?.id?.split('?')[0];
          if (!id || !isAbsolute(id) || id.includes(`${sep}node_modules${sep}`) || !existsSync(id)) continue;
          const set = importers.get(id) ?? new Set<string>();
          set.add(importer);
          importers.set(id, set);
          if (!visited.has(id)) { visited.add(id); queue.push(id); }
        }
      }
    };
    // Every test is selected, configured and set up through its config and the setup files, so their import
    // closures are one "loaded by every test" set: a change there (shared tooling such as the feature-test
    // gating or worker sizing that only apps/ui/vitest.config.ts imports) runs the whole package.
    const setupFiles = new Set<string>();
    for (const project of vitest.projects) {
      const configs = [...new Set([configPath, project.vite.config.configFile].filter((file): file is string => Boolean(file)))];
      const setup = [...configs, ...project.config.setupFiles.map(file => resolve(project.config.root, file))];
      const before = new Set(visited);
      await walk(project, setup);
      for (const file of visited) if (!before.has(file)) setupFiles.add(file);
    }
    for (const project of vitest.projects) {
      await walk(project, specifications.filter(spec => spec.project === project).map(spec => spec.moduleId));
    }
    // A suite that imports another workspace's built output cannot see that workspace's source edits.
    const visitedRepo = [...visited].map(toRepo);
    for (const file of changed.filter(path => !path.startsWith(ownerPrefix))) {
      const workspace = resolveOwningWorkspaceDirectory(file, params.workspaceDirectories ?? []);
      if (workspace && visitedRepo.some(path => path.startsWith(`${workspace}/`) && path.includes('/dist/'))) {
        return { full: true, reason: `${file} reaches this suite through ${workspace}'s built output` };
      }
    }
    const setupHit = changed.find(file => setupFiles.has(resolve(params.rootDir, file)));
    if (setupHit) return { full: true, reason: `${setupHit} is loaded by every test (config and setup closure: ${setupFiles.size} of ${visited.size} modules)` };
    const unplaced = own.find(file => !visited.has(resolve(params.rootDir, file)) && !CODE_FILE.test(file) && !/\.md$/iu.test(file));
    if (unplaced) return { full: true, reason: `${unplaced} is not in the import graph` };
    const tests = new Set(specifications.map(spec => spec.moduleId));
    const reached = new Set<string>();
    const queue = changed.map(file => resolve(params.rootDir, file));
    while (queue.length) {
      const file = queue.pop()!;
      if (reached.has(file)) continue;
      reached.add(file);
      for (const importer of importers.get(file) ?? []) queue.push(importer);
    }
    const files = [...reached].filter(file => tests.has(file)).map(toRepo).sort();
    process.stderr.write(`[affected] ${params.workspaceDir}: ${files.length} of ${tests.size} unit test file(s) reach the change through ${visited.size} modules (${Math.round((Date.now() - started) / 1000)}s)\n`);
    return { full: false, files, total: tests.size };
  } finally {
    await vitest.close();
  }
}

export async function selectAffectedTests(rootDir: string, changedFiles: readonly string[], options: Readonly<{
  journeysOnly?: boolean;
  unitsOnly?: boolean;
  /** Unit owners to select for (CI: every Gate package); default: the changed files' owners. */
  unitOwners?: readonly string[];
}> = {}) {
  const related = changedFiles.map(file => resolve(rootDir, file)).filter(existsSync);
  // The Gate's unit plan runs beside journey-select, which walks the journeys itself.
  const allJourneys = related.length === 0 || options.unitsOnly ? [] : await selectRelated({ rootDir, workspaceDir: TESTS_DIR, config: 'vitest.core.config.ts', related, include: [
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
  // cliLaunchSpec starts src/index.ts, which dynamically loads cli/bootstrap.
  const sharedProcesses = runtimeChanges.some(file => file === 'apps/cli/src/index.ts' || [
    'apps/cli/src/cli/', 'apps/cli/src/agent/acp/', 'apps/cli/src/daemon/', 'apps/cli/src/session/',
    'apps/server/sources/',
  ].some(prefix => file.startsWith(prefix)));
  for (const preset of STUB_PROVIDER_PRESET_IDS) {
    const fixture = `${TESTS_DIR}/fixtures/cli-backends/${preset}/`;
    const spec = JSON.parse(readFileSync(resolve(rootDir, fixture, 'e2e/providerSpec.json'), 'utf8')) as { traceProvider: string };
    const plugin = `packages/plugins/${spec.traceProvider}/src/agent/`;
    const boundaryReached = sharedProcesses || (preset === 'codex_acp_stub' && changedFiles.some(file => file.startsWith(`${TESTS_DIR}/fixtures/acp-stub-provider/`))) || runtimeChanges.some(file => file.startsWith(plugin) || file.startsWith(fixture));
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
  if (options.journeysOnly) return { journeyFiles, unitFiles: [], fullUnitOwners: [], unitTotals: {}, ...providerSelection };
  const manifests = await discoverWorkspaceManifests(rootDir);
  const unitOwners = new Set(resolveRootUnitCommandOwners(manifests).map(({ owner }) => owner).filter(Boolean));
  const owners = new Set((options.unitOwners ?? changedFiles
    .map(file => resolveOwningWorkspaceDirectory(file, manifests.map(manifest => manifest.workspaceDirectory))))
    .filter((owner): owner is string => owner !== null && owner !== TESTS_DIR && unitOwners.has(owner)));
  const unitFiles: string[] = [];
  const fullUnitOwners: { owner: string; reason: string }[] = [];
  const unitTotals: Record<string, number> = {};
  for (const owner of [...owners].sort()) {
    const config = VITEST_CONFIG_NAMES.find(name => existsSync(resolve(rootDir, owner, name)));
    if (!config) continue;
    const selection = await selectGraphUnitTests({ rootDir, workspaceDir: owner, config, changedFiles,
      workspaceDirectories: manifests.map(manifest => manifest.workspaceDirectory) });
    if (selection.full) fullUnitOwners.push({ owner, reason: selection.reason });
    else {
      unitFiles.push(...selection.files);
      unitTotals[owner] = selection.total;
    }
  }
  return { journeyFiles, unitFiles, fullUnitOwners, unitTotals, ...providerSelection };
}

export async function runAffectedTests(args: readonly string[], rootDir = process.cwd()): Promise<void> {
  const changedFiles = readChangedFiles(rootDir, args);
  if (changedFiles.length === 0 && !args.includes('--base')) {
    throw new Error('Usage: pnpm test:affected -- <changed file>... | --commit <sha> | --base <ref> [--journeys | --units] [--list | --plan]');
  }
  if (args.includes('--units')) {
    // CI unit gate: one JSON line, per unit owner either its selected files or the whole package.
    const requested = readOption(args, '--owners');
    const selection = await selectAffectedTests(rootDir, changedFiles,
      { unitsOnly: true, ...(requested ? { unitOwners: requested.split(',').filter(Boolean) } : {}) });
    const owners: Record<string, { full: true; reason: string } | { full: false; files: string[]; total: number }> = {};
    for (const { owner, reason } of selection.fullUnitOwners) owners[owner] = { full: true, reason };
    for (const [owner, total] of Object.entries(selection.unitTotals)) owners[owner] = { full: false, files: [], total };
    const directories = (await discoverWorkspaceManifests(rootDir)).map(manifest => manifest.workspaceDirectory);
    for (const file of selection.unitFiles) {
      const entry = owners[resolveOwningWorkspaceDirectory(file, directories)!];
      if (entry && !entry.full) entry.files.push(file);
    }
    process.stdout.write(`${JSON.stringify({ units: owners })}\n`);
    return;
  }
  const selection = await selectAffectedTests(rootDir, changedFiles, { journeysOnly: args.includes('--journeys') });
  for (const { owner, reason } of selection.fullUnitOwners) {
    process.stdout.write(`[affected] ${owner}: whole package needed (${reason}); run its test:unit\n`);
  }
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
