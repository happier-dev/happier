import { fork } from 'node:child_process';
import { on, once } from 'node:events';
import { join } from 'node:path';
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
  const child = fork(join(repoRoot, 'packages/tests/src/testkit/uiE2e/databaseWorkbenchFixtureProcess.ts'), {
    execArgv: ['--conditions=happier-source', '--import', join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs')],
    env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'apps/cli/tsconfig.runtime.json') },
  });
  const messages = on(child, 'message', { close: ['disconnect', 'exit'] });
  const exit = once(child, 'close');
  void exit.catch(() => {}); // The command or stop reports the process error.
  let ui: StartedUiWeb | undefined;

  const send = (request: WorkbenchFixtureRequest) => new Promise<void>((resolve, reject) => {
    child.send(request, error => error ? reject(error) : resolve());
  });
  async function receive<K extends WorkbenchFixtureReply['kind']>(kind: K) {
    const reply: WorkbenchFixtureReply | undefined = (await messages.next()).value?.[0];
    if (!reply) throw new Error(`DBW fixture process closed while waiting for ${kind}`);
    if (reply.kind === 'failed') throw new Error(reply.error);
    if (reply.kind !== kind) throw new Error(`DBW fixture sent ${reply.kind} while waiting for ${kind}`);
    return reply as Extract<WorkbenchFixtureReply, { kind: K }>;
  }
  async function stop() {
    try {
      if (child.connected) child.disconnect();
      const [code, signal] = await exit;
      if (code !== 0) throw new Error(`DBW fixture process exited (${signal ?? code})`);
    } finally {
      await messages.return?.();
      await ui?.stop();
    }
  }

  try {
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
    return { ui, scope, runtime, stop,
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
