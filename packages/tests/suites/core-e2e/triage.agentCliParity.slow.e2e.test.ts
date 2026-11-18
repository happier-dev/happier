// QB-01 QB-04 QB-18 QB-58: one read Action through the UI and a real CLI process.
// The real agent MCP leg lives in triage.platform.declarationsAndConnect.slow.e2e.test.ts.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import {
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageReadActionsResultV1Schema,
} from '../../../plugins/triage/src/actions/actionsCatalogProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'triage-agent-cli-parity' });

describe('Triage Action parity across person and headless surfaces', () => {
  let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
  let accountSecret: Uint8Array;
  let daemonParams: Parameters<typeof startTestDaemon>[0];

  beforeAll(async () => {
    const testDir = run.testDir('account');
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    server = await startServerLight({ testDir, extraEnv: {
      NODE_OPTIONS: sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const auth = await createTestAuth(server.baseUrl);
    accountSecret = auth.accountSigningSeed;
    const homeDir = join(testDir, 'daemon-home');
    await mkdir(homeDir, { recursive: true });
    await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    daemonParams = {
      testDir,
      happyHomeDir: homeDir,
      requireMachineControlReady: true,
      env: {
        ...process.env,
        NODE_OPTIONS: sourceOptions,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
    };
  }, 0);

  beforeAll(async () => {
    daemon = await startTestDaemon(daemonParams);
  }, 0);

  beforeEach(async () => {
    if (!server) throw new Error('Parity server unavailable');
    client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret });
    await waitFor(() => client!.isAccountReady(), { context: 'Triage parity Account readiness' });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => client?.close(), () => daemon?.stop(), () => server?.stop()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Triage parity cleanup failed');
  });

  it('returns the same typed read through the UI and a real CLI invocation', async () => {
    if (!client || !server) throw new Error('Parity Account runtime unavailable');
    const action = {
      pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
      localId: TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    };
    const ui = await client.execute('action.invoke', { action, input: { v: 1 } }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: client.serverId,
    });
    expect(ui, JSON.stringify(ui)).toMatchObject({ ok: true });
    if (!ui.ok) throw new Error(`UI read refused (${ui.errorCode})`);
    const cli = await runCliJson({
      testDir: daemonParams.testDir,
      cliHomeDir: daemonParams.happyHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: server.baseUrl,
      env: daemonParams.env,
      label: 'triage-read-parity',
      args: ['actions', 'invoke', formatQualifiedPluginActionId(action), '--input-json', JSON.stringify({ v: 1 }), '--json'],
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
    });
    expect(cli, JSON.stringify(cli)).toMatchObject({ ok: true, kind: 'actions_invoke' });
    expect(TriageReadActionsResultV1Schema.parse(cli.data)).toEqual(TriageReadActionsResultV1Schema.parse(ui.result));
  });
});
