import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import githubPackage from '../../../plugins/scm-github/package.json';
import { PLUGIN_MANIFEST as githubManifest } from '../../../plugins/scm-github/src/manifest';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import {
  connectUiPersonActionClient, connectUiTriageActionClient, installPersonTransientConfirmationBoundary, type connectUiActionClient,
} from '@happier-tests/ui-action-client';
import { ReviewCommentCreateResponseV1Schema, formatReviewCommentPublicationMarkerV1, type ReviewCommentPublicationPlanV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewCommentTextSnapshotHashes } from '@happier-dev/protocol/reviews/comments/snapshots';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceAdministrationActionResultV1Schema, type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1, GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import { GithubIssueCommentResultV1Schema, githubReviewPublicationCredential } from '../../../plugins/scm-github/src/triage/mutations/contracts';
import { GITHUB_ISSUE_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE } from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startFinJourneyFixture } from '../../src/testkit/finJourney';
import { startConnectedAccountTlsRecordingProxy, writeConnectedAccountTlsProxyPreload,
  type RecordedConnectedAccountTlsRequest, type ConnectedAccountTlsResponse } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';
import { createDeferred } from '../../../../apps/cli/src/testkit/async/deferred';

// QB-34/QB-47: public Actions -> encrypted Account/Postgres -> real daemon ->
// real GitHub source -> canonical Reviews claim. Only external HTTPS is playback.
// A held first POST makes the second writer reach the SQL claim before any
// marker exists. Marker reconciliation alone cannot pass that assertion.
const run = createRunDirs({ runLabel: 'triage-scm-publication-faults' });
const testDir = run.testDir(randomUUID());
const source = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
const localRef = { kindId: 'issue', collisionScope: 'github:8815', entryId: '7' };
const issuePath = '/repos/octo-org/example-tools/issues/7';
const body = 'Two distinct Happier comments intentionally share this body.';
const anchor = { kind: 'file' as const, filePath: 'README.md' };
const lines = { selectedLines: ['Context'], beforeContext: [], afterContext: [] };
const snapshot = { kind: 'text' as const, ...lines, ...buildReviewCommentTextSnapshotHashes(lines),
  capturedAt: 1, fileLength: 1, source: 'committed' as const, isUncommitted: false,
  isUntracked: false, truncated: false, hasBidiControls: false, likelyMinified: false };
const published: Array<{ id: number; body: string; user: { login: string }; created_at: string; updated_at: string; html_url: string }> = [];
let fixture: Awaited<ReturnType<typeof startFinJourneyFixture>> | undefined;
let github: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let client: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let owner: Awaited<ReturnType<NonNullable<typeof fixture>['createAccount']>>;
let machine: Awaited<ReturnType<NonNullable<typeof fixture>['enrollDaemon']>>;
let restoreConfirmation: (() => void) | undefined;
let firstWriteSeen = createDeferred<void>();
let releaseFirstWrite = createDeferred<void>();
let holdFirstWrite = false;
const providerHosts = ['gitlab.com', 'api.bitbucket.org', 'dev.azure.com'];
let orderedResponse: ((request: RecordedConnectedAccountTlsRequest) => ConnectedAccountTlsResponse) | undefined;

function answerLossPreload() {
  // Substitute only the external fetch response: the real HTTPS server has
  // already accepted the second comment POST when its answer is lost. The first
  // POST is the known-good control; every later request remains a real fetch.
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(pathToFileURL(join(repoRootDir(), 'apps/cli/package.json')).href)});
    const undici = require('undici/index.js');
    let writes = 0;
    const wrap = fetcher => async (input, init) => {
      const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
      const commentWrite = url.hostname === 'api.github.com' && url.pathname === ${JSON.stringify(`${issuePath}/comments`)}
        && (init?.method ?? input?.method ?? 'GET').toUpperCase() === 'POST';
      const response = await fetcher(input, init);
      if (commentWrite && ++writes === 2) {
        await response.arrayBuffer();
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('External response lost after dispatch'), { code: 'ECONNRESET' }),
        });
      }
      return response;
    };
    globalThis.fetch = wrap(globalThis.fetch);
    undici.fetch = wrap(undici.fetch);
  `;
  return `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`;
}

beforeAll(async () => {
  github = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com', 'github.com', ...providerHosts],
    async responseForRequest(request) {
      if (providerHosts.includes(request.connectTarget.split(':')[0]!) && orderedResponse) return orderedResponse(request);
      const path = new URL(request.path, 'https://api.github.com').pathname;
      const ok = (value: unknown, statusCode = 200) => ({ statusCode, body: value });
      if (path === '/') return ok({ current_user_url: 'https://api.github.com/user' });
      if (path === '/user') return { ...ok({ id: 1118, login: 'scm-fault-fixture' }), headers: { 'x-oauth-scopes': 'repo' } };
      if (request.method === 'GET' && path === issuePath) return ok(GITHUB_ISSUE_RESPONSE);
      if (request.method === 'GET' && path === '/repos/octo-org/example-tools') return ok(GITHUB_OTHER_REPOSITORY_RESPONSE);
      if (request.method === 'GET' && path === `${issuePath}/comments`) return ok([...published]);
      if (request.method === 'POST' && path === `${issuePath}/comments`) {
        if (holdFirstWrite) {
          holdFirstWrite = false;
          firstWriteSeen.resolve(undefined);
          await releaseFirstWrite.promise;
        }
        const input: unknown = JSON.parse(request.body);
        if (!input || typeof input !== 'object' || !('body' in input) || typeof input.body !== 'string') {
          return ok({ message: 'Fixture requires a comment body' }, 422);
        }
        const id = 700 + published.length;
        const row = { id, body: input.body, user: { login: 'scm-fault-fixture' },
          created_at: '2026-08-12T09:00:00Z', updated_at: '2026-08-12T09:00:00Z',
          html_url: `https://github.com/octo-org/example-tools/issues/7#issuecomment-${id}` };
        published.push(row);
        return ok(row, 201);
      }
      return ok({ message: 'Unexpected GitHub publication fixture route' }, 404);
    },
  });
  fixture = await startFinJourneyFixture({ testDir, dbProvider: 'postgres',
    serverEnv: { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL } });
  owner = await fixture.createAccount('scm-publication-owner');
  const providerPreload = await writeConnectedAccountTlsProxyPreload(testDir, github, ['api.github.com', ...providerHosts]);
  machine = await fixture.enrollDaemon(owner, { env: {
    NODE_ENV: process.env.NODE_ENV,
    NODE_OPTIONS: `${fixture.sourceOptions} --import ${providerPreload} --import ${answerLossPreload()}`,
    HAPPIER_E2E_TRIAGE_GITHUB_PROXY: github.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: github.caCertPath,
    GH_CONFIG_DIR: join(testDir, 'gh-home'), GH_HOST: 'github.com', GH_TOKEN: 'constructed-scm-fault-token',
    GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
    HTTPS_PROXY: github.url, https_proxy: github.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    SSL_CERT_FILE: github.caCertPath,
  } });
}, 0);

afterAll(async () => {
  releaseFirstWrite.resolve(undefined);
  const failures: unknown[] = [];
  for (const close of [() => client?.close(), () => fixture?.stop(), () => github?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  restoreConfirmation?.();
  if (failures.length) throw new AggregateError(failures, 'SCM publication fault cleanup failed');
});

it('QB-34/QB-47 atomically admits one first writer, preserves same-body comment identity, and reconciles a lost answer without retry', async () => {
  const [{ readFile }, { createRequire }, { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1: connectionOutputs },
    { TriageListInstancesResultV1Schema, TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageScanResultV1Schema, TriageGetResultV1Schema },
    { default: gitlabPackage }, { GITLAB_PLUGIN }, { activate: activateGitlab }, gl,
    glAuth, { GitlabReviewPublicationResultV1Schema }, { default: gitlabMergeRequests },
    { default: bitbucketPackage }, { BITBUCKET_PLUGIN }, { activate: activateBitbucket }, bb, bbDescriptor,
    { BITBUCKET_TRIAGE_MUTATION_ACTION_IDS, BitbucketReviewPublicationResultV1Schema },
    { default: bitbucketUser }, { default: bitbucketWorkspaces }, { default: bitbucketRepositories }, { default: bitbucketPullRequest },
    { default: azurePackage }, { AZURE_DEVOPS_PLUGIN }, { activate: activateAzure }, { AZURE_DEVOPS_PLUGIN_ID }, azDescriptor,
    { AZURE_DEVOPS_TRIAGE_ACTION_IDS }, { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS }, azAuth, { AzureReviewPublicationResultV1Schema },
    { default: azureConnection }, { default: azureProjects }, { default: azurePullRequests }] = await Promise.all([
      import('node:fs/promises'), import('node:module'), import('@happier-dev/protocol/connect/configurationActionsV1'),
      import('@happier-dev/triage-protocol/v1'),
      import('../../../plugins/scm-gitlab/package.json'), import('../../../plugins/scm-gitlab/src/manifest'),
      import('../../../plugins/scm-gitlab/src/accountRuntime'), import('../../../plugins/scm-gitlab/src/triage/contribution'),
      import('../../../plugins/scm-gitlab/src/auth/connectedAccountRuntime'), import('../../../plugins/scm-gitlab/src/triage/mutations/contracts'),
      import('../../../plugins/scm-gitlab/src/triage/__fixtures__/mergeRequestList.json'),
      import('../../../plugins/scm-bitbucket/package.json'), import('../../../plugins/scm-bitbucket/src/manifest'),
      import('../../../plugins/scm-bitbucket/src/accountRuntime'), import('../../../plugins/scm-bitbucket/src/bitbucketContracts'),
      import('../../../plugins/scm-bitbucket/src/triage/source/descriptor'), import('../../../plugins/scm-bitbucket/src/triage/source/mutationContracts'),
      import('../../../plugins/scm-bitbucket/src/triage/fixtures/currentUser.json'), import('../../../plugins/scm-bitbucket/src/triage/fixtures/userWorkspacesPage.json'),
      import('../../../plugins/scm-bitbucket/src/triage/fixtures/workspaceRepositoriesPage.json'), import('../../../plugins/scm-bitbucket/src/triage/fixtures/pullRequestSelf.json'),
      import('../../../plugins/scm-azure-devops/package.json'), import('../../../plugins/scm-azure-devops/src/manifest'),
      import('../../../plugins/scm-azure-devops/src/accountRuntime'), import('../../../plugins/scm-azure-devops/src/azureDevopsContracts'),
      import('../../../plugins/scm-azure-devops/src/triage/descriptor'), import('../../../plugins/scm-azure-devops/src/triage/actions'),
      import('../../../plugins/scm-azure-devops/src/triage/mutationActions'), import('../../../plugins/scm-azure-devops/src/auth/azureDevopsConnectedAccountRuntime'),
      import('../../../plugins/scm-azure-devops/src/triage/mutations/contracts'), import('../../../plugins/scm-azure-devops/src/triage/fixtures/connectionData.json'),
      import('../../../plugins/scm-azure-devops/src/triage/fixtures/projects.page1.json'), import('../../../plugins/scm-azure-devops/src/triage/fixtures/pullRequests.authored.page1.json'),
    ]);
  restoreConfirmation = installPersonTransientConfirmationBoundary();
  const configuredClient = await connectUiTriageActionClient({ serverUrl: fixture!.server.baseUrl, accountSecret: owner.auth.accountSigningSeed,
    additionalPlugins: [{ packageName: githubPackage.name, manifest: githubManifest, activate: activateGithub },
      { packageName: gitlabPackage.name, manifest: GITLAB_PLUGIN.manifest, activate: activateGitlab },
      { packageName: bitbucketPackage.name, manifest: BITBUCKET_PLUGIN.manifest, activate: activateBitbucket },
      { packageName: azurePackage.name, manifest: AZURE_DEVOPS_PLUGIN.manifest, activate: activateAzure }] });
  client = configuredClient;
  const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: client!.serverId });
  const token = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: ['octo-org/example-tools'] } });
  if (token === null) throw new Error('Publication fixture configuration could not encode');
  const draft: TriageSourceInstanceDraftV1 = { v: 1,
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: GITHUB_CONNECTED_ACCOUNT_SERVICE },
    localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, keyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
    configuration: { v: 1, token }, locator: { v: 1, displayLabel: 'SCM publication faults' } };
  const created = await configuredClient.executeConfirmed('action.invoke', { action: {
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1 },
    input: { v: 1, kind: 'create', source, draft } }, context());
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error(`Configured source create failed (${created.errorCode})`);
  const createdSource = TriageSourceAdministrationActionResultV1Schema.parse(created.result);
  if (createdSource.kind !== 'active') throw new Error(`Configured source unavailable (${createdSource.kind})`);
  const read = await configuredClient.execute('action.invoke', { action: {
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1 },
    input: { v: 1, source } }, context());
  if (!read.ok) throw new Error(`Configured source read failed (${read.errorCode})`);
  const configured = TriageReadConfiguredSourceInstancesResultV1Schema.parse(read.result);
  if (configured.kind !== 'read') throw new Error(`Configured source read unavailable (${configured.kind})`);
  const instance = configured.instances.find(row => row.configured.instance.sourceInstanceId === createdSource.sourceInstanceId)?.configured;
  if (!instance) throw new Error('Publication source missing from authoritative configured read');
  await configuredClient.close();
  const personClient = await connectUiPersonActionClient({ serverUrl: fixture!.server.baseUrl, accountSecret: owner.auth.accountSigningSeed,
    presentedMachineAction: { action: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueComment },
      target: { serverIdentityId: fixture!.serverId, machineId: machine.target.machineId } } });
  client = personClient;
  await waitFor(() => client!.isAccountReady() && client!.isMachineControlReady(machine.target.machineId));
  await client.waitForPluginAccountAvailability();
  await waitFor(() => personClient.isPresentedMachineActionReady());
  const createComment = async () => {
    const result = await client!.executeConfirmed('reviews.comments.create', {
      workspace: { machineId: machine.target.machineId, path: machine.workspaceDir },
      anchor, snapshot, body, clientMutationId: randomUUID(),
    }, context());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Reviews comment create failed (${result.errorCode})`);
    return ReviewCommentCreateResponseV1Schema.parse(result.result).comment;
  };
  const commentA = await createComment();
  const commentB = await createComment();
  expect(commentA.id).not.toBe(commentB.id);
  const planFor = (comment: typeof commentA): ReviewCommentPublicationPlanV1 => ({
    target: { providerId: 'github', ...githubReviewPublicationCredential(instance.binding),
      entryRef: { sourceId: `${GITHUB_PLUGIN_ID}/github-forge`, ...localRef }, subtarget: null },
    baseRevision: null, headRevision: null, entries: [{ happierCommentId: comment.id,
      expectedServerRevision: comment.serverRevision, anchor, snapshot, body }], verdict: null,
  });
  const publish = async (plan: ReviewCommentPublicationPlanV1) => {
    const result = await client!.executeConfirmed('action.invoke', { action: {
      pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueComment },
      input: { v: 1, instance, localRef, routingToken: 'octo-org/example-tools', publicationPlan: plan } }, context());
    if (!result.ok) throw new Error(`GitHub publication Action failed (${result.errorCode})`);
    return GithubIssueCommentResultV1Schema.parse(result.result);
  };
  const posts = () => github!.entries().filter(row => row.method === 'POST' && row.path === `${issuePath}/comments`);

  // Establish the complete known-good path before injecting either fault.
  const control = await publish(planFor(commentB));
  expect(control).toMatchObject({ kind: 'settled', publication: { entries: [{ happierCommentId: commentB.id,
    outcome: { kind: 'published' } }] } });
  expect(posts()).toHaveLength(1);

  holdFirstWrite = true;
  const first = publish(planFor(commentA));
  await Promise.race([firstWriteSeen.promise, first.then(() => { throw new Error('First publication settled before the held POST'); })]);
  const contender = await publish(planFor(commentA));
  expect(contender).toMatchObject({ kind: 'settled', publication: { entries: [{ happierCommentId: commentA.id,
    outcome: { kind: 'uncertain' } }] } });
  // The first writer is held before GitHub stores its marker. A second POST
  // would prove the source relied on a marker pre-read instead of SQL admission.
  expect(published).toHaveLength(1);
  expect(posts()).toHaveLength(2);
  releaseFirstWrite.resolve(undefined);
  const firstResult = await first;
  expect(firstResult).toMatchObject({ kind: 'settled', publication: { entries: [{ happierCommentId: commentA.id,
    outcome: { kind: 'published' } }] } });
  expect(published).toHaveLength(2);
  expect(published[0]!.body.split('\n\n')[0]).toBe(body);
  expect(published[1]!.body.split('\n\n')[0]).toBe(body);
  expect(published[0]!.body).not.toBe(published[1]!.body);
  if (control.kind !== 'settled' || firstResult.kind !== 'settled') throw new Error('Missing GitHub publication settlement');
  expect(published[0]!.body).toBe(`${body}\n\n${formatReviewCommentPublicationMarkerV1('entry', control.publication.entries[0]!.publicationCorrelationId)}`);
  expect(published[1]!.body).toBe(`${body}\n\n${formatReviewCommentPublicationMarkerV1('entry', firstResult.publication.entries[0]!.publicationCorrelationId)}`);
  expect(control.publication.entries[0]!.publicationCorrelationId).not.toBe(firstResult.publication.entries[0]!.publicationCorrelationId);
  expect(posts()).toHaveLength(2);
  expect(await publish(planFor(commentA))).toMatchObject({ kind: 'settled', publication: {
    entries: [{ happierCommentId: commentA.id, outcome: { kind: 'published' } }] } });
  expect(posts()).toHaveLength(2);
  console.info('SCM_PUBLICATION_EVIDENCE', JSON.stringify({ provider: 'github', machineId: machine.target.machineId,
    sourceInstanceId: instance.instance.sourceInstanceId, control: control.publication, answerLost: firstResult.publication,
    commentBodies: published.map(row => ({ externalRef: String(row.id), body: row.body })),
    writes: posts().map(row => ({ method: row.method, path: row.path, observedAtMs: row.observedAtMs })) }));
  await client.close();
  const gitlabRow = { ...gitlabMergeRequests[0]!, diff_refs: { base_sha: '1'.repeat(40),
    head_sha: gitlabMergeRequests[0]!.sha, start_sha: '2'.repeat(40) } };
  const gitlabDrafts = new Map<number, { note: string; position?: unknown }>();
  const gitlabNotes: Array<{ id: number; body: string; type: 'DiscussionNote' | null }> = [];
  const bitbucketComments: Array<{ id: number; content: { raw: string } }> = [];
  const azureThreads: Array<{ id: number; comments: Array<{ id: number; content: string }> }> = [];
  const acceptedStates = new Set<string>();
  const effects: Array<{ host: string; phase: 'entry' | 'summary' | 'state'; body?: string }> = [];
  let loseStateAnswer = false;
  let loseSummaryAnswer = false;
  let lostStateAnswers = 0;
  let lostSummaryAnswers = 0;
  let nextGitlabDraftId = 80;
  const orderedProxy = github!;
  orderedResponse = request => {
      const host = request.connectTarget.split(':')[0]!;
      const url = new URL(request.path, `https://${host}`);
      const path = url.pathname.toLowerCase();
      const ok = (body: unknown, statusCode = 200) => ({ statusCode, body });
      const parsed: unknown = request.body ? JSON.parse(request.body) : undefined;
      const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      if (host === 'gitlab.com') {
        if (path === '/api/v4/user') return ok({ id: 1, username: 'example-user' });
        if (path.endsWith('/merge_requests/7')) return ok({ ...gitlabRow, approved: acceptedStates.has(host) });
        if (path === '/api/v4/merge_requests') return ok(url.searchParams.get('scope') === 'created_by_me' ? [gitlabRow] : []);
        if (path === '/api/v4/issues' || path.endsWith('/pipelines')) return ok([]);
        if (request.method === 'GET' && path.endsWith('/draft_notes')) return ok([...gitlabDrafts].map(([id, draft]) => ({ id, ...draft })));
        if (request.method === 'GET' && path.endsWith('/discussions')) return ok(gitlabNotes.map(note => ({ id: `thread-${note.id}`, notes: [note] })));
        if (request.method === 'GET' && path.endsWith('/notes')) return ok(gitlabNotes.filter(note => note.type === null));
        if (request.method === 'POST' && path.endsWith('/draft_notes')) {
          if (typeof record.note !== 'string') return ok({ error: 'Missing authored note' }, 422);
          const id = ++nextGitlabDraftId;
          gitlabDrafts.set(id, { note: record.note, ...(record.position === undefined ? {} : { position: record.position }) });
          return ok({ id }, 201);
        }
        if (request.method === 'PUT' && /\/draft_notes\/\d+\/publish$/u.test(path)) {
          const id = Number(path.split('/').at(-2));
          const draft = gitlabDrafts.get(id);
          if (!draft) return ok({ error: 'Missing draft' }, 404);
          gitlabDrafts.delete(id);
          gitlabNotes.push({ id: id + 10, body: draft.note, type: draft.position ? 'DiscussionNote' : null });
          effects.push({ host, phase: draft.position ? 'entry' : 'summary', body: draft.note });
          return { statusCode: 204, body: '' };
        }
        if (request.method === 'POST' && path.endsWith('/merge_requests/7/approve')) {
          acceptedStates.add(host); effects.push({ host, phase: 'state' });
          return ok({ approved: true }, 201);
        }
      }
      if (host === 'api.bitbucket.org') {
        if (path === '/2.0/user') return ok(bitbucketUser);
        if (path === '/2.0/user/workspaces') return ok({ ...bitbucketWorkspaces, size: 1, values: [bitbucketWorkspaces.values[0]] });
        const row = { ...bitbucketPullRequest,
          source: { ...bitbucketPullRequest.source, commit: { hash: '3'.repeat(40) } },
          destination: { ...bitbucketPullRequest.destination, commit: { hash: '4'.repeat(40) } },
          draft: false, participants: acceptedStates.has(host)
          ? [{ role: 'PARTICIPANT', approved: true, state: 'approved', user: bitbucketUser }] : [] };
        if (path.endsWith('/pullrequests/42')) return ok(row);
        if (path.endsWith('/pullrequests/42/comments')) {
          if (request.method === 'GET') return ok({ values: bitbucketComments });
          const content = record.content;
          if (content === null || typeof content !== 'object' || !('raw' in content) || typeof content.raw !== 'string') return ok({ error: 'Missing comment' }, 422);
          const comment = { id: 900 + bitbucketComments.length, content: { raw: content.raw } };
          bitbucketComments.push(comment);
          effects.push({ host, phase: record.inline ? 'entry' : 'summary', body: content.raw });
          return ok(comment, 201);
        }
        if (request.method === 'POST' && path.endsWith('/pullrequests/42/approve')) {
          acceptedStates.add(host); effects.push({ host, phase: 'state' });
          return ok({ user: bitbucketUser, approved: true, state: 'approved' });
        }
        if (path.includes('/pullrequests')) return ok({ values: path.endsWith('/statuses') ? [] : [row] });
        if (path.startsWith('/2.0/repositories/')) return ok({ ...bitbucketRepositories, values: [bitbucketRepositories.values[0]] });
      }
      if (host === 'dev.azure.com') {
        if (path.endsWith('/_apis/connectiondata')) return ok(azureConnection);
        if (path.endsWith('/_apis/projects')) return ok(azureProjects);
        if (path.endsWith('/_apis/git/repositories')) return ok({ value: [azurePullRequests.value[0]!.repository] });
        const row = { ...azurePullRequests.value[0]!, reviewers: acceptedStates.has(host)
          ? [{ id: azureConnection.authenticatedUser.id, vote: 10 }] : [] };
        if (path.endsWith('/pullrequests/22')) return ok(row);
        if (path.endsWith('/pullrequests/22/iterations')) return ok({ value: [{ id: 3 }] });
        if (path.endsWith('/pullrequests/22/iterations/3/changes')) return ok({ changeEntries: [{ changeTrackingId: 42, item: { path: 'src/index.ts' } }] });
        if (path.endsWith('/pullrequests/22/threads')) {
          if (request.method === 'GET') return ok({ value: azureThreads });
          const comments = record.comments;
          const first = Array.isArray(comments) ? comments[0] as unknown : undefined;
          if (first === null || typeof first !== 'object' || !('content' in first) || typeof first.content !== 'string') return ok({ error: 'Missing comment' }, 422);
          const thread = { id: 70 + azureThreads.length, comments: [{ id: 1, content: first.content }] };
          azureThreads.push(thread);
          effects.push({ host, phase: record.threadContext ? 'entry' : 'summary', body: first.content });
          return ok(thread, 201);
        }
        if (request.method === 'PUT' && path.includes('/pullrequests/22/reviewers/')) {
          acceptedStates.add(host); effects.push({ host, phase: 'state' });
          return ok({ id: azureConnection.authenticatedUser.id, vote: 10 });
        }
        if (path.endsWith('/pullrequests')) return ok({ value: [row] });
      }
      return ok({ error: 'unrecognized-ordered-publication-fixture-route' }, 404);
    };
  const requireCli = createRequire(join(repoRootDir(), 'apps/cli/package.json'));
  type HttpBoundary = { fetch: typeof fetch; ProxyAgent: new (input: { uri: string; requestTls: { ca: Buffer } }) => { close(): Promise<void> } };
  const undici: HttpBoundary = requireCli('undici/index.js'); // Only the third-party HTTP adapter is untyped.
  const dispatcher = new undici.ProxyAgent({ uri: orderedProxy.url, requestTls: { ca: await readFile(orderedProxy.caCertPath) } });
  const originalFetch = globalThis.fetch;
  const originalUndiciFetch = undici.fetch;
  const proxyFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (!providerHosts.includes(url.hostname)) return originalFetch(input, init);
    const from = effects.length;
    const response = await originalUndiciFetch(input, { ...init, dispatcher } as RequestInit);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const stateWrite = method === 'POST' && url.pathname.endsWith('/approve')
      || method === 'PUT' && url.pathname.toLowerCase().includes('/reviewers/');
    const summaryAnswerLost = loseSummaryAnswer && effects.slice(from).some(effect => effect.phase === 'summary');
    const stateAnswerLost = loseStateAnswer && stateWrite;
    if (stateAnswerLost || summaryAnswerLost) {
      await response.arrayBuffer();
      if (stateAnswerLost) lostStateAnswers += 1;
      if (summaryAnswerLost) lostSummaryAnswers += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Answer lost after accepted provider write'), { code: 'ECONNRESET' }) });
    }
    return response;
  };
  globalThis.fetch = proxyFetch;
  undici.fetch = proxyFetch;
  try {
    const orderedClient = await connectUiTriageActionClient({ serverUrl: fixture!.server.baseUrl, accountSecret: owner.auth.accountSigningSeed,
      additionalPlugins: [{ packageName: gitlabPackage.name, manifest: GITLAB_PLUGIN.manifest, activate: activateGitlab },
        { packageName: bitbucketPackage.name, manifest: BITBUCKET_PLUGIN.manifest, activate: activateBitbucket },
        { packageName: azurePackage.name, manifest: AZURE_DEVOPS_PLUGIN.manifest, activate: activateAzure }] });
    client = orderedClient;
    const action = async (id: import('@happier-dev/protocol/actions/actionIds').ActionId, input: unknown) => {
      const result = await orderedClient.executeConfirmed(id, input, context());
      if (!result.ok) throw new Error(`Ordered publication ${id} refused (${result.errorCode})`);
      return result.result;
    };
    const invoke = (pluginId: string, localId: string, input: unknown) => action('action.invoke', { action: { pluginId, localId }, input });
    const connect = async (service: import('@happier-dev/plugin-sdk/connected-accounts').QualifiedConnectedAccountRef['service'], modeId: string,
      values: Record<string, string>, fields: Record<string, string>) => {
      const begun = connectionOutputs['connectedServices.authentication.beginConnect'].parse(await action('connectedServices.authentication.beginConnect', { service, modeId }));
      if (begun.status !== 'configurationRequired' && begun.status !== 'awaitingManual') throw new Error(`Ordered Connect unavailable (${begun.status})`);
      if (begun.status === 'configurationRequired') {
        const configured = connectionOutputs['connectedServices.configuration.replace'].parse(await action('connectedServices.configuration.replace', {
          target: { kind: 'attempt', attemptId: begun.attemptId }, expectedRevision: null, values, secretValues: {} }));
        expect(await action('connectedServices.authentication.continueConnect', { attemptId: begun.attemptId, expectedConfigurationRevision: configured.revision }))
          .toMatchObject({ status: 'awaitingManual' });
      }
      const connected = connectionOutputs['connectedServices.authentication.submitManual'].parse(await action('connectedServices.authentication.submitManual', { attemptId: begun.attemptId, fields }));
      if (connected.status !== 'connected') throw new Error(`Ordered Connect did not complete (${connected.status})`);
      return connected.account;
    };
    const cases = [
      { providerId: 'gitlab', pluginId: gl.GITLAB_PLUGIN_ID, sourceId: gl.GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID,
        actions: gl.GITLAB_TRIAGE_ACTION_IDS, publishAction: gl.GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview,
        purpose: gl.GITLAB_CONNECTED_ACCOUNT_PURPOSE, host: 'gitlab.com',
        account: await connect({ pluginId: gl.GITLAB_PLUGIN_ID, localId: gl.GITLAB_CONNECTED_ACCOUNT_ID }, glAuth.GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
          { [glAuth.GITLAB_ORIGIN_CONFIGURATION_FIELD]: 'https://gitlab.com' }, { [glAuth.GITLAB_TOKEN_CREDENTIAL_KEY]: 'constructed-ordered-gitlab-token' }),
        parse: GitlabReviewPublicationResultV1Schema.parse },
      { providerId: 'bitbucket', pluginId: bb.BITBUCKET_PLUGIN_ID, sourceId: bb.BITBUCKET_TRIAGE_CONTRIBUTION_ID,
        actions: bbDescriptor.BITBUCKET_TRIAGE_ACTION_IDS, publishAction: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.submitReview,
        purpose: bbDescriptor.BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, host: 'api.bitbucket.org',
        account: await connect({ pluginId: bb.BITBUCKET_PLUGIN_ID, localId: bbDescriptor.BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID }, 'manual', {},
          { identity: 'fixture-reader@example.invalid', token: 'constructed-ordered-bitbucket-token' }), parse: BitbucketReviewPublicationResultV1Schema.parse },
      { providerId: 'azure-devops', pluginId: AZURE_DEVOPS_PLUGIN_ID, sourceId: azDescriptor.AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID,
        actions: AZURE_DEVOPS_TRIAGE_ACTION_IDS, publishAction: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.submitReview,
        purpose: azDescriptor.AZURE_DEVOPS_TRIAGE_PURPOSE, host: 'dev.azure.com',
        account: await connect({ pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: azDescriptor.AZURE_DEVOPS_CONNECTED_ACCOUNT_ID }, azAuth.AZURE_DEVOPS_MANUAL_MODE_ID,
          { [azAuth.AZURE_DEVOPS_BASE_CONFIGURATION_FIELD]: 'https://dev.azure.com/exampleorg' }, { token: 'constructed-ordered-azure-token' }), parse: AzureReviewPublicationResultV1Schema.parse },
    ];
    for (const forge of cases) {
      // Join the chooser's profile publication when this account is consumed,
      // after the other Connect flows have also published their profile updates.
      await orderedClient.waitForConnectedAccountProfile(forge.account);
      const purpose = { consumer: { pluginId: forge.pluginId, localId: forge.actions.listInstances }, purpose: forge.purpose };
      const selection = await orderedClient.executeConfirmed('connectedServices.purposes.default.set', {
        purpose, target: { kind: 'account', account: forge.account },
      }, context());
      if (!selection.ok) {
        // Read the public owner's credential-free profile result to classify setup.
        const { sameQualifiedConnectedAccountRef } = await import('@happier-dev/protocol/connect/qualified-connected-account-persistence');
        const read = await orderedClient.executeConfirmed('connectedServices.accounts.list', { service: forge.account.service }, context());
        const listing = read.ok ? connectionOutputs['connectedServices.accounts.list'].parse(read.result) : null;
        throw new Error(`Ordered purpose admission refused: ${JSON.stringify({ provider: forge.providerId, code: selection.errorCode,
          profileReadCode: read.ok ? undefined : read.errorCode,
          profiles: listing?.accounts.map(({ account, health }) => ({ selected: sameQualifiedConnectedAccountRef(account.ref, forge.account),
            status: account.status, configurationReady: account.configurationReady, health })),
        })}`);
      }
      expect(selection.result).toMatchObject({ applied: true });
      const discovery = TriageListInstancesResultV1Schema.parse(await invoke(forge.pluginId, forge.actions.listInstances, { v: 1 }));
      if (discovery.kind !== 'complete' || !discovery.candidates[0]) throw new Error(`${forge.providerId} source discovery unavailable (${discovery.kind})`);
      const source = { pluginId: forge.pluginId, localId: forge.sourceId };
      const saved = TriageSourceAdministrationActionResultV1Schema.parse(await invoke(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, { v: 1, kind: 'create', source, draft: discovery.candidates[0] }));
      if (saved.kind !== 'active') throw new Error(`${forge.providerId} source save unavailable (${saved.kind})`);
      const configured = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1, source }));
      if (configured.kind !== 'read') throw new Error(`${forge.providerId} configured source unavailable (${configured.kind})`);
      const instance = TriageConfiguredSourceConnectedAccountInstanceV1Schema.parse(configured.instances.find(row => row.configured.instance.sourceInstanceId === saved.sourceInstanceId)?.configured);
      const scan = TriageScanResultV1Schema.parse(await invoke(forge.pluginId, forge.actions.scan, { v: 1, instance, page: { kind: 'initial', limit: 20 } }));
      if (scan.kind !== 'page' && scan.kind !== 'complete') throw new Error(`${forge.providerId} source scan failed (${scan.kind})`);
      const observed = scan.observations.find(row => row.kind === 'present' && row.localRef.kindId !== 'issue');
      if (observed?.kind !== 'present' || !observed.locator.routingToken) throw new Error(`${forge.providerId} source route missing`);
      const detail = TriageGetResultV1Schema.parse(await invoke(forge.pluginId, forge.actions.get, { v: 1, instance, localRef: observed.localRef, lastKnownLocator: observed.locator }));
      if (detail.kind !== 'present' || !detail.snapshot.reviewRevision) throw new Error(`${forge.providerId} source revision missing`);
      const revision = detail.snapshot.reviewRevision;
      const entryAnchor = { kind: 'line' as const, filePath: 'src/index.ts', line: 12, side: 'after' as const };
      const entrySnapshot = { ...snapshot, fileLength: 20, commitSha: revision.headSha, diffContext: { side: 'after' as const,
        baseSha: revision.baseSha, headSha: revision.headSha, ...(forge.providerId === 'gitlab' ? { startSha: gitlabRow.diff_refs.start_sha } : {}) } };
      const makePlan = async (verdict: 'approve' | 'comment') => {
        const response = ReviewCommentCreateResponseV1Schema.parse(await action('reviews.comments.create', {
          workspace: { machineId: machine.target.machineId, path: machine.workspaceDir }, anchor: entryAnchor, snapshot: entrySnapshot,
          body, clientMutationId: randomUUID() }));
        return { target: { providerId: forge.providerId, configuredAccountId: forge.account.accountId,
          entryRef: { sourceId: `${forge.pluginId}/${forge.sourceId}`, ...observed.localRef }, subtarget: null },
          baseRevision: revision.baseSha, headRevision: revision.headSha,
          entries: [{ happierCommentId: response.comment.id, expectedServerRevision: response.comment.serverRevision, anchor: entryAnchor, snapshot: entrySnapshot, body }],
          verdict: { kind: verdict, body: 'The author has reviewed this change and explained the decision.' } } satisfies ReviewCommentPublicationPlanV1;
      };
      const publishPlan = async (plan: ReviewCommentPublicationPlanV1) => {
        const result = forge.parse(await invoke(forge.pluginId, forge.publishAction, { v: 1, instance, localRef: observed.localRef,
          ...(forge.providerId === 'bitbucket' ? { lastKnownLocator: observed.locator } : { routingToken: observed.locator.routingToken }),
          publicationPlan: plan }));
        if (result.kind !== 'settled') throw new Error(`${forge.providerId} publication rejected (${result.reason})`);
        return result.publication;
      };
      const outwardWrites = () => orderedProxy.entries().filter(row => row.method !== 'GET' && row.method !== 'HEAD');
      const assertEffects = (from: number, result: Awaited<ReturnType<typeof publishPlan>>, state: boolean) => {
        const written = effects.slice(from);
        expect(written.map(effect => `${effect.host}/${effect.phase}`)).toEqual((state ? ['entry', 'summary', 'state'] : ['entry', 'summary']).map(phase => `${forge.host}/${phase}`));
        expect(written[0]!.body).toBe(`${body}\n\n${formatReviewCommentPublicationMarkerV1('entry', result.entries[0]!.publicationCorrelationId)}`);
        if ('kind' in result.verdict) throw new Error('Missing authored verdict settlement');
        expect(written[1]!.body).toBe(`The author has reviewed this change and explained the decision.\n\n${formatReviewCommentPublicationMarkerV1('verdict', result.verdict.publicationCorrelationId)}`);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]!.outcome.kind).toBe('published');
      };
      // Same real Account and Reviews claim owner: known-good compound control,
      // comment-only summary, exact-marker summary answer loss, and finally an
      // accepted markerless state whose answer cannot be attributed on rejoin.
      for (const verdict of ['approve', 'comment'] as const) {
        const plan = await makePlan(verdict);
        const from = effects.length;
        const result = await publishPlan(plan);
        assertEffects(from, result, verdict === 'approve');
        expect(result.verdict).toMatchObject({ outcome: { kind: 'published' } });
        const beforeReentry = effects.length;
        const writesBeforeReentry = outwardWrites().length;
        expect(await publishPlan(plan)).toEqual(result);
        expect(effects).toHaveLength(beforeReentry);
        expect(outwardWrites()).toHaveLength(writesBeforeReentry);
        console.info('SCM_PUBLICATION_EVIDENCE', JSON.stringify({ provider: forge.providerId, scenario: verdict,
          sourceInstanceId: instance.instance.sourceInstanceId, localRef: observed.localRef,
          result, effects: effects.slice(from) }));
      }
      const summaryLostPlan = await makePlan('approve');
      const summaryFrom = effects.length;
      const priorSummaryLosses = lostSummaryAnswers;
      loseSummaryAnswer = true;
      const summaryResult = await publishPlan(summaryLostPlan);
      loseSummaryAnswer = false;
      assertEffects(summaryFrom, summaryResult, true);
      expect(lostSummaryAnswers).toBe(priorSummaryLosses + 1);
      expect(summaryResult.verdict).toMatchObject({ outcome: { kind: 'published' } });
      const beforeSummaryReentry = effects.length;
      const writesBeforeSummaryReentry = outwardWrites().length;
      expect(await publishPlan(summaryLostPlan)).toEqual(summaryResult);
      expect(effects).toHaveLength(beforeSummaryReentry);
      expect(outwardWrites()).toHaveLength(writesBeforeSummaryReentry);
      console.info('SCM_PUBLICATION_EVIDENCE', JSON.stringify({ provider: forge.providerId, scenario: 'summary-answer-lost',
        sourceInstanceId: instance.instance.sourceInstanceId, localRef: observed.localRef,
        result: summaryResult, effects: effects.slice(summaryFrom) }));
      const lostPlan = await makePlan('approve');
      const from = effects.length;
      const priorStateLosses = lostStateAnswers;
      loseStateAnswer = true;
      const result = await publishPlan(lostPlan);
      loseStateAnswer = false;
      assertEffects(from, result, true);
      expect(lostStateAnswers).toBe(priorStateLosses + 1);
      expect(acceptedStates.has(forge.host)).toBe(true);
      expect(result.verdict, JSON.stringify(result)).toMatchObject({ outcome: { kind: 'uncertain', externalRef: expect.any(String) } });
      // A later source read seeing the requested state cannot attribute the lost
      // state transition. Rejoin keeps the compound verdict uncertain, no write.
      const current = TriageGetResultV1Schema.parse(await invoke(forge.pluginId, forge.actions.get,
        { v: 1, instance, localRef: observed.localRef, lastKnownLocator: observed.locator }));
      expect(current.kind).toBe('present');
      const beforeReentry = effects.length;
      const writesBeforeReentry = outwardWrites().length;
      expect(await publishPlan(lostPlan)).toEqual(result);
      expect(effects).toHaveLength(beforeReentry);
      expect(outwardWrites()).toHaveLength(writesBeforeReentry);
      console.info('SCM_PUBLICATION_EVIDENCE', JSON.stringify({ provider: forge.providerId, scenario: 'state-answer-lost',
        sourceInstanceId: instance.instance.sourceInstanceId, localRef: observed.localRef,
        result, effects: effects.slice(from), requestedStatePresent: acceptedStates.has(forge.host) }));
    }
  } finally {
    try { await client?.close(); } finally {
      client = undefined;
      globalThis.fetch = originalFetch;
      undici.fetch = originalUndiciFetch;
      await dispatcher.close();
    }
  }
}, 0);
