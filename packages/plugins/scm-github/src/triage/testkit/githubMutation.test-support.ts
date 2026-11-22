import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_PULL_REQUEST_RESPONSE } from '../__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from '../configuration.js';
import { createStubGithubTransport, readRecordedJsonBody, type StubHttpResponse } from './githubTriage.test-support.js';

export const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
export const OBSERVED_HEAD = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
export const OBSERVED_BASE = '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e';
export const ADVANCED_HEAD = '0011223344556677889900aabbccddeeff001122';
export const CONFIGURED_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'configured-account',
});

export function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: { kind: 'repository', repositoryKey: REPOSITORY_KEY },
  });
  if (token === null) throw new Error('the fixture configuration must encode');
  const fixture = createTriageSourceV1Fixture();
  return Object.freeze({
    ...fixture.configuredInstance,
    instance: Object.freeze({
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }),
    binding: Object.freeze({
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: CONFIGURED_ACCOUNT,
    }),
    localInstanceKey: 'github.com',
    configuration: Object.freeze({ v: 1 as const, token }),
  });
}

export const PULL_REQUEST_REF = Object.freeze({
  kindId: 'pull-request',
  collisionScope: 'github:4210',
  entryId: '1284',
});

export function stateInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    ...overrides,
  };
}

export function previewStatusInput() {
  return { ...stateInput(), serverId: 'srv_preview', environmentId: 'preview-child',
    templateEnvironmentId: 'preview-template', targetLinkId: 'preview-runtime', deploymentId: 'preview-teardown',
    expectedHeadSha: OBSERVED_HEAD, status: 'removed', targetUrl: null };
}

/** Network-contract fixtures for the public Home Actions. Internal policy/Artifact parsing remains real in the handler. */
export function previewStatusTransport(options: Readonly<{
  tombstoned?: boolean;
  replacementChild?: boolean;
  headSha?: string; foreignSource?: boolean; foreignReceipt?: boolean; artifactRevision?: number;
  native?: boolean; loseResponse?: boolean; publicationNotObserved?: boolean; deny?: boolean; existing?: boolean;
  deletedChild?: boolean; deletedTemplate?: boolean; retiredLink?: boolean; advanceHeadAfterRead?: boolean; childId?: string;
  receiptState?: 'running' | 'failed' | 'cancelled'; operation?: 'deploy' | 'teardown'; pullRequestState?: 'open';
  domainState?: 'active' | 'failed'; domainHostname?: string; domainPath?: string; supersededReceipt?: boolean; inactiveReceipt?: boolean;
  multiplePreviews?: boolean; unavailableFirstPreview?: boolean; previewQueryError?: 'deployment_access_denied'; previewReadDenied?: boolean;
  publicationReadDenied?: boolean; publicationReadFailure?: 'transport' | 'malformed';
  controllerState?: 'available' | 'paused' | 'unknown';
  noReceipt?: boolean; headerOnlyReceipt?: boolean;
}> = {}) {
  const childId = options.childId ?? 'preview-child';
  const repository = { kind: 'github', deployment: 'https://github.com', repository: REPOSITORY_KEY };
  const reference = (id: string) => ({ contentArtifactId: `${id}-content`, contentHeaderVersion: 1, contentBodyVersion: 1 });
  const environment = (id: string, purpose: 'preview' | 'standard') => ({ v: 1, id, serverId: 'srv_preview',
    projectSourceId: options.foreignSource && purpose === 'preview' ? 'foreign-source' : 'preview-source', revision: 1,
    owner: { kind: 'account', accountId: 'preview-owner' }, protection: 'nonProduction', purpose,
    deployerMode: 'managers', controllerMachineId: 'preview-controller',
    runtimeTargetLinkId: purpose === 'preview' ? 'preview-runtime' : 'template-runtime',
    ...(purpose === 'preview' ? { previewTemplateEnvironmentId: 'preview-template', previewRepositoryId: 'preview-source',
      previewPullRequestId: '1284', previewTargetLinkId: 'template-runtime' } : {}),
    ...reference(id), createdByAccountId: 'preview-owner', createdAtMs: 1, updatedAtMs: 1,
    ...(purpose === 'preview' ? id === childId && (options.deletedChild || options.tombstoned) ? { deletedAtMs: 2 } : {} : options.deletedTemplate ? { deletedAtMs: 2 } : {}),
    capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true } });
  const runtimeLink = (id: string, environmentId: string) => ({ v: 1, id, environmentId, revision: 1, role: 'runtime',
    ...(environmentId === childId && options.operation === 'deploy' && !options.receiptState
      ? { activeDeploymentId: options.inactiveReceipt ? 'other-active-deployment' : 'preview-teardown' } : {}),
    source: options.native ? { kind: 'plugin', contribution: { pluginId: 'native-provider', localId: 'runtime' } }
      : { kind: 'host', id: 'own-server' }, targetKind: 'ownServer', state: 'none', machines: ['preview-machine'],
    members: [{ machineId: 'preview-machine', installationId: 'preview-installation', state: 'active' }],
    ...(options.retiredLink || options.tombstoned && environmentId === childId ? { detachedAtMs: 2 } : {}),
    ...reference(id), createdByAccountId: 'preview-owner', createdAtMs: 1, updatedAtMs: 1 });
  const sourceIntent = { kind: 'repository', projectSourceId: 'preview-source', sourceRevision: 1, sha: OBSERVED_HEAD,
    compose: { path: 'compose.yaml', services: ['app'], profiles: [] }, pullRequestHead: { number: 1284 } };
  const provenance = { v: 1, templateEnvironmentId: 'preview-template', runtimeTargetLinkId: 'template-runtime',
    repository, pullRequestId: '1284', pullRequestNumber: 1284,
    author: { id: 'preview-author', login: 'preview-author' }, headRepository: repository };
  const contextDigest = computeCanonicalDomainSeparatedDigest('happier.github.preview-status.v1', ['preview-template', 'template-runtime']);
  let published: Readonly<Record<string, unknown>> | null = options.existing ? {
    id: 90, context: `happier/preview/${Buffer.from(contextDigest, 'base64url').toString('hex')}`,
    state: 'success', description: 'Preview removed', target_url: null,
  } : null;
  let pullRequestReads = 0;
  return createStubGithubTransport({
    executeAction: async (actionId, input) => {
      const request = input as Readonly<Record<string, unknown>>;
      if (actionId === 'deployments.environments.list') {
        if (JSON.stringify(request.previewPullRequestIds) !== JSON.stringify(['1284'])
          || JSON.stringify(request.previewRepository) !== JSON.stringify(repository)) throw new Error('Expected one exact repository/PR query');
        if (options.previewQueryError) return { ok: false, error: options.previewQueryError };
        const secondPage = options.multiplePreviews && request.cursor === 'preview-next-page';
        return { ok: true, items: options.replacementChild ? [environment(childId, 'preview'), {
          ...environment('new-preview-child', 'preview'), runtimeTargetLinkId: 'new-preview-runtime',
        }].filter(item => request.includeDeleted === true || item.deletedAtMs === undefined) : [secondPage ? { ...environment('preview-second', 'preview'),
          previewTemplateEnvironmentId: 'preview-second-template', previewTargetLinkId: 'preview-second-template-runtime',
          runtimeTargetLinkId: 'preview-second-runtime' } : environment(childId, 'preview')].filter(item => request.includeDeleted === true || item.deletedAtMs === undefined),
          currentDeployments: [], runtimeTargetLinks: [], nextCursor: options.multiplePreviews && !secondPage ? 'preview-next-page' : null, coverage: 'complete' };
      }
      if (actionId === 'deployments.environments.get') {
        if (options.unavailableFirstPreview && request.environmentId === childId) return { ok: false, error: 'deployment_not_found' };
        if (options.multiplePreviews && (request.environmentId === 'preview-second' || request.environmentId === 'preview-second-template')) {
          const child = request.environmentId === 'preview-second';
          const id = child ? 'preview-second' : 'preview-second-template';
          const linkId = child ? 'preview-second-runtime' : 'preview-second-template-runtime';
          return { ok: true, environment: { ...environment(id, child ? 'preview' : 'standard'), runtimeTargetLinkId: linkId,
            ...(child ? { previewTemplateEnvironmentId: 'preview-second-template', previewTargetLinkId: 'preview-second-template-runtime' } : {}) },
            targetLinks: [{ ...runtimeLink(linkId, id), ...(child ? { activeDeploymentId: 'preview-second-deployment' } : {}) }] };
        }
        const child = request.environmentId === childId;
        const id = child ? childId : 'preview-template';
        return { ok: true, environment: environment(id, child ? 'preview' : 'standard'),
          ...(options.controllerState ? { controller: { machineId: 'preview-controller', state: options.controllerState } } : {}),
          targetLinks: [runtimeLink(child ? 'preview-runtime' : 'template-runtime', id)] };
      }
      if (actionId === 'deployments.receipts.get') return { ok: true, deployment: { v: 1, id: 'preview-teardown',
        environmentId: options.foreignReceipt ? 'foreign-child' : childId, targetLinkId: 'preview-runtime', revision: 1,
        operation: options.operation ?? 'teardown', state: options.receiptState ?? 'succeeded', requestKey: 'preview-request', requestedByAccountId: 'preview-owner',
        actionOperationId: 'preview-operation', requestedAtMs: 1, startedAtMs: 1, settledAtMs: 1, ...reference('preview-teardown') } };
      if (actionId === 'deployments.receipts.list') return { ok: true,
        items: options.noReceipt ? [] : [{ v: 1, id: request.environmentId === 'preview-second' ? 'preview-second-deployment' : options.supersededReceipt ? 'newer-deployment' : 'preview-teardown',
          environmentId: request.environmentId === 'preview-second' ? 'preview-second' : options.foreignReceipt ? 'foreign-child' : childId,
          targetLinkId: request.environmentId === 'preview-second' ? 'preview-second-runtime' : 'preview-runtime', revision: 1,
          operation: options.operation ?? 'teardown', state: options.receiptState ?? 'succeeded', requestKey: 'preview-request',
          requestedByAccountId: options.headerOnlyReceipt ? null : 'preview-owner', actionOperationId: 'preview-operation', requestedAtMs: 1,
          startedAtMs: 1, settledAtMs: 1, ...reference(request.environmentId === 'preview-second' ? 'preview-second-deployment' : 'preview-teardown'),
          ...(options.headerOnlyReceipt ? { contentArtifactId: null } : {}) }], nextCursor: null };
      if (actionId === 'deployments.domains.list' && request.environmentId === 'preview-second') return { ok: true,
        environmentId: 'preview-second', revision: 1, nextCursor: null,
        domains: [{ v: 1, id: 'preview-second-domain', environmentId: 'preview-second', targetLinkId: 'preview-second-runtime',
          revision: 1, state: 'active', createdByAccountId: 'preview-owner', createdAtMs: 1, updatedAtMs: 1, ...reference('preview-second-domain') }] };
      if (actionId === 'deployments.domains.list') return { ok: true, environmentId: childId, revision: 1,
        domains: options.domainState ? [{ v: 1, id: 'preview-domain', environmentId: childId, targetLinkId: 'preview-runtime',
          revision: 1, createdByAccountId: 'preview-owner', createdAtMs: 1, updatedAtMs: 1,
          state: options.domainState, ...reference('preview-domain') }] : [], nextCursor: null };
      if (actionId === 'projects.sources.read') return { ok: true, canManage: true, source: { id: 'preview-source', revision: 1,
        name: 'Preview source', audience: [], createdByAccountId: 'preview-owner', owner: { kind: 'account', accountId: 'preview-owner' },
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: REPOSITORY_KEY }, protocol: 'https' } } };
      if (actionId === 'artifact.get') {
        const id = String(request.artifactId);
        const receipt = id === 'preview-teardown-content' || id === 'preview-second-deployment-content';
        const domain = id === 'preview-domain-content' || id === 'preview-second-domain-content';
        return { artifact: { artifactId: id, ownerAccountId: 'preview-owner', access: 'owner', publicAudience: 'none',
          header: { kind: receipt ? 'deployment-receipt.v1' : domain ? 'deployment-domain.v1' : 'deployment-environment.v1', title: 'Preview' },
          revision: { headerVersion: 1, bodyVersion: options.artifactRevision ?? 1 }, seq: 1, createdAt: 1, updatedAt: 1,
          body: JSON.stringify(receipt ? { sourceIntent } : domain
            ? { hostname: id === 'preview-second-domain-content' ? 'second.example.test' : options.domainHostname ?? 'pr-1284.example.test',
              target: { service: 'app', containerPort: 3000, ...(options.domainPath ? { path: options.domainPath } : {}) } }
            : { previewProvenance: id === 'preview-second-content' ? { ...provenance,
              templateEnvironmentId: 'preview-second-template', runtimeTargetLinkId: 'preview-second-template-runtime' } : provenance }) } };
      }
      throw new Error(`Unexpected public Home Action: ${actionId}`);
    },
    respond: request => {
      const path = new URL(request.url).pathname;
      if (path === '/graphql') return json({ data: { repository: {
        isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
        pullRequest: { headRefOid: OBSERVED_HEAD, reviewDecision: 'APPROVED',
          commits: { nodes: [{ commit: { oid: OBSERVED_HEAD, statusCheckRollup: { contexts: {
            nodes: published === null ? [] : [{ __typename: 'StatusContext', id: String(published.id),
              context: published.context, state: String(published.state).toUpperCase(), targetUrl: published.target_url,
              description: published.description, createdAt: null, updatedAt: null, isRequired: false }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } } } }] },
        },
      } } });
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
        if (options.previewReadDenied) return json({ message: 'Forbidden' }, 403);
        pullRequestReads += 1;
        const headSha = options.advanceHeadAfterRead && pullRequestReads > 1 ? ADVANCED_HEAD : options.headSha;
        return json(pullRequestBody({ state: options.pullRequestState ?? 'closed', ...(headSha ? { headSha } : {}) }));
      }
      if (request.method === 'GET' && path === `${REPOSITORY_PATH}/commits/${OBSERVED_HEAD}/statuses`) {
        if (options.publicationReadDenied) return json({ message: 'Resource not accessible by integration' }, 403);
        if (options.publicationReadFailure === 'transport') throw new Error('Provider unavailable');
        if (options.publicationReadFailure === 'malformed') return json({ invalid: true });
        return json(published === null || options.publicationNotObserved ? [] : [published]);
      }
      if (request.method === 'POST' && path === `${REPOSITORY_PATH}/statuses/${OBSERVED_HEAD}`) {
        if (options.deny) return json({ message: 'Resource not accessible by integration' }, 403);
        published = { id: 91, ...(readRecordedJsonBody(request) as Readonly<Record<string, unknown>>) };
        if (options.loseResponse) throw new Error('Provider response lost');
        return json(published, 201);
      }
      return undefined;
    },
  });
}

export type PullRequestShape = Readonly<{
  state?: 'open' | 'closed';
  merged?: boolean;
  headSha?: string;
  baseSha?: string;
  draft?: boolean;
  mergeableState?: string;
  autoMerge?: Readonly<Record<string, unknown>> | null;
}>;

export function pullRequestBody(shape: PullRequestShape = {}): Readonly<Record<string, unknown>> {
  const state = shape.state ?? 'open';
  const merged = shape.merged ?? false;
  return Object.freeze({
    ...GITHUB_PULL_REQUEST_RESPONSE,
    state,
    merged,
    merged_at: merged ? '2026-08-13T10:00:00Z' : null,
    closed_at: state === 'closed' ? '2026-08-13T10:00:00Z' : null,
    draft: shape.draft ?? false,
    auto_merge: shape.autoMerge ?? null,
    mergeable_state: shape.mergeableState ?? 'clean',
    head: Object.freeze({
      ...(GITHUB_PULL_REQUEST_RESPONSE.head as Readonly<Record<string, unknown>>),
      sha: shape.headSha ?? OBSERVED_HEAD,
    }),
    base: Object.freeze({
      ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>),
      sha: shape.baseSha ?? OBSERVED_BASE,
    }),
  });
}

export function json(body: unknown, status = 200): StubHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}


export const PULL_REQUEST_PATH = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`;
export const REPOSITORY_PATH = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`;
