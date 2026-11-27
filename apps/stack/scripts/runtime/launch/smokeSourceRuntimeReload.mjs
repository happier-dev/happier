import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runQaBrowserSession, runQaBrowserWorker } from '../../utils/dev_targets/qa_browser.mjs';
import { resolveControlledQaBrowserTarget } from '../../utils/dev_targets/service_placement.mjs';
import { pickNextFreeTcpPort } from '../../utils/net/ports.mjs';
import { killProcessTree } from '../../utils/proc/proc.mjs';
import { buildServerRuntimeEnv } from '../../utils/server/server_env.mjs';
import { applyServerLightEnvDefaults } from '../../utils/server/apply_server_light_env_defaults.mjs';
import { applyRuntimeServerDatabaseEnv, applySharedDatabaseSourceEnv } from '../../utils/server/apply_runtime_server_database_env.mjs';
import { fetchHappierHealth, waitForServerReady } from '../../utils/server/server.mjs';
import { resolveServerRuntimeLaunchSpec } from './resolveServerRuntimeLaunchSpec.mjs';
import { spawnRuntimeServerAfterMigration } from './runServerRuntimeMigration.mjs';
import { assertWebArtifactPayload } from '../shared/web_payload.mjs';
import { diagnoseSourceReloadFailure, emitSourceReloadRefusal } from '../shared/source_reload_refusal.mjs';

/** Probe the emitted graph, never the live Stack database, daemon lock or
 * Machine identity. Resource admission belongs to the calling source worker.
 */
export async function smokeSourceRuntimeReload({ components, ui, env = process.env, signal, logger = console }) {
  signal?.throwIfAborted();
  const server = components.server;
  if (!server) {
    if (ui) throw new Error('[reload] a web boot smoke requires its replacement server');
    return;
  }
  // Preparation resolves the provider on the actual server host. A worker's
  // inherited env is not the authority for this admitted replacement graph.
  const dbProvider = server.dbProvider;
  if (dbProvider !== 'sqlite' && dbProvider !== 'pglite' && dbProvider !== 'postgres') {
    throw new Error(`[reload] cannot smoke ${dbProvider} without a separately authorized scratch database; incumbent retained`);
  }
  let phaseStarted = performance.now();
  const finishPhase = phase => {
    const now = performance.now();
    logger.log(`[source-reload] phase=${phase} elapsedMs=${Math.round(now - phaseStarted)}`);
    phaseStarted = now;
  };
  const scratch = await mkdtemp(join(tmpdir(), 'hstack-reload-smoke-'));
  const children = [];
  let database = null;
  const cancellation = new AbortController();
  const cancel = () => {
    cancellation.abort(signal?.reason);
    for (const child of children) void killProcessTree(child, 'SIGTERM').catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let smokeComponent = 'server';
  try {
    // Resolve the real launch's existing secret before dropping shared-source
    // references. Carry only that credential into the scratch storage layout.
    const runtimeEnv = { ...env, ...server.env };
    applySharedDatabaseSourceEnv({ env: runtimeEnv });
    const isolated = { ...env, ...server.env, HAPPIER_SERVER_HOST: '127.0.0.1',
      HAPPIER_HOME_DIR: scratch, HAPPIER_STACK_CLI_HOME_DIR: join(scratch, 'cli'),
      HAPPIER_SERVER_LIGHT_DATA_DIR: join(scratch, 'server-light'),
      HAPPIER_SERVER_LIGHT_FILES_DIR: join(scratch, 'files'),
      HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(scratch, 'private-files'),
      HAPPIER_SERVER_LIGHT_DB_DIR: join(scratch, 'pglite'),
      HAPPIER_DB_PROVIDER: dbProvider, DATABASE_URL: '', HANDY_MASTER_SECRET: runtimeEnv.HANDY_MASTER_SECRET,
      HAPPIER_SQLITE_AUTO_MIGRATE: '1', HAPPY_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_STACK_SHARED_DB_SOURCE_STACK: '', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: '',
      HAPPIER_STACK_MIGRATE_MODE: '', HAPPIER_STACK_LOG_TEE_DIR: '', METRICS_ENABLED: 'false' };
    // Legacy aliases must not repoint a scratch smoke to retained directories.
    for (const key of ['HAPPY_SERVER_LIGHT_DATA_DIR', 'HAPPY_SERVER_LIGHT_FILES_DIR',
      'HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR', 'HAPPY_SERVER_LIGHT_DB_DIR', 'HAPPY_SQLITE_MIGRATIONS_DIR']) delete isolated[key];
    if (dbProvider === 'postgres') {
      // The Stack's (often shared) DATABASE_URL stays forbidden. A scratch
      // PostgreSQL wire endpoint lets the replacement run its real driver,
      // migrations and boot before retirement, like the other flavours.
      database = await startScratchPostgres({ dir: join(scratch, 'postgres') });
      isolated.DATABASE_URL = database.url;
    }
    finishPhase('smoke-db-setup');
    const { url, processChild } = await startSmokeServer({ server, ui, env, isolated, scratch, children,
      signal: cancellation.signal, finishPhase });
    const health = await fetchHappierHealth(url, { signal: cancellation.signal });
    finishPhase('smoke-health');
    if (!health.ok) throw new Error('[reload] replacement server did not expose canonical /health');
    if (ui) {
      smokeComponent = 'ui';
      await assertWebArtifactPayload({ payloadDir: ui.uiDir, entrypoint: ui.entrypoint ?? 'index.html' });
      await smokeSourceWebBoot({ repoDir: env.HAPPIER_STACK_REPO_DIR, url, env: {
        ...isolated, HAPPIER_CANONICAL_SERVER_URL: url, HAPPIER_PUBLIC_SERVER_URL: url,
      }, signal: cancellation.signal });
      finishPhase('smoke-web-boot');
    }
    if (processChild.exitCode != null || processChild.signalCode != null) throw new Error('[reload] smoke server exited before admission');
  } catch (error) {
    await diagnoseSourceReloadFailure(error, { component: smokeComponent,
      repoDir: env.HAPPIER_STACK_REPO_DIR, env, signal });
    throw error;
  } finally {
    phaseStarted = performance.now();
    signal?.removeEventListener('abort', cancel);
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) await killProcessTree(child, 'SIGTERM');
    }
    // Its server is gone: release the scratch PostgreSQL before its directory.
    await database?.stop();
    await rm(scratch, { recursive: true, force: true });
    finishPhase('smoke-cleanup');
  }
}

async function startSmokeServer({ server, ui, env, isolated, scratch, children, signal, finishPhase }) {
  const spec = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch: server });
  const timeout = Number(env.HAPPIER_STACK_SERVER_READY_TIMEOUT_MS);
  let nextPort = 40_000;
  for (;;) {
    signal.throwIfAborted();
    const port = await pickNextFreeTcpPort(nextPort);
    const url = `http://127.0.0.1:${port}`;
    const serverEnv = buildServerRuntimeEnv({ baseEnv: isolated, serverPort: port,
      canonicalServerUrl: url, publicServerUrl: url, serveUi: Boolean(ui), uiRequired: Boolean(ui),
      uiBuildDir: ui?.uiDir ?? '', uiBuildDirExists: Boolean(ui), uiPrefix: '/', development: true });
    applyServerLightEnvDefaults({ baseEnv: isolated, serverEnv, baseDir: scratch });
    applyRuntimeServerDatabaseEnv({ env: serverEnv, serverDir: server.serverDir });
    // Health alone could come from the reload that won the bind. Enable the
    // candidate's own API-ready log before opening the HTTP probe.
    serverEnv.HAPPIER_SERVER_LOG_LEVEL = 'info';
    let bound = false;
    let portInUse = false;
    const processChild = await spawnRuntimeServerAfterMigration({ serverLaunchSpec: spec, env: serverEnv, children,
      isCancellationRequested: () => signal.aborted,
      onMigrationSettled: () => finishPhase('smoke-migration'),
      onServerLine({ stream, line }) {
        if (stream === 'stdout' && line.includes(`API ready on port http://localhost:${port}`)) bound = true;
        if (stream === 'stderr' && line.endsWith(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`)) portInUse = true;
      },
    });
    try {
      await waitForServerReady(url, { childProcess: processChild, signal, canProbe: () => bound,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : Infinity, continueWhileChildAlive: false });
      return { url, processChild };
    } catch (error) {
      if (processChild.exitCode == null) throw error;
      await processChild.completion;
      if (signal.aborted || bound || !portInUse) throw error;
      nextPort = port + 1;
    } finally {
      finishPhase('smoke-server-ready');
    }
  }
}

/** PGlite served over the PostgreSQL protocol by the server's own framed socket
 * owner (the light server's PGlite mode uses the same pair). Tooling-side: the
 * scratch database is smoke infrastructure, not part of the replacement graph. */
async function startScratchPostgres({ dir }) {
  const serverPackage = new URL('../../../../server/package.json', import.meta.url);
  const { PGlite } = await import(pathToFileURL(createRequire(serverPackage).resolve('@electric-sql/pglite')).href);
  const { FramedPgliteSocketServer } = await import(new URL('../../../../server/sources/storage/pgliteFramedSocketServer.mjs', import.meta.url).href);
  const db = new PGlite(dir);
  await db.waitReady;
  const socket = new FramedPgliteSocketServer({ db, host: '127.0.0.1', port: 0 });
  try { await socket.start(); } catch (error) { await db.close(); throw error; }
  let stopped = false;
  return {
    // pglite is single-connection; the socket server returns host:port only.
    url: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable&connection_limit=1`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await socket.stop();
      await db.close();
    },
  };
}

/** With `observeApiOrigin`, also returns the origin the loaded QA URL names for its server (its `server` parameter,
 * else the page's own origin) and the origins of the page's API requests up to its first one. */
export async function smokeSourceWebBoot({ repoDir, url, stackName, env = process.env, signal, observeApiOrigin = false }) {
  // The source checkout's browser test tooling owns Playwright. Chromium
  // launch policy/profile cleanup remain with the existing QA browser owner.
  const { chromium } = createRequire(join(repoDir, 'packages/tests/package.json'))('@playwright/test');
  const input = new PassThrough();
  const signalSource = new EventEmitter();
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const controlled = stackName ? await resolveControlledQaBrowserTarget({ stackName, sourceDir: repoDir, env }) : null;
  const sessionName = `reload-${process.pid}`;
  const worker = controlled
    ? runQaBrowserSession({ target: controlled.target, stackName,
      stackBaseDir: controlled.authority.producerStackBaseDir, sessionName, url, env, onReady: ready }, { signalSource })
    : runQaBrowserWorker({ sessionName, input, env, writeReady: ready }, { signalSource });
  let browser;
  let context;
  const cancel = () => signalSource.emit('SIGTERM');
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const endpoint = await Promise.race([readyPromise, worker.then(() => { throw new Error('[reload] smoke browser closed before readiness'); })]);
    browser = await chromium.connectOverCDP(endpoint.cdpUrl ?? `http://127.0.0.1:${endpoint.port}`, { timeout: 0 });
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    let rejectBoot;
    const bootError = new Promise((_resolve, reject) => { rejectBoot = reject; });
    // Capture failures from the first script, including errors before goto's
    // load event. Keep rejection observed while navigation is still settling.
    void bootError.catch(() => {});
    page.on('pageerror', error => rejectBoot(new Error(`[reload] UI boot failed: ${error.message}`)));
    page.on('requestfailed', request => {
      if (['script', 'document'].includes(request.resourceType())) {
        rejectBoot(new Error(`[reload] UI boot request failed: ${request.url()}`));
      }
    });
    const apiOrigins = new Set();
    let firstApiRequest;
    const apiRequest = new Promise(resolve => { firstApiRequest = resolve; });
    if (observeApiOrigin) page.on('request', request => {
      const target = new URL(request.url());
      if (!/^\/v\d+\//.test(target.pathname)) return;
      apiOrigins.add(target.origin);
      firstApiRequest();
    });
    const closePage = () => { void page.close().catch(() => {}); };
    signal?.addEventListener('abort', closePage, { once: true });
    try {
      const response = await Promise.race([page.goto(endpoint.url ?? url, { waitUntil: 'load' }), bootError]);
      if (!response?.ok()) throw new Error('[reload] UI root request failed');
      await Promise.race([page.waitForFunction(() => document.scripts.length > 0 && document.body.innerText.trim().length > 0), bootError]);
      await Promise.race([page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }), bootError]);
      // The app's boot reads the server's features; that request names the API origin it uses.
      if (observeApiOrigin) await Promise.race([apiRequest, bootError]);
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener('abort', closePage);
    }
    if (observeApiOrigin) {
      // The URL this smoke navigated to (a controlled browser's endpoint may rewrite it), not the page's later URL.
      const loaded = new URL(endpoint.url ?? url);
      const named = loaded.searchParams.get('server');
      return { expectedApiOrigin: named ? new URL(named).origin : loaded.origin, apiOrigins: [...apiOrigins] };
    }
    return undefined;
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      await context?.close();
      await browser?.close();
    } finally {
      if (controlled) signalSource.emit('SIGTERM');
      else input.write('close\n');
      try { await worker; } finally { input.destroy(); }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('[reload] smoke interrupted'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await smokeSourceRuntimeReload({ ...JSON.parse(process.argv[2]), signal: cancellation.signal });
  } catch (error) {
    emitSourceReloadRefusal(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
