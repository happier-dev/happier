import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { connectUiTriageActionClient,
  installPersonTransientConfirmationBoundary } from '@happier-tests/ui-action-client';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as connectedOutputs } from '@happier-dev/protocol/connect/configurationActionsV1';
import { TriageGetResultV1Schema, TriageListInstancesResultV1Schema,
  TriageSourceAdministrationActionResultV1Schema, TriageReadConfiguredSourceInstancesResultV1Schema,
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  type TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST as AZURE_MANIFEST } from '../../../plugins/scm-azure-devops/src/manifest';
import azurePackage from '../../../plugins/scm-azure-devops/package.json';
import { activate } from '../../../plugins/scm-azure-devops/src/accountRuntime';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS } from '../../../plugins/scm-azure-devops/src/triage/actions';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID, AZURE_DEVOPS_TRIAGE_PURPOSE } from '../../../plugins/scm-azure-devops/src/triage/descriptor';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from '../../../plugins/scm-azure-devops/src/triage/mutationActions';
import { AzureMutationResultV1Schema } from '../../../plugins/scm-azure-devops/src/triage/mutations/contracts';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from '../../../plugins/triage/src/actions/listEntriesProtocol';
import pullRequests from '../../../plugins/scm-azure-devops/src/triage/fixtures/pullRequests.authored.page1.json';
import connectionData from '../../../plugins/scm-azure-devops/src/triage/fixtures/connectionData.json';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

// QB-65: source-owned Azure REST 7.1 request-review, without a local repository,
// local diff, or a fixture-generated configured-source identity.
const run = createRunDirs({ runLabel: 'triage-writes-azure' });
const testDir = run.testDir(randomUUID());
const pluginId = AZURE_MANIFEST.id;
const source = { pluginId, localId: AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID };
const service = { pluginId, localId: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID };
const base = 'https://dev.azure.com/exampleorg';
const row = pullRequests.value[0]!;
const previousReviewers = [{ id: '19d9411e-9a1a-4b06-9f6c-7bd1b2b7cbc4', vote: 10 },
  { id: 'a4c955bd-0bbd-4d02-89b8-70fc68a406f5', vote: -5 }];
const addedReviewer = '207628ef-54cc-4e54-ae32-b6e4c873760b';
const lostReviewer = 'ac75bc2d-7d90-4dd0-a2b2-9189ae98447b';
let reviewers = [...previousReviewers];
let currentHead = row.lastMergeSourceCommit.commitId;
let mode: 'apply' | 'lag' | 'loss' | 'forbidden' = 'apply';
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let provider: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let restoreConfirmation: (() => void) | undefined;
let accountSecret: Uint8Array;
let machineId = '';
let dispatcher: { close(): Promise<void> } | undefined;
let restoreFetch: (() => void) | undefined;

beforeAll(async () => {
  provider = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['dev.azure.com'],
    responseForRequest(request) {
      const url = new URL(request.path, base);
      const path = url.pathname.toLowerCase();
      const observedRow = () => ({ ...row, reviewers: reviewers.map(reviewer => ({ ...reviewer,
        displayName: `Reviewer ${reviewer.id}`, isRequired: true })), lastMergeSourceCommit: { commitId: currentHead } });
      if (path.endsWith('/_apis/connectiondata')) return { statusCode: 200, body: connectionData };
      if (path.endsWith('/_apis/projects')) return { statusCode: 200, body: { count: 1, value: [row.repository.project] } };
      if (path.endsWith('/_apis/git/repositories')) return { statusCode: 200, body: { count: 1, value: [row.repository] } };
      if (path.endsWith('/pullrequests')) return { statusCode: 200, body: { count: 1, value: [observedRow()] } };
      if (path.endsWith(`/pullrequests/${row.pullRequestId}`)) {
        if (mode === 'forbidden') return { statusCode: 403, body: { message: 'Pull request permission withdrawn' } };
        return { statusCode: 200, body: observedRow() };
      }
      if (path.endsWith(`/pullrequests/${row.pullRequestId}/reviewers`) && request.method === 'POST') {
        if (mode === 'apply') reviewers = [...reviewers, { id: addedReviewer, vote: 0 }];
        // The response intentionally claims no reviewer outcome; confirmation must read the PR.
        return { statusCode: 200, body: [] };
      }
      return { statusCode: 404, body: { message: 'No such Azure fixture route' } };
    } });
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
  const auth = await createTestAuth(server.baseUrl);
  accountSecret = auth.accountSigningSeed;
  const homeDir = join(testDir, 'daemon-home');
  machineId = (await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' })).machineId;
  daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
  } });
}, 0);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [closeClient, () => daemon?.stop(), () => server?.stop(), () => dispatcher?.close(),
    () => provider?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  restoreFetch?.();
  restoreConfirmation?.();
  if (failures.length) throw new AggregateError(failures, 'Azure journey cleanup failed');
});

async function closeClient() {
  try { await client?.close(); } finally { client = undefined; }
}

function context() {
  if (!client) throw new Error('Azure Account client unavailable');
  return { surface: 'ui' as const, authority: 'present_user' as const,
    actionCaller: { kind: 'host' as const }, serverId: client.serverId };
}

async function invoke(localId: string, input: unknown, write = false) {
  const action = { pluginId, localId };
  const result = write ? await client!.executeConfirmed('action.invoke', { action, input }, context())
    : await client!.execute('action.invoke', { action, input }, context());
  if (!result.ok) throw new Error(`Azure Action ${localId} refused (${result.errorCode})`);
  return result.result;
}

async function connectAzure() {
  const connected = await connectUiTriageActionClient({ serverUrl: server!.baseUrl, accountSecret,
    additionalPlugins: [{ packageName: azurePackage.name, manifest: AZURE_MANIFEST, activate }] });
  client = connected;
  await waitFor(() => client!.isAccountReady() && client!.isMachineControlReady(machineId),
    { context: 'Azure Account and daemon readiness' });
  return connected;
}

it('QB-65 adds only selected identities, confirms votes and membership, and never blindly retries a lost reviewer POST', async () => {
  restoreConfirmation = installPersonTransientConfirmationBoundary();
  // This is the HTTP socket boundary. Every host decision, authentication,
  // registration, credential materialization and Azure decoder remains real.
  const requireCli = createRequire(join(repoRootDir(), 'apps/cli/package.json'));
  const undici = requireCli('undici/index.js') as {
    ProxyAgent: new (input: { uri: string; requestTls: { ca: Buffer } }) => { close(): Promise<void> };
    fetch(input: string, init?: RequestInit & { dispatcher: unknown }): Promise<Response>;
  };
  dispatcher = new undici.ProxyAgent({ uri: provider!.url, requestTls: { ca: await readFile(provider!.caCertPath) } });
  const originalFetch = globalThis.fetch.bind(globalThis);
  const providerFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== 'dev.azure.com') return originalFetch(input, init);
    const response = await undici.fetch(url, { ...init, dispatcher });
    if (mode === 'loss' && init?.method === 'POST') throw new TypeError('Azure fixture connection lost after provider accepted request');
    return response;
  };
  const triageClient = await connectAzure();
  const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch);
  restoreFetch = () => fetchBoundary.mockRestore();
  const begun = await client!.executeConfirmed('connectedServices.authentication.beginConnect', { service, modeId: 'manual' }, context());
  expect(begun).toMatchObject({ ok: true });
  if (!begun.ok) throw new Error(`Azure Connect refused (${begun.errorCode})`);
  const attempt = connectedOutputs['connectedServices.authentication.beginConnect'].parse(begun.result);
  if (attempt.status !== 'configurationRequired') throw new Error(`Azure Connect did not request configuration (${attempt.status})`);
  const staged = await client!.executeConfirmed('connectedServices.configuration.replace', {
    target: { kind: 'attempt', attemptId: attempt.attemptId }, expectedRevision: null, values: { base }, secretValues: {},
  }, context());
  if (!staged.ok) throw new Error(`Azure configuration refused (${staged.errorCode})`);
  const configuration = connectedOutputs['connectedServices.configuration.replace'].parse(staged.result);
  expect(await client!.executeConfirmed('connectedServices.authentication.continueConnect', {
    attemptId: attempt.attemptId, expectedConfigurationRevision: configuration.revision,
  }, context())).toMatchObject({ ok: true, result: { status: 'awaitingManual' } });
  const connected = await client!.executeConfirmed('connectedServices.authentication.submitManual', {
    attemptId: attempt.attemptId, fields: { token: 'constructed-azure-https-fixture-pat' },
  }, context());
  expect(connected).toMatchObject({ ok: true });
  if (!connected.ok) throw new Error(`Azure credential submission refused (${connected.errorCode})`);
  const account = connectedOutputs['connectedServices.authentication.submitManual'].parse(connected.result);
  expect(account.status).toBe('connected');
  if (account.status !== 'connected') throw new Error(`Azure Account connection not established (${account.status})`);
  const selected = await triageClient.executeConfirmed('connectedServices.purposes.default.set', {
    purpose: { consumer: { pluginId, localId: AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances }, purpose: AZURE_DEVOPS_TRIAGE_PURPOSE },
    target: { kind: 'account', account: account.account },
  }, context());
  expect(selected).toMatchObject({ ok: true, result: { applied: true } });
  const discovered = TriageListInstancesResultV1Schema.parse(await invoke(AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances, { v: 1 }));
  expect(discovered.kind).toBe('complete');
  if (discovered.kind !== 'complete') throw new Error(`Azure discovery incomplete (${discovered.kind})`);
  const draft = discovered.candidates.find(candidate => candidate.localInstanceKey === base);
  if (!draft) throw new Error('Connected Azure deployment was not discovered');
  expect(draft.binding).toMatchObject({ account: account.account });
  const created = await triageClient.executeConfirmed('action.invoke', { action: TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    input: { v: 1, kind: 'create', source, draft } }, context());
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error(`Azure source save refused (${created.errorCode})`);
  const saved = TriageSourceAdministrationActionResultV1Schema.parse(created.result);
  if (saved.kind !== 'active') throw new Error(`Azure source not created (${saved.kind})`);
  const read = await triageClient.execute('action.invoke', { action: TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    input: { v: 1, source } }, context());
  expect(read).toMatchObject({ ok: true });
  if (!read.ok) throw new Error(`Azure configured source read refused (${read.errorCode})`);
  const configured = TriageReadConfiguredSourceInstancesResultV1Schema.parse(read.result);
  if (configured.kind !== 'read') throw new Error(`Azure source read unavailable (${configured.kind})`);
  const instance: TriageConfiguredSourceInstanceV1 | undefined = configured.instances.find(candidate =>
    candidate.configured.instance.sourceInstanceId === saved.sourceInstanceId)?.configured;
  if (!instance) throw new Error('Saved Azure instance was not returned by its owner');
  const listed = await triageClient.execute('action.invoke', {
    action: { pluginId: TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1.pluginId, localId: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 },
    input: { v: 1, sources: { kind: 'allConfigured' }, limit: 20, order: 'newest' },
  }, context());
  if (!listed.ok) throw new Error(`Azure aggregate read refused (${listed.errorCode})`);
  const selectedRow = TriageListEntriesResultV1Schema.parse(listed.result).window.rows.find(candidate =>
    candidate.observation.sourceInstanceId === instance.instance.sourceInstanceId
    && candidate.entryRef.entryId === String(row.pullRequestId));
  const observed = selectedRow?.observation.outcome;
  if (!selectedRow || observed?.kind !== 'present' || !observed.locator.routingToken) {
    throw new Error('Azure source did not produce an entry route');
  }
  const { source: _source, ...localRef } = selectedRow.entryRef;
  const target = { v: 1, instance, localRef, routingToken: observed.locator.routingToken };
  const initial = TriageGetResultV1Schema.parse(await invoke(AZURE_DEVOPS_TRIAGE_ACTION_IDS.get,
    { v: 1, instance, localRef, lastKnownLocator: observed.locator }));
  expect(initial.kind).toBe('present');
  if (initial.kind !== 'present' || !initial.snapshot.reviewRevision) throw new Error('Azure authoritative source revision missing');
  const input = { ...target, observedSourceCommitId: initial.snapshot.reviewRevision.headSha, reviewerIds: [addedReviewer] };
  const before = provider!.entries().length;
  const result = AzureMutationResultV1Schema.parse(await invoke(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview, input, true));
  expect(result).toMatchObject({ kind: 'applied', observation: { kind: 'present' } });
  const requests = provider!.entries().slice(before);
  const writes = requests.filter(request => request.method !== 'GET');
  expect(writes.map(request => ({ method: request.method, path: new URL(request.path, base).pathname,
    body: JSON.parse(request.body) }))).toEqual([{ method: 'POST',
    path: `/exampleorg/Payments/_apis/git/repositories/gateway/pullRequests/${row.pullRequestId}/reviewers`, body: [{ id: addedReviewer }] }]);
  const writeIndex = requests.findIndex(request => request.method === 'POST');
  const isTargetRead = (request: typeof requests[number]) => request.method === 'GET'
    && new URL(request.path, base).pathname.toLowerCase().endsWith(`/pullrequests/${row.pullRequestId}`);
  expect(requests.slice(0, writeIndex).filter(isTargetRead)).toHaveLength(1);
  expect(requests.slice(writeIndex + 1).filter(isTargetRead)).toHaveLength(1);
  expect(reviewers).toEqual([...previousReviewers, { id: addedReviewer, vote: 0 }]);
  expect(await invoke(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview, { ...input, reviewerIds: [previousReviewers[0]!.id] }, true))
    .toMatchObject({ kind: 'refused', reason: 'reviewer-already-present' });
  currentHead = '0f9e8d7c6b5a49382716059f8e7d6c5b4a392817';
  expect(await invoke(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview, { ...input, reviewerIds: [lostReviewer] }, true))
    .toMatchObject({ kind: 'refused', reason: 'head-advanced' });
  currentHead = row.lastMergeSourceCommit.commitId;
  mode = 'forbidden';
  expect(await invoke(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview, { ...input, reviewerIds: [lostReviewer] }, true))
    .toMatchObject({ kind: 'unavailable', failure: { class: 'permission' } });
  expect(provider!.entries().slice(before).filter(request => request.method !== 'GET')).toHaveLength(1);
  mode = 'lag';
  expect(await invoke(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview, { ...input, reviewerIds: [lostReviewer] }, true))
    .toMatchObject({ kind: 'pending', observation: { kind: 'present' } });
  mode = 'loss';
  const lossBefore = provider!.entries().length;
  expect(await invoke(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview, { ...input, reviewerIds: [lostReviewer] }, true))
    .toMatchObject({ kind: 'uncertain', observation: { kind: 'present' } });
  const afterLoss = provider!.entries().slice(lossBefore);
  expect(afterLoss.filter(request => request.method !== 'GET')).toHaveLength(1);
  expect(afterLoss.at(-1)?.method).toBe('GET');
  expect(reviewers).toEqual([...previousReviewers, { id: addedReviewer, vote: 0 }]);
});
