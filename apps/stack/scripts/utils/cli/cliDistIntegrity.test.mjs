import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import cliDistBuildManifest from './cliDistBuildManifestLoader.mjs';

import {
  probeCliDistRuntimeImport,
  readCliDistBuildManifest,
  readCliDistClosureFingerprint,
  resolveCliDistEntrypointFromBin,
  writeCliDistBuildManifest,
} from './cliDistIntegrity.mjs';

test('CLI runtime probes suppress creation of a Windows console at the process boundary', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hidden-runtime-probe-' });
  const entry = fixture.path('entry.mjs');
  await writeFile(entry, 'export const ready = true;\n');
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(options.windowsHide, true);
    return originalSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await probeCliDistRuntimeImport(entry);
});

test('fresh entry loads identify the first failing module and accept a healthy graph', async t => {
  const fixture = await createTempFixture(t, { prefix: 'entry-load-contract-' });
  const entry = fixture.path('entry.mjs');
  const leaf = fixture.path('leaf.mjs');
  await writeFile(entry, "import './leaf.mjs';\n");
  await writeFile(leaf, 'export const before = after; export const after = 1;\n');
  await assert.rejects(probeCliDistRuntimeImport(entry), error => {
    assert.equal(error.firstFailingModule, leaf);
    assert.equal(error.loadError.name, 'ReferenceError');
    assert.match(error.loadError.message, /before initialization/);
    return true;
  });
  await writeFile(leaf, 'export const after = 1; export const before = after;\n');
  await probeCliDistRuntimeImport(entry);
});

test('dependency extraction scales below quadratic for a large emitted import table', () => {
  const measure = (count) => {
    const source = Array.from({ length: count }, (_, index) =>
      `import x${index} from './module${index}.js';\n`).join('');
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const before = process.cpuUsage();
      const specifiers = cliDistBuildManifest.extractRelativeModuleSpecifiers(source);
      const used = process.cpuUsage(before);
      samples.push(used.user + used.system);
      assert.equal(specifiers.length, count);
      assert.equal(specifiers.at(-1), `./module${count - 1}.js`);
    }
    return Math.min(...samples);
  };
  // Compare CPU scaling, not an absolute machine-specific startup deadline.
  // Five times the input must remain below the n^1.5 envelope; rescanning the
  // complete string/comment inventory for each import grows quadratically.
  measure(1000);
  const small = measure(10_000);
  const large = measure(50_000);
  assert.ok(large / small < 5 ** 1.5, `CPU scaling ${large}/${small} = ${large / small}`);
});

test('installed runtime import probes keep their default deadline even with caller cancellation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'installed-probe-deadline-' });
  const entrypoint = fixture.path('entry.mjs');
  const started = fixture.path('started');
  await writeFile(entrypoint, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, 'yes'); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  let onStarted;
  const entered = new Promise(resolve => { onStarted = resolve; });
  const observer = watch(fixture.root, (_event, name) => { if (name === 'started') onStarted(); });
  const scheduled = [];
  const setTimeout = globalThis.setTimeout;
  // The clock is the external boundary: exercise the real spawned loader and
  // advance its existing deadline without spending two minutes in the test.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    scheduled.push({ callback: () => callback(...args), delay });
    return setTimeout(callback, delay, ...args);
  });
  const loading = probeCliDistRuntimeImport(entrypoint, { signal: controller.signal });
  void loading.catch(() => {});
  try {
    await Promise.race([entered, loading.then(() => { throw new Error('loader exited before its deadline'); })]);
    assert.deepEqual(scheduled.map(timer => timer.delay), [120_000]);
    scheduled[0].callback();
    await assert.rejects(loading, error => error.loadError?.code === 'import_timeout');
  } finally {
    observer.close();
    controller.abort(new Error('probe fixture finished'));
    await loading.catch(() => {});
  }
});

async function writeCliBinFixture(root) {
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin', 'happier.mjs'), [
    '#!/usr/bin/env node',
    "import '../dist/index.mjs';",
    '',
  ].join('\n'), 'utf-8');
}

function writeManifest(distDir) {
  return writeCliDistBuildManifest(join(distDir, 'index.mjs'), {
    builtAt: '2026-07-09T00:00:00.000Z',
  });
}

test('readCliDistBuildManifest requires an entrypoint and build manifest', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-manifest-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    assert.deepEqual(readCliDistBuildManifest(entrypoint), {
      ok: false,
      reason: 'missing_build_manifest',
      fingerprint: null,
      maxMtimeMs: null,
      fileCount: 0,
      manifestPath: join(distDir, '.build-manifest.json'),
    });

    writeManifest(distDir);
    const manifest = readCliDistBuildManifest(entrypoint);
    assert.equal(manifest.ok, true);
    assert.equal(manifest.reason, 'manifest');
    assert.match(manifest.fingerprint, /^[a-f0-9]{16}$/);
    assert.equal(manifest.fileCount, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CLI dist integrity follows declared workspace entries and refuses undeclared siblings', async t => {
  const fixture = await createTempFixture(t, { prefix: 'cli-dist-workspace-entry-' });
  const packageName = '@happier-dev/plugins-fixture-extra';
  const dist = fixture.path('package-dist');
  const entrypoint = join(dist, 'index.mjs');
  const daemon = fixture.path('node_modules', packageName, '.happier-plugin-build', 'daemon.js');
  const specifier = `../node_modules/${packageName}/.happier-plugin-build/daemon.js`;
  await mkdir(dist, { recursive: true });
  await mkdir(fixture.path('node_modules', packageName, '.happier-plugin-build'), { recursive: true });
  await writeFile(entrypoint, `export const load = () => import('${specifier}');`);
  await writeFile(daemon, 'export const ready = true;');

  assert.throws(() => writeCliDistBuildManifest(entrypoint, {
    workspaceRuntimeIdentity: 'a'.repeat(64),
    workspaceRuntimePackages: ['@happier-dev/plugins-fixture'],
  }), /incomplete:outside_dist/);
  writeCliDistBuildManifest(entrypoint, {
    workspaceRuntimeIdentity: 'a'.repeat(64),
    workspaceRuntimePackages: [packageName],
  });
  assert.equal(readCliDistBuildManifest(entrypoint).ok, true);

  await writeFile(daemon, 'export const ready = false;');
  assert.equal(readCliDistBuildManifest(entrypoint).reason, 'build_manifest_fingerprint_mismatch');
  await rm(daemon);
  assert.match(readCliDistBuildManifest(entrypoint).reason, /^incomplete:missing_module:/);
});

test('resolveCliDistEntrypointFromBin prefers manifest-complete dist before package-dist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-entrypoint-manifest-'));
  try {
    await writeCliBinFixture(tmp);
    await mkdir(join(tmp, 'dist'), { recursive: true });
    await mkdir(join(tmp, 'package-dist'), { recursive: true });
    await writeFile(join(tmp, 'dist', 'index.mjs'), 'export const value = "dist";\n', 'utf-8');
    await writeFile(join(tmp, 'package-dist', 'index.mjs'), 'export const value = "package";\n', 'utf-8');
    writeManifest(join(tmp, 'dist'));
    writeManifest(join(tmp, 'package-dist'));

    assert.equal(
      resolveCliDistEntrypointFromBin(join(tmp, 'bin', 'happier.mjs')),
      join(tmp, 'dist', 'index.mjs'),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveCliDistEntrypointFromBin falls back to package-dist when dist lacks a manifest', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-package-dist-entrypoint-manifest-'));
  try {
    await writeCliBinFixture(tmp);
    await mkdir(join(tmp, 'dist'), { recursive: true });
    await mkdir(join(tmp, 'package-dist'), { recursive: true });
    await writeFile(join(tmp, 'dist', 'index.mjs'), 'export const value = "dist";\n', 'utf-8');
    await writeFile(join(tmp, 'package-dist', 'index.mjs'), 'export const value = "package";\n', 'utf-8');
    writeManifest(join(tmp, 'package-dist'));

    assert.equal(
      resolveCliDistEntrypointFromBin(join(tmp, 'bin', 'happier.mjs')),
      join(tmp, 'package-dist', 'index.mjs'),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest rejects changed payload bytes', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-stale-manifest-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');
    writeCliDistBuildManifest(entrypoint, {
      builtAt: '2026-07-09T00:00:00.000Z',
    });

    await writeFile(entrypoint, "import './missing-chunk.mjs';\n", 'utf-8');

    const integrity = readCliDistBuildManifest(entrypoint);
    assert.equal(integrity.ok, false);
    assert.match(integrity.reason, /^(?:incomplete:missing_module:|build_manifest_fingerprint_mismatch)/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest rejects a manifest from an unsupported tool version', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-manifest-version-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');
    writeManifest(tmp);
    const manifestPath = join(tmp, '.build-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, toolVersion: 'unknown' }), 'utf-8');
    assert.equal(readCliDistBuildManifest(entrypoint).reason, 'unsupported_build_manifest_version');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistBuildManifest rejects a blank executable entrypoint even when its manifest matches', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-empty-entrypoint-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, '', 'utf-8');
    const closure = readCliDistClosureFingerprint(entrypoint);
    assert.equal(closure.ok, true);
    await writeFile(join(tmp, '.build-manifest.json'), `${JSON.stringify({
      fingerprint: closure.fingerprint,
      builtAt: '2026-07-11T00:00:00.000Z',
      fileCount: closure.fileCount,
      toolVersion: '2',
    }, null, 2)}\n`, 'utf-8');

    const integrity = readCliDistBuildManifest(entrypoint);
    assert.equal(integrity.ok, false);
    assert.equal(integrity.reason, 'empty_entrypoint');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport resolves a valid ESM entrypoint', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-ok-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, 'export const ready = true;\n', 'utf-8');

    await probeCliDistRuntimeImport(entrypoint);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport rejects ESM link failures', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-fail-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(entrypoint, "import { A } from './chunk.mjs'; export const value = A;\n", 'utf-8');
    await writeFile(join(tmp, 'chunk.mjs'), 'export const B = true;\n', 'utf-8');

    await assert.rejects(
      () => probeCliDistRuntimeImport(entrypoint),
      /does not provide an export named 'A'/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport validates the daemon command lazy import closure', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-daemon-probe-fail-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    await writeFile(
      entrypoint,
      [
        "if (process.argv.includes('daemon')) {",
        "  try { await import('./daemon.mjs'); }",
        "  catch (error) {",
        "    console.error(error.stack);",
        "    for (let frame = 0; frame < 12; frame++) console.error('    at daemonLoader (runtime.mjs:1:1)');",
        "    process.exit(1);",
        "  }",
        "}",
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(tmp, 'daemon.mjs'), "import './missing-daemon-dependency.mjs';\n", 'utf-8');

    await assert.rejects(
      () => probeCliDistRuntimeImport(entrypoint),
      /missing-daemon-dependency/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('probeCliDistRuntimeImport rejects when the import process stays alive past the timeout', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-runtime-probe-timeout-'));
  try {
    const entrypoint = join(tmp, 'index.mjs');
    const pidPath = join(tmp, 'probe.pid');
    const pipeHolderPidPath = join(tmp, 'pipe-holder.pid');
    await writeFile(
      entrypoint,
      [
        `import { spawn } from 'node:child_process';`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `const pipeHolder = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 5500)'], { stdio: ['ignore', 'ignore', 'inherit'] });`,
        `writeFileSync(${JSON.stringify(pipeHolderPidPath)}, String(pipeHolder.pid));`,
        `setInterval(() => {}, 1000);`,
        '',
      ].join('\n'),
      'utf-8',
    );

    let watchdog;
    const result = await Promise.race([
      probeCliDistRuntimeImport(entrypoint, { timeoutMs: 5000 }).then(
        () => 'resolved',
        (error) => error,
      ),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve('timed-out'), 30_000);
      }),
    ]);
    clearTimeout(watchdog);

    assert.match(result instanceof Error ? result.message : String(result), /timed out/i);
    const probePid = Number(await readFile(pidPath, 'utf-8'));
    assert.throws(
      () => process.kill(probePid, 0),
      (error) => error?.code === 'ESRCH',
      'expected the timed-out import probe process to be reaped before rejection',
    );
    const pipeHolderPid = Number(await readFile(pipeHolderPidPath, 'utf-8'));
    assert.throws(
      () => process.kill(pipeHolderPid, 0),
      (error) => error?.code === 'ESRCH',
      'expected the timed-out import probe stderr pipe to be closed before rejection',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
