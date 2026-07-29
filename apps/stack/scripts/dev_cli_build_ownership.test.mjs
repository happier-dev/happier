import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCliBuilt } from './utils/proc/pm.mjs';
import { writeCliDistBuildManifest } from './utils/cli/cliDistIntegrity.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..', '..', '..');
const sharedWorkspaceNames = ['protocol', 'agents', 'cli-common'];

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
  await writeFile(join(workspaceDir, 'src', 'index.ts'), `export const ${workspaceName.replaceAll('-', '_')} = true;\n`);
  await writeFile(join(workspaceDir, 'tsconfig.json'), '{}\n');
  await writeFile(join(workspaceDir, 'package.json'), JSON.stringify({
    name: `@happier-dev/${workspaceName}`,
    main: './dist/index.js',
    exports: { '.': './dist/index.js' },
    dependencies,
    scripts: { build: 'node scripts/build.mjs' },
  }));
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
    '    mkdir -p "$repo/packages/$workspace/dist"',
    '    printf "export const built = true;\\n" > "$repo/packages/$workspace/dist/index.js"',
    '  done',
    '  echo "cli:build" >> "${EVENTS_PATH:?}"',
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
  const expoStartIndex = source.lastIndexOf('(await ensureDevExpoServer({');
  const devTargetsStartIndex = source.indexOf(
    'devTargetsController = startStackDevTargetsInBackground({',
  );

  assert.notEqual(expoStartIndex, -1, 'expected the canonical Expo startup call');
  assert.notEqual(devTargetsStartIndex, -1, 'expected background dev-target startup');
  assert.ok(
    expoStartIndex < devTargetsStartIndex,
    'remote target bootstrap must not delay local Expo startup',
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
  const { cliDir, eventsPath } = await createCliBuildFixture(t);

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const events = await readFile(eventsPath, 'utf8');
  for (const workspaceName of sharedWorkspaceNames) {
    assert.equal(countEvent(events, `shared:${workspaceName}`), 1, `build events:\n${events}`);
  }
  assert.equal(countEvent(events, 'cli:build'), 1, `build events:\n${events}`);
});

test('one successful atomic CLI build is admitted as usable when later edits supersede it', async (t) => {
  const { cliDir, eventsPath } = await createCliBuildFixture(t);
  applyEnv(t, { MUTATE_CLI_SOURCE_DURING_BUILD: '1' });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const events = await readFile(eventsPath, 'utf8');

  assert.equal(countEvent(events, 'cli:build'), 1, `build events:\n${events}`);
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
  assert.equal(countEvent(events, 'cli:build'), 0, `adoption events:\n${events}`);
});
