// GitHub native detail reads and typed provider failures through registered Actions.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import githubPackage from '../../../plugins/scm-github/package.json';
import { PLUGIN_MANIFEST as githubManifest } from '../../../plugins/scm-github/src/manifest';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_ACCOUNT_SCOPE_V1, GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_ISSUE_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE, GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-entry-detail-github' });
const testDir = run.testDir(randomUUID());
const homeDir = join(testDir, 'daemon-home');
const githubAccountPlugin = { packageName: githubPackage.name, manifest: githubManifest, activate: activateGithub };
const source = {
  v: 1 as const,
  instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: randomUUID() },
  binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native' as const,
    service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' } },
  localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1,
  configuration: { v: 1 as const, token: encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1)! },
  locator: { v: 1 as const, displayLabel: 'octo-org/example-app' },
} satisfies TriageConfiguredSourceInstanceV1;
const pullRequestRef = { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1284' };
const issueRef = { kindId: 'issue', collisionScope: 'github:8815', entryId: '7' };

let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let mode: 'good' | 'rate-limit' | 'forbidden' | 'missing' | 'unidentified' | 'malformed' = 'good';
let accountSecret: Uint8Array;
let machineId: string;

afterAll(async () => {
  for (const close of [() => client?.close(), () => daemon?.stop(), () => server?.stop(), () => github?.stop()]) await close();
});

beforeAll(async () => {
  github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com', 'github.com'],
    responseForRequest(request) {
      const path = new URL(request.path, 'https://api.github.com').pathname;
      if (path === '/user') return { statusCode: 200, headers: { 'x-oauth-scopes': 'repo' }, body: { login: 'detail-fixture', id: 72, name: 'Detail fixture' } };
      if (path === '/') return { statusCode: 200, body: { current_user_url: 'https://api.github.com/user' } };
      if (mode === 'rate-limit') return { statusCode: 429, headers: { 'retry-after': '30' }, body: { message: 'API rate limit exceeded' } };
      if (mode === 'forbidden') return { statusCode: 403, body: { message: 'Resource not accessible' } };
      if (mode === 'missing') return { statusCode: 404, body: { message: 'Not Found' } };
      if (mode === 'unidentified') return { statusCode: 200, body: { unexpected: true } };
      if (mode === 'malformed') return { statusCode: 200, body: null, rawBody: '{"unexpected":' };
      if (path === '/repos/octo-org/example-app') return { statusCode: 200, body: GITHUB_REPOSITORY_RESPONSE };
      if (path === '/repos/octo-org/example-app/pulls/1284') return { statusCode: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
      if (path === '/repos/octo-org/example-app/issues/1284/timeline') return { statusCode: 200, body: [{ id: 1, event: 'labeled', actor: { login: 'octocat' }, created_at: '2026-08-12T18:00:00Z', label: { name: 'review' } }] };
      if (path === '/repos/octo-org/example-app/pulls/1284/files') return { statusCode: 200, body: [{ sha: GITHUB_PULL_REQUEST_RESPONSE.head.sha, filename: 'src/framePump.ts', status: 'modified', additions: 4, deletions: 1, changes: 5, blob_url: 'https://github.com/octo-org/example-app/blob/main/src/framePump.ts', raw_url: 'https://github.com/octo-org/example-app/raw/main/src/framePump.ts', contents_url: 'https://api.github.com/repos/octo-org/example-app/contents/src/framePump.ts', patch: '@@ -1 +1 @@' }] };
      if (path === '/repos/octo-org/example-tools') return { statusCode: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE };
      if (path === '/repos/octo-org/example-tools/issues/7') return { statusCode: 200, body: GITHUB_ISSUE_RESPONSE };
      if (path === '/repos/octo-org/example-tools/issues/7/timeline') return { statusCode: 200, body: [] };
      if (path === '/graphql') return { statusCode: 200, body: { data: {
        viewer: { login: 'detail-fixture' },
        repository: { databaseId: GITHUB_REPOSITORY_RESPONSE.id, pullRequest: {
          id: GITHUB_PULL_REQUEST_RESPONSE.node_id, headRefOid: GITHUB_PULL_REQUEST_RESPONSE.head.sha,
          reviewDecision: null, mergeStateStatus: 'CLEAN', mergeQueueEntry: null,
          viewerCanMergeAsAdmin: false, viewerCanUpdate: true, viewerCanEnableAutoMerge: false, viewerCanDisableAutoMerge: false,
          reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
          reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
          reviewThreads: { nodes: [], pageInfo: { hasPreviousPage: false } },
          commits: { nodes: [{ commit: { oid: GITHUB_PULL_REQUEST_RESPONSE.head.sha, statusCheckRollup: null } }] },
        } },
      } } };
      return { statusCode: 404, body: { message: 'Not Found' } };
    } });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
  const auth = await createTestAuth(server.baseUrl);
  accountSecret = auth.accountSigningSeed;
  machineId = (await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' })).machineId;
  const env = { ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(), 'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`, HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath, GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: 'constructed-detail-token', GITHUB_TOKEN: '', HTTPS_PROXY: github.url, https_proxy: github.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SSL_CERT_FILE: github.caCertPath };
  daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env, requireMachineControlReady: true });
}, 0);

beforeEach(() => { mode = 'good'; });

it('reads PR overview, files and timeline, handles issue sibling and typed refresh failures', async ({ signal }) => {
  client = await connectUiTriageActionClient({ serverUrl: server!.baseUrl, accountSecret,
    additionalPlugins: [githubAccountPlugin] });
  await waitFor(() => client!.isAccountReady() && client!.isMachineControlReady(machineId), {
    timeoutMs: 60_000, context: `GitHub detail Account and Machine ${machineId} readiness`,
  });
  await client.waitForPluginAccountAvailability();
  const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: client!.serverId, defaultSessionMachineId: machineId, signal } as const;
  const invoke = async (localId: string, input: unknown) => {
    // The public Account Action selects native credentials and forwards to its
    // plugin-only daemon leaf. That leaf is not a UI invocation entry point.
    const result = await client!.execute('action.invoke', { action: { pluginId: GITHUB_PLUGIN_ID, localId }, input }, context);
    expect(result, JSON.stringify({ mode, localId, result, providerRequests: github!.entries().map(({ method, path }) => ({ method, path })) }))
      .toMatchObject({ ok: true });
    return result;
  };
  const base = { v: 1, instance: source, localRef: pullRequestRef, routingToken: 'octo-org/example-app' };
  const good = await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, base);
  expect(good, JSON.stringify(good)).toMatchObject({ ok: true, result: { kind: 'overview', kindId: 'pull-request', title: 'Stream terminal frames without a full re-render' } });
  expect(github!.entries().some(request => request.path === '/repos/octo-org/example-app/pulls/1284')).toBe(true);
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles, { ...base, limit: 20 })).toMatchObject({ ok: true, result: { kind: 'changedFiles', rows: [expect.objectContaining({ path: 'src/framePump.ts' })] } });
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline, { ...base, limit: 20 })).toMatchObject({ ok: true, result: { kind: 'timeline', rows: [expect.any(Object)] } });
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, { ...base, localRef: issueRef, routingToken: 'octo-org/example-tools' })).toMatchObject({ ok: true, result: { kind: 'overview', kindId: 'issue' } });
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles, { ...base, localRef: issueRef, routingToken: 'octo-org/example-tools', limit: 20 })).toMatchObject({ ok: true, result: { kind: 'unavailable', failure: { class: 'unsupportedContract' } } });
  mode = 'rate-limit';
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, base)).toMatchObject({ ok: true, result: { kind: 'unavailable', failure: { class: 'rateLimit' } } });
  mode = 'forbidden';
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, base)).toMatchObject({ ok: true, result: { kind: 'unavailable', failure: { class: 'permission' } } });
  mode = 'missing';
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, base)).toMatchObject({ ok: true, result: { kind: 'unavailable' } });
  mode = 'unidentified';
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, base)).toMatchObject({ ok: true, result: {
    kind: 'unavailable', failure: { class: 'unknown', code: 'route-body-mismatch' },
  } });
  mode = 'malformed';
  expect(await invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, base)).toMatchObject({ ok: true, result: {
    kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_api_response_invalid' },
  } });
});
