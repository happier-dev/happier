import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolveHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';
import { resolveBestExpoWebappUrlForAuth, resolveStackWebappTargetForAuth, buildStackAuthLoginInvocation } from '../../utils/auth/stack_guided_login.mjs';
import { prepareSourceRuntimeReload } from '../launch/prepareSourceRuntimeReload.mjs';
import { prepareSourceQaWebUi } from '../../build/build_source_web_ui.mjs';
import { beginPendingSourceStart } from './pending_source_start.mjs';
import { getDaemonEnv } from '../../daemon.mjs';
import { buildServerRuntimeEnv } from '../../utils/server/server_env.mjs';
import test from 'node:test';

import {
  buildBorrowedExpoUiUrl,
  isBorrowedExpoConsumer,
  projectBorrowedExpoWebappEnv,
  projectBorrowedExpoRuntime,
  resolveBorrowedExpoLogPath,
  resolveBorrowedExpoRuntime,
} from './borrowed_expo.mjs';

async function resolveRemoteBorrowedExpoForTest(t, { metroRunning }) {
  const storageDir = await mkdirTempStackStorage(t);
  let reachable = metroRunning;
  const probedPorts = [];
  const metro = createServer((_request, response) => {
    probedPorts.push(port);
    response.writeHead(reachable ? 200 : 503).end(reachable ? 'packager-status:running' : 'unavailable');
  });
  metro.listen(0, '127.0.0.1');
  await once(metro, 'listening');
  const port = metro.address().port;
  t.after(() => { metro.closeAllConnections(); return new Promise(resolve => metro.close(resolve)); });
  const producerStackName = 'repo-happier-producer';
  const producerStackDir = join(storageDir, producerStackName);
  await mkdir(producerStackDir, { recursive: true });
  await writeFile(
    join(producerStackDir, 'stack.runtime.json'),
    JSON.stringify({
      startedAt: '2026-09-20T08:00:00.000Z',
      expo: { webPort: port, mobilePort: port, devClientEnabled: true },
      placement: { expo: 'mac' },
      remoteTargets: { mac: { status: 'running', services: { expo: true } } },
      processes: { expoPid: null },
    }) + '\n',
    'utf8',
  );

  const query = {
    rootDir: process.cwd(),
    producerStackName,
    env: {
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_REPO_DIR: process.cwd(),
    },
  };
  const projected = await resolveBorrowedExpoRuntime(query);
  return { projected, probedPorts, query, port, setReachable(value) { reachable = value; },
    refresh: () => resolveBorrowedExpoRuntime(query) };
}

async function mkdirTempStackStorage(t) {
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-borrowed-expo-'));
  t.after(async () => await rm(storageDir, { recursive: true, force: true }));
  return storageDir;
}

test('isBorrowedExpoConsumer gives ownership only to a distinct producer stack', () => {
  assert.equal(isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: 'repo-dev' }), true);
  assert.equal(isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: 'qa' }), false);
  assert.equal(isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: '' }), false);
});

test('source restart admits runtime work while borrowed Expo is unavailable', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-borrowed-reload-' });
  const env = { ...process.env, HAPPIER_STACK_EXPO_SOURCE_STACK: 'missing-producer',
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  const prepared = await prepareSourceRuntimeReload({ stackName: 'qa', stackBaseDir: fixture.path('stacks/qa'),
    repoDir: process.cwd(), args: ['--no-dev-targets', '--no-server', '--server-url=http://127.0.0.1:3005', '--no-daemon'], env });
  assert.equal(prepared.ui, null);
  assert.equal(prepared.remote, false);
});

test('default source UI misses borrow locally and never contact an unrelated host', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-local-web-miss-' });
  const stackBaseDir = fixture.path('stacks/qa');
  const pending = await beginPendingSourceStart({ stackBaseDir });
  t.after(async () => await pending.dispose());
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer' };
  let remoteRequests = 0;
  const ui = await prepareSourceQaWebUi({ mode: 'auto', repoDir: process.cwd(), stackBaseDir, pending,
    revision: { revision: 'a'.repeat(40), overlayDigest: null }, env,
    requestWebPublication: async () => { remoteRequests++; throw new Error('unrelated host unavailable'); } });
  assert.equal(remoteRequests, 0);
  assert.deepEqual(ui, { mode: 'borrowed', built: null, reason: 'source_web_publication_missing' });
});

test('borrowed Expo projects the consumer UI origin without replacing an explicit webapp URL', async t => {
  const { query, port, setReachable } = await resolveRemoteBorrowedExpoForTest(t, { metroRunning: true });
  const projected = await projectBorrowedExpoWebappEnv({
    ...query,
    consumerStackName: 'agent-qa-embed',
  });

  assert.equal(projected.HAPPIER_WEBAPP_URL, `http://happier-agent-qa-embed.localhost:${port}`);
  const serverEnv = buildServerRuntimeEnv({
    baseEnv: projected,
    serverPort: 43005,
    publicServerUrl: 'http://happier-agent-qa-embed.localhost:43005',
  });
  const daemonEnv = await getDaemonEnv({
    baseEnv: projected,
    cliHomeDir: join(query.env.HAPPIER_STACK_STORAGE_DIR, 'agent-qa-embed', 'cli'),
    internalServerUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://happier-agent-qa-embed.localhost:43005',
    stackName: 'agent-qa-embed',
    cliIdentity: 'default',
  });
  assert.equal(serverEnv.HAPPIER_WEBAPP_URL, projected.HAPPIER_WEBAPP_URL);
  assert.equal(daemonEnv.HAPPIER_WEBAPP_URL, projected.HAPPIER_WEBAPP_URL);

  const explicit = await projectBorrowedExpoWebappEnv({
    ...query,
    consumerStackName: 'agent-qa-embed',
    env: { ...query.env, HAPPIER_WEBAPP_URL: 'https://explicit.example.test' },
  });
  assert.equal(explicit.HAPPIER_WEBAPP_URL, 'https://explicit.example.test');

  setReachable(false);
  const degraded = await projectBorrowedExpoWebappEnv({
    ...query,
    consumerStackName: 'agent-qa-embed',
  });
  assert.equal(degraded.HAPPIER_WEBAPP_URL, `http://happier-agent-qa-embed.localhost:${port}`);
});

test('borrowed Expo rejects non-canonical producer names before resolving managed paths', async () => {
  assert.throws(
    () => isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: '../outside' }),
    /invalid borrowed Expo producer stack name/i,
  );
  await assert.rejects(
    () => resolveBorrowedExpoRuntime({
      rootDir: '/repo',
      producerStackName: 'My Stack',
      env: { HAPPIER_STACK_STORAGE_DIR: '/stacks' },
    }),
    /invalid borrowed Expo producer stack name/i,
  );
});

test('borrowed Expo login resolves and publishes the web app origin without browser bootstrap parameters', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-borrowed-auth-origin-' });
  // Real HTTP and stack-state boundaries keep the guided-auth production resolver composed.
  const metro = createServer((req, res) => res.end('packager-status:running'));
  metro.listen(0, '127.0.0.1');
  await once(metro, 'listening');
  t.after(() => new Promise(resolve => metro.close(resolve)));
  const port = metro.address().port;
  const producer = 'repo-auth-producer';
  const consumer = 'qa-auth-origin';
  const storageDir = fixture.path('stacks');
  await mkdir(join(storageDir, producer), { recursive: true });
  await mkdir(join(storageDir, consumer), { recursive: true });
  const envPath = join(storageDir, consumer, 'env');
  await writeFile(envPath, `HAPPIER_STACK_EXPO_SOURCE_STACK=${producer}\n`);
  await writeFile(join(storageDir, producer, 'stack.runtime.json'), JSON.stringify({
    expo: { webPort: port, mobilePort: port },
    placement: { expo: 'mac' },
    remoteTargets: { mac: { status: 'running', services: { expo: true } } },
    processes: { expoPid: null },
  }));
  const input = { rootDir: process.cwd(), stackName: consumer, timeoutMs: 1, env: buildStackFixtureEnv({
    storageDir, stackName: consumer, envPath, stripStackEnv: true,
    extraEnv: { HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_SERVER_PORT: '43005' },
  }) };
  const expectedOrigin = `http://happier-${consumer}.localhost:${port}`;
  const webappUrl = await resolveBestExpoWebappUrlForAuth(input);
  assert.equal(webappUrl, expectedOrigin);
  const target = await resolveStackWebappTargetForAuth(input);
  assert.deepEqual(target, { webappUrl: expectedOrigin, kind: 'expo' });
  const invocation = await buildStackAuthLoginInvocation({ ...input, webappUrl });
  assert.equal(invocation.env.HAPPIER_WEBAPP_URL, expectedOrigin);
  const home = await resolveHomeTarget({
    input: { kind: 'https_url', url: 'http://127.0.0.1:43005', webappUrl: invocation.env.HAPPIER_WEBAPP_URL },
    readSavedProfile: async () => null,
  });
  assert.equal(home.webappUrl, expectedOrigin);
  // The controlled source-runtime branch reaches the same producer without building or launching a CLI.
  const entrypoint = fixture.path('retained-cli.mjs');
  await writeFile(entrypoint, 'export {};\n');
  await writeFile(join(storageDir, consumer, 'stack.runtime.json'), JSON.stringify({
    sourceRuntimeLaunch: { entrypoint, cliDir: fixture.root },
  }));
  assert.deepEqual(await resolveStackWebappTargetForAuth({ ...input, env: {
    ...input.env, HAPPIER_STACK_RUNTIME_MODE: 'source-snapshot',
  } }), { webappUrl: expectedOrigin, kind: 'expo' });
  const browserUrl = new URL(buildBorrowedExpoUiUrl({ consumerHost: `happier-${consumer}.localhost`, expoPort: port, serverPort: 43005 }));
  assert.equal(browserUrl.origin, expectedOrigin);
  assert.equal(browserUrl.searchParams.get('server'), `http://happier-${consumer}.localhost:43005`);
  assert.equal(browserUrl.searchParams.get('happier_hmr'), '0');
});

test('buildBorrowedExpoUiUrl routes the consumer origin to its own server with HMR disabled', () => {
  const url = new URL(buildBorrowedExpoUiUrl({
    consumerHost: 'happier-qa-agent-17.localhost',
    expoPort: 19364,
    serverPort: 53288,
  }));

  assert.equal(url.hostname, 'happier-qa-agent-17.localhost');
  assert.equal(url.port, '19364');
  assert.equal(url.searchParams.get('server'), 'http://happier-qa-agent-17.localhost:53288');
  assert.equal(url.searchParams.get('happier_hmr'), '0');
  assert.deepEqual(url.searchParams.getAll('happier_hmr'), ['0']);
});

test('borrowers with distinct runtime server and Account URLs receive the same Expo web bundle path', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-borrowed-bundle-' });
  const uiRequire = createRequire(new URL('../../../../ui/package.json', import.meta.url));
  const sdkVersion = `${uiRequire('expo/package.json').version.split('.')[0]}.0.0`;
  await writeFile(fixture.path('package.json'), JSON.stringify({ name: 'borrowed-ui', main: 'index.js' }));
  await writeFile(fixture.path('app.json'), JSON.stringify({ expo: { name: 'Borrowed UI', slug: 'borrowed-ui', sdkVersion, platforms: ['web'] } }));
  await writeFile(fixture.path('index.js'), 'export {};');
  const { ManifestMiddleware } = uiRequire('@expo/cli/build/src/start/server/middleware/ManifestMiddleware.js');
  // Only the HTTP request/response boundary is substituted; Expo's real HTML
  // and bundle URL producers run without starting another Metro.
  const middleware = new ManifestMiddleware(fixture.root, { mode: 'development', minify: false });
  const bundlePaths = [];
  for (const [host, port, account] of [['happier-qa-a.localhost', 3001, 'a'], ['happier-qa-b.localhost', 3002, 'b']]) {
    const pageUrl = new URL(buildBorrowedExpoUiUrl({ consumerHost: host, expoPort: 19364, serverPort: port }));
    pageUrl.searchParams.set('serverId', `account-${account}`);
    pageUrl.searchParams.set('returnUrl', `http://${host}:${port}/account/${account}`);
    assert.equal(pageUrl.searchParams.get('server'), `http://${host}:${port}`);
    let html;
    const handled = await middleware.checkBrowserRequestAsync(
      { url: pageUrl.pathname + pageUrl.search, headers: { host: pageUrl.host, accept: 'text/html' } },
      { setHeader() {}, end(value) { html = value; } },
      () => assert.fail('Expo must serve the borrower page'),
    );
    assert.equal(handled, true);
    const src = html.match(/<script[^>]+src="([^"]+\.bundle[^\"]*)"/)[1].replaceAll('&amp;', '&');
    bundlePaths.push(src);
    const bundle = new URL(src, pageUrl);
    assert.equal(bundle.searchParams.get('platform'), 'web');
    for (const key of ['server', 'serverId', 'returnUrl', 'happier_hmr']) assert.equal(bundle.searchParams.has(key), false);
    assert.equal(src.includes(host), false);
  }
  assert.equal(bundlePaths[0], bundlePaths[1], 'borrowers share one producer bundle identity');
});

test('borrowed Expo projects a verified running remote tunnel as a borrowed consumer endpoint', async (t) => {
  const { projected, probedPorts, port } = await resolveRemoteBorrowedExpoForTest(t, {
    metroRunning: true,
  });

  assert.deepEqual(projected, {
    producerStackName: 'repo-happier-producer',
    ownership: 'borrowed',
    running: true,
    status: 'running',
    port,
    mobilePort: port,
    devClientEnabled: true,
    source: 'remote_target',
    remoteTarget: 'mac',
    runtimeStartedAt: '2026-09-20T08:00:00.000Z',
  });
  assert.deepEqual(probedPorts, [port]);
});

test('borrowed Expo discovers endpoint recovery without restarting its producer or consumer', async (t) => {
  const { projected, probedPorts, port, setReachable, refresh } = await resolveRemoteBorrowedExpoForTest(t, {
    metroRunning: false,
  });

  assert.deepEqual(projected, {
    producerStackName: 'repo-happier-producer',
    ownership: 'borrowed',
    running: false,
    status: 'degraded',
    port,
    mobilePort: port,
    devClientEnabled: true,
    source: 'remote_target',
    remoteTarget: 'mac',
    runtimeStartedAt: '2026-09-20T08:00:00.000Z',
  });
  assert.ok(probedPorts.length > 0 && probedPorts.every(value => value === port));
  setReachable(true);
  const recovered = await refresh();
  assert.equal(recovered.running, true);
  assert.equal(recovered.port, port);
  assert.equal(recovered.runtimeStartedAt, projected.runtimeStartedAt);
});

test('borrowed Expo remains degraded after an owner process exit instead of claiming local fallback', () => {
  const projected = projectBorrowedExpoRuntime({
    producerStackName: 'repo-happier-producer',
    runtimeState: {
      expo: { webPort: null, mobilePort: null, devClientEnabled: true },
      placement: { expo: 'mac' },
      remoteTargets: { mac: { status: 'running', services: { expo: false } } },
      processes: { expoPid: null },
    },
    localEndpoint: null,
  });

  assert.equal(projected.ownership, 'borrowed');
  assert.equal(projected.running, false);
  assert.equal(projected.status, 'degraded');
  assert.equal(projected.source, 'remote_target');
  assert.equal(projected.remoteTarget, 'mac');
});

test('borrowed Expo log path follows the producer lifecycle owner', () => {
  assert.equal(
    resolveBorrowedExpoLogPath({ producerStackBaseDir: '/stacks/producer', remoteTarget: null }),
    '/stacks/producer/logs/expo.log',
  );
  assert.equal(
    resolveBorrowedExpoLogPath({ producerStackBaseDir: '/stacks/producer', remoteTarget: 'Second Mac' }),
    '/stacks/producer/logs/remote-second-mac.log',
  );
});
