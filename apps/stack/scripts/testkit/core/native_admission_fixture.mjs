import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { writeFakeBin } from './fake_bin_harness.mjs';
import { createTempFixture } from './temp_fixture.mjs';
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
  const fixtureEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')
    && !key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')
    && !key.startsWith('HSTACK_EXEC_CONTROLLER_')
    && key !== 'control_input_pid'
    && !['VITEST_MAX_THREADS', 'VITEST_MIN_THREADS',
      'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS', 'HAPPIER_VITEST_GOVERNOR_MAX_WORKERS',
      'HAPPIER_VITEST_MAX_WORKERS', 'VITEST_UI_MAX_FORKS', 'GOMAXPROCS'].includes(key)));
  // CLI --import affects only the test runner. Fixture Node children also
  // consume authored workspace exports, before any dist has been published.
  const sourceRuntime = `--import=${pathToFileURL(join(sourceRoot, 'packages/cli-common/registerSourceRuntime.mjs')).href}`;
  if (!String(fixtureEnv.NODE_OPTIONS ?? '').includes(sourceRuntime)) {
    fixtureEnv.NODE_OPTIONS = [fixtureEnv.NODE_OPTIONS, sourceRuntime].filter(Boolean).join(' ');
  }
  return fixtureEnv;
}

/** Remap only the fixed OS-state filesystem boundary, never a production flag.
 * Real admission, kernel identity, locking and class policy remain unchanged.
 */
export async function installNativeAdmissionFixture({ root, admissionRoot = null, observedPidsPath = null, processMemoryKiBPath = null, prepareDependencies = false,
  launcherSourcePath = process.env.HAPPIER_TEST_NATIVE_ADMISSION_LAUNCHER || join(sourceRoot, 'apps/stack/bin/hstack-exec'),
  admissionStateSourcePath = process.env.HAPPIER_TEST_NATIVE_ADMISSION_STATE || join(sourceRoot, 'apps/stack/scripts/utils/proc/native_host_admission_state.sh'),
  admissionBrokerSourcePath = process.env.HAPPIER_TEST_NATIVE_ADMISSION_BROKER || join(sourceRoot, 'apps/stack/scripts/utils/proc/admission_broker.mjs'),
  admissionClientSourcePath = process.env.HAPPIER_TEST_NATIVE_ADMISSION_CLIENT || join(sourceRoot, 'apps/stack/scripts/utils/proc/admission_client.mjs'),
  commandPolicySourcePath = join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_commands.mjs') }) {
  if (!admissionRoot) {
    // Unix socket paths have a kernel byte bound. Worker TMPDIR deliberately
    // stays disk-backed and may be long; only owned socket metadata uses /tmp.
    const sockets = await createTempFixture({ after }, { parentDir: '/tmp', prefix: 'ha-' });
    admissionRoot = sockets.root;
  }
  const checkout = join(root, 'native-owner');
  const bin = join(checkout, 'apps/stack/bin');
  const proc = join(checkout, 'apps/stack/scripts/utils/proc');
  const targets = join(checkout, 'apps/stack/scripts/utils/dev_targets');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(proc, { recursive: true }), mkdir(targets, { recursive: true })]);
  if (!observedPidsPath) {
    observedPidsPath = join(checkout, 'worker-pids.json');
    await writeFile(observedPidsPath, '[]');
  }
  if (!processMemoryKiBPath) {
    processMemoryKiBPath = join(checkout, 'worker-pages.json');
    await writeFile(processMemoryKiBPath, '{}');
  }
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
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_process_priority.sh'), join(proc, 'native_process_priority.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_admission_client.sh'), join(proc, 'native_admission_client.sh')),
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
  const processOwner = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/proc.mjs')).href;
  await writeFile(join(proc, 'proc.mjs'), `export * from ${JSON.stringify(processOwner)};\n`);
  const state = await readFile(admissionStateSourcePath, 'utf8');
  const rootAssignments = [...state.matchAll(/^native_host_admission_root=(?:'(\/tmp\/happier-heavyweight-admission-v\d+)'|"(\/tmp\/happier-heavyweight-admission-v\d+)-\$native_host_admission_uid")$/gm)];
  const defaultRoot = rootAssignments[0]?.[1]
    ?? `${rootAssignments[0]?.[2]}-${process.getuid?.()}`;
  if (rootAssignments.length !== 1 || resolve(admissionRoot) === defaultRoot) {
    throw new Error('Native admission fixture must replace exactly one default host root');
  }
  const quoted = `'${admissionRoot.replaceAll("'", "'\\''")}'`;
  await writeFile(join(proc, 'native_host_admission_state.sh'), state.replace(rootAssignments[0][0], `native_host_admission_root=${quoted}`));
  // The broker owns real scheduling and reservation arithmetic. Only the
  // physical memory/process observations belong to this isolated worker.
  const brokerOwner = pathToFileURL(admissionBrokerSourcePath).href;
  const resourceSamplesPath = join(checkout, 'broker-resource-samples');
  const memoryOverridePath = join(checkout, 'broker-memory-observation.json');
  await writeFile(join(proc, 'admission_broker.mjs'), `
export * from ${JSON.stringify(brokerOwner)};
import { createAdmissionBroker, readAdmissionMemorySample } from ${JSON.stringify(brokerOwner)};
import { appendFileSync, existsSync, readFileSync, watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLinuxWorkerProcesses } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/service_memory.mjs')).href)};
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === '--serve') {
  if (process.argv[3] !== ${JSON.stringify(admissionRoot)}) throw new Error('Native admission fixture root mismatch');
  const root = ${JSON.stringify(root)};
  const readProcesses = () => {
    const selected = new Set(JSON.parse(readFileSync(${JSON.stringify(observedPidsPath)}, 'utf8')));
    const processes = selected.size ? new Map([...readLinuxWorkerProcesses()].filter(([pid]) => selected.has(pid))) : new Map();
    const pages = JSON.parse(readFileSync(${JSON.stringify(processMemoryKiBPath)}, 'utf8'));
    for (const [pid, record] of processes) {
      if (Number.isSafeInteger(pages[pid]) && pages[pid] >= 0) processes.set(pid, { ...record, rssKiB: pages[pid], pssKiB: pages[pid] });
    }
    return processes;
  };
  const readMemory = () => {
    if (existsSync(${JSON.stringify(memoryOverridePath)})) return JSON.parse(readFileSync(${JSON.stringify(memoryOverridePath)}, 'utf8'));
    const values = execFileSync('awk', ['/MemAvailable:/ {available=$2} /MemTotal:/ {total=$2} END {print available, total}', '/proc/meminfo'], { encoding: 'utf8' }).trim().split(/\\s+/u).map(Number);
    return { availableMemoryKiB: values[0], totalMemoryKiB: values[1] };
  };
  const broker = createAdmissionBroker({ root: ${JSON.stringify(admissionRoot)}, oldLockPath: ${JSON.stringify(join(admissionRoot, 'old-admission.lock'))}, sampleResources: ({ slots }) => {
    appendFileSync(${JSON.stringify(resourceSamplesPath)}, 'sample\\n');
    if (process.env.FIXTURE_SAMPLES) appendFileSync(process.env.FIXTURE_SAMPLES, 'sample\\n');
    return readAdmissionMemorySample({ slots, readProcesses, readMemory });
  } });
  let started = false;
  try { await broker.start(); started = true; process.stdout.write('ready\\n'); }
  catch (error) {
    if (error.code === 'EADDRINUSE') process.stdout.write('ready\\n');
    else { process.stderr.write('HSTACK_ADMISSION_BROKER_UNAVAILABLE\\n'); process.exitCode = 76; }
    await broker.close();
  }
  if (started) {
    // One fixture broker watches its owned root lifetime; teardown must not
    // leave a detached host behind after the temporary worker is removed.
    const lifetime = watch(dirname(root), () => {
      if (!existsSync(root)) { lifetime.close(); void broker.close(); }
    });
  }
}
`);
  try {
    await copyFile(admissionClientSourcePath, join(proc, 'admission_client.mjs'));
    await copyFile(join(dirname(admissionClientSourcePath), 'admission_socket.mjs'), join(proc, 'admission_socket.mjs'));
  } catch (error) {
    // The old launcher remains executable for the pre-replacement RED run.
    if (error.code !== 'ENOENT' || process.env.HAPPIER_TEST_NATIVE_ADMISSION_CLIENT) throw error;
  }
  // This fixture is an isolated physical worker, not the test runner's host.
  // Replace only OS enumeration; real RSS/ancestry for explicitly included
  // fixture processes and the production observer's domain logic stay real.
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
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkspaceBuildAdmissionWorker, runWorkspaceBuildAdmission as runOwner } from ${JSON.stringify(workspaceAdmissionWorker)};
export async function runWorkspaceBuildAdmission(options) { return await runOwner({ ...options, launcherPath: ${JSON.stringify(launcher)} }); }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // A simulated Darwin shell and its real Node worker share one OS boundary.
  // Keep standalone policy real; Linux admission and imported adapters retain
  // their actual kernel platform and process-generation observations.
  if (process.argv[2] === '--standalone' && process.platform === 'linux'
    && execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim() === 'Darwin') {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  }
  await runWorkspaceBuildAdmissionWorker(process.argv.slice(2));
}
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
      // Outer no-refresh flags protect the shared checkout, not this owned
      // dependency-free fixture's synthetic package-manager boundary.
      env: { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_SKIP_REFRESH_DEPS: '',
        HAPPIER_STACK_DISABLE_REFRESH_DEPS: '', HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_HOME_DIR: root } }, async ({ env }) => {
      execFileSync(join(packageBin, 'pnpm'), ['install', '--frozen-lockfile'], { cwd: checkout, env, stdio: 'pipe' });
    });
  }
  const brokerStatus = async () => {
    const { requestAdmissionSample } = await import(pathToFileURL(join(proc, 'admission_client.mjs')));
    return requestAdmissionSample(admissionRoot);
  };
  const setMemoryObservation = memory => writeFile(memoryOverridePath, JSON.stringify(memory));
  return { launcher, admissionRoot, observedPidsPath, processMemoryKiBPath, resourceSamplesPath, memoryOverridePath,
    admissionClientPath: join(proc, 'admission_client.mjs'), brokerStatus, setMemoryObservation };
}

/** Physical pressure belongs to an actual live fixture process, so a queued
 * request can recover when admitted pages are released, without allocating GiB.
 */
export async function holdNativeAdmissionFixtureMemory(t, native, { totalKiB, availableKiB }) {
  // Admit this real holder before applying its physical pressure. The owned
  // observation file substitutes only OS memory, never broker admission state.
  await writeFile(native.memoryOverridePath, JSON.stringify({ availableMemoryKiB: totalKiB, totalMemoryKiB: totalKiB }));
  const client = pathToFileURL(native.admissionClientPath).href;
  const program = `import { runAdmissionCommand } from ${JSON.stringify(client)};
process.exitCode = await runAdmissionCommand({ root: ${JSON.stringify(native.admissionRoot)},
  className: 'validation', floorKiB: ${Math.max(1, totalKiB - availableKiB)}, machine: 'fixture',
  repoDir: ${JSON.stringify(resolve(native.launcher, '../../../..'))}, cacheBaseDir: ${JSON.stringify(dirname(native.memoryOverridePath))},
  command: process.execPath, args: ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], env: process.env });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: buildNativeAdmissionFixtureEnv(native.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  let released = false;
  const release = async (updateMemory, { availableKiB: releasedAvailableKiB = totalKiB } = {}) => {
    if (released) return;
    released = true;
    try {
      await updateMemory?.();
      try { await native.setMemoryObservation({ availableMemoryKiB: releasedAvailableKiB, totalMemoryKiB: totalKiB }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } finally {
      child.stdin.end();
      await exited;
    }
  };
  t.after(() => release());
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', status => reject(new Error(`fixture holder exited before admission (${status}): ${stderr}`)));
  });
  const pids = JSON.parse(await readFile(native.observedPidsPath, 'utf8'));
  await writeFile(native.observedPidsPath, JSON.stringify([...pids, child.pid]));
  const pages = JSON.parse(await readFile(native.processMemoryKiBPath, 'utf8'));
  await writeFile(native.processMemoryKiBPath, JSON.stringify({ ...pages, [child.pid]: totalKiB - availableKiB }));
  await native.setMemoryObservation({ availableMemoryKiB: availableKiB, totalMemoryKiB: totalKiB });
  return { child, release };
}

/** Adapt only the OS launch boundary, retaining foreground IPC/tree custody. */
export function installWorkspaceAdmissionProcessAdapter({ launcher, binDir = null, remapShellCommands = false }) {
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
    if (remapShellCommands) {
      for (let index = 1; index < mapped.length; index += 1) {
        if (['-c', '-lc'].includes(mapped[index - 1]) && typeof mapped[index] === 'string') {
          mapped[index] = mapped[index].replaceAll(canonicalLauncher, launcher);
        }
      }
    }
    for (let index = 0; index < mapped.length - 2; index += 1) {
      if (mapped[index] !== custodyModule || mapped[index + 1] !== '--happier-foreground-custody') continue;
      const invocation = JSON.parse(mapped[index + 2]);
      mapped[index + 2] = JSON.stringify({ ...invocation,
        command: remapCommand(invocation.command), args: remapArgs(invocation.args) });
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

/** Controller placement keeps the real repository cwd and helper identities.
 * Redirect only its host admission state/client and child OS launch boundary;
 * an includeLocal score must never contact the runner's default host broker.
 */
export async function installNativeAdmissionControllerFixture(t, root, { env: baseEnv = process.env } = {}) {
  const native = await installNativeAdmissionFixture({ root });
  const proc = resolve(native.launcher, '../../scripts/utils/proc');
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const replaceOnce = (source, marker, replacement) => {
    if (source.split(marker).length !== 2) throw new Error('Native controller fixture source boundary changed');
    return source.replace(marker, replacement);
  };
  let source = await readFile(native.launcher, 'utf8');
  source = replaceOnce(source, 'script_dir=$(CDPATH= cd -- "$launcher_dir" && pwd -P) || exit 1',
    `script_dir=${shellQuote(dirname(process.env.HAPPIER_TEST_NATIVE_ADMISSION_LAUNCHER || join(sourceRoot, 'apps/stack/bin/hstack-exec')))}`);
  for (const entry of ['native_host_admission_state.sh', 'native_admission_client.sh']) {
    source = replaceOnce(source, `. "$script_dir/../scripts/utils/proc/${entry}" || exit 1`,
      `. ${shellQuote(join(proc, entry))} || exit 1`);
  }
  await writeFile(native.launcher, source);
  const transportPath = join(proc, 'native_admission_client.sh');
  await writeFile(transportPath, replaceOnce(await readFile(transportPath, 'utf8'),
    'admission_client="$script_dir/../scripts/utils/proc/admission_client.mjs"',
    `admission_client=${shellQuote(native.admissionClientPath)}`));
  t.after(installWorkspaceAdmissionProcessAdapter({ launcher: native.launcher, remapShellCommands: true }));
  const preloadPath = join(root, 'controller-admission-process.mjs');
  await writeFile(preloadPath, `import { installWorkspaceAdmissionProcessAdapter } from ${JSON.stringify(import.meta.url)};\ninstallWorkspaceAdmissionProcessAdapter({ launcher: ${JSON.stringify(native.launcher)}, remapShellCommands: true });\n`);
  const fixtureEnv = buildNativeAdmissionFixtureEnv(baseEnv);
  return { ...native, preloadPath, env: { ...fixtureEnv,
    NODE_OPTIONS: `${fixtureEnv.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preloadPath).href}`.trim() } };
}

/** Independent fixture worker: redirect only process launch and OS memory
 * observation. Its child preload consumes the same adapter; native admission,
 * authenticated leases, resolver options and foreground custody stay real.
 */
export async function installWorkspaceAdmissionProcessFixture(t, root, { env: baseEnv = process.env } = {}) {
  if (process.platform !== 'linux') return { env: buildNativeAdmissionFixtureEnv(baseEnv), launcher: null, binDir: null, admissionRoot: null, preloadPath: null };
  const native = await installNativeAdmissionFixture({ root });
  const { launcher } = native;
  const { binDir } = writeFakeBin({ root, binDirName: 'native-owner/node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '73400320 73400320\\n' ;;
  */proc/pressure/memory*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  t.after(installWorkspaceAdmissionProcessAdapter({ launcher, binDir }));
  const preloadPath = join(root, 'workspace-admission-process.mjs');
  await writeFile(preloadPath, `import { installWorkspaceAdmissionProcessAdapter } from ${JSON.stringify(import.meta.url)};\ninstallWorkspaceAdmissionProcessAdapter({ launcher: ${JSON.stringify(launcher)}, binDir: ${JSON.stringify(binDir)} });\n`);
  const fixtureEnv = buildNativeAdmissionFixtureEnv(baseEnv);
  const env = { ...fixtureEnv, PATH: `${binDir}:${baseEnv.PATH ?? ''}`, HAPPIER_DEV_TARGET_EXECUTION: '1',
    NODE_OPTIONS: `${fixtureEnv.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preloadPath).href}`.trim() };
  return { ...native, env, binDir, preloadPath };
}
