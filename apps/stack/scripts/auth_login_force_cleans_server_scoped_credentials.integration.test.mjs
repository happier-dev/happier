import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';

async function startHealthServer({ port }) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function writeRuntimeCliSnapshot({ fixture, snapshotId, script }) {
  const snapshotDir = join(fixture.storageDir, fixture.stackName, 'runtime', 'builds', snapshotId);
  await mkdir(join(snapshotDir, 'ui'), { recursive: true });
  await mkdir(join(snapshotDir, 'server'), { recursive: true });
  await mkdir(join(snapshotDir, 'cli'), { recursive: true });
  await writeFile(join(snapshotDir, 'ui', 'index.html'), '<!doctype html><html><body>runtime ui</body></html>\n', 'utf-8');
  await writeFile(join(snapshotDir, 'server', 'happier-server'), '#!/bin/sh\nexit 0\n', 'utf-8');
  const cliPath = join(snapshotDir, 'cli', 'happier');
  await writeFile(cliPath, script, 'utf-8');
  await chmod(cliPath, 0o755);
  await writeFile(
    join(snapshotDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      snapshotId,
      sourceFingerprint: `src-${snapshotId}`,
      components: {
        web: { artifactFingerprint: `web-${snapshotId}`, entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: `srv-${snapshotId}`, entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: `cli-${snapshotId}`, entrypoint: 'cli/happier' },
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(
    join(fixture.storageDir, fixture.stackName, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId,
      snapshotPath: snapshotDir,
      sourceFingerprint: `src-${snapshotId}`,
    }) + '\n',
    'utf-8',
  );
}

async function writeCredential(path, token) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      token,
      encryption: { publicKey: 'AA==', machineKey: 'AA==' },
    }) + '\n',
    'utf-8',
  );
}

test('hstack stack auth login --force clears stale stack credential aliases before invoking core login', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const stackName = 'dev';
  const serverPort = 4102;
  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-force-cleanup-',
    stackName,
    stackEnvLines: [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      'HAPPIER_STACK_RUNTIME_MODE=prefer',
    ],
  });
  fixture.stackName = stackName;

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const cliHomeDir = join(fixture.storageDir, stackName, 'cli');
  const env = fixture.buildEnv({
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
    HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
  });
  const paths = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalServerUrl, env });
  const unrelatedCredentialPath = join(cliHomeDir, 'servers', 'unrelated_server', 'access.key');
  const capturePath = join(cliHomeDir, 'force-cleanup-result.json');

  let server = null;
  try {
    await mkdir(cliHomeDir, { recursive: true });
    await writeCredential(paths.serverScopedPath, 'token-stable');
    await writeCredential(paths.urlHashServerScopedPath, 'token-url-hash');
    await writeCredential(paths.hostPortServerScopedPath, 'token-host-port');
    await writeCredential(paths.legacyPath, 'token-legacy');
    await writeCredential(unrelatedCredentialPath, 'token-unrelated');

    await writeRuntimeCliSnapshot({
      fixture,
      snapshotId: 'snap-force-cleanup',
      script: `#!/bin/sh
set -eu
python3 - <<'PY'
import json, os
paths = {
  "serverScopedPath": os.environ["TEST_SERVER_SCOPED_PATH"],
  "urlHashServerScopedPath": os.environ["TEST_URL_HASH_SERVER_SCOPED_PATH"],
  "hostPortServerScopedPath": os.environ["TEST_HOST_PORT_SERVER_SCOPED_PATH"],
  "legacyPath": os.environ["TEST_LEGACY_PATH"],
  "unrelatedCredentialPath": os.environ["TEST_UNRELATED_CREDENTIAL_PATH"],
}
result = {key: os.path.exists(value) for key, value in paths.items()}
with open(os.environ["TEST_CAPTURE_PATH"], "w", encoding="utf-8") as fh:
    json.dump(result, fh)
PY
`,
    });

    server = await startHealthServer({ port: serverPort });

    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'stack', 'auth', stackName, 'login', '--force', '--no-open', '--method', 'mobile'],
      {
        cwd: rootDir,
        env: {
          ...env,
          TEST_SERVER_SCOPED_PATH: paths.serverScopedPath,
          TEST_URL_HASH_SERVER_SCOPED_PATH: paths.urlHashServerScopedPath,
          TEST_HOST_PORT_SERVER_SCOPED_PATH: paths.hostPortServerScopedPath,
          TEST_LEGACY_PATH: paths.legacyPath,
          TEST_UNRELATED_CREDENTIAL_PATH: unrelatedCredentialPath,
          TEST_CAPTURE_PATH: capturePath,
        },
      },
    );

    assert.equal(res.code, 0, `expected login --force to exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(existsSync(capturePath), true, 'expected runtime snapshot CLI to capture force-cleanup state');
    const observed = JSON.parse(await readFile(capturePath, 'utf-8'));
    assert.deepEqual(observed, {
      serverScopedPath: false,
      urlHashServerScopedPath: false,
      hostPortServerScopedPath: false,
      legacyPath: false,
      unrelatedCredentialPath: true,
    });
  } finally {
    if (server) {
      await server.close();
    }
    await fixture.cleanup();
  }
});
