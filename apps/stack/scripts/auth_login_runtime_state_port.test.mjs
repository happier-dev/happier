import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack auth login --print --json uses stack.runtime.json server port when HAPPIER_STACK_SERVER_PORT is missing', async (t) => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-runtime-port-',
    stackName: 'dev-auth',
    stackEnvLines: [
      'HAPPIER_STACK_STACK=dev-auth',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
    ],
  });
  try {
    const runtimeServer = spawn(process.execPath, ['-e', `
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
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        HAPPIER_STACK_STACK: 'dev-auth',
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
        HAPPIER_STACK_CLI_HOME_DIR: join(fixture.storageDir, 'dev-auth', 'cli'),
        HAPPIER_STACK_PROCESS_KIND: 'server',
      },
    });
    t.after(() => {
      try {
        runtimeServer.kill('SIGKILL');
      } catch {
        // ignore
      }
    });
    const runtimeServerPort = await new Promise((resolve, reject) => {
      let output = '';
      runtimeServer.stdout.setEncoding('utf8');
      runtimeServer.stdout.on('data', (chunk) => {
        output += String(chunk);
        const value = Number(output.split(/\r?\n/).find(Boolean));
        if (Number.isInteger(value) && value > 0) resolve(value);
      });
      runtimeServer.once('error', reject);
      runtimeServer.once('exit', (code) => reject(new Error(`runtime server exited early (${code ?? 'unknown'})`)));
    });

    const runtimeStatePath = join(fixture.storageDir, 'dev-auth', 'stack.runtime.json');
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName: 'dev-auth',
        ownerPid: 999_999_999,
        processes: { serverPid: runtimeServer.pid },
        ports: { server: runtimeServerPort },
      }) + '\n',
      'utf-8'
    );

    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'auth', 'login', '--print', '--no-open', '--json'],
      {
        cwd: rootDir,
        env: fixture.buildEnv({
          HAPPIER_SERVER_URL: '',
          HAPPIER_STACK_SERVER_PORT: '',
        }),
      }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());

    assert.equal(parsed.stackName, 'dev-auth');
    assert.equal(parsed.internalServerUrl, `http://127.0.0.1:${runtimeServerPort}`);
    assert.equal(parsed.publicServerUrl, `http://localhost:${runtimeServerPort}`);
  } finally {
    await fixture.cleanup();
  }
});
