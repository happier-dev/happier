import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runSqliteMigrationDeploy } from '../migrate.sqlite.deploy';
import { bundleServerRuntimeEntrypoints } from './buildRuntime';

const projectDir = resolve(import.meta.dirname, '..', '..');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, output: () => string): Promise<number> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`light runtime exited ${child.exitCode}:\n${output()}`);
    const status = await fetch(url).then((response) => response.status, () => 0);
    if (status === 200) return status;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  throw new Error(`light runtime never became healthy:\n${output()}`);
}

describe('server light runtime bundle', () => {
  it('boots on Node against a migrated SQLite database and serves health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-light-runtime-boot-'));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    // The bundle keeps package dependencies external. Mirror the in-tree `dist/runtime` lookup:
    // the server's install first, then the workspace root's hoisted packages.
    const serverDir = join(root, 'server');
    await mkdir(serverDir, { recursive: true });
    await symlink(join(projectDir, 'node_modules'), join(serverDir, 'node_modules'), 'junction');
    await symlink(join(projectDir, '..', '..', 'node_modules'), join(root, 'node_modules'), 'junction');
    const outDir = join(serverDir, 'runtime');
    const dataDir = join(root, 'data');
    await mkdir(outDir, { recursive: true });
    await bundleServerRuntimeEntrypoints({ projectDir, outDir });

    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      CI: '1',
      METRICS_ENABLED: 'false',
      HAPPIER_FILES_BACKEND: 'local',
      HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
      HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
      HAPPIER_DB_PROVIDER: 'sqlite',
      DATABASE_URL: `file:${join(dataDir, 'happier-server-light.sqlite')}`,
      HAPPIER_SQLITE_AUTO_MIGRATE: '0',
      HAPPIER_SERVER_HOST: '127.0.0.1',
      PORT: String(port),
    };
    // Schema sync is the package's test preparation; this test needs only the migrated tables.
    await runSqliteMigrationDeploy({ env: { ...env }, serverRoot: projectDir, runSchemaSync: async () => {} });

    let output = '';
    const child = spawn(process.execPath, [join(outDir, 'main.light.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((settle) => child.once('exit', settle));
      child.kill('SIGKILL');
      await exited;
    });
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });

    expect(await waitForHealth(`http://127.0.0.1:${port}/health`, child, () => output)).toBe(200);
  }, 180_000);
});
