import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
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
import { spawnLoggedProcess } from '../../src/testkit/process/spawnProcess';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-runtime-cancel' });
const testDir = run.testDir(randomUUID());
const homeDir = join(testDir, 'daemon-home');
let env: NodeJS.ProcessEnv;
let machineId: string;
let accountSecret: Uint8Array;
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let caller: ReturnType<typeof spawnLoggedProcess> | undefined;
const held = Promise.withResolvers<void>();
const requestSeen = Promise.withResolvers<void>();
let released = false;

afterAll(async () => {
  held.resolve();
  const failures: unknown[] = [];
  for (const close of [() => caller?.stop(), () => client?.close(), () => daemon?.stop(), () => server?.stop(), () => github?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Cancellation journey cleanup failed');
});

beforeAll(async () => {
  github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com', 'github.com'],
    async responseForRequest(request) {
      if (request.path === '/user') {
        requestSeen.resolve();
        await held.promise;
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
});

beforeEach(async () => {
  client = await connectUiTriageActionClient({ serverUrl: server!.baseUrl, accountSecret });
  await waitFor(() => client!.isMachineControlReady(machineId), { timeoutMs: 60_000 });
});

// Node's Windows kill('SIGINT') forcibly terminates the child rather than
// delivering an interrupt to its handler. Native Windows console cancellation
// remains a release check; this journey exercises POSIX signal delivery.
it.skipIf(process.platform === 'win32')('exits the cancelled CLI while the real Machine read still waits for GitHub and allows a fresh read afterward', async () => {
  // With no Account binding, this public read delegates to its declared native
  // Machine Action. The real gh login materializer sees only the synthetic token.
  const args = ['actions', 'invoke', formatQualifiedPluginActionId({ pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }), '--input-json', JSON.stringify({ v: 1 }),
    '--machine-id', machineId, '--json'];
  const launch = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir: join(testDir, 'cli-dist'),
    preferSourceEntrypoint: true, skipSourceFreshnessCheck: true });
  const stdoutPath = join(testDir, 'cancelled-cli.stdout.log');
  const stderrPath = join(testDir, 'cancelled-cli.stderr.log');
  caller = spawnLoggedProcess({ command: launch.command, args: [...launch.args, ...args],
    cwd: launch.cwd ?? repoRootDir(), env: { ...env, ...launch.env }, stdoutPath, stderrPath });
  // The test's existing lifecycle budget owns source startup plus provider
  // admission; the external request itself signals readiness without a shorter cutoff.
  await requestSeen.promise;
  expect(caller.child.exitCode).toBeNull();
  expect(caller.child.kill('SIGINT')).toBe(true);
  // The assertion is process exit, not merely a cancellation message. The
  // provider response remains unresolved until after this boundary is proven.
  await waitFor(() => caller!.child.exitCode !== null, { timeoutMs: 60_000 });
  expect(caller.child.exitCode).toBe(1);
  expect(caller.child.signalCode).toBeNull();
  expect(released).toBe(false);
  const lines = (await readFile(stdoutPath, 'utf8')).trim().split('\n');
  const result: unknown = JSON.parse(lines.at(-1)!);
  expect(result).toMatchObject({ ok: false, error: { code: 'cancelled', details: { outcome: 'unknown' } } });
  released = true;
  held.resolve();
  const retried = await runCliJson({ testDir, cliHomeDir: homeDir, serverUrl: server!.baseUrl, webappUrl: server!.baseUrl,
    env, label: 'fresh-read', args, cliLaunchSpec: launch });
  expect(retried).toMatchObject({ ok: true, data: { kind: 'complete', candidates: [expect.objectContaining({
    locator: expect.objectContaining({ displayLabel: 'Cancellation fixture' }),
  })] } });
});
