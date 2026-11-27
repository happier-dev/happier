// GitHub native detail reads and typed provider failures through registered Actions.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { reviewReviewersForEngineIdsV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { readReviewStartActionResultV1 } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import githubPackage from '../../../plugins/scm-github/package.json';
import { PLUGIN_MANIFEST as githubManifest } from '../../../plugins/scm-github/src/manifest';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1, GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_ACCOUNT_SCOPE_V1, GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import {
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TriageSourceAdministrationActionResultV1Schema, type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema,
} from '../../../plugins/triage/src/actions/entryDetailProtocol';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryResultV1Schema } from '../../../plugins/triage/src/actions/reobserveEntryProtocol';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionResultV1Schema } from '../../../plugins/triage/src/actions/resolveResourceProtocol';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { GITHUB_ISSUE_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE, GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy, type ConnectedAccountTlsResponse } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-entry-detail-github' });
const testDir = run.testDir(randomUUID());
const homeDir = join(testDir, 'daemon-home');
const githubAccountPlugin = { packageName: githubPackage.name, manifest: githubManifest, activate: activateGithub };
const source = {
  v: 1 as const,
  instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 }, sourceInstanceId: randomUUID() },
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
    responseForRequest(request): ConnectedAccountTlsResponse {
      const path = new URL(request.path, 'https://api.github.com').pathname;
      if (path === '/user') return { statusCode: 200, headers: { 'x-oauth-scopes': 'repo' }, body: { login: 'detail-fixture', id: 72, name: 'Detail fixture' } };
      if (path === '/') return { statusCode: 200, body: { current_user_url: 'https://api.github.com/user' } };
      if (mode === 'rate-limit') return { statusCode: 429, headers: { 'retry-after': '30' }, body: { message: 'API rate limit exceeded' } };
      if (mode === 'forbidden') return { statusCode: 403, body: { message: 'Resource not accessible' } };
      if (mode === 'missing') return { statusCode: 404, body: { message: 'Not Found' } };
      if (mode === 'unidentified') return { statusCode: 200, body: { unexpected: true } };
      if (mode === 'malformed') return { statusCode: 200, body: null, rawBody: '{"unexpected":' };
      if (path === '/repos/octo-org/example-app') return { statusCode: 200, body: GITHUB_REPOSITORY_RESPONSE };
      const baseOid = GITHUB_PULL_REQUEST_RESPONSE.base.sha;
      const headOid = GITHUB_PULL_REQUEST_RESPONSE.head.sha;
      if (path === `/repos/octo-org/example-app/compare/${baseOid}...${headOid}`) {
        return { statusCode: 200, body: { base_commit: { sha: baseOid }, merge_base_commit: { sha: baseOid } } };
      }
      if (path === '/repos/octo-org/example-app/pulls/1284') return { statusCode: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 } };
      if (path === '/repos/octo-org/example-app/issues/1284/timeline') return { statusCode: 200, body: [{ id: 1, event: 'labeled', actor: { login: 'octocat' }, created_at: '2026-08-12T18:00:00Z', label: { name: 'review' } }] };
      if (path === '/repos/octo-org/example-app/pulls/1284/files') return { statusCode: 200, body: [{ sha: GITHUB_PULL_REQUEST_RESPONSE.head.sha, filename: 'src/framePump.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, blob_url: 'https://github.com/octo-org/example-app/blob/main/src/framePump.ts', raw_url: 'https://github.com/octo-org/example-app/raw/main/src/framePump.ts', contents_url: 'https://api.github.com/repos/octo-org/example-app/contents/src/framePump.ts', patch: '@@ -1 +1 @@\n-before\n+after' }] };
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
  const env = { ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(), 'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`, HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath, GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: 'constructed-detail-token', GITHUB_TOKEN: '',
    HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'review-json', HTTPS_PROXY: github.url, https_proxy: github.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SSL_CERT_FILE: github.caCertPath };
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

it('links a Review started directly through the UI Action executor to the current PR entry', async ({ signal }) => {
  const ui = await connectUiTriageActionClient({ serverUrl: server!.baseUrl, accountSecret,
    additionalPlugins: [githubAccountPlugin] });
  try {
    await waitFor(() => ui.isAccountReady() && ui.isMachineControlReady(machineId));
    await ui.waitForPluginAccountAvailability();
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: ui.serverId, defaultSessionMachineId: machineId, signal } as const;
    const triage = async (localId: string, input: unknown) => {
      const action = await ui.executeConfirmed('action.invoke', { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId }, input }, context);
      if (!action.ok) throw new Error(`Triage Action refused: ${action.errorCode}`);
      return action.result;
    };
    const { binding, localInstanceKey, configuration, locator } = source;
    const created = TriageSourceAdministrationActionResultV1Schema.parse(await triage(
      TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, {
        v: 1, kind: 'create', source: source.instance.source,
        draft: { v: 1, binding, localInstanceKey, configuration, locator, keyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 },
      }));
    if (created.kind !== 'active') {
      const code = 'failure' in created ? created.failure?.code : undefined;
      const admission = created.kind === 'invalidCaller' ? created.admission : undefined;
      throw new Error(`GitHub source setup settled ${created.kind}${code ? ` (${code})` : ''}${admission ? ` ${JSON.stringify(admission)}` : ''}`);
    }
    const resolved = TriageResolveResourceActionResultV1Schema.parse(await triage(
      TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, {
        v: 1, resource: { kind: 'pullRequest', url: GITHUB_PULL_REQUEST_RESPONSE.html_url },
      }));
    if (resolved.kind !== 'resolved') throw new Error(`GitHub PR resolution settled ${resolved.kind}`);
    const selected = { v: 1, entryRef: resolved.entryRef, sourceInstanceId: resolved.sourceInstance.sourceInstanceId };
    const readDetail = async () => TriageReadEntryDetailResultV1Schema.parse(await triage(
      TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, selected));
    const observed = TriageReobserveEntryResultV1Schema.parse(await triage(
      TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, {
        ...selected, lastKnownLocator: resolved.locator, forSessionPullRequest: true, includeComparisonSource: true,
      }));
    if (observed.kind !== 'observed' || observed.comparisonSource?.kind !== 'pullRequest') {
      throw new Error('The configured source did not provide a PR comparison');
    }
    const before = await readDetail();
    expect(before.kind).toBe('read');
    expect(before).not.toHaveProperty('admittedReview');

    const cwd = join(testDir, 'direct-review');
    await initGitRepo({ repoDir: cwd });
    execGit(cwd, ['commit', '--allow-empty', '-m', 'Direct Review fixture']);
    const input = {
      target: { kind: 'detached' }, cwd, instructions: 'Review this pull request.',
      reviewers: reviewReviewersForEngineIdsV1(['claude']),
      source: observed.comparisonSource,
    } as const;
    const start = await ui.executeConfirmed(REVIEW_START_ACTION_ID_V1, input,
      { ...context, executionRunTargetMachineId: machineId, externalActionTarget: { kind: 'machine', machineId } });
    if (!start.ok) throw new Error(`Direct Review start refused: ${start.errorCode}`);
    const admitted = readReviewStartActionResultV1(start.result, input);
    if (admitted.kind !== 'native' || !admitted.reviewRound) throw new Error('Direct Review start did not return a round');
    expect(admitted.failed).toEqual([]);
    expect(admitted.runs).toHaveLength(1);
    expect(await readDetail()).toMatchObject({ kind: 'read', admittedReview: admitted.reviewRound });
  } finally {
    await ui.close();
  }
});
