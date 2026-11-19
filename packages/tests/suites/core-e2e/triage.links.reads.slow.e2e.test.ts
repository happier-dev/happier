import gitlabPackage from '../../../plugins/scm-gitlab/package.json';
import githubPackage from '../../../plugins/scm-github/package.json';
// QB-69/QB-77 and U-TRIAGE-FIX-PR-LINK: public relation reads, not mounted UI claims.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import {
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, TriageSourceAdministrationActionResultV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
  TriageReadSourceSessionLinksResultV1Schema, TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1, TriageReadFixPullRequestsResultV1Schema,
  TriageSetFixPullRequestResultV1Schema, type TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST as githubManifest } from '../../../plugins/scm-github/src/manifest';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import { GITLAB_PLUGIN } from '../../../plugins/scm-gitlab/src/manifest';
import { activate as activateGitlab } from '../../../plugins/scm-gitlab/src/accountRuntime';
import { GITLAB_PLUGIN_ID, GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID } from '../../../plugins/scm-gitlab/src/triage/contribution';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1,
  GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import { GITHUB_REPOSITORY_RESPONSE } from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
  TriageLinkEntryToSessionActionResultV1Schema } from '../../../plugins/triage/src/actions/sessionLinksProtocol';
import { TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
  TriageUnlinkEntryFromSessionActionResultV1Schema } from '../../../plugins/triage/src/actions/entrySessionProtocol';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  TriageReadEntryDetailResultV1Schema } from '../../../plugins/triage/src/actions/entryDetailProtocol';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_USER_MARKS_COLLECTION_ID } from '../../../plugins/triage/src/corpus/collections/ids';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { createServerLightDatabaseClient } from '../../src/testkit/process/serverLightDatabase';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-links-reads' });
const testDir = run.testDir(randomUUID());
const repository = 'octo-org/example-app';
const githubSource = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
const gitlabSource = { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID };
const issue: TriageEntryRefV1 = { source: githubSource, kindId: 'issue', collisionScope: 'github:4210', entryId: '25' };
const otherIssue: TriageEntryRefV1 = { ...issue, entryId: '26' };
const pullRequest: TriageEntryRefV1 = { source: gitlabSource, kindId: 'merge-request', collisionScope: 'gitlab:fixture-project', entryId: '17' };
const nativeAlert: TriageEntryRefV1 = { ...issue, kindId: 'dependabot-alert', entryId: '1' };
const nativePullRequest: TriageEntryRefV1 = { ...issue, kindId: 'pull-request', entryId: '19' };
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let database: Awaited<ReturnType<typeof createServerLightDatabaseClient>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let daemonParams: Parameters<typeof startTestDaemon>[0];
let machineId: string;
let wrongNativeRepository = false;

beforeAll(async () => {
  // Only the external GitHub TLS boundary is substituted; source admission,
  // credentials, native routing and decoders use their production owners.
  github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com', 'github.com'],
    responseForRequest(request) {
      const path = new URL(request.path, 'https://api.github.com').pathname;
      if (path === '/') return { statusCode: 200, body: { current_user_url: 'https://api.github.com/user' } };
      if (path === '/user') return { statusCode: 200, headers: { 'x-oauth-scopes': 'repo' },
        body: { login: 'triage-links-fixture', id: 991, name: 'Links fixture' } };
      if (path === `/repos/${repository}`) return { statusCode: 200, body: GITHUB_REPOSITORY_RESPONSE };
      if (path === '/graphql') {
        const body = JSON.parse(request.body) as { query?: string };
        if (body.query?.includes('HappierAlertUpdate')) return { statusCode: 200, body: { data: { repository: {
          databaseId: wrongNativeRepository ? 8815 : 4210, nameWithOwner: repository,
          vulnerabilityAlert: { number: 1, dependabotUpdate: { pullRequest: { number: 19,
            title: 'Update fixture', url: `https://github.com/${repository}/pull/19`, state: 'OPEN',
            repository: { databaseId: 4210, nameWithOwner: repository } } } },
        } } } };
        if (body.query?.includes('viewer')) return { statusCode: 200, body: { data: { viewer: { login: 'triage-links-fixture' } } } };
      }
      return { statusCode: 404, body: { message: 'No fixture for this provider read' } };
    } });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, dbProvider: 'postgres', extraEnv: { NODE_OPTIONS: sourceOptions,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
  if (!server.databaseUrl) throw new Error('Links fixture requires its isolated PostgreSQL URL');
  database = await createServerLightDatabaseClient('postgres', server.databaseUrl);
  auth = await createTestAuth(server.baseUrl);
  const homeDir = join(testDir, 'daemon-home');
  ({ machineId } = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' }));
  daemonParams = { testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(), 'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`,
    HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath,
    GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: '', GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', HTTPS_PROXY: github.url, https_proxy: github.url,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', SSL_CERT_FILE: github.caCertPath,
  } };
  daemon = await startTestDaemon(daemonParams);
}, 0);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => client?.close(), () => daemon?.stop(), () => database?.$disconnect(),
    () => server?.stop(), () => github?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Links fixture cleanup failed');
}, 0);

async function connect() {
  if (!server) throw new Error('Links server unavailable');
  client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed,
    additionalPlugins: [{ packageName: githubPackage.name, manifest: githubManifest, activate: activateGithub },
      { packageName: gitlabPackage.name, manifest: GITLAB_PLUGIN.manifest, activate: activateGitlab }] });
  await waitFor(() => client!.isAccountReady(), { context: 'links Account readiness' });
}

async function invoke(localId: string, input: unknown, mutation = false, selectedMachineId?: string) {
  if (!client) throw new Error('Links Account client unavailable');
  const args = { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId }, input };
  const context = { surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: client.serverId, defaultSessionMachineId: selectedMachineId };
  const result = mutation ? await client.executeConfirmed('action.invoke', args, context)
    : await client.execute('action.invoke', args, context);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Link Action ${localId} refused (${result.errorCode})`);
  return result.result;
}

async function durableReadState() {
  if (!database) throw new Error('Links PostgreSQL unavailable');
  const accountId = readAccountIdFromToken(auth.token);
  if (!accountId) throw new Error('Links token omitted its Account');
  // Inspect only this isolated Account's authoritative links/intent, including
  // tombstones: a read must not materialize native or Session-derived choices.
  return z.array(z.object({ collectionId: z.string(), rowId: z.string(), revision: z.number(),
    contentEnvelope: z.unknown(), deletedAt: z.unknown() })).parse(await database.$queryRawUnsafe(
    'SELECT "collectionId", "rowId", revision, "contentEnvelope", "deletedAt" FROM "PluginCollectionRow" '
      + 'WHERE "accountId" = $1 AND "pluginId" = $2 AND "collectionId" IN ($3, $4) ORDER BY "collectionId", "rowId"',
    accountId, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_USER_MARKS_COLLECTION_ID));
}

it('reads exact Session relations and selected native/manual/Session fix candidates without materializing derived state', async () => {
  if (!server || !github || !database) throw new Error('Links fixture not started');
  // Shared UI beforeEach resets profiles; connect after that boundary.
  await connect();
  const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: [repository] } });
  if (token === null) throw new Error('Links source configuration could not be encoded');
  const created = TriageSourceAdministrationActionResultV1Schema.parse(await invoke(
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, { v: 1, kind: 'create', source: githubSource, draft: { v: 1,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
      localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, keyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
      configuration: { v: 1, token }, locator: { v: 1, displayLabel: 'Selected links source' } } }, true));
  expect(created).toMatchObject({ kind: 'active' });
  if (created.kind !== 'active') throw new Error(`Links configuration refused (${created.kind})`);
  const sourceInstanceId = created.sourceInstanceId;
  const readConfigured = async () => {
    const result = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke(
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1, source: githubSource }));
    expect(result).toMatchObject({ kind: 'read', status: 'complete' });
    if (result.kind !== 'read') throw new Error('Selected links source unreadable');
    const configured = result.instances.find(row => row.configured.instance.sourceInstanceId === sourceInstanceId);
    expect(configured).toMatchObject({ lifecycle: 'active', configured: { configuration: { token } } });
    if (!configured) throw new Error('Selected links source missing');
    return configured.configured;
  };
  await readConfigured();
  const live = (await createSession(server.baseUrl, auth.token)).sessionId;
  const removed = (await createSession(server.baseUrl, auth.token)).sessionId;
  const decoy = (await createSession(server.baseUrl, auth.token)).sessionId;
  const link = async (entryRef: TriageEntryRefV1, sessionId: string) => {
    expect(TriageLinkEntryToSessionActionResultV1Schema.parse(await invoke(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
      { v: 1, entryRef, sessionId, ...(entryRef.source.pluginId === GITHUB_PLUGIN_ID ? { sourceInstanceId } : {}),
        display: { locator: { v: 1, displayPath: `${entryRef.source.localId}#${entryRef.entryId}` }, scopeLabel: repository } }, true)))
      .toMatchObject({ status: 'linked' });
  };
  const relations = async (input: { entryRef: TriageEntryRefV1; sourceInstanceId?: string } | { sessionId: string }) =>
    TriageReadSourceSessionLinksResultV1Schema.parse(await invoke(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, { v: 1, ...input }));
  const fix = async (entryRef: TriageEntryRefV1, selectedMachineId?: string) => TriageReadFixPullRequestsResultV1Schema.parse(await invoke(
    TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1, { v: 1, entryRef,
      sourceContext: { instance: await readConfigured(), lastKnownLocator: { v: 1, routingToken: repository } } }, false, selectedMachineId));
  await link(issue, live);
  await link(issue, removed);
  await link(otherIssue, decoy);
  await link(pullRequest, live);
  const deletion = await fetch(`${server.baseUrl}/v1/sessions/${removed}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } });
  expect(deletion.status).toBe(200);
  expect(await deletion.json()).toMatchObject({ success: true });
  expect(await database.session.findUnique({ where: { id: removed }, select: { id: true } })).toBeNull();
  const beforeReads = await durableReadState();
  const issueLinks = await relations({ entryRef: issue, sourceInstanceId });
  expect(issueLinks.kind).toBe('complete');
  expect(issueLinks.links.map(row => row.sessionId).sort()).toEqual([live, removed].sort());
  for (const row of issueLinks.links) expect(row.entryRef).toEqual(issue);
  const sessionLinks = await relations({ sessionId: live });
  expect(sessionLinks.links.map(row => row.entryRef)).toEqual(expect.arrayContaining([issue, pullRequest]));
  expect(sessionLinks.links.some(row => row.sessionId !== live || row.entryRef.entryId === otherIssue.entryId)).toBe(false);
  const detail = TriageReadEntryDetailResultV1Schema.parse(await invoke(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
    { v: 1, entryRef: issue, sourceInstanceId }));
  expect(detail).toMatchObject({ kind: 'read', linkedSessions: expect.arrayContaining([{ sessionId: live }, { sessionId: removed }]) });
  const derived = await fix(issue);
  expect(derived.candidates).toEqual([expect.objectContaining({ entryRef: pullRequest, origins: ['session'], status: 'unknown' })]);
  expect(derived.primary?.entryRef).toEqual(pullRequest);
  expect(await durableReadState()).toEqual(beforeReads);
  // Removal of the actual Session relation must remove the derived candidate;
  // this happens before explicit dismissal can conceal a stale derivation.
  expect(TriageUnlinkEntryFromSessionActionResultV1Schema.parse(await invoke(TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
    { v: 1, sessionId: live, entryRef: pullRequest }, true))).toMatchObject({ status: 'unlinked' });
  expect(await fix(issue)).toMatchObject({ candidates: [], primary: null });
  await link(pullRequest, live);
  expect((await fix(issue)).primary?.entryRef).toEqual(pullRequest);
  const displayAtMark = { title: 'Issue fixture', scopeLabel: repository };
  expect(TriageSetFixPullRequestResultV1Schema.parse(await invoke(TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
    { v: 1, linked: true, entryRef: issue, displayAtMark, fixPullRequest: pullRequest,
      displayAtLink: { title: 'Manual fix', scopeLabel: 'GitLab fixture' } }, true))).toMatchObject({ status: 'linked' });
  expect((await fix(issue)).candidates).toEqual([expect.objectContaining({ entryRef: pullRequest,
    origins: expect.arrayContaining(['user', 'session']) })]);
  expect(TriageSetFixPullRequestResultV1Schema.parse(await invoke(TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
    { v: 1, linked: false, entryRef: issue, displayAtMark, fixPullRequest: pullRequest }, true))).toMatchObject({ status: 'unlinked' });
  expect(await fix(issue)).toMatchObject({ candidates: [], primary: null });
  expect((await relations({ sessionId: live })).links.map(row => row.entryRef)).toContainEqual(pullRequest);
  expect(TriageUnlinkEntryFromSessionActionResultV1Schema.parse(await invoke(TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
    { v: 1, sessionId: live, entryRef: pullRequest }, true))).toMatchObject({ status: 'unlinked' });
  expect((await relations({ entryRef: pullRequest })).links).toEqual([]);

  // Persist the selected tuple before native discovery can supply candidates.
  await client!.close();
  client = undefined;
  await daemon!.stop();
  daemon = undefined;
  daemon = await startTestDaemon({ ...daemonParams, env: { ...daemonParams.env, GH_TOKEN: 'constructed-triage-links-token' } });
  await connect();
  await waitFor(() => client!.isMachineControlReady(machineId), { context: 'selected GitHub native Machine readiness' });
  await client!.waitForPluginAccountAvailability();
  await readConfigured();
  const beforeNative = await durableReadState();
  const providerStart = github.entries().length;
  const native = await fix(nativeAlert, machineId);
  const nativeRequests = github.entries().slice(providerStart);
  expect(native.candidates, JSON.stringify({ incomplete: native.incomplete,
    requests: nativeRequests.map(({ method, path }) => ({ method, path })) }))
    .toEqual([expect.objectContaining({ entryRef: nativePullRequest, origins: ['native'], status: 'open',
    sourceContext: expect.objectContaining({ sourceInstanceId, lastKnownLocator: expect.objectContaining({
      routingToken: repository, webUrl: `https://github.com/${repository}/pull/19` }) }) })]);
  expect(native.primary?.entryRef).toEqual(nativePullRequest);
  expect(nativeRequests.some(request => request.path === '/graphql' && request.body.includes('HappierAlertUpdate'))).toBe(true);
  expect(nativeRequests.some(request => /\/search\/|\/user\/repos|\/pulls(?:\?|$)/u.test(request.path))).toBe(false);
  wrongNativeRepository = true;
  const misrouted = await fix(nativeAlert, machineId);
  expect(misrouted).toMatchObject({ candidates: [], primary: null, incomplete: true });
  expect(await durableReadState()).toEqual(beforeNative);
}, 0);
