import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { writeRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';

async function startHealthServer({ port }) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/account/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: { id: 'acct_test' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  return {
    port: actualPort,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function writeRuntimeCliSnapshot({ fixture, snapshotId, script }) {
  const normalizedBody = String(script ?? '').startsWith('#!')
    ? String(script).replace(/^#![^\n]*\n?/, '')
    : String(script ?? '');
  await writeRuntimeSnapshotLayout({
    stackDir: join(fixture.storageDir, fixture.stackName),
    snapshotId,
    web: {
      content: '<!doctype html><html><body>runtime ui</body></html>\n',
      artifactFingerprint: `web-${snapshotId}`,
    },
    server: {
      content: '#!/bin/sh\nexit 0\n',
      artifactFingerprint: `srv-${snapshotId}`,
    },
    daemon: {
      content: [
        '#!/bin/sh',
        'set -eu',
        normalizedBody,
        'if [ -n "${HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH-}" ]; then',
        '  mkdir -p "$(dirname "$HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH")"',
        '  printf "%s\\n" "${HAPPIER_TEST_AUTH_SUCCESS_TOKEN-test-token}" > "$HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH"',
        'fi',
      ].join('\n'),
      artifactFingerprint: `cli-${snapshotId}`,
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: 'export {};\n',
    },
  });
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

test('hstack stack auth login --force clears stale stack credential aliases while preserving the active credential slot', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const stackName = 'dev';
  let server = null;
  let fixture = null;
  try {
    server = await startHealthServer({ port: 0 });
    const serverPort = server.port;
    fixture = await createAuthStackFixture({
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
    const canonicalServerId = 'stack-dev-profile';
    const historicalServerId = `127.0.0.1-${serverPort}`;
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(
      join(cliHomeDir, 'settings.json'),
      JSON.stringify(
        {
          schemaVersion: 6,
          activeServerId: canonicalServerId,
          servers: {
            [canonicalServerId]: {
              id: canonicalServerId,
              name: canonicalServerId,
              serverUrl: internalServerUrl,
              webappUrl: `http://localhost:${serverPort}`,
              createdAt: 1,
              updatedAt: 1,
              lastUsedAt: 1,
            },
            [historicalServerId]: {
              id: historicalServerId,
              name: historicalServerId,
              serverUrl: internalServerUrl,
              webappUrl: `http://localhost:${serverPort}`,
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    const paths = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalServerUrl, env });
    const canonicalAliasPath = join(cliHomeDir, 'servers', canonicalServerId, 'access.key');
    const historicalCredentialPath = join(cliHomeDir, 'servers', historicalServerId, 'access.key');
    const unrelatedCredentialPath = join(cliHomeDir, 'servers', 'unrelated_server', 'access.key');
    const capturePath = join(cliHomeDir, 'force-cleanup-result.json');

    await writeCredential(paths.serverScopedPath, 'token-stable');
    await writeCredential(paths.urlHashServerScopedPath, 'token-url-hash');
    await writeCredential(paths.hostPortServerScopedPath, 'token-host-port');
    await writeCredential(paths.legacyPath, 'token-legacy');
    await writeCredential(canonicalAliasPath, 'token-canonical-alias');
    await writeCredential(historicalCredentialPath, 'token-historical');
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
  "canonicalAliasPath": os.environ["TEST_CANONICAL_ALIAS_PATH"],
  "historicalCredentialPath": os.environ["TEST_HISTORICAL_CREDENTIAL_PATH"],
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

    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'stack', 'auth', stackName, 'login', '--force', '--no-open', '--method', 'mobile'],
      {
        cwd: rootDir,
        env: {
          ...env,
          TEST_SERVER_SCOPED_PATH: paths.serverScopedPath,
          TEST_CANONICAL_ALIAS_PATH: canonicalAliasPath,
          TEST_HISTORICAL_CREDENTIAL_PATH: historicalCredentialPath,
          TEST_URL_HASH_SERVER_SCOPED_PATH: paths.urlHashServerScopedPath,
          TEST_HOST_PORT_SERVER_SCOPED_PATH: paths.hostPortServerScopedPath,
          TEST_LEGACY_PATH: paths.legacyPath,
          TEST_UNRELATED_CREDENTIAL_PATH: unrelatedCredentialPath,
          TEST_CAPTURE_PATH: capturePath,
          HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH: paths.serverScopedPath,
          HAPPIER_TEST_AUTH_SUCCESS_TOKEN: 'token-fresh',
        },
      },
    );

    assert.equal(
      existsSync(capturePath),
      true,
      `expected runtime snapshot CLI to capture force-cleanup state before auth exits\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
    const observed = JSON.parse(await readFile(capturePath, 'utf-8'));
    assert.deepEqual(observed, {
      serverScopedPath: true,
      canonicalAliasPath: false,
      historicalCredentialPath: true,
      urlHashServerScopedPath: false,
      hostPortServerScopedPath: false,
      legacyPath: false,
      unrelatedCredentialPath: true,
    });
  } finally {
    if (server) {
      await server.close();
    }
    if (fixture) {
      await fixture.cleanup();
    }
  }
});
