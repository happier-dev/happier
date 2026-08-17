import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function withUnavailableMetroEndpoint() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end('unavailable');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function spawnStackOwnedHealthServer(t, { stackName, envPath, cliHomeDir }) {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ready') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    setInterval(() => {}, 1000);
  `], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The fixture process may already have exited.
    }
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const value = Number(output.split(/\r?\n/).find(Boolean));
      if (Number.isInteger(value) && value > 0) resolve(value);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`stack-owned health server exited early (${code ?? 'unknown'})`)));
  });
  return { child, pid: child.pid, port };
}

test('doctor --json reports the active runtime snapshot', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.activeSnapshotId, 'snap-1');
  assert.equal(parsed.runtime.snapshotPath, fixture.snapshotDir);
  assert.equal(parsed.runtime.mode, 'prefer');
  assert.equal(parsed.uiBuildDir, join(fixture.snapshotDir, 'ui'));
  assert.notEqual(parsed.uiBuildDir, join(fixture.stackDir, 'runtime', 'current', 'ui'));
  assert.equal(parsed.checks.uiBuildDir?.ok, true);
  assert.equal(parsed.checks.uiBuildDir?.path, join(fixture.snapshotDir, 'ui'));
});

test('doctor --json reports source mode when no runtime snapshot is active', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'source',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.mode, 'source');
  assert.equal(parsed.runtime.activeSnapshotId, null);
  assert.equal(parsed.runtime.snapshotPath, null);
  assert.equal(parsed.runtime.valid, false);
  assert.equal(parsed.uiBuildDir, join(fixture.stackDir, 'ui'));
});

test('stack doctor --json diagnoses a source stack even when caller requires runtime snapshots', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
  };

  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'doctor', fixture.stackName, '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.mode, 'source');
  assert.equal(parsed.runtime.activeSnapshotId, null);
  assert.equal(parsed.runtime.snapshotPath, null);
});

test('stack doctor --runtime preserves runtime diagnostics for a controlled consumer', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const res = await runNode([
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack',
    'doctor',
    fixture.stackName,
    '--runtime',
    '--json',
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
      HAPPIER_STACK_RUNTIME_MODE: 'require',
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    },
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.mode, 'require');
  assert.equal(parsed.checks.runtimeSnapshot.ok, false);
  assert.equal(parsed.checks.runtimeSnapshot.status, 'missing');
});

test('stack doctor --json uses the trusted running stack server port when the stack env has none', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'doctor-runtime-port' });
  const runtimeServer = await spawnStackOwnedHealthServer(t, {
    stackName: fixture.stackName,
    envPath: join(fixture.stackDir, 'env'),
    cliHomeDir: join(fixture.stackDir, 'cli'),
  });
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: 999_999_999,
      processes: { serverPid: runtimeServer.pid },
      ports: { server: runtimeServer.port },
    }) + '\n',
    'utf-8',
  );

  const res = await runNode([
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack',
    'doctor',
    fixture.stackName,
    '--json',
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
      HAPPIER_STACK_RUNTIME_MODE: 'source',
    },
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.internalServerUrl, `http://127.0.0.1:${runtimeServer.port}`);
});

test('doctor --json reports invalid active runtime snapshots even in prefer mode', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await writeFile(
    join(fixture.stackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: join(fixture.root, 'escaped-runtime'),
      sourceFingerprint: 'src-1',
    }, null, 2) + '\n',
    'utf-8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.activeSnapshotId, 'snap-1');
  assert.equal(parsed.runtime.snapshotPath, join(fixture.root, 'escaped-runtime'));
  assert.equal(parsed.runtime.valid, false);
  assert.match(parsed.runtime.errors.join('\n'), /outside the stack runtime builds dir/i);
});

test('doctor --json keeps borrowed Expo degraded when its forwarded Metro endpoint is unavailable', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-consumer' });
  const producerStackName = 'repo-producer';
  const unavailableMetro = await withUnavailableMetroEndpoint();
  t.after(async () => await unavailableMetro.close());
  const producerDir = join(fixture.storageDir, producerStackName);
  await appendFile(
    join(fixture.stackDir, 'env'),
    `HAPPIER_STACK_EXPO_SOURCE_STACK=${producerStackName}\n`,
    'utf8',
  );
  await mkdir(producerDir, { recursive: true });
  await writeFile(
    join(producerDir, 'stack.runtime.json'),
    JSON.stringify({
      expo: { webPort: unavailableMetro.port, mobilePort: unavailableMetro.port, devClientEnabled: true },
      placement: { expo: 'mac' },
      remoteTargets: { mac: { status: 'running', services: { expo: true } } },
    }),
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
    HAPPIER_STACK_EXPO_SOURCE_STACK: producerStackName,
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.borrowedExpo.producerStackName, producerStackName);
  assert.equal(parsed.runtime.borrowedExpo.ownership, 'borrowed');
  assert.equal(parsed.runtime.borrowedExpo.running, false);
  assert.equal(parsed.runtime.borrowedExpo.status, 'degraded');
  assert.equal(parsed.runtime.borrowedExpo.remoteTarget, 'mac');
  assert.equal(parsed.checks.borrowedExpo.ok, false);
});

test('doctor gives borrowed-Expo runtime consumers their snapshot and producer prerequisites', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-consumer' });
  const producerStackName = 'repo-producer';
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });
  await appendFile(
    join(fixture.stackDir, 'env'),
    `HAPPIER_STACK_EXPO_SOURCE_STACK=${producerStackName}\nHAPPIER_STACK_RUNTIME_MODE=require\nHAPPIER_STACK_SERVER_PORT=1\n`,
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_EXPO_SOURCE_STACK: producerStackName,
  };

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'doctor', fixture.stackName, '--runtime'],
    {
      cwd: rootDir,
      env: {
        ...env,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /runtime snapshot: missing/i);
  assert.match(res.stdout, /hstack stack runtime qa-consumer select/i);
  assert.doesNotMatch(res.stdout, /hstack stack build qa-consumer --all --activate-runtime/i);
  assert.match(res.stdout, /borrowed Expo: repo-producer \(degraded\)/i);
  assert.match(res.stdout, /restore Expo on producer stack repo-producer/i);
  assert.match(res.stdout, /server health: unreachable/i);
  assert.doesNotMatch(res.stdout, /ui build dir missing/i);
  assert.doesNotMatch(res.stdout, /run: hstack build(?:\s|$)/i);
  assert.doesNotMatch(res.stdout, /start Expo on this consumer/i);
});

test('doctor gives strict runtime snapshot UI consumers snapshot guidance instead of legacy UI-build guidance', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'strict-snapshot' });
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs')], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /runtime snapshot: missing/i);
  assert.match(res.stdout, /hstack stack runtime strict-snapshot select/i);
  assert.doesNotMatch(res.stdout, /hstack stack build strict-snapshot --all --activate-runtime/i);
  assert.doesNotMatch(res.stdout, /borrowed Expo/i);
  assert.doesNotMatch(res.stdout, /ui build dir missing/i);
  assert.doesNotMatch(res.stdout, /run: hstack build(?:\s|$)/i);
});

test('doctor keeps legacy UI-build guidance for ordinary source stacks', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-stack' });
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'source',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs')], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /ui build dir missing/i);
  assert.match(res.stdout, /run: hstack build/i);
  assert.doesNotMatch(res.stdout, /runtime snapshot: missing/i);
});
