// QB-65: the person and CLI use the same real Home before a malformed native write is refused.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { GITHUB_PLUGIN_ID } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 } from '../../../plugins/triage/src/actions/actionsCatalogProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { waitFor } from '../../src/testkit/timing';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'triage-native-writes-corridor2' });
const testDir = run.testDir(randomUUID());
const homeDir = join(testDir, 'daemon-home');
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let machineId = '';
let accountSecret: Uint8Array;
let daemonEnv: NodeJS.ProcessEnv;

afterAll(async () => {
  await client?.close();
  await daemon?.stop();
  await server?.stop();
  await github?.stop();
});

beforeAll(async () => {
  github = await startConnectedAccountTlsRecordingProxy({
    additionalDnsNames: ['api.github.com', 'github.com'],
    async responseForRequest(request) {
      if (request.path === '/') return { statusCode: 200, body: { current_user_url: 'https://api.github.com/user' } };
      if (request.path === '/user') return { statusCode: 200, body: { id: 1118, login: 'triage-native-writes-fixture' } };
      return { statusCode: 404, body: { message: 'Not Found' } };
    },
  });
  const sourceRuntime = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, extraEnv: {
    NODE_OPTIONS: sourceRuntime,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
  } });
  const auth = await createTestAuth(server.baseUrl);
  const seeded = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
  machineId = seeded.machineId;
  daemonEnv = {
    ...sanitizeCliTestEnv(process.env), CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    NODE_OPTIONS: `${sourceRuntime} --import ${pathToFileURL(join(repoRootDir(),
      'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`,
    HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath,
    GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: 'constructed-triage-native-writes-token',
    GITHUB_TOKEN: '', HTTPS_PROXY: github.url, https_proxy: github.url,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SSL_CERT_FILE: github.caCertPath,
  };
  daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env: daemonEnv, requireMachineControlReady: true });
  accountSecret = auth.accountSigningSeed;
}, 240_000);

// The shared UI setup clears native storage and profiles before every case.
// Connect after that reset so the Action retains its actual Account.
beforeEach(async () => {
  client = await connectUiTriageActionClient({ serverUrl: server!.baseUrl, accountSecret });
  await waitFor(() => client!.isAccountReady() && client!.isMachineControlReady(machineId), { timeoutMs: 60_000 });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
});

it('QB-65 refuses an invalid native close operand with a typed failure and performs no provider write', async () => {
  const before = github!.entries().length;
  const accountRead = await client!.execute('action.invoke', {
    action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 },
    input: { v: 1 },
  }, { surface: 'ui', authority: 'present_user', serverId: client!.serverId, actionCaller: { kind: 'host' } });
  expect(accountRead, JSON.stringify(accountRead)).toMatchObject({ ok: true });

  const action = formatQualifiedPluginActionId({
    pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueClose,
  });
  const result = await runCliJson({
    testDir, cliHomeDir: homeDir, serverUrl: server!.baseUrl, webappUrl: server!.baseUrl, env: daemonEnv,
    label: 'native-github-close-invalid',
    args: ['actions', 'invoke', action, '--machine-id', machineId, '--input-json', JSON.stringify({ v: 1 }), '--json'],
    acceptedExitCodes: [1],
    launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, kind: 'actions_invoke', error: { code: 'invalid_arguments' } });
  expect(github!.entries().slice(before).filter(request => request.method !== 'GET')).toEqual([]);
});
