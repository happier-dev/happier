import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { GITHUB_PLUGIN_ID } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-runtime-faults' });
const testDir = run.testDir(randomUUID());
const homeDir = join(testDir, 'daemon-home');
let env: NodeJS.ProcessEnv;
let machineId: string;
let accountSecret: Uint8Array;
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let client: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let mode: 'good' | 'malformed' | 401 | 403 | 429 | 503 = 'good';
afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => client?.close(), () => daemon?.stop(), () => server?.stop(), () => github?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Cancellation journey cleanup failed');
});

beforeAll(async () => {
  github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com', 'github.com'],
    async responseForRequest(request) {
      if (request.path === '/user') {
        if (typeof mode === 'number') return { statusCode: mode,
          headers: mode === 429 ? { 'retry-after': '30' } : {},
          body: { message: 'Constructed provider failure' } };
        if (mode === 'malformed') return { statusCode: 200, body: { unexpected: true } };
        return { statusCode: 200, headers: { 'x-oauth-scopes': 'repo, read:org, gist' },
          body: { login: 'triage-cancel-fixture', name: 'Cancellation fixture',
          id: 1116, html_url: 'https://github.com/triage-cancel-fixture' } };
      }
      if (request.path === '/') return { statusCode: 200, headers: { 'x-oauth-scopes': 'repo, read:org, gist' },
        body: { current_user_url: 'https://api.github.com/user' } };
      if (request.path === '/graphql') return { statusCode: 200, headers: { 'x-oauth-scopes': 'repo, read:org, gist' },
        body: { data: { viewer: { login: 'triage-cancel-fixture' } } } };
      return { statusCode: 404, body: { message: 'Not Found' } };
    } });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
  const auth = await createTestAuth(server.baseUrl);
  const seeded = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
  machineId = seeded.machineId;
  accountSecret = auth.accountSigningSeed;
  env = { ...sanitizeCliTestEnv(process.env), CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(),
      'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`,
    HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath,
    GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: 'constructed-triage-cancellation-token', GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '', HTTPS_PROXY: github.url, https_proxy: github.url,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SSL_CERT_FILE: github.caCertPath,
  };
});

beforeAll(async () => {
  daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env, requireMachineControlReady: true });
  client = await connectUiPersonActionClient({ serverUrl: server!.baseUrl, accountSecret,
    withAppShellActions: false, withCurrentUiActionPort: false, withAccountLifecycle: false });
  await waitFor(() => client!.isMachineControlReady(machineId), { timeoutMs: 60_000 });
});

beforeEach(() => { mode = 'good'; });

async function discoveryJourney() {
  if (!server) throw new Error('Fault journey runtime unavailable');
  const args = ['actions', 'invoke', formatQualifiedPluginActionId({ pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }), '--input-json', JSON.stringify({ v: 1 }),
    '--machine-id', machineId, '--json'];
  const launch = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir: join(testDir, 'cli-dist'),
    preferSourceEntrypoint: true, skipSourceFreshnessCheck: true });
  return () => runCliJson({ testDir, cliHomeDir: homeDir, serverUrl: server!.baseUrl,
    webappUrl: server!.baseUrl, env, label: `discovery-${mode}`, args, cliLaunchSpec: launch,
    acceptedExitCodes: [0, 1] });
}

const healthy = { ok: true, data: { kind: 'complete', candidates: [expect.objectContaining({
  locator: expect.objectContaining({ displayLabel: 'Cancellation fixture' }),
})], failures: [] } };
it.each([401, 403, 429, 503, 'malformed'] as const)('reports provider fault %s without empty success and recovers', async (failure) => {
  const discover = await discoveryJourney();
  // The known-good path is the control for every refusal on this same native binding.
  const control = await discover();
  expect(control, JSON.stringify(control)).toMatchObject(healthy);
  mode = failure;
  const result = await discover();
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: {
    kind: 'complete', candidates: [], failures: [expect.objectContaining({ failure: expect.objectContaining({
      class: failure === 401 ? 'authentication' : failure === 403 ? 'permission'
        : failure === 429 ? 'rateLimit' : failure === 503 ? 'transient' : 'unsupportedContract',
    }) })],
  } });
  mode = 'good';
  expect(await discover()).toMatchObject(healthy);
});

it('reports an offline Machine and recovers after restarting its daemon', async () => {
  if (!client) throw new Error('Fault journey client unavailable');
  const discover = await discoveryJourney();
  expect(await discover()).toMatchObject(healthy);
  await daemon!.stop();
  await waitFor(() => !client!.isMachineControlReady(machineId), { timeoutMs: 60_000 });
  const offline = await discover();
  // The Machine admission owner supplies the unavailable cause before a source
  // is invoked; its outer transport code does not classify provider health.
  expect(offline, JSON.stringify(offline)).toMatchObject({ ok: false, error: {
    failureCause: { phase: 'rpc.admission.machine', errorCode: 'machine_unavailable' },
  } });
  daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env, requireMachineControlReady: true });
  await waitFor(() => client!.isMachineControlReady(machineId), { timeoutMs: 60_000 });
  expect(await discover()).toMatchObject(healthy);
});
