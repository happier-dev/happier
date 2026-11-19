import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import {
  TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  TriageGetResultV1Schema,
  TriageListInstancesResultV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageSourceAdministrationActionResultV1Schema,
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import {
  GITLAB_CONNECTED_ACCOUNT_ID,
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_ACTION_IDS,
  GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../../plugins/scm-gitlab/src/triage/contribution';
import { GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID } from '../../../plugins/scm-gitlab/src/auth/connectedAccountRuntime';
import { buildGitlabEntryIdentity } from '../../../plugins/scm-gitlab/src/triage/identity';
import { normalizeGitlabConfiguredBaseUrl } from '../../../plugins/scm-gitlab/src/triage/origin';
import {
  GitlabIssueAssignResultV1Schema,
  GitlabIssueLabelResultV1Schema,
  GitlabMergeRequestReviewerChangeResultV1Schema,
} from '../../../plugins/scm-gitlab/src/triage/mutations/contracts';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

// QB-66: real public Actions, Postgres, and daemon; only GitLab HTTPS is a fixture.
// The provider vectors match the bundled GitLab REST v4 / GraphQL contracts in
// scm-gitlab's memberDeltas.test.ts. An issue and MR deliberately share project/IID.
const base = 'https://gitlab.example.test/Corp/GitLab';
const prefix = '/Corp/GitLab';
const project = 'group/project';
const iid = '7';
const revision = '2026-08-12T09:00:00.000Z';
const head = 'a'.repeat(40);
const token = 'constructed-gitlab-write-journey-token';
const tokenFingerprint = `sha256:${createHash('sha256').update(token).digest('hex')}`;
const source = { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID };
const service = { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_CONNECTED_ACCOUNT_ID };
const issuePath = `${prefix}/api/v4/projects/${encodeURIComponent(project)}/issues/${iid}`;
const mrPath = `${prefix}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
const reviewers = ['alice'];
const assignees = ['alice'];
const labels = ['bug'];
let writeNumber = 0;
let denial: 'read' | 'write' | undefined;
let missingReviewers = false;

function row(kind: 'issue' | 'merge-request') {
  return { iid: Number(iid), project_id: 3, state: 'opened', title: `${kind} same IID`,
    updated_at: revision, created_at: revision, references: { full: `${project}${kind === 'issue' ? '#' : '!'}${iid}` },
    web_url: `${base}/${project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}`,
    author: { id: 11, username: 'alice', name: 'Alice' },
    ...(kind === 'issue' ? { assignees: assignees.map(username => ({ username })), labels: [...labels] }
      : { draft: false, sha: head, ...(missingReviewers ? {} : { reviewers: reviewers.map(username => ({ username })) }) }),
  };
}

const run = createRunDirs({ runLabel: 'triage-writes-gitlab' });
const testDir = run.testDir(randomUUID());
let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
let gitlab: Awaited<ReturnType<typeof startConnectedAccountTlsRecordingProxy>> | undefined;
let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let restoreConfirmation: (() => void) | undefined;
let restoreProviderFetch: (() => Promise<void>) | undefined;
let restoreGlobalFetch: (() => void) | undefined;
let providerFetch: typeof globalThis.fetch;
let accountSecret: Uint8Array;
let machineId = '';

beforeAll(async () => {
  gitlab = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['gitlab.example.test'],
    responseForRequest(request) {
      const path = new URL(request.path, base).pathname;
      if (request.authorizationFingerprint !== tokenFingerprint) {
        return { statusCode: 401, body: { message: 'Constructed GitLab credential required' } };
      }
      if (request.method === 'GET' && path === `${prefix}/api/v4/user`) {
        return { statusCode: 200, body: { id: 11, username: 'alice', name: 'Alice' } };
      }
      if (request.method === 'GET' && (path === issuePath || path === mrPath)) {
        if (denial === 'read') return { statusCode: 403, body: { message: 'Constructed project read refusal' } };
        return { statusCode: 200, body: row(path === issuePath ? 'issue' : 'merge-request') };
      }
      if (request.method === 'GET' && path === `${mrPath}/pipelines`) return { statusCode: 200, body: [] };
      if (request.method === 'POST' && path === `${prefix}/api/graphql`) {
        if (denial === 'write') return { statusCode: 403, body: { message: 'Constructed project write refusal' } };
        const body = JSON.parse(request.body) as { query: string; variables: {
          operationMode: string; reviewerUsernames?: string[]; assigneeUsernames?: string[];
        } };
        const isReviewer = body.query.includes('mergeRequestSetReviewers');
        const names = isReviewer ? reviewers : assignees;
        const selected = (isReviewer ? body.variables.reviewerUsernames : body.variables.assigneeUsernames) ?? [];
        // A collaborator changes GitLab after preflight, before applying this delta.
        names.push(`concurrent-${++writeNumber}`);
        const changed = body.variables.operationMode === 'APPEND' ? [...new Set([...names, ...selected])]
          : body.variables.operationMode === 'REMOVE' ? names.filter(name => !selected.includes(name)) : selected;
        names.splice(0, names.length, ...changed);
        return { statusCode: 200, body: { data: { [isReviewer ? 'mergeRequestSetReviewers' : 'issueSetAssignees']: { errors: [] } } } };
      }
      if (request.method === 'PUT' && path === issuePath) {
        if (denial === 'write') return { statusCode: 403, body: { message: 'Constructed project write refusal' } };
        const body = JSON.parse(request.body) as { add_labels?: string; remove_labels?: string; labels?: string };
        labels.push(`concurrent-${++writeNumber}`);
        const changed = body.add_labels !== undefined ? [...new Set([...labels, ...body.add_labels.split(',')])]
          : body.remove_labels !== undefined ? labels.filter(name => !body.remove_labels!.split(',').includes(name))
            : (body.labels ?? '').split(',');
        labels.splice(0, labels.length, ...changed);
        return { statusCode: 200, body: row('issue') };
      }
      return { statusCode: 404, body: { message: 'Unexpected GitLab fixture route' } };
    },
  });
  // The Account HTTP owner uses runtimeFetch; only its external HTTPS socket is
  // redirected, preserving real admission, credential materialization and HTTP.
  const undici: typeof import('undici') = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url))('undici/index.js');
  const originalFetch = globalThis.fetch.bind(globalThis);
  const dispatcher = new undici.ProxyAgent({ uri: gitlab.url, requestTls: { ca: await readFile(gitlab.caCertPath) } });
  providerFetch = (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input));
    const providerInit = { ...init, dispatcher } satisfies RequestInit & { dispatcher: typeof dispatcher };
    return originalFetch(input, address.hostname === 'gitlab.example.test' ? providerInit : init);
  };
  restoreProviderFetch = async () => {
    restoreGlobalFetch?.();
    await dispatcher.close();
  };
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions,
    HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
  const auth = await createTestAuth(server.baseUrl);
  accountSecret = auth.accountSigningSeed;
  const homeDir = join(testDir, 'daemon-home');
  machineId = (await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' })).machineId;
  daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
    ...sanitizeCliTestEnv(process.env), NODE_OPTIONS: sourceOptions, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
    HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
  } });
}, 0);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => client?.close(), () => daemon?.stop(),
    () => server?.stop(), () => gitlab?.stop(), () => restoreProviderFetch?.()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  restoreConfirmation?.();
  if (failures.length) throw new AggregateError(failures, 'GitLab write journey cleanup failed');
});

async function action(id: ActionId, input: unknown) {
  if (!client) throw new Error('GitLab Account client unavailable');
  const result = await client.executeConfirmed(id, input, { surface: 'ui', authority: 'present_user',
    actionCaller: { kind: 'host' }, serverId: client.serverId });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`GitLab journey ${id} refused (${result.errorCode})`);
  return result.result;
}

const invoke = (pluginId: string, localId: string, input: unknown) => action('action.invoke', {
  action: { pluginId, localId }, input,
});

it('QB-66 preserves concurrent siblings across all six configured GitLab deltas and kind-routes the same project/IID', async () => {
  const { installPersonTransientConfirmationBoundary, connectUiTriageActionClient } = await import('@happier-tests/ui-action-client');
  restoreConfirmation = installPersonTransientConfirmationBoundary();
  const [{ PLUGIN_MANIFEST }, { activate }, { default: gitlabPackage }] = await Promise.all([
    import('../../../plugins/scm-gitlab/src/manifest'), import('../../../plugins/scm-gitlab/src/accountRuntime'),
    import('../../../plugins/scm-gitlab/package.json'),
  ]);
  client = await connectUiTriageActionClient({ serverUrl: server!.baseUrl, accountSecret,
    additionalPlugins: [{ packageName: gitlabPackage.name, manifest: PLUGIN_MANIFEST, activate }] });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch);
  restoreGlobalFetch = () => fetch.mockRestore();
  await waitFor(() => client!.isAccountReady() && client!.isMachineControlReady(machineId), { context: 'GitLab Account and daemon ready' });
  const modeId = GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID;
  const draftAttempt = ConnectedAccountAttemptResponseSchema.parse(await action('connectedServices.authentication.beginConnect', {
    service, modeId,
  }));
  expect(draftAttempt).toMatchObject({ status: 'configurationRequired' });
  if (draftAttempt.status !== 'configurationRequired') throw new Error(`GitLab Connect settled ${draftAttempt.status}`);
  const configured = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace'].parse(
    await action('connectedServices.configuration.replace', { target: { kind: 'attempt', attemptId: draftAttempt.attemptId }, expectedRevision: null,
      values: { baseUrl: base }, secretValues: {} }));
  const begun = ConnectedAccountAttemptResponseSchema.parse(await action('connectedServices.authentication.continueConnect', {
    attemptId: draftAttempt.attemptId, expectedConfigurationRevision: configured.revision,
  }));
  expect(begun).toMatchObject({ status: 'awaitingManual' });
  if (begun.status !== 'awaitingManual') throw new Error(`GitLab Connect settled ${begun.status}`);
  const connected = ConnectedAccountAttemptResponseSchema.parse(await action('connectedServices.authentication.submitManual', {
    attemptId: begun.attemptId, fields: { token },
  }));
  expect(connected).toMatchObject({ status: 'connected' });
  if (connected.status !== 'connected') throw new Error(`GitLab credential settled ${connected.status}`);
  expect(await action('connectedServices.purposes.default.set', {
    purpose: { consumer: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_ACTION_IDS.listInstances },
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE },
    target: { kind: 'account', account: connected.account },
  })).toMatchObject({ applied: true });
  const discovered = TriageListInstancesResultV1Schema.parse(await invoke(GITLAB_PLUGIN_ID, GITLAB_TRIAGE_ACTION_IDS.listInstances, { v: 1 }));
  expect(discovered).toMatchObject({ kind: 'complete', failures: [] });
  if (discovered.kind !== 'complete') throw new Error('GitLab discovery did not list its connected deployment');
  const draft = discovered.candidates.find(candidate => candidate.localInstanceKey === base);
  expect(draft?.binding).toMatchObject({ account: connected.account });
  if (!draft) throw new Error('GitLab source did not mint the self-managed candidate');

  const created = TriageSourceAdministrationActionResultV1Schema.parse(await invoke(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, { v: 1, kind: 'create', source, draft }));
  expect(created).toMatchObject({ kind: 'active' });
  if (created.kind !== 'active') throw new Error('GitLab configured source was not persisted');
  const listed = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1, source }));
  if (listed.kind !== 'read') throw new Error('Configured GitLab source read refused');
  const instance = TriageConfiguredSourceConnectedAccountInstanceV1Schema.parse(listed.instances.find(candidate =>
    candidate.configured.instance.sourceInstanceId === created.sourceInstanceId)?.configured);
  expect(instance).toMatchObject({ localInstanceKey: base, binding: { account: connected.account } });
  const origin = normalizeGitlabConfiguredBaseUrl(base);
  if (!origin) throw new Error('GitLab fixture base is invalid');
  function localRef(kindId: 'issue' | 'merge-request') {
    const identity = buildGitlabEntryIdentity({ kindId, origin: origin!, row: row(kindId) });
    if (identity.kind !== 'built') throw new Error('GitLab fixture identity invalid');
    return identity.identity;
  }
  const read = async (kindId: 'issue' | 'merge-request') => {
    const result = TriageGetResultV1Schema.parse(await invoke(GITLAB_PLUGIN_ID, GITLAB_TRIAGE_ACTION_IDS.get, {
      v: 1, instance, localRef: localRef(kindId), lastKnownLocator: { v: 1, routingToken: project },
    }));
    expect(result).toMatchObject({ kind: 'present', localRef: { kindId, entryId: iid },
      snapshot: { title: `${kindId} same IID` } });
    if (result.kind !== 'present') throw new Error(`GitLab ${kindId} get settled ${result.kind}`);
    return result;
  };
  expect((await read('issue')).localRef).not.toEqual((await read('merge-request')).localRef);

  for (const member of ['reviewer', 'assignee', 'label'] as const) {
    for (const operation of ['add', 'remove'] as const) {
      const kindId = member === 'reviewer' ? 'merge-request' : 'issue';
      const observed = await read(kindId);
      const start = gitlab!.entries().length;
      const prior = [...(member === 'reviewer' ? reviewers : member === 'assignee' ? assignees : labels)];
      const input = { v: 1, instance, localRef: observed.localRef, routingToken: observed.locator.routingToken,
        operation, ...(member === 'reviewer' ? { observedHeadSha: observed.nativeRevision, reviewerUsernames: ['bob'] }
          : { observedRevision: observed.nativeRevision, ...(member === 'assignee' ? { assigneeUsernames: ['bob'] } : { labelNames: ['release'] }) }) };
      const raw = await invoke(GITLAB_PLUGIN_ID, member === 'reviewer' ? GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange
        : member === 'assignee' ? GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign : GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel, input);
      const result = member === 'reviewer' ? GitlabMergeRequestReviewerChangeResultV1Schema.parse(raw)
        : member === 'assignee' ? GitlabIssueAssignResultV1Schema.parse(raw) : GitlabIssueLabelResultV1Schema.parse(raw);
      const selected = member === 'label' ? 'release' : 'bob';
      const expectedNames = [...prior.filter(name => operation === 'add' || name !== selected), `concurrent-${writeNumber}`,
        ...(operation === 'add' ? [selected] : [])];
      expect(result).toMatchObject({ kind: member === 'reviewer' ? 'reviewersChanged' : member === 'assignee' ? 'assigneesChanged' : 'labelsChanged',
        item: { [member === 'reviewer' ? 'reviewerUsernames' : member === 'assignee' ? 'assigneeUsernames' : 'labelNames']: expectedNames } });
      const requests = gitlab!.entries().slice(start);
      const writes = requests.filter(request => request.method !== 'GET');
      expect(writes).toHaveLength(1);
      const write = writes[0];
      expect(requests[0]).toMatchObject({ method: 'GET', path: kindId === 'issue' ? issuePath : mrPath });
      expect(requests.at(-1)).toMatchObject({ method: 'GET', path: kindId === 'issue' ? issuePath : mrPath });
      expect(write).toMatchObject({ method: member === 'label' ? 'PUT' : 'POST',
        path: member === 'label' ? issuePath : `${prefix}/api/graphql` });
      expect(JSON.parse(write.body)).toMatchObject(member === 'label' ? { [operation === 'add' ? 'add_labels' : 'remove_labels']: selected }
        : { variables: { projectPath: project, iid, operationMode: operation === 'add' ? 'APPEND' : 'REMOVE',
          [member === 'reviewer' ? 'reviewerUsernames' : 'assigneeUsernames']: [selected] } });
      expect(write.body).not.toMatch(/REPLACE|assignee_ids|reviewer_ids|"labels"/u);
    }
  }

  const observed = await read('issue');
  const labelInput = { v: 1, instance, localRef: observed.localRef, routingToken: observed.locator.routingToken,
    observedRevision: observed.nativeRevision, operation: 'add', labelNames: ['denied-label'] };
  for (const phase of ['read', 'write'] as const) {
    denial = phase;
    const start = gitlab!.entries().length;
    const result = GitlabIssueLabelResultV1Schema.parse(await invoke(GITLAB_PLUGIN_ID, GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel, labelInput));
    expect(result).toMatchObject(phase === 'read' ? { kind: 'unavailable', failure: { class: 'permission', code: 'forbidden' } }
      : { kind: 'refused', dispatched: true, reason: 'mutationRejected', failure: { class: 'permission', code: 'forbidden' } });
    expect(gitlab!.entries().slice(start).filter(request => request.method !== 'GET')).toHaveLength(phase === 'read' ? 0 : 1);
  }
  denial = undefined;
  const beforeReplacement = gitlab!.entries().length;
  const replacement = await client!.executeConfirmed('action.invoke', {
    action: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange },
    input: { v: 1, instance, localRef: localRef('merge-request'), routingToken: project,
      observedHeadSha: head, operation: 'replace', reviewerUsernames: ['replacement-reviewer'] },
  }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: client!.serverId });
  expect(replacement).toMatchObject({ ok: false, errorCode: 'plugin_action_input_schema_invalid' });
  expect(gitlab!.entries().length).toBe(beforeReplacement);
  const beforeStale = gitlab!.entries().length;
  expect(GitlabIssueLabelResultV1Schema.parse(await invoke(GITLAB_PLUGIN_ID, GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel,
    { ...labelInput, observedRevision: '2026-08-11T09:00:00.000Z' }))).toMatchObject({ kind: 'reconfirmationRequired', observed: { revision } });
  expect(gitlab!.entries().slice(beforeStale).filter(request => request.method !== 'GET')).toEqual([]);
  missingReviewers = true;
  const beforeUnavailable = gitlab!.entries().length;
  expect(GitlabMergeRequestReviewerChangeResultV1Schema.parse(await invoke(GITLAB_PLUGIN_ID,
    GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange, { v: 1, instance, localRef: localRef('merge-request'),
      routingToken: project, observedHeadSha: head, operation: 'add', reviewerUsernames: ['unavailable-reviewer'] })))
    .toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'gitlab-member-list-unavailable' } });
  expect(gitlab!.entries().slice(beforeUnavailable).filter(request => request.method !== 'GET')).toEqual([]);
  expect(gitlab!.entries().every(request => request.path.startsWith(`${prefix}/api/`))).toBe(true);
  expect(gitlab!.entries().every(request => request.authorizationFingerprint === tokenFingerprint)).toBe(true);
  expect(gitlab!.entries().some(request => /\/version(?:\?|$)/u.test(request.path))).toBe(false);
  expect(gitlab!.connectTargets().every(target => target === 'gitlab.example.test:443')).toBe(true);
}, 0);
