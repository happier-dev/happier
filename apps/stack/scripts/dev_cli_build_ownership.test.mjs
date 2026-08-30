import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCliBuilt } from './utils/proc/pm.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

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

async function createCliBuildFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-cli-build-owner-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  const agentsDir = join(root, 'packages', 'agents');
  const binDir = join(root, 'bin');
  const eventsPath = join(root, 'events.txt');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await mkdir(join(agentsDir, 'src'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"private":true}\n');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/ui"}\n');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n');
  await writeFile(join(cliDir, 'src', 'index.ts'), 'export const cli = true;\n');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    dependencies: { '@happier-dev/agents': '0.0.0' },
  }));
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n');
  await writeFile(join(agentsDir, 'src', 'index.ts'), 'export const version = 1;\n');
  await writeFile(join(agentsDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/agents',
    main: './dist/index.js',
    exports: { '.': './dist/index.js' },
    scripts: { build: 'node scripts/build.mjs' },
  }));
  await writeFile(eventsPath, '');

  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "${1:-}" = "--version" ]; then echo "1.22.22"; exit 0; fi',
    'repo="${FIXTURE_ROOT:?}"',
    'case "$PWD" in',
    '*/packages/agents)',
    '  echo "shared:agents" >> "${EVENTS_PATH:?}"',
    '  out="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
    '  mkdir -p "$out"',
    '  printf "export const agents = true;\\n" > "$out/index.js"',
    '  exit 0',
    ';;',
    'esac',
    'case "$PWD" in',
    '*/apps/cli)',
    'if [ "${1:-}" = "build" ]; then',
    '  # Yarn runs prebuild before build; model the real CLI build:shared owner.',
    '  echo "shared:agents" >> "${EVENTS_PATH:?}"',
    '  mkdir -p "$repo/packages/agents/dist"',
    '  printf "export const agents = true;\\n" > "$repo/packages/agents/dist/index.js"',
    '  echo "cli:build" >> "${EVENTS_PATH:?}"',
    '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist}"',
    '  mkdir -p "$out"',
    '  printf "export const cli = true;\\n" > "$out/index.mjs"',
    '  printf "{\\"fingerprint\\":\\"abcdef1234567890\\",\\"fileCount\\":1}\\n" > "$out/.build-manifest.json"',
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
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });
  return { cliDir, agentsDir, eventsPath };
}

function countEvent(events, expected) {
  return events.split('\n').filter((event) => event.trim() === expected).length;
}

test('dev cold-start delegates CLI build admission exclusively to the daemon launch owner', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');
  assert.doesNotMatch(
    source,
    /ensureDevCliReady/,
    'dev must not eagerly build before startDevDaemon re-enters canonical daemon generation admission',
  );
  assert.match(source, /await startDevDaemon\(/);
});

test('dev reaches Expo before starting remote development targets', async () => {
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf-8');
  const expoStartIndex = source.lastIndexOf('await ensureDevExpoServer({');
  const devTargetsStartIndex = source.lastIndexOf('startStackDevTargetsInBackground(');

  assert.notEqual(expoStartIndex, -1, 'expected the canonical Expo startup call');
  assert.notEqual(devTargetsStartIndex, -1, 'expected background dev-target startup');
  assert.ok(
    expoStartIndex < devTargetsStartIndex,
    'remote target bootstrap must not delay local Expo startup',
  );
});

test('one CLI admission builds each missing or changed shared workspace once', async (t) => {
  const { cliDir, agentsDir, eventsPath } = await createCliBuildFixture(t);

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  let events = await readFile(eventsPath, 'utf-8');
  assert.equal(countEvent(events, 'shared:agents'), 1, `cold build events:\n${events}`);
  assert.equal(countEvent(events, 'cli:build'), 1, `cold build events:\n${events}`);

  await writeFile(eventsPath, '');
  await writeFile(join(agentsDir, 'src', 'index.ts'), 'export const version = 2;\n');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  events = await readFile(eventsPath, 'utf-8');
  assert.equal(countEvent(events, 'shared:agents'), 1, `changed-input build events:\n${events}`);
  assert.equal(countEvent(events, 'cli:build'), 1, `changed-input build events:\n${events}`);
});

test('one successful atomic CLI build is admitted as usable when later edits supersede it', async (t) => {
  const { cliDir, eventsPath } = await createCliBuildFixture(t);
  applyEnv(t, { MUTATE_CLI_SOURCE_DURING_BUILD: '1' });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const events = await readFile(eventsPath, 'utf-8');

  assert.equal(countEvent(events, 'cli:build'), 1, `build events:\n${events}`);
  assert.deepEqual(result, {
    built: true,
    current: false,
    reason: 'inputs_changed_during_build',
  });
});
