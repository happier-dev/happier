import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCliBuilt, syncSharedDepsForSourceDev } from './utils/proc/pm.mjs';
import { writeCliDistBuildManifest } from './utils/cli/cliDistIntegrity.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..', '..', '..');
const sharedWorkspaceNames = ['protocol', 'agents', 'cli-common'];

test('source-dev shared dependency publication runs outside the Stack owner process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-source-dev-sync-boundary-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const scriptsDir = join(cliDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(
    join(scriptsDir, 'buildSharedDeps.mjs'),
    'export async function syncSharedDepsForSourceDev() { throw new Error("must not run in the Stack owner"); }\n',
  );
  await writeFile(join(scriptsDir, 'syncSharedDepsForDev.mjs'), '// canonical child entrypoint\n');

  let invocation = null;
  const result = await syncSharedDepsForSourceDev(root, {
    cliDir,
    env: { ...process.env },
    quiet: true,
    workspaceNames: ['protocol', '@happier-dev/agents'],
    includeRuntimeDependencies: false,
    spawnProcImpl: (label, command, args, env, options) => {
      invocation = { command, args, options };
      options.lineFilter({
        stream: 'stdout',
        line: '__HAPPIER_SOURCE_DEV_SYNC_RESULT__={"synced":true,"reason":"completed"}',
      });
      return { completion: Promise.resolve({ code: 0, signal: null }) };
    },
  });

  assert.deepEqual(result, { synced: true, reason: 'completed' });
  assert.equal(invocation?.command, process.execPath);
  assert.deepEqual(invocation?.args, [
    join(scriptsDir, 'syncSharedDepsForDev.mjs'),
    '--json',
    '--no-runtime-dependencies',
    'protocol',
    'agents',
  ]);
  assert.equal(invocation?.options.cwd, root);
});

test('source-dev shared dependency publication preserves bounded child failure evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-source-dev-sync-failure-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const scriptsDir = join(cliDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(
    join(scriptsDir, 'buildSharedDeps.mjs'),
    'export async function syncSharedDepsForSourceDev() {}\n',
  );
  await writeFile(join(scriptsDir, 'syncSharedDepsForDev.mjs'), '// canonical child entrypoint\n');

  await assert.rejects(
    () => syncSharedDepsForSourceDev(root, {
      cliDir,
      quiet: true,
      spawnProcImpl: (_label, _command, _args, _env, options) => {
        options.lineFilter({
          stream: 'stderr',
          line: '[cli-build-inputs] runtime inputs changed while this build was running; refusing to finalize a mixed CLI closure',
        });
        return { completion: Promise.resolve({ code: 1, signal: null }) };
      },
    }),
    (error) => (
      error?.code === 'EEXIT'
      && error?.exitCode === 1
      && error?.signal === null
      && error.message.includes('[stderr]')
      && error.message.includes('[cli-build-inputs] runtime inputs changed while this build was running')
    ),
  );
});

function applyEnv(t, entries) {
  for (const [key, value] of Object.entries(entries)) {
    const previous = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
    t.after(() => {
      if (previous == null) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

async function writeSharedWorkspace(root, workspaceName, dependencies = {}) {
  const workspaceDir = join(root, 'packages', workspaceName);
  await mkdir(join(workspaceDir, 'src'), { recursive: true });
  await mkdir(join(workspaceDir, 'scripts'), { recursive: true });
  await writeFile(join(workspaceDir, 'src', 'index.ts'), `export const ${workspaceName.replaceAll('-', '_')} = true;\n`);
  await writeFile(join(workspaceDir, 'tsconfig.json'), '{}\n');
  await writeFile(join(workspaceDir, 'package.json'), JSON.stringify({
    name: `@happier-dev/${workspaceName}`,
    main: './dist/index.js',
    exports: { '.': './dist/index.js' },
    dependencies,
    scripts: { build: 'node scripts/build.mjs' },
  }));
  await writeFile(join(workspaceDir, 'scripts', 'build.mjs'), [
    "import { appendFile, mkdir, writeFile } from 'node:fs/promises';",
    "import { existsSync } from 'node:fs';",
    "import { join, resolve } from 'node:path';",
    `const workspaceName = ${JSON.stringify(workspaceName)};`,
    "const repoRoot = process.env.FIXTURE_ROOT;",
    "const lockState = existsSync(join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock')) ? 'present' : 'absent';",
    "await appendFile(process.env.EVENTS_PATH, `shared:${workspaceName}\\nshared-lock:${workspaceName}:${lockState}\\n`);",
    "const outputDir = resolve(process.cwd(), process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || 'dist');",
    "await mkdir(outputDir, { recursive: true });",
    "await writeFile(join(outputDir, 'index.js'), 'export const built = true;\\n');",
    '',
  ].join('\n'));
}

async function writeUsableCliDist(cliDir) {
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  const entrypoint = join(cliDir, 'dist', 'index.mjs');
  await writeFile(entrypoint, 'export const cli = true;\n');
  writeCliDistBuildManifest(entrypoint);
}

async function createCliBuildFixture(t, { existingCliDist = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-cli-build-owner-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const binDir = join(root, 'bin');
  const eventsPath = join(root, 'events.txt');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'tweetnacl'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  }));
  await writeFile(join(root, 'yarn.lock'), '# yarn\n');
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n');
  await writeFile(join(root, 'node_modules', 'tweetnacl', 'package.json'), JSON.stringify({
    name: 'tweetnacl',
    version: '1.0.3',
    main: './index.js',
  }));
  await writeFile(join(root, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/ui"}\n');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n');
  await writeFile(join(cliDir, 'src', 'index.ts'), 'export const cli = true;\n');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    dependencies: {
      ...Object.fromEntries(sharedWorkspaceNames.map((name) => [`@happier-dev/${name}`, '0.0.0'])),
      tweetnacl: '1.0.3',
    },
    bundledDependencies: sharedWorkspaceNames.map((name) => `@happier-dev/${name}`),
  }));
  await writeFile(
    join(cliDir, 'scripts', 'buildSharedDeps.mjs'),
    `export { syncSharedDepsForSourceDev } from ${JSON.stringify(
      new URL('../../cli/scripts/buildSharedDeps.mjs', import.meta.url).href,
    )};\n`,
  );
  await writeFile(
    join(cliDir, 'scripts', 'syncSharedDepsForDev.mjs'),
    [
      "import { dirname, resolve } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "import { syncSharedDepsForSourceDev } from './buildSharedDeps.mjs';",
      'const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");',
      'const workspaceNames = process.argv.slice(2).filter((value) => !value.startsWith("--"));',
      'const result = await syncSharedDepsForSourceDev({ repoRoot, workspaceNames });',
      'process.stdout.write(`__HAPPIER_SOURCE_DEV_SYNC_RESULT__=${JSON.stringify(result ?? null)}\\n`);',
      '',
    ].join('\n'),
  );
  await writeSharedWorkspace(root, 'protocol');
  await writeSharedWorkspace(root, 'agents', { '@happier-dev/protocol': '0.0.0' });
  await writeSharedWorkspace(root, 'cli-common', { '@happier-dev/agents': '0.0.0' });
  await writeFile(eventsPath, '');
  if (existingCliDist) await writeUsableCliDist(cliDir);

  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "${1:-}" = "--version" ]; then echo "1.22.22"; exit 0; fi',
    'repo="${FIXTURE_ROOT:?}"',
    'case "$PWD" in',
    '*/packages/protocol|*/packages/agents|*/packages/cli-common)',
    '  workspace="${PWD##*/}"',
    '  echo "shared:$workspace" >> "${EVENTS_PATH:?}"',
    '  if [ -e "$repo/.project/tmp/cli-dist-build.lock" ]; then lock_state=present; else lock_state=absent; fi',
    '  echo "shared-lock:$workspace:$lock_state" >> "${EVENTS_PATH:?}"',
    '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
    '  mkdir -p "$out"',
    '  printf "export const built = true;\\n" > "$out/index.js"',
    '  exit 0',
    ';;',
    'esac',
    'case "$PWD" in',
    '*/apps/cli)',
    'if [ "${1:-}" = "build" ]; then',
    '  # Model Yarn automatic prebuild -> build:shared: this is the full-build owner.',
    '  for workspace in protocol agents cli-common; do',
    '    echo "shared:$workspace" >> "${EVENTS_PATH:?}"',
    '    echo "shared-lock:$workspace:present" >> "${EVENTS_PATH:?}"',
    '    mkdir -p "$repo/packages/$workspace/dist"',
    '    printf "export const built = true;\\n" > "$repo/packages/$workspace/dist/index.js"',
    '  done',
    'fi',
    'if [ "${1:-}" = "build" ] || [ "${1:-}" = "build:prepared" ]; then',
    '  echo "cli:${1:-}" >> "${EVENTS_PATH:?}"',
    '  mkdir -p "$repo/apps/cli/dist"',
    '  printf "export const cli = true;\\n" > "$repo/apps/cli/dist/index.mjs"',
    '  node -e "const manifest = require(process.env.CLI_MANIFEST_HELPER); manifest.writeCliDistBuildManifest(process.argv[1]);" "$repo/apps/cli/dist/index.mjs"',
    '  if [ "${MUTATE_CLI_SOURCE_DURING_BUILD:-0}" = "1" ]; then',
    '    printf "// changed while build was running\\n" >> "$repo/apps/cli/src/index.ts"',
    '  fi',
    '  exit 0',
    'fi',
    ';;',
    'esac',
    'exit 0',
  ].join('\n') + '\n');
  await chmod(yarnPath, 0o755);

  applyEnv(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    FIXTURE_ROOT: root,
    EVENTS_PATH: eventsPath,
    CLI_MANIFEST_HELPER: join(repoRoot, 'packages', 'cli-common', 'cliDistBuildManifest.cjs'),
    HAPPIER_STACK_CLI_BUILD_MODE: existingCliDist ? 'never' : 'auto',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });
  return { cliDir, eventsPath };
}

function countEvent(events, expected) {
  return events.split('\n').filter((event) => event.trim() === expected).length;
}

test('dev reaches Expo before starting remote development targets', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');
  const expoStartIndex = source.lastIndexOf('await ensureDevExpoServer({');
  const serverStartIndex = source.indexOf('await startDevServer({');
  const daemonStartIndex = source.indexOf('if (startupDecision.startDaemon');
  const devTargetsStartIndex = source.indexOf(
    'devTargetsController = startStackDevTargetsInBackground(',
  );

  assert.notEqual(expoStartIndex, -1, 'expected the canonical Expo startup call');
  assert.notEqual(serverStartIndex, -1, 'expected the canonical server startup call');
  assert.notEqual(daemonStartIndex, -1, 'expected daemon startup');
  assert.notEqual(devTargetsStartIndex, -1, 'expected background dev-target startup');
  assert.ok(
    expoStartIndex < serverStartIndex,
    'server source workspace admission must not delay independent Expo availability',
  );
  assert.ok(
    expoStartIndex < daemonStartIndex,
    'a potentially expensive daemon build must not delay Expo availability',
  );
  assert.ok(
    expoStartIndex < devTargetsStartIndex,
    'remote target bootstrap must not delay local Expo startup',
  );
});

test('remote server placement does not wait for the local daemon before starting its target', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');
  const remoteServerDependencyIndex = source.indexOf(
    'const localDaemonWaitsForRemoteServer = servicePlans.targets.some((plan) => plan.services.server);',
  );
  const backgroundDaemonIndex = source.indexOf(
    'if (localDaemonWaitsForRemoteServer) {',
  );
  const devTargetsStartIndex = source.indexOf(
    'devTargetsController = startStackDevTargetsInBackground(',
  );

  assert.notEqual(remoteServerDependencyIndex, -1, 'expected the remote-server dependency decision');
  assert.notEqual(backgroundDaemonIndex, -1, 'expected remote-server daemon startup to be non-blocking');
  assert.notEqual(devTargetsStartIndex, -1, 'expected the canonical target supervisor startup');
  const remoteServerBranchEnd = source.indexOf('} else {', backgroundDaemonIndex);
  assert.notEqual(remoteServerBranchEnd, -1, 'expected the local-server branch after remote-server handling');
  const remoteServerBranch = source.slice(backgroundDaemonIndex, remoteServerBranchEnd);
  assert.match(
    remoteServerBranch,
    /void daemonStartPromise\.catch/u,
    'the VM daemon may start concurrently, but it must not gate the target-hosted server that it needs',
  );
  assert.doesNotMatch(
    remoteServerBranch,
    /await daemonStartPromise/u,
    'waiting for the daemon here recreates the daemon→server→target startup cycle',
  );
});

test('remote Expo or daemon placement scopes generated plugin preparation to dependent targets', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');

  assert.match(source, /createHappyCliWorkspacePreparationExecutor/u);
  assert.match(
    source,
    /servicePlans\.targets\.some\(\s*planRequiresRemoteCliWorkspacePreparation,?\s*\)/u,
  );
  assert.match(
    source,
    /const daemonRefreshEnabled = daemonReloadEnabled \|\| remoteCliWorkspacePreparationEnabled/u,
  );
  assert.match(source, /daemonReloadEnabled:\s*daemonRefreshEnabled/u);
  const initialPreparationIndex = source.indexOf(
    'const remoteWorkspacePreparation = remoteWorkspacePreparationExecutor',
  );
  const devTargetsStartIndex = source.indexOf(
    'devTargetsController = startStackDevTargetsInBackground(',
  );
  assert.notEqual(initialPreparationIndex, -1, 'expected one shared local generated-input preparation promise');
  assert.ok(
    initialPreparationIndex < devTargetsStartIndex,
    'the supervisor must receive the shared preparation promise when it starts',
  );
  assert.match(
    source,
    /startStackDevTargetsInBackground\(\{\s*\.\.\.devTargetsStartOptions,\s*remoteWorkspacePreparation,\s*\}\)/u,
    'the canonical target supervisor must own the scoped preparation barrier',
  );
  assert.doesNotMatch(
    source,
    /await remoteWorkspacePreparationExecutor\.build\(\)/u,
    'an unrelated server-only target must not wait for remote Expo or daemon preparation',
  );
});

test('remote daemon preparation uses the same automatic runtime publisher as local daemon refresh', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');

  assert.match(
    source,
    /const daemonRefreshExecutor = daemonReloadEnabled[\s\S]*?: remoteWorkspacePreparationExecutor;/u,
    'local activation and remote preparation must select one daemon refresh executor',
  );
  assert.match(
    source,
    /wrapReloadExecutorWithRuntimeSnapshotPublication\(\{\s*executor: daemonRefreshExecutor,/u,
    'the selected daemon refresh executor must enter the one canonical runtime publisher',
  );
  assert.doesNotMatch(
    source,
    /reloadExecutors\.push\(remoteWorkspacePreparationExecutor\)/u,
    'remote placement must not bypass automatic daemon publication',
  );
});

test('dev publishes initial remote target state before background startup can publish a terminal state', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');
  const initialStateIndex = source.indexOf(
    "remoteTargets: Object.fromEntries(servicePlans.targets.map((plan) => [",
  );
  const devTargetsStartIndex = source.indexOf(
    'devTargetsController = startStackDevTargetsInBackground(',
  );

  assert.notEqual(initialStateIndex, -1, 'expected initial remote target runtime projection');
  assert.notEqual(devTargetsStartIndex, -1, 'expected background dev-target startup');
  assert.ok(
    initialStateIndex < devTargetsStartIndex,
    'a fast unavailable/running callback must not be overwritten by a later starting projection',
  );
  const initialProjection = source.slice(initialStateIndex, devTargetsStartIndex);
  assert.match(
    initialProjection,
    /status:\s*'starting',\s*phase:\s*null,\s*error:\s*null,/u,
    'a new controller incarnation must clear stale retry diagnostics while publishing its starting state',
  );
});

test('dev publishes a configured remote Expo service in its initial runtime declaration', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');
  const remoteExpoPlanIndex = source.indexOf('const remoteExpoPlan = servicePlans.targets.find((plan) => plan.services.expo) ?? null;');
  const configuredRemoteExpoIndex = source.indexOf('const initialRemoteExpoProjection =');
  const runtimeStartIndex = source.indexOf('await recordStackRuntimeStart(runtimeStatePath, {');
  const watchdogIndex = source.indexOf('spawnStackOwnerDeathWatchdog({');

  assert.notEqual(remoteExpoPlanIndex, -1, 'expected the resolved remote Expo plan');
  assert.notEqual(configuredRemoteExpoIndex, -1, 'expected an initial configured remote Expo projection');
  assert.notEqual(runtimeStartIndex, -1, 'expected the canonical Stack runtime start publication');
  assert.notEqual(watchdogIndex, -1, 'expected the initial runtime publication boundary');
  assert.ok(
    configuredRemoteExpoIndex < runtimeStartIndex,
    'the initial remote Expo declaration must exist before a service tunnel can discover the Stack runtime',
  );
  const initialRuntimePublication = source.slice(runtimeStartIndex, watchdogIndex);
  assert.match(
    initialRuntimePublication,
    /\.\.\.\(initialRemoteExpoProjection \? \{ expo: initialRemoteExpoProjection \} : \{\}\)/u,
    'the first runtime declaration must expose the configured remote Expo service',
  );
  assert.match(
    source.slice(remoteExpoPlanIndex, runtimeStartIndex),
    /remoteExpoPlan[\s\S]*HAPPIER_STACK_EXPO_DEV_PORT[\s\S]*remoteTarget/u,
    'only a configured remote Expo plan may be published before target startup',
  );
});

test('one full CLI admission owns every shared workspace build exactly once', async (t) => {
  const cliPackageJson = JSON.parse(await readFile(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'));
  assert.equal(
    cliPackageJson.scripts?.['build:shared'],
    'node scripts/buildSharedDeps.mjs',
    'the shared closure builder already includes cli-common; the lifecycle script must not build it separately',
  );
  assert.equal(
    cliPackageJson.scripts?.prebuild,
    'yarn -s build:shared',
    'the actual CLI build lifecycle must delegate shared dependency admission to build:shared',
  );
  assert.equal(
    cliPackageJson.scripts?.['build:prepared'],
    cliPackageJson.scripts?.build,
    'Stack-owned preparation needs a lifecycle entrypoint that does not rerun Yarn prebuild',
  );
  const { cliDir, eventsPath } = await createCliBuildFixture(t);

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const events = await readFile(eventsPath, 'utf8');
  for (const workspaceName of sharedWorkspaceNames) {
    assert.equal(countEvent(events, `shared:${workspaceName}`), 1, `build events:\n${events}`);
    assert.equal(
      countEvent(events, `shared-lock:${workspaceName}:absent`),
      1,
      `workspace preparation must run before the final CLI dist lock:\n${events}`,
    );
  }
  assert.equal(countEvent(events, 'cli:build:prepared'), 1, `build events:\n${events}`);
});

test('one successful atomic CLI build is admitted as usable when later edits supersede it', async (t) => {
  const { cliDir, eventsPath } = await createCliBuildFixture(t);
  applyEnv(t, { MUTATE_CLI_SOURCE_DURING_BUILD: '1' });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const events = await readFile(eventsPath, 'utf8');

  assert.equal(countEvent(events, 'cli:build:prepared'), 1, `build events:\n${events}`);
  assert.deepEqual(result, {
    built: true,
    current: false,
    reason: 'inputs_changed_during_build',
  });
});

test('adopting an existing CLI dist still repairs every missing shared workspace once', async (t) => {
  const { cliDir, eventsPath } = await createCliBuildFixture(t, { existingCliDist: true });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  assert.deepEqual(result, { built: false, current: false, reason: 'mode_never' });
  const events = await readFile(eventsPath, 'utf8');
  for (const workspaceName of sharedWorkspaceNames) {
    assert.equal(countEvent(events, `shared:${workspaceName}`), 1, `adoption events:\n${events}`);
  }
  assert.equal(countEvent(events, 'cli:build:prepared'), 0, `adoption events:\n${events}`);
});
