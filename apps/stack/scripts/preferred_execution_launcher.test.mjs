import { killProcessTree } from './utils/proc/proc.mjs';
import { terminateProcessPid } from './utils/proc/terminate.mjs';
import { isPidAlive } from './utils/proc/pids.mjs';
import { brokerAddress, createAdmissionBroker } from './utils/proc/admission_broker.mjs';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { withDependencyRefresh } from './utils/proc/dependency_refresh.mjs';
import { prepareCommandRepository, renderNativeExecutionProjection } from './utils/dev_targets/native_execution_projection.mjs';
import { buildRemoteExecCommand, posixQuote, resolveHeavyweightMemoryFloorKiB, resolvePackageCommandPolicy } from './utils/dev_targets/remote_commands.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installCliNativeCustodySourceFixture, installNativeAdmissionControllerFixture, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { flushDevTargetSync } from './utils/dev_targets/sync_project.mjs';
import { syncDevTarget } from './utils/dev_targets/executor.mjs';
import { resolveDevTargetMutagenRuntime } from './utils/dev_targets/mutagen_runtime.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from './utils/dev_targets/mutagen_project.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const launcher = join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');

// Bootstrap progress is independent of the admitted command's stdout contract.
function payloadOutput(stdout) {
  return stdout.replace(/^pnpm \d+\.\d+\.\d+ ready; root archive integrity verified\r?\n/gm, '');
}

// OS boundary: systemd 259 expands command operands by default, including
// shell programs. Count that extra interpretation rather than testing flags.
const systemdOperandExpansionProbe = `if [ "\${TEST_LITERAL_SCOPE_PROBE-}" = 1 ]; then exec ${JSON.stringify(process.execPath)} --input-type=module -e '${[
  'import { existsSync, writeFileSync } from "node:fs";',
  'const [literal, ...args] = process.argv.slice(1); let expansions = 0;',
  'const operands = literal === "1" ? args : args.map(arg => arg.replace(/\\$(?:\\{([^}]*)\\}|([A-Za-z_]\\w*))/g, (_, braced, plain) => { expansions++; return process.env[braced ?? plain] ?? ""; }));',
  'writeFileSync(process.env.TEST_SCOPE_EXPANSIONS, String(expansions), { flag: "a" });',
  'const command = operands[0].includes("/") ? operands[0] : process.env.PATH.split(":").map(dir => dir + "/" + operands[0]).find(existsSync) ?? operands[0];',
  'process.execve(command, operands, process.env);',
].join(' ')}' "$literal_arguments" "$@"; fi`;

// Measured cksum fixture key for `probe-command  ` (empty build target/components).
const probeCommandCacheKey = '1086556756';
const repoToken = repoRoot.split('/').at(-1)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '') || 'repo';
const executionNeutralEnv = Object.fromEntries(
  Object.entries(buildNativeAdmissionFixtureEnv()).filter(([key]) => ![
    'HAPPIER_DEV_TARGET_EXECUTION',
    'HAPPIER_PREFERRED_EXECUTION',
    'HAPPIER_EXEC_CONFIG_PATH',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE',
    'HAPPIER_HSTACK_DISPATCH_CONTROL',
    'HAPPIER_HSTACK_EXECUTION',
    'HAPPIER_TYPECHECK_DISPATCHED',
    'HAPPIER_STACK_CLI_HOME_DIR',
    'HAPPIER_HOME_DIR',
    'HAPPIER_STACK_PM_CACHE_BASE_DIR',
    // Synthetic package-manager fixtures must not inherit the suite's Yarn
    // executable and escape their external process boundary.
    'npm_node_execpath',
    'npm_execpath',
  ].includes(key)),
);

async function installObservedWorkerLoginShell(binDir) {
  // The remote login shell is an OS boundary. Keep prerequisite, compiler-pin
  // and component-capability logic real; supply its existing worker sample
  // only where the remote shell would observe that machine's OS resources.
  await executable(join(binDir, 'bash'), `#!/bin/sh
if [ "\${1-}" = -lc ]; then
  case "\${2-}" in
    *'cpu=$(getconf'*)
      /usr/bin/awk 'NR==1 {for(i=1;i<=16;i++) printf "%s%s",(i==1?"":" "),$i; printf "\\n%s %s %s %s\\n",($17==""?$7:$17),($18==""?0:$18),($19==""?$8:$19),($20==""?0:$20)}' "$FIXTURE_PROBE_SAMPLE"
      exit $? ;;
  esac
fi
exec /bin/bash "$@"
`);
}

async function executable(path, contents) {
  if (path.endsWith('/node')) {
    // These are internal policy/admission owners, even when their argv contains
    // a compiler or test payload that the external executable fixture handles.
    contents = contents.replace(/^(#![^\n]*\n)/, `$1case "\${1-}:\${2-}" in\n  *native_execution_projection.mjs:--validate-execution-config|*native_execution_projection.mjs:--prepare-protocol-exports) exec ${JSON.stringify(process.execPath)} "$@" ;;\nesac\ncase "\${1-}" in\n  *controller_coalescing.mjs|*remote_commands.mjs|*workspace_build_admission.mjs|*admission_client.mjs|*admission_broker.mjs|*worker_disk_budget.mjs|*remote_dependency_bootstrap.mjs|*remote_validation_preparation.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;\nesac\n`);
  }
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

function nativeFixtureRuntime(stackDir) {
  return resolveDevTargetMutagenRuntime({ stackBaseDir: stackDir, sourceDir: repoRoot,
    env: { HAPPIER_STACK_STORAGE_DIR: dirname(stackDir) } });
}

test('sibling basis bootstrap and preparation use the basis UI tool contract', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-basis-bootstrap-', parentDir: dirname(repoRoot) });
  const ui = fixture.path('apps/ui');
  const owners = fixture.path('apps/stack/scripts/utils/dev_targets');
  await mkdir(join(ui, 'tools'), { recursive: true });
  await mkdir(owners, { recursive: true });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# basis fixture\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(fixture.path('apps/stack/package.json'), JSON.stringify({ name: '@happier-dev/stack' }));
  await writeFile(join(ui, 'package.json'), JSON.stringify({ name: '@happier-dev/app',
    scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
    happier: { installFreshnessInputs: ['tools/resolveUiPostinstallTasks.mjs'] } }));
  // The historical tool intentionally has no resolveUiPostinstallTaskInputs.
  await writeFile(join(ui, 'tools/resolveUiPostinstallTasks.mjs'),
    'export function resolveUiPostinstallTasks() { return ["historical-task"]; }\n');
  // These source-owned executables model the other checkout's process boundary;
  // their real imports must stay paired with that checkout's older UI contract.
  for (const [name, output] of [['remote_dependency_bootstrap', 'bootstrap'], ['remote_validation_preparation', 'prepared']]) {
    await writeFile(join(owners, `${name}.mjs`), `import { writeFileSync } from 'node:fs';
import { resolveUiPostinstallTasks } from '../../../../ui/tools/resolveUiPostinstallTasks.mjs';
if (process.env.HAPPIER_TEST_BASIS_BOOTSTRAP_FAILURE === '1') process.exit(29);
writeFileSync(new URL('../../../../../${output}', import.meta.url), JSON.stringify(resolveUiPostinstallTasks()));
`);
  }
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'pnpm', content: `#!${process.execPath}
const { readFileSync } = require('node:fs');
for (const name of process.env.HAPPIER_TEST_BASIS_MISSING_PREPARATION === '1' ? ['bootstrap'] : ['bootstrap', 'prepared']) {
  if (readFileSync(${JSON.stringify(fixture.root)} + '/' + name, 'utf8') !== '["historical-task"]') process.exit(37);
}
console.log('Vitest reached'); process.exit(17);
` });
  const env = { ...executionNeutralEnv, PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, CI: '1',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  await withDependencyRefresh({ installDir: fixture.root, componentDir: fixture.path('apps/stack'), env: { ...env,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } },
  async () => mkdir(fixture.path('node_modules')));
  const args = [launcher, `--repo=${fixture.root}`, '--cwd=.', '--local', '--', 'pnpm', '--dir', 'apps/ui',
    'exec', 'vitest', 'run', 'sources/historical.test.ts'];
  const result = spawnSync('/bin/sh', args, { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stdout, /Vitest reached/);
  const failure = spawnSync('/bin/sh', args, { cwd: repoRoot,
    env: { ...env, HAPPIER_TEST_BASIS_BOOTSTRAP_FAILURE: '1' }, encoding: 'utf8' });
  assert.equal(failure.status, 29, failure.stderr);
  assert.doesNotMatch(failure.stdout, /Vitest reached/);

  // Older checkouts such as 0.2 have bootstrap but no preparation entrypoint.
  // Observe the Node process boundary while executing real preparation logic.
  await rm(join(owners, 'remote_validation_preparation.mjs'));
  await rm(fixture.path('prepared'));
  const trace = fixture.path('preparation-trace');
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
printf '%s\\n' "$1" >> ${JSON.stringify(trace)}
exec ${JSON.stringify(process.execPath)} "$@"
` });
  const historical = spawnSync('/bin/sh', args, { cwd: repoRoot,
    env: { ...env, HAPPIER_TEST_BASIS_MISSING_PREPARATION: '1' }, encoding: 'utf8' });
  assert.equal(historical.status, 17, historical.stderr);
  assert.match(historical.stdout, /Vitest reached/);
  const invoked = (await readFile(trace, 'utf8')).trim().split('\n');
  assert.ok(invoked.includes(join(owners, 'remote_dependency_bootstrap.mjs')),
    'available checkout bootstrap must retain precedence');
  assert.ok(invoked.some(path => resolve(path) === join(repoRoot,
    'apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs')),
  'missing checkout preparation must use the executor entrypoint');
});

test('managed pnpm remains visible during native worker preflight and dispatch', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-managed-pnpm-preflight-' });
  const bin = fixture.path('bin');
  const stack = fixture.path('stack');
  const config = join(stack, 'dev-targets.json');
  const workerHome = fixture.path('worker');
  const managedBin = join(workerHome, 'cache', 'pnpm-toolchain', 'bin');
  await mkdir(bin);
  await mkdir(stack);
  await writeFile(config, JSON.stringify({ version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/worker/repo', cliHomeDir: workerHome }],
    commandExecution: { mode: 'prefer-target', target: 'worker', fallback: 'local' } }));
  await executable(join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(join(bin, 'mutagen'), '#!/bin/sh\n[ "$1" != sync ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  // SSH availability and remote execution are the system boundary. A worker
  // exposes pnpm only in the canonical provisioner's private install prefix.
  await executable(join(bin, 'ssh'), `#!/bin/sh
case "$*" in
  *-MNf*|*-O\\ check*) exit 0 ;;
  *command\\ -v*) case "$*" in *"'pnpm'"*) case "$*" in *'${managedBin}'*) exit 0 ;; *) exit 1 ;; esac ;; esac; exit 0 ;;
  *getconf*) printf '48 0 0.9 100000000 10 0 100000000 100000000 0 0 0 0 0 0 0 linux\\n' ;;
  *) case "$*" in *'${managedBin}'*) printf '12.14.0\\n'; exit 0 ;; *) exit 42 ;; esac ;;
esac
`);
  const result = spawnSync('/bin/sh', [launcher, '--target=worker', '--', 'pnpm', '--version'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...executionNeutralEnv, HOME: fixture.root,
      HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
      PATH: `${bin}:/usr/bin:/bin`, TMPDIR: fixture.root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /12\.14\.0/);
});

test('CLI test preflight rejects missing Go before bootstrap and admits the repaired worker', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cli-go-preflight-' });
  const bin = join(root, 'bin');
  const stack = join(root, 'stack');
  const config = join(stack, 'dev-targets.json');
  const ready = join(root, 'go-ready');
  await mkdir(bin);
  await mkdir(stack);
  await writeFile(config, JSON.stringify({ version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/worker/repo', cliHomeDir: '/worker/home' }],
    commandExecution: { mode: 'prefer-target', target: 'worker', fallback: 'local' } }));
  await executable(join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(join(bin, 'mutagen'), '#!/bin/sh\n[ "$1" != sync ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  // SSH/tool availability is the system boundary. The real launcher performs
  // policy classification, prerequisite caching, selection and dispatch.
  await executable(join(bin, 'ssh'), `#!/bin/sh
case "$*" in
  *-MNf*|*-O\\ check*) exit 0 ;;
  *command\\ -v*) case "$*" in *"'go'"*) [ -f '${ready}' ] || exit 1 ;; esac; exit 0 ;;
  *getconf*) printf '48 0 0.9 100000000 10 0 100000000 100000000 0 0 0 0 0 0 0 linux\\n' ;;
  *) printf 'runner-started\\n'; exit 23 ;;
esac
`);
  const invocation = { cwd: repoRoot, encoding: 'utf8', env: { ...executionNeutralEnv,
    HOME: root, HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root } };
  const args = [launcher, '--target=worker', '--', 'corepack', 'yarn', '--cwd', 'apps/cli', 'vitest', 'run', 'src/example.test.ts'];
  const missing = spawnSync('/bin/sh', args, invocation);
  assert.notEqual(missing.status, 0, missing.stderr);
  assert.doesNotMatch(missing.stdout, /runner-started/, 'missing Go must prevent bootstrap and payload dispatch');
  assert.match(missing.stderr, /command preflight failed/);
  await writeFile(ready, 'ready');
  const repaired = spawnSync('/bin/sh', args, invocation);
  assert.equal(repaired.status, 23, repaired.stderr);
  assert.match(repaired.stdout, /runner-started/);
});

test('Stack public tests select the Bun-capable AUTO worker before bootstrap', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-stack-bun-preflight-' });
  const bin = join(root, 'bin');
  const stack = join(root, 'stack');
  const config = join(stack, 'dev-targets.json');
  const dispatched = join(root, 'dispatched');
  await mkdir(bin);
  await mkdir(stack);
  await writeFile(config, JSON.stringify({ version: 3,
    targets: ['missing-bun', 'has-bun'].map(name => ({ name, platform: 'posix', ssh: name,
      repoDir: `/${name}/repo`, cliHomeDir: `/${name}/home` })),
    commandExecution: { mode: 'auto', targets: ['missing-bun', 'has-bun'], includeLocal: false, fallback: 'error' } }));
  await executable(join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(join(bin, 'mutagen'), '#!/bin/sh\n[ "$1" != sync ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  // Only SSH/tool availability and telemetry are external boundaries. Give the
  // incapable worker the better load so tool preflight, not ranking, decides.
  await executable(join(bin, 'ssh'), `#!/bin/sh
case "$*" in *missing-bun*) worker=missing-bun ;; *) worker=has-bun ;; esac
case "$*" in
  *-MNf*|*-O\\ check*) exit 0 ;;
  *command\\ -v*) case "$worker:$*" in missing-bun:*"'bun'"*) exit 1 ;; esac; exit 0 ;;
  *getconf*) load=1; [ "$worker" != missing-bun ] || load=0; printf '48 %s 0.9 100000000 10 0 100000000 100000000 0 0 0 0 0 0 0 linux\\n' "$load" ;;
  *) printf '%s\\n' "$worker" >> '${dispatched}'; printf 'runner-started:%s\\n' "$worker"; exit 23 ;;
esac
`);
  const result = spawnSync('/bin/sh', [launcher, '--', 'pnpm', '--dir', 'apps/stack', 'run', '--silent', 'test'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...executionNeutralEnv, CI: '', HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root },
  });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /runner-started:has-bun/);
  assert.match(result.stderr, /missing-bun command preflight failed/);
  assert.deepEqual((await readFile(dispatched, 'utf8')).trim().split('\n'), ['has-bun'],
    'the missing-Bun worker must never receive bootstrap or payload dispatch');
});

async function writeNativeProjectionFixture(path, contents) {
  const runtime = nativeFixtureRuntime(dirname(path));
  // Even hand-authored external-process fixtures consume the shared-owner
  // fields. Keep their daemon/barrier namespace inside the isolated fixture.
  const source = /^projection_config_path=/m.test(contents) ? ''
    : `projection_config_path=${JSON.stringify(join(dirname(path), 'dev-targets.json'))}\n`;
  const body = source + contents.replace(/^projection_mutagen_(?:data_dir|ssh_path)=.*\n/gm, '');
  await writeFile(path, `projection_mutagen_data_dir=${JSON.stringify(runtime.dataDir)}\nprojection_mutagen_ssh_path=${JSON.stringify(runtime.opensshDir)}\n${body}`);
}

test('controller explicit local compilation refuses without override and override retains admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-local-compile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeFixture = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const { launcher: native } = nativeFixture;
  const checkout = join(root, 'native-owner');
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Keep the real runner/selector/leaf admission. Only its native compiler
  // process and physical worker state are adapted at the OS spawn boundary.
  const compiler = join(root, 'compiler.cjs');
  const preload = join(root, 'compiler-process.mjs');
  const lifecycle = join(root, 'package-lifecycle.mjs');
  const parentState = join(root, 'package-parent.json');
  const compilerArgs = ['--noEmit', '-p', 'apps/ui/tsconfig.json'];
  await writeFile(join(checkout, 'apps/ui/tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, files: ['fixture.ts'] }));
  await writeFile(join(checkout, 'apps/ui/fixture.ts'), 'export {};\n');
  const compilerPath = resolveTypeScriptCliInvocation({ args: compilerArgs, workspaceDir: checkout }).compilerPath;
  await writeFile(compiler, `process.stdout.write('compiler-started\\n'); process.exit(7);\n`);
  // The real entry and selector derive repository identity from their location.
  // Keep that identity in this fixture while forwarding installed dependencies.
  for (const entry of ['runTypeScriptCli.mjs', 'resolveTypeScriptCliInvocation.mjs']) {
    const sourceModule = new URL(`../../../scripts/workspaces/${entry}`, import.meta.url);
    const source = await readFile(sourceModule, 'utf8');
    const forwarded = source.replace(/(from\s+|import\()(['"])(\.[^'"]+)\2/g, (match, prefix, quote, specifier) => {
      if (entry === 'runTypeScriptCli.mjs' && specifier === './resolveTypeScriptCliInvocation.mjs') return match;
      return `${prefix}${quote}${new URL(specifier, sourceModule).href}${quote}`;
    }).replace("from 'typescript'", `from ${JSON.stringify(import.meta.resolve('typescript'))}`)
      .replace('createRequire(import.meta.url)', `createRequire(${JSON.stringify(sourceModule.href)})`);
    await writeFile(join(checkout, 'scripts/workspaces', entry), forwarded);
  }
  const { packageManager } = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ private: true, packageManager, scripts: {
      pretypecheck: 'node scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
      typecheck: `node scripts/workspaces/runTypeScriptCli.mjs ${compilerArgs.map(arg => JSON.stringify(arg)).join(' ')}`,
    } }));
  // The package-manager adapter keeps a real finite prerequisite before the
  // real compiler. Parent admission would hide a missing leaf CI requirement.
  await writeFile(lifecycle, `
import { writeFileSync } from 'node:fs';
import { runWorkspaceBuildAdmission } from ${JSON.stringify(new URL('./utils/proc/workspace_build_admission.mjs', import.meta.url).href)};
writeFileSync(${JSON.stringify(parentState)}, JSON.stringify({ admitted: Boolean(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN) }));
const prepared = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', ''],
  locks: [{ path: ${JSON.stringify(join(root, 'prerequisite.lock'))} }], admissionClass: 'package-dist',
  cwd: ${JSON.stringify(checkout)}, env: process.env });
if (prepared.error || prepared.signal || prepared.status !== 0) throw prepared.error ?? new Error('prerequisite failed');
process.argv = [process.execPath, ${JSON.stringify(join(checkout, 'scripts/workspaces/runTypeScriptCli.mjs'))}, ...${JSON.stringify(compilerArgs)}];
await import(${JSON.stringify(pathToFileURL(join(checkout, 'scripts/workspaces/runTypeScriptCli.mjs')).href)});
`);
  await writeFile(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { installWorkspaceAdmissionProcessAdapter } from ${JSON.stringify(new URL('./testkit/core/native_admission_fixture.mjs', import.meta.url).href)};
installWorkspaceAdmissionProcessAdapter({ launcher: ${JSON.stringify(native)} });
const cp = createRequire(import.meta.url)('node:child_process');
const remapCompiler = args => args?.map(arg => arg === ${JSON.stringify(compilerPath)} ? ${JSON.stringify(compiler)} : arg);
const spawn = cp.spawn;
const fork = cp.fork;
cp.spawn = (command, args, options) => spawn(command, remapCompiler(args), options);
// The process owner carries owned foreground commands through its IPC fork.
// Adapt the external compiler inside that existing custody boundary too.
cp.fork = (modulePath, args, options) => fork(modulePath, args?.map((arg, index) => {
  if (args[index - 1] !== '--happier-foreground-custody') return arg;
  const invocation = JSON.parse(arg);
  return JSON.stringify({ ...invocation, args: remapCompiler(invocation.args) });
}), options);
syncBuiltinESMExports();
`);
  await executable(join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await executable(join(bin, 'pnpm'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(lifecycle)}\n`);
  await executable(join(bin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "%s %s\\n" "$MEMORY_KIB" "$MEMORY_KIB" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  const invoke = async (memory, options = [], extraEnv = {}, payload = ['pnpm', 'run', '--silent', 'typecheck']) => {
    await nativeFixture.setMemoryObservation({ availableMemoryKiB: memory, totalMemoryKiB: memory });
    return spawnSync('/bin/sh', [native, '--local', ...options, '--', ...payload], {
      cwd: checkout, encoding: 'utf8', timeout: 15000,
      env: { ...executionNeutralEnv, HOME: root, PATH: `${bin}:${process.env.PATH}`, CI: '', MEMORY_KIB: String(memory),
        NODE_OPTIONS: `${executionNeutralEnv.NODE_OPTIONS ?? ''} --import=${preload}`.trim(), ...extraEnv },
    });
  };
  const refused = await invoke(40 * 1024 * 1024);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /AUTO.*--allow-local-compilation/);
  const uiFloorKiB = resolveHeavyweightMemoryFloorKiB('compilation-ui', { machine: 'local' });
  const insufficient = await invoke(uiFloorKiB - 1, ['--allow-local-compilation'], { CI: '1' });
  assert.equal(insufficient.status, 75, insufficient.stderr);
  assert.equal(insufficient.stdout, '');
  assert.match(insufficient.stderr, /HSTACK_MEMORY_CAPACITY/);
  const admitted = await invoke(40 * 1024 * 1024, ['--allow-local-compilation'], { CI: '1' });
  assert.equal(admitted.status, 7, admitted.stderr);
  assert.equal(admitted.stdout, 'compiler-started\n');
  assert.deepEqual(JSON.parse(await readFile(parentState, 'utf8')), { admitted: false },
    'only the producer and compiler leaf may admit this mixed package lifecycle');
  const packageFloorKiB = resolveHeavyweightMemoryFloorKiB('package-dist');
  const localFloor = await invoke(packageFloorKiB - 1, ['--allow-local-compilation'], {}, ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=package-dist', '--', 'node', '-e', '']);
  assert.equal(localFloor.status, 75, localFloor.stderr);
  assert.match(localFloor.stderr, /HSTACK_MEMORY_CAPACITY/);
});

test('worker disk admission rejects an exhausted write filesystem before starting payload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-disk-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher: native } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  const cache = join(root, 'cli/cache');
  await mkdir(join(cache, 'yarn/v6'), { recursive: true });
  await mkdir(join(checkout, 'node_modules'), { recursive: true });
  await writeFile(join(checkout, 'node_modules/data'), 'dependency'.repeat(8192));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // df and memory telemetry are the OS boundaries; filesystem measurement,
  // class admission, process identity and retention execute their real owners.
  await executable(join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000 100000 0 100%% /\\n"\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "28000000 30000000\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  const payload = join(root, 'started');
  const result = spawnSync('/bin/sh', [native, '--heavyweight-admission', '--class=runtime-build', '--machine=worker', '--failure-id=disk-test', '--no-wait', '--', process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', payload], {
    cwd: checkout, encoding: 'utf8', env: { ...executionNeutralEnv, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, HAPPIER_STACK_PM_CACHE_BASE_DIR: cache },
  });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /HSTACK_ADMISSION_DISK:disk-test/);
  await assert.rejects(access(payload), { code: 'ENOENT' });
});

test('inherited admission preserves the parent admission when disk changes during its payload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-disk-escalation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher: native } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  const cache = join(root, 'cli/cache');
  const phase = join(root, 'phase');
  const payload = join(root, 'started');
  await mkdir(join(cache, 'yarn/v6'), { recursive: true });
  await mkdir(join(checkout, 'node_modules'), { recursive: true });
  await writeFile(join(checkout, 'node_modules/data'), 'dependency');
  await writeFile(join(cache, 'native-output'), 'build'.repeat(65536));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Free disk changes between the admitted parent and its nested build.
  await executable(join(bin, 'df'), '#!/bin/sh\nif [ -f "$DISK_PHASE" ]; then free=0; else free=100000; fi\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 200000 100000 %s 50%% /\\n" "$free"\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "28000000 30000000\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  const parent = `require('node:fs').writeFileSync(process.env.DISK_PHASE, 'build');
    const child = require('node:child_process').spawnSync('/bin/sh', [process.argv[1], '--heavyweight-admission', '--class=validation', '--machine=worker', '--failure-id=disk-escalation', '--no-wait', '--', process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', process.argv[2]], {encoding:'utf8',env:{...process.env,HAPPIER_STACK_PM_CACHE_BASE_DIR:process.env.FIXTURE_CACHE}});
    console.log(JSON.stringify({status:child.status,stderr:child.stderr}));`;
  const result = spawnSync('/bin/sh', [native, '--heavyweight-admission', '--class=validation', '--machine=worker', '--no-wait', '--', process.execPath, '-e', parent, native, payload], {
    cwd: checkout, encoding: 'utf8', env: { ...executionNeutralEnv, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, DISK_PHASE: phase, FIXTURE_CACHE: cache },
  });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout.trim());
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /HSTACK_ADMISSION_DISK/);
  assert.equal(await readFile(payload, 'utf8'), 'started');
});

test('runtime control uses the command pool and forwards ACK only after worker READY without replaying a started exit', { timeout: 15000 }, async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  await executable(join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    ' *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    ' *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    ' *" cancel "*) exit 0 ;;',
    ' *remote_execution_custody.sh*)',
    '  printf "starved\\n" >> "$DISPATCHES"',
    '  printf \'HAPPIER_RUNTIME_BUILD_READY={"worker":"starved","runtimeTarget":{"platform":"linux","arch":"x64"}}\\n\'',
    '  IFS= read -r ack || exit 130',
    '  printf "BODY:%s\\n" "$ack"',
    '  exit "${PAYLOAD_EXIT-75}" ;;',
    ' *) exit 0 ;;',
    'esac', '',
  ].join('\n'));
  for (const exitCode of [75, 255, 137]) {
    const child = spawn('/bin/sh', [launcher, '--runtime-build-target=darwin-arm64', '--runtime-build-components=server', '--control-stdin', '--', 'node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], { ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: String(exitCode) }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGTERM'));
    let out = '', err = '', ack = false;
    child.stdout.on('data', chunk => {
      out += chunk;
      if (!ack && out.includes('HAPPIER_RUNTIME_BUILD_READY=')) { ack = true; child.stdin.write('{"requestPath":"/tmp/fixture-request"}\n'); }
    });
    child.stderr.on('data', chunk => { err += chunk; });
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(result.code, exitCode, err);
    assert.match(out, /BODY:\{"requestPath":"\/tmp\/fixture-request"\}/);
  }
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved','starved','starved']);
});

async function runtimeAdmissionTransportFixture(t, { availableKiB = resolveHeavyweightMemoryFloorKiB('validation') - 1 } = {}) {
  const fixture = await memoryRoutingFixture(t, { availableKiB, roomyAvailableKiB: availableKiB, roomyLoad: 12 });
  const workers = {};
  for (const name of ['starved', 'roomy']) {
    workers[name] = await installNativeAdmissionFixture({ root: join(fixture.root, name), prepareDependencies: true });
    workers[name].goRoot = join(fixture.root, name, 'go');
    await mkdir(workers[name].goRoot, { recursive: true });
    for (const evidence of ['LICENSE', 'PATENTS']) await writeFile(join(workers[name].goRoot, evidence), 'Go distribution evidence\n');
    workers[name].pressure = await holdNativeAdmissionFixtureMemory(t, workers[name], { totalKiB: 28311552, availableKiB });
    workers[name].sample = join(fixture.root, `${name}-sample`);
    await writeFile(workers[name].sample, `8 ${name === 'starved' ? '0.1' : '12'} ${availableKiB / 28311552} 22000000 20 0 ${availableKiB} 28311552 0 0 0 0 0 0 0 linux\n`);
  }
  for (const target of fixture.config.targets) {
    target.repoDir = resolve(workers[target.name].launcher, '../../../..');
    await mkdir(join(target.repoDir, 'packages/plugins/cliproxyapi/managed-runtime'), { recursive: true });
  }
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const controller = join(fixture.root, 'worker-controller.mjs');
  await writeFile(controller, `
import { createInterface } from 'node:readline';
const worker = process.env.HAPPIER_RUNTIME_BUILD_WORKER_NAME;
console.log('HAPPIER_RUNTIME_BUILD_READY=' + JSON.stringify({worker,controllerPid:process.pid,runtimeTarget:{platform:process.platform,arch:process.arch}}));
process.stdin.on('end', () => { console.error('fixture-controller-input-EOF:' + worker); process.exitCode = 91; });
createInterface({input:process.stdin}).once('line', line => { console.log('BODY:' + worker + ':' + line); process.exit(Number(process.env.PAYLOAD_EXIT || 0)); });
`);
  await executable(join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await executable(join(fixture.binDir, 'go'), `#!/bin/sh
[ "$1:$2" = env:GOROOT ] || exit 93
# Real Go selects its module toolchain from cwd, not the repository root.
case "$PWD" in */packages/plugins/cliproxyapi/managed-runtime) ;; *) exit 94 ;; esac
[ -z "\${FIXTURE_GO_READS-}" ] || printf 'observed\\n' >> "$FIXTURE_GO_READS"
printf '%s\\n' "$FIXTURE_GO_ROOT"
`);
  await installObservedWorkerLoginShell(fixture.binDir);
  await executable(join(fixture.binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(fixture.binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7,$8}\' "$RUNTIME_WORKER_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/bash',
    'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$*" in *starved-host*) worker=starved; export RUNTIME_WORKER_SAMPLE="$STARVED_SAMPLE"; native="$STARVED_NATIVE" ;; *) worker=roomy; export RUNTIME_WORKER_SAMPLE="$ROOMY_SAMPLE"; native="$ROOMY_NATIVE" ;; esac',
    'case "$worker" in starved) export FIXTURE_GO_ROOT="$STARVED_GO_ROOT" ;; *) export FIXTURE_GO_ROOT="$ROOMY_GO_ROOT" ;; esac',
    'export FIXTURE_PROBE_SAMPLE="$RUNTIME_WORKER_SAMPLE"',
    'for argument in "$@"; do remote=$argument; done',
    'case "$*" in',
    ' *getconf*) eval "$remote" ;;',
    ' *-O\\ check*|*-MNf*) exit 0 ;;',
    ' *remote_execution_custody.sh*)',
    '  case "$remote" in *" cancel "*) eval "$remote"; exit $? ;; esac',
    // Real SSH does not forward Node's private controller test-run marker.
    '  unset NODE_TEST_CONTEXT',
    '  printf "%s\\n" "$worker" >> "$DISPATCHES"',
    '  remote=${remote//"$RUNTIME_REAL_LAUNCHER"/"$native"}',
    '  remote=${remote//"apps/stack/scripts/build/remote_runtime_build.mjs"/"$RUNTIME_CONTROLLER"}',
    '  eval "$remote" ;;',
    ' *) eval "$remote" ;;',
    'esac', '',
  ].join('\n'));
  fixture.invocation.env = { ...fixture.invocation.env, STARVED_SAMPLE: workers.starved.sample, ROOMY_SAMPLE: workers.roomy.sample,
    STARVED_GO_ROOT: workers.starved.goRoot, ROOMY_GO_ROOT: workers.roomy.goRoot,
    STARVED_NATIVE: workers.starved.launcher, ROOMY_NATIVE: workers.roomy.launcher,
    RUNTIME_REAL_LAUNCHER: launcher, RUNTIME_CONTROLLER: controller };
  return { ...fixture, workers };
}

for (const { cancel, typecheck } of [{ cancel: false }, { cancel: true }, { cancel: false, typecheck: true }]) {
  test(`AUTO busy-pool ${typecheck ? 'public typecheck' : 'sweep'} retains one native waiter and ${cancel ? 'cancellation removes only that waiter' : 'runs the payload once after capacity recovers'}`, { skip: process.platform !== 'linux', timeout: 60_000 }, async t => {
    const fixture = await runtimeAdmissionTransportFixture(t);
    delete fixture.invocation.env.NODE_TEST_CONTEXT;
    const belowFloorKiB = resolveHeavyweightMemoryFloorKiB(typecheck ? 'compilation-ui' : 'validation') - 1;
    for (const worker of Object.values(fixture.workers)) {
      await worker.setMemoryObservation({ availableMemoryKiB: belowFloorKiB, totalMemoryKiB: 28311552 });
      await writeFile(worker.sample, `8 0.1 ${belowFloorKiB / 28311552} 22000000 20 0 ${belowFloorKiB} 28311552 0 0 0 0 0 0 0 linux\n`);
    }
    // Equal memory pressure, distinct load: use the existing selection order.
    await writeFile(fixture.workers.roomy.sample, `8 12 ${belowFloorKiB / 28311552} 22000000 20 0 ${belowFloorKiB} 28311552 0 0 0 0 0 0 0 linux\n`);
    for (const target of fixture.config.targets) {
      await writeFile(join(target.repoDir, 'focused.test.mjs'), 'import test from "node:test"; import { appendFileSync } from "node:fs"; test("admitted payload", () => appendFileSync("payload-runs", "once\\n"));\n');
    }
    if (typecheck) {
      // The package-manager process is the boundary. Run the real public
      // compiler runner, selector and nested admission against the worker's
      // real broker; a small invalid project supplies an actual verdict.
      for (const target of fixture.config.targets) {
        const ui = join(target.repoDir, 'apps/ui');
        await mkdir(ui, { recursive: true });
        await writeFile(join(ui, 'tsconfig.busy.json'), JSON.stringify({
          compilerOptions: { noEmit: true, strict: true, types: [] }, files: ['busy.ts'],
        }));
        await writeFile(join(ui, 'busy.ts'), 'const invalid: number = "invalid";\n');
        await writeFile(join(ui, 'typecheck.mjs'), `
import { installWorkspaceAdmissionProcessAdapter } from ${JSON.stringify(new URL('./testkit/core/native_admission_fixture.mjs', import.meta.url).href)};
installWorkspaceAdmissionProcessAdapter({ launcher: ${JSON.stringify(fixture.workers[target.name].launcher)} });
process.argv = [process.execPath, ${JSON.stringify(join(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs'))}, '--noEmit', '-p', 'tsconfig.busy.json'];
await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs')).href)});
`);
      }
      await executable(join(fixture.binDir, 'pnpm'), `#!/bin/sh
case "$*" in
  *typecheck:*) exec ${JSON.stringify(process.execPath)} "$PWD/typecheck.mjs" ;;
  *typecheck*) exec /bin/sh ../stack/bin/hstack-exec --script=typecheck:local ;;
  *) printf '12.14.0\\n' ;;
esac
`);
    }
    const command = typecheck ? ['pnpm', 'run', 'typecheck'] : ['node', '--test', 'focused.test.mjs'];
    const child = spawn('/bin/sh', [launcher, ...(typecheck ? ['--cwd=apps/ui'] : []), '--', ...command], fixture.invocation);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
    const waitingWorker = fixture.workers.starved;
    if (typecheck) {
      await waitForRuntime(() => /HSTACK_(?:[A-Z_]*_)?BUSY|queued on /.test(stderr),
        () => `public typecheck never reported its placement outcome:\n${stderr}`);
      assert.match(stderr, /HSTACK_MEMORY_BUSY/, 'abandoned pool attempts expose their native reason');
    }
    await waitForRuntime(async () => (await waitingWorker.brokerStatus()).waitingCount === 1,
      () => `full busy sweep never retained its native queue position:\n${stderr}`);
    const queued = await waitingWorker.brokerStatus();
    const costs = async () => {
      const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
      return {
        dispatches: (await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'),
        selections: (stderr.match(/\[preferred-execution\] selected /g) ?? []).length,
        sync: trace.split('\n').filter(line => line.startsWith('mutagen:')).length,
        bootstrap: trace.split('\n').filter(line => line.startsWith('ssh:') && line.includes('remote_dependency_bootstrap.mjs')).length,
      };
    };
    const initialCosts = await costs();
    assert.deepEqual(initialCosts.dispatches, ['starved', 'roomy', 'starved'], 'one full capacity sweep, then the best eligible native queue');
    assert.match(stderr, /HSTACK_MEMORY_BUSY/, 'abandoned pool attempts expose their native reason');
    assert.equal((stderr.match(/queued on starved for memory, waiting \(Ctrl-C cancels\)/g) ?? []).length, 1,
      'the retained queue must be visible exactly once before any verdict');
    assert.doesNotMatch(stderr, /admitted on /, 'waiting is not admission');
    assert.equal(payloadOutput(stdout), '');
    // Let a real pressure retry elapse. Waiting must not re-sync or bootstrap.
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(await costs(), initialCosts, 'routing, sync and bootstrap work grew while queued');
    const idle = await waitingWorker.brokerStatus();
    // The broker's existing catch-up clock observes external RAM recovery.
    // Those observations must preserve demand without repeating placement.
    assert.deepEqual({ ...idle, sampleCount: queued.sampleCount }, queued,
      'idle native demand must retain its queue position across recovery observations');
    if (cancel) {
      const neighbor = spawn('/bin/sh', [waitingWorker.launcher, '--heavyweight-admission', '--class=runtime-build',
        '--machine=worker', '--', '/usr/bin/true'], { ...fixture.invocation, stdio: 'ignore' });
      const neighborExit = new Promise(resolve => neighbor.once('close', resolve));
      t.after(async () => { if (neighbor.exitCode === null && neighbor.signalCode === null) neighbor.kill('SIGTERM'); await neighborExit; });
      await waitForRuntime(async () => (await waitingWorker.brokerStatus()).waitingCount === 2, () => 'unrelated socket waiter did not join');
      child.kill('SIGTERM');
      assert.deepEqual(await exited, { code: 130, signal: null }, stderr);
      await waitForRuntime(async () => (await waitingWorker.brokerStatus()).waitingCount === 1, () => 'cancelled native waiter remained');
      assert.equal(neighbor.exitCode, null, 'cancelling one caller preserves the unrelated socket waiter');
      await assert.rejects(access(join(fixture.config.targets[0].repoDir, 'payload-runs')), { code: 'ENOENT' });
    } else {
      await waitingWorker.pressure.release(() => writeFile(waitingWorker.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n'));
      assert.deepEqual(await exited, { code: typecheck ? 2 : 0, signal: null }, stderr);
      if (typecheck) assert.match(stdout, /TS2322/, 'the queued public typecheck must produce its compiler verdict');
      else assert.equal(await readFile(join(fixture.config.targets[0].repoDir, 'payload-runs'), 'utf8'), 'once\n');
      assert.equal((stderr.match(/queued on /g) ?? []).length, 1, 'queue output must not repeat while waiting');
      assert.equal((stderr.match(/admitted on starved/g) ?? []).length, 1, 'capacity recovery announces admission once');
      assert.equal((await waitingWorker.brokerStatus()).waitingCount, 0);
      assert.deepEqual(await costs(), initialCosts);
    }
  });
}


function startRuntimeController(t, fixture, extra = {}, { target = 'darwin-arm64', components = 'server', nodeOptions = [] } = {}) {
  const child = spawn('/bin/sh', [launcher, `--runtime-build-target=${target}`, `--runtime-build-components=${components}`, '--control-stdin', '--', 'node', ...nodeOptions, 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], { ...fixture.invocation, env: { ...fixture.invocation.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  const result = { child, stdout: '', stderr: '', completion: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) };
  child.stdout.on('data', chunk => { result.stdout += chunk; });
  child.stderr.on('data', chunk => { result.stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await result.completion; });
  return result;
}

async function waitForRuntime(predicate, message) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message());
}

test('runtime placement switches only after an alternative is actually admitted and cancels the original queue', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const runtime = startRuntimeController(t, fixture);
  const waiters = join(fixture.workers.starved.admissionRoot, 'waiters');
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 1, () => runtime.stderr);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  try {
    await waitForRuntime(() => runtime.stdout.includes('"worker":"roomy"'), () => runtime.stderr);
  } catch (error) {
    error.message += `\nstdout:\n${runtime.stdout}\ntransport trace:\n${await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8')}`;
    throw error;
  }
  assert.doesNotMatch(runtime.stdout, /BODY:/);
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 0, () => runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:roomy:/, runtime.stderr);
  assert.doesNotMatch(runtime.stdout, /BODY:starved:/);
});

test('runtime alternatives observe a recovered worker on the next cadence despite unavailable caches', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const down = join(fixture.root, 'roomy-down');
  await writeFile(down, '');
  const ssh = join(fixture.binDir, 'ssh');
  const body = await readFile(ssh, 'utf8');
  await executable(ssh, body.replace('#!/bin/bash\n', '#!/bin/bash\ncase "$*" in *roomy-host*) [ ! -f "$WORKER_DOWN" ] || exit 255 ;; esac\n'));
  const runtime = startRuntimeController(t, fixture, { WORKER_DOWN: down });
  const waiters = join(fixture.workers.starved.admissionRoot, 'waiters');
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 1 && runtime.stderr.includes('roomy command preflight failed'), () => runtime.stderr);
  const [original] = await readdir(waiters);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await rm(down);
  try {
    await waitForRuntime(() => runtime.stdout.includes('"worker":"roomy"'), () => runtime.stderr);
  } catch (error) {
    error.message += `\nstdout:\n${runtime.stdout}\ntransport trace:\n${await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8')}`;
    throw error;
  }
  assert.doesNotMatch(runtime.stdout, /BODY:/);
  runtime.child.stdin.write('{"requestPath":"/tmp/recovered-runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:roomy:/);
  await waitForRuntime(async () => !(await readdir(waiters)).includes(original), () => runtime.stderr);
});

test('daemon placement prefers a native worker over a less-loaded capable cross builder', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  for (const worker of Object.values(fixture.workers)) await worker.pressure.release(() => writeFile(worker.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n'));
  const ssh = join(fixture.binDir, 'ssh');
  const body = await readFile(ssh, 'utf8');
  // The remote OS/capability probe is the boundary: both workers are eligible,
  // but only roomy matches the requested daemon's native support target.
  await executable(ssh, body.replace(' *getconf*)', [
    ' *componentArtifactTarget.mjs*)',
    '   /usr/bin/awk \'{print; print $7, 0, $8, 0}\' "$RUNTIME_WORKER_SAMPLE"',
    '   case "$worker" in roomy) printf "linux-arm64\\n" ;; *) printf "linux-x64\\n" ;; esac ;;',
    ' *getconf*)',
  ].join('\n')));
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  const runtime = startRuntimeController(t, fixture, {}, { target: 'linux-arm64', components: 'daemon' });
  await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY='), () => runtime.stderr);
  assert.match(runtime.stdout, /"worker":"roomy"/, runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/native-daemon-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  for (const worker of Object.values(fixture.workers)) worker.pressure = await holdNativeAdmissionFixtureMemory(t, worker, { totalKiB: 28311552, availableKiB: 9437184 });
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.3 22000000 20 0 9437184 28311552 0 0 0 0 0 0 0 linux\n');
  await writeFile(fixture.workers.roomy.sample, '8 12 0.3 22000000 20 0 9437184 28311552 0 0 0 0 0 0 0 linux\n');
  const queued = startRuntimeController(t, fixture, {}, { target: 'linux-arm64', components: 'daemon' });
  await waitForRuntime(async () => (await fixture.workers.roomy.brokerStatus()).waitingCount === 1 || (await fixture.workers.starved.brokerStatus()).waitingCount === 1, () => queued.stderr);
  assert.doesNotMatch(queued.stdout, /HAPPIER_RUNTIME_BUILD_READY=|BODY:/);
  const dispatches = (await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n');
  assert.equal(dispatches.length, 2, 'the queued runtime has one capable worker dispatch');
  const selected = dispatches[1];
  assert.ok(selected === 'roomy' || selected === 'starved');
  const selectedWorker = fixture.workers[selected];
  assert.equal((await selectedWorker.brokerStatus()).waitingCount, 1);
  await selectedWorker.pressure.release(() => writeFile(selectedWorker.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n'));
  await waitForRuntime(() => queued.stdout.includes('HAPPIER_RUNTIME_BUILD_READY='), () => queued.stderr);
  const ready = queued.stdout.split('\n').find(line => line.startsWith('HAPPIER_RUNTIME_BUILD_READY='));
  assert.equal(JSON.parse(ready.slice('HAPPIER_RUNTIME_BUILD_READY='.length)).worker, selected);
  queued.child.stdin.write('{"requestPath":"/tmp/queued-native-daemon-request"}\n');
  assert.equal((await queued.completion).code, 0, queued.stderr);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), dispatches, 'admission must not replay the runtime payload');
});

test('runtime alternatives keep evaluating the pool while another alternative is flushing', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  fixture.config.targets.push({ ...fixture.config.targets[1], name: 'recovered', ssh: 'recovered-host' });
  fixture.config.commandExecution.targets.push('recovered');
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const down = join(fixture.root, 'recovered-down');
  const flushing = join(fixture.root, 'alternative-flushing');
  await writeFile(down, '');
  const ssh = join(fixture.binDir, 'ssh');
  await executable(ssh, (await readFile(ssh, 'utf8')).replace('#!/bin/bash\n', '#!/bin/bash\ncase "$*" in *recovered-host*) [ ! -f "$RECOVERED_DOWN" ] || exit 255 ;; esac\n'));
  const mutagen = join(fixture.binDir, 'mutagen');
  await executable(mutagen, (await readFile(mutagen, 'utf8')).replace('#!/bin/sh\n', '#!/bin/sh\ncase "$*" in *"flush happier-roomy"*) : > "$ALTERNATIVE_FLUSHING"; exec /bin/sleep 60 ;; esac\n'));
  const runtime = startRuntimeController(t, fixture, { RECOVERED_DOWN: down, ALTERNATIVE_FLUSHING: flushing });
  await waitForRuntime(async () => (await readdir(join(fixture.workers.starved.admissionRoot, 'waiters')).catch(() => [])).length === 1, () => runtime.stderr);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await waitForRuntime(async () => access(flushing).then(() => true, () => false), () => runtime.stderr);
  await rm(down);
  await waitForRuntime(() => runtime.stdout.includes('"worker":"recovered"'), () => runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/pool-recovered-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:recovered:/);
});

test('runtime worker eligibility uses the command pool, physical class floor and canonical component capability', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  for (const worker of Object.values(fixture.workers)) await worker.pressure.release();
  fixture.config.targets[0].name = 'mac2-linux';
  fixture.config.targets.push({ ...fixture.config.targets[1], name: 'linux1', ssh: 'metro-host' });
  fixture.config.commandExecution.targets = ['mac2-linux','roomy'];
  fixture.config.runtimePlacement.build = { mode: 'prefer-target', targets: ['roomy'], fallback: 'local' };
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await writeFile(fixture.workers.roomy.sample, '8 0.1 0.9 22000000 20 0 15000000 16000000 0 0 0 0 0 0 0 linux\n');
  const runtime = startRuntimeController(t, fixture);
  await waitForRuntime(() => runtime.stdout.includes('"worker":"mac2-linux"'), () => runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stderr, /HSTACK_PLACEMENT_EXCLUDED target=roomy reason=memory-capacity /);
  assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), /metro-host/);
  const daemon = spawn('/bin/sh', [launcher, '--runtime-build-target=darwin-arm64', '--runtime-build-components=daemon', '--control-stdin', '--', 'node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], { ...fixture.invocation, stdio: ['pipe','pipe','pipe'] });
  let error = '';
  daemon.stderr.on('data', chunk => { error += chunk; });
  const code = await new Promise(resolve => daemon.once('close', resolve));
  assert.equal(code, 1, error);
  assert.match(error, /daemon:.*host-native runtime packages require a matching host target/);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved'], 'cached server eligibility bypassed daemon capability filtering');
});

for (const heavy of [false, true]) test(`AUTO concurrent cached placements spread in proportion to probed cores (${heavy ? 'zero memory headroom' : 'light commands'})`, { skip: process.platform !== 'linux', timeout: 60000 }, async t => {
  const completions = [];
  let release;
  t.after(async () => { if (release) await writeFile(release, ''); await Promise.all(completions); });
  const fixture = await memoryRoutingFixture(t);
  fixture.config.commandExecution.loadProbeTtlMs = 300000;
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const available = heavy ? 0 : 14000000;
  await executable(join(fixture.binDir, 'ssh'), `#!/bin/sh
case "$*" in
  *getconf*)
    case "$*" in *starved-host*) cores=2 ;; *) cores=6 ;; esac
    printf '%s 0 0.5 22000000 20 0 ${available} 28000000 0 0 0 0 0 0 0 linux ${available} 0 28000000 0\\n' "$cores" ;;
  *) exit 0 ;;
esac
`);
  // Create the cached observation through its real producer so the burst
  // consumes the same prerequisite/cwd identity that selected the first call.
  const command = heavy ? ['vitest', 'run', 'fixture.test.ts'] : ['probe-command'];
  const initial = spawnSync('/bin/sh', [launcher, '--', ...command], fixture.invocation);
  assert.equal(initial.status, 0, initial.stderr);
  release = join(fixture.root, 'release-placements');
  await executable(join(fixture.binDir, 'ssh'), `#!/bin/sh
case "$*" in
  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;
esac
while [ ! -f "$PLACEMENT_RELEASE" ]; do sleep 0.02; done
exit 0
`);
  // The incident had 19 simultaneous waiters on an eight-core worker. Keep
  // every fixture dispatch live so all 24 selections see the same cached probe.
  // Coordination 2026-10-30 14:41 D5 coalesces identical commands. Placement
  // distribution still needs 24 distinct payloads, rather than 24 subscribers.
  const selections = Array.from({ length: 24 }, (_, index) => new Promise((resolveSelection, rejectSelection) => {
    const child = spawn('/bin/sh', [launcher, '--', ...command, `placement-${index}`], {
      ...fixture.invocation, env: { ...fixture.invocation.env, PLACEMENT_RELEASE: release },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const selected = stderr.match(/selected (starved|roomy) /);
      if (selected) resolveSelection(selected[1]);
    });
    completions.push(new Promise(resolveExit => child.once('close', code => {
      if (!/selected (starved|roomy) /.test(stderr)) rejectSelection(new Error(`no placement: exit=${code}\n${stderr}`));
      resolveExit({ code, stderr });
    })));
    child.once('error', rejectSelection);
  }));
  const targets = await Promise.all(selections);
  await writeFile(release, '');
  const results = await Promise.all(completions);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const small = targets.filter(name => name === 'starved').length;
  t.diagnostic(JSON.stringify({ placements: targets.length, small, large: targets.length - small }));
  assert.ok(small >= 5 && small <= 7, `2:6 cores must share 24 cached placements approximately 6:18; got ${small}:${24 - small}`);
});

test('AUTO missing controller Mutagen leaves shared worker availability and placements untouched', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  const invoke = env => spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    ...fixture.invocation, env,
  });
  const warm = invoke(fixture.invocation.env);
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /remote:starved/);
  const cacheDir = join(fixture.stackDir, 'dev-target-command-load-native');
  const paths = (await readdir(cacheDir)).filter(name => name.endsWith('.cache') || name === 'provenance.jsonl');
  const before = await Promise.all(paths.map(name => readFile(join(cacheDir, name), 'utf8')));
  const traceBefore = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  const mutagenPath = join(fixture.binDir, 'mutagen');
  const mutagen = await readFile(mutagenPath, 'utf8');
  await rm(mutagenPath);
  // Restrict only the external executable search path. Cached worker facts,
  // command classification, selection and sync-control logic remain real.
  const missingEnv = { ...fixture.invocation.env, PATH: `${fixture.binDir}:/usr/bin:/bin` };
  assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v mutagen'], { env: missingEnv }).status, 0,
    'the missing-tool control must not find a system Mutagen installation');
  const missing = invoke(missingEnv);
  assert.equal(missing.status, 127, missing.stderr);
  assert.doesNotMatch(missing.stderr, /selected (starved|roomy) /);
  assert.deepEqual(await Promise.all(paths.map(name => readFile(join(cacheDir, name), 'utf8'))), before,
    'a controller prerequisite failure must not rewrite healthy worker facts or publish a placement');
  assert.equal(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), traceBefore,
    'a missing controller tool must fail before remote observations or synchronization');
  await executable(mutagenPath, mutagen);
  const restored = invoke(fixture.invocation.env);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /remote:starved/);
});

test('AUTO cached placement compares load per core before choosing a smaller worker', async t => {
  const fixture = await memoryRoutingFixture(t, { roomyLoad: 24 });
  await writeFile(fixture.samplePath, '8 16 0.5 22000000 20 0 14000000 28000000 0 0 0 0 0 0 0 linux 14000000\n');
  const sshPath = join(fixture.binDir, 'ssh');
  await writeFile(sshPath, (await readFile(sshPath, 'utf8')).replace('8 24 ', '48 24 '));
  // k=1 derives from one runnable load unit per probed core, not a new cap.
  // 16/8 is above that capacity and must lose to 24/48 despite lower raw load.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], fixture.invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /remote:roomy/);
  }
});

test('native runtime control admits web, mixed web and daemon, and all runtime components', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  for (const worker of Object.values(fixture.workers)) await worker.pressure.release();
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  for (const components of ['web', 'web,daemon', 'web,server,daemon']) {
    const runtime = startRuntimeController(t, fixture, {}, { target: `${process.platform}-${process.arch}`, components });
    await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY=') || runtime.child.exitCode !== null, () => runtime.stderr);
    assert.equal(runtime.child.exitCode, null, `${components} exited before admission: ${runtime.stderr}`);
    assert.match(runtime.stdout, /"worker":"starved"/);
    assert.doesNotMatch(runtime.stdout, /BODY:/);
    runtime.child.stdin.write('{"requestPath":"/tmp/runtime-web-request"}\n');
    assert.equal((await runtime.completion).code, 0, `${components}: ${runtime.stderr}`);
    assert.match(runtime.stdout, /BODY:starved:/);
  }
});

test('native runtime admission preserves Node preload arguments and runs the hook in the admitted controller before READY', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  for (const worker of Object.values(fixture.workers)) await worker.pressure.release();
  const hook = 'console.error("fixture-preload:" + process.pid + ":" + process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT)';
  const module = 'data:text/javascript;base64,' + Buffer.from(hook).toString('base64');
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  for (const nodeOptions of [[`--import=${module}`], ['--import', module]]) {
    const runtime = startRuntimeController(t, fixture, {}, { nodeOptions });
    await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY=') || runtime.child.exitCode !== null, () => runtime.stderr);
    assert.equal(runtime.child.exitCode, null, runtime.stderr);
    const preload = runtime.stderr.match(/^fixture-preload:(\d+):(\d+)$/m);
    assert.ok(preload, runtime.stderr);
    const readyLine = runtime.stdout.split('\n').find(line => line.startsWith('HAPPIER_RUNTIME_BUILD_READY='));
    const ready = JSON.parse(readyLine.slice('HAPPIER_RUNTIME_BUILD_READY='.length));
    assert.equal(Number(preload[1]), ready.controllerPid, 'preload ran in a different process from the admitted controller');
    runtime.child.stdin.write('{"requestPath":"/tmp/runtime-preload-request"}\n');
    assert.equal((await runtime.completion).code, 0, runtime.stderr);
    assert.match(runtime.stdout, /BODY:starved:/);
  }
});

test('EOF before runtime READY removes only its retained worker demand', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const runtime = startRuntimeController(t, fixture);
  const worker = fixture.workers.starved;
  await waitForRuntime(async () => (await worker.brokerStatus()).waitingCount === 1, () => runtime.stderr);
  runtime.child.stdin.end();
  assert.equal((await runtime.completion).code, 130, runtime.stderr);
  await waitForRuntime(async () => (await worker.brokerStatus()).waitingCount === 0, () => runtime.stderr);
  assert.equal(payloadOutput(runtime.stdout), '');
});

test('native launcher hands Mac workspace execution to the configured execution-host bridge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-native-host-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const stackHome = join(root, 'stack-home');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackHome, { recursive: true });
  await writeFile(join(stackHome, 'execution-host.json'), '{}');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
  const invocation = { cwd: repoRoot, encoding: 'utf8', env: {
    ...executionNeutralEnv, HOME: root, HAPPIER_STACK_HOME_DIR: stackHome,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    HAPPIER_STACK_EXECUTION_HOST_REENTRY: '', CI: '', HAPPIER_STACK_SANDBOX_DIR: '',
    PATH: `${binDir}:/usr/bin:/bin`,
  } };
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'literal argument'], invocation);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${repoRoot}/apps/stack/bin/../scripts/execution_host_bridge.mjs`,
    `--native-launcher=${launcher}`, '--', 'probe-command', 'literal argument',
  ]);
  const local = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command'], invocation);
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.stdout, 'unexpected-local\n');
});

test('runtime skip targets accepts comma and whitespace while retaining configured names outside the pool', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  fixture.config.targets.push({ ...fixture.config.targets[0], name: 'configured-only' });
  fixture.config.targets.push({ name: 'windows-only', platform: 'windows', ssh: 'win-host',
    repoDir: 'C:/repo', cliHomeDir: 'C:/home' });
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  for (const skip of ['starved configured-only windows-only', 'starved,configured-only,windows-only', ' \tstarved,,\n configured-only, windows-only, ']) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
      ...fixture.invocation,
      env: { ...fixture.invocation.env, HSTACK_EXEC_RUNTIME_SKIP_TARGETS: skip },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /roomy/);
    assert.doesNotMatch(result.stdout, /starved/);
  }
});

test('runtime skip targets rejects unknown names before automatic or explicit remote work', async (t) => {
  const fixture = await memoryRoutingFixture(t);
  for (const selection of [[], ['--target=roomy']]) {
    const result = spawnSync('/bin/sh', [launcher, ...selection, '--', 'probe-command'], {
      ...fixture.invocation,
      env: { ...fixture.invocation.env, HSTACK_EXEC_RUNTIME_SKIP_TARGETS: 'starvd' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HSTACK_EXEC_RUNTIME_SKIP_TARGETS/);
    assert.match(result.stderr, /starvd/);
    await assert.rejects(access(fixture.invocation.env.FIXTURE_TRACE), { code: 'ENOENT' });
    await assert.rejects(access(fixture.invocation.env.DISPATCHES), { code: 'ENOENT' });
  }
});

test('runtime skip targets refreshes a future-dated legacy projection without trusting an inherited name field', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  const projectionPath = join(fixture.stackDir, 'dev-target-exec-v1.sh');
  const legacy = (await readFile(projectionPath, 'utf8')).replace(/^configured_target_names=.*\n/m, '');
  await writeFile(projectionPath, legacy);
  const future = new Date(Date.now() + 60000);
  await utimes(projectionPath, future, future);
  const result = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', 'probe-command'], {
    ...fixture.invocation,
    env: { ...fixture.invocation.env, HSTACK_EXEC_RUNTIME_SKIP_TARGETS: 'starved', configured_target_names: 'stale-only' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /roomy/);
  assert.match(await readFile(projectionPath, 'utf8'), /^configured_target_names=/m);
});

// Keep the low-load worker below focused admission while its nonheavy score
// remains ahead of the roomy worker, including the owner's memory-pressure cost.
async function memoryRoutingFixture(t, { availableKiB = resolveHeavyweightMemoryFloorKiB('focused-validation') / 2, totalKiB = 28311552, roomyLoad = 12, roomyAvailableKiB = 25480397, roomyTotalKiB = 28311552, fallback = 'error' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-memory-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, 'repo-memory');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  const config = {
    version: 3,
    targets: ['starved', 'roomy'].map((name) => ({
      name, platform: 'posix', ssh: `${name}-host`, repoDir: repoRoot,
      cliHomeDir: join(root, name), remotePath: [binDir, '/usr/bin', '/bin'],
    })),
    runtimePlacement: {
      server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'auto', targets: ['starved', 'roomy'], includeLocal: false, fallback },
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot }));
  const samplePath = join(root, 'starved-sample');
  await writeFile(samplePath, `8 0.1 ${availableKiB / totalKiB} 22000000 20 0 ${availableKiB} ${totalKiB} 0 0 0 0 0 0 0 linux ${availableKiB}\n`);
  await executable(join(binDir, 'node'), `#!/bin/sh
case "\${1-}" in
  */native_execution_projection.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;
esac
case "$*" in *service_memory.mjs*) printf "service 0\\n"; exit 0 ;; esac
printf "node:%s\\n" "$*" >> "$FIXTURE_TRACE"
exit 0
`);
  // Yarn is external, but its package scripts remain real: a public script
  // can own a nested launcher dispatch rather than the outer manager process.
  const packageManager = `#!/bin/sh
[ "\${1-}" = yarn ] && shift
[ "\${1-}" != --version ] || { printf '1.22.22\\n'; exit 0; }
manager_cwd=$PWD
while [ "$#" -gt 0 ]; do
  case "$1" in --cwd) manager_cwd=$2; shift 2 ;; -s|--silent) shift ;; *) break ;; esac
done
manager_script=\${1-}; [ "$#" -eq 0 ] || shift
manager_body=$(${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).scripts?.[process.argv[2]] || "")' "$manager_cwd/package.json" "$manager_script") || exit $?
case "$manager_body" in
  *hstack-exec\\ --script=*) cd "$manager_cwd"; exec /bin/sh -c "$manager_body \\"\\$@\\"" fixture-manager "$@" ;;
  *) exit 97 ;;
esac
`;
  for (const name of ['corepack', 'yarn']) await executable(join(binDir, name), packageManager);
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "mutagen:%s\\n" "$*" >> "$FIXTURE_TRACE"\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\nexit 0\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'for argument in "$@"; do remote=$argument; done',
    '[ "$remote" != : ] || exit 0',
    'case "$*" in',
    '  *getconf*)',
    '    case "$*" in',
    '      *starved-host*) cat "$STARVED_SAMPLE" ;;',
    `      *) printf "8 ${roomyLoad} ${roomyAvailableKiB / roomyTotalKiB} 22000000 20 0 ${roomyAvailableKiB} ${roomyTotalKiB} 0 0 0 0 0 0 0 linux ${roomyAvailableKiB}\\n" ;;`,
    '    esac ;;',
    '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *)',
    '    case "$*" in *starved-host*) name=starved ;; *) name=roomy ;; esac',
    '    printf "%s\\n" "$name" >> "$DISPATCHES"',
    '    [ "${PAYLOAD_EXIT-0}" = 137 ] && exit 137',
    '    printf "remote:%s\\n" "$name" ;;',
    'esac',
    '',
  ].join('\n'));
  return {
    root, binDir, configPath, config, stackDir, samplePath,
    invocation: { cwd: repoRoot, encoding: 'utf8', env: {
      ...executionNeutralEnv, HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath, HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_HOME_DIR: join(root, 'home'), HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      // The JS entry point fills missing toolchain paths at the front. Include
      // those directories here so our OS/transport fixtures retain precedence.
      PATH: `${binDir}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      DISPATCHES: join(root, 'dispatches'),
      FIXTURE_TRACE: join(root, 'trace'),
      STARVED_SAMPLE: samplePath,
    } },
  };
}

test('AUTO sends small suites to a free peer when the broker head reserves the other host', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 11600000, roomyLoad: 80 });
  // Unix socket paths must stay short even under a remote custody TMPDIR.
  const root = await mkdtemp('/tmp/happier-rank-');
  const broker = createAdmissionBroker({ root, oldLockPath: join(root, 'old.lock'),
    // OS boundary: reproduce nl1's physical sample while retaining real queue policy.
    sampleResources: async () => ({ availableMemoryKiB: 11600000, totalMemoryKiB: 33554432 }) });
  await broker.start();
  const head = createConnection(brokerAddress(root));
  t.after(async () => { head.destroy(); await broker.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { head.once('connect', resolve); head.once('error', reject); });
  head.write(JSON.stringify({ kind: 'acquire', className: 'compilation-ui', floorKiB: 27262976,
    pid: process.pid, repoDir: fixture.root, locks: [], env: {} }) + '\n');
  await waitForRuntime(() => broker.status().waitingCount === 1, () => 'the big head did not enter admission');
  const budget = broker.status();
  await writeFile(fixture.samplePath, `8 0.1 0.35 22000000 20 0 11600000 33554432 0 0 0 0 0 0 0 linux ${budget.unreservedMemoryKiB} 0 33554432 ${budget.queuedMemoryKiB}\n`);
  for (const cached of [false, true]) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n', `cached=${cached}: a fitting peer must precede the reserved head`);
  }
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['roomy', 'roomy'],
    'a small suite must not spend preparation on the head-reserved host');
});



async function controllerCoalescingFixture(t) {
  const fixture = await memoryRoutingFixture(t);
  await executable(join(fixture.binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  const connections = [];
  const gate = createServer(socket => { connections.push(socket); socket.write('ready'); });
  await new Promise(resolveListen => gate.listen(join(fixture.root, 'gate.sock'), resolveListen));
  t.after(() => { for (const socket of connections) socket.destroy(); gate.close(); });
  const payload = `const net = require('node:net'); const s = net.connect(${JSON.stringify(join(fixture.root, 'gate.sock'))}); s.once('data', () => { process.stdout.write('payload-started\\n'); process.stdout.write(Buffer.from([0,255])); process.stderr.write('payload-stderr\\n'); }); s.on('end', () => process.exit(7));`;
  await executable(join(fixture.binDir, 'ssh'), `#!/bin/sh
case "$*" in
  *remote_execution_custody.sh*" cancel "*) exit 0 ;;
  *getconf*) printf '8 0 0.1 22000000 20 0 25480397 28311552 0 0 0 0 0 0 0 linux 25480397\\n' ;;
  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;
  *remote_execution_custody.sh*) exec ${JSON.stringify(process.execPath)} -e '${payload.replaceAll("'", "'\\''")}' ;;
  *) exit 0 ;;
esac
`);
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); });
  function start({ args = ['probe-command', 'coalescing'], env = {}, options = [], isolatedController = false } = {}) {
    const invocation = [launcher, ...options, '--', ...args];
    const child = spawn(isolatedController ? process.execPath : '/bin/sh', isolatedController ? [
      join(repoRoot, 'apps/stack/scripts/utils/dev_targets/controller_coalescing.mjs'),
      fixture.root, repoRoot, '0', '', invocation.map(posixQuote).join(' '),
    ] : invocation, {
      ...fixture.invocation, env: { ...fixture.invocation.env, ...env },
    });
    children.push(child);
    let stdout = '', stderr = '';
    const stdoutChunks = [];
    t.after(() => {
      if (!stdout.includes('payload-started\n')) t.diagnostic(stderr.split('\n').filter(line => !/\:\/\/|bearer |token|secret|password|api_?key|credential|database_url|-----begin|private_key/i.test(line)).join('\n'));
    });
    let ready, joined, failed;
    const started = new Promise((resolveStarted, rejectStarted) => { ready = resolveStarted; failed = rejectStarted; });
    const attached = new Promise(resolveJoined => { joined = resolveJoined; });
    child.stdout.on('data', chunk => { stdoutChunks.push(chunk); stdout += chunk; if (stdout.includes('payload-started\n')) { ready(); joined(); } });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('[preferred-execution] coalesced queued')) joined(); });
    const result = new Promise(resolveExit => child.once('close', code => {
      if (!stdout.includes('payload-started\n')) failed(new Error(`payload did not start: exit=${code}; ${stderr}`));
      resolveExit({ code, stdout: Buffer.concat(stdoutChunks), stderr });
    }));
    return { child, started, attached, result };
  }
  return { connections, start, privateControllerRepo: fixture.root };
}

test('controller coalescing shares one AUTO dispatch with full output replay and exit status', { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const { start, connections } = await controllerCoalescingFixture(t);
  const first = start(); await first.started;
  const second = start(); await second.started;
  const dispatches = connections.length;
  for (const socket of connections) socket.end();
  const results = await Promise.all([first.result, second.result]);
  assert.equal(dispatches, 1, 'identical callers must produce exactly one outbound payload dispatch');
  for (const result of results) {
    assert.equal(result.code, 7);
    assert.deepEqual(result.stdout, Buffer.concat([Buffer.from('payload-started\n'), Buffer.from([0, 255])]));
    assert.match(result.stderr, /payload-stderr/);
  }
  assert.equal(results[0].stderr, results[1].stderr, 'both callers receive the same stderr replay');
  const next = start(); await next.started;
  assert.equal(connections.length, 2, 'a completed result must never serve a new invocation');
  connections[1].end();
  assert.equal((await next.result).code, 7);
});

for (const variant of ['argv', 'env', 'cwd', 'ssh-agent']) test(`controller coalescing keeps different ${variant} in distinct dispatches`, { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const { start, connections } = await controllerCoalescingFixture(t);
  const first = start(); await first.started;
  const second = start(variant === 'argv' ? { args: ['probe-command', 'different'] }
    : variant === 'env' ? { env: { HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' } }
      : variant === 'ssh-agent' ? { env: { SSH_AUTH_SOCK: '/fixture/different-agent.sock' } }
      : { options: ['--cwd=apps/stack'] });
  await second.started;
  assert.equal(connections.length, 2);
  for (const socket of connections) socket.end();
  await Promise.all([first.result, second.result]);
});

test('controller coalescing queues exactly one whole-package typecheck follower for five requesters', { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const { start, connections } = await controllerCoalescingFixture(t);
  const request = { args: ['tsc', '--noEmit', '-p', 'apps/stack/tsconfig.json'] };
  const first = start(request); await first.started;
  const followers = Array.from({ length: 5 }, () => start(request));
  await Promise.all(followers.map(follower => follower.attached));
  const activeDispatches = connections.length;
  connections[0].end();
  await first.result;
  assert.equal(activeDispatches, 1, 'five later typechecks must wait behind the current run');
  await Promise.all(followers.map(follower => follower.started));
  assert.equal(connections.length, 2, 'five requesters must share exactly one follower dispatch');
  connections[1].end();
  for (const result of await Promise.all(followers.map(follower => follower.result))) assert.equal(result.code, 7);
});

test('controller coalescing keeps a shared job after first cancellation and ends it after last cancellation', { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const { start, connections } = await controllerCoalescingFixture(t);
  const first = start(); await first.started;
  const second = start(); await second.started;
  assert.equal(connections.length, 1);
  first.child.kill('SIGTERM');
  await first.result;
  assert.equal(connections[0].destroyed, false, 'remaining caller must retain the dispatch');
  const closed = new Promise(resolveClose => connections[0].once('close', resolveClose));
  second.child.kill('SIGTERM');
  await Promise.all([second.result, closed]);
});

test('controller coalescing ends its real dispatch when its private broker is killed', { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const { start, connections, privateControllerRepo } = await controllerCoalescingFixture(t);
  const first = start({ isolatedController: true }); await first.started;
  const observed = spawnSync(process.execPath, [
    join(repoRoot, 'apps/stack/scripts/utils/dev_targets/controller_coalescing.mjs'), '--status', privateControllerRepo,
  ], { encoding: 'utf8' });
  assert.equal(observed.status, 0);
  const status = JSON.parse(observed.stdout);
  assert.equal(status.dispatchPids.length, 1);
  let jobSettled = false;
  t.after(() => { if (!jobSettled) for (const pid of status.dispatchPids) { try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } });
  const closed = new Promise(resolveClose => connections[0].once('close', resolveClose));
  // This service belongs only to this fixture's private repo; never terminate
  // the shared checkout's controller or any other lane's command.
  process.kill(status.pid, 'SIGKILL');
  assert.equal((await first.result).code, 1);
  await closed;
  jobSettled = true;
});


test('automatic placement excludes mac-host unless it is in the configured command pool', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  fixture.config.targets[0].name = 'mac-host';
  fixture.config.commandExecution.targets = ['roomy'];
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const automatic = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], fixture.invocation);
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.match(automatic.stderr, /selected roomy /);
  assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), /starved-host/);
  fixture.config.commandExecution.targets.push('mac-host');
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const configured = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], fixture.invocation);
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stderr, /selected mac-host /);
});

test('native launcher ranks reserved memory below the class floor behind a fitting worker', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 80 });
  // The transport supplies the admission owner's observed unreserved budget;
  // classification, cached scoring and selection execute the real launcher.
  await writeFile(fixture.samplePath, '8 0.1 0.99 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux 9437184\n');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], fixture.invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n', 'CPU-idle worker without room for the class must rank behind a fitting worker, including from cache');
  }
  const light = spawnSync('/bin/sh', [launcher, '--', 'rg', 'source'], fixture.invocation);
  assert.equal(light.status, 0, light.stderr);
  assert.equal(light.stdout, 'remote:starved\n', 'heavy reservations must not exclude lightweight work');
});

test('automatic placement flushes an eligible no-watch first-cycle worker before dispatch', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  const marker = join(fixture.root, 'flushed');
  await executable(join(fixture.binDir, 'mutagen'), [
    '#!/bin/sh',
    'printf "mutagen:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$2" in',
    '  flush) : > "$FIRST_CYCLE_MARKER" ;;',
    '  list)',
    '    scanned=0; cycles=0',
    '    if [ -e "$FIRST_CYCLE_MARKER" ]; then scanned=1; cycles=1; fi',
    '    printf "%s|Watching|false|true|%s|0/0|0/0|true|%s|0/0|0/0|active|%s|ok|0|0|WatchModeNoWatch|WatchModeNoWatch\\n" "$3" "$scanned" "$scanned" "$cycles" ;;',
    'esac',
  ].join('\n'));
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, FIRST_CYCLE_MARKER: marker },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected starved /);
  assert.equal(result.stdout.trim(), 'remote:starved');
  const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  assert.ok(trace.indexOf('mutagen:sync flush') < trace.lastIndexOf('remote_execution_custody.sh'), trace);
  assert.equal((trace.match(/mutagen:sync flush/g) ?? []).length, 1);
});

for (const { problem, flushes, selectRoomy = false, projectEvidence = false } of [
  { problem: 'unable to relocate staged file: file exists', flushes: 1 },
  { problem: 'unable to swap file: unable to set staged file permissions: unable to set permission bits: chmod /staging/evidence: no such file or directory', flushes: 2, projectEvidence: true },
  { problem: 'unable to swap file: unable to set staged file permissions: unable to set permission bits: chmod /staging/source: no such file or directory', flushes: 3 },
  { problem: 'unable to set staged file permissions: chmod /staging/source: no such file or directory', flushes: 3, selectRoomy: true },
]) test(projectEvidence ? 'automatic placement settles project evidence churn arising during its flush with one rescan'
  : selectRoomy ? 'automatic placement never flushes an unselected transient mirror'
  : flushes === 1 ? 'automatic placement recovers a transient staged-file problem in its requested cycle'
    : 'automatic placement reports a remaining staged-file problem after its requested cycle', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  if (!selectRoomy && flushes > 2) {
    fixture.config.commandExecution.targets = ['starved'];
    await writeFile(fixture.configPath, JSON.stringify(fixture.config));
    await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  }
  if (selectRoomy) {
    const sample = (await readFile(fixture.samplePath, 'utf8')).trim().split(' ');
    sample[1] = '200';
    await writeFile(fixture.samplePath, sample.join(' ') + '\n');
  }
  const marker = join(fixture.root, 'collision-cleared');
  await executable(join(fixture.binDir, 'mutagen'), [
    '#!/bin/sh',
    'printf "mutagen:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$2" in',
    '  flush) [ "$3" != happier-starved ] || printf "cycle\\n" >> "$COLLISION_MARKER"; printf "\\rForcing synchronization cycle for session fixture\\r" ;;',
    '  list)',
    '    transition=0/0',
    `    if [ "$3" = happier-starved ] && [ "$(wc -l < "$COLLISION_MARKER" 2>/dev/null || printf 0)" -lt ${flushes} ]${projectEvidence ? ' && [ -e "$COLLISION_MARKER" ]' : ''}; then transition=1/0; fi`,
    `    printf "%s|${projectEvidence ? 'Scanning' : 'Watching'}|false|true|1|0/0|0/0|true|1|0/0|%s|active|2|ok|0|0\\n" "$3" "$transition"`,
    `    [ "$transition" = 0/0 ] || printf '%s\\n' ${posixQuote(`${projectEvidence ? '.project/plans/2026-10-23-calm-shell/lanes/ATMOS-DARK-captures/matrix.json' : 'fixture/source.mjs'}|${problem}`)} ;;`,
    'esac',
  ].join('\n'));
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, COLLISION_MARKER: marker },
  });
  const unresolved = !selectRoomy && flushes > 2;
  assert.equal(result.status, unresolved ? 1 : 0, result.stderr);
  assert.equal(result.stdout.trim(), unresolved ? '' : selectRoomy ? 'remote:roomy' : 'remote:starved',
    `an unresolved transfer must settle before dispatch while recovery preserves load-based selection: ${result.stderr}`);
  const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  if (selectRoomy) {
    assert.equal((trace.match(/mutagen:sync flush happier-starved\b/g) ?? []).length, 0,
      'an unselected mirror must not hold placement behind its rescan barrier');
    await assert.rejects(access(marker), { code: 'ENOENT' });
    return;
  }
  assert.match(result.stderr, /needs a fresh scan/);
  assert.match(result.stderr, /Forcing synchronization cycle/, 'flush progress must stay observable on the diagnostic stream');
  if (unresolved) {
    assert.match(result.stderr, /HSTACK_SYNC_PROBLEM:.*fixture\/source\.mjs/);
    assert.doesNotMatch(trace, /remote_execution_custody\.sh/);
  } else {
    assert.ok(trace.indexOf('mutagen:sync flush') < trace.lastIndexOf('remote_execution_custody.sh'), trace);
  }
  assert.equal((trace.match(/mutagen:sync flush/g) ?? []).length, Math.min(flushes, 2),
    'the selected worker crosses its requested cycle and at most one classified rescan');
});

test('remote admission state failure is typed before payload dispatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-admission-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await installNativeAdmissionFixture({ root });
  await mkdir(fixture.admissionRoot);
  await writeFile(join(fixture.admissionRoot, 'waiters'), 'not a directory');
  const result = spawnSync('/bin/sh', [fixture.launcher, '--heavyweight-admission', '--failure-id=native-io-test', '--', '/bin/sh', '-c', 'echo unexpected-payload'], {
    cwd: root, encoding: 'utf8', env: executionNeutralEnv,
  });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^HSTACK_ADMISSION_UNAVAILABLE:native-io-test$/m);
});

test('automatic placement reroutes admission I/O failure with unavailable TTL and preserves payload exit 75', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *starved-host*)',
    '    case "$*" in *remote_execution_custody.sh*) ;; *) exit 0 ;; esac',
    '    printf "starved\\n" >> "$DISPATCHES"',
    '    for argument in "$@"; do remote=$argument; done',
    '    id=$(printf "%s\\n" "$remote" | sed -n "s/.*--failure-id=\\(native-[A-Za-z0-9_-]*\\).*/\\1/p")',
    '    printf "HSTACK_ADMISSION_UNAVAILABLE:%s\\n" "$id" >&2',
    '    exit 75 ;;',
    '  *) printf "roomy\\n" >> "$DISPATCHES"; printf "payload-result\\n"; exit "${PAYLOAD_EXIT-0}" ;;',
    'esac',
    '',
  ].join('\n'));
  const first = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /payload-result/);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy']);
  const second = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: '75' },
  });
  assert.equal(second.status, 75, second.stderr);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'roomy']);
});

test('automatic disk rejection reroutes only this class and cannot replay a started payload', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12, fallback: 'local' });
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    ' *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    ' *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    ' *remote_execution_custody.sh*)',
    '  case "$*" in *starved-host*) name=starved ;; *) name=roomy ;; esac',
    '  printf "%s\\n" "$name" >> "$DISPATCHES"',
    '  case "$*" in *starved-host*--heavyweight-admission*)',
    '    for argument in "$@"; do remote=$argument; done',
    '    id=$(printf "%s\\n" "$remote" | sed -n "s/.*--failure-id=\\(native-[A-Za-z0-9_-]*\\).*/\\1/p")',
    '    printf "HSTACK_ADMISSION_DISK:%s\\n" "$id" >&2; exit 75 ;;',
    '  esac',
    '  printf "payload:%s\\n" "$name"; exit "${PAYLOAD_EXIT-0}" ;;',
    ' *) exit 0 ;;',
    'esac', '',
  ].join('\n'));
  const heavy = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.equal(heavy.status, 0, heavy.stderr);
  assert.match(heavy.stderr, /disk budget rejected/);
  assert.match(heavy.stdout, /payload:roomy/);
  const search = spawnSync('/bin/sh', [launcher, '--', 'rg', 'source'], fixture.invocation);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /payload:starved/, 'build disk rejection must not exclude a source search');
  const failedPayload = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: '75' },
  });
  assert.equal(failedPayload.status, 75, failedPayload.stderr);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'starved', 'starved', 'roomy']);
});


async function installBusyAdmissionTransport(fixture) {
  // SSH is the process boundary. The native busy certification is exercised
  // separately above; no selector or admission domain logic is substituted.
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$*" in',
    ' *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    ' *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    ' *)',
    '  case "$*" in *remote_execution_custody.sh*) ;; *) exit 0 ;; esac',
    '  case "$*" in *starved-host*) name=starved ;; *) name=roomy ;; esac',
    '  printf "%s\\n" "$name" >> "$DISPATCHES"',
    '  attempts=$(wc -l < "$DISPATCHES")',
    '  case "$*" in',
    '   *--no-wait*)',
    '    if [ "$name" = starved ] || [ "$attempts" -le "${BUSY_ATTEMPTS-0}" ]; then',
    '     for argument in "$@"; do remote=$argument; done',
    '     id=$(printf "%s\\n" "$remote" | sed -n "s/.*--failure-id=\\([A-Za-z0-9_-]*\\).*/\\1/p")',
    '     printf "HSTACK_ADMISSION_BUSY:%s\\n" "$id" >&2',
    '     exit 75',
    '    fi ;;',
    '   *) printf "[preferred-execution] waiting for heavyweight admission on pinned fixture\\n" >&2 ;;',
    '  esac',
    '  printf "payload:%s\\n" "$name"; exit "${PAYLOAD_EXIT-0}" ;;',
    'esac', '',
  ].join('\n'));
}

test('automatic admission reroutes busy workers without an unavailable TTL while pins keep waiting', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  const controller = await isolatedRoutingController(fixture);
  await installBusyAdmissionTransport(fixture);
  for (const payloadExit of [0, 75]) {
    const result = spawnSync('/bin/sh', [controller, '--', 'node', '--test', 'focused.test.mjs'], {
      ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: String(payloadExit) }, timeout: 15_000,
    });
    assert.equal(result.status, payloadExit, result.stderr);
    assert.equal(result.stdout, 'payload:roomy\n');
    assert.match(result.stderr, /HSTACK_MEMORY_BUSY/,
      'the waiting person must see the canonical reason for each abandoned preparation');
  }
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'starved', 'roomy']);
  const pinned = spawnSync('/bin/sh', [controller, '--target=starved', '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, 'payload:starved\n');
  assert.match(pinned.stderr, /waiting for heavyweight admission on pinned/);
  const commands = (await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8')).split('\n').filter(line => line.includes('remote_execution_custody.sh') && line.includes('--heavyweight-admission'));
  assert.match(commands[0], /--no-wait/);
  assert.doesNotMatch(commands.at(-1), /--no-wait/);
});

test('AUTO busy-pool queue selection excludes a worker whose final sync flush fails', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  await installBusyAdmissionTransport(fixture);
  await executable(join(fixture.binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; exit 0; fi',
    'if [ "$2" = flush ] && [ "$3" = happier-starved ]; then',
    '  if [ -f "$FINAL_SYNC_ATTEMPT" ]; then exit 73; fi',
    '  : > "$FINAL_SYNC_ATTEMPT"',
    'fi',
    'exit 0', '',
  ].join('\n'));
  const result = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
    ...fixture.invocation, timeout: 15_000,
    env: { ...fixture.invocation.env, BUSY_ATTEMPTS: '2', FINAL_SYNC_ATTEMPT: join(fixture.root, 'first-flush') },
  });
  assert.equal(result.status, 0, 'a formerly busy worker stayed eligible after its sync failure');
  assert.equal(result.stdout, 'payload:roomy\n');
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'roomy']);
  assert.match(result.stderr, /selected target sync flush failed: starved/);
  assert.doesNotMatch(result.stderr, /running locally/);
});

test('hosted CI public compiler scripts execute locally on a small host and preserve nested dispatch and failure', async (t) => {
  const { root, invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 16373452 });
  // Mocked physical memory belongs to this isolated worker, not the live host
  // whose unrelated reservations must not affect the simulated CI capacity.
  const { launcher } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  invocation.cwd = join(root, 'native-owner');
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(binDir, 'pnpm'), [
    '#!/bin/sh',
    'printf "script:%s:routed=%s:ci=%s:argument=%s\\n" "$3" "${HAPPIER_HSTACK_EXECUTION-unset}" "${CI-unset}" "${4-}"',
    'case "$3" in',
    '  typecheck:compiler:local) exec /bin/sh "$TEST_LAUNCHER" --script=typecheck:local -- "literal argument" ;;',
    '  typecheck:local) exit 23 ;;',
    '  *) exit 97 ;;',
    'esac',
    '',
  ].join('\n'));
  for (const configured of [true, false]) {
    const env = {
      ...invocation.env, CI: 'true', GITHUB_ACTIONS: 'true', TEST_LAUNCHER: launcher,
      npm_node_execpath: '', npm_execpath: '',
      ...(configured ? {} : {
        HAPPIER_EXEC_CONFIG_PATH: '',
        HAPPIER_STACK_STORAGE_DIR: join(invocation.env.HOME, 'unconfigured-stacks'),
      }),
    };
    const result = spawnSync('/bin/sh', [launcher, '--script=typecheck:compiler:local'], { ...invocation, env, timeout: 10_000 });
    assert.equal(result.status, 23, JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr, stdout: result.stdout }));
    const expectedOutput = [
      'script:typecheck:compiler:local:routed=1:ci=true:argument=',
      'script:typecheck:local:routed=1:ci=true:argument=literal argument',
    ];
    assert.deepEqual(result.stdout.trim().split('\n'), expectedOutput);
    assert.doesNotMatch(result.stderr, /heavyweight admission|memory capacity/);
    await assert.rejects(readFile(invocation.env.FIXTURE_TRACE), { code: 'ENOENT' });
    await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });

    const development = spawnSync('/bin/sh', [launcher, '--local', '--allow-local-compilation', '--script=typecheck:compiler:local'], {
      ...invocation, env: { ...env, CI: '', GITHUB_ACTIONS: '' }, timeout: 10_000,
    });
    assert.equal(development.status, 75, development.stderr);
    assert.equal(development.stdout, '');
    assert.match(development.stderr, /HSTACK_MEMORY_CAPACITY/);

    const explicitlyAdmitted = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=fixture', '--', '/bin/sh', launcher, '--script=typecheck:compiler:local'], {
      ...invocation, env, timeout: 10_000,
    });
    assert.equal(explicitlyAdmitted.status, 23, explicitlyAdmitted.stderr);
    assert.deepEqual(explicitlyAdmitted.stdout.trim().split('\n'), expectedOutput);
    assert.doesNotMatch(explicitlyAdmitted.stderr, /HSTACK_MEMORY_CAPACITY/);

    const placedWorker = spawnSync('/bin/sh', [launcher, '--script=typecheck:compiler:local'], {
      ...invocation, env: { ...env, HAPPIER_DEV_TARGET_EXECUTION: '1' }, timeout: 10_000,
    });
    assert.equal(placedWorker.status, 75, placedWorker.stderr);
    assert.equal(placedWorker.stdout, '');
    assert.match(placedWorker.stderr, /HSTACK_MEMORY_CAPACITY/);
  }
});

test('finite typecheck dispatch is granted by public script owners on remote and explicit local paths', async (t) => {
  const fixture = await memoryRoutingFixture(t, { roomyAvailableKiB: 41943040, roomyTotalKiB: 50331648 });
  const { invocation } = fixture;
  // Permission checks consume a ready fixture tree, never the mutable primary
  // install. Real readiness and permission policy remain in place.
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root, prepareDependencies: true });
  const checkout = resolve(launcher, '../../../..');
  invocation.cwd = checkout;
  for (const target of fixture.config.targets) target.repoDir = checkout;
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot: checkout }));
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'pnpm'), '#!/bin/sh\nprintf "dispatch=%s\\n" "${HAPPIER_TYPECHECK_DISPATCHED-}"\n');
  for (const script of ['typecheck:local', 'typecheck:compiler:local', 'check:public-sdk:finite:local']) {
    const local = spawnSync('/bin/sh', [launcher, '--local', `--script=${script}`], invocation);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, 'dispatch=1\n');
    await writeFile(invocation.env.FIXTURE_TRACE, '');
    const remote = spawnSync('/bin/sh', [launcher, `--script=${script}`], invocation);
    assert.equal(remote.status, 0, remote.stderr);
    assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /export HAPPIER_TYPECHECK_DISPATCHED=1;/);
  }
  const direct = spawnSync('/bin/sh', [launcher, '--local', '--script=typecheck:source:finite'], invocation);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, 'dispatch=\n', 'host selection alone must not grant finite task permission');
});

test('native dispatch consumes the shared source-test, generator, compiler and admission decisions', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  for (const { args, kind, component } of [
    { args: ['yarn', 'workspace', '@happier-dev/server', 'build'], kind: 'runtime', component: 'apps/server' },
    { args: ['yarn', 'workspace', '@happier-dev/app', 'test:unit:local'], kind: 'source-test', component: 'apps/ui' },
    { args: ['node', '--conditions=happier-source', '--import', 'tsx', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], kind: 'source-test', component: 'apps/stack' },
    { args: ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'], kind: 'source-test', component: 'packages/plugin-sdk' },
    { args: ['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs'], kind: 'runtime', component: 'apps/ui' },
    { args: ['node', '--test', 'apps/stack/scripts/config.test.mjs'], kind: 'runtime', component: 'apps/stack' },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'], kind: 'runtime', component: 'apps/cli' },
    { args: ['node', '--conditions=happier-source', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check', '--scope', 'projections'], kind: 'source-test', component: 'apps/cli' },
    { args: ['tsc', '-p', 'apps/cli/tsconfig.json'], kind: 'typecheck', component: 'apps/cli' },
    { args: ['yarn', '-s', 'lint'], kind: 'runtime', component: '' },
  ]) {
    await writeFile(invocation.env.FIXTURE_TRACE, '');
    const result = spawnSync('/bin/sh', [launcher, '--', ...args], invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n', args.join(' '));
    const trace = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
    assert.match(trace, /remote_dependency_bootstrap\.mjs/);
    assert.match(trace, /--execution-placement=remote/, 'only worker mirrors receive dependency mutation authority');
    assert.ok(trace.includes('--validation-kind=' + kind), trace);
    assert.ok(trace.includes('--component-relative-dir=' + component), trace);
    assert.equal(trace.includes('--component-relative-dir=' + repoRoot), false, 'preparation transports repository-relative components');
    if (component) assert.match(trace, /remote_validation_preparation\.mjs/);
  }
  await writeFile(invocation.env.FIXTURE_TRACE, '');
  const control = spawnSync('/bin/sh', [launcher, '--', 'node', '-e', 'console.log("control")'], invocation);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(control.stdout, 'remote:starved\n');
  assert.doesNotMatch(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /remote_dependency_bootstrap\.mjs|remote_validation_preparation\.mjs/);
});

test('native local fallback prepares dependencies through the local policy owner', async t => {
  const fixture = await memoryRoutingFixture(t, { fallback: 'local' });
  const native = await installNativeAdmissionFixture({ root: fixture.root, prepareDependencies: true });
  const checkout = resolve(native.launcher, '../../../..');
  await installCliNativeCustodySourceFixture(checkout);
  const cliDir = join(checkout, 'apps/cli');
  const nativeSource = join(cliDir, 'native/processcustody/main.go');
  const nativeExecutable = join(cliDir, 'tools/unpacked/happier-process-custody');
  await mkdir(dirname(nativeSource), { recursive: true });
  await mkdir(dirname(nativeExecutable), { recursive: true });
  fixture.invocation.cwd = cliDir;
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot: checkout }));
  // Transport failure is external. The real launcher still classifies the
  // payload and owns fallback/preparation before invoking the command.
  await executable(join(fixture.binDir, 'ssh'), '#!/bin/sh\nexit 255\n');
  // This keeper now executes the real native preparation worker. Its kernel
  // must agree with Node's platform; the generic routing fixture uses Darwin
  // only to avoid executing unrelated Linux resource owners.
  await executable(join(fixture.binDir, 'uname'), `#!/bin/sh\nprintf '${process.platform === 'linux' ? 'Linux' : 'Darwin'}\\n'\n`);
  await executable(join(fixture.binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "73400320 73400320\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh\nprintf 'node:%s\\n' "$*" >> "$FIXTURE_TRACE"\nexec ${JSON.stringify(process.execPath)} "$@"\n` });
  await executable(join(fixture.binDir, 'go'), `#!/bin/sh
${process.platform === 'linux' ? '[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" ] || exit 91' : ''}
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output=$1; fi
  shift
done
cat '${nativeSource}' > "$output"
`);
  await executable(join(fixture.binDir, 'vitest'), `#!/bin/sh
[ ! -e '${join(checkout, '.project/tmp/cli-dist-build.lock')}' ] || exit 92
cat '${nativeExecutable}'
`);
  const emptyStorage = join(fixture.root, 'empty-stacks');
  await mkdir(emptyStorage, { recursive: true });
  for (const [route, options, env] of [
    ['fallback', [], {}],
    ['explicit-local', ['--local'], {}],
    ['no-config', [], { HAPPIER_EXEC_CONFIG_PATH: '', HAPPIER_STACK_STORAGE_DIR: emptyStorage }],
  ]) {
    await writeFile(nativeSource, `current-native:${route}\n`);
    await writeFile(nativeExecutable, 'stale native output');
    const result = spawnSync('/bin/sh', [native.launcher, ...options, '--', 'vitest', 'run', 'fixture.test.ts'], {
      ...fixture.invocation, env: { ...fixture.invocation.env, ...env },
    });
    assert.equal(result.status, 0, `${route}: ${result.stderr}`);
    assert.equal(result.stdout, `current-native:${route}\n`);
  }
  const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  assert.match(trace, /remote_dependency_bootstrap\.mjs[^\n]*--execution-placement=local/,
    'fallback must select read-only primary readiness instead of worker installation');
});

for (const discovery of ['token', 'repository']) {
  test(`implicit execution config ${discovery}: an explicit neighbor cannot override default discovery`, async t => {
    const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000 });
    const stackDir = discovery === 'token' ? join(dirname(fixture.stackDir), `repo-${repoToken}-identity`) : fixture.stackDir;
    await mkdir(stackDir, { recursive: true });
    const configPath = join(stackDir, 'dev-targets.json');
    const config = { ...fixture.config, targets: fixture.config.targets.filter(target => target.name === 'roomy'),
      commandExecution: { mode: 'auto', targets: ['roomy'], includeLocal: false, fallback: 'error' } };
    await writeFile(configPath, JSON.stringify(config));
    const neighborPath = join(stackDir, 'neighbor.json');
    const neighbor = { version: 3, targets: [], commandExecution: { mode: 'auto', includeLocal: true, fallback: 'local' } };
    await writeFile(neighborPath, JSON.stringify(neighbor));
    await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(neighbor,
      { repoRoot, configPath: neighborPath }));
    await executable(join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    await executable(join(fixture.binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
    const invoke = path => spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
      ...fixture.invocation, env: { ...fixture.invocation.env, HAPPIER_EXEC_CONFIG_PATH: path,
        HAPPIER_STACK_STORAGE_DIR: discovery === 'repository'
          ? relative(repoRoot, dirname(stackDir)) : dirname(stackDir) },
    });
    const intentional = invoke(neighborPath);
    assert.equal(intentional.status, 0, intentional.stderr);
    assert.equal(intentional.stdout, 'wrong-local\n');
    await utimes(configPath, new Date(0), new Date(0));
    const discovered = invoke('');
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.equal(discovered.stdout, 'remote:roomy\n', 'discovery must not borrow the neighboring explicit policy');
  });
}

for (const dispatcher of ['native', 'javascript']) {
  const dispatch = (invocation, args) => dispatcher === 'native'
    ? spawnSync('/bin/sh', [launcher, '--', ...args], invocation)
    : spawnSync(process.execPath, [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', ...args], invocation);

  test(`queue policy ${dispatcher}: all memory-busy targets remain remotely eligible`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 0, roomyAvailableKiB: 5242880, fallback: 'local' });
    const result = dispatch(invocation, ['vitest', 'run', 'fixture.test.ts']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n');
    assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /--heavyweight-admission/);
    assert.doesNotMatch(result.stderr, /running locally|insufficient validation memory/);
  });

  test(`compilation capacity ${dispatcher}: typechecks and builds exclude small workers but focused tests remain eligible`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 15728640, roomyLoad: 80, roomyAvailableKiB: 41943040, roomyTotalKiB: 50331648 });
    const focused = dispatch(invocation, ['vitest', 'run', 'fixture.test.ts']);
    assert.equal(focused.status, 0, focused.stderr);
    assert.equal(focused.stdout, 'remote:starved\n');
    for (const args of [
      ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'],
      ['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'build'],
      ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/ui/tsconfig.source.json'],
    ]) {
      await writeFile(invocation.env.FIXTURE_TRACE, '');
      const result = dispatch(invocation, args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'remote:roomy\n', args.join(' '));
      const trace = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
      const policy = await resolvePackageCommandPolicy(args, { repoRoot, cwd: repoRoot, env: invocation.env });
      // Publishers own their reservation; compiler consumers receive the
      // shared policy's envelope after workspace preparation.
      if (policy.selfPublisher === '1') assert.doesNotMatch(trace, /--heavyweight-admission/);
      else assert.match(trace, new RegExp(`--heavyweight-admission.*--class=${policy.heavyClass}`));
    }
    const focusedAgain = dispatch(invocation, ['vitest', 'run', 'fixture.test.ts']);
    assert.equal(focusedAgain.status, 0, focusedAgain.stderr);
    assert.equal(focusedAgain.stdout, 'remote:starved\n');
  });

  test(`compilation capacity ${dispatcher}: an undersized fleet fails visibly without local fallback`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 15728640, roomyAvailableKiB: 14680064, roomyTotalKiB: 15728640, fallback: 'local' });
    const result = dispatch(invocation, ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`memory capacity.*compilation.*${resolveHeavyweightMemoryFloorKiB('compilation-ui')}`));
    assert.doesNotMatch(result.stderr, /running locally/);
    await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
  });

  test(`workload admission ${dispatcher}: source package builds fit a small worker while strict compilers and full runtime builds need a larger worker`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 15728640, totalKiB: 16777216, roomyLoad: 80, roomyAvailableKiB: 41943040, roomyTotalKiB: 50331648 });
    invocation.env.HAPPIER_WORKSPACE_BUILD_MODE = 'strict';
    for (const args of [
      ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build'],
      ['node', 'packages/cli-common/scripts/build.mjs'],
      ['corepack', 'yarn', '--cwd', 'packages/protocol', '-s', 'build:finite'],
      ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'],
      ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'],
      ['corepack', 'yarn', '--cwd', 'packages/unmeasured', '-s', 'build'],
    ]) {
      await writeFile(invocation.env.FIXTURE_TRACE, '');
      const result = dispatch(invocation, args);
      assert.equal(result.status, 0, result.stderr);
      const runtime = args.some(arg => arg.startsWith('--worker-request='));
      const small = args.join(' ').includes('packages/cli-common');
      const selfAdmitting = small || args.join(' ').includes('packages/protocol');
      assert.equal(result.stdout, small ? 'remote:starved\n' : 'remote:roomy\n', args.join(' '));
      const trace = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
      if (selfAdmitting) assert.doesNotMatch(trace, /--heavyweight-admission/, 'publication and compiler leaves own capacity after workspace preparation');
      else assert.match(trace, runtime ? /--class=runtime-build/ : /--class=compilation/);
    }
  });

  test(`compilation capacity ${dispatcher}: capable workers remain eligible while memory is busy`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 0, roomyAvailableKiB: 5242880, roomyTotalKiB: 50331648, fallback: 'local' });
    const result = dispatch(invocation, ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n');
    assert.doesNotMatch(result.stderr, /running locally/);
  });

  for (const allFail of [false, true]) {
    test(`queue policy ${dispatcher}: sync failure ${allFail ? 'on every reachable target cannot fall back locally' : 'retries the next reachable target'}`, async (t) => {
      const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
      const binDir = invocation.env.PATH.split(':')[0];
      await executable(join(binDir, 'mutagen'), [
        '#!/bin/sh',
        'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; exit 0; fi',
        allFail ? 'exit 73' : '[ "$3" != happier-starved ] || exit 73',
        'exit 0', '',
      ].join('\n'));
      await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
      const result = dispatch(invocation, ['probe-command']);
      if (allFail) {
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
        assert.match(result.stderr, /synchronization|sync.*flush/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'remote:roomy\n');
        assert.equal(await readFile(invocation.env.DISPATCHES, 'utf8'), 'roomy\n');
      }
      assert.doesNotMatch(result.stderr, /running locally/);
    });
  }

  for (const status of [76, 255]) {
    test(`queue policy ${dispatcher}: ${status === 255 ? 'unreachable fleet permits configured local fallback' : 'reachable prerequisite failure cannot fall back locally'}`, async (t) => {
      const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
      const binDir = invocation.env.PATH.split(':')[0];
      await executable(join(binDir, 'ssh'), `#!/bin/sh\nexit ${status}\n`);
      await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "local-fallback\\n"\n');
      const result = dispatch(invocation, ['probe-command']);
      assert.equal(result.status, status === 255 ? 0 : 1, result.stderr);
      assert.equal(result.stdout, status === 255 ? 'local-fallback\n' : '');
      if (status === 255) assert.match(result.stderr, /no remote execution target is reachable.*running locally/);
      else assert.doesNotMatch(result.stderr, /running locally/);
    });
  }

  test(`memory-aware ${dispatcher} dispatcher avoids a low-CPU target below validation headroom`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t);
    const result = dispatcher === 'native'
      ? spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation)
      : spawnSync(process.execPath, [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
    assert.equal(result.status, 0, `${result.stderr}\n${await readFile(invocation.env.FIXTURE_TRACE, 'utf8').catch(() => '')}`);
    assert.equal(result.stdout, 'remote:roomy\n');
  });
}

test('memory-aware cache ranks heavyweight work using a trivial command reachable result', async (t) => {
  const { invocation, stackDir } = await memoryRoutingFixture(t);
  const trivial = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
  assert.equal(trivial.status, 0, trivial.stderr);
  assert.equal(trivial.stdout, 'remote:starved\n');
  const heavy = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(heavy.status, 0, heavy.stderr);
  assert.equal(heavy.stdout, 'remote:roomy\n');
  assert.match(await readFile(join(stackDir, 'dev-target-command-load-native', 'starved.cache'), 'utf8'), /^\d+ 1 /);
});

test('typecheck affinity prefers the most recently completed project worker and falls back immediately when busy', async t => {
  const fixture = await memoryRoutingFixture(t, {
    availableKiB: 40000000, totalKiB: 45000000,
    roomyAvailableKiB: 40000000, roomyTotalKiB: 45000000, roomyLoad: 12,
  });
  const args = ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/cli/tsconfig.source.json'];
  const warm = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', ...args], fixture.invocation);
  assert.equal(warm.status, 0, warm.stderr);
  const repeat = spawnSync('/bin/sh', [launcher, '--', ...args, '--pretty', 'false'], fixture.invocation);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, 'remote:roomy\n', 'warm worker should win despite higher load');
  const other = spawnSync('/bin/sh', [launcher, '--', ...args.slice(0, -1), 'apps/ui/tsconfig.source.json'], fixture.invocation);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.stdout, 'remote:starved\n', 'another project must use normal selection');
  await installBusyAdmissionTransport(fixture);
  // The warm target is starved for the UI project. Actual nonblocking admission
  // rejects it; AUTO must immediately use the other worker, without a TTL.
  const fallback = spawnSync('/bin/sh', [launcher, '--', ...args.slice(0, -1), 'apps/ui/tsconfig.source.json'], {
    ...fixture.invocation, timeout: 15000,
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout, 'payload:roomy\n');
  assert.match(fallback.stderr, /admission busy before dispatch/);
  assert.doesNotMatch(fallback.stderr, /waiting for pool|running locally/);
});

test('warm project preference also applies to other compilation-class checks without coalescing builds', async t => {
  const fixture = await memoryRoutingFixture(t, {
    availableKiB: 40000000, totalKiB: 45000000,
    roomyAvailableKiB: 40000000, roomyTotalKiB: 45000000, roomyLoad: 12,
  });
  const args = ['yarn', '--cwd', 'apps/cli', '-s', 'build'];
  const warm = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', ...args], fixture.invocation);
  assert.equal(warm.status, 0, warm.stderr);
  const repeat = spawnSync('/bin/sh', [launcher, '--', ...args], fixture.invocation);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, 'remote:roomy\n');
  assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), /typecheck_dispatch\.mjs/);
});

test('in-flight typecheck demand stays on its leader worker and every follower flushes', { timeout: 20000 }, async t => {
  const fixture = await memoryRoutingFixture(t, {
    availableKiB: 40000000, totalKiB: 45000000,
    roomyAvailableKiB: 40000000, roomyTotalKiB: 45000000, roomyLoad: 12,
  });
  const ssh = join(fixture.binDir, 'ssh');
  const original = await readFile(ssh, 'utf8');
  await executable(ssh, original.replace('printf "remote:%s\\n" "$name"', `printf "remote:%s\\n" "$name"
    if [ "\${HOLD_TYPECHECK-0}" = 1 ]; then
      while [ ! -f "$RELEASE_TYPECHECK" ]; do sleep 0.02; done
    fi`));
  const args = ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/cli/tsconfig.source.json'];
  const release = join(fixture.root, 'release');
  const leader = spawn('/bin/sh', [launcher, '--target=roomy', '--', ...args], {
    ...fixture.invocation, env: { ...fixture.invocation.env, HOLD_TYPECHECK: '1', RELEASE_TYPECHECK: release },
  });
  t.after(() => { if (leader.exitCode === null) leader.kill('SIGTERM'); });
  const completed = new Promise(resolve => leader.once('close', resolve));
  let output = '';
  leader.stdout.on('data', data => { output += data; });
  leader.stderr.resume();
  await waitForRuntime(() => output.includes('remote:roomy'), () => output);
  // A shared cache can be read from another PID namespace. Keep the real
  // controller's flock held, but make its recorded PID/start identity resolve
  // to a different incarnation in this caller, as that boundary does live.
  const cacheDir = join(fixture.stackDir, 'dev-target-command-load-native');
  const reservation = (await readdir(cacheDir)).find(name => name.startsWith('roomy.active.'));
  assert.ok(reservation, 'the running leader must own a dispatch reservation');
  const reservationPath = join(cacheDir, reservation);
  const record = (await readFile(reservationPath, 'utf8')).split('\n');
  record[0] = String(process.pid);
  record[3] = '0';
  await writeFile(reservationPath, record.join('\n'));
  try {
    const probe = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', 'probe-command'], fixture.invocation);
    assert.equal(probe.status, 0, probe.stderr);
    assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), new RegExp(`reaping remote execution ${record[2]}`), 'an unrelated command must not cancel the live leader');
    assert.match(probe.stderr, /selected roomy .*active=1/, 'a held kernel lock must count even when its controller PID is not current here');
    const follower = spawnSync('/bin/sh', [launcher, '--', ...args], fixture.invocation);
    assert.equal(follower.status, 0, follower.stderr);
    assert.equal(follower.stdout, 'remote:roomy\n', 'follower must reach the existing flight instead of a colder worker');
  } finally {
    await writeFile(release, '');
    assert.equal(await completed, 0);
  }
  const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  assert.equal((trace.match(/mutagen:sync flush/g) ?? []).length, 3, 'each caller needs its own causal barrier');
});

test('memory-aware exit 137 carries target memory evidence without replaying an authoritative command', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    ...invocation, env: { ...invocation.env, PAYLOAD_EXIT: '137' },
  });
  assert.equal(result.status, 137, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /137.*SIGKILL.*possible.*(?:OOM|out.of.memory)/i);
  assert.match(result.stderr, /starved.*5242880.*28311552/);
  assert.equal(await readFile(invocation.env.DISPATCHES, 'utf8'), 'starved\n');
});

test('memory-aware placement weighs memory pressure above the absolute admission floor', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { availableKiB: 8388608 });
  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:roomy\n');
});

test('heavyweight placement ranks absolute unreserved headroom ahead of free-memory percentage', async t => {
  const { invocation } = await memoryRoutingFixture(t, {
    availableKiB: 24 * 1024 * 1024, totalKiB: 32 * 1024 * 1024,
    roomyAvailableKiB: 64 * 1024 * 1024, roomyTotalKiB: 256 * 1024 * 1024, roomyLoad: 0.1,
  });
  // Both workers fit the class and have the same CPU load. The larger worker
  // has more room for this command despite a lower percentage of free RAM.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', 'apps/ui/tsconfig.json'], invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n', 'fresh and cached samples must rank the actual class headroom');
  }
});

test('memory-aware Darwin probe measures absolute headroom through the native dispatch path', async (t) => {
  const { invocation, stackDir } = await memoryRoutingFixture(t);
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\ncase "$*" in *hw.memsize*) printf "28991029248\\n" ;; *) printf "{ 0.1 0.1 0.1 }\\n" ;; esac\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nif [ "$FIXTURE_REMOTE_TARGET" = starved ]; then ratio=18; else ratio=90; fi\nprintf "System-wide memory free percentage: %s%%\\n" "$ratio"\n');
  // Mock the remote login-shell boundary while executing its real probe body.
  await executable(join(binDir, 'bash'), '#!/bin/sh\n[ "$1" = -lc ] && shift\nexec /bin/sh -c "$1"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    'case "$*" in',
    '  *getconf*)',
    '    case "$*" in *starved-host*) FIXTURE_REMOTE_TARGET=starved ;; *) FIXTURE_REMOTE_TARGET=roomy ;; esac',
    '    export FIXTURE_REMOTE_TARGET',
    '    exec /bin/sh -c "$last_argument" ;;',
    '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *) printf "remote:roomy\\n" ;;',
    'esac', '',
  ].join('\n'));
  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected roomy/);
  const telemetry = (await readFile(join(stackDir, 'dev-target-command-load-native', 'starved.telemetry'), 'utf8')).trim().split(' ');
  assert.equal(telemetry[15], 'darwin');
  assert.equal(Number(telemetry[7]), 28311552);
  assert.ok(Number(telemetry[6]) > 0 && Number(telemetry[6]) < 6291456);
});

test('memory-aware placement admits validation at the measured floor', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { availableKiB: 6291456, roomyLoad: 80 });
  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:starved\n');
});

test('memory-aware memory-limited samples retain the positive TTL and recover after expiry', async (t) => {
  const { invocation, stackDir, samplePath } = await memoryRoutingFixture(t);
  const run = () => spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'remote:roomy\n');
  const traceBefore = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
  await writeFile(samplePath, '8 0.1 0.99 22000000 20 0 28028436 28311552 0 0 0 0 0 0 0 linux\n');
  const cached = run();
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(cached.stdout, 'remote:roomy\n');
  const countProbes = (trace) => trace.split('\n').filter((line) => line.includes('cpu=$(getconf')).length;
  assert.equal(countProbes(await readFile(invocation.env.FIXTURE_TRACE, 'utf8')), countProbes(traceBefore));
  const cachePath = join(stackDir, 'dev-target-command-load-native', 'starved.cache');
  const cache = await readFile(cachePath, 'utf8');
  await writeFile(cachePath, cache.replace(/^\d+/, String(Math.floor(Date.now() / 1000) - 16)));
  const recovered = run();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, 'remote:starved\n');
});

test('memory-aware cache preserves optional fields in a short probe sample', async (t) => {
  const { invocation, samplePath } = await memoryRoutingFixture(t);
  await writeFile(samplePath, '8 0.1 0.9\n');
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:starved\n');
  }
});

for (const { admissionClass, belowFloorKiB, floorKiB, nested = false } of [
  { admissionClass: 'validation', belowFloorKiB: 5242880, floorKiB: 6291456 },
  { admissionClass: 'runtime-build', belowFloorKiB: 15728640, floorKiB: 18874368 },
  { admissionClass: 'compilation', belowFloorKiB: resolveHeavyweightMemoryFloorKiB('compilation') - 1, floorKiB: resolveHeavyweightMemoryFloorKiB('compilation') },
  { admissionClass: 'compilation', belowFloorKiB: resolveHeavyweightMemoryFloorKiB('compilation') - 1, floorKiB: resolveHeavyweightMemoryFloorKiB('compilation'), nested: true },
]) {
test(`memory-aware ${admissionClass} target admission${nested ? ' beneath composed admission' : ''} waits below its measured floor`, { timeout: 30_000 }, async (t) => {
  const totalKiB = 50331648;
  const { invocation, samplePath } = await memoryRoutingFixture(t, { availableKiB: belowFloorKiB, totalKiB });
  const { launcher } = await installNativeAdmissionFixture({ root: invocation.env.HOME });
  const binDir = invocation.env.PATH.split(':')[0];
  // This case runs actual admission; its workspace worker and observer must
  // execute real internal logic rather than the routing fixture's tool stub.
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;;',
    '  */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac', '',
  ].join('\n'));
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\ncount=0; for owner in "$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT"/owners/*; do [ ! -d "$owner" ] || count=$((count + 1)); done\n[ "$count" = 1 ] || exit 99\nprintf "admitted\\n"\n');
  const directArgs = [launcher, '--heavyweight-admission', `--class=${admissionClass}`, '--machine=fixture', '--', 'probe-command'];
  const args = nested ? [launcher, '--heavyweight-admission', `--class=${admissionClass}`, '--machine=fixture', '--', '/bin/sh', ...directArgs] : directArgs;
  const child = spawn('/bin/sh', args, { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
  let stderr = '';
  let stdout = '';
  let recovery;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (!recovery && stderr.includes(`memory-available=${belowFloorKiB}/${totalKiB}`)) {
      assert.equal(stdout, '');
      const availableKiB = stderr.includes(`requires=${floorKiB} `) ? floorKiB : 41943040;
      recovery = writeFile(samplePath, `8 0.1 0.5 22000000 20 0 ${availableKiB} ${totalKiB} 0 0 0 0 0 0 0 linux\n`);
    }
  });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  await recovery;
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`waiting.*memory-available=${belowFloorKiB}/${totalKiB}`));
  assert.match(stderr, new RegExp(`requires=${floorKiB} KiB`));
  assert.equal(stdout, 'admitted\n');
});
}

test('compilation capacity rejects an undersized fresh admission while an admitted parent retains its envelope', { timeout: 30_000 }, async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 15728640 });
  const { launcher } = await installNativeAdmissionFixture({ root: invocation.env.HOME, prepareDependencies: true });
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "compiler-payload\\n"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "compiler-payload\\n"\n');
  const directArgs = [launcher, '--heavyweight-admission', '--class=compilation', '--machine=fixture', '--', 'probe-command'];
  for (const ci of ['', 'true']) {
    for (const args of [directArgs, ...(ci === '' ? [[launcher, '--local', '--allow-local-compilation', '--', 'tsc', '--noEmit']] : [])]) {
      const result = spawnSync('/bin/sh', args, { ...invocation, env: { ...invocation.env, CI: ci }, timeout: 10_000 });
      assert.equal(result.status, 75, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /HSTACK_MEMORY_CAPACITY/);
    }
    const inherited = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=fixture', '--', '/bin/sh', ...directArgs], {
      ...invocation, env: { ...invocation.env, CI: ci }, timeout: 10_000,
    });
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(inherited.stdout, 'compiler-payload\n');
    assert.doesNotMatch(inherited.stderr, /HSTACK_MEMORY_CAPACITY/);
  }
});

for (const { commandArgs, admissionClass, belowFloorKiB, floorKiB } of [
  { commandArgs: ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build'], admissionClass: 'package-dist', belowFloorKiB: 4194304, floorKiB: 8388608 },
  { commandArgs: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], admissionClass: 'compilation', belowFloorKiB: resolveHeavyweightMemoryFloorKiB('compilation', { machine: 'local' }) - 1, floorKiB: resolveHeavyweightMemoryFloorKiB('compilation', { machine: 'local' }) },
  { commandArgs: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], admissionClass: 'runtime-build', belowFloorKiB: 15728640, floorKiB: 18874368 },
]) {
test(`workload admission explicit local ${admissionClass} waits for memory, keeps light commands runnable and recovers at its floor`, { timeout: 30_000 }, async (t) => {
  const { invocation, samplePath } = await memoryRoutingFixture(t, { availableKiB: belowFloorKiB, totalKiB: 50331648 });
  const { launcher } = await installNativeAdmissionFixture({ root: invocation.env.HOME, prepareDependencies: true });
  invocation.cwd = resolve(launcher, '../../../..');
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(binDir, 'corepack'), '#!/bin/sh\nprintf "package-built\\n"\n');
  await executable(join(binDir, 'node'), '#!/bin/sh\ncase "$1" in *service_memory.mjs*) printf "service 0\\n" ;; *) printf "package-built\\n" ;; esac\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "light-ran\\n"\n');
  const child = spawn('/bin/sh', [launcher, '--local', '--allow-local-compilation', '--', ...commandArgs], { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
  let stderr = '', stdout = '', recovery;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (!recovery && stderr.includes('waiting for heavyweight admission')) {
      assert.equal(stdout, '');
      const light = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command'], invocation);
      assert.equal(light.status, 0, light.stderr);
      assert.equal(light.stdout, 'light-ran\n');
      // Release the old class too, so RED reports the wrong admission class
      // rather than leaving a live waiter until the harness times out.
      const availableKiB = stderr.includes('class=' + admissionClass) && stderr.includes(`requires=${floorKiB} `) ? floorKiB : 41943040;
      recovery = writeFile(samplePath, `8 0.1 0.5 22000000 20 0 ${availableKiB} 50331648 0 0 0 0 0 0 0 linux\n`);
    }
  });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  await recovery;
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`waiting for heavyweight admission.*class=${admissionClass}.*memory-available=${belowFloorKiB}`));
  assert.match(stderr, new RegExp(`requires=${floorKiB} KiB`));
  assert.equal(stdout, 'package-built\n');
});
}

test('queue policy cwd: outside-repository routing refuses with paths and a recovery action', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  const outside = invocation.env.HOME;
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], { ...invocation, cwd: outside });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(outside), result.stderr);
  assert.ok(result.stderr.includes(repoRoot), result.stderr);
  assert.match(result.stderr, /cd|--cwd/);
  await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
});

test('queue policy cwd: source-dev publication and already-placed children may use fixture directories', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\npwd -P\n');
  for (const options of [
    // syncSharedDepsForSourceDev uses this explicit machine-authority path.
    { args: ['--local', '--', 'probe-command'], env: { HAPPIER_HSTACK_DISPATCH_CONTROL: '1' } },
    { args: ['--', 'probe-command'], env: { HAPPIER_DEV_TARGET_EXECUTION: '1' } },
  ]) {
    const result = spawnSync('/bin/sh', [launcher, ...options.args], {
      ...invocation, cwd: invocation.env.HOME, env: { ...invocation.env, ...options.env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), invocation.env.HOME);
  }
  await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
});

for (const failure of ['allocation', 'lock']) {
test(`queue policy native: controller state failure (${failure}) cannot redirect a reachable remote command locally or retain construction`, async (t) => {
  const { invocation, stackDir } = await memoryRoutingFixture(t, { fallback: 'local' });
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
  if (failure === 'allocation') {
    await executable(join(binDir, 'mktemp'), '#!/bin/sh\ncase "$*" in */.dispatch-reservation.tmp.*) exit 1 ;; *) exec /usr/bin/mktemp "$@" ;; esac\n');
  } else {
    // Preserve real tempfile creation and fail only its OS lock operation.
    await executable(join(binDir, 'flock'), '#!/bin/sh\nif [ "$#:$1:$2" = 2:-n:8 ]; then exit 73; fi\nexec /usr/bin/flock "$@"\n');
  }
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /running locally/);
  await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
  assert.deepEqual((await readdir(join(stackDir, 'dev-target-command-load-native')))
    .filter(name => name.startsWith('.dispatch-reservation.tmp.')), [], 'a failed reservation must retire its private construction file');
});
}

test('queue policy native: unavailable SSH master uses the reachable direct command connection', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
  const binDir = invocation.env.PATH.split(':')[0];
  const sshPath = join(binDir, 'ssh');
  const sshSource = await readFile(sshPath, 'utf8');
  await executable(sshPath, sshSource.replace('case "$*" in', 'last=; for arg in "$@"; do last=$arg; done\n[ "$last" = : ] && exit 0\ncase "$*" in\n  *-MNf*) exit 255 ;;'));
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
  assert.equal(result.status, 0, result.stderr);
  const dispatched = await readFile(invocation.env.DISPATCHES, 'utf8');
  assert.match(dispatched, /^(?:starved|roomy)\n$/);
  assert.equal(result.stdout, `remote:${dispatched}`);
  assert.doesNotMatch(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /-MNf|ControlMaster=yes/);
});

for (const dispatcher of ['native', 'javascript', 'pinned']) {
  test(`queue policy ${dispatcher}: routed work recovers from real target admission pressure`, { timeout: 30_000 }, async (t) => {
    const { invocation, samplePath } = await memoryRoutingFixture(t, { roomyAvailableKiB: 5242880, fallback: 'local' });
    const { launcher: fixtureLauncher } = await installNativeAdmissionFixture({ root: invocation.env.HOME, prepareDependencies: true });
    const checkout = resolve(fixtureLauncher, '../../../..');
    const config = JSON.parse(await readFile(invocation.env.HAPPIER_EXEC_CONFIG_PATH, 'utf8'));
    for (const target of config.targets) target.repoDir = checkout;
    await writeFile(invocation.env.HAPPIER_EXEC_CONFIG_PATH, JSON.stringify(config));
    await writeNativeProjectionFixture(join(invocation.env.HAPPIER_STACK_STORAGE_DIR, 'repo-memory', 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot: dispatcher !== 'javascript' ? checkout : repoRoot }));
    if (dispatcher !== 'javascript') invocation.cwd = checkout;
    const binDir = invocation.env.PATH.split(':')[0];
    await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
    // SSH and procfs are genuine system boundaries. Run the real dispatched
    // shell, heavyweight admission, queue and reentrant descendant path.
    await executable(join(binDir, 'awk'), [
      '#!/bin/sh',
      'case "$*" in',
      '  */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;;',
      '  */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;;',
      '  *) exec /usr/bin/awk "$@" ;;',
      'esac', '',
    ].join('\n'));
    await executable(join(binDir, 'ssh'), [
      '#!/bin/sh',
      'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
      'last=; for arg in "$@"; do last=$arg; done',
      '[ "$last" = : ] && exit 0',
      'case "$*" in',
      '  *getconf*) cat "$STARVED_SAMPLE" ;;',
      '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
      '  *) exec /bin/sh -c "$last" ;;',
      'esac', '',
    ].join('\n'));
    await executable(join(binDir, 'vitest'), '#!/bin/sh\nprintf "queued-remote-result\\n"\n');
    const args = dispatcher !== 'javascript'
      ? [fixtureLauncher, ...(dispatcher === 'pinned' ? ['--target=starved'] : []), '--', 'vitest', 'run', 'fixture.test.ts']
      : [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', 'vitest', 'run', 'fixture.test.ts'];
    const child = spawn(dispatcher !== 'javascript' ? '/bin/sh' : process.execPath, args, { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
    let stdout = '', stderr = '', recovery;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!recovery && /memory-available=5242880\/28311552|admission busy before dispatch/.test(stderr)) {
        assert.equal(payloadOutput(stdout), '');
        recovery = writeFile(samplePath, '8 0.1 0.9 22000000 20 0 25480397 28311552 0 0 0 0 0 0 0 linux\n');
      }
    });
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    await recovery;
    assert.equal(code, 0, stderr);
    assert.ok(recovery, stderr);
    assert.match(stderr, dispatcher === 'pinned' ? /waiting for heavyweight admission on .*memory-available/ : /admission busy before dispatch.*re-evaluating/);
    assert.equal(payloadOutput(stdout), 'queued-remote-result\n');
    assert.doesNotMatch(stderr, /running locally/);
    assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /remote_dependency_bootstrap\.mjs/);
  });
}

test('native launcher bypasses Node when no repository target configuration can exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const tokenToolMarker = join(root, 'token-tool-called');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  for (const command of ['dirname', 'basename', 'tr', 'sed']) {
    await executable(
      join(binDir, command),
      `#!/bin/sh\nprintf '%s\\n' ${command} >> "${tokenToolMarker}"\nexec /usr/bin/${command} "$@"\n`,
    );
  }
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "direct:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'direct:ok\n');
  await assert.rejects(readFile(tokenToolMarker), { code: 'ENOENT' });
});

test('automatic local execution does not pin descendant commands to the local host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-env-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "%s\\n" "${HAPPIER_PREFERRED_EXECUTION-unset}"\n',
  );

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'unset\n');
});

test('explicit local execution is selected per invocation without consulting target configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "local:%s:routed=%s\\n" "$1" "${HAPPIER_HSTACK_EXECUTION-unset}"\n',
  );

  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local:ok:routed=1\n');
  assert.match(
    result.stderr,
    /explicit --local bypasses automatic load distribution/u,
  );

  const protectedResult = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command', 'internal'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_HSTACK_DISPATCH_CONTROL: '1',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(protectedResult.status, 0, protectedResult.stderr);
  assert.equal(protectedResult.stdout, 'local:internal:routed=1\n');
  assert.doesNotMatch(
    protectedResult.stderr,
    /explicit --local bypasses automatic load distribution/u,
  );
});

test('explicit local execution preserves placement while applying the adaptive nested-worker budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-local-budget-'));
  const native = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const { launcher } = native;
  const repoRoot = join(root, 'native-owner');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'flock'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "24\\n" ;;',
    '  */proc/pressure/cpu*) printf "0\\n" ;;',
    '  */proc/pressure/memory*) printf "0\\n" ;;',
    '  */proc/meminfo*) printf "48000000 72000000\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s:%s\\n" "${HAPPIER_VITEST_GOVERNOR_MAX_WORKERS-}" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'rg'), '#!/bin/sh\nprintf "rg:%s\\n" "$*"\n');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);

  // The governor divides CPU among admitted jobs, rather than inferring jobs
  // from load average. Three live owners leave this command two of eight CPUs.
  for (let index = 0; index < 3; index++) {
    await holdNativeAdmissionFixtureMemory(t, native, {
      totalKiB: 72000000,
      availableKiB: 72000000 - resolveHeavyweightMemoryFloorKiB('validation'),
    });
  }
  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /explicit --local bypasses automatic load distribution/u);
  assert.match(result.stdout, /workers:2::::/);
  assert.match(result.stdout, /^args:run fixture\.test\.ts$/m);

  const search = spawnSync('/bin/sh', [launcher, '--local', '--', 'rg', 'needle', 'sources'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stderr, /explicit --local bypasses automatic load distribution/u);
  assert.equal(search.stdout, 'rg:--threads=2 needle sources\n');
});

test('automatic dispatch protects control work while keeping a selected local payload in the jobs slice', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dispatch-control-'));
  const controller = await installNativeAdmissionControllerFixture(t, root, { env: executionNeutralEnv });
  const launcher = controller.launcher;
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const scopeLog = join(root, 'systemd-run.log');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='0'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), '#!/bin/sh\nexit 255\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 0.1 0.1 0.1 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 80%%\\n"\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "payload:%s\\n" "$1"\n');
  await executable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *happier-critical.slice*) printf "LoadState=loaded\\nMemoryLow=4294967296\\n" ;;',
    '  *happier-jobs.slice*) printf "loaded\\n" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SCOPE_LOG"',
    'literal_arguments=0',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --expand-environment=no) literal_arguments=1 ;; --slice=*) export TEST_CURRENT_CGROUP=/user.slice/${1#--slice=}/fixture.scope ;; esac',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    systemdOperandExpansionProbe,
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'sed'), '#!/bin/sh\ncase "$*" in *"/proc/self/cgroup") printf "%s\\n" "${TEST_CURRENT_CGROUP-/user.slice/unscoped}" ;; *) exec /usr/bin/sed "$@" ;; esac\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...controller.env,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      DBUS_SESSION_BUS_ADDRESS: 'test-user-bus',
      PATH: `${binDir}:/usr/bin:/bin`,
      SCOPE_LOG: scopeLog,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'payload:ok\n');
  const scopes = await readFile(scopeLog, 'utf8');
  assert.match(scopes, /--slice=happier-critical\.slice .*hstack-exec.*probe-command ok/);
  // Routed tests may already inherit a lower background scheduling priority.
  assert.match(scopes, /--slice=happier-jobs\.slice --nice=1[0-9] -- probe-command ok/);

  const literal = spawnSync('/bin/sh', [launcher, '--', 'probe-command', '${GOMAXPROCS+x}'], {
    cwd: repoRoot,
    env: { ...controller.env, HOME: root, HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), DBUS_SESSION_BUS_ADDRESS: 'test-user-bus',
      PATH: `${binDir}:/usr/bin:/bin`, SCOPE_LOG: scopeLog, TMPDIR: root,
      TEST_LITERAL_SCOPE_PROBE: '1', TEST_SCOPE_EXPANSIONS: join(root, 'scope-expansions') },
    encoding: 'utf8',
  });
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(literal.stdout, 'payload:${GOMAXPROCS+x}\n');
  assert.match(await readFile(join(root, 'scope-expansions'), 'utf8'), /^0+$/, 'control and jobs scopes must interpret zero operands');
});

test('Yarn workspace validation receives the remote workload governor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-workspace-validation-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='0'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "14 360 0.8 22000000 20 420 48000000 72000000 0 0 90 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; printf "remote:%s\\n" "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'yarn', 'workspace', '@happier-dev/app', 'test:local', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HAPPIER_VITEST_GOVERNOR_MAX_WORKERS=.*1/);
  assert.doesNotMatch(result.stdout, /export VITEST_MAX_THREADS=|export VITEST_MAX_FORKS=/);
  assert.match(result.stdout, /nice -n 10/);
  for (const argument of ['yarn', 'workspace', '@happier-dev/app', 'test:local', 'fixture.test.ts']) {
    assert.match(result.stdout, new RegExp(argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(result.stdout, /--maxWorkers=1|--minWorkers=1/);
});

test('native launcher keeps Git commands on the authoritative checkout without probing a replica', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-git-authority-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  const remoteMarker = join(root, 'remote-called');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    "primary_only_direct_commands='git'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'git'), '#!/bin/sh\nprintf "local-git:%s\\n" "$*"\n');
  // This fixture observes Git placement; dedicated admission tests exercise
  // the systemd boundary without borrowing a live user scope.
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'mutagen'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\nprintf 'happier-linux|Scanning|7||false|0\\n'\n`);
  await executable(join(binDir, 'ssh'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\ncase "$*" in *getconf*) printf '8 1 0.5 9999999 10\\n' ;; esac\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', 'git', 'status'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local-git:status\n');
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
});

test('native launcher keeps bundled-plugin publication on the authoritative checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-plugin-writer-authority-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  const remoteMarker = join(root, 'remote-called');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    "primary_only_direct_commands='git'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "local-writer:%s\\n" "$*"\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'mutagen'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\nprintf 'happier-linux|Scanning|7||false|0\\n'\n`);
  await executable(join(binDir, 'ssh'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\ncase "$*" in *getconf*) printf '8 1 0.5 9999999 10\\n' ;; esac\n`);
  const generatorArguments = [
    'node',
    '--experimental-strip-types',
    'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
    '--mode',
    'write',
  ];
  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const result = spawnSync('/bin/sh', [launcher, '--', ...generatorArguments], invocation);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local-writer:--experimental-strip-types .* --mode write/u);
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });

  const canonicalDefaultWriter = spawnSync('/bin/sh', [
    launcher,
    '--',
    'node',
    '--experimental-strip-types',
    'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
  ], invocation);
  assert.equal(canonicalDefaultWriter.status, 0, canonicalDefaultWriter.stderr);
  assert.match(
    canonicalDefaultWriter.stdout,
    /local-writer:--experimental-strip-types apps\/cli\/scripts\/build-owned\/generateBundledPluginEntries\.ts/u,
  );
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });

  const explicitRemote = spawnSync('/bin/sh', [launcher, '--target=linux', '--', ...generatorArguments], invocation);
  assert.equal(explicitRemote.status, 1);
  assert.match(explicitRemote.stderr, /bundled-plugin projection writer must execute on the authoritative primary checkout/u);
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
});

test('native launcher uses Node once to publish a stale validated projection, then executes natively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-target-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-test`);
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n', 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(
    await readFile(join(stackDir, 'dev-target-exec-v1.sh'), 'utf8'),
    /^command_mode='local'$/m,
  );
});

test('native launcher discovers the matching repository projection when its directory name is not the stack token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-renamed-workspace-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, 'repo-stack-unrelated-token');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='local'",
    "fallback_mode='error'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  // An older implicit projection may omit source provenance and remain warm.
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await writeFile(projectionPath, (await readFile(projectionPath, 'utf8')).replace(/^projection_config_path=.*\n/m, ''));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "happier-linux|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) case "$*" in *ControlPath=none*) printf "8 1 0.5 22000000 10\\n" ;; *) exit 255 ;; esac ;;',
    '  *command\\ -v*) case "$*" in *ControlPath=none*) exit 0 ;; *) exit 255 ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };
  const localResult = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/printf', 'preserved-command\n'], invocation);
  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command'], invocation);

  assert.equal(localResult.status, 0, localResult.stderr);
  assert.equal(localResult.stdout, 'preserved-command\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:/);
});

test('native launcher refreshes an explicit stale projection instead of silently falling back locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-stale-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='1'",
    `projection_repo_root='${repoRoot}'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(projectionPath, 'utf8'), /^HSTACK_EXEC_PROJECTION_VERSION='2'$/m);
});

for (const dispatcher of ['native', 'javascript']) {
  test(`explicit execution config ${dispatcher}: selection is authoritative and invalid overrides never discover defaults`, async t => {
    const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, fallback: 'local' });
    const directory = join(fixture.root, 'explicit policy');
    await mkdir(directory);
    const path = join(directory, 'dev-targets.json');
    const config = { ...fixture.config, targets: fixture.config.targets.filter(target => target.name === 'roomy'),
      commandExecution: { mode: 'auto', targets: ['roomy'], includeLocal: false, fallback: 'error' } };
    await writeFile(path, JSON.stringify(config));
    await writeNativeProjectionFixture(join(directory, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot }));
    // Keep real configuration/manifest owners; only PM/SSH/OS boundaries are fixtures.
    await executable(join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    await executable(join(fixture.binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
    const invoke = (configPath, args = ['probe-command'], environment = {}) => {
      const invocation = { ...fixture.invocation, env: { ...fixture.invocation.env, ...environment, HAPPIER_EXEC_CONFIG_PATH: configPath } };
      return dispatcher === 'native'
        ? spawnSync('/bin/sh', [launcher, '--', ...args], invocation)
        : spawnSync(process.execPath, [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', ...args], invocation);
    };
    await t.test('absolute override selects its remote-only pool instead of the discovered pool', async () => {
      const result = invoke(path);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'remote:roomy\n');
    });
    await t.test('absolute policy does not depend on default discovery having a home directory', async () => {
      const result = invoke(`${directory}/./dev-targets.json`, ['probe-command'], { HOME: '', HAPPIER_STACK_STORAGE_DIR: '' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'remote:roomy\n');
    });
    await t.test('two valid colocated overrides retain their own target and local fallback policy', async () => {
      const neighborPath = join(directory, 'neighbor.json');
      const neighbor = { version: 3, targets: [],
        commandExecution: { mode: 'auto', includeLocal: true, fallback: 'local' } };
      await writeFile(neighborPath, JSON.stringify(neighbor));
      await writeNativeProjectionFixture(join(directory, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(neighbor,
        { repoRoot, configPath: neighborPath }));
      const intendedLocal = invoke(neighborPath);
      assert.equal(intendedLocal.status, 0, intendedLocal.stderr);
      assert.equal(intendedLocal.stdout, 'wrong-local\n', 'the neighbor intentionally permits controller fallback');
      await utimes(path, new Date(0), new Date(0));
      const selected = invoke(path);
      assert.equal(selected.status, 0, selected.stderr);
      assert.equal(selected.stdout, 'remote:roomy\n', 'the named remote-only file must not borrow the neighbor projection');
    });
    await t.test('a valid explicit local fallback remains an intentional policy', async () => {
      const fallbackDir = join(fixture.root, 'intentional fallback');
      await mkdir(fallbackDir);
      const fallbackPath = join(fallbackDir, 'dev-targets.json');
      const localConfig = { version: 3, targets: [], commandExecution: { mode: 'auto', fallback: 'local' } };
      await writeFile(fallbackPath, JSON.stringify(localConfig));
      await writeNativeProjectionFixture(join(fallbackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(localConfig, { repoRoot }));
      const result = invoke(fallbackPath);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'wrong-local\n');
    });
    const invalidJson = join(directory, 'invalid.json');
    const invalidSchema = join(directory, 'invalid-schema.json');
    await writeFile(invalidJson, '{ invalid JSON');
    await writeFile(invalidSchema, JSON.stringify({ version: 3, targets: 'invalid' }));
    // Explicit input cannot borrow a newer valid projection from this directory.
    for (const invalid of [invalidJson, invalidSchema]) await utimes(invalid, new Date(0), new Date(0));
    for (const [name, configPath, args] of [
      ['relative path before a package-manager cwd change', relative(repoRoot, path), ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck']],
      ['missing file', join(directory, 'missing.json')],
      ['directory instead of a file', directory],
      ['invalid JSON', invalidJson],
      ['invalid schema', invalidSchema],
    ]) await t.test(name, async () => {
      await rm(fixture.invocation.env.DISPATCHES, { force: true });
      const result = invoke(configPath, args);
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(result.stdout, '', 'no local or remote payload may start');
      await assert.rejects(readFile(fixture.invocation.env.DISPATCHES), { code: 'ENOENT' });
    });
    if (dispatcher === 'native') await t.test('an unloadable explicit projection cannot become local fallback', async () => {
      await writeFile(join(directory, 'dev-target-exec-v1.sh'), 'return 7\n');
      const result = invoke(path);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    });
  });
}

test('native launcher preserves the canonical repository cwd boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-cwd-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "node:%s\\n" "$*"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: root,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /working directory must stay inside the repository/i);
  assert.equal(result.stdout, '');
});

test('a linked worktree launcher hands its own --repo dispatch to the primary checkout executor', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-worktree-launcher-' });
  const root = await realpath(fixture.root);
  const primary = join(root, 'primary');
  const worktree = join(root, 'basis');
  await mkdir(join(primary, '.git', 'worktrees', 'basis'), { recursive: true });
  await mkdir(join(primary, 'apps', 'stack', 'bin'), { recursive: true });
  await mkdir(join(worktree, 'apps', 'stack', 'bin'), { recursive: true });
  await mkdir(join(worktree, 'apps', 'ui'), { recursive: true });
  // Git's linked-worktree pointer is the only identity the launcher reads.
  await writeFile(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'basis')}\n`);
  await writeFile(join(worktree, 'apps', 'stack', 'bin', 'hstack-exec'), await readFile(launcher, 'utf8'));
  await executable(join(primary, 'apps', 'stack', 'bin', 'hstack-exec'),
    '#!/bin/sh\nprintf "primary cwd=%s args=%s\\n" "$(pwd -P)" "$*"\n');
  const result = spawnSync('/bin/sh', [join(worktree, 'apps', 'stack', 'bin', 'hstack-exec'), `--repo=${worktree}`,
    '--', 'pnpm', '--dir', 'apps/ui', 'exec', 'vitest', 'run', 'a.test.ts'], {
    cwd: join(worktree, 'apps', 'ui'), env: executionNeutralEnv, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout,
    `primary cwd=${join(worktree, 'apps', 'ui')} args=--repo=${worktree} -- pnpm --dir apps/ui exec vitest run a.test.ts\n`);
});

test('remote heavyweight admission starts from the configured repository when SSH login cwd is external', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-cwd-'));
  const { launcher } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const repoRoot = join(root, 'native-owner');
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='darwin'",
    "target_1_ssh='darwin-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\nexit 0\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "remote-tsc\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "4 0.1 0.9 22000000 20 0 48000000 72000000 0 0 0 0 0 0 0 darwin\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    cd -- "$REMOTE_LOGIN_CWD"',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'tsc', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      REMOTE_LOGIN_CWD: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payloadOutput(result.stdout), 'remote-tsc\n');
});

test('native payloads stay independent of a configured master across sequential and concurrent commands', async (t) => {
  if (process.platform === 'win32') {
    t.skip('native launcher requires a POSIX controller');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-shared-ssh-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const masterStarts = join(root, 'master-starts');
  const heldCommandStarted = join(root, 'held-command-started');
  const releaseHeldCommand = join(root, 'release-held-command');
  const explicitMasterStarts = join(root, 'explicit-master-starts');
  const releaseReservation = join(root, 'release-reservation');
  const configuredControlPath = join(root, 'runtime', 'configured-master');
  const provenancePath = join(stackDir, 'dev-target-command-load-native', 'provenance.jsonl');
  const historicalProvenance = JSON.stringify({ phase: 'completed', executionId: 'historical', target: 'x'.repeat(1024 * 1024) });
  const runtimeDir = join(root, 'runtime');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  // A warm master belongs to other sessions. Native payloads must not join it.
  await writeFile(configuredControlPath, '');
  await mkdir(`${configuredControlPath}.fixture-master`);
  await writeFile(masterStarts, 'start\n');
  const sshConfig = join(root, 'ssh.config');
  await writeFile(sshConfig, `Host linux-host\n  ControlMaster auto\n  ControlPath ${configuredControlPath}\n`);
  await mkdir(join(stackDir, 'dev-target-command-load-native'));
  await writeFile(provenancePath, `${historicalProvenance}\n`);
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    `target_1_ssh_config='${sshConfig}'`,
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  if (process.platform === 'linux') {
    // Pause only the genuine OS lock boundary after its file is opened. A
    // concurrent selector must not reap a reservation still being published.
    await executable(join(binDir, 'flock'), `#!/bin/sh
if [ "$#:$1" = 1:7 ]; then printf 'fixture-placement-wait\\n' >&2; fi
if [ "$#:$1:$2" = 2:-n:8 ]; then
  printf 'fixture-reservation-open:%s\\n' "$(readlink /proc/$$/fd/8)" >&2
  if [ "\${GATE_RESERVATION-}" = 1 ]; then
    while [ ! -e "$RELEASE_RESERVATION" ]; do sleep 0.02; done
  fi
fi
exec /usr/bin/flock "$@"
`);
  }
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'probe-command'), [
    '#!/bin/sh',
    'if [ "$1" = hold ]; then',
    '  : > "$HELD_COMMAND_STARTED"',
    '  while [ ! -e "$RELEASE_HELD_COMMAND" ]; do sleep 0.02; done',
    'fi',
    'printf "remote:%s\\n" "$1"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case " $* " in',
    '  *" -G "*) printf "controlpath %s\\n" "$CONFIGURED_CONTROL_PATH" ;;',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -S "$control_path" ] || [ -f "$control_path" ] ;;',
    '  *-MNf*)',
    '    printf "unexpected-create\\n" >> "$EXPLICIT_MASTER_STARTS"; exit 91 ;;',
    '  *)',
    // The SSH process boundary models configured ControlMaster auto: one
    // socket wins and competing first connections still execute their command.
    '    case " $* " in *" ControlMaster=no "*) ;; *)',
    '      if mkdir "$CONFIGURED_CONTROL_PATH.fixture-master" 2>/dev/null; then',
    '        : > "$CONFIGURED_CONTROL_PATH"; printf "start\\n" >> "$MASTER_STARTS"',
    '      fi ;;',
    '    esac',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    case "$remote_command" in *HAPPIER_REMOTE_EXEC_LIFELINE=1*)',
    '      case " $* " in *" ControlPath=none "*) ;; *) printf "payload joined shared master\\n" >&2; exit 255 ;; esac ;;',
    '    esac',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_EXEC_CONFIG_PATH: configPath,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    XDG_RUNTIME_DIR: runtimeDir,
    MASTER_STARTS: masterStarts,
    EXPLICIT_MASTER_STARTS: explicitMasterStarts,
    HELD_COMMAND_STARTED: heldCommandStarted,
    RELEASE_HELD_COMMAND: releaseHeldCommand,
    RELEASE_RESERVATION: releaseReservation,
    CONFIGURED_CONTROL_PATH: configuredControlPath,
  };

  const startupCompletions = [];
  try {
    // Independent payload connections retain admission publication ordering.
    const startFollower = (index, gateReservation = false) => {
      const child = spawn('/bin/sh', [launcher, '--', 'probe-command', `startup-${index}`], {
        cwd: repoRoot, env: { ...env, GATE_RESERVATION: gateReservation ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
      let out = '', err = '';
      let opened;
      const reservationOpened = new Promise(resolve => { opened = resolve; });
      let waiting;
      const placementWaiting = new Promise(resolve => { waiting = resolve; });
      child.stdout.on('data', value => { out += value; });
      child.stderr.on('data', value => {
        err += value;
        const marker = err.match(/^fixture-reservation-open:(.+)\n/m);
        if (marker) opened(marker[1]);
        if (err.includes('fixture-placement-wait\n')) waiting();
      });
      const completion = new Promise(resolve => child.once('close', code => resolve({ code, out, err })));
      startupCompletions.push(completion);
      return { child, completion, reservationOpened, placementWaiting };
    };
    const followers = [];
    if (process.platform === 'linux') {
      const gated = startFollower(0, true);
      followers.push(gated);
      const openedPath = await Promise.race([gated.reservationOpened, gated.completion.then(result => assert.fail(JSON.stringify(result)))]);
      await access(openedPath);
      const scanning = startFollower(1);
      followers.push(scanning);
      await Promise.race([scanning.placementWaiting, scanning.completion.then(result => assert.fail(JSON.stringify(result)))]);
      // Placement now serializes publication. Observe the contender before
      // releasing the publisher, rather than waiting for an impossible scan.
      await access(openedPath);
      await writeFile(releaseReservation, '');
    }
    while (followers.length < 5) followers.push(startFollower(followers.length));
    for (const { completion } of followers) {
      const result = await completion;
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /^remote:startup-/);
    }
  } finally {
    await writeFile(releaseReservation, '', 'utf8');
    await Promise.all(startupCompletions);
  }
  await assert.rejects(readFile(explicitMasterStarts), { code: 'ENOENT' });
  assert.ok((await readFile(provenancePath, 'utf8')).split('\n')[0] === historicalProvenance, 'existing provenance remains in the active log');

  for (const value of ['one', 'two']) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', value], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `remote:${value}\n`);
  }

  assert.equal((await readFile(masterStarts, 'utf8')).trim().split('\n').length, 1);
  assert.equal(await readFile(configuredControlPath, 'utf8'), '', 'native payloads leave the configured master untouched');

  const held = spawn('/bin/sh', [launcher, '--', 'probe-command', 'hold'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const heldOutput = { stdout: '', stderr: '' };
  held.stdout.on('data', (chunk) => { heldOutput.stdout += chunk; });
  held.stderr.on('data', (chunk) => { heldOutput.stderr += chunk; });
  let heldExit;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await readFile(heldCommandStarted);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(heldCommandStarted).catch(error => {
      const codes = heldOutput.stderr.match(/HSTACK_[A-Z_]+/g) ?? [];
      throw new Error(`held payload did not start (exit=${held.exitCode}, signal=${held.signalCode}, codes=${codes.join(',')})`, { cause: error });
    });
    const concurrent = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'concurrent'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(concurrent.status, 0, concurrent.stderr);
    assert.equal(concurrent.stdout, 'remote:concurrent\n');
    assert.equal((await readFile(masterStarts, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await writeFile(releaseHeldCommand, '', 'utf8');
    heldExit = held.exitCode ?? await new Promise((resolveExit) => held.once('exit', resolveExit));
  }
  assert.equal(heldExit, 0, heldOutput.stderr);
  assert.equal(heldOutput.stdout, 'remote:hold\n');
});

test('native payload requires no SSH control directory when XDG_RUNTIME_DIR is read-only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-readonly-runtime-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const runtimeDir = join(root, 'runtime');
  const masterPath = join(root, 'master-path');
  t.after(async () => {
    await chmod(runtimeDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "remote:%s\\n" "$1"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path"; printf "%s\\n" "$control_path" > "$MASTER_PATH" ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; /bin/sh -c "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));
  await chmod(runtimeDir, 0o555);

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
      MASTER_PATH: masterPath,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:ok\n');
  await assert.rejects(access(join(root, `happier-ssh-${process.getuid()}`)), { code: 'ENOENT' });
  await assert.rejects(readFile(masterPath), { code: 'ENOENT' });
});

test('native launcher admits another remote heavyweight command while the worker has healthy pressure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-pretransport-admission-'));
  const { launcher: workerLauncher } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const workerRepoRoot = resolve(workerLauncher, '../../../..');
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const configPath = join(stackDir, 'dev-targets.json');
  const masterStarted = join(root, 'master-started');
  const runtimeDir = join(root, 'runtime');
  const owners = [
    spawn('/bin/sleep', ['300'], { stdio: 'ignore' }),
    spawn('/bin/sleep', ['300'], { stdio: 'ignore' }),
  ];
  t.after(async () => {
    for (const owner of owners) {
      if (owner.exitCode == null) owner.kill('SIGTERM');
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "validation_direct_commands='tsc vitest'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${workerRepoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  const now = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${now} 1 0.062500 8\n`, 'utf8');
  await writeFile(
    join(cacheDir, 'linux.telemetry'),
    '8 0.5 0.8 22000000 20 0 18000000 26000000 0 0 0 0 0 0 0 linux\n',
    'utf8',
  );
  for (const owner of owners) {
    await writeFile(join(cacheDir, `linux.active.${owner.pid}`), `${owner.pid}\nvalidation\nexisting\n`, 'utf8');
  }
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'flock'), [
    '#!/bin/sh',
    '# Reservation fixtures model locks held by another dispatcher.',
    '[ "${1-}" = -n ] && [ "${3-}" = -c ] && exit 1',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'if [ "${REMOTE_MARKER-}" = 1 ]; then printf "remote\\n"; else printf "local\\n"; fi',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 26000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path"; : > "$MASTER_STARTED" ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; REMOTE_MARKER=1 /bin/sh -c "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_EXEC_CONFIG_PATH: configPath,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    XDG_RUNTIME_DIR: runtimeDir,
    MASTER_STARTED: masterStarted,
  };
  const child = spawn('/bin/sh', [launcher, '--', 'vitest', '--version'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  try {
    const exitCode = child.exitCode ?? await new Promise((resolveExit) => child.once('exit', resolveExit));
    assert.equal(exitCode, 0, output.stderr);
    assert.equal(payloadOutput(output.stdout), 'remote\n');
    await readFile(masterStarted);
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
  }
});

test('native launcher ignores an inherited local preference and dispatches to the least-loaded host without Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-native-target-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'dev-target-command-load-native', 'mac2.cache.lock'), { recursive: true });
  await utimes(
    join(stackDir, 'dev-target-command-load-native', 'mac2.cache.lock'),
    new Date(0),
    new Date(0),
  );
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Scanning|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 1 0.5\\n" ;; *) printf "8 4 0.5\\n" ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_PREFERRED_EXECUTION: 'local',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac2/);
  assert.doesNotMatch(result.stderr, /cannot open .*provenance\.jsonl/);
  assert.match(result.stdout, /remote:.*mac2-host.*probe-command.*ok/);
});

test('native launcher automatic placement remains compatible with GNU awk local scoring', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-gawk-score-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = await installNativeAdmissionControllerFixture(t, root, { env: executionNeutralEnv });
  const launcher = controller.launcher;
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const reservedLoadMarker = join(root, 'reserved-load-variable');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 100.0 100.0 100.0 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 50%%\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    `for argument in "$@"; do case "$argument" in load=*) printf called > ${JSON.stringify(reservedLoadMarker)} ;; esac; done`,
    'exec /usr/bin/awk "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10 1 16000000 24000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...controller.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
  await assert.rejects(readFile(reservedLoadMarker), { code: 'ENOENT' });
});

test('AUTO keeps heavyweight compilation and validation on workers even when the controller is idle', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-local-placement-floor-' });
  const { launcher: native } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const checkout = join(root, 'native-owner');
  const bin = join(root, 'bin'), stack = join(root, 'stack');
  await mkdir(bin); await mkdir(stack);
  const config = join(stack, 'dev-targets.json');
  await writeFile(config, '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stack, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection({
    version: 3, targets: [{ name: 'worker', platform: 'posix', ssh: 'worker-host', repoDir: '/worker/repo', cliHomeDir: '/worker/home' }],
    commandExecution: { mode: 'auto', targets: ['worker'], includeLocal: true, fallback: 'error' },
  }, { repoRoot: checkout, stackBaseDir: stack }));
  // Replace only OS telemetry and SSH. A CPU-idle controller has more memory
  // than the worker, so load scoring alone incorrectly chooses the controller.
  await executable(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  await executable(join(bin, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(bin, 'sysctl'), '#!/bin/sh\nprintf "{ 0.0 0.0 0.0 }\\n"\n');
  await executable(join(bin, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 83%%\\n"\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "41943040 50331648\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'mutagen'), '#!/bin/sh\n[ "$2" != list ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(bin, 'probe-command'), '#!/bin/sh\nprintf "local\\n"\n');
  await executable(join(bin, 'ssh'), '#!/bin/sh\ncase "$*" in *getconf*) printf "8 16 0.9 22000000 10 0 25165824 28311552 0 0 0 0 0 0 0 linux 25165824\\n" ;; *command\\ -v*) exit 0 ;; *) printf "remote\\n" ;; esac\n');
  const invocation = {
    cwd: checkout, encoding: 'utf8', timeout: 15000,
    env: { ...executionNeutralEnv, CI: '', HOME: root, HAPPIER_EXEC_CONFIG_PATH: config,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root,
      HAPPIER_HSTACK_DISPATCH_CONTROL: '1',
      NODE_OPTIONS: `${executionNeutralEnv.NODE_OPTIONS ?? ''} --conditions=happier-source --import=${join(repoRoot, 'node_modules/tsx/dist/loader.mjs')}`.trim() },
  };
  for (const admissionClass of ['compilation-ui', 'validation']) {
    await t.test(admissionClass, () => {
      const result = spawnSync('/bin/sh', [native, '--', './apps/stack/bin/hstack-exec', '--heavyweight-admission', `--class=${admissionClass}`, '--machine=worker', '--', 'probe-command'], invocation);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'remote\n', 'AUTO must preserve the controller for interactive work even when it wins load scoring');
    });
  }
  const light = spawnSync('/bin/sh', [native, '--', 'probe-command'], invocation);
  assert.equal(light.status, 0, light.stderr);
  assert.equal(light.stdout, 'local\n', 'includeLocal still applies to lightweight commands');
});

test('native launcher ranks live local admission waiters against idle remote capacity', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-placement-queue-' });
  const authority = await installNativeAdmissionFixture({ root });
  const native = authority.launcher;
  const checkout = join(root, 'native-owner');
  const bin = join(root, 'bin');
  const stack = join(root, 'stack');
  const config = join(stack, 'dev-targets.json');
  await mkdir(bin);
  await mkdir(stack);
  await writeFile(config, '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stack, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection({
    version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'worker-host', repoDir: '/worker/repo', cliHomeDir: '/worker/home' }],
    commandExecution: { mode: 'auto', targets: ['worker'], includeLocal: true, fallback: 'error' },
  }, { repoRoot: checkout, stackBaseDir: stack }));
  await executable(join(bin, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(bin, 'getconf'), '#!/bin/sh\nprintf "1\\n"\n');
  await executable(join(bin, 'sysctl'), '#!/bin/sh\nprintf "{ 0.0 0.0 0.0 }\\n"\n');
  await executable(join(bin, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 90%%\\n"\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(bin, 'mutagen'), '#!/bin/sh\n[ "$2" != list ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(bin, 'probe-command'), '#!/bin/sh\nprintf "local\\n"\n');
  await executable(join(bin, 'ssh'), '#!/bin/sh\ncase "$*" in *getconf*) printf "1 0.25 0.9 22000000 10 0 16000000 24000000 0 0 0 0 0 0 0 linux\\n" ;; *command\\ -v*) exit 0 ;; *) printf "remote\\n" ;; esac\n');
  const invocation = { cwd: checkout, encoding: 'utf8', env: { ...executionNeutralEnv, HOME: root,
    HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: bin + ':/usr/bin:/bin', TMPDIR: root } };
  const invoke = () => spawnSync('/bin/sh', [native, '--', 'probe-command'], invocation);
  const empty = invoke();
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, 'local\n');
  await holdNativeAdmissionFixtureMemory(t, { ...authority, env: invocation.env }, { totalKiB: 24000000, availableKiB: 1 });
  const demand = spawn('/bin/sh', [native, '--heavyweight-admission', '--class=validation', '--machine=worker', '--', '/usr/bin/true'],
    { ...invocation, stdio: 'ignore' });
  const demandExit = new Promise(resolve => demand.once('close', resolve));
  t.after(async () => { if (demand.exitCode === null && demand.signalCode === null) demand.kill('SIGTERM'); await demandExit; });
  await waitForRuntime(async () => (await authority.brokerStatus()).waitingCount === 1, () => 'local socket demand did not queue');
  const queued = invoke();
  assert.equal(queued.status, 0, queued.stderr);
  assert.equal(queued.stdout, 'remote\n', 'a real socket waiter increases local effective load');
  demand.kill('SIGTERM');
  await demandExit;
  await waitForRuntime(async () => (await authority.brokerStatus()).waitingCount === 0, () => 'closed local demand did not release');
  const released = invoke();
  assert.equal(released.status, 0, released.stderr);
  assert.equal(released.stdout, 'local\n', 'closed demand no longer penalizes local placement');
});

test('native launcher governs nested Vitest workers on an explicitly selected pressured local Linux host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-governor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const repoRoot = join(root, 'native-owner');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  // Admission's real OS observer needs Node; reject only the retired JS
  // dispatch path rather than disabling observation and waiting forever.
  await executable(join(binDir, 'node'), `#!/bin/sh\ncase "$1" in */service_memory.mjs|*/worker_disk_budget.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;; *) exit 97 ;; esac\n`);
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "14\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/meminfo*) printf "16000000 24000000\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac', '',
  ].join('\n'));
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 100.0 100.0 100.0 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 50%%\\n"\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 120 0.5 22000000 10 120 16000000 24000000 0 0 90 90 0 0 0 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "wrong-remote\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s:%s\\n" "${HAPPIER_VITEST_GOVERNOR_MAX_WORKERS-}" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'corepack'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s:%s\\n" "${HAPPIER_VITEST_GOVERNOR_MAX_WORKERS-}" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workers:1::::/);
  assert.match(result.stdout, /^args:run fixture\.test\.ts$/m);
  assert.doesNotMatch(result.stdout, /wrong-remote/);

  const explicit = spawnSync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', '--maxWorkers=6'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /workers:::::/);
  assert.match(explicit.stdout, /args:run --maxWorkers=6/);

  const packageScript = spawnSync(
    '/bin/sh',
    [launcher, '--local', '--', 'corepack', 'yarn', '-s', 'test:migration:bundled-plugin-projections'],
    {
      cwd: repoRoot,
      env: {
        ...executionNeutralEnv,
        HOME: root,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: root,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(packageScript.status, 0, packageScript.stderr);
  assert.match(packageScript.stdout, /workers:1::::/);
  assert.match(packageScript.stdout, /^args:yarn -s test:migration:bundled-plugin-projections$/m);
});

test('AUTO resolves repository-relative cwd on the selected target and retains it across admission retries', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  const { invocation } = fixture;
  for (const cwdOption of [['--cwd=apps/cli'], ['--cwd', 'apps/cli']]) {
    const result = spawnSync('/bin/sh', [launcher, ...cwdOption, '--', 'probe-command'], invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:starved\n');
    assert.ok((await readFile(invocation.env.FIXTURE_TRACE, 'utf8')).includes(`cd -- '${repoRoot}/apps/cli'`));
  }
  for (const [files, expectedClass] of [
    [["sources/components/settings/teams/credentials/TeamCredentialExternalApiScreen.test.tsx"], 'focused-validation'],
    [['sources/utils/path/pathUtils.spec.ts'], 'focused-validation'],
    [['sources/utils/path/pathUtils.spec.ts', 'sources/text/declarationEmission.test.ts'], 'compilation'],
  ]) {
    await writeFile(invocation.env.FIXTURE_TRACE, '');
    const selected = spawnSync('/bin/sh', [launcher, '--cwd=apps/ui', '--', 'pnpm', 'exec', 'vitest', 'run', ...files], invocation);
    assert.equal(selected.status, 0, selected.stderr);
    const selectedTrace = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
    assert.ok(selectedTrace.includes(`--class=${expectedClass}`), selectedTrace);
    assert.ok(selectedTrace.replaceAll("'\"'\"'", "'").includes(`cd -- '${repoRoot}/apps/ui'`), selectedTrace);
  }
  await installBusyAdmissionTransport(fixture);
  const retried = spawnSync('/bin/sh', [launcher, '--cwd=apps/cli', '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.stdout, 'payload:roomy\n');
  assert.match(retried.stderr, /HSTACK_ADMISSION_BUSY:/);
  const trace = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
  assert.ok(trace.includes(`cd -- '${repoRoot}/apps/cli'`), trace);
  const invalid = spawnSync('/bin/sh', [launcher, '--cwd=apps/../../outside', '--', 'probe-command'], invocation);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /working directory must stay inside/);
  // AUTO's configured local fallback resolves the same repository-relative cwd.
  await executable(join(fixture.binDir, 'probe-command'), '#!/bin/sh\npwd -P\n');
  await executable(join(fixture.binDir, 'ssh'), '#!/bin/sh\nexit 255\n');
  fixture.config.commandExecution.fallback = 'local';
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const fallback = spawnSync('/bin/sh', [launcher, '--cwd=apps/cli', '--', 'probe-command'], invocation);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout.trim(), join(repoRoot, 'apps/cli'));
});

test('native launcher exact target preserves remote-only cwd, environment, and TTY on only the named healthy target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const remoteRepo = resolve(native.launcher, '../../../..');
  const remoteHome = join(root, 'remote-home');
  const sshLog = join(root, 'ssh.log');
  const environmentValue = "a 'quoted' $value $(exit 99)\n\n";
  await mkdir(binDir, { recursive: true });
  await mkdir(join(remoteRepo, 'apps/cli/dist'), { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac-host'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${remoteRepo}'`,
    `target_1_cli_home='${remoteHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    "target_2_name='linux'",
    "target_2_ssh='linux-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/linux-repo'",
    "target_2_cli_home='/remote/linux-home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "value<%s>empty<%s>arg<%s>\\n" "$PROBE_VALUE" "$PROBE_EMPTY" "$1"\nprintf "remote-error\\n" >&2\nexit 23\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\n[ "$3" = "happier-mac--host" ] || exit 0\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'printf "called\\n" >> "$PROBE_SSH_LOG"',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac-host*) printf "8 6 0.5 22000000 10\\n" ;; *) printf "8 0.1 0.9 22000000 10\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *probe-command*) printf "remote:mac:%s\\n" "$*"; for argument in "$@"; do remote_command=$argument; done; exec /bin/bash -c "$remote_command" ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    '  *linux-host*) printf "wrong-target:linux\\n" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--tty', '--cwd=apps/cli/dist', `--env=PROBE_VALUE=${environmentValue}`, '--env=PROBE_EMPTY=', '--', 'probe-command', "ok'\n"], {
    cwd: join(repoRoot, 'apps', 'stack'),
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      PROBE_SSH_LOG: sshLog,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /selected mac-host/);
  assert.match(result.stderr, /remote-error/);
  assert.match(result.stdout, /remote:mac:/);
  assert.match(result.stdout, /-tt .*ControlMaster=no.*ControlPath=none/);
  assert.ok(result.stdout.includes(`${remoteRepo}/apps/cli/dist`));
  assert.match(result.stdout, /export PROBE_VALUE=/);
  assert.ok(result.stdout.includes(`value<${environmentValue}>empty<>arg<ok'\n>`), result.stdout);
  assert.doesNotMatch(result.stdout, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout, /wrong-target:linux/);
  const transportBeforeInvalidOptions = await readFile(sshLog, 'utf8');
  for (const option of ['--env=BAD-KEY=value', '--cwd=apps/../../outside']) {
    const rejected = spawnSync('/bin/sh', [launcher, '--target=mac-host', option, '--', 'probe-command'], {
      cwd: repoRoot,
      env: {
        ...executionNeutralEnv,
        HOME: root,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: root,
        PROBE_SSH_LOG: sshLog,
      },
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1, rejected.stderr);
  }
  assert.equal(await readFile(sshLog, 'utf8'), transportBeforeInvalidOptions);
});

test('native launcher exact target fails closed when its command connection is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-connection-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac-host'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/mac-repo'",
    "target_1_cli_home='/remote/mac-home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='linux'",
    "target_2_ssh='linux-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/linux-repo'",
    "target_2_cli_home='/remote/linux-home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'debug_log=; previous=; last_argument=',
    'for argument in "$@"; do [ "$previous" != -E ] || debug_log=$argument; previous=$argument; last_argument=$argument; done',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac-host*) printf "8 0.1 0.9 22000000 10\\n" ;; *) printf "8 0.2 0.8 22000000 10\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *mac-host*) [ -z "$debug_log" ] || printf "ssh: connect to host mac-host port 22: Connection refused\\n" > "$debug_log"; exit 255 ;;',
    '  *linux-host*) printf "wrong-target:linux\\n" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await writeFile(cacheDir, 'occupied\n');
  const cacheFailure = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.equal(cacheFailure.status, 1, cacheFailure.stderr);
  assert.doesNotMatch(cacheFailure.stdout, /wrong-target:linux|wrong-local/);
  await rm(cacheDir);

  const temporaryFailure = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], {
    ...invocation,
    env: { ...invocation.env, TMPDIR: join(root, 'missing') },
  });
  assert.equal(temporaryFailure.status, 1, temporaryFailure.stderr);
  assert.doesNotMatch(temporaryFailure.stdout, /wrong-target:linux|wrong-local/);

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mac-host.*command connection/i);
  assert.doesNotMatch(result.stdout, /wrong-target:linux|wrong-local/);
});

test('native load probe samples heavyweight memory through the configured executor checkout', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000 });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const executorRepo = resolve(native.launcher, '../../../..');
  const commandRepo = join(fixture.root, 'command checkout 0.2');
  const commandBin = join(commandRepo, 'apps/stack/bin');
  await mkdir(commandBin, { recursive: true });
  // The command checkout is a predecessor shim, not the host's execution owner.
  // With no sibling named 0.3 it cannot supply the native memory subcommand.
  await executable(join(commandBin, 'hstack-exec'), '#!/bin/sh\nexit 97\n');
  const projection = join(fixture.stackDir, 'dev-target-exec-v1.sh');
  await writeNativeProjectionFixture(projection, (await readFile(projection, 'utf8'))
    .replace(/^target_2_repo_dir=.*$/m, `target_2_repo_dir='${commandRepo}'`)
    + `target_2_executor_repo_dir='${executorRepo}'\n`);
  // SSH is the genuine remote boundary. Execute the real generated load probe,
  // while payload dispatch remains a disposable external command.
  await executable(join(fixture.binDir, 'ssh'), `#!/bin/sh
last_argument=; for argument in "$@"; do last_argument=$argument; done
case "$*" in
  *getconf*) /bin/sh -c "$last_argument" ;;
  *command\\ -v*|*-O\\ check*|*-MNf*) exit 0 ;;
  *) printf 'remote-payload\\n' ;;
esac
`);
  await executable(join(fixture.binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(fixture.binDir, 'awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*) case "$*" in *a/t*) printf '0.9 48000000 72000000 0 0\\n' ;; *) printf '48000000 72000000\\n' ;; esac ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  */proc/vmstat*) printf '0 0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  const loginEnv = join(fixture.root, 'remote-login-env');
  await writeFile(loginEnv, `export PATH='${fixture.binDir}':$PATH\n`);
  fixture.invocation.env.BASH_ENV = loginEnv;
  const result = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', 'vitest', 'run', 'fixture.test.ts'], fixture.invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote-payload\n');
  const load = (await readFile(join(fixture.stackDir, 'dev-target-command-load-native/roomy.telemetry'), 'utf8')).trim().split(/\s+/);
  assert.equal(load.at(-1), '48000000', 'the native owner must supply unreserved memory to load admission');
});

test('native launcher preserves a successful remote command when the login shell exit hook fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-exit-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = await installNativeAdmissionFixture({ root });
  const workerRepo = resolve(native.launcher, '../../../..');
  const exitHook = join(root, 'bash-exit-hook');
  await writeFile(exitHook, 'trap false EXIT\n');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const remoteRepo = resolve(native.launcher, '../../../..');
  const remoteHome = join(root, 'remote-home');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'dev-target-command-load-native'), { recursive: true });
  await mkdir(remoteRepo, { recursive: true });
  await mkdir(remoteHome, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${remoteRepo}'`,
    `target_1_executor_repo_dir='${workerRepo}'`,
    `target_1_cli_home='${remoteHome}'`,
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *"&& [ -x "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    BASH_ENV="$EXIT_HOOK" /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      EXIT_HOOK: exitHook,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  const javascriptCommand = buildRemoteExecCommand({ platform: 'posix', repoDir: remoteRepo, cliHomeDir: remoteHome }, {
    executionId: 'hook-fixture-javascript', commandArgs: ['/usr/bin/true'],
  });
  const javascript = spawnSync('/bin/bash', ['-c', `trap 'exit 41' EXIT; ${javascriptCommand}`], {
    encoding: 'utf8', env: executionNeutralEnv,
  });
  assert.equal(javascript.status, 0, javascript.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test('native launcher exact target bypasses local automatic placement from a freshly generated projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-local-policy-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac-host/);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher refreshes a projection produced by older generator bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-generator-stale-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await writeNativeProjectionFixture(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='local'",
    "fallback_mode='local'",
    "target_count='0'",
    '',
  ].join('\n'));
  const oldTimestamp = new Date(0);
  await utimes(configPath, oldTimestamp, oldTimestamp);
  await utimes(projectionPath, oldTimestamp, oldTimestamp);
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher exact target re-probes a previously unavailable command immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-recovery-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const healthyMarker = join(root, 'healthy');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    `if [ ! -f ${JSON.stringify(healthyMarker)} ]; then exit 1; fi`,
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));
  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const unavailable = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.notEqual(unavailable.status, 0);
  await writeFile(healthyMarker, 'ready\n', 'utf8');

  const recovered = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /remote:mac:/);
  assert.doesNotMatch(recovered.stdout, /wrong-local/);
});

test('native launcher exact target fails closed when no target configuration exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-unconfigured-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no target configuration/i);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher excludes a target with no free repository filesystem space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-full-disk-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 0.5 0.8 0 99\\n" ;; *) printf "8 4 0.5 22000000 98\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac2-host*) printf "wrong-target:mac2\\n" ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-target:mac2/);
});

test('native launcher keeps remote execution available when sandboxing makes stack command state read-only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-readonly-state-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const runtimeDir = join(root, 'runtime');
  t.after(async () => {
    await chmod(stackDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "execution:%s\\n" "${HAPPIER_DEV_TARGET_EXECUTION-local}"\n',
  );
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -S "$control_path" ] || [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  await chmod(stackDir, 0o555);

  const runSandboxedSession = (sessionId) => spawnSync('/bin/sh', [launcher, '--', 'probe-command', sessionId], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      CODEX_SESSION_ID: sessionId,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
  });

  const result = runSandboxedSession('first-session');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /execution:1/);
  assert.doesNotMatch(result.stdout, /execution:local/);

  const secondResult = runSandboxedSession('second-session');
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.match(secondResult.stderr, /selected mac /);

  const fallbackCacheRoot = join(root, `happier-preferred-execution-${process.getuid()}`);
  assert.equal(
    (await readdir(fallbackCacheRoot)).length,
    1,
    'sandboxed sessions for one Stack must share load samples and active dispatch reservations',
  );
});

test('native launcher admits APFS targets that round capacity to 100 percent with useful free space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-apfs-free-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 7340032 100\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
});

test('native launcher re-probes a cached unavailable target as soon as its sync becomes ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-sync-recovered-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeFile(join(cacheDir, 'mac.cache'), `${Math.floor(Date.now() / 1_000)} 0 - 1\n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|8|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 7340032 50\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
});

test('native launcher retries another target when the selected host is unreachable before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-predispatch-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'debug_log=; previous=',
    'for argument in "$@"; do [ "$previous" != -E ] || debug_log=$argument; previous=$argument; done',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *mac2-host*) printf "remote:mac2:%s\\n" "$*" ;;',
    '  *mac-host*) [ -z "$debug_log" ] || printf "ssh: connect to host mac-host port 22: Connection refused\\n" > "$debug_log"; exit 255 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stderr, /selected mac2 /);
  assert.match(result.stdout, /remote:mac2:.*probe-command.*ok/);
});



async function liveSshControlFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'ssh-control-' });
  const configPath = fixture.path('config');
  await writeFile(configPath, '');
  for (const target of ['mac-host', 'mac2-host']) {
    const server = createServer();
    await new Promise(resolveListen => server.listen(fixture.path(`${target}.sock`), resolveListen));
    t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  }
  return { controlPath: fixture.root, configPath };
}

test('native launcher uses independent connections for pinned and automatic payloads despite a refused configured master', async t => {
  const control = await liveSshControlFixture(t);
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-authoritative-mux-refused-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    `target_1_ssh_config='${control.configPath}'`,
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    `target_2_ssh_config='${control.configPath}'`,
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'debug_log=',
    'previous=',
    'last_argument=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -E ]; then debug_log=$argument; fi',
    '  previous=$argument',
    '  last_argument=$argument',
    'done',
    'case "$*" in',
    '  "-G "*) printf "controlpath %s/%s.sock\\n" "$SSH_CONTROL_PATH" "$last_argument"; exit 0 ;;',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *mac-host*)',
    '    [ "$last_argument" = : ] && exit 0',
    '    case "$*" in *ControlPath=none*) printf "remote:mac:dedicated:%s\\n" "$*"; exit 0 ;; esac',
    '    [ -z "$debug_log" ] || printf "mux_client_request_session: session request failed: Session open refused by peer\\n" > "$debug_log"',
    '    printf "mux_client_request_session: session request failed: Session open refused by peer\\n" >&2',
    '    exit 255',
    '    ;;',
    '  *mac2-host*)',
    '    [ "$last_argument" = : ] && exit 0',
    '    [ -z "$debug_log" ] || printf "debug2: mux_client_request_session: master session id: 7\\n" > "$debug_log"',
    '    printf "remote:mac2:%s\\n" "$*"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      SSH_CONTROL_PATH: control.controlPath,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const exact = spawnSync('/bin/sh', [launcher, '--target=mac', '--', 'probe-command', 'exact'], invocation);
  assert.equal(exact.status, 0, exact.stderr);
  assert.doesNotMatch(exact.stderr, /retrying.*SSH connection/i);
  assert.match(exact.stdout, /remote:mac:dedicated:.*ControlPath=none.*probe-command.*exact/);
  assert.doesNotMatch(exact.stdout, /remote:mac2|wrong-local/);

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], invocation);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.doesNotMatch(result.stderr, /retrying.*SSH connection/i);
  assert.match(result.stdout, /remote:mac:dedicated:.*ControlPath=none.*probe-command.*ok/);
  assert.doesNotMatch(result.stderr, /selected mac2 /);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher replaces only certified pre-payload dispatch refusals', async t => {
  for (const scenario of ['kex', 'connect', 'proxy-pin', 'proxy-all', 'pin', 'all', 'sync', 'after-start', 'fallback', 'sync-all']) {
    await t.test(scenario, async t => {
      const fixture = await createTempFixture(t, { prefix: 'hstack-dispatch-refusal-' });
      const root = fixture.root;
      const control = await liveSshControlFixture(t);
      const bin = fixture.path('bin');
      const storage = fixture.path('stacks');
      const stack = join(storage, 'repo-dispatch');
      const proxyRefusal = scenario.includes('proxy');
      let resetPort = '';
      let realSsh = '';
      if (proxyRefusal) {
        realSsh = spawnSync('/bin/sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).stdout.trim();
        assert.ok(realSsh, 'the proxy-hop regression requires real OpenSSH');
        // Real TCP/SSH boundary: the proxy hop resets before accepting a session.
        // ERROR hides the parent diagnostic while the proxy writes to stderr.
        const resetServer = createServer(socket => socket.resetAndDestroy());
        await new Promise(resolve => resetServer.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => resetServer.close(resolve)));
        resetPort = String(resetServer.address().port);
      }
      await mkdir(bin, { recursive: true });
      await mkdir(join(stack, 'mutagen/data'), { recursive: true });
      await writeFile(join(stack, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
      await writeNativeProjectionFixture(join(stack, 'dev-target-exec-v1.sh'), [
        "HSTACK_EXEC_PROJECTION_VERSION='2'", `projection_repo_root='${repoRoot}'`,
        "command_mode='auto'", "include_local='0'", `fallback_mode='${scenario === 'fallback' || scenario === 'sync-all' ? 'local' : 'error'}'`,
        "load_ttl_seconds='15'", "unavailable_ttl_seconds='120'", "target_count='2'",
        ...['mac', 'mac2'].flatMap((name, index) => [
          `target_${index + 1}_name='${name}'`, `target_${index + 1}_ssh='${name}-host'`,
          `target_${index + 1}_ssh_config='${control.configPath}'`, `target_${index + 1}_repo_dir='/remote/repo'`,
          `target_${index + 1}_cli_home='/remote/home'`, `target_${index + 1}_remote_path='/usr/bin:/bin'`,
        ]), '',
      ].join('\n'));
      await executable(join(bin, 'node'), '#!/bin/sh\nexit 97\n');
      await executable(join(bin, 'probe-command'), '#!/bin/sh\nprintf "local-payload\\n"\n');
      await executable(join(bin, 'mutagen'), `#!/bin/sh
if [ "$SCENARIO" = sync ] && [ "$2" = flush ]; then
  case "$3" in *-mac) printf 'read-only filesystem during flush\\n' >&2; exit 1 ;; esac
fi
if [ "$SCENARIO" = sync-all ] && [ "$2" = flush ]; then exit 1; fi
if [ "$2" = flush ]; then printf '%s\\n' "$3" >> "$FLUSHES"; fi
printf '%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n' "$3"
`);
      await executable(join(bin, 'ssh'), `#!/bin/sh
debug_log=; previous=; target=; last_argument=; log_level=
for argument in "$@"; do
  [ "$previous" != -E ] || debug_log=$argument
  case "$argument" in mac-host|mac2-host) target=$argument ;; esac
  case "$argument" in LogLevel=*) log_level=\${argument#LogLevel=} ;; esac
  previous=$argument; last_argument=$argument
done
case "$*" in
  "-G "*) printf 'controlpath %s/%s.sock\\n' "$SSH_CONTROL_PATH" "$target"; exit 0 ;;
  *getconf*) case "$target" in mac-host) printf '8 1 0.5\\n' ;; *) printf '8 4 0.5\\n' ;; esac; exit 0 ;;
  *command\\ -v*|*-O\\ check*|*-MNf*) exit 0 ;;
esac
[ "$last_argument" != : ] || exit 0
case "$last_argument" in *' cancel '*) exit 0 ;; esac
printf '%s\\n' "$target" >> "$ATTEMPTS"
if [ "$target" = mac2-host ] && [ "$SCENARIO" != all ] && [ "$SCENARIO" != proxy-all ] && [ "$SCENARIO" != fallback ]; then
  printf '%s\\n' "$target" >> "$PAYLOADS"; printf 'payload:mac2\\n'; exit 0
fi
case "$SCENARIO" in
  *proxy*)
    grep -Fx "happier-\${target%-host}" "$FLUSHES" >/dev/null || exit 83
    case "$*" in
      *ControlPath=none*)
        exec "$REAL_SSH" -F /dev/null -E "$debug_log" -o "LogLevel=$log_level" \
          -o IdentityFile=none -o IdentitiesOnly=yes -o ControlMaster=no -o ControlPath=none -o BatchMode=yes \
          -o "ProxyCommand=$REAL_SSH -F /dev/null -o IdentityFile=none -o IdentitiesOnly=yes -p $RESET_PORT 127.0.0.1 -W 127.0.0.1:22" 127.0.0.1 : ;;
      *) printf 'mux_client_request_session: session request failed: Session open refused by peer\\n' > "$debug_log" ;;
    esac ;;
  after-start)
    printf '%s\\n' "$target" >> "$PAYLOADS"
    printf 'payload:mac\\n'
    printf 'kex_exchange_identification: read: Connection reset by peer\\n' >&2
    printf 'client_loop: read: Connection reset by peer\\n' > "$debug_log" ;;
  connect) printf 'ssh: connect to host mac-host port 22: Connection refused\\n' > "$debug_log" ;;
  *) printf 'kex_exchange_identification: read: Connection reset by peer\\n' > "$debug_log" ;;
esac
exit 255
`);
      const env = { ...executionNeutralEnv, HOME: root, XDG_RUNTIME_DIR: root,
        HAPPIER_STACK_STORAGE_DIR: storage, HAPPIER_EXEC_CONFIG_PATH: join(stack, 'dev-targets.json'),
        PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root,
        SSH_CONTROL_PATH: control.controlPath,
        SCENARIO: scenario, ATTEMPTS: fixture.path('attempts'), PAYLOADS: fixture.path('payloads'),
        FLUSHES: fixture.path('flushes'), REAL_SSH: realSsh, RESET_PORT: resetPort };
      const invoke = () => new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', [launcher,
          ...(scenario === 'pin' || scenario === 'proxy-pin' ? ['--target=mac'] : []), '--', 'probe-command'],
        { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', status => resolve({ status, stdout, stderr }));
      });
      const result = await invoke();
      const lines = async name => (await readFile(fixture.path(name), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; throw error;
      })).trim().split('\n').filter(Boolean);
      if (scenario === 'after-start') {
        assert.equal(result.status, 255, result.stderr);
        assert.deepEqual(await lines('payloads'), ['mac-host']);
        assert.deepEqual(await lines('attempts'), ['mac-host']);
      } else if (scenario === 'fallback') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /local-payload/);
        assert.deepEqual(await lines('payloads'), []);
        const again = await invoke();
        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stdout, /local-payload/);
        assert.deepEqual(await lines('attempts'), ['mac-host', 'mac2-host']);
      } else if (scenario === 'sync-all') {
        for (const failed of [result, await invoke()]) {
          assert.notEqual(failed.status, 0);
          assert.match(failed.stderr, /HSTACK_EXEC_DISPATCH_REFUSED/);
          assert.match(failed.stderr, /mac=sync/);
          assert.match(failed.stderr, /mac2=sync/);
          assert.doesNotMatch(failed.stdout, /local-payload/);
        }
        assert.deepEqual(await lines('attempts'), []);
      } else if (scenario === 'pin' || scenario === 'all' || scenario === 'proxy-pin' || scenario === 'proxy-all') {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /HSTACK_EXEC_DISPATCH_REFUSED/);
        assert.match(result.stderr, /mac=ssh/);
        if (scenario === 'all' || scenario === 'proxy-all') assert.match(result.stderr, /mac2=ssh/);
        assert.deepEqual(await lines('payloads'), []);
        const expectedAttempts = scenario === 'pin' || scenario === 'proxy-pin' ? ['mac-host'] : ['mac-host', 'mac2-host'];
        assert.deepEqual(await lines('attempts'), expectedAttempts);
        if (scenario === 'all' || scenario === 'proxy-all') {
          const again = await invoke();
          assert.notEqual(again.status, 0);
          assert.match(again.stderr, /HSTACK_EXEC_DISPATCH_REFUSED/);
          assert.match(again.stderr, /mac=ssh/);
          assert.match(again.stderr, /mac2=ssh/);
          assert.deepEqual(await lines('attempts'), expectedAttempts);
        }
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await lines('payloads'), ['mac2-host'], 'payload executes exactly once');
        assert.deepEqual(await lines('attempts'), scenario === 'sync' ? ['mac2-host'] : ['mac-host', 'mac2-host']);
        const negative = await readFile(join(stack, 'dev-target-command-load-native/mac.cache'), 'utf8');
        assert.match(negative, /^\d+ 0 - 1 dispatch-(ssh|sync)\n$/);
        const again = await invoke();
        assert.equal(again.status, 0, again.stderr);
        assert.deepEqual(await lines('payloads'), ['mac2-host', 'mac2-host']);
        assert.equal((await lines('attempts')).filter(name => name === 'mac-host').length,
          scenario === 'sync' ? 0 : 1,
          'unavailable TTL prevents another dispatch to the refusing target');
      }
    });
  }
});

test('native launcher never replays an authoritative remote command that starts and exits 255', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-authoritative-255-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'debug_log=',
    'previous=',
    'last_argument=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -E ]; then debug_log=$argument; fi',
    '  previous=$argument',
    '  last_argument=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *mac-host*)',
    '    [ "$last_argument" = : ] && exit 0',
    '    [ -z "$debug_log" ] || printf "client_loop: send disconnect: Broken pipe\\n" > "$debug_log"',
    '    printf "authoritative-command-started\\n"',
    '    exit 255',
    '    ;;',
    '  *mac2-host*) printf "wrong-target:mac2\\n"; exit 0 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 255, result.stderr);
  assert.match(result.stdout, /authoritative-command-started/);
  assert.match(result.stderr, /client_loop: send disconnect: Broken pipe/);
  assert.doesNotMatch(result.stdout, /wrong-target:mac2|wrong-local/);
  assert.doesNotMatch(result.stderr, /selected mac2 /);
});

test('native launcher accounts for an in-flight dispatch from another sandboxed session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-in-flight-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const holdMarker = join(root, 'first-started');
  const releaseMarker = join(root, 'release-first');
  const collisionMarker = join(root, 'second-selected-busy-target');
  t.after(async () => {
    await chmod(stackDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "2 0.25 0.5\\n" ;; *) printf "8 2.4 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac2-host*)',
    '    if [ -e "$HOLD_MARKER" ]; then : > "$COLLISION_MARKER"; printf "remote:mac2-second\\n"; exit 0; fi',
    '    : > "$HOLD_MARKER"',
    '    while [ ! -e "$RELEASE_MARKER" ]; do sleep 0.02; done',
    '    printf "remote:mac2-first\\n"',
    '    ;;',
    '  *mac-host*) printf "remote:mac-second\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    HOLD_MARKER: holdMarker,
    RELEASE_MARKER: releaseMarker,
    COLLISION_MARKER: collisionMarker,
  };
  await chmod(stackDir, 0o555);

  const first = spawn('/bin/sh', [launcher, '--', 'probe-command', 'first'], {
    cwd: repoRoot,
    env: { ...env, CODEX_SESSION_ID: 'first-sandboxed-session' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstExited = new Promise((resolveExit) => first.once('exit', resolveExit));
  const firstOutput = { stdout: '', stderr: '' };
  first.stdout.on('data', (chunk) => { firstOutput.stdout += chunk; });
  first.stderr.on('data', (chunk) => { firstOutput.stderr += chunk; });
  let second;
  let dispatchError;
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        await readFile(holdMarker);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(holdMarker);
    second = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'second'], {
      cwd: repoRoot,
      env: { ...env, CODEX_SESSION_ID: 'second-sandboxed-session' },
      encoding: 'utf8',
    });
  } catch (error) {
    dispatchError = error;
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
  }
  const firstStatus = await firstExited;

  if (dispatchError) throw dispatchError;

  assert.equal(firstStatus, 0, firstOutput.stderr);
  assert.match(firstOutput.stderr, /selected mac2/);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /selected mac /);
  assert.match(second.stdout, /remote:mac-second/);
  await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
});

test('anonymous controller probe and dispatch locks cannot hold reachable work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dispatch-backoff-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const dispatchLock = join(cacheDir, 'dispatch.lock');
  const sleepAttempts = join(root, 'dispatch-sleep-attempts');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(dispatchLock, { recursive: true });
  await mkdir(join(cacheDir, 'remote.cache.lock'));
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'sleep'), [
    '#!/bin/sh',
    'printf "%s\\n" "$1" >> "$DISPATCH_SLEEP_ATTEMPTS"',
    'exec /bin/sleep "${DISPATCH_SLEEP_ACTUAL_SECONDS-$1}"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'stat'), [
    '#!/bin/sh',
    'case "$1" in',
    '  -c) printf "1\\n" ;;',
    '  -f) printf "/\\n" ;;',
    '  *) exec /usr/bin/stat "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote-host*) printf "remote:dispatch\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    DBUS_SESSION_BUS_ADDRESS: '',
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    DISPATCH_SLEEP_ATTEMPTS: sleepAttempts,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'status'], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 1_000,
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}`);
  assert.match(result.stdout, /remote:dispatch/);
  assert.deepEqual(await readdir(dispatchLock), [], 'obsolete state is neither admission authority nor reclaimed by age');
});

test('native launcher cache writes and reservations survive reused sandbox process ids', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-pid-namespace-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const staleReservation = join(cacheDir, 'remote.active.reused-namespace-pid');
  const wrapper = join(root, 'launch-with-reused-pid');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'remote.cache'), `${cachedAt} 1 0.125000 8\n`);
  await writeFile(join(cacheDir, `remote.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-remote-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *-MNf*|*-O\\ check*|*-O\\ exit*) exit 0 ;;',
    '  *) printf "remote:reused-pid\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(wrapper, [
    '#!/bin/sh',
    `printf '%s\\nvalidation\\nstale-execution\\n' "$$" > '${staleReservation}'`,
    `mkdir '${cacheDir}/remote.active.'"$$"'.'"$$"'.tmp'`,
    `exec /bin/sh '${launcher}' -- probe-command status`,
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [wrapper], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:reused-pid/);
  assert.doesNotMatch(result.stderr, /reservation failed|cannot create|cannot stat/i);
  const hasFlock = spawnSync('/bin/sh', ['-c', 'command -v flock'], {
    env: { PATH: `${binDir}:/usr/bin:/bin` },
    stdio: 'ignore',
  }).status === 0;
  if (hasFlock) {
    await assert.rejects(readFile(staleReservation), { code: 'ENOENT' });
  } else {
    t.diagnostic('flock unavailable; PID-namespace stale-reservation reclamation is Linux-only');
  }
});

for (const platform of ['linux', 'darwin']) {
test(`native launcher keeps ${platform} control commands preferred and adapts recognized worker tools to pressure`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-resource-governor-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'flock'), [
    '#!/bin/sh',
    '# Reservation fixtures model locks held by another dispatcher.',
    '[ "${1-}" = -n ] && [ "${3-}" = -c ] && exit 1',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'));
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) if [ "$GOVERNOR_PLATFORM" = darwin ]; then printf "14 1 0.8 22000000 20 0 57600000 72000000 0 0 0 0 0 0 0 darwin\\n"; else case "${GOVERNOR_PRESSURE-}" in quiet) printf "14 1 0.8 22000000 20 2 48000000 72000000 0 0 0 0 0 0 0 linux 48000000\\n" ;; *) printf "14 360 0.8 22000000 20 420 48000000 72000000 0 0 90 0 0 0 0 linux 48000000\\n" ;; esac; fi ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; eval "set -- $remote_command"; /bin/bash -n -c "$3" || exit $?; printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    GOVERNOR_PLATFORM: platform,
  };

  // Darwin has no Linux PSI/run-queue sample. Existing live dispatch
  // reservations still share its CPU capacity between nested workers. Linux
  // must use observed pressure instead of treating waiting reservations as CPU.
  const reservations = [];
  const processToken = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity',
    join(import.meta.dirname, 'utils/proc/native_process_identity.sh'), String(process.pid)], {
    encoding: 'utf8', env: executionNeutralEnv,
  }).stdout.trim();
  assert.notEqual(processToken, '-');
  if (platform === 'darwin' || platform === 'linux') {
    const cacheDir = join(stackDir, 'dev-target-command-load-native');
    await mkdir(cacheDir, { recursive: true });
    const reservationCount = platform === 'darwin' ? 13 : 7;
    for (let index = 0; index < reservationCount; index += 1) {
      const path = join(cacheDir, `linux.active.fixture-${index}`);
      await writeFile(path, `${process.pid}\nvalidation\nfixture-${index}\n${processToken}\n\n`);
      reservations.push(path);
    }
  }

  const control = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'status'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const vitest = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const search = spawnSync('/bin/sh', [launcher, '--', 'rg', 'needle', 'sources'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const typecheck = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const sourceExport = spawnSync('/bin/sh', [launcher, '--', 'node', 'apps/stack/scripts/build/build_source_web_ui.mjs'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedVitest = spawnSync('/bin/sh', [launcher, '--script=test:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedNonVitestTest = spawnSync('/bin/sh', [launcher, '--script=test:migration:bundled-plugin-projections'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const directNonVitestTest = spawnSync('/bin/sh', [launcher, '--', 'yarn', '-s', 'test:migration:bundled-plugin-projections'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedTypecheck = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--maxWorkers=6'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestPoolWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--poolOptions.forks.maxForks=6'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestEnvironment = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run'], {
    cwd: repoRoot,
    env: { ...env, VITEST_MAX_THREADS: '7' },
    encoding: 'utf8',
  });
  const explicitPackageWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run'], {
    cwd: repoRoot,
    env: { ...env, HAPPIER_VITEST_MAX_WORKERS: '2', VITEST_UI_MAX_FORKS: '3' },
    encoding: 'utf8',
  });
  const explicitRemoteVitestEnvironment = spawnSync('/bin/sh', [launcher, '--target=linux', '--env=VITEST_MAX_FORKS=3', '--', 'vitest', 'run'], {
    cwd: repoRoot,
    env: { ...env, VITEST_MAX_FORKS: '7' },
    encoding: 'utf8',
  });
  const explicitTypeScriptEnvironment = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
    cwd: repoRoot,
    env: { ...env, GOMAXPROCS: '7', HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' },
    encoding: 'utf8',
  });
  if (platform === 'darwin') {
    for (const path of reservations) await rm(path);
  }
  const quietVitest = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: { ...env, GOVERNOR_PRESSURE: 'quiet' },
    encoding: 'utf8',
  });
  if (platform === 'linux') {
    for (const path of reservations) await rm(path);
  }

  for (const [name, result] of Object.entries({
    control,
    vitest,
    search,
    typecheck,
    sourceExport,
    scriptedVitest,
    scriptedNonVitestTest,
    directNonVitestTest,
    scriptedTypecheck,
    quietVitest,
    explicitVitestWorkers,
    explicitVitestPoolWorkers,
    explicitVitestEnvironment,
    explicitPackageWorkers,
    explicitRemoteVitestEnvironment,
    explicitTypeScriptEnvironment,
  })) {
    assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  }
  assert.doesNotMatch(control.stdout, /nice -n 10|--maxWorkers|--threads|--singleThreaded/);
  assert.match(vitest.stdout, /HAPPIER_VITEST_GOVERNOR_MAX_WORKERS=1.*nice -n 10.*vitest/s);
  assert.doesNotMatch(vitest.stdout, /export VITEST_MAX_THREADS=|export VITEST_MAX_FORKS=|--maxWorkers|--minWorkers/);
  assert.doesNotMatch(vitest.stdout, /fi;;/);
  assert.match(search.stdout, /nice -n 10.*rg.*--threads=1/s);
  assert.match(typecheck.stdout, /GOMAXPROCS=1.*nice -n 10.*runTypeScriptCli\.mjs/s);
  assert.match(sourceExport.stdout, /GOMAXPROCS=1.*nice -n 10.*build_source_web_ui\.mjs/s);
  assert.doesNotMatch(typecheck.stdout, /--singleThreaded/);
  assert.match(scriptedVitest.stdout, /HAPPIER_VITEST_GOVERNOR_MAX_WORKERS=1.*nice -n 10.*pnpm.*run.*--silent.*test:local/s);
  assert.doesNotMatch(scriptedVitest.stdout, /--maxWorkers|--minWorkers/);
  assert.match(
    scriptedNonVitestTest.stdout,
    /HAPPIER_VITEST_GOVERNOR_MAX_WORKERS=1.*nice -n 10.*pnpm.*run.*--silent.*test:migration:bundled-plugin-projections/s,
  );
  assert.doesNotMatch(scriptedNonVitestTest.stdout, /--maxWorkers|--minWorkers/);
  assert.match(
    directNonVitestTest.stdout,
    /nice -n 10.*yarn.*-s.*test:migration:bundled-plugin-projections/s,
  );
  assert.doesNotMatch(directNonVitestTest.stdout, /--maxWorkers|--minWorkers/);
  assert.match(scriptedTypecheck.stdout, /GOMAXPROCS=1.*nice -n 10.*pnpm.*run.*--silent.*typecheck:local/s);
  assert.match(quietVitest.stdout, /nice -n 10.*vitest/s);
  assert.doesNotMatch(quietVitest.stdout, /HAPPIER_VITEST_GOVERNOR_MAX_WORKERS=|VITEST_MAX_THREADS=|--maxWorkers/);
  assert.match(explicitVitestWorkers.stdout, /vitest.*--maxWorkers=6/s);
  assert.doesNotMatch(explicitVitestWorkers.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitVitestPoolWorkers.stdout, /vitest.*--poolOptions\.forks\.maxForks=6/s);
  assert.doesNotMatch(explicitVitestPoolWorkers.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitVitestEnvironment.stdout, /VITEST_MAX_THREADS=.*7/s);
  assert.doesNotMatch(explicitVitestEnvironment.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitPackageWorkers.stdout, /export HAPPIER_VITEST_MAX_WORKERS=.*2/s);
  assert.match(explicitPackageWorkers.stdout, /export VITEST_UI_MAX_FORKS=.*3/s);
  assert.doesNotMatch(explicitPackageWorkers.stdout, /export VITEST_MAX_THREADS=|export VITEST_MAX_FORKS=|--maxWorkers/);
  assert.match(explicitRemoteVitestEnvironment.stdout, /VITEST_MAX_FORKS=.*7.*VITEST_MAX_FORKS=.*3/s);
  assert.doesNotMatch(explicitRemoteVitestEnvironment.stdout, /--maxWorkers=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitTypeScriptEnvironment.stdout, /GOMAXPROCS=.*7/s);
  assert.doesNotMatch(explicitTypeScriptEnvironment.stdout, /GOMAXPROCS=1/);
  assert.match(explicitTypeScriptEnvironment.stdout, /export HAPPIER_TYPESCRIPT_COMPILER=.*microsoft/s);
  if (platform === 'darwin') {
    for (const result of [vitest, scriptedVitest, typecheck, search]) {
      assert.doesNotMatch(result.stdout, /--heavyweight-admission|systemd-run|\/proc\//);
    }
  }
});
}

test('native launcher excludes a low-load target that cannot launch the requested command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-command-capability-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    // Tool and telemetry checks share one SSH request at the OS boundary.
    '  *getconf*) case "$*" in *mac2-host*) exit 73 ;; esac; printf "8 4 1 10000000 1 0 28000000 28000000 0 0 0 0 0 0 0 linux\\n28000000 0 28000000 0\\n-\\n" ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:.*mac-host.*probe-command.*ok/);
  assert.doesNotMatch(result.stdout, /mac2-host/);
});

test('native launcher bootstraps dependency-consuming commands and leaves source-only commands bootstrap-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dependency-admission-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "source_test_components='apps/cli'",
    "source_test_configs='vitest.config.ts'",
    "source_test_scripts='vitest vitest:local'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac2'",
    "target_1_ssh='mac2-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 20 2 48000000 72000000 1000 8000000 0.1 0.2 0.3 4 5 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*run-vitest-with-heartbeat.mjs*) printf "vitest-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*corepack*yarn*--cwd*apps/ui*vitest*) printf "cwd-vitest-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*typecheck:local*) printf "typed-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*generateBundledPluginEntries.ts*--mode*check*) printf "plugin-generator-check-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*test:migration:bundled-plugin-projections*) printf "plugin-projection-script-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*test:migration:governance*) printf "migration-governance-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*typecheck:local*) printf "typed-after-bootstrap:%s\\n" "$*" ;;',
    '  *typecheck:local*) printf "typed-without-bootstrap\\n"; exit 42 ;;',
    '  *remote_dependency_bootstrap.mjs*custom:script*) printf "custom-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*test:integration:local*) printf "integration-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*vitest*) printf "vitest-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*tsc*) printf "tsc-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*runTypeScriptCli.mjs*) printf "typescript-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*--test*) printf "stack-test-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "unexpected-bootstrap\\n"; exit 43 ;;',
    '  *source-only*|*find*) printf "source-only:%s\\n" "$*" ;;',
    '  *rg*) printf "raw-search:%s\\n" "$*" ;;',
    '  *) printf "unexpected:%s\\n" "$*"; exit 44 ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };

  const sourceOnlyCommands = [
    ['node', '-e', 'console.log("source-only")'],
    ['nodejs', 'source-only.mjs'],
    ['find', '.', '-name', '*.mjs'],
  ];
  for (const commandArgs of sourceOnlyCommands) {
    const result = spawnSync('/bin/sh', [launcher, '--', ...commandArgs], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${commandArgs.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /source-only:/);
    assert.doesNotMatch(result.stdout, /remote_dependency_bootstrap\.mjs/);
  }
  const dependencyCommands = [
    ['yarn', '-s', 'custom:script'],
    ['vitest', 'run', 'owner.test.ts'],
    ['tsc', '--noEmit'],
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'],
    ['node', 'node_modules/vitest/vitest.mjs', 'run', 'owner.test.ts'],
    ['nodejs', 'node_modules/vitest/vitest.mjs', 'run', 'owner.test.ts'],
    ['node', '--test', 'source-only.test.mjs'],
    ['node', '--test', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
    ['nodejs', '--test', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
  ];
  for (const commandArgs of dependencyCommands) {
    const result = spawnSync('/bin/sh', [launcher, '--', ...commandArgs], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${commandArgs.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /after-bootstrap:/);
    assert.match(result.stdout, /remote_dependency_bootstrap\.mjs/);
  }

  const sourceTest = spawnSync('/bin/sh', [launcher, '--', 'corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'vitest:local', 'run', 'arbitrary.test.ts'], {
    cwd: repoRoot, env, encoding: 'utf8',
  });
  assert.equal(sourceTest.status, 0, `${sourceTest.stderr}\n${sourceTest.stdout}`);
  assert.match(sourceTest.stdout, /--validation-kind=source-test/);

  const integrationTest = spawnSync('/bin/sh', [launcher, '--script=test:integration:local'], {
    cwd: join(repoRoot, 'apps/cli'), env, encoding: 'utf8',
  });
  assert.equal(integrationTest.status, 0, `${integrationTest.stderr}\n${integrationTest.stdout}`);
  assert.match(integrationTest.stdout, /remote_validation_preparation\.mjs/);
  assert.match(integrationTest.stdout, /--validation-kind=runtime/);

  const typed = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(typed.status, 0, `${typed.stderr}\n${typed.stdout}`);
  assert.match(typed.stdout, /typed-after-bootstrap/);
  assert.match(typed.stdout, /remote_dependency_bootstrap\.mjs/);
  assert.match(typed.stdout, /node .*remote_dependency_bootstrap\.mjs/);
  assert.doesNotMatch(typed.stdout, /corepack .*yarn .*node .*remote_dependency_bootstrap\.mjs/);
  assert.match(typed.stdout, /HAPPIER_STACK_PM_CACHE_BASE_DIR.*remote\/home\/cache/);

  const componentTyped = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env,
    encoding: 'utf8',
  });
  assert.equal(componentTyped.status, 0, componentTyped.stderr);
  assert.match(componentTyped.stdout, /typed-after-preparation/);
  assert.match(componentTyped.stdout, /remote_validation_preparation\.mjs/);
  assert.match(componentTyped.stdout, /--validation-kind=typecheck/);

  for (const runtime of ['node', 'nodejs']) {
    const relativeCompiler = spawnSync('/bin/sh', [launcher, '--', runtime, '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
      cwd: join(repoRoot, 'apps', 'cli'), env, encoding: 'utf8',
    });
    assert.equal(relativeCompiler.status, 0, `${relativeCompiler.stderr}\n${relativeCompiler.stdout}`);
    assert.match(relativeCompiler.stdout, /typescript-after-bootstrap:/);
    assert.match(relativeCompiler.stdout, /remote_validation_preparation\.mjs/);
    assert.match(relativeCompiler.stdout, /--validation-kind=typecheck/);
    assert.match(relativeCompiler.stdout, /GOMAXPROCS/);
  }

  const composedVitest = spawnSync('/bin/sh', [
    launcher,
    '--',
    'yarn',
    '--cwd',
    'packages/tests',
    'node',
    'scripts/run-vitest-with-heartbeat.mjs',
    '--config',
    'vitest.core.slow.config.ts',
    'suites/example.slow.e2e.test.ts',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(composedVitest.status, 0, composedVitest.stderr);
  assert.match(composedVitest.stdout, /vitest-after-preparation/);
  assert.match(composedVitest.stdout, /remote_validation_preparation\.mjs/);
  assert.match(composedVitest.stdout, /--component-relative-dir=packages\/tests/);
  assert.match(composedVitest.stdout, /HAPPIER_VITEST_GOVERNOR_MAX_WORKERS=[1-9][0-9]*/s);
  assert.doesNotMatch(composedVitest.stdout, /--maxWorkers|--minWorkers/);

  const cwdVitest = spawnSync('/bin/sh', [
    launcher,
    '--',
    'corepack',
    'yarn',
    '--cwd',
    'apps/ui',
    'vitest:local',
    'run',
    'sources/example.test.ts',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(cwdVitest.status, 0, cwdVitest.stderr);
  assert.match(cwdVitest.stdout, /cwd-vitest-after-preparation/);
  assert.match(cwdVitest.stdout, /--component-relative-dir=apps\/ui/);

  const directPluginCheck = spawnSync('/bin/sh', [
    launcher,
    '--',
    'node',
    '--experimental-strip-types',
    'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
    '--mode',
    'check',
    '--scope',
    'projections',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(directPluginCheck.status, 0, directPluginCheck.stderr);
  assert.match(directPluginCheck.stdout, /plugin-generator-check-after-preparation/);
  assert.match(directPluginCheck.stdout, /--component-relative-dir=apps\/cli/);

  const pluginProjectionScript = spawnSync('/bin/sh', [
    launcher,
    '--script=test:migration:bundled-plugin-projections',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(pluginProjectionScript.status, 0, pluginProjectionScript.stderr);
  assert.match(pluginProjectionScript.stdout, /plugin-projection-script-after-preparation/);
  assert.match(pluginProjectionScript.stdout, /--component-relative-dir=apps\/cli/);

  const migrationGovernance = spawnSync('/bin/sh', [
    launcher,
    '--script=test:migration:governance',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(migrationGovernance.status, 0, migrationGovernance.stderr);
  assert.match(migrationGovernance.stdout, /migration-governance-after-preparation/);
  assert.match(migrationGovernance.stdout, /--component-relative-dir=apps\/cli/);

  const raw = spawnSync('/bin/sh', [launcher, '--', 'rg', '-n', 'needle'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /raw-search/);
  assert.doesNotMatch(raw.stdout, /remote_dependency_bootstrap\.mjs/);

  for (const flag of ['HAPPIER_STACK_SKIP_REFRESH_DEPS', 'HAPPIER_STACK_DISABLE_REFRESH_DEPS']) {
    for (const explicit of [false, true]) {
      const result = spawnSync('/bin/sh', [launcher, '--target=mac2',
        ...(explicit ? [`--env=${flag}=1`] : []), '--', 'vitest', 'run', 'owner.test.ts'], {
        cwd: repoRoot, env: { ...env, [flag]: explicit ? '0' : '1' }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const beforeBootstrap = result.stdout.split('remote_dependency_bootstrap.mjs')[0].replaceAll("'\"'\"'", "'");
      const assignments = [...beforeBootstrap.matchAll(new RegExp(`export ${flag}='([^']*)'`, 'g'))];
      assert.equal(assignments.at(-1)?.[1], '1', 'no-refresh policy must reach bootstrap, including explicit overrides');
    }
  }

  const provenanceLines = (await readFile(
    join(stackDir, 'dev-target-command-load-native', 'provenance.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));
  const admittedClasses = provenanceLines
    .filter((entry) => entry.phase === 'admitted')
    .map((entry) => entry.commandClass);
  assert.deepEqual(admittedClasses, [
    ...sourceOnlyCommands.map((args) => args[0] === 'find' ? 'source-search' : 'unclassified'),
    ...dependencyCommands.map((args) => args.includes('custom:script') ? 'unclassified'
      : args.some(arg => arg.startsWith('apps/stack/')) ? 'targeted-validation' : 'full-validation'),
    'targeted-validation',
    'targeted-validation',
    'full-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'source-search',
    ...Array(4).fill('full-validation'),
  ]);
  assert.equal(provenanceLines.filter((entry) => entry.phase === 'completed').length, admittedClasses.length);
  assert.equal(provenanceLines.every((entry) => entry.schemaVersion === 1), true);
  assert.equal(provenanceLines.every((entry) => !('commandArgs' in entry)), true);
  assert.equal(provenanceLines.every((entry) => (
    entry.phase !== 'admitted' || entry.activeClassReservations === 0
  )), true);
  assert.deepEqual(
    {
      runQueue: provenanceLines[0].runQueue,
      memAvailableKiB: provenanceLines[0].memAvailableKiB,
      swapUsedKiB: provenanceLines[0].swapUsedKiB,
      memoryPsiAvg10: provenanceLines[0].memoryPsiAvg10,
      swapInPages: provenanceLines[0].swapInPages,
      platform: provenanceLines[0].platform,
    },
    {
      runQueue: 2,
      memAvailableKiB: 48_000_000,
      swapUsedKiB: 1_000,
      memoryPsiAvg10: 0.2,
      swapInPages: 4,
      platform: 'linux',
    },
  );
});

test('queue policy native launcher delegates dependency refresh waiting to the remote lock owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-busy-dependencies-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const dependencyBusyMarker = join(root, 'dependency-busy');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeFile(dependencyBusyMarker, '1\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node'",
    "dependency_corepack_subcommands=''",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "local-node:%s\\n" "$*"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "local-tsc:%s\\n" "$*"\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 20 0 36000000 72000000 0 0 0 0 0 0 0 linux\\n" ;;',
    `  *dependency-install.lock*) [ -f "${dependencyBusyMarker}" ] && exit 75; exit 0 ;;`,
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "remote-node:%s\\n" "$*" ;;',
    '  *) printf "unexpected-remote:%s\\n" "$*"; exit 44 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'tsc', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.doesNotMatch(result.stderr, /running locally/i);
  assert.match(result.stdout, /remote-node:/);
  assert.doesNotMatch(result.stdout, /unexpected-remote/);

});

for (const [entry, signal] of [['native', 'SIGTERM'], ['native', 'SIGHUP'], ['native', 'SIGKILL'], ['JavaScript entry', 'SIGHUP'], ['JavaScript entry', 'SIGKILL']]) {
test(`${entry} launcher ${signal} cancellation terminates a remote descendant that ignores SIGTERM`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-cancel-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stacks', 'repo-test');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const startedMarker = join(root, 'remote-started');
  const childPidPath = join(root, 'remote-child.pid');
  const runtimeDir = join(root, 'runtime');
  let remoteChildPid = null;
  t.after(async () => {
    if (remoteChildPid) {
      try { process.kill(remoteChildPid, 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 1, targets: [{
    name: 'linux', platform: 'posix', ssh: 'linux-host', repoDir: repoRoot,
    cliHomeDir: machineHome, remotePath: [binDir, '/usr/bin', '/bin'],
  }] }), 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'remote-ignore-term'), [
    '#!/bin/sh',
    "trap '' TERM",
    'printf "%s\\n" "$$" > "$REMOTE_CHILD_PID_PATH"',
    ': > "$REMOTE_STARTED_MARKER"',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.1 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const child = entry === 'native'
    ? spawn('/bin/sh', [launcher, '--', 'remote-ignore-term'], spawnOptions())
    : spawn(process.execPath, [join(repoRoot, 'apps/stack/scripts/dev_targets.mjs'), 'exec', 'auto', '--stack=repo-test', '--', 'remote-ignore-term'], spawnOptions());
  function spawnOptions() { return {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      HAPPIER_STACK_HOME_DIR: join(root, 'home'),
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      PATH: `${binDir}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      REMOTE_CHILD_PID_PATH: childPidPath,
      REMOTE_STARTED_MARKER: startedMarker,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }; }
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(startedMarker);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(startedMarker).catch((error) => assert.fail(`remote fixture did not start: ${stderr}\n${error}`));
    remoteChildPid = Number((await readFile(childPidPath, 'utf8')).trim());
    assert.ok(Number.isInteger(remoteChildPid) && remoteChildPid > 0);

    child.kill(signal);
    const exitCode = child.exitCode ?? await new Promise((resolveExit) => child.once('exit', resolveExit));
    assert.equal(exitCode, signal === 'SIGKILL' ? null : signal === 'SIGHUP' ? 129 : 130, stderr);
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        process.kill(remoteChildPid, 0);
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(remoteChildPid)], { encoding: 'utf8' });
        if (state.status === 0 && state.stdout.trim().startsWith('Z')) {
          remoteChildPid = null;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      } catch (error) {
        if (error?.code === 'ESRCH') {
          remoteChildPid = null;
          break;
        }
        throw error;
      }
    }
    assert.equal(remoteChildPid, null, 'remote descendant survived launcher cancellation');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
  }
});
}

test('native launcher cancels only its remote execution after an authoritative SSH connection is lost', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-ssh-loss-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const startedMarker = join(root, 'remote-started');
  const childPidPath = join(root, 'remote-child.pid');
  const cancelArgsPath = join(root, 'cancel-ssh-args');
  const runtimeDir = join(root, 'runtime');
  const neighbor = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  let remoteChildPid = null;
  t.after(async () => {
    if (remoteChildPid) {
      try { process.kill(remoteChildPid, 'SIGKILL'); } catch {}
    }
    if (neighbor.exitCode == null) neighbor.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'remote-ignore-term'), [
    '#!/bin/sh',
    "trap '' TERM",
    'printf "%s\\n" "$$" > "$REMOTE_CHILD_PID_PATH"',
    ': > "$REMOTE_STARTED_MARKER"',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    '  remote_command=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.1 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *remote-ignore-term*)',
    '    exec 3<&0',
    '    /bin/sh -c "$remote_command" >/dev/null 2>&1 <&3 &',
    '    attempt=0',
    '    while [ ! -f "$REMOTE_STARTED_MARKER" ] && [ "$attempt" -lt 250 ]; do sleep 0.02; attempt=$((attempt + 1)); done',
    '    [ -f "$REMOTE_STARTED_MARKER" ] || exit 97',
    '    exit 255',
    '    ;;',
    '  *) printf "%s\\n" "$*" > "$REMOTE_CANCEL_ARGS_PATH"; /bin/sh -c "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'remote-ignore-term'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      REMOTE_CHILD_PID_PATH: childPidPath,
      REMOTE_STARTED_MARKER: startedMarker,
      REMOTE_CANCEL_ARGS_PATH: cancelArgsPath,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 255, result.stderr);
  remoteChildPid = Number((await readFile(childPidPath, 'utf8')).trim());
  assert.ok(Number.isInteger(remoteChildPid) && remoteChildPid > 0);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(remoteChildPid, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    } catch (error) {
      if (error?.code === 'ESRCH') {
        remoteChildPid = null;
        break;
      }
      throw error;
    }
  }
  assert.equal(remoteChildPid, null, 'remote descendant survived the SSH failure');
  assert.doesNotThrow(() => process.kill(neighbor.pid, 0), 'an unrelated process was terminated');
  const cancelArgs = await readFile(cancelArgsPath, 'utf8');
  assert.match(cancelArgs, /ControlPath=none/);
  assert.match(cancelArgs, /ServerAliveInterval=15/);
  assert.match(cancelArgs, /ServerAliveCountMax=3/);
});

test('native launcher executes locally when configured command targets are not POSIX', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-native-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "target_count='0'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "local:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local:ok\n');
});

test('native launcher exact target blocks dispatch when a clean cached probe is followed by a problem-bearing post-flush inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-postflush-problem-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'openssh'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) exit 0 ;;`,
    '  list) printf "%s|Watching|false|true|1|0/0|1/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /sync flush failed|synchronization.*unhealthy|transition/i);
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });
});

test('startup and explicit sync share the command dispatch barrier and preserve newer source bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-causal-flush-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const runtime = nativeFixtureRuntime(stackDir);
  const syncControlDir = `/tmp/happier-sync-control-${process.getuid()}${dirname(runtime.dataDir)}/hstack-control`;
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const sourceBytes = join(root, 'source-bytes');
  const mirrorBytes = join(root, 'mirror-bytes');
  const firstFlushStarted = join(root, 'first-flush-started');
  const releaseFirstFlush = join(root, 'release-first-flush');
  const flushLog = join(root, 'flush-log');
  const startupLock = join(syncControlDir, 'happier-linux.lock');
  const queuedLog = join(root, 'queued');
  const releaseLock = join(root, 'release-lock');
  const children = [];
  const outputs = [];
  t.after(async () => {
    await Promise.all([writeFile(releaseLock, ''), writeFile(releaseFirstFlush, '')]);
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    }
    await rm(root, { recursive: true, force: true });
    await rm(`/tmp/happier-sync-control-${process.getuid()}${root}`, { recursive: true, force: true });
  });

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(syncControlDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeFile(sourceBytes, 'X\n');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='happier-linux'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) cp "${sourceBytes}" "${mirrorBytes}"; tr -d '\\n' < "${mirrorBytes}" >> "${flushLog}"; printf '\\n' >> "${flushLog}"; if grep -qx X "${mirrorBytes}" && [ ! -e "${releaseFirstFlush}" ]; then : > "${firstFlushStarted}"; while [ ! -e "${releaseFirstFlush}" ]; do sleep 0.02; done; fi ;;`,
    '  list) if [ "$5" = "{{json .}}" ]; then printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":2,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'; else printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; fi ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 4 1 10000000 1 0 28000000 28000000 0 0 0 0 0 0 0 linux\\n28000000 0 28000000 0\\n-\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) printf 'mirror:'; cat "${mirrorBytes}" ;;`,
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    DBUS_SESSION_BUS_ADDRESS: '',
  };
  // Observe the external flock boundary; all domain and admission logic is real.
  await executable(join(binDir, 'flock'), `#!/bin/sh\ncase "$*" in *--locked-sync-flush*) printf 'queued\\n' >> ${JSON.stringify(queuedLog)} ;; esac\nexec /usr/bin/flock "$@"\n`);
  const launch = (label) => {
    const child = spawn(
      '/bin/sh',
      [launcher, '--target=linux', '--', 'probe-command', label],
      { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    return child;
  };
  const collect = (child) => new Promise((resolveResult) => {
    const output = { stdout: '', stderr: '' };
    outputs.push(output);
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    child.once('exit', (code, signal) => resolveResult({ code, signal, ...output }));
  });
  const waitForFile = async (path) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await access(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${path}: ${JSON.stringify(outputs)}`);
  };

  const first = launch('first');
  const firstResult = collect(first);
  await waitForFile(firstFlushStarted);
  await writeFile(sourceBytes, 'Y\n');
  const second = launch('second');
  const secondResult = collect(second);
  await writeFile(releaseFirstFlush, 'release\n');

  const [firstCompleted, secondCompleted] = await Promise.all([firstResult, secondResult]);
  assert.equal(firstCompleted.code, 0, firstCompleted.stderr);
  assert.equal(secondCompleted.code, 0, secondCompleted.stderr);
  assert.equal(secondCompleted.stdout, 'mirror:Y\n');
  assert.deepEqual((await readFile(flushLog, 'utf8')).trim().split('\n'), ['X', 'Y']);

  const held = spawn('/usr/bin/flock', [startupLock, 'sh', '-c', `: > ${JSON.stringify(root)}/lock-held; while [ ! -e ${JSON.stringify(releaseLock)} ]; do sleep 0.02; done`], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(held);
  const heldResult = collect(held);
  await waitForFile(join(root, 'lock-held'));
  await writeFile(sourceBytes, 'Z\n');
  await writeFile(queuedLog, '');
  const startup = flushDevTargetSync({ target: { name: 'linux' }, env: { ...env, MUTAGEN_DATA_DIRECTORY: runtime.dataDir } });
  const explicit = syncDevTarget({ target: { name: 'linux' }, stackBaseDir: stackDir, env });
  const command = collect(launch('shared'));
  let prematureDispatch;
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      if ((await readFile(queuedLog, 'utf8')).trim().split('\n').filter(Boolean).length >= 3) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.equal((await readFile(queuedLog, 'utf8')).trim().split('\n').filter(Boolean).length, 3, 'all three callers reached lock admission before release');
    prematureDispatch = (await readFile(flushLog, 'utf8')).trim().split('\n');
  } finally {
    await writeFile(releaseLock, '');
  }
  const [, , completed] = await Promise.all([startup, explicit, command, heldResult]);
  assert.deepEqual(prematureDispatch, ['X', 'Y'], 'all paths must wait behind the same session barrier');
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, 'mirror:Z\n');
  assert.deepEqual((await readFile(flushLog, 'utf8')).trim().split('\n'), ['X', 'Y', 'Z'], 'all pre-start demands share one fresh flush');
});


test('native launcher flushes an automatically selected mirror and retries another target after a flush failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-moving-mirror-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  const flushMarker = join(root, 'mutagen-flush-ran');
  const freshMarker = `${remoteMarker}.fresh`;
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeFile(join(cacheDir, 'provenance.jsonl'), '');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeFile(join(cacheDir, 'mac2.cache'), `${cachedAt} 1 0.500000 4\n`);
  await writeFile(join(cacheDir, `mac2.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_sync_name='named-mac2-sync'",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = "list" ]; then',
    '  if [ "$3" = --template ]; then printf "[]\\n"; exit 0; fi',
    '  printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"',
    '  exit 0',
    'fi',
    'if [ "$2" != flush ]; then exit 0; fi',
    `printf '%s\\n' "$3" >> "${flushMarker}"`,
    'case "$3" in named-linux-sync|happier-*-linux) exit 73 ;; esac',
    `: > "${freshMarker}"`,
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    // The joint probe observes tools and load on the same SSH request. Return
    // its real telemetry shape rather than relying on legacy keyless caches.
    'case "$*" in *getconf*) case "$*" in *linux-host*) sample_load=0 ;; *) sample_load=2 ;; esac; printf "4 %s 1 10000000 1 0 28000000 28000000 0 0 0 0 0 0 0 linux\\n28000000 0 28000000 0\\n-\\n" "$sample_load"; exit 0 ;; esac',
    'case "$*" in *"&& command -v "*) exit 0 ;; esac',
    `if [ ! -e "${freshMarker}" ]; then printf '%s\\n' 'remote dispatch attempted before sync flush' >&2; exit 74; fi`,
    'case "$*" in',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected linux /);
  assert.match(result.stderr, /selected mac2 /);
  assert.match(result.stdout, /remote:.*probe-command.*ok/);
  assert.deepEqual((await readFile(flushMarker, 'utf8')).trim().split('\n'), [
    'named-linux-sync',
    'named-mac2-sync',
  ]);
  await readFile(remoteMarker);
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });

  await t.test('AUTO retains prerequisite exclusions after another host fails synchronization', async () => {
    const originalSsh = await readFile(join(binDir, 'ssh'), 'utf8');
    const originalMutagen = await readFile(join(binDir, 'mutagen'), 'utf8');
    const prerequisiteFailed = join(root, 'prerequisite-failed');
    const probes = join(root, 'prerequisite-probes');
    try {
      // The OS transport fails mac2's prerequisite once. A later selected-host
      // sync failure expires shared observations without changing this request.
      await executable(join(binDir, 'ssh'), originalSsh.replace('#!/bin/sh', [
        '#!/bin/sh',
        `case "$*" in *mac2-host*getconf*) printf 'probe\\n' >> '${probes}'; if [ ! -e '${prerequisiteFailed}' ]; then : > '${prerequisiteFailed}'; exit 73; fi ;; esac`,
      ].join('\n')));
      await executable(join(binDir, 'mutagen'), originalMutagen.replace('#!/bin/sh', [
        '#!/bin/sh',
        `if [ "$2" = flush ] && [ "$3" = named-linux-sync ]; then rm -f -- '${join(cacheDir, 'mac2.cache')}'; fi`,
      ].join('\n')));
      for (const name of ['linux', 'mac2']) await rm(join(cacheDir, `${name}.cache`), { force: true });
      const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'request-exhausted'], {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...executionNeutralEnv, HOME: root, XDG_RUNTIME_DIR: root,
          HAPPIER_STACK_STORAGE_DIR: storageDir, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root },
      });
      assert.notEqual(result.status, 0, 'a failed prerequisite must stay excluded for the entire request');
      assert.match(result.stderr, /HSTACK_EXEC_DISPATCH_REFUSED/);
      assert.match(result.stderr, /mac2=prerequisite/);
      assert.doesNotMatch(result.stdout, /remote:/, 'no payload may start after the pool is exhausted');
      assert.equal((await readFile(probes, 'utf8')).trim().split('\n').length, 1,
        'cache expiry must not re-probe a prerequisite already refused for this request');
    } finally {
      await executable(join(binDir, 'ssh'), originalSsh);
      await executable(join(binDir, 'mutagen'), originalMutagen);
      for (const name of ['linux', 'mac2']) await rm(join(cacheDir, `${name}.cache`), { force: true });
    }
  });

  await t.test('AUTO returns a typed prerequisite failure when local fallback is configured', async () => {
    const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
    const originalProjection = await readFile(projectionPath, 'utf8');
    const originalSsh = await readFile(join(binDir, 'ssh'), 'utf8');
    try {
      await writeFile(projectionPath, originalProjection.replace("fallback_mode='error'", "fallback_mode='local'"));
      await executable(join(binDir, 'ssh'), originalSsh.replace('#!/bin/sh\n',
        '#!/bin/sh\ncase "$*" in *getconf*) exit 73 ;; esac\n'));
      for (const name of ['linux', 'mac2']) await rm(join(cacheDir, `${name}.cache`), { force: true });
      const exhausted = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'prerequisite-exhausted'], {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...executionNeutralEnv, HOME: root, XDG_RUNTIME_DIR: root,
          HAPPIER_STACK_STORAGE_DIR: storageDir, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root },
      });
      assert.notEqual(exhausted.status, 0);
      assert.match(exhausted.stderr, /HSTACK_EXEC_DISPATCH_REFUSED/);
      assert.doesNotMatch(exhausted.stdout, /remote:|local:/);
    } finally {
      await writeFile(projectionPath, originalProjection);
      await executable(join(binDir, 'ssh'), originalSsh);
      for (const name of ['linux', 'mac2']) await rm(join(cacheDir, `${name}.cache`), { force: true });
    }
  });

  // The same public retry must retain an authoritative sibling source, not
  // restart against the executor checkout after the first target fails.
  const sibling = await mkdtemp(join(dirname(repoRoot), 'hstack-sibling-retry-'));
  t.after(() => rm(sibling, { recursive: true, force: true }));
  await writeFile(join(sibling, 'package.json'), '{}');
  await writeFile(join(sibling, 'pnpm-lock.yaml'), '');
  await writeFile(join(sibling, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const configPath = join(stackDir, 'dev-targets.json');
  await writeFile(configPath, JSON.stringify({ version: 3,
    targets: ['linux', 'mac2'].map(name => ({ name, platform: 'posix', ssh: `${name}-host`, repoDir: '/remote/repo', cliHomeDir: '/remote/home' })),
    commandExecution: { mode: 'auto', targets: ['linux', 'mac2'], fallback: 'error' },
  }));
  const env = { ...executionNeutralEnv, HOME: root, XDG_RUNTIME_DIR: root, HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_EXEC_CONFIG_PATH: configPath, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root };
  const siblingConfig = join(stackDir, `commands-${sibling.split('/').at(-1)}`, 'dev-targets.json');
  await mkdir(dirname(siblingConfig), { recursive: true });
  await writeFile(siblingConfig, JSON.stringify({ commandExecution: { mode: 'auto', targets: ['linux', 'mac2'], fallback: 'error' } }));
  const prepared = await prepareCommandRepository({ configPath, repoRoot: sibling, executorRepoRoot: repoRoot, synchronize: false, env });
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: dirname(prepared.path), sourceDir: sibling, env });
  await mkdir(dirname(runtime.projectFile), { recursive: true });
  await writeFile(runtime.projectFile, renderMutagenProject({ sourceDir: sibling, targets: prepared.config.targets, config: prepared.config, ownerId: 'dev-target-sync-service' }));
  await writeFile(runtime.syncServiceStateFile, JSON.stringify({ version: 1, state: 'ready', targets: {
    linux: { state: 'ready' }, mac2: { state: 'ready' },
  } }));
  const siblingCache = join(dirname(prepared.path), 'dev-target-command-load-native');
  await mkdir(siblingCache);
  for (const [name, score] of [['linux', 0], ['mac2', 0.5]]) {
    await writeFile(join(siblingCache, `${name}.cache`), `${Math.floor(Date.now() / 1000)} 1 ${score} 4\n`);
    await writeFile(join(siblingCache, `${name}.command.2560848116.cache`), `${Math.floor(Date.now() / 1000)} 1\n`);
  }
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await rm(flushMarker);
  const siblingResult = spawnSync('/bin/sh', [launcher, `--repo=${sibling}`, '--', 'probe-command', 'sibling'], {
    cwd: sibling, env, encoding: 'utf8',
  });
  assert.equal(siblingResult.status, 0, siblingResult.stderr);
  assert.match(siblingResult.stdout, /remote:.*probe-command.*sibling/);
  assert.deepEqual((await readFile(flushMarker, 'utf8')).trim().split('\n'),
    ['linux', 'mac2'].map(name => resolveMutagenSessionName(name, sibling)));
  // An absolute --repo names the command checkout; the caller's cwd elsewhere
  // (normally the executor checkout) runs the command from that checkout's root.
  const fromExecutor = spawnSync('/bin/sh', [launcher, `--repo=${sibling}`, '--', 'probe-command', 'from-executor'], {
    cwd: repoRoot, env, encoding: 'utf8',
  });
  assert.equal(fromExecutor.status, 0, fromExecutor.stderr);
  assert.match(fromExecutor.stdout, /remote:.*probe-command.*from-executor/);
});

test('native launcher exact target flushes the selected Mutagen session before remote dispatch and fails closed after a flush failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-sync-flush-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  const flushMarker = join(root, 'mutagen-flushes');
  const flushWaitStarted = join(root, 'mutagen-flush-started');
  const flushWaitRelease = join(root, 'mutagen-flush-release');
  const flushWaitFinished = join(root, 'mutagen-flush-finished');
  const flushWaitTerminated = join(root, 'mutagen-flush-terminated');
  const { dataDir: mutagenDataDir, opensshDir: mutagenSshPath } = nativeFixtureRuntime(stackDir);
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(mutagenDataDir, { recursive: true });
  await mkdir(mutagenSshPath, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  // Cached load keeps placement separate from prerequisite inspection. Only
  // payload execution requires the source flush, not the SSH tool preflight.
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) : > "${remoteMarker}.fresh"; printf '%s|%s|%s\\n' "$MUTAGEN_DATA_DIRECTORY" "$MUTAGEN_SSH_PATH" "$3" >> "${flushMarker}"; if [ "\${FLUSH_WAIT-}" = 1 ]; then trap ': > "$FLUSH_WAIT_TERMINATED"; exit 0' TERM; : > "$FLUSH_WAIT_STARTED"; while [ ! -e "$FLUSH_WAIT_RELEASE" ]; do sleep 0.02; done; : > "$FLUSH_WAIT_FINISHED"; fi; [ "\${FLUSH_FAIL-}" != 1 ] || exit 73 ;;`,
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    // Tool/load observation precedes source consumption; only the payload
    // needs the selected flush. The joint SSH probe must return telemetry.
    'case "$*" in *getconf*) printf "4 1 0.5 10000000 1 0 28000000 28000000 0 0 0 0 0 0 0 linux\\n28000000 0 28000000 0\\n-\\n"; exit 0 ;; esac',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in *"&& command -v "*) exit 0 ;; esac',
    `if [ ! -e "${remoteMarker}.fresh" ]; then printf '%s\\n' 'remote dispatch attempted before sync flush' >&2; exit 74; fi`,
    'case "$*" in',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const successful = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(successful.status, 0, successful.stderr);
  assert.match(successful.stdout, /remote:.*probe-command.*ok/);
  assert.equal(
    await readFile(flushMarker, 'utf8'),
    `${mutagenDataDir}|${mutagenSshPath}|named-linux-sync\n`,
  );
  await readFile(remoteMarker);

  await rm(remoteMarker, { force: true });
  const exactFailure = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'exact'], {
    cwd: repoRoot,
    env: { ...env, FLUSH_FAIL: '1' },
    encoding: 'utf8',
  });
  assert.equal(exactFailure.status, 1, exactFailure.stderr);
  assert.match(exactFailure.stderr, /sync flush failed.*linux/);
  assert.equal(exactFailure.stdout, '');
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
  assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.startsWith('linux.active.')), []);

  const waitForState = async (observe, label) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        if (await observe()) return;
      } catch {
        // Fixture producers may not have published their state yet.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForFile = (path, label) => waitForState(async () => {
    await readFile(path);
    return true;
  }, label);
  const waitForFlushExit = async () => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(flushWaitTerminated);
        return;
      } catch {
        try {
          await readFile(flushWaitFinished);
          return;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
    }
    throw new Error('timed out waiting for the fake sync flush to exit');
  };
  const flushing = spawn('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'cancelled-flush'], {
    cwd: repoRoot,
    env: {
      ...env,
      FLUSH_WAIT: '1',
      FLUSH_WAIT_STARTED: flushWaitStarted,
      FLUSH_WAIT_RELEASE: flushWaitRelease,
      FLUSH_WAIT_FINISHED: flushWaitFinished,
      FLUSH_WAIT_TERMINATED: flushWaitTerminated,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForFile(flushWaitStarted, 'the selected sync flush');
    flushing.kill('SIGTERM');
    const exit = await new Promise((resolveExit) => flushing.once('exit', (code, signal) => resolveExit({ code, signal })));
    assert.deepEqual(exit, { code: 130, signal: null });
    await waitForFile(flushWaitTerminated, 'the interrupted sync flush to terminate');
    // The coalesced client closes its socket before the native owner finishes
    // cancelling the flush and releasing its dispatch reservation.
    await waitForState(async () => !(await readdir(cacheDir)).some(entry => entry.startsWith('linux.active.')),
      'the native owner to release the cancelled flush reservation');
    await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
    assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.startsWith('linux.active.')), []);
  } finally {
    await writeFile(flushWaitRelease, '', 'utf8');
    await waitForFlushExit();
    if (flushing.exitCode == null && flushing.signalCode == null) flushing.kill('SIGTERM');
  }
});

test('native admission uses the measured memory envelope without arbitrary pressure denials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-cpu-saturation-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${FIXTURE_PLATFORM:-Linux}"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\ncase "$*" in *hw.ncpu*) printf "4\\n" ;; *) printf "{ 99 99 99 }\\n" ;; esac\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'flock'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "%s\\n" "${FIXTURE_RUN_QUEUE:-0}" ;;',
    '  */proc/meminfo*) printf "9437184 %s\\n" "${FIXTURE_TOTAL_MEMORY:-28311552}" ;;',
    '  */proc/pressure/cpu*) printf "%s\\n" "${FIXTURE_CPU_PSI:-0}" ;;',
    '  */proc/pressure/memory*) printf "%s\\n" "${FIXTURE_MEMORY_PSI:-0}" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  for (const [telemetry, expectedBudget] of [
    [{ FIXTURE_RUN_QUEUE: '12', FIXTURE_CPU_PSI: '75' }, '1'],
    [{ FIXTURE_MEMORY_PSI: '11' }, '3'],
    [{ FIXTURE_TOTAL_MEMORY: '125829120' }, '4'],
    [{ GOMAXPROCS: '2' }, '2'],
    [{ FIXTURE_PLATFORM: 'Darwin' }, 'unset'],
  ]) {
    const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=dedicated-worker', '--no-wait', '--', '/bin/sh', '-c', 'printf "admitted:%s" "${GOMAXPROCS-unset}"'], {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...executionNeutralEnv, HOME: root, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root, ...telemetry },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `admitted:${expectedBudget}`);
  }
});

const exportEnvelopeCandidateSources = {
  ...(process.env.HAPPIER_TEST_EXPORT_ENVELOPE_LAUNCHER ? { launcherSourcePath: resolve(repoRoot, process.env.HAPPIER_TEST_EXPORT_ENVELOPE_LAUNCHER) } : {}),
  ...(process.env.HAPPIER_TEST_EXPORT_ENVELOPE_POLICY ? { commandPolicySourcePath: resolve(repoRoot, process.env.HAPPIER_TEST_EXPORT_ENVELOPE_POLICY) } : {}),
};

test('source web export admission fits measured memory to its admitted thread count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-export-envelope-'));
  const native = await installNativeAdmissionFixture({ root, ...exportEnvelopeCandidateSources });
  const { launcher } = native;
  const { resolveHeavyweightMemoryFloorKiB } = await import(exportEnvelopeCandidateSources.commandPolicySourcePath
    ?? new URL('./utils/dev_targets/remote_commands.mjs', import.meta.url));
  const binDir = join(root, 'bin');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/meminfo*) printf "%s %s\\n" "$FIXTURE_MEMORY_KIB" "$FIXTURE_MEMORY_KIB" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac', '',
  ].join('\n'));
  const payload = 'printf "%s,%s" "$GOMAXPROCS" "$HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB"';
  for (const [memoryGiB, cpuBudget, override, expectedThreads, expectedGiB, custody, expectedStatus = 0] of [
    // Owner Q1: measured peaks rounded up without the former blanket margin.
    [26, 47, '', 8, 13, false],
    [125, 47, '', 8, 13, false],
    [26, 8, '', 8, 13, false],
    [26, 47, '8', 8, 13, false],
    [125, 47, '47', 47, 32, false],
    [26.7, 47, '', 8, 13, true],
    [13, 47, '', 8, 13, false],
    [10, 47, '', 4, 10, false],
    [10, 1, '', 1, 8, false],
    [8, 47, '', 1, 8, false],
    [7, 47, '', null, 8, false, 75],
    [125, 2, '0', null, 32, false],
  ]) {
    await native.setMemoryObservation({ availableMemoryKiB: Math.floor(memoryGiB * 1024 * 1024),
      totalMemoryKiB: Math.floor(memoryGiB * 1024 * 1024) });
    const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=source-web-export',
      '--machine=dedicated-worker', '--no-wait', ...(custody ? ['--workspace-locks=[]'] : []), '--', '/bin/sh', '-c', payload, 'probe',
      join(root, 'native-owner/apps/stack/scripts/utils/dev_targets/native_command_policy.sh')], {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...executionNeutralEnv, HOME: root, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root,
        GOMAXPROCS: String(cpuBudget), FIXTURE_MEMORY_KIB: String(Math.floor(memoryGiB * 1024 * 1024)),
        HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: override },
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus !== 0) {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /capacity|CAPACITY/);
      continue;
    }
    const expectedCpuBudget = override ? cpuBudget : expectedThreads;
    assert.equal(result.stdout, `${expectedCpuBudget},${expectedGiB * 1024 * 1024}`);
    assert.equal(resolveHeavyweightMemoryFloorKiB('source-web-export', { workers: expectedThreads ?? undefined }),
      expectedGiB * 1024 * 1024);
  }
});

test('source web export peers account their admitted thread envelopes once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-export-envelope-peers-'));
  const native = await installNativeAdmissionFixture({ root, ...exportEnvelopeCandidateSources });
  const { launcher } = native;
  const binDir = join(root, 'bin');
  const release = join(root, 'release');
  const { resolveHeavyweightMemoryFloorKiB } = await import(exportEnvelopeCandidateSources.commandPolicySourcePath
    ?? new URL('./utils/dev_targets/remote_commands.mjs', import.meta.url));
  const peerReservationKiB = 2 * resolveHeavyweightMemoryFloorKiB('source-web-export', { workers: 8 });
  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'awk'), `#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "${peerReservationKiB} ${peerReservationKiB}\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n`);
  const env = { ...executionNeutralEnv, HOME: root, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root,
    GOMAXPROCS: '8', HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '' };
  const jobs = [];
  t.after(async () => {
    await writeFile(release, '');
    await Promise.all(jobs.map(child => child.exitCode === null ? new Promise(resolveExit => child.once('close', resolveExit)) : null));
    await rm(root, { recursive: true, force: true });
  });
  for (const index of [0, 1]) {
    const marker = join(root, `started-${index}`);
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=source-web-export',
      '--machine=dedicated-worker', '--no-wait', '--', '/bin/sh', '-c',
      'printf "%s" "$GOMAXPROCS" > "$1"; while [ ! -e "$2" ]; do sleep 0.02; done', 'hold', marker, release],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    jobs.push(child);
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    let observed;
    for (let attempt = 0; attempt < 250 && observed === undefined; attempt++) {
      observed = await readFile(marker, 'utf8').catch(() => undefined);
      if (observed === undefined) await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.equal(observed, '8', stderr);
  }
  assert.equal((await native.brokerStatus()).activeCount, 2);
  assert.equal((await native.brokerStatus()).reservedMemoryKiB, peerReservationKiB);
  const third = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation',
    '--machine=dedicated-worker', '--no-wait', '--', '/bin/sh', '-c', 'exit 99'],
  { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(third.status, 75, third.stderr);
  assert.equal((await native.brokerStatus()).reservedMemoryKiB, peerReservationKiB);
});

test('native launcher does not derive a fixed heavyweight job count from the worker profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-profile-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const firstMarker = join(root, 'first-admitted');
  const secondMarker = join(root, 'second-admitted');
  const thirdMarker = join(root, 'third-admitted');
  const releaseMarker = join(root, 'release');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) case "$1" in *split*) printf "0\\n" ;; *) printf "0.1\\n" ;; esac ;;',
    // A VM configured with 24 GiB exposes less than 24 GiB as MemTotal after kernel overhead.
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "23068672 24557560\\n" ;; *) printf "24557560\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "1.4\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'hold'), [
    '#!/bin/sh',
    ': > "$1"',
    'while [ ! -e "$2" ]; do sleep 0.02; done',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const waitForFile = async (path, label, diagnostic = () => '') => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}${diagnostic()}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  const run = (marker) => spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=worker-profile',
    '--',
    'hold',
    marker,
    releaseMarker,
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const first = run(firstMarker);
  let second;
  let third;
  const outputFor = (child) => {
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    return output;
  };
  const firstOutput = outputFor(first);
  let thirdStderr = '';
  try {
    await waitForFile(firstMarker, 'the first worker-profile admission', () =>
      ` (first exit=${first.exitCode}; stderr=${firstOutput.stderr})`,
    );
    second = run(secondMarker);
    await waitForFile(secondMarker, 'the second worker-profile admission');
    third = run(thirdMarker);
    third.stderr.on('data', (chunk) => { thirdStderr += chunk; });
    await waitForFile(thirdMarker, 'the third worker-profile admission');
    assert.doesNotMatch(thirdStderr, /active=2\/2/);
    await writeFile(releaseMarker, '', 'utf8');
    assert.equal(await waitForExit(first), 0);
    assert.equal(await waitForExit(second), 0);
    assert.equal(await waitForExit(third), 0);
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
    for (const child of [first, second, third]) {
      if (child && child.exitCode == null) child.kill('SIGTERM');
    }
  }
});

test('native launcher scopes admitted Linux work only when the systemd user slice is ready', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-scope-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const repoRoot = resolve(launcher, '../../../..');
  const readyBin = join(root, 'ready-bin');
  const fallbackBin = join(root, 'fallback-bin');
  const scopedMarker = join(root, 'scoped-command');
  const fallbackMarker = join(root, 'fallback-command');
  const scopedArguments = join(root, 'systemd-run-arguments');
  const scopeInvocations = join(root, 'scope-invocations');
  const scopeUnits = join(root, 'scope-units');
  const fallbackScopeAttempt = join(root, 'unexpected-systemd-run');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  for (const binDir of [readyBin, fallbackBin]) {
    await mkdir(binDir, { recursive: true });
    await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
    await executable(join(binDir, 'awk'), [
      '#!/bin/sh',
      'case "$*" in',
      '  */proc/loadavg*) case "$1" in *split*) printf "0\\n" ;; *) printf "0.1\\n" ;; esac ;;',
      '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
      '  */proc/pressure/memory*) printf "1.4\\n" ;;',
      '  *) exec /usr/bin/awk "$@" ;;',
      'esac',
      '',
    ].join('\n'));
    await executable(join(binDir, 'scoped-command'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$SCOPED_MARKER"\nprintf "%s\\n" "$TEST_EFFECTIVE_NICE" > "$SCOPED_MARKER.nice"\n');
    await executable(join(binDir, 'rg'), '#!/bin/sh\nprintf "%s\\n" "$TEST_EFFECTIVE_NICE" > "$SCOPED_MARKER.nice"\n');
    await executable(join(binDir, 'sed'), [
      '#!/bin/sh',
      'case "$*" in *"/proc/self/cgroup") printf "%s\\n" "${TEST_CURRENT_CGROUP-/user.slice/unscoped}" ;; *) exec /usr/bin/sed "$@" ;; esac',
      '',
    ].join('\n'));
    // Scheduling tools and procfs are genuine OS boundaries. Observe the
    // priority received by the payload, independent of the test runner's nice.
    await executable(join(binDir, 'ps'), '#!/bin/sh\ncase "$*" in "-o ni= -p "*) printf "%s\\n" "$TEST_EFFECTIVE_NICE" ;; *) exec /usr/bin/ps "$@" ;; esac\n');
    await executable(join(binDir, 'nice'), '#!/bin/sh\nshift; adjustment=$1; shift; TEST_EFFECTIVE_NICE=$((TEST_EFFECTIVE_NICE + adjustment)); [ "$TEST_EFFECTIVE_NICE" -le 19 ] || TEST_EFFECTIVE_NICE=19; export TEST_EFFECTIVE_NICE; exec "$@"\n');
  }
  await executable(join(readyBin, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *LoadState*) printf "loaded\\n"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(readyBin, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" > "$SYSTEMD_RUN_ARGUMENTS"',
    'unit=; slice=; literal_arguments=0',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --expand-environment=no) literal_arguments=1 ;; --unit=*) unit=${1#--unit=} ;; --slice=*) slice=${1#--slice=} ;; --nice=*) if [ "${1#--nice=}" -lt "${TEST_INHERITED_NICE:-0}" ]; then printf "Failed to set nice level: Permission denied\\n" >&2; exit 1; fi ;; esac',
    '  case "$1" in --nice=*) TEST_EFFECTIVE_NICE=${1#--nice=}; export TEST_EFFECTIVE_NICE ;; esac',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    // systemd 259 identifies a default scope by process identity and execs the
    // payload in that process. Procfs and systemd are genuine OS boundaries.
    'if [ -z "$unit" ]; then token=$(/usr/bin/awk \'{print $22}\' /proc/$$/stat); unit=run-p$$-i$token.scope; fi',
    'mkdir -p -- "$SCOPE_UNITS"',
    'if ! mkdir "$SCOPE_UNITS/$unit"; then printf "Failed to start transient scope unit: Unit %s was already loaded or has a fragment file.\\n" "$unit" >&2; exit 42; fi',
    'printf "%s|%s\\n" "$unit" "$slice" >> "$SCOPE_INVOCATIONS"',
    'export TEST_CURRENT_CGROUP=/user.slice/user-1000.slice/user@1000.service/happier.slice/$slice/$unit',
    systemdOperandExpansionProbe,
    'exec "$@"',
    '',
  ].join('\n'));
  // OS boundary: systemd cannot raise an unprivileged child's inherited priority.
  await executable(join(readyBin, 'ps'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "-o ni= -p "*) printf "%s\\n" "${TEST_EFFECTIVE_NICE:-0}" ;;',
    '  *) exec /usr/bin/ps "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(fallbackBin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(fallbackBin, 'systemd-run'), [
    '#!/bin/sh',
    'printf "unexpected\\n" > "$FALLBACK_SCOPE_ATTEMPT"',
    'exit 42',
    '',
  ].join('\n'));

  const run = (binDir, home, marker, { inheritedNice = 0, protectedLocal = false, local = false, command, literalProbe = false } = {}) => spawnSync('/bin/sh', [
    launcher,
    ...(protectedLocal || local ? ['--local'] : [
      '--heavyweight-admission',
      '--class=validation',
      '--machine=scope-profile',
    ]),
    '--',
    ...(command ?? ['scoped-command', marker === scopedMarker ? 'scoped' : 'fallback']),
  ], {
    cwd: join(root, 'native-owner'),
    env: {
      ...executionNeutralEnv,
      HOME: home,
      TEST_INHERITED_NICE: String(inheritedNice),
      TEST_EFFECTIVE_NICE: String(inheritedNice),
      ...(literalProbe ? { TEST_LITERAL_SCOPE_PROBE: '1', TEST_SCOPE_EXPANSIONS: join(root, 'scope-expansions'), GOMAXPROCS: '7' } : {}),
      ...(protectedLocal ? { HAPPIER_HSTACK_DISPATCH_CONTROL: '1' } : {}),
      SCOPED_MARKER: marker,
      SYSTEMD_RUN_ARGUMENTS: scopedArguments,
      SCOPE_UNITS: scopeUnits,
      SCOPE_INVOCATIONS: scopeInvocations,
      TEST_LAUNCHER: launcher,
      FALLBACK_SCOPE_ATTEMPT: fallbackScopeAttempt,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  const scoped = run(readyBin, join(root, 'ready-home'), scopedMarker);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
  assert.match(
    await readFile(scopedArguments, 'utf8'),
    /--user --scope --quiet --slice=happier-jobs\.slice --nice=10 -- scoped-command scoped/,
  );

  const fallback = run(fallbackBin, join(root, 'fallback-home'), fallbackMarker);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(await readFile(fallbackMarker, 'utf8'), 'fallback\n');
  await assert.rejects(readFile(fallbackScopeAttempt), { code: 'ENOENT' });
  assert.equal((await readFile(fallbackMarker + '.nice', 'utf8')).trim(), '10',
    'admitted work keeps the background priority when the user manager is unavailable');

  for (const binDir of [readyBin, fallbackBin]) {
    for (const inheritedNice of [0, 5, 19]) {
      const local = run(binDir, join(root, 'local-priority-home'), scopedMarker, {
        local: true, inheritedNice, command: ['rg', 'needle'],
      });
      assert.equal(local.status, 0, local.stderr);
      assert.equal((await readFile(scopedMarker + '.nice', 'utf8')).trim(), String(Math.max(10, inheritedNice)),
        'explicit local source work gets the same priority floor without a dispatch-control marker');
    }
  }

  const literal = run(readyBin, join(root, 'literal-home'), scopedMarker, {
    literalProbe: true,
    command: ['/bin/sh', '-c', 'if [ -z "${GOMAXPROCS+x}" ]; then export GOMAXPROCS=1; fi; printf "%s\\n" "$GOMAXPROCS" > "$SCOPED_MARKER"'],
  });
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(await readFile(join(root, 'scope-expansions'), 'utf8'), '0', 'scope transport must interpret zero shell operands');
  assert.equal(await readFile(scopedMarker, 'utf8'), '7\n', 'the worker override belongs to the shell, not systemd');

  for (const protectedLocal of [false, true]) {
    const inherited = run(readyBin, join(root, `inherited-home-${protectedLocal}`), scopedMarker, {
      inheritedNice: 19,
      protectedLocal,
    });
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
    assert.match(await readFile(scopedArguments, 'utf8'), /--nice=19 -- scoped-command scoped/);
  }

  for (const throughCriticalScope of [false, true]) {
    await writeFile(scopeInvocations, '');
    const nestedCommand = '"$TEST_LAUNCHER" --heavyweight-admission --class=validation --machine=scope-profile -- scoped-command scoped';
    const command = throughCriticalScope
      ? `systemd-run --user --scope --quiet --slice=happier-critical.slice -- ${nestedCommand}; result=$?; exit "$result"`
      : `exec ${nestedCommand}`;
    const nested = run(readyBin, join(root, `nested-home-${throughCriticalScope}`), scopedMarker, {
      command: ['/bin/sh', '-c', command],
    });
    assert.equal(nested.status, 0, `critical transition: ${throughCriticalScope}\n${nested.stderr}`);
    assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
    const scopes = (await readFile(scopeInvocations, 'utf8')).trim().split('\n');
    assert.equal(scopes.length, throughCriticalScope ? 3 : 1);
    assert.equal(scopes.at(-1).split('|')[1], 'happier-jobs.slice');
    assert.equal((await readFile(scopedMarker + '.nice', 'utf8')).trim(), '10',
      'nested admitted launches do not accumulate relative nice adjustments');
  }
});

test('Windows launcher is explicitly local-only and does not start the Node router', async () => {
  const cmd = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.cmd'), 'utf8');
  const powershell = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.ps1'), 'utf8');
  assert.doesNotMatch(cmd, /\bnode\b/i);
  assert.match(cmd, /powershell/i);
  assert.doesNotMatch(powershell, /HAPPIER_PREFERRED_EXECUTION/);
  assert.match(powershell, /\$invocation\[0\] -eq '--local'/);
});

test('native nonblocking admission certifies capacity refusal without certifying state failure', async (t) => {
  const fixture = await memoryRoutingFixture(t);
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  await executable(join(fixture.binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  const belowFloorKiB = resolveHeavyweightMemoryFloorKiB('validation') - 1;
  await executable(join(fixture.binDir, 'awk'), `#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "${belowFloorKiB} ${belowFloorKiB}\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n`);
  const result = spawnSync('/bin/sh', [native.launcher, '--heavyweight-admission', '--no-wait', '--class=validation', '--failure-id=busy-test', '--', '/usr/bin/printf', 'unexpected'], fixture.invocation);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^HSTACK_ADMISSION_CAPACITY:busy-test$/m);
  const sample = await native.brokerStatus();
  assert.equal(sample.totalMemoryKiB, belowFloorKiB);
  assert.equal(sample.availableMemoryKiB, belowFloorKiB);
  assert.doesNotMatch(result.stderr, /HSTACK_ADMISSION_UNAVAILABLE/);
});

test('remote Linux execution reaches one broker slot and preserves payload failure without replay', { skip: process.platform !== 'linux', timeout: 60_000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const worker = fixture.workers.starved;
  await worker.pressure.release();
  await waitForRuntime(async () => (await worker.brokerStatus()).activeCount === 0, () => 'fixture pressure slot was not released');
  const checkout = resolve(worker.launcher, '../../../..');
  const observations = join(checkout, 'admitted-observations.jsonl');
  await writeFile(join(checkout, 'focused.test.mjs'), `import { appendFileSync } from 'node:fs';
import { requestAdmissionSample } from ${JSON.stringify(pathToFileURL(worker.admissionClientPath).href)};
appendFileSync(${JSON.stringify(observations)}, JSON.stringify(await requestAdmissionSample(${JSON.stringify(worker.admissionRoot)})) + '\\n');
process.exitCode = 37;`);
  const before = await worker.brokerStatus();
  const result = spawnSync('/bin/sh', [launcher, '--target=starved', '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  const rows = (await readFile(observations, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 1, 'an authoritative payload failure is never replayed');
  assert.equal(rows[0].activeCount, 1);
  assert.equal(rows[0].sampleCount, before.sampleCount + 1, 'the remote payload has one admission');
  await waitForRuntime(async () => (await worker.brokerStatus()).activeCount === 0, () => result.stderr);
  assert.equal((await worker.brokerStatus()).sampleCount, before.sampleCount + 2, 'payload exit releases the same slot');
});


test('native launcher leaves a pressured local Linux host with no admitted owners its full worker allowance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-governor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  const repoRoot = join(root, 'native-owner');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  // Admission's real OS observer needs Node; reject only the retired JS
  // dispatch path rather than disabling observation and waiting forever.
  await executable(join(binDir, 'node'), `#!/bin/sh\ncase "$1" in */service_memory.mjs|*/worker_disk_budget.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;; *) exit 97 ;; esac\n`);
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "14\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/meminfo*) printf "16000000 24000000\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac', '',
  ].join('\n'));
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 100.0 100.0 100.0 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 50%%\\n"\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 120 0.5 22000000 10 120 16000000 24000000 0 0 90 90 0 0 0 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "wrong-remote\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s:%s\\n" "${HAPPIER_VITEST_GOVERNOR_MAX_WORKERS-}" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'corepack'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s:%s\\n" "${HAPPIER_VITEST_GOVERNOR_MAX_WORKERS-}" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  // SYSTEMIC-CHALLENGE §4 step 6: PSI/load does not consume an admitted share.
  assert.match(result.stdout, /workers:::::/);
  assert.match(result.stdout, /^args:run fixture\.test\.ts$/m);
  assert.doesNotMatch(result.stdout, /wrong-remote/);

  const explicit = spawnSync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', '--maxWorkers=6'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /workers:::::/);
  assert.match(explicit.stdout, /args:run --maxWorkers=6/);

  const packageScript = spawnSync(
    '/bin/sh',
    [launcher, '--local', '--', 'corepack', 'yarn', '-s', 'test:migration:bundled-plugin-projections'],
    {
      cwd: repoRoot,
      env: {
        ...executionNeutralEnv,
        HOME: root,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: root,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(packageScript.status, 0, packageScript.stderr);
  assert.match(packageScript.stdout, /workers:::::/);
  assert.match(packageScript.stdout, /^args:yarn -s test:migration:bundled-plugin-projections$/m);
});


test('Linux local and remote worker allowances share admitted owners and preserve explicit tool budgets', { skip: process.platform !== 'linux', timeout: 60_000 }, async t => {
  // Retain one admitted owner while leaving capacity for the payload's own slot.
  const fixture = await runtimeAdmissionTransportFixture(t, { availableKiB: 2 * resolveHeavyweightMemoryFloorKiB('validation') });
  const worker = fixture.workers.starved;
  await executable(join(fixture.binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(fixture.binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 999 999 999 }\\n"\n');
  await executable(join(fixture.binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(fixture.binDir, 'vitest'), '#!/bin/sh\nprintf "workers:%s go:%s\\n" "${HAPPIER_VITEST_GOVERNOR_MAX_WORKERS-unset}" "${GOMAXPROCS-unset}"\nprintf "args:%s\\n" "$*"\n');
  await executable(join(fixture.binDir, 'rg'), '#!/bin/sh\nprintf "args:%s\\n" "$*"\n');
  const local = (args, extra = {}) => spawnSync('/bin/sh', [worker.launcher, '--local', '--', ...args], {
    ...fixture.invocation,
    cwd: resolve(worker.launcher, '../../../..'),
    env: { ...fixture.invocation.env, RUNTIME_WORKER_SAMPLE: worker.sample, HAPPIER_DEV_TARGET_EXECUTION: '1', ...extra },
  });
  const remote = (args, extra = {}) => spawnSync('/bin/sh', [launcher, '--target=starved', '--', ...args], {
    ...fixture.invocation, env: { ...fixture.invocation.env, ...extra },
  });
  // The existing fixture owns one real admitted job on eight cores. A nested
  // adapter must not charge its containing admitted job a second time, and a
  // Go-only override must not replace Vitest's independently derived share.
  for (const invoke of [local, remote]) {
    const vitest = invoke(['vitest', 'run', 'fixture.test.ts'], { GOMAXPROCS: '7' });
    assert.equal(vitest.status, 0, vitest.stderr);
    assert.match(vitest.stdout, /workers:4 go:7/);
    const explicit = invoke(['vitest', 'run', '--maxWorkers=6']);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.stdout, /workers:unset/);
    assert.match(explicit.stdout, /args:run --maxWorkers=6/);
    const explicitEnv = invoke(['vitest', 'run'], { VITEST_MAX_THREADS: '3' });
    assert.equal(explicitEnv.status, 0, explicitEnv.stderr);
    assert.match(explicitEnv.stdout, /workers:unset/);
    // Cold, warm and explicit search all reach the same real worker adapter.
    for (const args of [['rg', 'needle', 'sources'], ['rg', 'needle', 'sources'], ['rg', '--threads=3', 'needle']]) {
      const search = invoke(args);
      assert.equal(search.status, 0, search.stderr);
      assert.match(search.stdout, args.includes('--threads=3') ? /args:--threads=3 needle/ : /args:--threads=4 needle sources/);
      if (args.includes('--threads=3')) assert.doesNotMatch(search.stdout, /--threads=4/);
    }
  }
});

test('AUTO ranks deeply queued demand behind idle capacity before preparation', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 80 });
  const queuedKiB = 85 * resolveHeavyweightMemoryFloorKiB('runtime-build');
  await writeFile(fixture.samplePath, `8 0.1 0.99 22000000 20 0 28000000 33554432 0 0 0 0 0 0 0 linux 28000000 0 16777216 ${queuedKiB}\n`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], fixture.invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n');
  }
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['roomy', 'roomy']);
});

async function isolatedRoutingController(fixture) {
  // Controller preparation must inspect its owned workspace, never publish
  // Protocol exports into the test runner's concurrently changing checkout.
  const controller = await installNativeAdmissionFixture({ root: join(fixture.root, 'controller'), prepareDependencies: true });
  const controllerRoot = resolve(controller.launcher, '../../../..');
  fixture.invocation.cwd = controllerRoot;
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'),
    renderNativeExecutionProjection(fixture.config, { repoRoot: controllerRoot }));
  return controller.launcher;
}

test('AUTO publication during preparation waits on its selected worker instead of preparing the pool', { skip: process.platform !== 'linux', timeout: 60_000 }, async t => {
  const publications = new Map();
  const releases = [];
  const connections = new Set();
  let server, child, exited;
  // Release publications and the dispatched child before fixture roots retire.
  t.after(async () => {
    for (const release of releases) release();
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await Promise.all(publications.values());
    for (const socket of connections) socket.destroy();
    if (server) await new Promise(done => server.close(done));
  });
  const fixture = await runtimeAdmissionTransportFixture(t);
  const controller = await isolatedRoutingController(fixture);
  fixture.invocation.env.HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS = '0';
  for (const [name, worker] of Object.entries(fixture.workers)) {
    await worker.pressure.release();
    await writeFile(worker.sample, `8 ${name === 'starved' ? '0.1' : '12'} 0.9 22000000 20 0 28311552 28311552 0 0 0 0 0 0 0 linux 28311552\n`);
  }
  const sockets = await createTempFixture(t, { parentDir: '/tmp', prefix: 'hp-' });
  const address = sockets.path('prepared.sock');
  server = createServer(socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    socket.once('data', data => {
      const name = data.toString();
      if (publications.has(name)) { socket.end(); return; }
      const checkout = resolve(fixture.workers[name].launcher, '../../../..');
      const publication = withDependencyRefresh({ installDir: checkout, force: true,
        componentDir: join(checkout, 'apps/stack'),
        env: { ...fixture.invocation.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' },
      }, async ({ env }) => {
        // The real publication owner retains mutation custody while the
        // external, dependency-free installer is held at its completion edge.
        const installed = spawnSync(join(checkout, '.fixture-pnpm/bin/pnpm'), ['install', '--frozen-lockfile'],
          { cwd: checkout, env, encoding: 'utf8' });
        assert.equal(installed.status, 0, installed.stderr);
        await new Promise(release => { releases.push(release); socket.end(); });
      });
      publications.set(name, publication);
    });
  });
  await new Promise(resolveListen => server.listen(address, resolveListen));
  for (const [name, worker] of Object.entries(fixture.workers)) {
    const checkout = resolve(worker.launcher, '../../../..');
    await writeFile(join(checkout, 'focused.test.mjs'),
      `import test from 'node:test'; test('selected payload', () => console.log('publication-payload:${name}'));\n`);
    // Interpose at the bootstrap process boundary before its real readiness
    // check. Dependency readiness belongs there, not to native admission.
    const bootstrap = join(checkout, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs');
    const original = await readFile(bootstrap, 'utf8');
    await writeFile(bootstrap, `import { createConnection } from 'node:net';
await new Promise((done, reject) => {
  const socket = createConnection(${JSON.stringify(address)});
  socket.once('connect', () => socket.write(${JSON.stringify(name)}));
  socket.once('error', reject); socket.once('end', done); socket.resume();
});
${original}
`);
  }
  child = spawn('/bin/sh', [controller, '--', 'node', '--test', 'focused.test.mjs'],
    { ...fixture.invocation, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  await waitForRuntime(() => stderr.includes('waiting for dependency refresh lock') || releases.length === 2, () => stderr);
  for (const release of releases) release();
  assert.equal(await exited, 0, stderr);
  await Promise.all(publications.values());
  const attempts = (await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n');
  t.diagnostic(JSON.stringify({ attempts, publications: publications.size,
    waits: (stderr.match(/waiting for dependency refresh lock/g) ?? []).length }));
  assert.deepEqual(attempts, ['starved'], 'one selected preparation joins its writer without preparing a peer');
  assert.equal(publications.size, 1);
  assert.match(stderr, /waiting for dependency refresh lock/);
  assert.equal((stdout.match(/publication-payload:starved/g) ?? []).length, 1);
  assert.doesNotMatch(stdout, /publication-payload:roomy/);
});
