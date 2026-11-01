import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFakeBin } from './fake_bin_harness.mjs';
import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';

const sourceRoot = resolve(import.meta.dirname, '../../../../..');

/** Keep the selected checkout's real setup implementation, with dependency
 * endpoints forwarded to this source tree. The trace observes Node's module
 * loading boundary; native staging and readiness logic are not replaced.
 */
export async function installCliNativeCustodySourceFixture(repoDir) {
  const setupSource = join(sourceRoot, 'apps/cli/src/test-setup.ts');
  const setupTarget = join(repoDir, 'apps/cli/src/test-setup.ts');
  const runtimeTarget = join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs');
  const tracePath = join(repoDir, 'native-source-loads.jsonl');
  await Promise.all([mkdir(join(repoDir, 'apps/cli/src'), { recursive: true }),
    mkdir(join(repoDir, 'packages/cli-common'), { recursive: true })]);
  const manifestPath = join(repoDir, 'apps/cli/package.json');
  const manifest = await readFile(manifestPath, 'utf8').then(value => JSON.parse(value)).catch(error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  const { type, happierSourceTestTools } = JSON.parse(await readFile(join(sourceRoot, 'apps/cli/package.json'), 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, type, happierSourceTestTools }));
  const source = await readFile(setupSource, 'utf8');
  await writeFile(setupTarget, source.replace(/from '(\.[^']+)'/gu,
    (_match, specifier) => `from '${new URL(specifier, pathToFileURL(setupSource)).href}'`));
  const hook = `import { appendFileSync } from 'node:fs';
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith('/test-setup.ts')) appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(url) + '\\n');
  return result;
}`;
  await writeFile(runtimeTarget, `import ${JSON.stringify(pathToFileURL(join(sourceRoot, 'packages/cli-common/registerSourceRuntime.mjs')).href)};
import { register } from 'node:module';
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(import.meta.url) + '\\n');
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);
`);
  return { setupTarget, runtimeTarget, tracePath };
}

/** A simulated physical worker cannot inherit the runner's custody or CPU budget.
 * Layer intentional fixture worker settings onto the returned environment.
 */
export function buildNativeAdmissionFixtureEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')
    && !key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')
    && !['HAPPIER_BUILD_DEPENDENCY_CUSTODY', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS',
      'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS', 'HAPPIER_VITEST_GOVERNOR_MAX_WORKERS',
      'HAPPIER_VITEST_MAX_WORKERS', 'VITEST_UI_MAX_FORKS', 'GOMAXPROCS'].includes(key)));
}

/** Remap only the fixed OS-state filesystem boundary, never a production flag.
 * Real admission, kernel identity, locking and class policy remain unchanged.
 */
export async function installNativeAdmissionFixture({ root, admissionRoot = join(root, 'host-admission'), observedPidsPath = null, prepareDependencies = false,
  launcherSourcePath = join(sourceRoot, 'apps/stack/bin/hstack-exec'),
  commandPolicySourcePath = join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_commands.mjs') }) {
  const checkout = join(root, 'native-owner');
  const bin = join(checkout, 'apps/stack/bin');
  const proc = join(checkout, 'apps/stack/scripts/utils/proc');
  const targets = join(checkout, 'apps/stack/scripts/utils/dev_targets');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(proc, { recursive: true }), mkdir(targets, { recursive: true })]);
  // This is physical filesystem input, not an installed SDK or readiness fact.
  // The real disk owner measures these owned bytes with du/df; without any
  // dependency footprint it rejects before the CPU/memory contract is reached.
  const footprint = join(checkout, 'node_modules');
  await mkdir(footprint, { recursive: true });
  await writeFile(join(footprint, 'native-admission-disk-input.fixture'),
    'Owned filesystem bytes for native admission resource observations only.\n');
  // npm's registry/archive process and the installed pnpm executable are external
  // boundaries. Keep setup-pnpm's pin parsing, archive verification and readiness
  // checks real, without network access or a global package installation.
  const archive = 'native admission package-manager archive fixture\n';
  const { packageManager: sourcePackageManager } = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const version = /^pnpm@([^+]+)/u.exec(sourcePackageManager)[1];
  const packageManager = `pnpm@${version}+sha512.${createHash('sha512').update(archive).digest('hex')}`;
  const packageBin = join(checkout, '.fixture-pnpm/bin');
  await mkdir(packageBin, { recursive: true });
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ private: true, packageManager }));
  await writeFile(join(checkout, 'pnpm-lock.yaml'), '# dependency-free native worker fixture\n');
  await writeFile(join(checkout, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  writeFakeBin({ root: checkout, binDirName: '.fixture-pnpm/bin', name: 'npm', content: `#!/bin/sh
[ "\${1-}" = pack ] || exit 97
destination=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --pack-destination ]; then shift; destination=$1; fi
  shift
done
[ -n "$destination" ] || exit 98
printf '%s' '${archive}' > "$destination/pnpm-fixture.tgz"
printf '[{"filename":"pnpm-fixture.tgz"}]\\n'
` });
  writeFakeBin({ root: checkout, binDirName: '.fixture-pnpm/bin', name: 'pnpm', content: `#!/bin/sh
case "$#:\${1-}:\${2-}" in
  '1:--version:') printf '%s\\n' '${version}' ;;
  '2:install:--frozen-lockfile')
    mkdir -p node_modules
    printf 'packageManager: pnpm@${version}\\nlayoutVersion: 5\\nnodeLinker: hoisted\\n' > node_modules/.modules.yaml
    ;;
  *) exit 97 ;;
esac
` });
  const launcher = join(bin, 'hstack-exec');
  await Promise.all([
    copyFile(launcherSourcePath, launcher),
    copyFile(join(sourceRoot, 'apps/stack/bin/hstack-dev-target-control'), join(bin, 'hstack-dev-target-control')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_process_identity.sh'), join(proc, 'native_process_identity.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/native_command_policy.sh'), join(targets, 'native_command_policy.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/native_sync_readiness.sh'), join(targets, 'native_sync_readiness.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh'), join(targets, 'remote_execution_custody.sh')),
  ]);
  // A live admission change can prove its exact sibling candidate before the
  // atomic publication. Execute the real candidate policy, not a copied table.
  if (commandPolicySourcePath !== join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_commands.mjs')) {
    const { renderNativeCommandPolicy } = await import(pathToFileURL(commandPolicySourcePath));
    await writeFile(join(targets, 'native_command_policy.sh'), renderNativeCommandPolicy());
  }
  // Native runtime dispatch consumes these real source preparation owners.
  // Forward the entry identity too: a plain symlink skips their CLI main guard
  // because Node resolves import.meta.url to the original module's real path.
  for (const entry of ['remote_dependency_bootstrap.mjs', 'remote_validation_preparation.mjs', 'native_execution_projection.mjs']) {
    const canonicalEntry = join(sourceRoot, 'apps/stack/scripts/utils/dev_targets', entry);
    const packageEnvironment = entry === 'remote_dependency_bootstrap.mjs'
      ? `process.env.PATH = ${JSON.stringify(packageBin)} + ':' + process.env.PATH; delete process.env.npm_execpath;\n` : '';
    await writeFile(join(targets, entry), `${packageEnvironment}process.argv[1] = ${JSON.stringify(canonicalEntry)}; await import(${JSON.stringify(pathToFileURL(canonicalEntry).href)});\n`);
  }
  const dependencyRefresh = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/dependency_refresh.mjs')).href;
  await writeFile(join(proc, 'dependency_refresh.mjs'), `export * from ${JSON.stringify(dependencyRefresh)};\n`);
  const state = await readFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_host_admission_state.sh'), 'utf8');
  const quoted = `'${admissionRoot.replaceAll("'", "'\\''")}'`;
  await writeFile(join(proc, 'native_host_admission_state.sh'), state.replace(/'\/tmp\/happier-heavyweight-admission-v\d+'/, quoted));
  // This fixture is an isolated physical worker, not the test runner's host.
  // Replace only OS enumeration; real RSS/ancestry for explicitly included
  // fixture processes and the production observer's domain logic stay real.
  const observer = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/service_memory.mjs')).href;
  const commandPolicy = pathToFileURL(commandPolicySourcePath).href;
  await writeFile(join(targets, 'remote_commands.mjs'), `export * from ${JSON.stringify(commandPolicy)};
import { runRemoteCommandPolicyCli } from ${JSON.stringify(commandPolicy)};
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runRemoteCommandPolicyCli();
}
`);
  const workspaceAdmissionWorker = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href;
  await writeFile(join(proc, 'workspace_build_admission.mjs'), `export * from ${JSON.stringify(workspaceAdmissionWorker)};
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkspaceBuildAdmissionWorker, runWorkspaceBuildAdmission as runOwner } from ${JSON.stringify(workspaceAdmissionWorker)};
export async function runWorkspaceBuildAdmission(options) { return await runOwner({ ...options, launcherPath: ${JSON.stringify(launcher)} }); }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runWorkspaceBuildAdmissionWorker(process.argv.slice(2));
`);
  const diskObserver = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/worker_disk_budget.mjs')).href;
  await writeFile(join(targets, 'worker_disk_budget.mjs'), `import { runWorkerDiskBudgetCommand } from ${JSON.stringify(diskObserver)}; await runWorkerDiskBudgetCommand();\n`);
  if (prepareDependencies) {
    // A real, dependency-free workspace keeps preparation on its actual
    // readiness/graph owners without reading or repairing the runner's tree.
    await mkdir(join(checkout, 'node_modules'), { recursive: true });
    await mkdir(join(checkout, 'scripts/workspaces'), { recursive: true });
    for (const component of ['stack', 'cli', 'ui', 'server']) {
      await mkdir(join(checkout, 'apps', component), { recursive: true });
      await writeFile(join(checkout, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}`, private: true }));
    }
    const workspaceOwner = pathToFileURL(join(sourceRoot, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs')).href;
    const artifactTarget = pathToFileURL(join(sourceRoot, 'packages/cli-common/componentArtifactTarget.mjs')).href;
    await mkdir(join(checkout, 'packages/cli-common'), { recursive: true });
    await writeFile(join(checkout, 'packages/cli-common/componentArtifactTarget.mjs'), `export * from ${JSON.stringify(artifactTarget)};\n`);
    await writeFile(join(checkout, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'), `export * from ${JSON.stringify(workspaceOwner)};\n`);
    for (const [domain, owner] of [['workspaces', workspaceOwner], ['process', pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/proc.mjs')).href]]) {
      const output = join(checkout, 'packages/cli-common/dist', domain);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'index.js'), `export * from ${JSON.stringify(owner)};\n`);
    }
    // The external installer produces metadata for this dependency-free tree.
    // The real refresh owner alone records proof after that process completes.
    await withDependencyRefresh({ installDir: checkout, componentDir: join(checkout, 'apps/stack'),
      env: { ...buildNativeAdmissionFixtureEnv(), HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_HOME_DIR: root } }, async ({ env }) => {
      execFileSync(join(packageBin, 'pnpm'), ['install', '--frozen-lockfile'], { cwd: checkout, env, stdio: 'pipe' });
    });
  }
  await writeFile(join(proc, 'service_memory.mjs'), `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readLinuxWorkerProcesses, readWorkerMemoryReservations as readReservations, renderWorkerMemoryReservationRows } from ${JSON.stringify(observer)};
const observedPidsPath = ${JSON.stringify(observedPidsPath)};
const selected = observedPidsPath ? new Set(JSON.parse(readFileSync(observedPidsPath, 'utf8'))) : new Set();
const processes = selected.size ? new Map([...readLinuxWorkerProcesses()].filter(([pid]) => selected.has(pid))) : new Map();
export function readWorkerMemoryReservations(options) {
  return readReservations({ ...options, readProcesses: () => processes });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = process.argv.slice(2).find(value => value.startsWith('--admission-root='));
  let previousProgress = null;
  if (process.argv.includes('--include-owner-progress')) {
    try { previousProgress = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  }
  const sample = readWorkerMemoryReservations({ admissionRoot: argument?.slice('--admission-root='.length), includeAdmittedRss: process.argv.includes('--include-admitted-rss'), includeOwnerProgress: process.argv.includes('--include-owner-progress'), previousProgress });
  process.stdout.write(renderWorkerMemoryReservationRows(sample));
}
`);
  const memoryOverridePath = join(checkout, 'broker-memory-observation.json');
  const setMemoryObservation = memory => writeFile(memoryOverridePath, JSON.stringify(memory));
  return { launcher, admissionRoot, setMemoryObservation };
}

/** Adapt only the OS launch boundary, retaining foreground IPC/tree custody. */
export function installWorkspaceAdmissionProcessAdapter({ launcher, binDir = null }) {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalFork = childProcess.fork;
  const canonicalLauncher = join(sourceRoot, 'apps/stack/bin/hstack-exec');
  const custodyModule = join(sourceRoot, 'apps/stack/scripts/utils/proc/proc.mjs');
  const remapCommand = command => command === canonicalLauncher ? launcher : command;
  // A real package build prepends its Node/tool bins. Restore the fixture's
  // physical OS executables at the final launch boundary, including custody
  // forks, so capacity observations do not fall through to the runner's host.
  const remapOptions = options => binDir && options?.env
    ? { ...options, env: { ...options.env, PATH: `${binDir}:${options.env.PATH ?? ''}` } }
    : options;
  const remapArgs = args => {
    const mapped = args?.map(remapCommand);
    if (!mapped) return mapped;
    for (let index = 0; index < mapped.length - 2; index += 1) {
      if (mapped[index] !== custodyModule || mapped[index + 1] !== '--happier-foreground-custody') continue;
      const invocation = JSON.parse(mapped[index + 2]);
      mapped[index + 2] = JSON.stringify({ ...invocation,
        command: remapCommand(invocation.command), args: invocation.args?.map(remapCommand) });
    }
    return mapped;
  };
  childProcess.spawn = (command, args, options) => originalSpawn(remapCommand(command), Array.isArray(args) ? remapArgs(args) : args, remapOptions(options));
  childProcess.fork = (modulePath, args, options) => originalFork(modulePath,
    Array.isArray(args) ? remapArgs([modulePath, ...args]).slice(1) : args, remapOptions(options));
  syncBuiltinESMExports();
  return () => {
    childProcess.spawn = originalSpawn;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  };
}

/** Independent fixture worker: redirect only process launch and OS memory
 * observation. Its child preload consumes the same adapter; native admission,
 * authenticated leases, resolver options and foreground custody stay real.
 */
export async function installWorkspaceAdmissionProcessFixture(t, root, { env: baseEnv = process.env } = {}) {
  if (process.platform !== 'linux') return { env: buildNativeAdmissionFixtureEnv(baseEnv), launcher: null, binDir: null, admissionRoot: null };
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const { binDir } = writeFakeBin({ root, binDirName: 'native-owner/node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '73400320 73400320\\n' ;;
  */proc/pressure/memory*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  t.after(installWorkspaceAdmissionProcessAdapter({ launcher }));
  const preloadPath = join(root, 'workspace-admission-process.mjs');
  await writeFile(preloadPath, `import { installWorkspaceAdmissionProcessAdapter } from ${JSON.stringify(import.meta.url)};\ninstallWorkspaceAdmissionProcessAdapter({ launcher: ${JSON.stringify(launcher)} });\n`);
  const env = { ...buildNativeAdmissionFixtureEnv(baseEnv), PATH: `${binDir}:${baseEnv.PATH ?? ''}`, HAPPIER_DEV_TARGET_EXECUTION: '1',
    NODE_OPTIONS: `${baseEnv.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preloadPath).href}`.trim() };
  return { env, launcher, binDir, admissionRoot };
}
