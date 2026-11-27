import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Page } from '@playwright/test';

import { repoRootDir } from '../paths';
import { startUiWeb, type StartedUiWeb } from '../process/uiWeb';
import { ensureUiWebWorkspacePrebuild } from '../process/uiWebWorkspacePrebuild';
import { approveTerminalConnect } from './approveTerminalConnect';
import { buildCredentialsAuthBootstrapStorageSnapshot } from './buildAuthBootstrapStorageSnapshot';
import type { WorkbenchFixtureReply, WorkbenchFixtureRequest } from './databaseWorkbenchFixtureProcess';
import { installAuthBootstrapStorageSnapshot } from './readLegacyAuthSecretFromLocalStorage';

export async function startDatabaseWorkbenchBrowser(params: Readonly<{
  page: Page;
  testDir: string;
  storageScope: string;
}>) {
  const { page, testDir, storageScope } = params;
  const repoRoot = repoRootDir();
  // Finish workspace preparation before the CLI issues its expiring link.
  const uiEnv = await ensureUiWebWorkspacePrebuild({ testDir, env: process.env,
    workspaceRootDir: join(repoRoot, 'apps/ui'), logPrefix: 'dbw-browser',
    stdoutPath: join(testDir, 'ui.web.stdout.log'), stderrPath: join(testDir, 'ui.web.stderr.log'),
  });
  const packageDir = join(repoRoot, 'packages/tests');
  const requireTests = createRequire(join(packageDir, 'package.json'));
  const vitest = join(dirname(requireTests.resolve('vitest/package.json')), 'vitest.mjs');
  const pipeDir = await mkdtemp(join(tmpdir(), 'dbw-'));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(pipeDir)}` : join(pipeDir, 'fixture.sock');
  const listener = createServer();
  const accepted = once(listener, 'connection') as Promise<[Socket]>;
  listener.listen(pipe);
  try {
    await once(listener, 'listening');
  } catch (error) {
    // Both events observe a listen error. Consume the unused connection result.
    await accepted.catch(() => {});
    await rmdir(pipeDir);
    throw error;
  }
  const child = spawn(process.execPath, [vitest, 'run', '--config', 'vitest.core.config.ts', '--maxWorkers=1',
    'src/testkit/uiE2e/databaseWorkbenchFixtureProcess.test.ts'], {
    cwd: packageDir, stdio: 'inherit', env: { ...process.env, HAPPIER_DBW_BROWSER_FIXTURE_PIPE: pipe },
  });
  const exit = once(child, 'exit');
  void exit.catch(() => {}); // The command or stop reports the process error.
  let ui: StartedUiWeb | undefined;
  let socket: Socket | undefined;
  async function stop() {
    try {
      socket?.end();
      listener.close();
      const [code, signal] = await exit;
      if (code !== 0) throw new Error(`DBW fixture process exited (${signal ?? code})`);
    } finally {
      socket?.destroy();
      try {
        await rmdir(pipeDir);
      } finally {
        await ui?.stop();
      }
    }
  }

  try {
    const [connection] = await Promise.race([accepted, exit.then(([code, signal]) => {
      throw new Error(`DBW fixture process exited before connecting (${signal ?? code})`);
    })]);
    socket = connection;
    listener.close();
    const messages = createInterface({ input: connection, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const send = (request: WorkbenchFixtureRequest) => new Promise<void>((resolve, reject) => {
      connection.write(`${JSON.stringify(request)}\n`, error => error ? reject(error) : resolve());
    });
    async function receive<K extends WorkbenchFixtureReply['kind']>(kind: K) {
      const message = await messages.next();
      if (message.done) throw new Error(`DBW fixture process closed while waiting for ${kind}`);
      const reply: WorkbenchFixtureReply = JSON.parse(message.value);
      if (reply.kind === 'failed') throw new Error(reply.error);
      if (reply.kind !== kind) throw new Error(`DBW fixture sent ${reply.kind} while waiting for ${kind}`);
      return reply as Extract<WorkbenchFixtureReply, { kind: K }>;
    }
    await send({ kind: 'start', testDir });
    const { options } = await receive('pair');
    ui = await startUiWeb({ testDir: join(testDir, 'ui'), skipWorkspacePrebuild: true, env: {
      ...uiEnv, HAPPIER_E2E_UI_WEB_MODE: 'metro',
      EXPO_PUBLIC_HAPPY_SERVER_URL: options.canonicalServerUrl,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
    } });
    await installAuthBootstrapStorageSnapshot(page, buildCredentialsAuthBootstrapStorageSnapshot({
      serverUrl: options.canonicalServerUrl, serverIdentityId: options.homeServerIdentityId,
      credentials: options.credentials, storageScope,
    }));
    const link = new URL(options.connectUrl);
    await page.goto(new URL(`${link.pathname}${link.search}${link.hash}`, ui.baseUrl).href, { waitUntil: 'domcontentloaded' });
    await approveTerminalConnect({ page });
    await send({ kind: 'approved' });
    const { scope, runtime } = await receive('ready');
    const services = new URL(`/projects/${encodeURIComponent(scope.workspace.workspaceId)}/services`, ui.baseUrl);
    services.searchParams.set('serverId', scope.workspace.serverId);
    services.searchParams.set('happier_hmr', '0');
    return { ui, runtime, stop,
      async openDatabase(label: string) {
        await page.goto(services.href, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('project-services-screen').getByTestId('project-services-page')
          .getByText(label, { exact: true }).filter({ visible: true }).click({ timeout: 40_000 });
      },
      async connectDatabase(label: string) {
        await send({ kind: 'connect', label });
        await receive('connected');
      },
      async sql(database: string, input: string) {
        await send({ kind: 'sql', database, input });
        return (await receive('sql')).output;
      },
    };
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'DBW browser fixture startup and cleanup failed');
    }
    throw error;
  }
}
