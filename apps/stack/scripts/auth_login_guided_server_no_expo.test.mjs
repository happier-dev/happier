import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authScriptPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { ensureMinimalMonorepoLayout } from './testkit/core/minimal_monorepo_layout.mjs';
import { writeRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';

async function createHealthyServer({
  rootBody = 'ok',
  rootContentType = 'text/plain',
  onHealthRequest = null,
  onProfileRequest = null,
} = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/account/profile') {
      if (typeof onProfileRequest === 'function') {
        onProfileRequest({ req, res, server });
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ account: { id: 'acct_test' } }));
      return;
    }
    if (req.url === '/health') {
      if (typeof onHealthRequest === 'function') {
        onHealthRequest({ req, res, server });
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', rootContentType);
    res.end(rootBody);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected listening port, got ${String(port)}`);
  return { server, port };
}

async function reserveUnusedPort() {
  const server = createServer((_, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected reserved port, got ${String(port)}`);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

function buildSuccessfulAuthBinScript() {
  return [
    `import { mkdirSync, writeFileSync } from 'node:fs';`,
    `import { dirname } from 'node:path';`,
    `const credentialPath = process.env.HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH || '';`,
    `if (credentialPath) {`,
    `  mkdirSync(dirname(credentialPath), { recursive: true });`,
    `  writeFileSync(credentialPath, \`\${process.env.HAPPIER_TEST_AUTH_SUCCESS_TOKEN || 'test-token'}\\n\`, 'utf-8');`,
    `}`,
    `process.exit(0);`,
    '',
  ].join('\n');
}

function wrapSuccessfulAuthRuntimeCliScript(runtimeCliScript) {
  const raw = String(runtimeCliScript ?? '');
  const normalizedBody = raw.startsWith('#!') ? raw.replace(/^#![^\n]*\n?/, '') : raw;
  return [
    '#!/bin/sh',
    'if [ -n "${HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH-}" ]; then',
    '  mkdir -p "$(dirname "$HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH")"',
    '  printf "%s\\n" "${HAPPIER_TEST_AUTH_SUCCESS_TOKEN-test-token}" > "$HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH"',
    'fi',
    normalizedBody,
  ].join('\n');
}

async function buildGuidedNoExpoFixture({
  publicServerUrl = '',
  runtimeSnapshot = false,
  runtimeOwnerAlive = false,
  startServer = true,
  stackName = 'main',
  rootBody = 'ok',
  rootContentType = 'text/plain',
  includeSourceCli = true,
  runtimeCliScript = '#!/bin/sh\nexit 0\n',
  successfulLoginWritesCredentials = true,
  onHealthRequest = null,
  onProfileRequest = null,
} = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-guided-no-expo-'));
  const storageDir = join(tmp, 'storage');
  const monoRoot = join(tmp, 'happier');
  const cliHomeDir = join(storageDir, stackName, 'cli');
  await ensureMinimalMonorepoLayout(monoRoot);
  const serverFixture = startServer
    ? await createHealthyServer({ rootBody, rootContentType, onHealthRequest, onProfileRequest })
    : null;
  const server = serverFixture?.server ?? null;
  const port = serverFixture?.port ?? (await reserveUnusedPort());
  const serverUrl = `http://127.0.0.1:${port}`;
  const authEnv = {
    ...process.env,
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
  };
  const credentialPaths = resolveStackCredentialPaths({
    cliHomeDir,
    serverUrl,
    env: authEnv,
  });
  if (includeSourceCli) {
    const sourceCliScript = buildSuccessfulAuthBinScript();
    await writeStubHappierCliFiles(monoRoot, {
      distIndexScript: sourceCliScript,
      binHappierScript: sourceCliScript,
    });
  }

  await mkdir(join(storageDir, stackName), { recursive: true });
  const envPath = join(storageDir, stackName, 'env');
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_SERVER_PORT=${port}`,
      ...(publicServerUrl ? [`HAPPIER_STACK_SERVER_URL=${publicServerUrl}`] : []),
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      '',
    ].join('\n'),
    'utf-8'
  );

  await writeFile(
    join(storageDir, stackName, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeOwnerAlive ? process.pid : undefined,
      ports: { server: port },
    }) + '\n',
    'utf-8'
  );
  if (runtimeSnapshot) {
    await writeRuntimeSnapshotLayout({
      stackDir: join(storageDir, stackName),
      snapshotId: 'snap-auth',
      sourceFingerprint: 'src-auth',
      web: {
        content: '<!doctype html><html><body>runtime ui</body></html>\n',
        artifactFingerprint: 'web-auth',
      },
      server: {
        content: '#!/bin/sh\nexit 0\n',
        artifactFingerprint: 'srv-auth',
      },
      daemon: {
        content: wrapSuccessfulAuthRuntimeCliScript(runtimeCliScript),
        artifactFingerprint: 'cli-auth',
        nodeEntrypoint: 'cli/package-dist/index.mjs',
        nodeContent: 'export {};\n',
      },
    });
  }

  return {
    tmp,
    storageDir,
    stackName,
    server,
    port,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_TEST_TTY: '1',
      HAPPIER_STACK_AUTH_FLOW: '0',
      HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS: '1',
      HAPPIER_STACK_AUTH_EXPO_SOFT_TIMEOUT_MS: '1',
      HAPPIER_NO_BROWSER_OPEN: '1',
      ...(successfulLoginWritesCredentials
        ? {
            HAPPIER_TEST_AUTH_SUCCESS_CREDENTIAL_PATH: credentialPaths.serverScopedPath,
            HAPPIER_TEST_AUTH_SUCCESS_TOKEN: 'test-token',
          }
        : {}),
    },
    async cleanup() {
      if (server) {
        await new Promise((resolvePromise) => server.close(resolvePromise));
      }
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function writeOrchestratedAuthStubLoader({ dir, markerPath }) {
  const loaderPath = join(dir, 'orchestrated-auth-loader.mjs');
  const registerPath = join(dir, 'register-orchestrated-auth-loader.mjs');
  const stubUrl = `data:text/javascript,${encodeURIComponent(`
import { appendFileSync } from 'node:fs';

export async function runOrchestratedGuidedAuthFlow() {
  throw new Error('runOrchestratedGuidedAuthFlow should not be called in this test');
}

export async function startDaemonPostAuth() {
  appendFileSync(${JSON.stringify(markerPath)}, 'startDaemonPostAuth\\n', 'utf-8');
  return { ok: true };
}
`)}`;

  await writeFile(
    loaderPath,
    [
      `const targetSpecifier = './utils/auth/orchestrated_stack_auth_flow.mjs';`,
      `const stubUrl = ${JSON.stringify(stubUrl)};`,
      '',
      'export async function resolve(specifier, context, defaultResolve) {',
      '  if (specifier === targetSpecifier) {',
      '    return { url: stubUrl, shortCircuit: true };',
      '  }',
      '  return defaultResolve(specifier, context, defaultResolve);',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    registerPath,
    [
      `import { register } from 'node:module';`,
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return registerPath;
}

test('hstack auth login --webapp=expo fails closed when Expo web UI is not ready (does not fall back to server URL)', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=expo'], {
      cwd: rootDir,
      env: fixture.env,
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when Expo is unavailable\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
    assert.match(
      res.stderr,
      /guid(ed)? login web UI is still not ready|startup failed/i,
      `stderr:\n${res.stderr}`
    );
    assert.match(res.stderr, /Stack runtime path:/i, `stderr:\n${res.stderr}`);
    assert.match(res.stderr, /server health:/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, new RegExp(`URL: http://localhost:${fixture.port}\\b`), `stdout:\n${res.stdout}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) prefers the runtime-backed stack UI over Expo when a runtime snapshot is active', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
        fixture = await buildGuidedNoExpoFixture({
          stackName: 'dev-built',
          runtimeSnapshot: true,
          runtimeOwnerAlive: true,
          rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
          rootContentType: 'text/html',
        });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=stack'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
      },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for runtime-backed auth without Expo\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login uses the active runtime snapshot cli for the actual login flow', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      const markerPath = join(await mkdtemp(join(tmpdir(), 'hstack-auth-runtime-cli-marker-')), 'runtime-cli-args.log');
        fixture = await buildGuidedNoExpoFixture({
          stackName: 'dev-built',
          runtimeSnapshot: true,
          runtimeOwnerAlive: true,
          includeSourceCli: false,
          rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
          rootContentType: 'text/html',
          runtimeCliScript:
          '#!/bin/sh\n' +
          'if [ -n "$RUNTIME_AUTH_MARKER" ]; then\n' +
          '  printf "%s\\n" "$@" >> "$RUNTIME_AUTH_MARKER"\n' +
          'fi\n' +
          'exit 0\n',
      });
      fixture.markerPath = markerPath;
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--no-open'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
        RUNTIME_AUTH_MARKER: fixture.markerPath,
      },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for runtime-backed auth\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const markerRaw = await readFile(fixture.markerPath, 'utf-8');
    assert.match(markerRaw, /^auth$/m, `expected runtime cli to receive auth command\n${markerRaw}`);
    assert.match(markerRaw, /^login$/m, `expected runtime cli to receive login command\n${markerRaw}`);
    assert.match(markerRaw, /^--no-open$/m, `expected runtime cli to receive --no-open\n${markerRaw}`);
    assert.match(markerRaw, /^--method$/m, `expected runtime cli to receive --method flag\n${markerRaw}`);
    assert.match(markerRaw, /^web$/m, `expected runtime cli to receive web method\n${markerRaw}`);
  } finally {
    if (fixture?.markerPath) {
      await rm(dirname(fixture.markerPath), { recursive: true, force: true }).catch(() => {});
    }
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --force fails closed when guided login exits without usable credentials and skips post-auth daemon start', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-cancelled-auth',
        runtimeSnapshot: true,
        includeSourceCli: false,
        rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
        rootContentType: 'text/html',
        runtimeCliScript: '#!/bin/sh\nexit 0\n',
        successfulLoginWritesCredentials: false,
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const markerPath = join(fixture.tmp, 'post-auth-daemon.marker');
    const registerPath = await writeOrchestratedAuthStubLoader({
      dir: fixture.tmp,
      markerPath,
    });
    const cliHomeDir = join(fixture.storageDir, fixture.stackName, 'cli');
    const serverUrl = `http://127.0.0.1:${fixture.port}`;
    const env = {
      ...fixture.env,
      HAPPIER_STACK_RUNTIME_MODE: 'prefer',
      HAPPIER_ACTIVE_SERVER_ID: `stack_${fixture.stackName}__id_default`,
    };
    const credentialPaths = resolveStackCredentialPaths({
      cliHomeDir,
      serverUrl,
      env,
    });
    await mkdir(dirname(credentialPaths.serverScopedPath), { recursive: true });
    await writeFile(credentialPaths.serverScopedPath, 'stale-token\n', 'utf-8');

    const res = await runNodeCapture(
      [
        '--import',
        registerPath,
        authScriptPath(rootDir),
        'login',
        '--force',
        '--method',
        'web',
        '--webapp=stack',
        '--no-open',
      ],
      {
        cwd: rootDir,
        env,
        input: '\n\n',
      },
    );

    assert.notStrictEqual(
      res.code,
      0,
      `expected non-zero exit when login leaves no usable credentials\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.match(
      res.stderr,
      /did not produce usable credentials|usable credentials were not created/i,
      `stderr:\n${res.stderr}`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      `expected post-auth daemon start to be skipped when guided login does not leave credentials\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --force fails closed when credential validation cannot reach the stack server and skips post-auth daemon start', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-auth-validation-offline',
        runtimeSnapshot: true,
        includeSourceCli: false,
        rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
        rootContentType: 'text/html',
        runtimeCliScript: '#!/bin/sh\nexit 0\n',
        successfulLoginWritesCredentials: true,
        onProfileRequest: ({ req }) => {
          req.socket.destroy();
        },
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const markerPath = join(fixture.tmp, 'post-auth-daemon-validation.marker');
    const registerPath = await writeOrchestratedAuthStubLoader({
      dir: fixture.tmp,
      markerPath,
    });

    const res = await runNodeCapture(
      [
        '--import',
        registerPath,
        authScriptPath(rootDir),
        'login',
        '--force',
        '--method',
        'web',
        '--webapp=stack',
        '--no-open',
      ],
      {
        cwd: rootDir,
        env: {
          ...fixture.env,
          HAPPIER_STACK_RUNTIME_MODE: 'prefer',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_ATTEMPTS: '2',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_RETRY_DELAY_MS: '1',
        },
        input: '\n\n',
      },
    );

    assert.notStrictEqual(
      res.code,
      0,
      `expected non-zero exit when login cannot validate credentials against the stack server\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.match(
      res.stderr,
      /resulting credentials are not usable|request-error/i,
      `stderr:\n${res.stderr}`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      `expected post-auth daemon start to be skipped when credential validation cannot reach the stack server\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --force retries transient credential validation request errors before continuing with post-auth daemon start', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    let profileRequests = 0;
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-auth-validation-request-error-retry',
        runtimeSnapshot: true,
        includeSourceCli: false,
        rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
        rootContentType: 'text/html',
        runtimeCliScript: '#!/bin/sh\nexit 0\n',
        successfulLoginWritesCredentials: true,
        onProfileRequest: ({ req, res }) => {
          profileRequests += 1;
          if (profileRequests === 1) {
            req.socket.destroy();
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ account: { id: 'acct_test' } }));
        },
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const markerPath = join(fixture.tmp, 'post-auth-daemon-validation-request-error-retry.marker');
    const registerPath = await writeOrchestratedAuthStubLoader({
      dir: fixture.tmp,
      markerPath,
    });

    const res = await runNodeCapture(
      [
        '--import',
        registerPath,
        authScriptPath(rootDir),
        'login',
        '--force',
        '--method',
        'web',
        '--webapp=stack',
        '--no-open',
      ],
      {
        cwd: rootDir,
        env: {
          ...fixture.env,
          HAPPIER_STACK_RUNTIME_MODE: 'prefer',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_ATTEMPTS: '3',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_RETRY_DELAY_MS: '1',
        },
        input: '\n\n',
      },
    );

    assert.equal(res.code, 0, `expected exit 0 after transient request-error retry\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.ok(
      existsSync(markerPath),
      `expected post-auth daemon start after transient request-error retry\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.equal(profileRequests, 2, `expected one retry after transient request error, got ${profileRequests} profile requests`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --force retries a transient 401 credential validation response before continuing with post-auth daemon start', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    let profileRequests = 0;
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-auth-validation-401-retry',
        runtimeSnapshot: true,
        includeSourceCli: false,
        rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
        rootContentType: 'text/html',
        runtimeCliScript: '#!/bin/sh\nexit 0\n',
        successfulLoginWritesCredentials: true,
        onProfileRequest: ({ res }) => {
          profileRequests += 1;
          if (profileRequests === 1) {
            res.statusCode = 401;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'token not ready yet', code: 'invalid-token' }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ account: { id: 'acct_test' } }));
        },
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const markerPath = join(fixture.tmp, 'post-auth-daemon-validation-401-retry.marker');
    const registerPath = await writeOrchestratedAuthStubLoader({
      dir: fixture.tmp,
      markerPath,
    });

    const res = await runNodeCapture(
      [
        '--import',
        registerPath,
        authScriptPath(rootDir),
        'login',
        '--force',
        '--method',
        'web',
        '--webapp=stack',
        '--no-open',
      ],
      {
        cwd: rootDir,
        env: {
          ...fixture.env,
          HAPPIER_STACK_RUNTIME_MODE: 'prefer',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_ATTEMPTS: '3',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_RETRY_DELAY_MS: '1',
        },
        input: '\n\n',
      },
    );

    assert.equal(res.code, 0, `expected exit 0 after transient 401 retry\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.ok(
      existsSync(markerPath),
      `expected post-auth daemon start after transient 401 retry\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.equal(profileRequests, 2, `expected one retry after transient 401, got ${profileRequests} profile requests`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --force retries a transient 503 credential validation response before continuing with post-auth daemon start', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    let profileRequests = 0;
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-auth-validation-503-retry',
        runtimeSnapshot: true,
        includeSourceCli: false,
        rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
        rootContentType: 'text/html',
        runtimeCliScript: '#!/bin/sh\nexit 0\n',
        successfulLoginWritesCredentials: true,
        onProfileRequest: ({ res }) => {
          profileRequests += 1;
          if (profileRequests === 1) {
            res.statusCode = 503;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'server warming' }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ account: { id: 'acct_test' } }));
        },
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const markerPath = join(fixture.tmp, 'post-auth-daemon-validation-503-retry.marker');
    const registerPath = await writeOrchestratedAuthStubLoader({
      dir: fixture.tmp,
      markerPath,
    });

    const res = await runNodeCapture(
      [
        '--import',
        registerPath,
        authScriptPath(rootDir),
        'login',
        '--force',
        '--method',
        'web',
        '--webapp=stack',
        '--no-open',
      ],
      {
        cwd: rootDir,
        env: {
          ...fixture.env,
          HAPPIER_STACK_RUNTIME_MODE: 'prefer',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_ATTEMPTS: '3',
          HAPPIER_STACK_AUTH_CREDENTIAL_VALIDATION_RETRY_DELAY_MS: '1',
        },
        input: '\n\n',
      },
    );

    assert.equal(res.code, 0, `expected exit 0 after transient 503 retry\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.ok(
      existsSync(markerPath),
      `expected post-auth daemon start after transient 503 retry\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`,
    );
    assert.equal(profileRequests, 2, `expected one retry after transient 503, got ${profileRequests} profile requests`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login suggests runtime-backed start when a runtime-backed stack is already starting but unhealthy', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-built',
        runtimeSnapshot: true,
        runtimeOwnerAlive: true,
        startServer: false,
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
        HAPPIER_STACK_AUTH_SERVER_READY_TIMEOUT_MS: '1000',
      },
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when runtime-backed server stays unhealthy\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /stack runtime is already starting; waiting for health/i, `stderr:\n${res.stderr}`);
    assert.match(res.stderr, /hstack stack start dev-built --background --runtime/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /hstack stack dev dev-built --background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login falls back to mobile when a runtime-backed stack stays unhealthy during auth startup', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      const markerPath = join(await mkdtemp(join(tmpdir(), 'hstack-auth-runtime-mobile-fallback-')), 'runtime-cli-args.log');
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-built',
        runtimeSnapshot: true,
        runtimeOwnerAlive: true,
        startServer: true,
        onHealthRequest: ({ res }) => {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ status: 'starting' }));
        },
        runtimeCliScript:
          '#!/bin/sh\n' +
          'set -eu\n' +
          'printf "%s\\n" "$@" >> "$RUNTIME_AUTH_MARKER"\n' +
          'printf "method=%s\\n" "${HAPPIER_AUTH_METHOD-}" >> "$RUNTIME_AUTH_MARKER"\n' +
          'printf "%s\\n" "--" >> "$RUNTIME_AUTH_MARKER"\n' +
          'exit 0\n',
      });
      fixture.markerPath = markerPath;
      const envFilePath = join(fixture.tmp, 'storage', 'dev-built', 'env');
      const envFileRaw = await readFile(envFilePath, 'utf-8');
      await writeFile(
        envFilePath,
        `${envFileRaw}HAPPIER_STACK_SERVICE_MODE=1\nHAPPIER_STACK_AUTH_SERVER_READY_TIMEOUT_MS=1000\n`,
        'utf-8'
      );
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_SERVICE_MODE: '1',
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
        RUNTIME_AUTH_MARKER: fixture.markerPath,
      },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 after falling back to mobile auth\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const markerRaw = await readFile(fixture.markerPath, 'utf-8');
    assert.match(markerRaw, /^auth$/m, `expected runtime cli to receive auth command\n${markerRaw}`);
    assert.match(markerRaw, /^login$/m, `expected runtime cli to receive login command\n${markerRaw}`);
    assert.match(markerRaw, /^method=mobile$/m, `expected runtime cli to fall back to mobile auth\n${markerRaw}`);
  } finally {
    if (fixture?.markerPath) {
      await rm(dirname(fixture.markerPath), { recursive: true, force: true }).catch(() => {});
    }
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login suggests stack start for non-Expo guided login when the stack is unhealthy', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-public',
        startServer: false,
        runtimeOwnerAlive: true,
        publicServerUrl: 'https://example.invalid',
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=stack'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_AUTH_SERVER_READY_TIMEOUT_MS: '1000',
      },
      input: '\n\n',
    });

    assert.notStrictEqual(res.code, 0, `expected non-zero exit when stack-backed server stays unhealthy\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /hstack stack start dev-public --background/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /hstack stack dev dev-public --background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) falls back to the stack-served web UI in interactive mode when Expo is not ready', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({ runtimeOwnerAlive: true });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: fixture.env,
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 when auto mode falls back to the stack-served web UI\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) does not attempt Expo in service mode', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({ runtimeOwnerAlive: true });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: { ...fixture.env, HAPPIER_STACK_SERVICE_MODE: '1' },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for auto auth in service mode without Expo\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) keeps the stack-served web UI when Expo is not ready even if a public URL exists', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({ publicServerUrl: 'https://example.invalid' });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: fixture.env,
      input: '2\n',
    });
    assert.equal(res.code, 0, `expected exit 0 when auto auth keeps the stack-served web UI\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /falling back to hosted/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /Pick \[1-\d+\]/i, `expected no interactive hosted fallback prompt\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --method=mobile succeeds even when Expo web UI is not running', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const leakedCliHomeDir = join(fixture.tmp, 'leaked-cli-home');
    await mkdir(leakedCliHomeDir, { recursive: true });
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'mobile'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        // Guard against shell-env leakage from other stack sessions.
        HAPPIER_HOME_DIR: leakedCliHomeDir,
      },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for mobile auth without Expo\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --webapp=expo prints progress messages while waiting for Expo to become ready', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=expo'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS: '50',
        HAPPIER_STACK_AUTH_EXPO_PROGRESS_INTERVAL_MS: '1',
        HAPPIER_STACK_AUTH_UI_START_TIMEOUT_MS: '10',
      },
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when Expo is unavailable\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /still starting|Expo dev server is running/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});
