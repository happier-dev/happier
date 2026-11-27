import {
  REPOSITORY_KEY, OBSERVED_HEAD, OBSERVED_BASE, ADVANCED_HEAD, CONFIGURED_ACCOUNT, configuredInstance, PULL_REQUEST_REF, stateInput, previewStatusInput, previewStatusTransport, pullRequestBody, json, PULL_REQUEST_PATH, REPOSITORY_PATH,
} from './testkit/githubMutation.test-support.js';
import type { ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { pluginActionRequiresPresentUserIntent, PluginActionContributionV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate, activateAccount } from '../activate.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/plugin-sdk/actions';
import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1, readTriageSourceOperationOutcomeV1 } from '@happier-dev/triage-protocol/v1';

import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';
import { GithubPreviewResultV1Schema } from './detail/contracts.js';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
} from './__fixtures__/githubResponses.js';
import {
  GithubIssueDeltaResultV1Schema,
  GithubIssueCommentResultV1Schema,
  GithubCommentEditResultV1Schema,
  GithubCommentCreateResultV1Schema,
  GithubPullRequestMarkReadyActionResultV1Schema,
  GithubPullRequestMergeActionResultV1Schema,
  GithubPullRequestNativeMergeActionResultV1Schema,
  GithubPullRequestEnqueueInputV1Schema,
  GithubPullRequestDequeueInputV1Schema,
  GithubPullRequestAutoMergeSetInputV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestReviewPublicationResultV1Schema,
  GithubPullRequestReviewCommentCreateResultV1Schema,
  GithubPullRequestStateResultV1Schema,
  GithubPullRequestThreadResolutionResultV1Schema,
  GithubPullRequestThreadReplyResultV1Schema,
  GithubPullRequestUpdateBranchResultV1Schema,
} from './mutations/contracts.js';
import {
  addGithubIssueAssigneesAction,
  addGithubIssueLabelsAction,
  addGithubPullRequestReviewersAction,
  closeGithubIssueAction,
  closeGithubPullRequestAction,
  createGithubIssueCommentAction,
  createGithubPullRequestReviewCommentAction,
  editGithubCommentAction,
  createGithubCommentAction,
  markGithubPullRequestReadyAction,
  mergeGithubPullRequestAction,
  removeGithubIssueAssigneesAction,
  removeGithubIssueLabelAction,
  removeGithubPullRequestReviewersAction,
  publishGithubPullRequestReviewAction,
  reopenGithubIssueAction,
  reopenGithubPullRequestAction,
  replyToGithubPullRequestThreadAction,
  setGithubPullRequestThreadResolutionAction,
  updateGithubPullRequestBranchAction,
} from './mutationOperations.js';
import {
  createStubGithubTransport,
  readRecordedJsonBody,
  type RecordedGithubRequest,
  type StubGithubTransport,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

/**
 * The GitHub pull-request writes, driven through the real Action entrypoints.
 *
 * The mock sits at the genuine system boundary — the host HTTP service and the
 * generic Connected Accounts service — so the real API client, the real
 * admission, the real preflight read and the real failure classifier all run
 * beneath every case. No network call is made, and nothing in `triage/` is
 * stubbed.
 *
 * What these assert is what actually protects a user: the exact bytes sent, the
 * requests NOT sent, and the refusal to claim an effect the confirming read did
 * not observe.
 */

describe('GitHub preview-status registered Action', () => {
  async function invoke(input: unknown, stub: StubGithubTransport) {
    const actionId = 'github/pull-request/preview-status';
    const declaration = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === actionId);
    expect(declaration, 'own-server preview status must have one canonical Forge Action').toBeDefined();
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      return await testkit.invokeAction(actionId, defineProtocolJsonValue().parse(input));
    } finally {
      await testkit.dispose();
    }
  }

  it.each([
    [OBSERVED_HEAD, 'ready', 'https://pr-1284.example.test/app'],
    [OBSERVED_HEAD.toUpperCase(), 'ready', 'https://pr-1284.example.test/app'],
    [ADVANCED_HEAD, 'outdated', null],
  ] as const)('reads the exact PR preview at head %s through the registered private projection', async (headSha, state, targetUrl) => {
    const stub = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active', domainPath: '/app', headSha });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      expect(await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }))
        .toMatchObject({ kind: 'preview', headSha, previews: [{ kind: 'preview', state,
          environmentId: 'preview-child', deploymentId: 'preview-teardown', servingSha: OBSERVED_HEAD, targetUrl }] });
      expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
    } finally { await testkit.dispose(); }
  });

  it.each([
    ['deploy', 'running', 'deploying'], ['teardown', 'running', 'deploying'],
    ['deploy', 'failed', 'failed'], ['teardown', 'failed', 'failed'],
    ['deploy', 'cancelled', 'failed'], ['teardown', 'cancelled', 'failed'],
  ] as const)('retains receipt operation %s for a %s preview run', async (operation, receiptState, state) => {
    const stub = previewStatusTransport({ operation, receiptState, pullRequestState: 'open' });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      expect(await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }))
        .toMatchObject({ kind: 'preview', previews: [{ kind: 'preview', operation, state, targetUrl: null }] });
    } finally { await testkit.dispose(); }
  });

  it.each([false, true])('preserves two preview templates and their URLs with first child unavailable=%s', async unavailableFirstPreview => {
    const stub = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active',
      multiplePreviews: true, unavailableFirstPreview });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      expect(await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }))
        .toMatchObject({ kind: 'preview', headSha: OBSERVED_HEAD, previews: [
          unavailableFirstPreview ? { kind: 'unavailable', environmentId: 'preview-child', failure: expect.objectContaining({ code: expect.any(String) }) }
            : { kind: 'preview', environmentId: 'preview-child', state: 'ready', targetUrl: 'https://pr-1284.example.test/' },
          { kind: 'preview', environmentId: 'preview-second', state: 'ready', targetUrl: 'https://second.example.test/' },
        ] });
      expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
    } finally { await testkit.dispose(); }
  });

  it('preserves the canonical preview query denial code and class', async () => {
    const stub = previewStatusTransport({ previewQueryError: 'deployment_access_denied' });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      expect(await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }))
        .toMatchObject({ kind: 'unavailable', failure: { class: 'permission', code: 'deployment_access_denied' } });
    } finally { await testkit.dispose(); }
  });

  it('preserves the canonical preview PR observation denial code and class', async () => {
    const stub = previewStatusTransport({ previewReadDenied: true });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      expect(await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }))
        .toMatchObject({ kind: 'unavailable', failure: { class: 'permission', code: 'github_forbidden' } });
    } finally { await testkit.dispose(); }
  });

  it('refuses to publish a preview status when the Receipt has no content', async () => {
    const stub = previewStatusTransport({ headerOnlyReceipt: true });
    expect(await invoke(previewStatusInput(), stub))
      .toMatchObject({ kind: 'failed', failure: { code: 'deployment_content_unavailable' } });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('publishes removal only in the admitted template runtime context and exact head', async () => {
    const stub = previewStatusTransport();
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: 'applied', publication: {
      environmentId: 'preview-child', templateEnvironmentId: 'preview-template',
      targetLinkId: 'preview-runtime', deploymentId: 'preview-teardown', expectedHeadSha: OBSERVED_HEAD,
      status: 'removed', targetUrl: null, providerStatusId: '91',
    } });
    const sent = stub.requests.filter(request => request.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).pathname).toBe(`${REPOSITORY_PATH}/statuses/${OBSERVED_HEAD}`);
    expect(readRecordedJsonBody(sent[0]!)).toMatchObject({ state: 'success', target_url: null });
    expect(readRecordedJsonBody(sent[0]!)).toHaveProperty('context', expect.stringMatching(/^happier\/preview\/[0-9a-f]+$/u));
    expect(sent[0]!.headers['X-GitHub-Api-Version']).toBe('2026-03-10');
    expect(stub.materializeCount()).toBeGreaterThan(0);
  });

  it.each([
    { operation: 'deploy', receiptState: 'running', pullRequestState: 'open', status: 'pending' },
    { operation: 'deploy', pullRequestState: 'open', status: 'pending' },
    { operation: 'deploy', domainState: 'active', pullRequestState: 'open', status: 'ready' },
    { operation: 'deploy', receiptState: 'failed', pullRequestState: 'open', status: 'failed' },
    { tombstoned: true, status: 'removed' },
  ] as const)('publishes $status from an ordinary receipt Event using its retained Forge source', async ({ status, ...options }) => {
    const stub = previewStatusTransport(options);
    const result = await invokeRegisteredGithubMutation('github/pull-request/preview-status', {
      v: 1, serverId: 'srv_preview', environmentId: 'preview-child', deploymentId: 'preview-teardown',
      templateEnvironmentId: 'preview-template',
      sourceConfig: { v: 1, credentialRef: CONFIGURED_ACCOUNT, repository: { v: 1, repositoryId: '4210',
        owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY, nameWithOwner: REPOSITORY_KEY } },
    }, stub);
    expect(result).toMatchObject({ kind: 'applied', publication: { status, expectedHeadSha: OBSERVED_HEAD } });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(stub.materializations).toMatchObject([{ account: CONFIGURED_ACCOUNT }]);
  });

  it.each([
    { options: { foreignReceipt: true }, templateEnvironmentId: 'preview-template', deploymentId: 'preview-teardown', reason: 'preview_context_changed' },
    { options: {}, templateEnvironmentId: 'other-template', deploymentId: 'preview-teardown', reason: 'preview_context_changed' },
    { options: {}, templateEnvironmentId: 'preview-template', deploymentId: 'old-receipt', reason: 'preview_context_changed' },
    { options: { headSha: ADVANCED_HEAD }, templateEnvironmentId: 'preview-template', deploymentId: 'preview-teardown', reason: 'head_advanced' },
  ])('refuses a stale or foreign receipt Event before publishing ($reason)', async ({ options, templateEnvironmentId, deploymentId, reason }) => {
    const stub = previewStatusTransport(options);
    const result = await invokeRegisteredGithubMutation('github/pull-request/preview-status', {
      v: 1, serverId: 'srv_preview', environmentId: 'preview-child', templateEnvironmentId, deploymentId,
      sourceConfig: { v: 1, credentialRef: CONFIGURED_ACCOUNT, repository: { v: 1, repositoryId: '4210',
        owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY, nameWithOwner: REPOSITORY_KEY } },
    }, stub);
    expect(result).toMatchObject({ kind: 'refused', reason });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('refuses an old removal when a newer live child owns the same template target', async () => {
    const stub = previewStatusTransport({ tombstoned: true, replacementChild: true });
    expect(await invokeRegisteredGithubMutation('github/pull-request/preview-status', previewStatusInput(), stub))
      .toEqual({ kind: 'refused', reason: 'preview_context_changed' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('offers an exact publication retry independently of app readiness and observes its result without redeploying', async () => {
    const stub = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active' });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    try {
      const before = GithubPreviewResultV1Schema.parse(
        await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }),
      );
      expect(before).toMatchObject({ kind: 'preview', previews: [{ state: 'ready', publication: {
        kind: 'unpublished', input: { environmentId: 'preview-child', deploymentId: 'preview-teardown',
          expectedHeadSha: OBSERVED_HEAD, status: 'ready', targetUrl: 'https://pr-1284.example.test/' },
      } }] });
      const preview = before.kind === 'preview' ? before.previews[0] : undefined;
      if (preview?.kind !== 'preview' || preview.publication?.kind !== 'unpublished') {
        throw new Error('Expected an unpublished preview with retry input');
      }
      expect(await testkit.invokeAction('github/pull-request/preview-status', preview.publication.input))
        .toMatchObject({ kind: 'applied' });
      expect(await testkit.invokeAction('github/pull-request/preview', { ...stateInput(), serverId: 'srv_preview' }))
        .toMatchObject({ kind: 'preview', previews: [{ state: 'ready', publication: { kind: 'current' } }] });
      expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    } finally { await testkit.dispose(); }
  });

  it.each([false, true])('publishes the retained successful teardown after tombstoning only for its own child (foreign=%s)', async foreignReceipt => {
    const stub = previewStatusTransport({ tombstoned: true, foreignReceipt });
    expect(await invoke(previewStatusInput(), stub)).toMatchObject(foreignReceipt
      ? { kind: 'refused', reason: 'preview_context_changed' }
      : { kind: 'applied', publication: { status: 'removed', environmentId: 'preview-child' } });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(foreignReceipt ? 0 : 1);
  });

  it('publishes successful cleanup while the pull request remains open', async () => {
    const stub = previewStatusTransport({ pullRequestState: 'open' });
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: 'applied', publication: { status: 'removed', targetUrl: null } });
    const sent = stub.requests.filter(request => request.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(readRecordedJsonBody(sent[0]!)).toMatchObject({ state: 'success', description: 'Preview removed', target_url: null });
  });

  it('keeps the owned template runtime context when a child is recreated', async () => {
    const original = previewStatusTransport();
    const recreated = previewStatusTransport({ childId: 'preview-recreated' });
    expect(await invoke(previewStatusInput(), original)).toMatchObject({ kind: 'applied' });
    expect(await invoke({ ...previewStatusInput(), environmentId: 'preview-recreated' }, recreated)).toMatchObject({ kind: 'applied' });
    const context = (stub: StubGithubTransport) => {
      const request = stub.requests.find(value => value.method === 'POST');
      expect(request).toBeDefined();
      return (readRecordedJsonBody(request!) as Readonly<Record<string, unknown>>).context;
    };
    expect(context(recreated)).toBe(context(original));
  });

  it.each([
    ['pending', 'running', 'pending', 'Preview deployment pending'],
    ['failed', 'failed', 'failure', 'Preview deployment failed'],
  ] as const)('publishes %s from its admitted deployment receipt without a URL', async (status, receiptState, state, description) => {
    const stub = previewStatusTransport({ receiptState, operation: 'deploy', pullRequestState: 'open' });
    expect(await invoke({ ...previewStatusInput(), status }, stub)).toMatchObject({ kind: 'applied', publication: { status, targetUrl: null } });
    const sent = stub.requests.filter(request => request.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(readRecordedJsonBody(sent[0]!)).toMatchObject({ state, description, target_url: null });
  });

  it('refuses a pending status when the settled successful receipt already has its serving Domain', async () => {
    const stub = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active' });
    expect(await invoke({ ...previewStatusInput(), status: 'pending' }, stub)).toMatchObject({ kind: 'refused', reason: 'preview_context_changed' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['advanced PR head', { headSha: ADVANCED_HEAD }],
    ['head changes before publication', { advanceHeadAfterRead: true }],
    ['foreign child Source', { foreignSource: true }],
    ['foreign receipt Environment', { foreignReceipt: true }],
    ['changed Artifact revision', { artifactRevision: 2 }],
    ['provider-native runtime', { native: true }],
    ['deleted child without successful cleanup', { deletedChild: true, operation: 'deploy', pullRequestState: 'open' }],
    ['deleted template', { deletedTemplate: true }],
    ['retired runtime relation', { retiredLink: true }],
  ] as const)('makes zero provider writes for %s', async (_label, options) => {
    const stub = previewStatusTransport(options);
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: expect.stringMatching(/^(refused|failed)$/u) });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('reconciles a response-lost publication once without reposting or another deployment', async () => {
    const stub = previewStatusTransport({ loseResponse: true });
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: 'applied', publication: { providerStatusId: '91' } });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('keeps an unobserved send uncertain without reposting', async () => {
    const stub = previewStatusTransport({ loseResponse: true, publicationNotObserved: true });
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: 'uncertain' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('reconciles an explicit retry from the matching owned exact-head fact without another POST', async () => {
    const stub = previewStatusTransport({ existing: true });
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: 'applied', publication: { providerStatusId: '90' } });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('returns provider permission denial independently from the successful teardown receipt', async () => {
    const stub = previewStatusTransport({ deny: true });
    expect(await invoke(previewStatusInput(), stub)).toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('does not publish a caller URL without an owner-produced preview URL fact', async () => {
    const stub = previewStatusTransport();
    expect(await invoke({ ...previewStatusInput(), targetUrl: 'https://preview.example.test/' }, stub))
      .toMatchObject({ kind: 'refused', reason: 'preview_url_unavailable' });
    expect(stub.requests).toHaveLength(0);
  });

  it('does not claim ready without current P41 readiness and URL facts', async () => {
    const stub = previewStatusTransport();
    expect(await invoke({ ...previewStatusInput(), status: 'ready' }, stub))
      .toMatchObject({ kind: 'refused', reason: 'preview_url_unavailable' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['pr-1284.example.test', 'https://pr-1284.example.test/app'],
    ['münich.example.test', 'https://xn--mnich-kva.example.test/app'],
  ])('publishes ready with the current successful receipt and owner Domain URL for %s', async (domainHostname, targetUrl) => {
    const stub = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active', domainPath: '/app', domainHostname });
    expect(await invoke({ ...previewStatusInput(), status: 'ready' }, stub)).toMatchObject({ kind: 'applied', publication: {
      status: 'ready', targetUrl,
    } });
    const sent = stub.requests.filter(request => request.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(readRecordedJsonBody(sent[0]!)).toMatchObject({ state: 'success', target_url: targetUrl });
  });

  it.each([
    ['superseded receipt', { supersededReceipt: true }],
    ['receipt replaced at the active runtime link', { inactiveReceipt: true }],
    ['failed Domain', { domainState: 'failed' as const }],
    ['caller-selected URL', { targetUrl: 'https://attacker.test/' }],
  ])('does not publish ready for %s', async (_name, options) => {
    const stub = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active', ...options });
    expect(await invoke({ ...previewStatusInput(), status: 'ready', ...('targetUrl' in options ? { targetUrl: options.targetUrl } : {}) }, stub))
      .toMatchObject({ kind: 'refused' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('rejects arbitrary context or provider endpoint operands at the registered strict input boundary', async () => {
    const stub = previewStatusTransport();
    await expect(invoke({ ...previewStatusInput(), context: 'ci/required', endpoint: 'https://other.test/' }, stub)).rejects.toThrow();
    expect(stub.requests).toHaveLength(0);
  });
});

const ADVANCED_BASE = 'ffeeddccbbaa0099887766554433221100ffeedd';
const REVIEW_COMMENT_ID = 'review-comment-1';
const VERDICT_CORRELATION_ID = 'A'.repeat(43);
const COMMENT_CORRELATION_ID = 'B'.repeat(43);

function mergeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    headRevision: OBSERVED_HEAD,
    mergeMethod: 'squash',
    ...overrides,
  };
}

async function invokeRegisteredGithubMutation(id: string, input: unknown, stub: StubGithubTransport) {
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
  try { return await kit.invokeAction(id, defineProtocolJsonValue().parse(input)); }
  finally { await kit.dispose(); }
}

describe('registered GitHub draft transitions', () => {
  it.each([
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestConvertToDraft, 'convertPullRequestToDraft', false],
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady, 'markPullRequestReadyForReview', true],
  ] as const)('%s distinguishes a permission refusal from failure to read a mutation result', async (id, mutation, draft) => {
    const before = pullRequestBody({ draft });
    const input = stateInput(draft ? { headRevision: OBSERVED_HEAD } : {});
    const message = 'The user does not have permission to convert the pull request to draft.';
    const failure = { class: 'permission', code: 'github_forbidden' };
    for (const data of [{}, { data: { [mutation]: null } }]) {
      const stub = transportFor({
        reads: [before],
        write: json({ ...data, errors: [{ type: 'FORBIDDEN', path: [mutation], message }] }),
      });
      expect(await invokeRegisteredGithubMutation(id, input, stub)).toMatchObject({ kind: 'failed', failure });
      expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(stub.requests.filter(request => request.method === 'GET' && new URL(request.url).pathname === PULL_REQUEST_PATH))
        .toHaveLength(1);
    }

    const stub = transportFor({
      reads: [before, before],
      write: json({
        data: { [mutation]: null },
        errors: [{ type: 'FORBIDDEN', path: [mutation, 'pullRequest', 'isDraft'], message: 'The resulting draft status is inaccessible.' }],
      }),
    });
    expect(await invokeRegisteredGithubMutation(id, input, stub)).toMatchObject({ kind: 'uncertain', failure });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(stub.requests.filter(request => request.method === 'GET' && new URL(request.url).pathname === PULL_REQUEST_PATH))
      .toHaveLength(2);
  });
});

describe('registered GitHub PR write parity', () => {
  const edits = [
    { id: 'github/pull-request/edit', fields: { title: 'Renamed PR', body: '  Description\n\n🦊  ' },
      before: pullRequestBody(), after: { ...pullRequestBody(), title: 'Renamed PR', body: '  Description\n\n🦊  ' },
      body: { title: 'Renamed PR', body: '  Description\n\n🦊  ' } },
    { id: 'github/pull-request/change-base', fields: { baseBranch: 'release/next' },
      before: pullRequestBody(), after: { ...pullRequestBody(), base: {
        ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>), ref: 'release/next',
      } }, body: { base: 'release/next' } },
    { id: 'github/pull-request/convert-to-draft', fields: {},
      before: pullRequestBody(), after: pullRequestBody({ draft: true }),
      body: { pullRequestId: GITHUB_PULL_REQUEST_RESPONSE.node_id } },
  ] as const;

  async function invoke(id: string, fields: Readonly<Record<string, unknown>>, stub: StubGithubTransport) {
    return invokeRegisteredGithubMutation(id, stateInput(fields), stub);
  }

  for (const edit of edits) {
    it(`${edit.id} defaults to Ask for agents, MCP and CLI and permits a saved waiver`, () => {
      const declaration = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === edit.id);
      expect(declaration).toBeDefined();
      const action = PluginActionContributionV2Schema.parse(declaration);
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(action.surfaces).toContain(surface);
        expect(pluginActionRequiresPresentUserIntent(action, surface, stateInput(edit.fields))).toBe(true);
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false },
          surface, stateInput(edit.fields))).toBe(false);
      }
    });

    it(`${edit.id} writes only the requested fields and confirms the provider state`, async () => {
      const stub = transportFor({ reads: [edit.before, edit.after] });
      expect(await invoke(edit.id, edit.fields, stub)).toMatchObject({ kind: 'applied', effect: 'changed' });
      const writes = stub.requests.filter(request => request.method !== 'GET');
      expect(writes).toHaveLength(1);
      const written = readRecordedJsonBody(writes[0]!) as Readonly<Record<string, unknown>>;
      if (edit.id === 'github/pull-request/convert-to-draft') {
        expect(written.query).toContain('convertPullRequestToDraft');
        expect(written.variables).toEqual(edit.body);
      } else {
        expect(writes[0]!.method).toBe('PATCH');
        expect(new URL(writes[0]!.url).pathname).toBe(PULL_REQUEST_PATH);
        expect(written).toEqual(edit.body);
      }
      expect(stub.materializeCount()).toBe(1);
    });

    it(`${edit.id} reports an unchanged target without a provider write`, async () => {
      const stub = transportFor({ reads: [edit.after] });
      expect(await invoke(edit.id, edit.fields, stub)).toMatchObject({ kind: 'applied', effect: 'alreadySatisfied' });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
    });

    it(`${edit.id} does not replay a write when the response is lost`, async () => {
      const stub = transportFor({ reads: [edit.before, edit.before], write: new Error('response lost') });
      expect(await invoke(edit.id, edit.fields, stub)).toMatchObject({ kind: 'uncertain' });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(1);
    });

    it(`${edit.id} keeps an accepted but unconfirmed change uncertain`, async () => {
      const stub = transportFor({ reads: [edit.before, edit.before] });
      expect(await invoke(edit.id, edit.fields, stub)).toMatchObject({ kind: 'uncertain' });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(1);
    });

    it(`${edit.id} preserves provider permission refusal`, async () => {
      const stub = transportFor({ reads: [edit.before], write: json({ message: 'Forbidden' }, 403) });
      expect(await invoke(edit.id, edit.fields, stub)).toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(1);
    });

    it(`${edit.id} refuses a foreign repository before writing`, async () => {
      const stub = transportFor({ reads: [{ ...edit.before, base: {
        ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>),
        repo: { ...(GITHUB_PULL_REQUEST_RESPONSE.base as { repo: Readonly<Record<string, unknown>> }).repo, id: 99999 },
      } }] });
      expect(await invoke(edit.id, edit.fields, stub)).toMatchObject({ kind: 'failed' });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
    });
  }

  it('clears a PR description without replacing its title', async () => {
    const before = { ...pullRequestBody(), body: 'Old description' };
    const stub = transportFor({ reads: [before, { ...before, body: '' }] });
    expect(await invoke('github/pull-request/edit', { body: '' }, stub)).toMatchObject({ kind: 'applied' });
    const patch = stub.requests.find(request => request.method === 'PATCH');
    expect(readRecordedJsonBody(patch!)).toEqual({ body: '' });
  });

  it('does not accept arbitrary fields in the content edit Action', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    await expect(invoke('github/pull-request/edit', { title: 'New', baseBranch: 'hidden-base' }, stub)).rejects.toThrow();
    expect(stub.requests).toHaveLength(0);
  });

  it('cannot convert a closed PR to draft', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed' })] });
    expect(await invoke('github/pull-request/convert-to-draft', {}, stub)).toMatchObject({ kind: 'refused', reason: 'state_changed' });
    expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
  });
});

describe('registered GitHub entry metadata parity', () => {
  it('projects PR metadata capability through the registered read even when issues are disabled', async () => {
    const stub = createStubGithubTransport({ respond: request => request.method === 'GET'
      && new URL(request.url).pathname === REPOSITORY_PATH ? json({ ...GITHUB_REPOSITORY_RESPONSE, has_issues: false }) : undefined });
    expect(await invokeRegisteredGithubMutation('triage/read-github-capabilities', stateInput(), stub)).toMatchObject({
      kind: 'capabilities', operations: { issueLabelAdd: { kind: 'available' }, issueAssigneeRemove: { kind: 'available' } },
    });
  });
  const changes = [
    { id: 'github/entry/milestone-set', fields: { milestone: 8 }, before: { milestone: null },
      after: { milestone: { number: 8, title: 'vNext' } }, method: 'PATCH', tail: '', body: { milestone: 8 } },
    { id: 'github/entry/milestone-set', fields: { milestone: null }, before: { milestone: { number: 8, title: 'vNext' } },
      after: { milestone: null }, method: 'PATCH', tail: '', body: { milestone: null } },
    { id: 'github/issue/type-set', fields: { issueType: 'Bug' }, before: { type: null },
      after: { type: { name: 'Bug' } }, method: 'PATCH', tail: '', body: { type: 'Bug' } },
    { id: 'github/issue/type-set', fields: { issueType: null }, before: { type: { name: 'Bug' } },
      after: { type: null }, method: 'PATCH', tail: '', body: { type: null } },
    { id: 'github/entry/lock', fields: { reason: 'off-topic' }, before: { locked: false, active_lock_reason: null },
      after: { locked: true, active_lock_reason: 'off-topic' }, method: 'PUT', tail: '/lock', body: { lock_reason: 'off-topic' } },
    { id: 'github/entry/unlock', fields: {}, before: { locked: true },
      after: { locked: false }, method: 'DELETE', tail: '/lock', body: undefined },
  ] as const;
  function metadataTransport(kind: 'issue' | 'pull-request', before: Readonly<Record<string, unknown>>,
    after: Readonly<Record<string, unknown>>, write?: StubHttpResponse | Error) {
    let reads = 0;
    const base = kind === 'issue' ? issueBody() : pullRequestBody();
    return createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
      if (request.method === 'GET' && path === (kind === 'issue' ? ISSUE_PATH : PULL_REQUEST_PATH)) {
        return json({ ...base, ...(reads++ === 0 ? before : after) });
      }
      if (request.method !== 'GET' && path.startsWith(`${REPOSITORY_PATH}/issues/`)) {
        if (write instanceof Error) throw write;
        return write ?? json({}, 200);
      }
      return undefined;
    } });
  }
  for (const change of changes) for (const kind of ['issue', 'pull-request'] as const) {
    if (change.id === 'github/issue/type-set' && kind !== 'issue') continue;
    it(`${change.id} ${JSON.stringify(change.fields)} changes only the chosen ${kind} metadata`, async () => {
      const stub = metadataTransport(kind, change.before, change.after);
      const input = kind === 'issue' ? issueInput(change.fields) : stateInput(change.fields);
      expect(await invokeRegisteredGithubMutation(change.id, input, stub)).toMatchObject({ kind: 'applied', effect: 'changed' });
      const sent = stub.requests.filter(request => request.method !== 'GET');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe(change.method);
      expect(new URL(sent[0]!.url).pathname).toBe(`${REPOSITORY_PATH}/issues/${kind === 'issue' ? '7' : '1284'}${change.tail}`);
      expect(readRecordedJsonBody(sent[0]!)).toEqual(change.body);
      expect(stub.materializeCount()).toBe(1);
    });
  }
  for (const id of ['github/entry/milestone-set', 'github/issue/type-set', 'github/entry/lock', 'github/entry/unlock']) {
    const change = changes.find(change => change.id === id)!;
    it(`${id} does not replay a response-lost write or claim an unobserved effect`, async () => {
      const stub = metadataTransport('issue', change.before, change.before, new Error('response lost'));
      expect(await invokeRegisteredGithubMutation(id, issueInput(change.fields), stub)).toMatchObject({ kind: 'uncertain' });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(1);
    });
    it(`${id} preserves Ask as a user-changeable automation default`, () => {
      const declaration = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === id));
      expect(pluginActionRequiresPresentUserIntent(declaration, 'agent', issueInput(change.fields))).toBe(true);
      expect(pluginActionRequiresPresentUserIntent({ ...declaration, approvalRequiredByActionSettings: false }, 'agent', issueInput(change.fields))).toBe(false);
    });
  }
  it('does not treat GitHub silently ignoring an issue-type write as success', async () => {
    const stub = metadataTransport('issue', { type: null }, { type: null });
    expect(await invokeRegisteredGithubMutation('github/issue/type-set', issueInput({ issueType: 'Bug' }), stub)).toMatchObject({ kind: 'uncertain' });
  });
  it('exposes current metadata operands through the existing overview read', async () => {
    const fields = { milestone: { number: 8, title: 'vNext' }, type: { name: 'Bug' }, locked: true, active_lock_reason: 'off-topic' };
    const stub = metadataTransport('issue', fields, fields);
    expect(await invokeRegisteredGithubMutation('triage/read-github-overview', issueInput(), stub)).toMatchObject({
      kind: 'overview', milestoneNumber: 8, issueType: 'Bug', locked: true, lockReason: 'off-topic',
    });
  });
  it('preserves a GitHub permission refusal without a retry', async () => {
    const stub = metadataTransport('issue', { milestone: null }, { milestone: null }, json({}, 403));
    expect(await invokeRegisteredGithubMutation('github/entry/milestone-set', issueInput({ milestone: 8 }), stub))
      .toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
    expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(1);
  });
  for (const [id, fields, before, after, method, tail, body] of [
    ['github/issue/label-add', { labels: ['new'] }, { labels: [{ name: 'existing' }] }, { labels: [{ name: 'existing' }, { name: 'new' }] }, 'POST', 'labels', { labels: ['new'] }],
    ['github/issue/label-remove', { label: 'old' }, { labels: [{ name: 'existing' }, { name: 'old' }] }, { labels: [{ name: 'existing' }] }, 'DELETE', 'labels/old', undefined],
    ['github/issue/assignee-add', { usernames: ['octocat'] }, { assignees: [{ login: 'existing' }] }, { assignees: [{ login: 'existing' }, { login: 'octocat' }] }, 'POST', 'assignees', { assignees: ['octocat'] }],
    ['github/issue/assignee-remove', { usernames: ['octocat'] }, { assignees: [{ login: 'existing' }, { login: 'octocat' }] }, { assignees: [{ login: 'existing' }] }, 'DELETE', 'assignees', { assignees: ['octocat'] }],
  ] as const) {
    it(`${id} applies its existing exact delta to PRs without touching unrelated members`, async () => {
      const stub = metadataTransport('pull-request', before, after);
      expect(await invokeRegisteredGithubMutation(id, stateInput(fields), stub)).toMatchObject({ kind: 'applied' });
      const sent = stub.requests.filter(request => request.method !== 'GET');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe(method);
      expect(new URL(sent[0]!.url).pathname).toBe(`${REPOSITORY_PATH}/issues/1284/${tail}`);
      expect(readRecordedJsonBody(sent[0]!)).toEqual(body);
    });
  }
});

describe('registered GitHub pending review parity', () => {
  it('exposes the native review commit through the registered feedback reader', async () => {
    const stub = createStubGithubTransport({ respond: request => {
      if (request.method === 'GET' && new URL(request.url).pathname === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
      if (request.method === 'POST' && new URL(request.url).pathname === '/graphql') return json({ data: { repository: {
        databaseId: 4210, pullRequest: { reviewDecision: null, reviews: { nodes: [{ id: 'PRR_PARITY', state: 'PENDING', body: 'Draft', commit: { oid: OBSERVED_HEAD } }],
          pageInfo: { hasPreviousPage: false, startCursor: null } } },
      } } });
      return undefined;
    } });
    expect(await invokeRegisteredGithubMutation('triage/read-github-feedback', stateInput({ connection: 'reviews' }), stub))
      .toMatchObject({ kind: 'reviews', rows: [{ id: 'PRR_PARITY', commitRevision: OBSERVED_HEAD }] });
  });
  const reviewId = 'PRR_PARITY';
  const operations = [
    { id: 'github/pull-request/pending-review-create', fields: { headRevision: OBSERVED_HEAD, body: 'Draft review' },
      mutation: 'addPullRequestReview', variables: { pullRequestId: GITHUB_PULL_REQUEST_RESPONSE.node_id, commitOID: OBSERVED_HEAD, body: 'Draft review' }, state: 'PENDING' },
    { id: 'github/pull-request/pending-review-submit', fields: { reviewId, headRevision: OBSERVED_HEAD, verdict: 'approve', body: 'Looks good' },
      mutation: 'submitPullRequestReview', variables: { reviewId, event: 'APPROVE', body: 'Looks good' }, state: 'APPROVED' },
    { id: 'github/pull-request/pending-review-delete', fields: { reviewId },
      mutation: 'deletePullRequestReview', variables: { reviewId }, state: 'PENDING' },
    { id: 'github/pull-request/review-dismiss', fields: { reviewId, message: 'Superseded' },
      mutation: 'dismissPullRequestReview', variables: { reviewId, message: 'Superseded' }, state: 'DISMISSED' },
  ] as const;
  function reviewTransport(operation: typeof operations[number], options: Readonly<{
    foreign?: boolean; lost?: boolean; forbidden?: boolean; advanced?: boolean;
    signal?: AbortSignal;
    holdWrite?: (response: StubHttpResponse, signal: AbortSignal | undefined) => Promise<StubHttpResponse>;
  }> = {}) {
    return createStubGithubTransport({ ...(options.signal === undefined ? {} : { signal: options.signal }), respond: (request, http) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) return json(pullRequestBody());
      if (request.method === 'POST' && path === '/graphql') {
        const payload = readRecordedJsonBody(request) as { query: string };
        if (payload.query.startsWith('query')) return json({ data: { node: {
          __typename: 'PullRequestReview', id: reviewId, state: 'PENDING', body: 'Draft review', commit: { oid: OBSERVED_HEAD },
          pullRequest: { number: options.foreign ? 999 : 1284, headRefOid: options.advanced ? 'e'.repeat(40) : OBSERVED_HEAD,
            repository: { databaseId: 4210, name: GITHUB_FIXTURE_REPOSITORY, owner: { login: GITHUB_FIXTURE_OWNER } } },
        } } });
        if (options.lost) throw new Error('response lost');
        if (options.forbidden) return json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] });
        const response = json({ data: { [operation.mutation]: { pullRequestReview: { id: reviewId, state: operation.state, body: 'Saved' } } } });
        return options.holdWrite?.(response, http?.signal) ?? response;
      }
      return undefined;
    } });
  }
  const sentMutations = (stub: StubGithubTransport) => stub.requests.filter(request => request.method === 'POST'
    && (readRecordedJsonBody(request) as { query?: string })?.query?.startsWith('mutation'));
  it('refuses submission when the PR moved beyond the selected pending-review commit', async () => {
    const operation = operations[1];
    const stub = reviewTransport(operation, { advanced: true });
    expect(await invokeRegisteredGithubMutation(operation.id, stateInput(operation.fields), stub))
      .toMatchObject({ kind: 'refused', reason: 'head_advanced' });
    expect(sentMutations(stub)).toHaveLength(0);
  });
  for (const operation of operations) {
    it(`${operation.id} reaches its native mutation through the registered Action and returns the review id`, async () => {
      const stub = reviewTransport(operation);
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput(operation.fields), stub))
        .toMatchObject({ kind: 'applied', effect: 'changed', review: { id: reviewId, state: operation.state } });
      const sent = sentMutations(stub);
      expect(sent).toHaveLength(1);
      const request = readRecordedJsonBody(sent[0]!) as { query: string; variables: Readonly<Record<string, unknown>> };
      expect(request.query).toContain(operation.mutation);
      expect(request.variables).toEqual(operation.variables);
      expect(stub.materializeCount()).toBe(1);
    });
    it(`${operation.id} stays uncertain on response loss without repeating the mutation`, async () => {
      const stub = reviewTransport(operation, { lost: true });
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput(operation.fields), stub)).toMatchObject({ kind: 'uncertain' });
      expect(sentMutations(stub)).toHaveLength(1);
    });
    it(`${operation.id} cancels a dispatched mutation without reading back or replaying it`, async () => {
      const caller = new AbortController();
      let reachedWrite!: (signal: AbortSignal | undefined) => void;
      const writeStarted = new Promise<AbortSignal | undefined>(resolve => { reachedWrite = resolve; });
      let releaseWrite = () => {};
      const stub = reviewTransport(operation, { signal: caller.signal, holdWrite: (response, signal) => {
        reachedWrite(signal);
        return new Promise(resolve => { releaseWrite = () => resolve(response); });
      } });
      const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
      try {
        // Observe the producer's typed settlement before an aborted host call discards it.
        const handler = kit.registration('actions', operation.id);
        if (!handler) throw new Error(`Missing registered Action ${operation.id}`);
        const pending = Promise.resolve(handler(stateInput(operation.fields), stub.context));
        const requestSignal = await Promise.race([writeStarted, pending.then(() => {
          throw new Error('The registered Action settled before the provider received its write');
        })]);
        const dispatchedRequests = stub.requests.slice();
        caller.abort(new DOMException('The caller left the review.', 'AbortError'));
        expect(requestSignal?.aborted).toBe(true);
        await expect(pending).resolves.toMatchObject({ kind: 'uncertain', failure: {
          class: 'transient', code: 'github_request_cancelled',
        } });
        releaseWrite();
        expect(stub.requests).toEqual(dispatchedRequests);
        expect(sentMutations(stub)).toHaveLength(1);
      } finally {
        caller.abort();
        releaseWrite();
        await kit.dispose();
      }
    });
    it(`${operation.id} reports GitHub GraphQL permission errors rather than HTTP-200 success`, async () => {
      const stub = reviewTransport(operation, { forbidden: true });
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput(operation.fields), stub))
        .toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
      expect(sentMutations(stub)).toHaveLength(1);
    });
    it(`${operation.id} keeps the shared Ask default and a saved waiver`, () => {
      const declaration = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === operation.id));
      expect(pluginActionRequiresPresentUserIntent(declaration, 'agent', stateInput(operation.fields))).toBe(true);
      expect(pluginActionRequiresPresentUserIntent({ ...declaration, approvalRequiredByActionSettings: false }, 'agent', stateInput(operation.fields))).toBe(false);
    });
    if ('reviewId' in operation.fields) it(`${operation.id} cannot mutate a review on another PR`, async () => {
      const stub = reviewTransport(operation, { foreign: true });
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput(operation.fields), stub)).toMatchObject({ kind: 'failed' });
      expect(sentMutations(stub)).toHaveLength(0);
    });
  }
});

describe('registered GitHub entry administration parity', () => {
  const operations = [
    { id: 'github/issue/transfer', fields: { destinationRepository: 'next/destination' }, mutation: 'transferIssue',
      variables: { issueId: 'I_PARITY', repositoryId: 'R_DEST' }, payload: { issue: { id: 'I_PARITY', number: 44,
        url: 'https://github.com/next/destination/issues/44', repository: { id: 'R_DEST', databaseId: 9000, name: 'destination', owner: { login: 'next' } } } } },
    { id: 'github/issue/delete', fields: {}, mutation: 'deleteIssue', variables: { issueId: 'I_PARITY' },
      payload: { repository: { databaseId: 4210 } } },
    { id: 'github/issue/pin', fields: {}, mutation: 'pinIssue', variables: { issueId: 'I_PARITY' }, payload: { issue: { id: 'I_PARITY', isPinned: true } } },
    { id: 'github/issue/unpin', fields: {}, mutation: 'unpinIssue', variables: { issueId: 'I_PARITY' }, payload: { issue: { id: 'I_PARITY', isPinned: false } } },
    { id: 'github/entry/subscribe', fields: {}, mutation: 'updateSubscription', variables: { subscribableId: 'I_PARITY', state: 'SUBSCRIBED' },
      payload: { subscribable: { id: 'I_PARITY', viewerSubscription: 'SUBSCRIBED' } } },
    { id: 'github/entry/unsubscribe', fields: {}, mutation: 'updateSubscription', variables: { subscribableId: 'I_PARITY', state: 'UNSUBSCRIBED' },
      payload: { subscribable: { id: 'I_PARITY', viewerSubscription: 'UNSUBSCRIBED' } } },
  ] as const;
  const mutations = (stub: StubGithubTransport) => stub.requests.filter(request => request.method === 'POST'
    && (readRecordedJsonBody(request) as { query?: string }).query?.startsWith('mutation'));
  function administrationTransport(operation: typeof operations[number], options: Readonly<{ lost?: boolean; foreign?: boolean; forbidden?: boolean; malformed?: boolean; pr?: boolean }> = {}) {
    return createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
      if (request.method === 'GET' && path === '/repos/next/destination') return json({ ...GITHUB_REPOSITORY_RESPONSE,
        id: 9000, node_id: 'R_DEST', full_name: 'next/destination', name: 'destination', owner: { login: 'next' } });
      if (request.method === 'GET' && path === ISSUE_PATH) return json({ ...issueBody(), node_id: 'I_PARITY',
        ...(options.foreign ? { number: 999 } : {}) });
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) return json(pullRequestBody());
      if (request.method === 'POST' && path === '/graphql') {
        if (options.lost) throw new Error('response lost');
        if (options.forbidden) return json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] });
        const payload = options.pr ? { subscribable: { id: GITHUB_PULL_REQUEST_RESPONSE.node_id,
          viewerSubscription: operation.id.endsWith('/subscribe') ? 'SUBSCRIBED' : 'UNSUBSCRIBED' } } : operation.payload;
        return json({ data: { [operation.mutation]: options.malformed ? {} : payload } });
      }
      return undefined;
    } });
  }
  for (const operation of operations) {
    it(`${operation.id} executes the native operation once through the registered Action`, async () => {
      const stub = administrationTransport(operation);
      const result = await invokeRegisteredGithubMutation(operation.id, issueInput(operation.fields), stub);
      expect(result).toMatchObject({ kind: 'applied', effect: 'changed' });
      if (operation.id.endsWith('/transfer')) expect(result).toMatchObject({ observation: { kind: 'merged', localRef: ISSUE_REF,
        successor: { kindId: 'issue', collisionScope: 'github:9000', entryId: '44' } }, entry: { url: 'https://github.com/next/destination/issues/44' } });
      if (operation.id.endsWith('/delete')) expect(result).toMatchObject({ observation: { kind: 'absent', localRef: ISSUE_REF } });
      if (operation.id.endsWith('/pin')) expect(result).toMatchObject({ entry: { pinned: true } });
      if (operation.id.endsWith('/unpin')) expect(result).toMatchObject({ entry: { pinned: false } });
      expect(mutations(stub)).toHaveLength(1);
      const document = readRecordedJsonBody(mutations(stub)[0]!) as { query: string; variables: unknown };
      expect(document.query).toContain(`${operation.mutation}(`);
      expect(document.variables).toEqual(operation.variables);
      expect(stub.materializeCount()).toBe(1);
    });
    it(`${operation.id} does not replay a lost response`, async () => {
      const stub = administrationTransport(operation, { lost: true });
      expect(await invokeRegisteredGithubMutation(operation.id, issueInput(operation.fields), stub)).toMatchObject({ kind: 'uncertain' });
      expect(mutations(stub)).toHaveLength(1);
    });
    it(`${operation.id} refuses a different entity before dispatch`, async () => {
      const stub = administrationTransport(operation, { foreign: true });
      expect(await invokeRegisteredGithubMutation(operation.id, issueInput(operation.fields), stub)).toMatchObject({ kind: 'failed' });
      expect(mutations(stub)).toHaveLength(0);
    });
    it(`${operation.id} preserves native permission refusal`, async () => {
      const stub = administrationTransport(operation, { forbidden: true });
      expect(await invokeRegisteredGithubMutation(operation.id, issueInput(operation.fields), stub)).toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
    });
    it(`${operation.id} does not claim a malformed success payload`, async () => {
      const stub = administrationTransport(operation, { malformed: true });
      expect(await invokeRegisteredGithubMutation(operation.id, issueInput(operation.fields), stub)).toMatchObject({ kind: 'uncertain' });
    });
    it(`${operation.id} preserves Ask and a per-Action waiver on every agent surface`, () => {
      const action = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(value => value.id === operation.id));
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(pluginActionRequiresPresentUserIntent(action, surface, issueInput(operation.fields))).toBe(true);
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, surface, issueInput(operation.fields))).toBe(false);
      }
    });
  }
  for (const operation of operations.filter(value => value.id.startsWith('github/entry/'))) {
    it(`${operation.id} also binds the PR through the canonical PR reader`, async () => {
      const stub = administrationTransport(operation, { pr: true });
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput(), stub)).toMatchObject({ kind: 'applied', entry: {
        id: GITHUB_PULL_REQUEST_RESPONSE.node_id, subscription: operation.id.endsWith('/subscribe') ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
      } });
      expect((readRecordedJsonBody(mutations(stub)[0]!) as { variables: unknown }).variables).toMatchObject({ subscribableId: GITHUB_PULL_REQUEST_RESPONSE.node_id });
    });
  }
});

describe('registered GitHub PR revert parity', () => {
  function revertTransport(mode: 'success' | 'lost' | 'forbidden' | 'malformed' = 'success') {
    return createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) return json(pullRequestBody({ state: 'closed', merged: true }));
      if (request.method !== 'POST' || path !== '/graphql') return undefined;
      if (mode === 'lost') throw new Error('response lost');
      if (mode === 'forbidden') return json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] });
      return json({ data: { revertPullRequest: mode === 'malformed' ? {} : {
        pullRequest: { id: GITHUB_PULL_REQUEST_RESPONSE.node_id }, revertPullRequest: {
          id: 'PR_REVERT', number: 1300, url: `https://github.com/${REPOSITORY_KEY}/pull/1300`,
          repository: { databaseId: 4210, name: GITHUB_FIXTURE_REPOSITORY, owner: { login: GITHUB_FIXTURE_OWNER } },
        },
      } } });
    } });
  }
  const input = () => stateInput({ title: 'Revert this change', body: '', draft: true });
  it('creates the native revert PR and returns its identity without retiring the merged original', async () => {
    const stub = revertTransport();
    const result = await invokeRegisteredGithubMutation('github/pull-request/revert', input(), stub);
    expect(result).toMatchObject({ kind: 'applied', entry: { id: 'PR_REVERT',
      localRef: { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1300' } } });
    expect(result).not.toHaveProperty('observation');
    const writes = stub.requests.filter(request => request.method === 'POST');
    expect(writes).toHaveLength(1);
    const document = readRecordedJsonBody(writes[0]!) as { query: string; variables: unknown };
    expect(document.query).toContain('revertPullRequest(');
    expect(document.variables).toEqual({ pullRequestId: GITHUB_PULL_REQUEST_RESPONSE.node_id, title: 'Revert this change', body: '', draft: true });
  });
  for (const mode of ['lost', 'forbidden', 'malformed'] as const) it(`settles ${mode} without claiming a new PR or retrying`, async () => {
    const stub = revertTransport(mode);
    expect(await invokeRegisteredGithubMutation('github/pull-request/revert', input(), stub))
      .toMatchObject({ kind: mode === 'forbidden' ? 'failed' : 'uncertain' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('keeps Ask and the saved per-Action waiver', () => {
    const action = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(value => value.id === 'github/pull-request/revert'));
    expect(pluginActionRequiresPresentUserIntent(action, 'agent', input())).toBe(true);
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, 'agent', input())).toBe(false);
  });
});

describe('registered GitHub PR head branch parity', () => {
  const branch = 'topic/line';
  const ref = `refs/heads/${branch}`;
  const operations = [
    { id: 'github/pull-request/head-branch-restore', method: 'POST', path: '/repos/fork-owner/fork-repo/git/refs', exists: true },
  ] as const;
  for (const operation of operations) {
    function transport(mode: 'success' | 'lost' | 'forbidden' | 'missing' = 'success') {
      return createStubGithubTransport({ respond: request => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
        if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
          const before = pullRequestBody();
          return json({ ...before, head: { ...(before.head as Readonly<Record<string, unknown>>), ref: branch,
            repo: mode === 'missing' ? null : { id: 999, owner: { login: 'fork-owner' }, name: 'fork-repo', clone_url: 'https://github.com/fork-owner/fork-repo.git' } } });
        }
        if (request.method === operation.method && path === operation.path) {
          if (mode === 'lost') throw new Error('response lost');
          if (mode === 'forbidden') return json({ message: 'Forbidden' }, 403);
          return operation.exists ? json({ ref, object: { sha: OBSERVED_HEAD } }, 201) : json(null, 204);
        }
        return undefined;
      } });
    }
    it(`${operation.id} targets the selected PR's fork branch, never the base repository`, async () => {
      const stub = transport();
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput({ headRevision: OBSERVED_HEAD }), stub)).toMatchObject({ kind: 'applied',
        entry: { branch: { name: branch, exists: operation.exists } } });
      const writes = stub.requests.filter(request => request.method !== 'GET');
      expect(writes).toHaveLength(1);
      expect(new URL(writes[0]!.url).pathname).toBe(operation.path);
      if (operation.exists) expect(readRecordedJsonBody(writes[0]!)).toEqual({ ref, sha: OBSERVED_HEAD });
    });
    for (const mode of ['lost', 'forbidden', 'missing'] as const) it(`${operation.id} handles ${mode} without a guessed branch or replay`, async () => {
      const stub = transport(mode);
      expect(await invokeRegisteredGithubMutation(operation.id, stateInput({ headRevision: OBSERVED_HEAD }), stub)).toMatchObject({ kind: mode === 'lost' ? 'uncertain' : 'failed' });
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(mode === 'missing' ? 0 : 1);
    });
    it(`${operation.id} keeps the outward Ask default and saved waiver`, () => {
      const action = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(value => value.id === operation.id));
      expect(pluginActionRequiresPresentUserIntent(action, 'agent', stateInput())).toBe(true);
      expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, 'agent', stateInput())).toBe(false);
    });
  }
  it('refuses a changed head instead of restoring a commit the caller did not select', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    expect(await invokeRegisteredGithubMutation('github/pull-request/head-branch-restore', stateInput({ headRevision: 'e'.repeat(40) }), stub))
      .toMatchObject({ kind: 'refused', reason: 'head_advanced' });
    expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
  });
});

describe('registered GitHub branch delete owner ruling', () => {
  const ref = 'refs/heads/topic/line';
  const prefix = '/repos/fork-owner/fork-repo/git';
  const input = () => stateInput({ headRevision: OBSERVED_HEAD });
  function transport(mode: 'same' | 'moved' | 'lost' | 'denied' = 'same') {
    return createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
        const before = pullRequestBody({ state: 'closed', merged: true });
        return json({ ...before, head: { ...(before.head as Readonly<Record<string, unknown>>), ref: 'topic/line',
          repo: { id: 999, owner: { login: 'fork-owner' }, name: 'fork-repo', clone_url: 'https://github.com/fork-owner/fork-repo.git' } } });
      }
      if (request.method === 'GET' && path === `${prefix}/ref/heads/topic/line`) return mode === 'denied' ? json({ message: 'Forbidden' }, 403)
        : json({ ref, object: { sha: mode === 'moved' ? 'e'.repeat(40) : OBSERVED_HEAD } });
      if (request.method === 'DELETE' && path === `${prefix}/refs/heads/topic/line`) {
        if (mode === 'lost') throw new Error('response lost');
        return json(null, 204);
      }
      return undefined;
    } });
  }
  it('refuses a moved ref with its observed tip and sends no DELETE', async () => {
    const stub = transport('moved');
    expect(await invokeRegisteredGithubMutation('github/pull-request/head-branch-delete', input(), stub)).toMatchObject({
      kind: 'refused', reason: 'branch_moved', currentBranchRevision: 'e'.repeat(40),
    });
    expect(stub.requests.filter(request => request.method === 'DELETE')).toHaveLength(0);
  });
  it('reads the exact ref immediately before one DELETE when the observed tip still matches', async () => {
    const stub = transport();
    expect(await invokeRegisteredGithubMutation('github/pull-request/head-branch-delete', input(), stub)).toMatchObject({
      kind: 'applied', entry: { branch: { name: 'topic/line', exists: false } },
    });
    const last = stub.requests.slice(-2);
    expect(last.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', `${prefix}/ref/heads/topic/line`], ['DELETE', `${prefix}/refs/heads/topic/line`],
    ]);
    expect(stub.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(stub.materializeCount()).toBe(1);
  });
  for (const mode of ['lost', 'denied'] as const) it(`settles ${mode} without repeating or guessing a DELETE`, async () => {
    const stub = transport(mode);
    expect(await invokeRegisteredGithubMutation('github/pull-request/head-branch-delete', input(), stub)).toMatchObject({ kind: mode === 'lost' ? 'uncertain' : 'failed' });
    expect(stub.requests.filter(request => request.method === 'DELETE')).toHaveLength(mode === 'lost' ? 1 : 0);
  });
  it('declares writesRemote and the shared Ask default with a per-Action waiver', () => {
    const action = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(value => value.id === 'github/pull-request/head-branch-delete'));
    expect(action.dangerLevel).toBe('writesRemote');
    for (const surface of ['agent', 'mcp', 'cli'] as const) {
      expect(pluginActionRequiresPresentUserIntent(action, surface, input())).toBe(true);
      expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, surface, input())).toBe(false);
    }
  });
});

function archivedRepositoryBody(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...GITHUB_REPOSITORY_RESPONSE,
    archived: true,
    has_issues: true,
  });
}

const REVIEWERS_PATH = `${PULL_REQUEST_PATH}/requested_reviewers`;
const REVIEWS_PATH = `${PULL_REQUEST_PATH}/reviews`;
const UPDATE_BRANCH_PATH = `${PULL_REQUEST_PATH}/update-branch`;
const GRAPHQL_PATH = '/graphql';
const REVIEW_THREAD_ID = 'PRRT_kwDOExample';

/** GitHub's own node id for the fixture pull request, as REST publishes it. */
const PULL_REQUEST_NODE_ID = GITHUB_PULL_REQUEST_RESPONSE.node_id as string;

function reviewerCollection(input: Readonly<{
  users?: readonly string[];
  teams?: readonly string[];
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    users: (input.users ?? []).map((login) => ({ login, id: 1, type: 'User' })),
    teams: (input.teams ?? []).map((slug) => ({ slug, id: 2, name: slug })),
  });
}

/**
 * Answers the reads every write performs, and lets one case decide what the write
 * itself returns and what the CONFIRMING read then observes.
 */
function transportFor(input: Readonly<{
  /** Answers, in order, the preflight read and then every following read. */
  reads: readonly Readonly<Record<string, unknown>>[];
  nativeMaterialization?: ConnectedAccountMaterialization;
  binding?: Parameters<typeof createStubGithubTransport>[0]['binding'];
  repository?: Readonly<Record<string, unknown>>;
  write?: StubHttpResponse | Error;
  readStatus?: number;
  /** Answers, in order, the reviewer preflight read and then the confirming read. */
  reviewerReads?: readonly Readonly<Record<string, unknown>>[];
  /** Answers, in order, the review-publication baseline and confirming reads. */
  reviewPublicationReads?: readonly unknown[][];
  reviewCommentPublicationReads?: readonly unknown[][];
  threadPublicationReads?: readonly unknown[][];
  claimDisposition?: 'dispatch' | 'reconcile';
  claimError?: Error;
  settlementError?: Error;
  claimInstructions?: Readonly<{
    entries: readonly ('dispatch' | 'reconcile' | 'confirmed' | 'held')[];
    verdict: 'dispatch' | 'reconcile' | 'confirmed' | 'held' | null;
  }>;
  priorPublicationResult?: unknown;
  mergeStatus?: Readonly<Record<string, unknown>>;
  mergeStatuses?: readonly Readonly<Record<string, unknown>>[];
  branchRules?: StubHttpResponse;
  mergeStatusResponse?: StubHttpResponse;
}>) {
  let read = 0;
  let reviewerRead = 0;
  let reviewPublicationRead = 0;
  let reviewCommentPublicationRead = 0;
  let threadPublicationRead = 0;
  let mergeStatusRead = 0;
  const claimedPlans: unknown[] = [];
  /**
   * `write: new Error(...)` states that the boundary recorded the request and
   * then lost its answer, which is a rejected request rather than a response
   * with no status.
   */
  const writeAnswer = (fallback: StubHttpResponse): StubHttpResponse => {
    if (input.write instanceof Error) throw input.write;
    return input.write ?? fallback;
  };
  const stub = createStubGithubTransport({
    ...(input.nativeMaterialization === undefined ? {} : { nativeMaterialization: input.nativeMaterialization }),
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    executeAction: async (actionId, actionInput) => {
      expect(actionId).toBe('reviews.comments.claimPublicationDispatch');
      claimedPlans.push(actionInput);
      if (input.claimError !== undefined) throw input.claimError;
      if (input.settlementError !== undefined
        && typeof actionInput === 'object'
        && actionInput !== null
        && 'settlement' in actionInput
        && actionInput.settlement !== undefined) {
        throw input.settlementError;
      }
      const plan = actionInput as Readonly<Record<string, unknown>>;
      const entries = Array.isArray(plan.entries) ? plan.entries : [];
      const disposition = input.claimDisposition ?? 'dispatch';
      return {
        disposition,
        dispatchToken: disposition === 'dispatch' ? 'dispatch-token-1' : null,
        publicationPlanId: 'C'.repeat(43),
        entries: entries.map((entry, index) => ({
          happierCommentId: (entry as Readonly<Record<string, unknown>>).happierCommentId,
          publicationCorrelationId: String.fromCharCode(66 + index).repeat(43),
        })),
        verdict: plan.verdict === null
          ? null
          : { publicationCorrelationId: VERDICT_CORRELATION_ID },
        instructions: input.claimInstructions ?? {
          entries: entries.map(() => disposition),
          verdict: plan.verdict === null ? null : disposition,
        },
        priorResult: input.priorPublicationResult ?? null,
      };
    },
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
        if (input.readStatus !== undefined && read > 0) {
          read += 1;
          return { status: input.readStatus, headers: {}, body: {} };
        }
        const body = input.reads[Math.min(read, input.reads.length - 1)];
        read += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === REPOSITORY_PATH) {
        return json(input.repository ?? GITHUB_REPOSITORY_RESPONSE);
      }
      if (request.method === 'GET' && path.startsWith(`${REPOSITORY_PATH}/rules/branches/`)) {
        return input.branchRules ?? json([]);
      }
      if (request.method === 'PUT' && path === `${PULL_REQUEST_PATH}/merge`) {
        return writeAnswer(json({ merged: true, sha: OBSERVED_HEAD }));
      }
      if (request.method === 'PATCH' && path === PULL_REQUEST_PATH) {
        return writeAnswer(json(input.reads[input.reads.length - 1]));
      }
      if (request.method === 'PUT' && path === UPDATE_BRANCH_PATH) {
        // GitHub answers a branch update with `202 Accepted`, which states only
        // that it took the request.
        return writeAnswer({
          status: 202,
          headers: { 'content-type': 'application/json' },
          body: { message: 'Updating pull request branch.' },
        });
      }
      if (request.method === 'POST' && path === GRAPHQL_PATH) {
        const graphql = readRecordedJsonBody(request) as Readonly<Record<string, unknown>>;
        const query = typeof graphql.query === 'string' ? graphql.query : '';
        if (query.includes('query Checks(')) {
          if (input.mergeStatusResponse !== undefined) return input.mergeStatusResponse;
          const status = input.mergeStatuses?.[Math.min(mergeStatusRead, input.mergeStatuses.length - 1)] ?? input.mergeStatus;
          mergeStatusRead += 1;
          return json({ data: { repository: { pullRequest: {
            headRefOid: OBSERVED_HEAD,
            id: PULL_REQUEST_NODE_ID,
            viewerCanUpdate: true,
            viewerCanEnableAutoMerge: true,
            viewerCanDisableAutoMerge: true,
            mergeQueueEntry: null,
            mergeStateStatus: 'CLEAN',
            viewerCanMergeAsAdmin: true,
            reviewDecision: 'APPROVED',
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
            reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
            commits: { nodes: [{ commit: { oid: OBSERVED_HEAD, statusCheckRollup: {
              contexts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            } } }] },
            ...status,
          } } } });
        }
        if (query.includes('GithubReviewThreadPublicationComments')) {
          const pages = input.threadPublicationReads ?? [[]];
          const nodes = pages[Math.min(threadPublicationRead, pages.length - 1)];
          threadPublicationRead += 1;
          return json({
            data: {
              node: {
                __typename: 'PullRequestReviewThread',
                id: REVIEW_THREAD_ID,
                isResolved: false,
                pullRequest: {
                  number: 1284,
                  repository: {
                    databaseId: 4210,
                    name: GITHUB_FIXTURE_REPOSITORY,
                    owner: { login: GITHUB_FIXTURE_OWNER },
                  },
                },
                comments: {
                  nodes,
                  pageInfo: { hasPreviousPage: false, startCursor: null },
                },
              },
            },
          });
        }
        if (query.includes('GithubReviewThread(')) {
          return json({
            data: {
              node: {
                __typename: 'PullRequestReviewThread',
                id: REVIEW_THREAD_ID,
                isResolved: false,
                pullRequest: {
                  number: 1284,
                  repository: {
                    databaseId: 4210,
                    name: GITHUB_FIXTURE_REPOSITORY,
                    owner: { login: GITHUB_FIXTURE_OWNER },
                  },
                },
              },
            },
          });
        }
        if (query.includes('GithubReplyToReviewThread')) {
          return writeAnswer(json({
            data: { addPullRequestReviewThreadReply: { comment: { id: 'thread-comment', body: '' } } },
          }));
        }
        const mutation = query.includes('convertPullRequestToDraft') ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
        return writeAnswer(json({
          data: { [mutation]: { pullRequest: { id: GITHUB_PULL_REQUEST_RESPONSE.node_id, isDraft: mutation === 'convertPullRequestToDraft' } } },
        }));
      }
      if (request.method === 'GET' && path === REVIEWERS_PATH) {
        const collections = input.reviewerReads ?? [reviewerCollection({})];
        const body = collections[Math.min(reviewerRead, collections.length - 1)];
        reviewerRead += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === REVIEWS_PATH) {
        const pages = input.reviewPublicationReads ?? [[]];
        const body = pages[Math.min(reviewPublicationRead, pages.length - 1)];
        reviewPublicationRead += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === `${PULL_REQUEST_PATH}/comments`) {
        const pages = input.reviewCommentPublicationReads ?? [[]];
        const body = pages[Math.min(reviewCommentPublicationRead, pages.length - 1)];
        reviewCommentPublicationRead += 1;
        return json(body);
      }
      if ((request.method === 'POST' || request.method === 'DELETE')
        && path === REVIEWERS_PATH) {
        if (input.write instanceof Error) throw input.write;
        return input.write ?? json(GITHUB_PULL_REQUEST_RESPONSE);
      }
      if (request.method === 'POST' && path === REVIEWS_PATH) {
        if (input.write instanceof Error) throw input.write;
        return input.write ?? json({ id: 991, state: 'APPROVED' }, 201);
      }
      if (request.method === 'POST' && path === `${PULL_REQUEST_PATH}/comments`) {
        return writeAnswer(json({ id: 992 }, 201));
      }
      return undefined;
    },
  });
  return Object.freeze({ ...stub, claimedPlans });
}

/* ---------------------------------------------------------- review publication */

describe('fresh merge requirement admission', () => {
  function failedRequiredCheck(name = 'Required build') {
    return { __typename: 'CheckRun', id: 'required-build', name, status: 'COMPLETED', conclusion: 'FAILURE',
      startedAt: '2026-08-13T09:00:00Z', completedAt: '2026-08-13T09:01:00Z', isRequired: true,
      checkSuite: { createdAt: '2026-08-13T09:00:00Z' } };
  }
  function withChecks(nodes: readonly unknown[]) {
    return { commits: { nodes: [{ commit: { oid: OBSERVED_HEAD, statusCheckRollup: {
      contexts: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    } } }] } };
  }
  it('keeps the source-projected named refusal inside the complete Action envelope near the native status boundary', async () => {
    const label = '"'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    const total = Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / (MAX_TRIAGE_TEXT_UTF8_BYTES_V1 * 2));
    const pages = Array.from({ length: Math.ceil(total / 100) }, (_, page) => {
      const start = page * 100;
      const end = Math.min(total, start + 100);
      return { commits: { nodes: [{ commit: { oid: OBSERVED_HEAD, statusCheckRollup: { contexts: {
        nodes: Array.from({ length: end - start }, (_, index) => ({ ...failedRequiredCheck(label), id: `envelope-${start + index}` })),
        pageInfo: { hasNextPage: end < total, endCursor: String(end) },
      } } } }] } };
    });
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatuses: pages });
    const result = GithubPullRequestMergeActionResultV1Schema.parse(await mergeGithubPullRequestAction(mergeInput(), stub.context));
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused' || result.outcome.kind !== 'refused' || result.outcome.unmetRequirements === undefined) throw new Error('Expected named native refusal');
    expect('unmetRequirements' in result).toBe(false);
    const outcome = readTriageSourceOperationOutcomeV1(result);
    expect(outcome).toMatchObject({ kind: 'refused', unmetRequirements: result.outcome.unmetRequirements });
    expect(result.outcome.unmetRequirements.length).toBeGreaterThan(0);
    const { outcome: _outcome, ...native } = result;
    const raw = { ...native, unmetRequirements: result.outcome.unmetRequirements };
    console.info('D-I15 Action envelope bytes', JSON.stringify({ raw: measureExternalActionResultResponseEnvelopeUtf8BytesV1(raw),
      projected: measureExternalActionResultResponseEnvelopeUtf8BytesV1(result), requirements: result.outcome.unmetRequirements.length, total }));
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(writes(stub)).toHaveLength(0);
  });
  it.each([{ intent: 'withoutWaiting' }, { intent: 'normal', skippedRequirements: [] }])(
    'rejects a missing or misplaced acknowledgement before admission', async (operands) => {
      const stub = transportFor({ reads: [pullRequestBody()] });
      expect(await mergeGithubPullRequestAction(mergeInput(operands), stub.context))
        .toMatchObject({ kind: 'failed', failure: { code: 'github_mutation_input_invalid' } });
      expect(stub.requests).toHaveLength(0);
    });
  it('refuses an eligible administrator ordinary Merge when native GitHub reports a block', async () => {
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
      mergeStatus: { mergeStateStatus: 'BLOCKED' } });
    const result = await mergeGithubPullRequestAction(mergeInput(), stub.context);
    expect(result).toMatchObject({ kind: 'refused', reason: 'requirements_unmet',
      outcome: { unmetRequirements: expect.arrayContaining([expect.objectContaining({ kind: 'policy' })]) } });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it.each(['agent', 'cli'] as const)('performs one fresh admitted status decision for a %s call without a mounted view', async (surface) => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { mergeStateStatus: 'BLOCKED' } });
    expect(await mergeGithubPullRequestAction(mergeInput(), { ...stub.context, surface }))
      .toMatchObject({ kind: 'refused', reason: 'requirements_unmet' });
    expect(entryReads(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === GRAPHQL_PATH)).toHaveLength(1);
    expect(stub.materializeCount()).toBe(1);
    expect(writes(stub)).toHaveLength(0);
  });

  it.each(['BEHIND', 'CLEAN', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE', 'FUTURE_STATE', null])(
    'lets GitHub decide ordinary Merge for native %s without an independently proven blocker', async (nativeState) => {
      const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
        mergeStatus: { mergeStateStatus: nativeState } });
      expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'applied' });
      const writes = stub.requests.filter((request) => request.method === 'PUT');
      expect(writes).toHaveLength(1);
      expect(readRecordedJsonBody(writes[0]!)).toEqual({ sha: OBSERVED_HEAD, merge_method: 'squash' });
      expect(stub.requests.filter((request) => request.method === 'GET' && new URL(request.url).pathname === PULL_REQUEST_PATH)).toHaveLength(2);
      expect(stub.requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname === GRAPHQL_PATH)).toHaveLength(1);
    });

  it.each(['DIRTY', 'DRAFT'])('refuses structural %s before a merge write', async (nativeState) => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { mergeStateStatus: nativeState } });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'refused', reason: 'not_mergeable' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it.each(['failed', 'pending'])('refuses normal merge with provider-labelled %s requirements even with unknown native state', async (outcome) => {
    const check = outcome === 'failed' ? failedRequiredCheck() : { ...failedRequiredCheck(), status: 'IN_PROGRESS', conclusion: null, completedAt: null };
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { mergeStateStatus: 'UNKNOWN', ...withChecks([check]) } });
    const result = await mergeGithubPullRequestAction(mergeInput(), stub.context);
    expect(GithubPullRequestMergeActionResultV1Schema.parse(result)).toMatchObject({ kind: 'refused', reason: 'requirements_unmet',
      outcome: { kind: 'refused', reason: 'requirements_unmet',
        unmetRequirements: [{ kind: 'check', id: 'github-check-run:required-build', label: 'Required build' }] } });
    expect(readTriageSourceOperationOutcomeV1(result)).toEqual(result.outcome);
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('allows UNSTABLE with optional failure and passing required checks', async () => {
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody({ merged: true, state: 'closed' })],
      mergeStatus: { mergeStateStatus: 'UNSTABLE', ...withChecks([
        { ...failedRequiredCheck('Optional analysis'), id: 'optional-analysis', isRequired: false },
        { ...failedRequiredCheck(), conclusion: 'SUCCESS' },
      ]) } });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'applied' });
    expect(writes(stub)).toHaveLength(1);
  });

  it('refuses BEHIND only with an explicit enforced up-to-date requirement', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { mergeStateStatus: 'BEHIND' },
      branchRules: json([{ type: 'required_status_checks', ruleset_id: 42, parameters: {
        strict_required_status_checks_policy: true, required_status_checks: [{ context: 'Required build' }],
      } }]) });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'refused',
      reason: 'requirements_unmet', outcome: { unmetRequirements: [{ kind: 'policy', id: 'github:up-to-date', label: 'Branch must be up to date' }] } });
    expect(writes(stub)).toHaveLength(0);
  });

  it('requires exact named acknowledgement for the same ordinary provider merge body', async () => {
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody({ merged: true, state: 'closed' })],
      mergeStatus: { mergeStateStatus: 'UNSTABLE', ...withChecks([failedRequiredCheck()]) } });
    const result = await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'check', id: 'github-check-run:required-build', label: 'Required build' },
    ] }), stub.context);
    expect(GithubPullRequestMergeActionResultV1Schema.parse(result)).toMatchObject({ kind: 'applied' });
    expect(readRecordedJsonBody(stub.requests.find((request) => request.method === 'PUT')!))
      .toEqual({ sha: OBSERVED_HEAD, merge_method: 'squash' });
    expect(stub.requests.filter((request) => new URL(request.url).pathname === GRAPHQL_PATH)).toHaveLength(1);
  });

  it('admits an eligible native BLOCKED check and review only with their complete exact acknowledgement', async () => {
    const setup = { reads: [pullRequestBody({ mergeableState: 'blocked' }), pullRequestBody({ merged: true, state: 'closed' })],
      mergeStatus: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', ...withChecks([failedRequiredCheck()]) },
      branchRules: json([{ type: 'required_status_checks', ruleset_id: 42 }, {
        type: 'pull_request', ruleset_id: 42, parameters: { required_review_thread_resolution: false },
      }]) };
    const expectedRequirements = [
      { kind: 'check', id: 'github-check-run:required-build', label: 'Required build' },
      { kind: 'review', id: 'github:review', label: 'Required review' },
    ];
    const ordinary = transportFor(setup);
    expect(await mergeGithubPullRequestAction(mergeInput(), ordinary.context))
      .toMatchObject({ kind: 'refused', reason: 'requirements_unmet', outcome: { unmetRequirements: expectedRequirements } });
    expect(writes(ordinary)).toHaveLength(0);

    const partial = transportFor(setup);
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting',
      skippedRequirements: expectedRequirements.slice(0, 1) }), partial.context))
      .toMatchObject({ kind: 'refused', reason: 'requirements_changed', outcome: { unmetRequirements: expectedRequirements } });
    expect(writes(partial)).toHaveLength(0);

    const explicit = transportFor(setup);
    expect(GithubPullRequestMergeActionResultV1Schema.parse(await mergeGithubPullRequestAction(mergeInput({
      intent: 'withoutWaiting', skippedRequirements: expectedRequirements,
    }), explicit.context))).toMatchObject({ kind: 'applied', effect: 'changed' });
    expect(writes(explicit)).toHaveLength(1);
    expect(readRecordedJsonBody(writes(explicit)[0]!)).toEqual({ sha: OBSERVED_HEAD, merge_method: 'squash' });
    expect(entryReads(explicit)).toHaveLength(2);
    expect(explicit.requests.filter((request) => new URL(request.url).pathname === GRAPHQL_PATH)).toHaveLength(1);
  });

  it('refuses bypass when the native reviewer evidence is explicitly incomplete', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: {
      mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: { nodes: [], pageInfo: { hasNextPage: true } },
    } });
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'review', id: 'github:review', label: 'Required review' },
    ] }), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unknown' });
    expect(writes(stub)).toHaveLength(0);
  });

  it('does not let an approved review hide an unobserved enforced thread-resolution requirement', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ mergeableState: 'blocked' }), pullRequestBody({ merged: true, state: 'closed' })],
      mergeStatus: { mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', ...withChecks([failedRequiredCheck()]) },
      branchRules: json([{ type: 'pull_request', ruleset_id: 42,
        parameters: { required_review_thread_resolution: true } }]),
    });
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'check', id: 'github-check-run:required-build', label: 'Required build' },
    ] }), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unknown' });
    expect(writes(stub)).toHaveLength(0);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === GRAPHQL_PATH)).toHaveLength(1);
    expect(stub.requests.filter((request) => new URL(request.url).pathname.startsWith(`${REPOSITORY_PATH}/rules/branches/`))).toHaveLength(1);
  });

  it.each([false, null])('refuses explicit bypass with viewer eligibility %s', async (viewerCanMergeAsAdmin) => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { viewerCanMergeAsAdmin, ...withChecks([failedRequiredCheck()]) } });
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'check', id: 'github-check-run:required-build', label: 'Required build' },
    ] }), stub.context)).toMatchObject({ kind: 'refused', reason: 'bypass_not_allowed' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it.each([{ skippedRequirements: [] }, { skippedRequirements: [{ kind: 'check', id: 'forged', label: 'Required build' }] },
    { skippedRequirements: [{ kind: 'check', id: 'github-check-run:required-build', label: 'Previous build' }] }])(
    'refuses changed or incomplete acknowledged requirements', async ({ skippedRequirements }) => {
      const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { ...withChecks([failedRequiredCheck()]) } });
      expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements }), stub.context))
        .toMatchObject({ kind: 'refused', reason: 'requirements_changed' });
      expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    });

  it('refuses explicit bypass when the native block has an unexplained policy remainder', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { mergeStateStatus: 'BLOCKED' } });
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'policy', id: 'github:merge-state:BLOCKED', label: 'Blocked on GitHub' },
    ] }), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unknown' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('requires explicit exact queue acknowledgement before an eligible direct merge', async () => {
    const setup = { reads: [pullRequestBody(), pullRequestBody({ merged: true, state: 'closed' })],
      mergeStatus: { mergeStateStatus: 'BLOCKED' }, branchRules: json([{ type: 'merge_queue', ruleset_id: 42 }]) };
    const ordinary = transportFor(setup);
    expect(await mergeGithubPullRequestAction(mergeInput(), ordinary.context)).toMatchObject({ kind: 'refused',
      reason: 'requirements_unmet', outcome: { unmetRequirements: [{ kind: 'queue', id: 'github:merge-queue', label: 'Merge queue required' }] } });
    expect(ordinary.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    const explicit = transportFor(setup);
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'queue', id: 'github:merge-queue', label: 'Merge queue required' },
    ] }), explicit.context)).toMatchObject({ kind: 'applied' });
    const writes = explicit.requests.filter((request) => request.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(readRecordedJsonBody(writes[0]!)).toEqual({ sha: OBSERVED_HEAD, merge_method: 'squash' });
    expect(explicit.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('refuses explicit bypass when current branch-rule explanation is denied', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: withChecks([failedRequiredCheck()]),
      branchRules: json({}, 403) });
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'check', id: 'github-check-run:required-build', label: 'Required build' },
    ] }), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unknown' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('does not turn a rejected credential into ordinary unknown-requirement permission', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatusResponse: json({}, 401) });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'failed',
      failure: { class: 'authentication' } });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('keeps the known REST block when the requirements subread is denied', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ mergeableState: 'blocked' })], mergeStatusResponse: json({}, 403) });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unmet' });
    expect(writes(stub)).toHaveLength(0);
  });

  it('permits ordinary unknown requirements after exact admission when only the subread is denied', async () => {
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody({ merged: true, state: 'closed' })],
      mergeStatusResponse: json({}, 403) });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'applied' });
    expect(writes(stub)).toHaveLength(1);
  });

  it('refuses a head advance observed by the rollup after the fresh REST preflight', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { headRefOid: ADVANCED_HEAD } });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'refused', reason: 'head_advanced' });
    expect(writes(stub)).toHaveLength(0);
  });

  it('refuses a known head advance without branch display labels before any merge PUT', async () => {
    const current = pullRequestBody();
    const stub = transportFor({ reads: [{ ...current,
      head: { ...(current.head as Readonly<Record<string, unknown>>), ref: null },
      base: { ...(current.base as Readonly<Record<string, unknown>>), ref: null },
    }], mergeStatus: { headRefOid: ADVANCED_HEAD } });
    expect(GithubPullRequestMergeActionResultV1Schema.parse(await mergeGithubPullRequestAction(mergeInput(), stub.context)))
      .toMatchObject({ kind: 'refused', reason: 'head_advanced' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(entryReads(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === GRAPHQL_PATH)).toHaveLength(1);
  });

  it('preserves a known required blocker when its name cannot enter the projected rows', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: withChecks([failedRequiredCheck('   ')]) });
    expect(await mergeGithubPullRequestAction(mergeInput(), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unmet' });
    expect(writes(stub)).toHaveLength(0);
  });

  it('does not acknowledge a known-only subset when the block includes unexplained policy evidence', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: { mergeStateStatus: 'BLOCKED' },
      branchRules: json([{ type: 'merge_queue', ruleset_id: 42 }, { type: 'required_deployments', ruleset_id: 43 }]) });
    expect(await mergeGithubPullRequestAction(mergeInput({ intent: 'withoutWaiting', skippedRequirements: [
      { kind: 'queue', id: 'github:merge-queue', label: 'Merge queue required' },
    ] }), stub.context)).toMatchObject({ kind: 'refused', reason: 'requirements_unknown' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });
});

describe('declared native merge Actions', () => {
  async function invoke(id: string, input: unknown, context: StubGithubTransport['context']) {
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    try {
      const handler = testkit.registration('actions', id);
      if (typeof handler !== 'function') throw new Error(`Missing native Action ${id}`);
      const admittedInput = id === 'github/pull-request/enqueue' ? GithubPullRequestEnqueueInputV1Schema.parse(input)
        : id === 'github/pull-request/dequeue' ? GithubPullRequestDequeueInputV1Schema.parse(input)
          : GithubPullRequestAutoMergeSetInputV1Schema.parse(input);
      const result = GithubPullRequestNativeMergeActionResultV1Schema.parse(await handler(admittedInput, context));
      expect(readTriageSourceOperationOutcomeV1(result)).toEqual(result.outcome);
      return result;
    } finally { await testkit.dispose(); }
  }
  it('enqueues using the fresh native node and atomic expected head, with readback and no REST merge', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatuses: [{ mergeQueueEntry: null },
      { mergeQueueEntry: { id: 'queue-entry', state: 'QUEUED', position: 1 } }] });
    expect(await invoke('github/pull-request/enqueue', stateInput({ expectedHeadSha: OBSERVED_HEAD }), stub.context)).toMatchObject({ kind: 'applied',
      outcome: { kind: 'applied', effect: 'changed', presentation: { title: 'Done', tone: 'secondary' } } });
    const writes = stub.requests.filter((request) => request.method !== 'GET' && !String((readRecordedJsonBody(request) as { query?: unknown })?.query).startsWith('query'));
    expect(writes).toHaveLength(1);
    expect(readRecordedJsonBody(writes[0]!)).toMatchObject({ variables: { input: { pullRequestId: PULL_REQUEST_NODE_ID, expectedHeadOid: OBSERVED_HEAD } } });
    expect(JSON.stringify(readRecordedJsonBody(writes[0]!))).not.toMatch(/"jump"|"bypass"/);
  });

  it('settles an already absent queue entry without a mutation', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    expect(await invoke('github/pull-request/dequeue', stateInput(), stub.context))
      .toMatchObject({ kind: 'applied', effect: 'alreadySatisfied' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(stub.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('confirms dequeue after one native mutation', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatuses: [
      { mergeQueueEntry: { id: 'queue-entry', state: 'QUEUED', position: 1 } }, { mergeQueueEntry: null },
    ] });
    expect(await invoke('github/pull-request/dequeue', stateInput(), stub.context)).toMatchObject({ kind: 'applied', effect: 'changed' });
    const mutations = stub.requests.filter((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as { query?: string }).query).startsWith('mutation'));
    expect(mutations).toHaveLength(1);
    expect(readRecordedJsonBody(mutations[0]!)).toMatchObject({ variables: { input: { pullRequestId: PULL_REQUEST_NODE_ID } } });
  });

  it('enables auto-merge with the expected head and settles immediate native merge', async () => {
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody({ merged: true, state: 'closed' })] });
    expect(await invoke('github/pull-request/auto-merge-set', stateInput({ enabled: true,
      expectedHeadSha: OBSERVED_HEAD, mergeMethod: 'squash' }), stub.context))
      .toMatchObject({ kind: 'applied', effect: 'changed' });
    const mutations = stub.requests.filter((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as { query?: string }).query).startsWith('mutation'));
    expect(mutations).toHaveLength(1);
    expect(readRecordedJsonBody(mutations[0]!)).toMatchObject({ variables: { input: {
      pullRequestId: PULL_REQUEST_NODE_ID, expectedHeadOid: OBSERVED_HEAD, mergeMethod: 'SQUASH',
    } } });
  });

  it('cancels native auto-merge with readback and without a REST merge', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ autoMerge: { merge_method: 'squash' } }), pullRequestBody()] });
    expect(await invoke('github/pull-request/auto-merge-set', stateInput({ enabled: false,
      expectedHeadSha: OBSERVED_HEAD }), stub.context)).toMatchObject({ kind: 'applied', effect: 'changed' });
    expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('does not claim an already-enabled native method was changed', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ autoMerge: { merge_method: 'squash' } })] });
    expect(await invoke('github/pull-request/auto-merge-set', stateInput({ enabled: true,
      expectedHeadSha: OBSERVED_HEAD, mergeMethod: 'rebase' }), stub.context))
      .toMatchObject({ kind: 'refused', reason: 'state_changed' });
    expect(stub.requests.filter((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as { query?: string }).query).startsWith('mutation'))).toHaveLength(0);
  });

  it('reports an uncertain native enqueue after response loss without replay', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], write: new Error('response lost') });
    expect(await invoke('github/pull-request/enqueue', stateInput({ expectedHeadSha: OBSERVED_HEAD }), stub.context))
      .toMatchObject({ kind: 'uncertain', outcome: { kind: 'uncertain', presentation: { title: 'Outcome unknown', tone: 'warning' } } });
    expect(stub.requests.filter((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as { query?: string }).query).startsWith('mutation'))).toHaveLength(1);
  });

  it('settles a lost enqueue response only when native readback observes membership', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], write: new Error('response lost'),
      mergeStatuses: [{ mergeQueueEntry: null }, { mergeQueueEntry: { id: 'queue-entry', state: 'QUEUED', position: 2 } }] });
    expect(await invoke('github/pull-request/enqueue', stateInput({ expectedHeadSha: OBSERVED_HEAD }), stub.context))
      .toMatchObject({ kind: 'applied', effect: 'changed' });
    expect(writes(stub)).toHaveLength(1);
  });

  it('preserves a definite native permission rejection without fallback or replay', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], write: json({ message: 'Forbidden' }, 403) });
    expect(await invoke('github/pull-request/enqueue', stateInput({ expectedHeadSha: OBSERVED_HEAD }), stub.context))
      .toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
    expect(writes(stub)).toHaveLength(1);
    expect(entryReads(stub)).toHaveLength(1);
  });

  it.each([
    ['github/pull-request/enqueue', { viewerCanUpdate: false }, { expectedHeadSha: OBSERVED_HEAD }],
    ['github/pull-request/auto-merge-set', { viewerCanEnableAutoMerge: null }, { enabled: true, expectedHeadSha: OBSERVED_HEAD }],
    ['github/pull-request/enqueue', { headRefOid: ADVANCED_HEAD }, { expectedHeadSha: OBSERVED_HEAD }],
  ] as const)('refuses fresh capability/head changes for %s with zero mutations', async (id, status, operands) => {
    const stub = transportFor({ reads: [pullRequestBody()], mergeStatus: status });
    expect(await invoke(id, stateInput(operands), stub.context)).toMatchObject({ kind: 'refused' });
    expect(stub.requests.filter((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as { query?: string }).query).startsWith('mutation'))).toHaveLength(0);
  });
});

describe('GitHub pull-request review publication', () => {
  const publicationEntry = Object.freeze({
    happierCommentId: REVIEW_COMMENT_ID,
    expectedServerRevision: 3,
    anchor: Object.freeze({ kind: 'line', filePath: 'src/index.ts', line: 12, side: 'after' }),
    snapshot: Object.freeze({
      kind: 'text', selectedLines: ['return ready;'], beforeContext: [], afterContext: [],
      selectedLinesHash: 'selected', contextWindowHash: 'context', capturedAt: 1,
      fileLength: 20, source: 'committed', isUncommitted: false, isUntracked: false,
      truncated: false, hasBidiControls: false, likelyMinified: false,
      diffContext: Object.freeze({ side: 'after', baseSha: OBSERVED_BASE, headSha: OBSERVED_HEAD }),
    }),
    body: 'Explain why this is safe.',
  });

  function publicationPlan(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
      target: {
        providerId: 'github',
        configuredAccountId: CONFIGURED_ACCOUNT.accountId,
        subtarget: null,
        entryRef: {
          sourceId: `${GITHUB_PLUGIN_ID}/github-forge`,
          kindId: PULL_REQUEST_REF.kindId,
          collisionScope: PULL_REQUEST_REF.collisionScope,
          entryId: PULL_REQUEST_REF.entryId,
        },
      },
      baseRevision: OBSERVED_BASE,
      headRevision: OBSERVED_HEAD,
      entries: [publicationEntry],
      verdict: { kind: 'approve', body: 'The implementation is ready to merge.' },
      ...overrides,
    };
  }

  function publicationInput(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      publicationPlan: publicationPlan(),
      ...overrides,
    };
  }

  function reviewRecord(body: string, id = 991) {
    return {
      id, commit_id: OBSERVED_HEAD, state: 'APPROVED', body,
      user: { login: 'octocat' }, submitted_at: '2026-08-13T10:00:00Z',
    };
  }

  function commentRecord(body: string, id = 992) {
    return { id, body };
  }

  it('publishes a review through the native service identity without an invented connected account', async () => {
    const nativeToken = 'review-native-token-kept-local';
    const stub = transportFor({
      binding: null,
      reads: [pullRequestBody(), pullRequestBody()],
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: `Bearer ${nativeToken}` } },
      reviewPublicationReads: [[reviewRecord(`Review\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`)]],
      reviewCommentPublicationReads: [[commentRecord(`Comment\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`)]],
    });
    const accountPlan = publicationPlan();
    const nativeTarget = {
      providerId: accountPlan.target.providerId,
      nativeService: CONFIGURED_ACCOUNT.service,
      entryRef: accountPlan.target.entryRef,
      subtarget: accountPlan.target.subtarget,
    };
    const input = publicationInput({
      instance: {
        ...configuredInstance(),
        binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: CONFIGURED_ACCOUNT.service },
      },
      publicationPlan: publicationPlan({ target: nativeTarget }),
    });

    const result = await publishGithubPullRequestReviewAction(input, stub.context);

    expect(result.kind, JSON.stringify(result)).toBe('settled');
    expect(writes(stub)[0]?.headers.Authorization).toBe(`Bearer ${nativeToken}`);
    expect(stub.claimedPlans[0]).toMatchObject({ target: nativeTarget });
    expect(JSON.stringify(stub.claimedPlans)).not.toContain(nativeToken);
    expect(JSON.stringify(result)).not.toContain(nativeToken);
    expect(stub.materializations).toEqual([]);
  });

  it('submits summary and verdict atomically at the observed head, then returns the authoritative detail', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewPublicationReads: [[reviewRecord(
        `Review\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      )]],
      reviewCommentPublicationReads: [[commentRecord(
        `Comment\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.observation?.kind).toBe('present');
    expect(result.publication.entries[0]?.outcome).toEqual({ kind: 'published', externalRef: '992' });
    expect(result.publication.verdict).toMatchObject({
      outcome: { kind: 'published', externalRef: '991' },
    });
    expect(entryReads(stub)).toHaveLength(2);
    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(REVIEWS_PATH);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      commit_id: OBSERVED_HEAD,
      event: 'APPROVE',
      body: `The implementation is ready to merge.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      comments: [{
        path: 'src/index.ts', line: 12, side: 'RIGHT',
        body: `Explain why this is safe.\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      }],
    });
  });

  it.each(['review', 'comment', 'reply'] as const)('retains a typed claim refusal before publishing a %s', async (kind) => {
    const failure = new PluginError({ code: 'review_claim_denied', retryable: false,
      details: { requestId: 'github-publication-claim' } });
    const stub = transportFor({ reads: [pullRequestBody()], claimError: failure });
    const result = kind === 'review' ? publishGithubPullRequestReviewAction(publicationInput(), stub.context)
      : kind === 'comment' ? createGithubPullRequestReviewCommentAction(standaloneInput(), stub.context)
        : replyToGithubPullRequestThreadAction(threadReplyInput(), stub.context);
    await expect(result).rejects.toBe(failure);
    expect(writes(stub)).toHaveLength(0);
  });

  it.each([false, true])('keeps the confirmed publication and settlement failure evidence (typed: %s)', async (typed) => {
    // The review is on the pull request and the marker reread proved it. Happier's
    // own server being unreachable afterwards cannot unpublish it, so throwing here
    // would discard a confirmed external effect AND skip the post-mutation exact read
    // that every possibly-effective outcome requires. The failure is reported, not
    // swallowed, and nothing is republished.
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewPublicationReads: [[reviewRecord(
        `Review\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      )]],
      reviewCommentPublicationReads: [[commentRecord(
        `Comment\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
      settlementError: typed ? new PluginError({ code: 'review_claim_denied', retryable: false,
        details: { requestId: 'github-review-settlement' } }) : new Error('canonical settlement unavailable'),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({ kind: 'published', externalRef: '992' });
    expect(result.publication.verdict).toMatchObject({
      outcome: { kind: 'published', externalRef: '991' },
    });
    expect(result.failure).toEqual(typed ? {
      class: 'unsupportedContract', code: 'review_claim_denied', requestId: 'github-review-settlement',
    } : {
      class: 'transient',
      code: 'github_publication_settlement_unrecorded',
    });
    // The final observation still ran: the preflight read plus the confirming read.
    expect(result.observation?.kind).toBe('present');
    expect(entryReads(stub)).toHaveLength(2);
    // Exactly one outward write, and no replay of it.
    expect(writes(stub)).toHaveLength(1);
  });

  it('rejects a moved observed head before dispatch and returns what GitHub has now', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ headSha: ADVANCED_HEAD })] });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(result.observation?.kind).toBe('present');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects a moved observed base before claiming dispatch or writing', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ baseSha: ADVANCED_BASE })] });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('base_advanced');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(writes(stub)).toHaveLength(0);
  });

  it('reconciles a prior canonical claim by exact marker and issues no second write', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      claimDisposition: 'reconcile',
      reviewPublicationReads: [[reviewRecord(
        `Different visible text\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      )]],
      reviewCommentPublicationReads: [[commentRecord(
        `Different comment text\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome.kind).toBe('published');
    expect(writes(stub)).toHaveLength(0);
  });

  it('publishes an ordinary verdict-only review without inventing a comment identity', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewPublicationReads: [[reviewRecord(
        `Looks good.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      )]],
    });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({
          entries: [],
          verdict: { kind: 'approve', body: 'Looks good.' },
        }),
      }), stub.context),
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries).toEqual([]);
    expect(result.publication.verdict).toMatchObject({
      outcome: { kind: 'published', externalRef: '991' },
    });
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest)).toEqual({
      commit_id: OBSERVED_HEAD,
      event: 'APPROVE',
      body: `Looks good.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      comments: [],
    });
  });

  it('rejects inline review entries without a user-authored verdict before provider work', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewCommentPublicationReads: [[commentRecord(
        `Comment\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({ verdict: null }),
      }), stub.context),
    );

    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'invalid_input',
    });
    expect(stub.requests).toHaveLength(0);
    expect(stub.claimedPlans).toHaveLength(0);
  });

  it('retries only the released suffix and never resubmits a confirmed review entry', async () => {
    const retryEntry = Object.freeze({
      ...publicationEntry,
      happierCommentId: 'review-comment-2',
      anchor: Object.freeze({
        ...publicationEntry.anchor,
        line: 14,
      }),
      body: 'Retry only this comment.',
    });
    const retryPlan = publicationPlan({
      entries: [publicationEntry, retryEntry],
      verdict: { kind: 'comment', body: 'Review these comments.' },
    });
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      claimInstructions: { entries: ['confirmed', 'dispatch'], verdict: 'confirmed' },
      priorPublicationResult: {
        publicationPlanId: 'C'.repeat(43),
        entries: [
          {
            happierCommentId: REVIEW_COMMENT_ID,
            publicationCorrelationId: COMMENT_CORRELATION_ID,
            outcome: { kind: 'published', externalRef: 'native-first' },
          },
          {
            happierCommentId: retryEntry.happierCommentId,
            publicationCorrelationId: 'C'.repeat(43),
            outcome: { kind: 'failed', code: 'provider/rejected' },
          },
        ],
        verdict: {
          publicationCorrelationId: VERDICT_CORRELATION_ID,
          outcome: { kind: 'published', externalRef: 'native-verdict' },
        },
      },
      reviewCommentPublicationReads: [[commentRecord(
        `Retry\n\n<!-- happier-review-comment:v1:${'C'.repeat(43)} -->`,
        993,
      )]],
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({ publicationPlan: retryPlan }), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries.map((entry) => entry.outcome)).toEqual([
      { kind: 'published', externalRef: 'native-first' },
      { kind: 'published', externalRef: '993' },
    ]);
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest)).toMatchObject({
      event: 'COMMENT',
      // A suffix retry still creates a native review body. Its own dispatched
      // entry marker suppresses loop intake without duplicating the already
      // confirmed verdict marker (which would make response-loss matching ambiguous).
      body: `Review these comments.\n\n<!-- happier-review-comment:v1:${'C'.repeat(43)} -->`,
      comments: [{
        path: 'src/index.ts',
        line: 14,
        side: 'RIGHT',
        body: `Retry only this comment.\n\n<!-- happier-review-comment:v1:${'C'.repeat(43)} -->`,
      }],
    });
    expect(stub.claimedPlans).toHaveLength(2);
    expect(stub.claimedPlans[1]).toMatchObject({
      settlement: {
        dispatchToken: 'dispatch-token-1',
        result: {
          entries: [
            { outcome: { kind: 'published', externalRef: 'native-first' } },
            { outcome: { kind: 'published', externalRef: '993' } },
          ],
        },
      },
    });
  });

  it('rechecks an archived repository before claiming or dispatching publication', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      repository: {
        id: 4210,
        archived: true,
        has_issues: true,
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      },
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'admission_failed',
      failure: { class: 'permission', code: 'repository_archived' },
    });
    expect(stub.claimedPlans).toHaveLength(0);
    expect(writes(stub)).toHaveLength(0);
    expect(stub.requests.some((request) => new URL(request.url).pathname === REPOSITORY_PATH))
      .toBe(true);
  });

  it('refuses a diff-less review entry without a verdict before durable claim', async () => {
    const { diffContext: _diffContext, ...summarySnapshot } = publicationEntry.snapshot;
    const summaryEntry = {
      ...publicationEntry,
      anchor: { kind: 'folder', folderPath: 'src' },
      snapshot: summarySnapshot,
    };
    const stub = transportFor({ reads: [pullRequestBody()] });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({ entries: [summaryEntry], verdict: null }),
      }), stub.context),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('invalid_input');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('folds a diff-less entry and marker into the verdict and shares its external review ref', async () => {
    const { diffContext: _diffContext, ...summarySnapshot } = publicationEntry.snapshot;
    const summaryEntry = {
      ...publicationEntry,
      anchor: { kind: 'folder', folderPath: 'src' },
      snapshot: summarySnapshot,
      body: 'The project-level concern is resolved.',
    };
    const reviewBody = `Ready.\n\nThe project-level concern is resolved.\n\n`
      + `<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->\n\n`
      + `<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`;
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewPublicationReads: [[reviewRecord(reviewBody)]],
    });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({
          entries: [summaryEntry],
          verdict: { kind: 'approve', body: 'Ready.' },
        }),
      }), stub.context),
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({ kind: 'published', externalRef: '991' });
    expect(result.publication.verdict).toMatchObject({ outcome: { kind: 'published', externalRef: '991' } });
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest)).toMatchObject({
      body: reviewBody,
      comments: [],
    });
  });

  it.each([
    { verdict: 'approve', event: 'APPROVE', status: 422, message: 'Can not approve your own pull request', code: 'github_review_own_pull_request' },
    { verdict: 'requestChanges', event: 'REQUEST_CHANGES', status: 422, message: 'Can not request changes on your own pull request', code: 'github_review_own_pull_request' },
    { verdict: 'approve', event: 'APPROVE', status: 403, message: 'Resource not accessible by integration', code: 'github_forbidden' },
  ])('surfaces $code for the requested $event without retrying as a comment', async ({ verdict, event, status, message, code }) => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: json({ message: 'Validation Failed', errors: [{ message }] }, status),
    });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({ publicationPlan: publicationPlan({
        entries: [], verdict: { kind: verdict, body: 'Review the change.' },
      }) }), stub.context),
    );
    expect(result).toMatchObject({ kind: 'settled', failure: { class: 'permission', code } });
    if (status === 422) {
      expect(result).toMatchObject({
        failure: { detail: expect.stringContaining('another account') },
        publication: { verdict: { outcome: { kind: 'failed', code } } },
      });
    }
    expect(writes(stub).map(write => readRecordedJsonBody(write).event)).toEqual([event]);
  });

  it('preserves a marker-confirmed comment when a 4xx response leaves the verdict uncertain', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: json({ message: 'Validation Failed' }, 422),
      reviewCommentPublicationReads: [[commentRecord(
        `Comment landed\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
    });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({
      kind: 'published', externalRef: '992',
    });
    expect(result.publication.verdict).toMatchObject({ outcome: { kind: 'uncertain' } });
    expect(result.failure?.code).toBe('github_unprocessable');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reports uncertainty when GitHub accepted the one submission but the authoritative reread fails', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      readStatus: 503,
      write: json({ id: 991, state: 'CHANGES_REQUESTED' }, 201),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({
          verdict: { kind: 'requestChanges', body: 'Please revise.' },
        }),
      }), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
  });

  it('does not fabricate rejection when GitHub returns a server failure after dispatch', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.failure?.code).toBe('github_server_error');
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(1);
  });

  it('confirms an answer-lost submission from a new authoritative review and never writes twice', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewPublicationReads: [[reviewRecord(
        `The implementation is ready to merge.\n\n<!-- happier-review-verdict:v1:${VERDICT_CORRELATION_ID} -->`,
      )]],
      reviewCommentPublicationReads: [[commentRecord(
        `Explain why this is safe.\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
      // The boundary records the POST and then loses its answer. The source must
      // reconcile that one attempt; issuing another POST would duplicate the review.
      write: new Error('socket closed after request dispatch'),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome.kind).toBe('published');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === REVIEWS_PATH)).toHaveLength(1);
  });

  it('keeps an answer-lost submission uncertain when the authoritative review read cannot decide', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewPublicationReads: [[{}]],
      write: new Error('socket closed after request dispatch'),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome.kind).toBe('uncertain');
    expect(result.failure?.code).toBe('github_request_failed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === REVIEWS_PATH)).toHaveLength(1);
  });

  it('settles an unsupported fresh anchor as failed without guessing positions or writing', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const unsupported = {
      ...publicationEntry,
      anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'hunk-1' },
    };

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(
        publicationInput({ publicationPlan: publicationPlan({ entries: [unsupported] }) }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('unsupported_anchor');
    expect(stub.claimedPlans[1]).toMatchObject({ settlement: {
      dispatchToken: 'dispatch-token-1',
      result: {
        entries: [{ happierCommentId: REVIEW_COMMENT_ID, outcome: { kind: 'failed', code: 'unsupported_anchor' } }],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    } });
    expect(writes(stub)).toHaveLength(0);
  });

  it('settles a stale fresh diff snapshot as failed without writing', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const stale = {
      ...publicationEntry,
      snapshot: {
        ...publicationEntry.snapshot,
        diffContext: { ...publicationEntry.snapshot.diffContext, baseSha: ADVANCED_BASE },
      },
    };
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(
        publicationInput({ publicationPlan: publicationPlan({ entries: [stale] }) }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('unsupported_anchor');
    expect(stub.claimedPlans[1]).toMatchObject({ settlement: {
      dispatchToken: 'dispatch-token-1',
      result: {
        entries: [{ happierCommentId: REVIEW_COMMENT_ID, outcome: { kind: 'failed', code: 'unsupported_anchor' } }],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    } });
    expect(writes(stub)).toHaveLength(0);
  });

  it.each([
    ['unsupported anchor', {
      ...publicationEntry,
      anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'hunk-1' },
    }],
    ['stale diff snapshot', {
      ...publicationEntry,
      snapshot: {
        ...publicationEntry.snapshot,
        diffContext: { ...publicationEntry.snapshot.diffContext, baseSha: ADVANCED_BASE },
      },
    }],
  ])('retains a confirmed publication with an %s without another provider write', async (_label, entry) => {
    const priorPublicationResult = {
      publicationPlanId: 'C'.repeat(43),
      entries: [{
        happierCommentId: REVIEW_COMMENT_ID,
        publicationCorrelationId: COMMENT_CORRELATION_ID,
        outcome: { kind: 'published', externalRef: 'native-first' },
      }],
      verdict: {
        publicationCorrelationId: VERDICT_CORRELATION_ID,
        outcome: { kind: 'published', externalRef: 'native-verdict' },
      },
    };
    const stub = transportFor({
      reads: [pullRequestBody()],
      claimDisposition: 'reconcile',
      claimInstructions: { entries: ['confirmed'], verdict: 'confirmed' },
      priorPublicationResult,
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({ entries: [entry] }),
      }), stub.context),
    );

    expect(result).toMatchObject({ kind: 'settled', publication: priorPublicationResult });
    expect(stub.claimedPlans[1]).toMatchObject({ settlement: {
      dispatchToken: null, result: priorPublicationResult,
    } });
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects an inner target from a different configured account before admission', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({
          target: {
            ...publicationPlan().target,
            configuredAccountId: 'different-account',
          },
        }),
      }), stub.context),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('invalid_input');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
  });

  it.each([
    ['provider', { providerId: 'gitlab' }],
    ['source', { entryRef: { ...publicationPlan().target.entryRef, sourceId: 'wrong/source' } }],
    ['kind', { entryRef: { ...publicationPlan().target.entryRef, kindId: 'issue' } }],
    ['collision scope', {
      entryRef: { ...publicationPlan().target.entryRef, collisionScope: 'github:different' },
    }],
    ['entry id', { entryRef: { ...publicationPlan().target.entryRef, entryId: '9999' } }],
  ])('rejects a mismatched inner %s before admission or claim', async (_label, targetPatch) => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const target = publicationPlan().target;
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput({
        publicationPlan: publicationPlan({
          target: {
            ...target,
            ...targetPatch,
          },
        }),
      }), stub.context),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('invalid_input');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects a malformed canonical publication plan before admission or claim', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(
        publicationInput({ publicationPlan: { target: null } }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('invalid_input');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('projects an exact multi-line range into GitHub singleRequest comments', async () => {
    const rangeEntry = {
      ...publicationEntry,
      anchor: { kind: 'range', filePath: 'src/index.ts', startLine: 9, endLine: 12, side: 'before' },
      snapshot: {
        ...publicationEntry.snapshot,
        diffContext: { ...publicationEntry.snapshot.diffContext, side: 'before' },
      },
    };
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody()] });
    await publishGithubPullRequestReviewAction(publicationInput({
      publicationPlan: publicationPlan({ entries: [rangeEntry] }),
    }), stub.context);
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest)).toMatchObject({
      comments: [{
        path: 'src/index.ts', start_line: 9, start_side: 'LEFT', line: 12, side: 'LEFT',
      }],
    });
  });

  function standaloneInput(planOverrides: Readonly<Record<string, unknown>> = {}) {
    return publicationInput({
      publicationPlan: publicationPlan({
        entries: [publicationEntry],
        verdict: null,
        ...planOverrides,
      }),
    });
  }

  it.each([
    ['unsupported anchor', { ...publicationEntry, anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'h1' } }],
    ['stale diff snapshot', { ...publicationEntry, snapshot: {
      ...publicationEntry.snapshot,
      diffContext: { ...publicationEntry.snapshot.diffContext, baseSha: ADVANCED_BASE },
    } }],
  ])('rejoins a confirmed standalone comment with %s without a provider write', async (_label, entry) => {
    const priorPublicationResult = {
      publicationPlanId: 'C'.repeat(43),
      entries: [{ happierCommentId: REVIEW_COMMENT_ID, publicationCorrelationId: COMMENT_CORRELATION_ID,
        outcome: { kind: 'published', externalRef: '992' } }],
      verdict: { kind: 'notRequested' },
    };
    const stub = transportFor({ reads: [pullRequestBody()], claimDisposition: 'reconcile',
      claimInstructions: { entries: ['confirmed'], verdict: null }, priorPublicationResult });

    const result = GithubPullRequestReviewCommentCreateResultV1Schema.parse(
      await createGithubPullRequestReviewCommentAction(standaloneInput({ entries: [entry] }), stub.context),
    );

    expect(result).toMatchObject({ kind: 'settled', publication: priorPublicationResult });
    expect(stub.claimedPlans[1]).toMatchObject({ settlement: { dispatchToken: null, result: priorPublicationResult } });
    expect(writes(stub)).toHaveLength(0);
  });

  it('settles an unsupported fresh standalone comment as failed without a provider write', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const result = await createGithubPullRequestReviewCommentAction(standaloneInput({ entries: [{
      ...publicationEntry, anchor: { kind: 'hunk', filePath: 'src/index.ts', hunkId: 'h1' },
    }] }), stub.context);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'unsupported_anchor' });
    expect(stub.claimedPlans[1]).toMatchObject({ settlement: { dispatchToken: 'dispatch-token-1', result: {
      entries: [{ happierCommentId: REVIEW_COMMENT_ID, outcome: { kind: 'failed', code: 'unsupported_anchor' } }],
      verdict: { kind: 'notRequested' },
    } } });
    expect(writes(stub)).toHaveLength(0);
  });

  it('publishes one canonical proposal as a standalone pinned review comment', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewCommentPublicationReads: [[commentRecord(
        `Landed\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      )]],
    });
    const result = GithubPullRequestReviewCommentCreateResultV1Schema.parse(
      await createGithubPullRequestReviewCommentAction(standaloneInput(), stub.context),
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({ kind: 'published', externalRef: '992' });
    const dispatched = stub.requests.find((request) => request.method === 'POST'
      && new URL(request.url).pathname === `${PULL_REQUEST_PATH}/comments`);
    expect(dispatched).toBeDefined();
    expect(readRecordedJsonBody(dispatched!)).toEqual({
      path: 'src/index.ts',
      line: 12,
      side: 'RIGHT',
      body: `Explain why this is safe.\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      commit_id: OBSERVED_HEAD,
    });
  });

  it('rechecks archive status before claiming a standalone review comment', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      repository: archivedRepositoryBody(),
    });
    const result = GithubPullRequestReviewCommentCreateResultV1Schema.parse(
      await createGithubPullRequestReviewCommentAction(standaloneInput(), stub.context),
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'admission_failed',
      failure: { class: 'permission', code: 'repository_archived' },
    });
    expect(stub.claimedPlans).toHaveLength(0);
    expect(writes(stub)).toHaveLength(0);
  });

  it('refuses a moved standalone comment base before claim or write', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ baseSha: ADVANCED_BASE })] });
    const result = GithubPullRequestReviewCommentCreateResultV1Schema.parse(
      await createGithubPullRequestReviewCommentAction(standaloneInput(), stub.context),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('base_advanced');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('rejects plural or verdict-bearing standalone comment plans at Action admission', async () => {
    for (const publicationPlanOverride of [
      publicationPlan({ entries: [publicationEntry, { ...publicationEntry, happierCommentId: 'second' }], verdict: null }),
      publicationPlan({ entries: [publicationEntry], verdict: { kind: 'comment', body: 'Summary' } }),
    ]) {
      const stub = transportFor({ reads: [pullRequestBody()] });
      const result = GithubPullRequestReviewCommentCreateResultV1Schema.parse(
        await createGithubPullRequestReviewCommentAction(
          publicationInput({ publicationPlan: publicationPlanOverride }), stub.context,
        ),
      );
      expect(result.kind).toBe('rejected');
      expect(stub.claimedPlans).toHaveLength(0);
      expect(stub.requests).toHaveLength(0);
    }
  });

  function threadReplyInput(planOverrides: Readonly<Record<string, unknown>> = {}) {
    return publicationInput({
      threadId: REVIEW_THREAD_ID,
      publicationPlan: publicationPlan({
        target: { ...publicationPlan().target, subtarget: { kindId: 'review-thread', targetId: REVIEW_THREAD_ID } },
        baseRevision: null,
        headRevision: null,
        entries: [publicationEntry],
        verdict: null,
        ...planOverrides,
      }),
    });
  }

  it('publishes and reconciles one reply inside the exact GraphQL review thread', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      threadPublicationReads: [[{
        id: 'thread-comment',
        body: `Reply\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      }]],
    });
    const result = GithubPullRequestThreadReplyResultV1Schema.parse(
      await replyToGithubPullRequestThreadAction(threadReplyInput(), stub.context),
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({
      kind: 'published', externalRef: 'thread-comment',
    });
    const reply = stub.requests.find((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as Readonly<Record<string, unknown>>).query)
        .includes('GithubReplyToReviewThread'));
    expect(reply).toBeDefined();
    expect(readRecordedJsonBody(reply!)).toMatchObject({
      variables: {
        threadId: REVIEW_THREAD_ID,
        body: `Explain why this is safe.\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      },
    });
  });

  it('rechecks archive status before claiming a review-thread reply', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      repository: archivedRepositoryBody(),
    });
    const result = GithubPullRequestThreadReplyResultV1Schema.parse(
      await replyToGithubPullRequestThreadAction(threadReplyInput(), stub.context),
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'admission_failed',
      failure: { class: 'permission', code: 'repository_archived' },
    });
    expect(stub.claimedPlans).toHaveLength(0);
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects a reply whose canonical subtarget names a different thread before any call', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });
    const result = GithubPullRequestThreadReplyResultV1Schema.parse(
      await replyToGithubPullRequestThreadAction(threadReplyInput({
        target: {
          ...publicationPlan().target,
          subtarget: { kindId: 'review-thread', targetId: 'another-thread' },
        },
      }), stub.context),
    );
    expect(result.kind).toBe('rejected');
    expect(stub.claimedPlans).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('reports a definite GraphQL reply rejection as failed, but answer loss as uncertain', async () => {
    const rejected = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: json({ data: null, errors: [{ message: 'Forbidden', type: 'FORBIDDEN' }] }),
    });
    const rejectedResult = GithubPullRequestThreadReplyResultV1Schema.parse(
      await replyToGithubPullRequestThreadAction(threadReplyInput(), rejected.context),
    );
    expect(rejectedResult.kind).toBe('settled');
    if (rejectedResult.kind !== 'settled') throw new Error('expected settled rejection');
    expect(rejectedResult.publication.entries[0]?.outcome.kind).toBe('failed');

    const lost = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: new Error('reply answer lost'),
      threadPublicationReads: [[]],
    });
    const lostResult = GithubPullRequestThreadReplyResultV1Schema.parse(
      await replyToGithubPullRequestThreadAction(threadReplyInput(), lost.context),
    );
    expect(lostResult.kind).toBe('settled');
    if (lostResult.kind !== 'settled') throw new Error('expected settled ambiguity');
    expect(lostResult.publication.entries[0]?.outcome.kind).toBe('uncertain');
    const replyWrites = lost.requests.filter((request) => request.method === 'POST'
      && String((readRecordedJsonBody(request) as Readonly<Record<string, unknown>>).query)
        .includes('GithubReplyToReviewThread'));
    expect(replyWrites).toHaveLength(1);
  });
});

function writes(stub: StubGithubTransport): readonly RecordedGithubRequest[] {
  return stub.requests.filter((request) => {
    if (request.method === 'GET') return false;
    if (new URL(request.url).pathname !== GRAPHQL_PATH) return true;
    // GraphQL reads use POST too. Counting the exact thread preflight query as
    // a write would make the archive-before-claim assertion fail while no
    // provider mutation was dispatched.
    const body = readRecordedJsonBody(request) as Readonly<Record<string, unknown>>;
    return typeof body.query === 'string' && /^\s*mutation\b/u.test(body.query);
  });
}

function entryReads(stub: StubGithubTransport): readonly RecordedGithubRequest[] {
  return stub.requests.filter((request) => request.method === 'GET'
    && new URL(request.url).pathname === PULL_REQUEST_PATH);
}

/* ---------------------------------------------------------------------- merge */

describe('GitHub pull-request merge', () => {
  it('merges at the exact observed head and claims it only after the confirming read', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
    });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(
        mergeInput({ commitTitle: 'Stream terminal frames (#1284)' }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected an applied merge, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.observation.kind).toBe('present');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PUT');
    // The user's pinned head goes to GitHub's OWN precondition, verbatim, and the
    // body carries nothing GitHub's merge endpoint does not document.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      sha: OBSERVED_HEAD,
      merge_method: 'squash',
      commit_title: 'Stream terminal frames (#1284)',
    });
    // GitHub's merge owns ONE external effect. A successful merge is never followed
    // by a source-ref delete: that endpoint has no expected-tip guard, so it would
    // race a collaborator's later push.
    expect(stub.requests.some((request) => request.method === 'DELETE')).toBe(false);
    // The claim rests on a confirming read, not on the write's own response.
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === PULL_REQUEST_PATH)).toHaveLength(2);
  });

  it('refuses a merge whose head advanced, with zero writes and the head GitHub now has', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ headSha: ADVANCED_HEAD })] });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    // The host must re-render with the head GitHub currently has. A generic error
    // would leave it rendering the commits the user already decided about.
    expect(result.observation?.kind).toBe('present');
    if (result.observation?.kind !== 'present') throw new Error('unreachable');
    // `nativeRevision` is a top-level field of the published present observation,
    // not a snapshot field: the snapshot schema is `additive-open/drop`, so
    // asserting it there would silently read `undefined` forever and pass against
    // any head the provider returned.
    expect(result.observation.nativeRevision).toBe(ADVANCED_HEAD);
    expect(writes(stub)).toHaveLength(0);
  });

  it('treats a 409 as a moved head, confirms once, and never reissues the write', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ headSha: ADVANCED_HEAD })],
      write: { status: 409, headers: {}, body: { message: 'Head branch was modified.' } },
    });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reports a 405 as not mergeable rather than as a bare provider error', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: { status: 405, headers: {}, body: { message: 'Pull Request is not mergeable' } },
    });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('not_mergeable');
    expect(writes(stub)).toHaveLength(1);
  });

  it('refuses a merge method the repository forbids instead of dispatching it', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      repository: { ...GITHUB_REPOSITORY_RESPONSE, allow_rebase_merge: false },
    });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput({ mergeMethod: 'rebase' }), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('merge_method_not_allowed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('never turns an unstated repository merge setting into a prohibition', async () => {
    // GitHub omits `allow_*` for some credentials and visibilities. Silence is
    // unknown, and refusing on it would block a merge the repository allows.
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
      repository: GITHUB_REPOSITORY_RESPONSE,
    });
    expect(Object.keys(GITHUB_REPOSITORY_RESPONSE)).not.toContain('allow_rebase_merge');

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput({ mergeMethod: 'rebase' }), stub.context),
    );
    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
  });

  it('returns the re-observed entity for an already merged pull request without writing', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed', merged: true })] });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    // A second merge converges on the same state rather than creating a second
    // object — but it is answered from the read, not from a request.
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reports an accepted merge whose confirming read failed as uncertain, not as success', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], readStatus: 500 });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.failure?.class).toBe('transient');
    // One write, and no retry: the user's decision was about the state they saw.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after dispatch before reporting the merge outcome', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    // A 5xx can arrive after GitHub applied the merge. The authoritative reread,
    // rather than the failed response, decides the one outcome we report.
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('makes no request at all for a ref this write does not apply to', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestMergeActionResultV1Schema.parse(
      await mergeGithubPullRequestAction(
        mergeInput({ localRef: { ...PULL_REQUEST_REF, kindId: 'issue' } }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- close/reopen */

describe('GitHub pull-request close and reopen', () => {
  it('closes an open pull request through the native state patch and confirms it', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PATCH');
    // Exactly the named transition. Nothing else about the pull request is
    // replaced by a write the user did not ask for.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({ state: 'closed' });
  });

  it('answers an already closed pull request from the read, with no second write', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed' })] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('does not call an already merged pull request an already satisfied close', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed', merged: true })] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('state_changed');
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reopens a closed, unmerged pull request', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ state: 'closed' }), pullRequestBody()],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await reopenGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest)).toEqual({ state: 'open' });
  });

  it('refuses to reopen a merged pull request and never patches it', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed', merged: true })] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await reopenGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('state_changed');
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(0);
  });

  it('maps a rejected state patch to its classified provider failure', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      write: {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'pull_requests=write' },
        body: { message: 'Resource not accessible' },
      },
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'insufficient_scope', detail: 'pull_requests=write', requiredPermissions: 'pull_requests=write' });
  });

  it('reconciles a possibly-applied state patch after a server error', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed' })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('does not confirm a close when the pull request merged during the write', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
  });

  it('rebinds the exact configured account on every write invocation', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed' })],
    });

    await closeGithubPullRequestAction(stateInput(), stub.context);
    // Cached corpus bytes never authorize a mutation: the account is
    // rematerialized for THIS invocation, against the exact configured ref.
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ----------------------------------------------------------------- mark ready */

describe('GitHub pull-request mark ready for review', () => {
  it('preserves actionable permission feedback in the original Action outcome', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ draft: true })],
      write: json({ message: 'Resource not accessible' }, 403) });
    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context));
    expect(result).toMatchObject({ kind: 'failed', failure: { class: 'permission' },
      outcome: { kind: 'failed', failure: { class: 'permission' }, presentation: { tone: 'danger' } } });
    expect(result.outcome.presentation.description).toContain('Grant it access');
    expect(result.outcome.presentation.descriptionKey).toBeUndefined();
  });

  it('preserves uncertainty advice together with failed confirming-read access guidance', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ draft: true })], readStatus: 403, write: new Error('response lost') });
    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context));
    expect(result).toMatchObject({ kind: 'uncertain', outcome: { kind: 'uncertain', failure: { class: 'permission' } } });
    expect(result.outcome.presentation.description).toContain('Grant it access');
    expect(result.outcome.presentation.description).toContain('rather than pressing again');
    expect(result.outcome.presentation.descriptionKey).toBeUndefined();
    expect(writes(stub)).toHaveLength(1);
  });

  it('marks a draft ready through GitHub’s own transition at the observed head', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true }), pullRequestBody({ draft: false })],
    });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    // `PATCH /pulls/{n}` documents no draft field, and a REST field GitHub does
    // not document is silently ignored — the worst outcome, because the user
    // would believe every reviewer was summoned.
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(GRAPHQL_PATH);
    const body = readRecordedJsonBody(dispatched[0] as RecordedGithubRequest) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('markPullRequestReadyForReview');
    // Addressed by the node id THIS validated read published, never by a guess
    // built from the number.
    expect(body.variables).toEqual({ pullRequestId: PULL_REQUEST_NODE_ID });
    // The claim rests on the confirming read, not on the mutation payload.
    expect(entryReads(stub)).toHaveLength(2);
  });

  it('refuses a draft whose head advanced, with zero writes and the head GitHub now has', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true, headSha: ADVANCED_HEAD })],
    });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    // The write's effect IS the notification fan-out. Against a stale head it
    // summons reviewers to commits the acting user never saw.
    expect(result.reason).toBe('head_advanced');
    if (result.observation?.kind !== 'present') throw new Error('expected the observed entity');
    expect(result.observation.nativeRevision).toBe(ADVANCED_HEAD);
    expect(writes(stub)).toHaveLength(0);
  });

  it('answers a pull request that is already ready from the read, with no notification', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ draft: false })] });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('refuses a draft that is no longer open instead of dispatching a transition', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true, state: 'closed' })],
    });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('state_changed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('never reads a GraphQL 200 carrying errors as a successful transition', async () => {
    // GraphQL answers `200 OK` for its own failures: a rejected mutation returns
    // `data: null` with a populated `errors` array. A transport success is not a
    // claim that the provider changed anything.
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true })],
      write: json({
        data: null,
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
      }),
    });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'github_forbidden' });
    expect(writes(stub)).toHaveLength(1);
    // A rejected mutation changed nothing, so there is no second read to make.
    expect(entryReads(stub)).toHaveLength(1);
  });

  it('never dispatches a transition for an entity the read published no node id for', async () => {
    const { node_id: _omitted, ...withoutNodeId } = pullRequestBody({ draft: true });
    const stub = transportFor({ reads: [withoutNodeId] });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: 'github_entity_id_unavailable',
    });
    // Addressing the transition with a guessed id would mark whatever currently
    // occupies that route ready for review.
    expect(writes(stub)).toHaveLength(0);
  });

  it('reports an accepted transition the confirming read still sees as draft as uncertain', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true }), pullRequestBody({ draft: true })],
    });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.observation?.kind).toBe('present');
    // One request, and no retry: a retry would re-decide on the user's behalf.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after GitHub may have marked the pull request ready', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true }), pullRequestBody({ draft: false })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestMarkReadyActionResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- update branch */

describe('GitHub pull-request update branch', () => {
  it('sends GitHub’s own expected-head precondition and applies once the head moved', async () => {
    const stub = transportFor({
      reads: [
        pullRequestBody({ mergeableState: 'behind' }),
        pullRequestBody({ headSha: ADVANCED_HEAD }),
      ],
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PUT');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(UPDATE_BRANCH_PATH);
    // The user's pinned head goes to GitHub's OWN precondition verbatim, and the
    // body carries nothing else.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ expected_head_sha: OBSERVED_HEAD });
  });

  it('refuses without a PUT when GitHub does not report the branch as behind', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ mergeableState: 'clean' })] });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );

    expect(result).toMatchObject({ kind: 'refused', reason: 'state_changed' });
    expect(writes(stub)).toHaveLength(0);
  });

  it('reports an accepted update the confirming read cannot yet observe as pending', async () => {
    // `202 Accepted` states that GitHub took the request, not that the branch
    // moved. Calling this applied would tell the user their branch was updated
    // while the update is still queued.
    const stub = transportFor({
      reads: [pullRequestBody({ mergeableState: 'behind' }), pullRequestBody()],
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`);
    if (result.observation.kind !== 'present') throw new Error('expected the observed entity');
    expect(result.observation.nativeRevision).toBe(OBSERVED_HEAD);
    // Accepted once. No poll on a source timer, and no second PUT.
    expect(writes(stub)).toHaveLength(1);
    expect(entryReads(stub)).toHaveLength(2);
  });

  it('confirms an answer-lost update once and never maps it to definite failure', async () => {
    let pullRequestRead = 0;
    const stub = createStubGithubTransport({
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
          const body = pullRequestRead++ === 0
            ? pullRequestBody({ mergeableState: 'behind' })
            : pullRequestBody({ headSha: ADVANCED_HEAD });
          return json(body);
        }
        if (request.method === 'PUT' && path === UPDATE_BRANCH_PATH) {
          return Promise.reject(new Error('answer lost after dispatch'));
        }
        return undefined;
      },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
    expect(entryReads(stub)).toHaveLength(2);
  });

  it('refuses an update whose head advanced, with zero PUTs', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ headSha: ADVANCED_HEAD })] });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(writes(stub)).toHaveLength(0);
  });

  it('maps a 422 whose confirming read shows a moved head to head_advanced, and never reissues', async () => {
    const stub = transportFor({
      reads: [
        pullRequestBody({ mergeableState: 'behind' }),
        pullRequestBody({ headSha: ADVANCED_HEAD }),
      ],
      write: { status: 422, headers: {}, body: { message: 'Expected head sha didn’t match' } },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after GitHub may have accepted an update branch request', async () => {
    const stub = transportFor({
      reads: [
        pullRequestBody({ mergeableState: 'behind' }),
        pullRequestBody({ headSha: ADVANCED_HEAD }),
      ],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('preserves the server failure when the exact reread cannot prove an update landed', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ mergeableState: 'behind' }), pullRequestBody()],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );

    expect(result).toMatchObject({
      kind: 'uncertain',
      failure: { class: 'transient', code: 'github_server_error' },
    });
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('maps a 422 whose head did not move to the classified provider failure', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ mergeableState: 'behind' }), pullRequestBody()],
      write: { status: 422, headers: {}, body: { message: 'merge conflict between base and head' } },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'unsupportedContract', code: 'github_unprocessable' });
    expect(writes(stub)).toHaveLength(1);
  });

  it('maps a 403 to the permission failure GitHub’s own header names, with no second read', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ mergeableState: 'behind' })],
      write: {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'contents=write' },
        body: { message: 'Resource not accessible' },
      },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'insufficient_scope', detail: 'contents=write', requiredPermissions: 'contents=write' });
    expect(entryReads(stub)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- add reviewers */

describe('GitHub pull-request reviewer requests', () => {
  it('requests exactly the named users and teams and confirms each named addition', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({}),
        reviewerCollection({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.requestedReviewers).toEqual({
      users: ['octocat'],
      teams: ['frame-pump-reviewers'],
    });

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(REVIEWERS_PATH);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      reviewers: ['octocat'],
      team_reviewers: ['frame-pump-reviewers'],
    });
  });

  it('sends an exact delta, so a reviewer somebody else requested is never withdrawn', async () => {
    // A desired full set would silently withdraw `monalisa`, whom a colleague
    // requested between our read and our write. A delta cannot.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['monalisa'] }),
        reviewerCollection({ users: ['monalisa', 'octocat'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    // Only the named addition leaves, and no team member is sent at all.
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest))
      .toEqual({ reviewers: ['octocat'] });
    // Confirmation checks only the requested addition; the unrelated reviewer is
    // reported, not equality-checked.
    expect(result.requestedReviewers.users).toEqual(['monalisa', 'octocat']);
  });

  it('answers an already pending reviewer from the read rather than re-notifying them', async () => {
    // GitHub logins are case-insensitive and it answers in its own canonical
    // casing. Re-requesting a pending reviewer is not free: it notifies again.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['OctoCat'] })],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects an empty delta before any request leaves', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(stateInput(), stub.context),
    );
    expect(result.kind).toBe('failed');
    // An empty request is rejected rather than turned into a request for nobody.
    expect(stub.requests).toHaveLength(0);
  });

  it('reports an addition the confirming read did not observe as uncertain, not as success', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({}), reviewerCollection({})],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.requestedReviewers).toEqual({ users: [], teams: [] });
    // One request, never retried: a retry would notify a second time.
    expect(writes(stub)).toHaveLength(1);
  });

  it('confirms an answer-lost reviewer request once and never re-notifies', async () => {
    let reviewerRead = 0;
    const stub = createStubGithubTransport({
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
          return json(pullRequestBody());
        }
        if (request.method === 'GET' && path === REVIEWERS_PATH) {
          return json(reviewerRead++ === 0
            ? reviewerCollection({})
            : reviewerCollection({ users: ['octocat'] }));
        }
        if (request.method === 'POST' && path === REVIEWERS_PATH) {
          return Promise.reject(new Error('answer lost after dispatch'));
        }
        return undefined;
      },
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => (
      request.method === 'GET' && new URL(request.url).pathname === REVIEWERS_PATH
    ))).toHaveLength(2);
  });

  it('reconciles a server error after a reviewer request may have been applied', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({}), reviewerCollection({ users: ['octocat'] })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => (
      request.method === 'GET' && new URL(request.url).pathname === REVIEWERS_PATH
    ))).toHaveLength(2);
  });

  it('never requests reviewers on a route whose entry identity no longer validates', async () => {
    // A stale routing token that resolves to another repository's pull request
    // would otherwise summon strangers to somebody else's code.
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({
          users: ['octocat'],
          localRef: { ...PULL_REQUEST_REF, collisionScope: 'github:8815' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests.some((request) => (
      new URL(request.url).pathname === REVIEWERS_PATH
    ))).toBe(false);
  });

  it('rebinds the exact configured account on a reviewer request', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({}), reviewerCollection({ users: ['octocat'] })],
    });

    await addGithubPullRequestReviewersAction(
      stateInput({ users: ['octocat'] }),
      stub.context,
    );
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ------------------------------------------------------- reviewer withdrawal */

describe('GitHub pull-request reviewer withdrawal', () => {
  it('withdraws exactly the named users and teams and confirms each named removal', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
        reviewerCollection({}),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.requestedReviewers).toEqual({ users: [], teams: [] });

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    // GitHub's own withdrawal endpoint, which is a DELETE on the same collection —
    // never `PUT /requested_reviewers` and never a desired full set.
    expect(dispatched[0]?.method).toBe('DELETE');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(REVIEWERS_PATH);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      reviewers: ['octocat'],
      team_reviewers: ['frame-pump-reviewers'],
    });
  });

  it('sends an exact delta, so a reviewer somebody else requested is never withdrawn', async () => {
    // The one failure a desired full set makes unavoidable: `monalisa` was
    // requested by a colleague between our read and our write and must survive a
    // withdrawal that never named her.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['octocat', 'monalisa'] }),
        reviewerCollection({ users: ['monalisa'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest))
      .toEqual({ reviewers: ['octocat'] });
    // Confirmation checks only the requested removal. The reviewer nobody asked to
    // withdraw is reported, not equality-checked and not restored.
    expect(result.requestedReviewers.users).toEqual(['monalisa']);
  });

  it('answers a reviewer who is not requested from the read, with no write at all', async () => {
    // GitHub logins are case-insensitive and it answers in its own canonical
    // casing, so `OctoCat` present must count as `octocat` still requested.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['monalisa'] })],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects an empty delta before any request leaves', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(stateInput(), stub.context),
    );
    expect(result.kind).toBe('failed');
    // An empty withdrawal is rejected rather than turned into a removal of nobody.
    expect(stub.requests).toHaveLength(0);
  });

  it('reports a withdrawal the confirming read still observes as uncertain, not as success', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['octocat'] }),
        reviewerCollection({ users: ['octocat'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.requestedReviewers).toEqual({ users: ['octocat'], teams: [] });
    // Accepted and unconfirmed is never retried on the user's behalf.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after a reviewer withdrawal may have been applied', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['octocat'] }), reviewerCollection({})],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => (
      request.method === 'GET' && new URL(request.url).pathname === REVIEWERS_PATH
    ))).toHaveLength(2);
  });

  it('never withdraws reviewers on a route whose entry identity no longer validates', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['octocat'] })],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({
          users: ['octocat'],
          localRef: { ...PULL_REQUEST_REF, collisionScope: 'github:8815' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests.some((request) => (
      new URL(request.url).pathname === REVIEWERS_PATH
    ))).toBe(false);
  });

  it('rebinds the exact configured account on a reviewer withdrawal', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['octocat'] }), reviewerCollection({})],
    });

    await removeGithubPullRequestReviewersAction(
      stateInput({ users: ['octocat'] }),
      stub.context,
    );
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* --------------------------------------------------------------- issue writes */

const ISSUE_REF = Object.freeze({
  kindId: 'issue',
  collisionScope: 'github:4210',
  entryId: '7',
});

const ISSUE_PATH = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/issues/7`;

function issueInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: ISSUE_REF,
    routingToken: REPOSITORY_KEY,
    ...overrides,
  };
}

type IssueShape = Readonly<{
  state?: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned';
  labels?: readonly string[];
  assignees?: readonly string[];
}>;

function issueBody(shape: IssueShape = {}): Readonly<Record<string, unknown>> {
  const state = shape.state ?? 'open';
  return Object.freeze({
    ...GITHUB_ISSUE_RESPONSE,
    number: 7,
    state,
    state_reason: shape.stateReason ?? null,
    closed_at: state === 'closed' ? '2026-08-13T10:00:00Z' : null,
    labels: (shape.labels ?? []).map((name) => ({ id: 1, name, color: 'ededed' })),
    assignees: (shape.assignees ?? []).map((login) => ({ login, id: 2, type: 'User' })),
  });
}

/** Answers the issue reads every issue write performs, in order. */
function issueTransportFor(input: Readonly<{
  reads: readonly Readonly<Record<string, unknown>>[];
  repository?: Readonly<Record<string, unknown>>;
  write?: StubHttpResponse | Error;
  commentReads?: readonly unknown[][];
  claimError?: Error;
  settlementError?: Error;
}>) {
  let read = 0;
  let commentRead = 0;
  const claimedPlans: unknown[] = [];
  const stub = createStubGithubTransport({
    executeAction: async (actionId, actionInput) => {
      expect(actionId).toBe('reviews.comments.claimPublicationDispatch');
      claimedPlans.push(actionInput);
      if (input.claimError !== undefined) throw input.claimError;
      if (input.settlementError !== undefined
        && typeof actionInput === 'object'
        && actionInput !== null
        && 'settlement' in actionInput
        && actionInput.settlement !== undefined) {
        throw input.settlementError;
      }
      const plan = actionInput as Readonly<Record<string, unknown>>;
      const entry = (plan.entries as readonly Readonly<Record<string, unknown>>[])[0]!;
      return {
        disposition: 'dispatch',
        dispatchToken: 'dispatch-token-issue-1',
        publicationPlanId: 'C'.repeat(43),
        entries: [{
          happierCommentId: entry.happierCommentId,
          publicationCorrelationId: COMMENT_CORRELATION_ID,
        }],
        verdict: null,
        instructions: { entries: ['dispatch'], verdict: null },
        priorResult: null,
      };
    },
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === ISSUE_PATH) {
        const body = input.reads[Math.min(read, input.reads.length - 1)];
        read += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === REPOSITORY_PATH) {
        return json(input.repository ?? GITHUB_REPOSITORY_RESPONSE);
      }
      if (request.method === 'GET' && path === `${ISSUE_PATH}/comments`) {
        const pages = input.commentReads ?? [[]];
        const body = pages[Math.min(commentRead, pages.length - 1)];
        commentRead += 1;
        return json(body);
      }
      if (request.method !== 'GET' && path.startsWith(ISSUE_PATH)) {
        if (input.write instanceof Error) throw input.write;
        return input.write ?? json(input.reads[input.reads.length - 1]);
      }
      return undefined;
    },
  });
  return Object.freeze({ ...stub, claimedPlans });
}

function issuePublicationInput(planOverrides: Readonly<Record<string, unknown>> = {}) {
  return issueInput({
    publicationPlan: {
      target: {
        providerId: 'github',
        configuredAccountId: CONFIGURED_ACCOUNT.accountId,
        subtarget: null,
        entryRef: {
          sourceId: `${GITHUB_PLUGIN_ID}/github-forge`,
          kindId: ISSUE_REF.kindId,
          collisionScope: ISSUE_REF.collisionScope,
          entryId: ISSUE_REF.entryId,
        },
      },
      baseRevision: null,
      headRevision: null,
      entries: [{
        happierCommentId: REVIEW_COMMENT_ID,
        expectedServerRevision: 3,
        anchor: { kind: 'file', filePath: 'README.md' },
        snapshot: {
          kind: 'text', selectedLines: ['Context'], beforeContext: [], afterContext: [],
          selectedLinesHash: 'selected', contextWindowHash: 'context', capturedAt: 1,
          fileLength: 1, source: 'committed', isUncommitted: false, isUntracked: false,
          truncated: false, hasBidiControls: false, likelyMinified: false,
        },
        body: 'Please clarify this issue.',
      }],
      verdict: null,
      ...planOverrides,
    },
  });
}

describe('GitHub issue comment publication', () => {
  it('publishes one canonical proposal and confirms its exact issue marker', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody()],
      commentReads: [[{
        id: 701,
        body: `Landed\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      }]],
    });
    const result = GithubIssueCommentResultV1Schema.parse(
      await createGithubIssueCommentAction(issuePublicationInput(), stub.context),
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({ kind: 'published', externalRef: '701' });
    const posted = stub.requests.find((request) => request.method === 'POST'
      && new URL(request.url).pathname === `${ISSUE_PATH}/comments`);
    expect(readRecordedJsonBody(posted!)).toEqual({
      body: `Please clarify this issue.\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
    });
  });

  it('retains a typed claim refusal before publishing an issue comment', async () => {
    const failure = new PluginError({ code: 'review_claim_denied', retryable: false,
      details: { requestId: 'github-issue-claim' } });
    const stub = issueTransportFor({ reads: [issueBody()], claimError: failure });
    await expect(createGithubIssueCommentAction(issuePublicationInput(), stub.context)).rejects.toBe(failure);
    expect(writes(stub)).toHaveLength(0);
  });

  it.each([false, true])('keeps a confirmed issue comment and settlement failure evidence (typed: %s)', async (typed) => {
    // The same ordering defect lives in every publication adapter, so the issue
    // conversation is fixed at the same boundary rather than at a second one.
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody()],
      commentReads: [[{
        id: 701,
        body: `Landed\n\n<!-- happier-review-comment:v1:${COMMENT_CORRELATION_ID} -->`,
      }]],
      settlementError: typed ? new PluginError({ code: 'review_claim_denied', retryable: false,
        details: { requestId: 'github-issue-settlement' } }) : new Error('canonical settlement unavailable'),
    });

    const result = GithubIssueCommentResultV1Schema.parse(
      await createGithubIssueCommentAction(issuePublicationInput(), stub.context),
    );

    if (result.kind !== 'settled') throw new Error(`expected settled, got ${result.kind}`);
    expect(result.publication.entries[0]?.outcome).toEqual({ kind: 'published', externalRef: '701' });
    expect(result.failure).toEqual(typed ? {
      class: 'unsupportedContract', code: 'review_claim_denied', requestId: 'github-issue-settlement',
    } : {
      class: 'transient',
      code: 'github_publication_settlement_unrecorded',
    });
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(1);
  });

  it('rechecks archive status before claiming an issue comment', async () => {
    const stub = issueTransportFor({
      reads: [issueBody()],
      repository: archivedRepositoryBody(),
    });
    const result = GithubIssueCommentResultV1Schema.parse(
      await createGithubIssueCommentAction(issuePublicationInput(), stub.context),
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'admission_failed',
      failure: { class: 'permission', code: 'repository_archived' },
    });
    expect(stub.claimedPlans).toHaveLength(0);
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects a mismatched issue target and plural plans before admission or claim', async () => {
    const one = (
      issuePublicationInput() as Readonly<Record<string, unknown>>
    ).publicationPlan as Readonly<Record<string, unknown>>;
    for (const publicationPlan of [
      { ...one, target: { ...(one.target as object), subtarget: { kindId: 'review-comment', targetId: 'other' } } },
      { ...one, entries: [...(one.entries as readonly unknown[]), { ...(one.entries as readonly object[])[0], happierCommentId: 'second' }] },
    ]) {
      const stub = issueTransportFor({ reads: [issueBody()] });
      const result = GithubIssueCommentResultV1Schema.parse(
        await createGithubIssueCommentAction(issueInput({ publicationPlan }), stub.context),
      );
      expect(result.kind).toBe('rejected');
      expect(stub.claimedPlans).toHaveLength(0);
      expect(stub.requests).toHaveLength(0);
    }
  });

  it('distinguishes a definite issue rejection from an answer-lost write', async () => {
    const rejected = issueTransportFor({
      reads: [issueBody(), issueBody()],
      write: json({ message: 'Validation Failed' }, 422),
    });
    const rejectedResult = GithubIssueCommentResultV1Schema.parse(
      await createGithubIssueCommentAction(issuePublicationInput(), rejected.context),
    );
    expect(rejectedResult.kind).toBe('settled');
    if (rejectedResult.kind !== 'settled') throw new Error('expected settled rejection');
    expect(rejectedResult.publication.entries[0]?.outcome.kind).toBe('failed');

    const lost = issueTransportFor({
      reads: [issueBody(), issueBody()],
      write: new Error('comment answer lost'),
      commentReads: [[]],
    });
    const lostResult = GithubIssueCommentResultV1Schema.parse(
      await createGithubIssueCommentAction(issuePublicationInput(), lost.context),
    );
    expect(lostResult.kind).toBe('settled');
    if (lostResult.kind !== 'settled') throw new Error('expected settled ambiguity');
    expect(lostResult.publication.entries[0]?.outcome.kind).toBe('uncertain');
    expect(lost.requests.filter((request) => request.method === 'POST'
      && new URL(request.url).pathname === `${ISSUE_PATH}/comments`)).toHaveLength(1);
  });
});

describe('GitHub issue close and reopen', () => {
  it('closes an open issue with the caller’s explicit reason and confirms it', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ state: 'closed', stateReason: 'not_planned' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'not_planned' }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PATCH');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(ISSUE_PATH);
    // The reason is CARRIED, never chosen: GitHub shows "closed as not planned"
    // differently from "completed" to everyone watching.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('refuses a close whose reason the caller did not supply, before any request leaves', async () => {
    const stub = issueTransportFor({ reads: [issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput(), stub.context),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });

  it('answers an already closed issue from the read, with no second write', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ state: 'closed', stateReason: 'completed' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('does not call a differently classified issue close already satisfied', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ state: 'closed', stateReason: 'not_planned' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('state_changed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reopens a closed issue and sends no reason of its own', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ state: 'closed' }), issueBody()],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await reopenGithubIssueAction(issueInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    // GitHub owns `state_reason: 'reopened'`; inventing one here would publish a
    // claim the person did not make.
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest))
      .toEqual({ state: 'open' });
  });

  it('reports a close the confirming read still sees open as uncertain, not as success', async () => {
    const stub = issueTransportFor({ reads: [issueBody(), issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    // Accepted and unconfirmed is never retried on the user's behalf.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reports a close confirmed with a different reason as uncertain', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ state: 'closed', stateReason: 'not_planned' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a possibly-applied issue close after a server error', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ state: 'closed', stateReason: 'completed' })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === ISSUE_PATH)).toHaveLength(2);
  });

  it('never writes an issue transition on a route whose entry identity no longer validates', async () => {
    const stub = issueTransportFor({ reads: [issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(
        issueInput({
          stateReason: 'completed',
          localRef: { ...ISSUE_REF, collisionScope: 'github:8815' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('refuses a pull-request ref on an issue write and calls nothing at all', async () => {
    const stub = issueTransportFor({ reads: [issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(
        issueInput({ stateReason: 'completed', localRef: PULL_REQUEST_REF }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('GitHub issue assignee and label deltas', () => {
  it('adds exactly the named assignees through GitHub’s own delta endpoint', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ assignees: ['monalisa'] }), issueBody({ assignees: ['monalisa', 'octocat'] })],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueAssigneesAction(issueInput({ usernames: ['octocat'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(`${ISSUE_PATH}/assignees`);
    // Only the named addition leaves. `PATCH /issues/{n}` with an `assignees`
    // array would have replaced the set and dropped `monalisa`.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ assignees: ['octocat'] });
  });

  it('removes exactly the named assignees and leaves everyone else assigned', async () => {
    const stub = issueTransportFor({
      reads: [
        issueBody({ assignees: ['octocat', 'monalisa'] }),
        issueBody({ assignees: ['monalisa'] }),
      ],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await removeGithubIssueAssigneesAction(issueInput({ usernames: ['octocat'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    const dispatched = writes(stub);
    expect(dispatched[0]?.method).toBe('DELETE');
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ assignees: ['octocat'] });
  });

  it('answers an assignee delta that already holds from the read, with no write', async () => {
    const stub = issueTransportFor({ reads: [issueBody({ assignees: ['OctoCat'] })] });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueAssigneesAction(issueInput({ usernames: ['octocat'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('adds exactly the named labels and never replaces the set', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ labels: ['bug'] }), issueBody({ labels: ['bug', 'needs triage'] })],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueLabelsAction(issueInput({ labels: ['needs triage'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    const dispatched = writes(stub);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(`${ISSUE_PATH}/labels`);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ labels: ['needs triage'] });
  });

  it('removes one label through the single-label delete, path-encoded as one segment', async () => {
    const stub = issueTransportFor({
      reads: [
        issueBody({ labels: ['bug', 'area/sync engine'] }),
        issueBody({ labels: ['bug'] }),
      ],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await removeGithubIssueLabelAction(issueInput({ label: 'area/sync engine' }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('DELETE');
    // The label is ONE segment. Unencoded, `area/sync engine` would address
    // `.../labels/area/sync%20engine`, which is a different route entirely.
    expect(new URL(dispatched[0]?.url ?? '').pathname)
      .toBe(`${ISSUE_PATH}/labels/area%2Fsync%20engine`);
    // GitHub's single-label delete carries no body.
    expect(dispatched[0]?.body).toBeUndefined();
  });

  it('rejects an empty or oversized delta before any request leaves', async () => {
    for (const overrides of [
      { usernames: [] },
      { usernames: Array.from({ length: 11 }, (_, index) => `person${index}`) },
      { usernames: ['octocat', 'octocat'] },
    ]) {
      const stub = issueTransportFor({ reads: [issueBody()] });
      const result = GithubIssueDeltaResultV1Schema.parse(
        await addGithubIssueAssigneesAction(issueInput(overrides), stub.context),
      );
      expect(result.kind).toBe('failed');
      expect(stub.requests).toHaveLength(0);
    }
  });

  it('reports a delta the confirming read did not observe as uncertain, not as success', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ labels: ['bug'] }), issueBody({ labels: ['bug'] })],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueLabelsAction(issueInput({ labels: ['needs triage'] }), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a possibly-applied delta after a server error', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ labels: ['bug'] }), issueBody({ labels: ['bug', 'needs triage'] })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueLabelsAction(issueInput({ labels: ['needs triage'] }), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === ISSUE_PATH)).toHaveLength(2);
  });

  it('rebinds the exact configured account on an issue delta', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ labels: ['bug'] })],
    });

    await addGithubIssueLabelsAction(issueInput({ labels: ['bug'] }), stub.context);
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ------------------------------------------------------- review thread resolution */

/**
 * Resolving and reopening one line-anchored review thread.
 *
 * A thread node id is OPAQUE and global: it names a thread anywhere GitHub will
 * let this account reach, not necessarily the pull request the user is looking
 * at. So the read that precedes the write is not only a preflight — it is the
 * identity proof, and every case below asserts what was and was not dispatched.
 */

const THREAD_ID = 'PRRT_kwDOABCD1M4AAbCd';

function threadInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    threadId: THREAD_ID,
    resolved: true,
    ...overrides,
  };
}

type ThreadShape = Readonly<{
  isResolved?: boolean;
  number?: number;
  owner?: string;
  repository?: string;
  repositoryId?: number;
}>;

function threadNode(shape: ThreadShape = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    data: Object.freeze({
      node: Object.freeze({
        __typename: 'PullRequestReviewThread',
        id: THREAD_ID,
        isResolved: shape.isResolved ?? false,
        pullRequest: Object.freeze({
          number: shape.number ?? 1284,
          repository: Object.freeze({
            databaseId: shape.repositoryId ?? 4210,
            // GitHub answers in ITS canonical casing, which is not the lowercased
            // routing token, so a case-sensitive comparison would refuse every
            // legitimate thread.
            name: shape.repository ?? GITHUB_FIXTURE_REPOSITORY.toUpperCase(),
            owner: Object.freeze({ login: shape.owner ?? GITHUB_FIXTURE_OWNER.toUpperCase() }),
          }),
        }),
      }),
    }),
  });
}

/**
 * Answers the thread reads in order and lets one case decide what the mutation
 * itself returns. Every GraphQL request is a POST to one URL, so a case can only
 * be proved by reading the DOCUMENTS that were sent.
 */
function threadTransportFor(input: Readonly<{
  reads: readonly Readonly<Record<string, unknown>>[];
  write?: StubHttpResponse;
}>) {
  let read = 0;
  return createStubGithubTransport({
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || path !== GRAPHQL_PATH) return undefined;
      const document = String(
        (readRecordedJsonBody(request) as Readonly<{ query?: unknown }>).query ?? '',
      );
      if (document.includes('resolveReviewThread')) {
        return input.write ?? json({
          data: {
            [document.includes('unresolveReviewThread') ? 'unresolveReviewThread' : 'resolveReviewThread']:
              { thread: { id: THREAD_ID, isResolved: !document.includes('unresolveReviewThread') } },
          },
        });
      }
      const body = input.reads[Math.min(read, input.reads.length - 1)];
      read += 1;
      return json(body);
    },
  });
}

/** Every GraphQL document this invocation actually sent, in order. */
function graphqlDocuments(stub: ReturnType<typeof threadTransportFor>): readonly string[] {
  return stub.requests
    .filter((request) => request.method === 'POST'
      && new URL(request.url).pathname === GRAPHQL_PATH)
    .map((request) => String(
      (readRecordedJsonBody(request) as Readonly<{ query?: unknown }>).query ?? '',
    ));
}

function threadMutations(stub: ReturnType<typeof threadTransportFor>): readonly string[] {
  return graphqlDocuments(stub).filter((document) => document.includes('solveReviewThread('));
}

describe('GitHub review-thread resolution', () => {
  it('resolves a thread on this pull request and claims it only after the confirming read', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: true })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.thread).toEqual({ id: THREAD_ID, isResolved: true });

    const dispatched = threadMutations(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('resolveReviewThread(');
    expect(dispatched[0]).not.toContain('unresolveReviewThread(');
    // The mutation's own payload is not the claim. Two reads bracket the write:
    // the identity/preflight read and the confirming read.
    expect(graphqlDocuments(stub)).toHaveLength(3);
    // The write carries the caller's exact opaque node id and nothing else.
    const written = stub.requests.filter((request) => request.method === 'POST');
    expect((readRecordedJsonBody(written[1] as RecordedGithubRequest) as Readonly<{
      variables?: unknown;
    }>).variables).toEqual({ threadId: THREAD_ID });
  });

  it('reopens a resolved thread through GitHub’s own unresolve mutation', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: true }), threadNode({ isResolved: false })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(
        threadInput({ resolved: false }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.thread.isResolved).toBe(false);

    const dispatched = threadMutations(stub);
    expect(dispatched).toHaveLength(1);
    // The direction the caller asked for is the direction dispatched. An
    // implementation that always resolves would collapse "reopen" into its
    // opposite and report success for it.
    expect(dispatched[0]).toContain('unresolveReviewThread(');
  });

  it('answers a thread that already holds the requested state from the read, with no write', async () => {
    const stub = threadTransportFor({ reads: [threadNode({ isResolved: true })] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(result.thread).toEqual({ id: THREAD_ID, isResolved: true });
    expect(threadMutations(stub)).toHaveLength(0);
    expect(graphqlDocuments(stub)).toHaveLength(1);
  });

  it('refuses a thread that belongs to another pull request and dispatches nothing', async () => {
    const stub = threadTransportFor({ reads: [threadNode({ number: 990 })] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure.code).toBe('github_review_thread_not_on_entry');
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('refuses a thread that belongs to another repository and dispatches nothing', async () => {
    // The SAME pull-request number in a DIFFERENT repository: an implementation
    // that compared only the number would resolve a stranger's thread.
    const stub = threadTransportFor({
      reads: [threadNode({ owner: 'someone-else', repository: 'another-repo' })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure.code).toBe('github_review_thread_not_on_entry');
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('refuses a path-reused repository whose canonical numeric identity differs', async () => {
    const stub = threadTransportFor({ reads: [threadNode({ repositoryId: 8815 })] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );

    expect(result).toMatchObject({
      kind: 'failed',
      failure: { code: 'github_review_thread_not_on_entry' },
    });
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('never dispatches for a node GitHub did not answer as a review thread', async () => {
    const stub = threadTransportFor({
      reads: [{ data: { node: { __typename: 'Issue', id: THREAD_ID } } }],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure.code).toBe('github_review_thread_absent');
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('never reads a GraphQL 200 carrying errors as a resolution', async () => {
    const stub = threadTransportFor({
      reads: [threadNode()],
      write: json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }),
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'github_forbidden' });
    // One read, one rejected write, and no confirming read for an effect that
    // never happened.
    expect(graphqlDocuments(stub)).toHaveLength(2);
  });

  it('reports a resolution the confirming read still contradicts as uncertain, not as success', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: false })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.thread).toEqual({ id: THREAD_ID, isResolved: false });
    // Accepted and unobserved is never retried: a second dispatch would re-decide
    // against state the user never saw.
    expect(threadMutations(stub)).toHaveLength(1);
  });

  it('retains a GraphQL refusal beside a still-unresolved review thread', async () => {
    const stub = threadTransportFor({
      reads: [threadNode()],
      write: json({
        data: { resolveReviewThread: { thread: null } },
        errors: [{ type: 'FORBIDDEN', path: ['resolveReviewThread', 'thread'] }],
      }),
    });

    expect(GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    )).toEqual({
      kind: 'uncertain',
      failure: { class: 'permission', code: 'github_forbidden' },
      thread: { id: THREAD_ID, isResolved: false },
    });
    expect(threadMutations(stub)).toHaveLength(1);
  });

  it('reconciles a server error after GitHub may have resolved the thread', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: true })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(threadMutations(stub)).toHaveLength(1);
    expect(graphqlDocuments(stub)).toHaveLength(3);
  });

  it('refuses an issue ref on a thread write and calls nothing at all', async () => {
    const stub = threadTransportFor({ reads: [threadNode()] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(
        threadInput({
          localRef: { kindId: 'issue', collisionScope: 'github:4210', entryId: '1284' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });

  it('rebinds the exact configured account on a thread resolution', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: true })],
    });

    await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context);
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ----------------------------------------------------------------- comment edit */

/**
 * Editing one existing comment body. The comment id is a GLOBAL GraphQL node id,
 * so the read before the write is the identity proof: a comment on any other
 * entry is refused before anything is sent. GitHub stays the permission owner.
 */
const ISSUE_COMMENT_ID = 'IC_kwDOABCD1M5AbCdE';

function commentEditInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    target: { kind: 'issue-comment', id: ISSUE_COMMENT_ID },
    body: 'Corrected: the tail is kept.',
    ...overrides,
  };
}

function commentNode(shape: Readonly<{
  typename?: string; number?: number; repositoryId?: number; owner?: string;
}> = {}) {
  const typename = shape.typename ?? 'IssueComment';
  const entry = { number: shape.number ?? 1284 };
  return {
    data: {
      node: {
        __typename: typename,
        id: ISSUE_COMMENT_ID,
        ...(typename === 'IssueComment' ? { issue: entry } : { pullRequest: entry }),
        repository: {
          databaseId: shape.repositoryId ?? 4210,
          name: GITHUB_FIXTURE_REPOSITORY.toUpperCase(),
          owner: { login: shape.owner ?? GITHUB_FIXTURE_OWNER.toUpperCase() },
        },
      },
    },
  };
}

function commentEditTransport(input: Readonly<{ read: unknown; write?: StubHttpResponse }>) {
  return createStubGithubTransport({
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== GRAPHQL_PATH) return undefined;
      const document = String((readRecordedJsonBody(request) as Readonly<{ query?: unknown }>).query ?? '');
      if (!document.trimStart().startsWith('mutation')) return json(input.read);
      if (input.write !== undefined) return input.write;
      const field = /\{\s*(update[A-Za-z]+)\(/u.exec(document)?.[1] ?? 'unknown';
      const payloadField = field === 'updateIssueComment' ? 'issueComment'
        : field === 'updatePullRequestReviewComment' ? 'pullRequestReviewComment' : 'pullRequestReview';
      const variables = (readRecordedJsonBody(request) as Readonly<{ variables: { id: string; body: string } }>).variables;
      return json({ data: { [field]: { [payloadField]: { id: variables.id, body: variables.body } } } });
    },
  });
}

function sentDocuments(stub: ReturnType<typeof commentEditTransport>) {
  return stub.requests
    .filter((request) => request.method === 'POST' && new URL(request.url).pathname === GRAPHQL_PATH)
    .map((request) => readRecordedJsonBody(request) as Readonly<{ query: string; variables: unknown }>);
}

describe('GitHub comment edit', () => {
  it('edits a conversation comment on this pull request with one identity read and one update', async () => {
    const stub = commentEditTransport({ read: commentNode() });

    const result = GithubCommentEditResultV1Schema.parse(
      await editGithubCommentAction(commentEditInput(), stub.context),
    );

    expect(result).toEqual({
      kind: 'applied',
      effect: 'changed',
      comment: { id: ISSUE_COMMENT_ID, body: 'Corrected: the tail is kept.' },
    });
    const sent = sentDocuments(stub);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.query).toContain('updateIssueComment(');
    expect(sent[1]?.variables).toEqual({ id: ISSUE_COMMENT_ID, body: 'Corrected: the tail is kept.' });
  });

  it('edits a review summary and a line comment through their own GitHub mutations', async () => {
    const review = commentEditTransport({ read: commentNode({ typename: 'PullRequestReview' }) });
    await editGithubCommentAction(commentEditInput({ target: { kind: 'review', id: ISSUE_COMMENT_ID } }), review.context);
    expect(sentDocuments(review)[1]?.query).toContain('updatePullRequestReview(');

    const line = commentEditTransport({ read: commentNode({ typename: 'PullRequestReviewComment' }) });
    await editGithubCommentAction(commentEditInput({ target: { kind: 'review-comment', id: ISSUE_COMMENT_ID } }), line.context);
    expect(sentDocuments(line)[1]?.query).toContain('updatePullRequestReviewComment(');
  });

  it('refuses a comment that belongs to another entry or repository and sends no update', async () => {
    for (const shape of [{ number: 990 }, { repositoryId: 8815 }, { owner: 'someone-else' }]) {
      const stub = commentEditTransport({ read: commentNode(shape) });
      const result = GithubCommentEditResultV1Schema.parse(
        await editGithubCommentAction(commentEditInput(), stub.context),
      );
      expect(result).toMatchObject({ kind: 'failed', failure: { code: 'github_comment_not_on_entry' } });
      expect(sentDocuments(stub)).toHaveLength(1);
    }
  });

  it('refuses a node whose kind is not the named target and sends no update', async () => {
    const stub = commentEditTransport({ read: commentNode({ typename: 'PullRequestReview' }) });
    const result = GithubCommentEditResultV1Schema.parse(
      await editGithubCommentAction(commentEditInput(), stub.context),
    );
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'github_comment_absent' } });
    expect(sentDocuments(stub)).toHaveLength(1);
  });

  it('reports a lost update response as uncertain and never sends it twice', async () => {
    const stub = commentEditTransport({
      read: commentNode(),
      write: json({ message: 'Internal Server Error' }, 503),
    });
    const result = GithubCommentEditResultV1Schema.parse(
      await editGithubCommentAction(commentEditInput(), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    expect(sentDocuments(stub)).toHaveLength(2);
  });

  it('states a GitHub permission refusal as failed', async () => {
    const stub = commentEditTransport({
      read: commentNode(),
      write: json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }),
    });
    const result = GithubCommentEditResultV1Schema.parse(
      await editGithubCommentAction(commentEditInput(), stub.context),
    );
    expect(result).toEqual({ kind: 'failed', failure: { class: 'permission', code: 'github_forbidden' } });
  });
});

/* --------------------------------------------------------------- comment create */

describe('GitHub conversation comment', () => {
  function subject(shape: Readonly<{ typename?: string; repositoryId?: number }> = {}) {
    return { data: { repository: {
      databaseId: shape.repositoryId ?? 4210,
      name: GITHUB_FIXTURE_REPOSITORY,
      owner: { login: GITHUB_FIXTURE_OWNER },
      issueOrPullRequest: { __typename: shape.typename ?? 'PullRequest', id: 'PR_kwDOABCD1M5Subject', number: 1284 },
    } } };
  }
  function transport(input: Readonly<{ read: unknown; write?: StubHttpResponse }>) {
    return createStubGithubTransport({
      respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
        if (request.method !== 'POST' || new URL(request.url).pathname !== GRAPHQL_PATH) return undefined;
        const sent = readRecordedJsonBody(request) as Readonly<{ query: string; variables: { body?: string } }>;
        if (!sent.query.trimStart().startsWith('mutation')) return json(input.read);
        return input.write ?? json({ data: { addComment: { commentEdge: { node: {
          id: 'IC_new', body: sent.variables.body, createdAt: '2026-10-31T12:00:00Z',
          url: 'https://github.com/o/r/pull/1284#issuecomment-9', author: { login: 'me' },
        } } } } });
      },
    });
  }
  const createInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
    v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    body: 'Thanks, merging after CI.', ...overrides,
  });

  it('posts one comment on the admitted pull request with one identity read and one addComment', async () => {
    const stub = transport({ read: subject() });
    const result = GithubCommentCreateResultV1Schema.parse(await createGithubCommentAction(createInput(), stub.context));
    expect(result).toEqual({ kind: 'applied', effect: 'changed', comment: {
      id: 'IC_new', body: 'Thanks, merging after CI.', author: 'me',
      createdAtMs: Date.parse('2026-10-31T12:00:00Z'), url: 'https://github.com/o/r/pull/1284#issuecomment-9',
    } });
    const sent = sentDocuments(stub);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.variables).toMatchObject({ number: 1284 });
    expect(sent[1]?.query).toContain('addComment(');
    expect(sent[1]?.variables).toEqual({ subjectId: 'PR_kwDOABCD1M5Subject', body: 'Thanks, merging after CI.' });
  });

  it('refuses a reused repository path or the wrong entry kind and posts nothing', async () => {
    for (const shape of [{ repositoryId: 8815 }, { typename: 'Issue' }]) {
      const stub = transport({ read: subject(shape) });
      const result = GithubCommentCreateResultV1Schema.parse(await createGithubCommentAction(createInput(), stub.context));
      expect(result.kind).toBe('failed');
      expect(sentDocuments(stub)).toHaveLength(1);
    }
  });

  it('reports a lost response as uncertain and never posts twice', async () => {
    const stub = transport({ read: subject(), write: json({ message: 'Internal Server Error' }, 503) });
    const result = GithubCommentCreateResultV1Schema.parse(await createGithubCommentAction(createInput(), stub.context));
    expect(result.kind).toBe('uncertain');
    expect(sentDocuments(stub)).toHaveLength(2);
  });
});
