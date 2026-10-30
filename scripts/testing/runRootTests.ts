import { stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import { selectSharedPackageTestCommands } from './runSharedPackageTests.ts';
import { resolveGatePackageForWorkspaceDirectory } from '../ci/selectAffectedGatePackages.mjs';
import { discoverWorkspaceManifests, resolveOwningWorkspaceDirectory } from './lib/workspaceManifests.ts';
import { discoverPluginWorkspaceTestPackageReport } from './lib/pluginWorkspaceTestPackages.ts';

export const ROOT_TEST_COMMANDS = {
  unit: [
    ...selectSharedPackageTestCommands('local'),
    { id: '@happier-dev/plugin-sdk', args: ['--filter', '@happier-dev/plugin-sdk', '--silent', 'run', 'test'] },
    { id: '@happier-dev/plugin-ui', args: ['--filter', '@happier-dev/plugin-ui', '--silent', 'run', 'test'] },
    { id: '@happier-dev/sdk', args: ['--filter', '@happier-dev/sdk', '--silent', 'run', 'test'] },
    { id: '@happier-dev/app', args: ['--filter', '@happier-dev/app', '--silent', 'run', 'test'] },
    { id: '@happier-dev/cli', args: ['--filter', '@happier-dev/cli', '--silent', 'run', 'test:unit'] },
    { id: 'apps/server', args: ['--dir', 'apps/server', '--silent', 'run', 'test:unit'] },
    { id: 'apps/stack', args: ['--dir', 'apps/stack', '--silent', 'run', 'test:unit'] },
  ],
  integration: [
    { id: '@happier-dev/app', args: ['--filter', '@happier-dev/app', '--silent', 'run', 'test:integration'] },
    { id: '@happier-dev/cli', args: ['--filter', '@happier-dev/cli', '--silent', 'run', 'test:integration'] },
    { id: 'apps/server', args: ['--dir', 'apps/server', '--silent', 'run', 'test:integration'] },
    { id: 'apps/stack', args: ['--dir', 'apps/stack', '--silent', 'run', 'test:integration'] },
  ],
} as const satisfies Record<string, readonly CommandSuiteEntry[]>;

/** The root lane whose workspaces come from run-time package labels instead of a fixed inventory. */
const GATE_UNIT_LANE = 'gate-unit';

/**
 * The fixed command inventory a root test lane runs, read by the lane runner and by the wiring
 * reader alike so a new lane cannot reach one without the other. The Gate lane has none: its
 * workspace set is chosen by the package labels its caller passes.
 */
export function resolveFixedRootTestCommands(lane: string | undefined): readonly CommandSuiteEntry[] {
  if (lane === 'unit' || lane === 'integration') return ROOT_TEST_COMMANDS[lane];
  if (lane === GATE_UNIT_LANE) return [];
  throw new Error(`Unsupported root test lane: ${lane ?? '<missing>'}`);
}

async function selectUnitFileCommands(files: readonly string[], rootDir: string): Promise<readonly CommandSuiteEntry[]> {
  const manifests = await discoverWorkspaceManifests(rootDir);
  const commands = ROOT_TEST_COMMANDS.unit.map(command => {
    const [selector, workspace] = command.args;
    return { command, owner: manifests.find(manifest => selector === '--dir'
      ? manifest.workspaceDirectory === workspace : manifest.packageName === workspace)?.workspaceDirectory };
  });
  const selected = new Map<string, Set<string>>();
  // Validate the complete request before dispatching: a typo must never widen a focused run.
  for (const file of files) {
    const path = resolve(rootDir, file);
    const repoPath = relative(resolve(rootDir), path).split(sep).join('/');
    const owner = resolveOwningWorkspaceDirectory(repoPath, manifests.map(manifest => manifest.workspaceDirectory));
    if (!file || file.startsWith('-') || !owner || !commands.some(entry => entry.owner === owner)
      || !(await stat(path)).isFile()) {
      throw new Error(`Not a file in a root unit-test workspace: ${file}`);
    }
    const selection = selected.get(owner) ?? new Set<string>();
    selection.add(relative(resolve(rootDir, owner), path));
    selected.set(owner, selection);
  }
  return commands.flatMap(({ command, owner }) => {
    const selection = owner ? selected.get(owner) : undefined;
    if (!selection) return [];
    // Keep the selected workspace's build/check prerequisites in their established order.
    const script = command.args[command.args.length - 1];
    return [{ ...command, args: script.startsWith('test') ? [...command.args, ...selection] : command.args }];
  });
}

export async function runRootTests(lane: string, args: readonly string[] = [], rootDir = process.cwd()): Promise<void> {
  if (lane === GATE_UNIT_LANE) {
    const separator = args.indexOf('--');
    const selectionArgs = separator < 0 ? args : args.slice(0, separator);
    const packages = selectionArgs.filter((arg) => !arg.startsWith('--filter='));
    const filters = [
      ...selectionArgs.filter((arg) => arg.startsWith('--filter=')).map((arg) => arg.slice('--filter='.length)),
      ...(separator < 0 ? [] : args.slice(separator + 1)),
    ];
    if (filters.some((filter) => !filter)) throw new Error('Gate unit file filters must not be empty.');
    if (packages.length === 0) throw new Error('Gate unit requires selected package labels.');
    const manifests = await discoverWorkspaceManifests(rootDir);
    const available = new Set<string>(manifests.map((workspace) => resolveGatePackageForWorkspaceDirectory(workspace.workspaceDirectory)).filter((label) => label !== null && label !== 'ui'));
    for (const label of packages) {
      if (!available.has(label)) throw new Error(`Unsupported Gate unit package ${label}.`);
    }
    if (packages.includes('plugins')) {
      const report = await discoverPluginWorkspaceTestPackageReport(rootDir);
      if (report.issues.length > 0) throw new Error(`Plugin workspace test selection failed:\n${report.issues.join('\n')}`);
    }
    const selected = new Set(packages);
    const { runWorkspaceUnitProjects } = await import('./runWorkspaceUnitProjects.ts');
    await runWorkspaceUnitProjects({ rootDir, filters, workspaces: manifests.filter((workspace) => {
      const label = resolveGatePackageForWorkspaceDirectory(workspace.workspaceDirectory);
      return label !== null && selected.has(label);
    }) });
    return;
  }
  const files = args[0] === '--' ? args.slice(1) : args;
  const commands = lane === 'unit' && files.length > 0
    ? await selectUnitFileCommands(files, rootDir) : resolveFixedRootTestCommands(lane);
  await runCommandSuite<CommandSuiteEntry>({
    commands,
    suiteName: `Root ${lane} test suite`,
    runCommand: (command) => runPnpmCommand(command, rootDir),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRootTests(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
