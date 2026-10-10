import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolveCurrentBunTarget() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `bun-${os}-${process.arch}`;
}

function compileServer({ entrypoint, outfile }) {
  const result = spawnSync(
    process.env.HAPPIER_BUN_PATH || 'bun',
    [
      join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildServerBunBinary.mjs'),
      `--target=${resolveCurrentBunTarget()}`,
      `--entrypoint=${entrypoint}`,
      `--outfile=${outfile}`,
      '--external=redis',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `server Bun graph must stay server-safe without an Expo/React Native external\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(statSync(outfile).size > 0, `compiled server binary is empty: ${outfile}`);
}

test('the server main and migration Bun graphs stay server-safe and their binary probes execute', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'happier-node-bundle-import-boundary-'));
  try {
    await import(pathToFileURL(join(repoRoot, 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href);
    const componentArtifacts = await import('@happier-dev/cli-common/componentArtifacts');
    const target = componentArtifacts.resolveCurrentBinaryTarget({
      availableTargets: componentArtifacts.SERVER_BINARY_TARGETS,
    });
    const payloadDir = join(outputDir, 'server-payload');
    const buildDbProviders = 'all';
    const entries = await componentArtifacts.resolveServerRuntimeSupportEntries({
      repoRoot, target, buildDbProviders,
    });
    // Migration imports load Prisma before provider admission. Exercise the
    // actual packaged support layout, not a bare code-only executable.
    await componentArtifacts.buildServerRuntimeSupportPayload({
      repoRoot, payloadDir, entries, target, buildDbProviders,
    });
    for (const entrypointName of ['main.light.ts', 'main.ts']) {
      const outfile = join(payloadDir, `happier-server-${entrypointName}${target.exeExt}`);
      compileServer({
        entrypoint: join(repoRoot, 'apps', 'server', 'sources', entrypointName),
        outfile,
      });
      if (entrypointName === 'main.light.ts') {
        const probe = spawnSync(outfile, ['--probe-runtime-capabilities'], { cwd: payloadDir, encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
        assert.equal(JSON.parse(probe.stdout).component, 'happier-server-light');
      }
    }
    const migration = join(payloadDir, `happier-server-migrate${target.exeExt}`);
    compileServer({ entrypoint: join(repoRoot, 'apps/server/scripts/runtime/migrateFullRuntime.ts'), outfile: migration });
    // SQLite migrations belong to the in-process SQLite owner; this process
    // refusal probes the loaded migration graph without opening any database.
    const refused = spawnSync(migration, [], { cwd: payloadDir, encoding: 'utf8', env: {
      ...process.env, HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: '',
    } });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /unsupported database provider: sqlite/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('the daemon Bun graph does not reach Expo or React Native source', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'happier-daemon-bundle-import-boundary-'));
  try {
    // The daemon probe exercises the native source owner, not an npm dist
    // publication or a stubbed internal workspace preparer.
    await import(pathToFileURL(join(repoRoot, 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href);
    const componentArtifacts = await import('@happier-dev/cli-common/componentArtifacts');

    const daemonPayloadDir = join(outputDir, 'daemon-payload');
    const daemonTarget = componentArtifacts.resolveCurrentBinaryTarget({
      availableTargets: componentArtifacts.CLI_BINARY_TARGETS,
    });
    const daemon = await componentArtifacts.buildCliBinaryArtifactCodePayload({
      repoRoot,
      payloadDir: daemonPayloadDir,
      target: daemonTarget,
      externals: [],
    });
    assert.ok(
      statSync(join(daemonPayloadDir, daemon.executableName)).size > 0,
      'compiled daemon binary must be non-empty',
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('server native entries consume authored workspace exports despite poisoned dist and installed copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-server-source-exports-'));
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  try {
    write(join(root, 'apps/server/package.json'), '{"type":"module"}');
    write(join(root, 'packages/fixture/package.json'), JSON.stringify({
      name: '@happier-dev/fixture', type: 'module', exports: {
        '.': { 'happier-source': './src/index.ts', default: './dist/index.js' },
      },
    }));
    write(join(root, 'packages/fixture/src/index.ts'), 'export const value = "authored source";');
    write(join(root, 'packages/fixture/dist/index.js'), 'throw new Error("workspace dist consumed");');
    write(join(root, 'apps/server/node_modules/@happier-dev/fixture/package.json'), '{"main":"index.js"}');
    write(join(root, 'apps/server/node_modules/@happier-dev/fixture/index.js'), 'console.log("installed shadow consumed");');
    for (const name of ['main.light.ts', 'main.ts', 'migrateFullRuntime.ts']) {
      const entrypoint = join(root, 'apps/server', name);
      const outfile = join(root, `server-${name}`);
      write(entrypoint, 'import {value} from "@happier-dev/fixture"; console.log(value);');
      const built = spawnSync(process.env.HAPPIER_BUN_PATH || 'bun', [
        join(repoRoot, 'packages/cli-common/scripts/buildServerBunBinary.mjs'),
        `--target=${resolveCurrentBunTarget()}`, `--entrypoint=${entrypoint}`, `--outfile=${outfile}`,
      ], { cwd: root, encoding: 'utf8' });
      assert.equal(built.status, 0, built.stderr);
      const ran = spawnSync(outfile, [], { cwd: root, encoding: 'utf8' });
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stdout.trim(), 'authored source');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
