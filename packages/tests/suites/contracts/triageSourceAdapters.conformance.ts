import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageGetResultV1,
  TriageScanContinuationV1,
  TriageScanResultV1,
  TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { vi } from 'vitest';

import issueDetail from '../../../plugins/sentry/src/fixtures/issueDetail.json' with { type: 'json' };
import issuesListPage1 from '../../../plugins/sentry/src/fixtures/issuesListPage1.json' with { type: 'json' };
import organizationsCloudPage from '../../../plugins/sentry/src/fixtures/organizationsCloudPage.json' with { type: 'json' };
import { encodeSentryInstanceConfiguration } from '../../../plugins/sentry/src/instances/sentryInstanceConfiguration';
import {
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_SCOPE_SEPARATOR,
} from '../../../plugins/sentry/src/sentryContracts';
import {
  getSentrySourceEntry,
  listSentryInstances,
  scanSentrySource,
} from '../../../plugins/sentry/src/source/operations';

import crudIssueRead from '../../../plugins/posthog/src/api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import organizationsPage from '../../../plugins/posthog/src/api/__fixtures__/organizationsPage.json' with { type: 'json' };
import projectsPage from '../../../plugins/posthog/src/api/__fixtures__/organizationProjectsPage.json' with { type: 'json' };
import queryIssueDetail from '../../../plugins/posthog/src/api/__fixtures__/queryIssueDetail.json' with { type: 'json' };
import queryIssuesPage1 from '../../../plugins/posthog/src/api/__fixtures__/queryIssuesPage1.json' with { type: 'json' };
import queryIssuesPage2 from '../../../plugins/posthog/src/api/__fixtures__/queryIssuesPage2.json' with { type: 'json' };
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/posthog/src/posthogContracts';
import { encodePosthogConfiguration } from '../../../plugins/posthog/src/source/instance';
import {
  getPosthogSourceEntry,
  listPosthogInstances,
  scanPosthogSource,
} from '../../../plugins/posthog/src/source/operations';

import {
  GITHUB_AUTHENTICATED_USER_RESPONSE,
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  githubSearchResponse,
} from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { encodeGithubTriageConfiguration } from '../../../plugins/scm-github/src/triage/configuration';
import { listGithubTriageInstances } from '../../../plugins/scm-github/src/triage/instances';
import {
  getGithubTriageEntry,
  scanGithubTriageSource,
} from '../../../plugins/scm-github/src/triage/operations';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import {
  createStubGithubTransport,
  fixedClock,
  type StubConnectedAccountListing,
  type StubHttpResponse,
} from '../../../plugins/scm-github/src/triage/testkit/githubTriage.test-support';

import issueList from '../../../plugins/scm-gitlab/src/triage/__fixtures__/issueList.json' with { type: 'json' };
import mergeRequestList from '../../../plugins/scm-gitlab/src/triage/__fixtures__/mergeRequestList.json' with { type: 'json' };
import { GITLAB_CONFIGURATION_RECORD_V1, encodeGitlabConfiguration } from '../../../plugins/scm-gitlab/src/triage/configuration';
import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/scm-gitlab/src/triage/contribution';
import type { GitlabConnectedAccounts, GitlabHttpResponse } from '../../../plugins/scm-gitlab/src/triage/http/gitlabClient';
import { createGitlabResponseHeaders } from '../../../plugins/scm-gitlab/src/triage/http/gitlabHeaders';
import { getGitlabTriageEntry } from '../../../plugins/scm-gitlab/src/triage/sourceGet';
import { listGitlabTriageInstances } from '../../../plugins/scm-gitlab/src/triage/sourceInstances';
import { scanGitlabTriageSource } from '../../../plugins/scm-gitlab/src/triage/sourceScan';

import bitbucketCurrentUser from '../../../plugins/scm-bitbucket/src/triage/fixtures/currentUser.json' with { type: 'json' };
import bitbucketPageOne from '../../../plugins/scm-bitbucket/src/triage/fixtures/pullRequestsPageOne.json' with { type: 'json' };
import bitbucketPullRequest from '../../../plugins/scm-bitbucket/src/triage/fixtures/pullRequestSelf.json' with { type: 'json' };
import bitbucketRepositories from '../../../plugins/scm-bitbucket/src/triage/fixtures/workspaceRepositoriesPage.json' with { type: 'json' };
import bitbucketWorkspaces from '../../../plugins/scm-bitbucket/src/triage/fixtures/userWorkspacesPage.json' with { type: 'json' };
import { encodeBitbucketConfiguration } from '../../../plugins/scm-bitbucket/src/triage/instance';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/scm-bitbucket/src/triage/source/descriptor';
import { getBitbucketSourceEntry } from '../../../plugins/scm-bitbucket/src/triage/source/get';
import { listBitbucketSourceInstances } from '../../../plugins/scm-bitbucket/src/triage/source/listInstances';
import { scanBitbucketSource } from '../../../plugins/scm-bitbucket/src/triage/source/scan';
import {
  accountRef as bitbucketAccountRef,
  createConnectedAccountsStub as createBitbucketConnectedAccounts,
  createHttpStub as createBitbucketHttp,
  createRuntime as createBitbucketRuntime,
  type StubReply as BitbucketStubReply,
} from '../../../plugins/scm-bitbucket/src/triage/source/testSupport';

import { encodeAzureSourceConfiguration } from '../../../plugins/scm-azure-devops/src/triage/configuration';
import { AZURE_DEVOPS_TRIAGE_PURPOSE } from '../../../plugins/scm-azure-devops/src/triage/descriptor';
import {
  AZURE_NATIVE_PAGE_SIZE,
  runAzureTriageGet,
  runAzureTriageListInstances,
  runAzureTriageScan,
  type AzureTriageReadServices,
} from '../../../plugins/scm-azure-devops/src/triage/operations';
import { normalizeAzureDevOpsBaseUrl } from '../../../plugins/scm-azure-devops/src/triage/origin';
import type {
  AzureDevOpsHttpRequest,
  AzureDevOpsHttpResponse,
} from '../../../plugins/scm-azure-devops/src/triage/types';

type ScanPage = Readonly<{
  result: TriageScanResultV1;
  requestWitness: string;
}>;

export type TriageSourceAdapterConformanceCase = Readonly<{
  name: string;
  expectedFirstPageEntryIds: readonly string[];
  discover: () => Promise<number>;
  firstPage: () => Promise<ScanPage>;
  nextPage: (continuation: TriageScanContinuationV1) => Promise<ScanPage>;
  detail: (localRef: TriageSourceEntryLocalRefV1) => Promise<TriageGetResultV1>;
  providerError: () => Promise<
    Extract<TriageScanResultV1, { kind: 'failed' }>
    | Extract<TriageGetResultV1, { kind: 'unresolved' }>
  >;
}>;

export function readConformanceEntryIds(result: TriageScanResultV1): readonly string[] {
  return result.kind === 'failed'
    ? []
    : result.observations.flatMap((observation) => (
      observation.kind === 'present' ? [observation.localRef.entryId] : []
    ));
}

const GITHUB_ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'conformance-account',
});
const GITHUB_REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();

function githubInstance() {
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: { kind: 'repository', repositoryKey: GITHUB_REPOSITORY_KEY },
  });
  if (token === null) throw new Error('GitHub conformance configuration must encode');
  return {
    ...createTriageSourceV1Fixture().configuredInstance,
    instance: {
      source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_ACCOUNT },
    localInstanceKey: 'github.com',
    configuration: { v: 1 as const, token },
  };
}

function githubListing(): StubConnectedAccountListing {
  return {
    status: 'complete',
    accounts: [{
      account: GITHUB_ACCOUNT,
      displayName: 'GitHub conformance',
      state: 'connected',
      connectedAccountOrigins: ['https://api.github.com'],
      connectedAccountBases: ['https://api.github.com'],
    }],
  };
}

function githubScanTransport(status = 200) {
  return createStubGithubTransport({
    respond: (request): StubHttpResponse | undefined => {
      if (!request.url.startsWith('https://api.github.com/search/issues')) return undefined;
      return status === 200
        ? { status, body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) }
        : { status, body: { message: 'provider failure' } };
    },
  });
}

function githubCase(): TriageSourceAdapterConformanceCase {
  let transport = githubScanTransport();
  return {
    name: 'GitHub',
    expectedFirstPageEntryIds: ['1284'],
    async discover() {
      const discovery = createStubGithubTransport({
        listing: githubListing(),
        respond: (request) => request.url.endsWith('/user')
          ? { status: 200, body: GITHUB_AUTHENTICATED_USER_RESPONSE }
          : undefined,
      });
      const result = await listGithubTriageInstances(discovery.context, { now: fixedClock(1_000) });
      return result.kind === 'failed' ? 0 : result.candidates.length;
    },
    async firstPage() {
      transport = githubScanTransport();
      const result = await scanGithubTriageSource({
        v: 1,
        instance: githubInstance(),
        page: { kind: 'initial', limit: 64 },
      }, transport.context, { now: fixedClock(1_700_000_000_000) });
      return { result, requestWitness: transport.requests.at(-1)?.url ?? '' };
    },
    async nextPage(continuation) {
      const before = transport.requests.length;
      const result = await scanGithubTriageSource({
        v: 1,
        instance: githubInstance(),
        page: { kind: 'continuation', continuation },
      }, transport.context, { now: fixedClock(1_700_000_000_000) });
      return { result, requestWitness: transport.requests.at(before)?.url ?? '' };
    },
    async detail(localRef) {
      const detail = createStubGithubTransport({
        respond: (request) => request.url.endsWith('/pulls/1284')
          ? { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }
          : undefined,
      });
      return getGithubTriageEntry({ v: 1, instance: githubInstance(), localRef }, detail.context, {
        now: fixedClock(1_700_000_000_000),
      });
    },
    async providerError() {
      const failed = createStubGithubTransport({
        respond: (request) => request.url.endsWith('/pulls/1284')
          ? { status: 503, body: { message: 'provider failure' } }
          : undefined,
      });
      const result = await getGithubTriageEntry({
        v: 1,
        instance: githubInstance(),
        localRef: {
          kindId: 'pull-request',
          collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
          entryId: '1284',
        },
      }, failed.context, { now: fixedClock(1_700_000_000_000) });
      if (result.kind !== 'unresolved') throw new Error('expected GitHub provider failure');
      return result;
    },
  };
}

const SENTRY_ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.sentry', localId: 'sentry-account' }),
  accountId: 'conformance-account',
});
const SENTRY_ORIGIN = 'https://de.sentry.io';
const SENTRY_ORGANIZATION_ID = '7701';

type RecordedSentryResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

function sentryRecordedOnOrigin(recorded: RecordedSentryResponse): RecordedSentryResponse {
  return JSON.parse(JSON.stringify(recorded).split('https://us.sentry.io').join(SENTRY_ORIGIN)) as
    RecordedSentryResponse;
}

function sentryContext(responses: readonly RecordedSentryResponse[]) {
  let call = 0;
  const urls: string[] = [];
  return {
    urls,
    value: {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          listAccounts: vi.fn(async () => ({
            status: 'complete' as const,
            accounts: [{
              account: SENTRY_ACCOUNT,
              displayName: 'Sentry conformance',
              state: 'connected' as const,
              connectedAccountOrigins: [SENTRY_ORIGIN],
              connectedAccountBases: [SENTRY_ORIGIN],
            }],
          })),
          materializeListedAccount: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { authorization: 'Bearer conformance' },
          })),
          getBinding: vi.fn(async () => ({ purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE })),
        },
        http: {
          request: vi.fn(async (input: Readonly<{ url: string }>) => {
            urls.push(input.url);
            const response = responses[call++];
            if (!response) throw new Error(`unexpected Sentry request ${input.url}`);
            return {
              status: response.status,
              finalUrl: input.url,
              headers: response.headers,
              body: new TextEncoder().encode(JSON.stringify(response.body)),
            };
          }),
        },
      },
    } as unknown as PluginInvocationContext,
  };
}

function sentryInstance() {
  const token = encodeSentryInstanceConfiguration({
    v: 1,
    organizationId: SENTRY_ORGANIZATION_ID,
    projectScope: { kind: 'allAccessible' },
    environmentScope: { kind: 'all' },
  });
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: 'happier.sentry', localId: 'sentry-issues' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: SENTRY_ACCOUNT },
    localInstanceKey: `${SENTRY_ORIGIN}${SENTRY_SCOPE_SEPARATOR}${SENTRY_ORGANIZATION_ID}`,
    configuration: { v: 1 as const, token },
  };
}

function sentryCase(): TriageSourceAdapterConformanceCase {
  let context = sentryContext([]);
  const page = sentryRecordedOnOrigin(issuesListPage1);
  return {
    name: 'Sentry',
    expectedFirstPageEntryIds: ['5501001', '5501002'],
    async discover() {
      const discovery = sentryContext([sentryRecordedOnOrigin(organizationsCloudPage)]);
      const result = await listSentryInstances({ v: 1 }, discovery.value);
      return result.kind === 'failed' ? 0 : result.candidates.length;
    },
    async firstPage() {
      context = sentryContext([page, page]);
      const result = await scanSentrySource({
        v: 1,
        instance: sentryInstance(),
        page: { kind: 'initial', limit: 32 },
      }, context.value);
      return { result, requestWitness: context.urls[0] ?? '' };
    },
    async nextPage(continuation) {
      const before = context.urls.length;
      const result = await scanSentrySource({
        v: 1,
        instance: sentryInstance(),
        page: { kind: 'continuation', continuation },
      }, context.value);
      return { result, requestWitness: context.urls[before] ?? '' };
    },
    async detail(localRef) {
      const detail = sentryContext([sentryRecordedOnOrigin(issueDetail)]);
      return getSentrySourceEntry({ v: 1, instance: sentryInstance(), localRef }, detail.value);
    },
    async providerError() {
      const failed = sentryContext([{
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: { detail: 'unavailable' },
      }]);
      const result = await scanSentrySource({
        v: 1,
        instance: sentryInstance(),
        page: { kind: 'initial', limit: 32 },
      }, failed.value);
      if (result.kind !== 'failed') throw new Error('expected Sentry provider failure');
      return result;
    },
  };
}

const POSTHOG_ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.posthog', localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }),
  accountId: 'conformance-account',
});

function posthogContext(responses: readonly unknown[], statuses: readonly number[] = []) {
  let call = 0;
  const urls: string[] = [];
  return {
    urls,
    value: {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          listAccounts: vi.fn(async () => ({
            status: 'complete' as const,
            accounts: [{
              account: POSTHOG_ACCOUNT,
              displayName: 'PostHog conformance',
              state: 'connected' as const,
              connectedAccountOrigins: ['https://eu.posthog.com'],
              connectedAccountBases: ['https://eu.posthog.com'],
            }],
          })),
          materializeListedAccount: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { authorization: 'Bearer conformance' },
          })),
        },
        http: {
          request: vi.fn(async (input: Readonly<{ url: string }>) => {
            const index = call++;
            const body = Reflect.get(input, 'body');
            urls.push(`${input.url}\n${body instanceof Uint8Array ? new TextDecoder().decode(body) : ''}`);
            return {
              status: statuses[index] ?? 200,
              finalUrl: input.url,
              headers: { 'content-type': 'application/json' },
              body: new TextEncoder().encode(JSON.stringify(responses[index] ?? {})),
            };
          }),
        },
      },
    } as unknown as PluginInvocationContext,
  };
}

function posthogInstance() {
  const fixture = createTriageSourceV1Fixture();
  const encoded = encodePosthogConfiguration({
    v: 1,
    organizationUuid: '00000000-0000-4000-8000-0000000000a1',
    environments: [{
      teamPathId: 4821,
      teamUuid: '00000000-0000-4000-8000-0000000000d1',
      parentProjectId: 4820,
      displayName: 'Storefront production',
    }],
    scanWindowPolicy: {
      kind: 'exact',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-15T00:00:00.000Z',
    },
    detailWindowPolicy: { kind: 'relative', durationMs: 30 * 86_400_000 },
  });
  if (!encoded.ok) throw new Error('PostHog conformance configuration must encode');
  return {
    ...fixture.configuredInstance,
    instance: {
      ...fixture.configuredInstance.instance,
      source: { pluginId: 'happier.posthog', localId: 'posthog-error-tracking' },
    },
    binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: POSTHOG_ACCOUNT },
    localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
    configuration: { v: 1 as const, token: encoded.token },
  };
}

function posthogCase(): TriageSourceAdapterConformanceCase {
  let context = posthogContext([]);
  return {
    name: 'PostHog',
    expectedFirstPageEntryIds: [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ],
    async discover() {
      const discovery = posthogContext([organizationsPage, projectsPage]);
      const result = await listPosthogInstances({ v: 1 }, discovery.value);
      return result.kind === 'failed' ? 0 : result.candidates.length;
    },
    async firstPage() {
      context = posthogContext([queryIssuesPage1, queryIssuesPage2]);
      const result = await scanPosthogSource({
        v: 1,
        instance: posthogInstance(),
        page: { kind: 'initial', limit: 3 },
      }, context.value);
      return { result, requestWitness: context.urls[0] ?? '' };
    },
    async nextPage(continuation) {
      const before = context.urls.length;
      const result = await scanPosthogSource({
        v: 1,
        instance: posthogInstance(),
        page: { kind: 'continuation', continuation },
      }, context.value);
      return { result, requestWitness: context.urls[before] ?? '' };
    },
    async detail(localRef) {
      const detail = posthogContext([crudIssueRead, queryIssueDetail]);
      return getPosthogSourceEntry({ v: 1, instance: posthogInstance(), localRef }, detail.value);
    },
    async providerError() {
      const failed = posthogContext([{}], [503]);
      const result = await scanPosthogSource({
        v: 1,
        instance: posthogInstance(),
        page: { kind: 'initial', limit: 3 },
      }, failed.value);
      if (result.kind !== 'failed') throw new Error('expected PostHog provider failure');
      return result;
    },
  };
}

const GITLAB_NOW_MS = 1_764_000_000_000;
const GITLAB_SERVICE = Object.freeze({
  pluginId: 'happier.scm.forge.gitlab',
  localId: 'gitlab-account',
});
const GITLAB_ACCOUNT = Object.freeze({ service: GITLAB_SERVICE, accountId: 'account-1' });
const GITLAB_VIEWER = Object.freeze({ id: 41, username: 'example-user' });

function gitlabInstance() {
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: GITLAB_SERVICE.pluginId, localId: 'gitlab-forge' },
      sourceInstanceId: '9d6f0b2a-3c41-4d7e-9a52-8c1f4b7d2e03',
    },
    binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: GITLAB_ACCOUNT },
    localInstanceKey: 'https://gitlab.com',
    configuration: encodeGitlabConfiguration(GITLAB_CONFIGURATION_RECORD_V1),
  };
}

type GitlabRoute = Readonly<{ status?: number; body?: unknown }>;

function gitlabHarness(routes: Readonly<Record<string, GitlabRoute>>) {
  const requested: string[] = [];
  const fetcher = vi.fn(async (url: string): Promise<GitlabHttpResponse> => {
    requested.push(url);
    const parsed = new URL(url);
    const route = routes[`${parsed.pathname}${parsed.search}`] ?? routes[parsed.pathname];
    return {
      status: route?.status ?? (route ? 200 : 404),
      statusText: '',
      headers: createGitlabResponseHeaders({}),
      text: async () => JSON.stringify(route?.body ?? { message: 'not routed' }),
    };
  });
  const connectedAccounts = {
    listAccounts: vi.fn(async () => ({ status: 'complete' as const, accounts: [] })),
    materializeListedAccount: vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer conformance' },
    })),
  } as unknown as GitlabConnectedAccounts;
  return { requested, fetcher, connectedAccounts };
}

function gitlabCase(): TriageSourceAdapterConformanceCase {
  const routes = {
    '/api/v4/user': { body: GITLAB_VIEWER },
    '/api/v4/merge_requests': { body: mergeRequestList },
    '/api/v4/issues': { body: issueList },
  } as const;
  let seam = gitlabHarness(routes);
  return {
    name: 'GitLab',
    expectedFirstPageEntryIds: ['7', '8'],
    async discover() {
      const connectedAccounts = {
        listAccounts: vi.fn(async () => ({
          status: 'complete' as const,
          accounts: [{
            account: GITLAB_ACCOUNT,
            displayName: 'GitLab conformance',
            state: 'connected' as const,
            connectedAccountOrigins: ['https://gitlab.com'],
          }],
        })),
        materializeListedAccount: vi.fn(),
      } as unknown as GitlabConnectedAccounts;
      const result = await listGitlabTriageInstances({
        connectedAccounts,
        signal: new AbortController().signal,
      });
      return result.kind === 'failed' ? 0 : result.candidates.length;
    },
    async firstPage() {
      seam = gitlabHarness(routes);
      const result = await scanGitlabTriageSource({
        scan: { v: 1, instance: gitlabInstance(), page: { kind: 'initial', limit: 2 } },
        connectedAccounts: seam.connectedAccounts,
        fetcher: seam.fetcher,
        signal: new AbortController().signal,
        nowMs: GITLAB_NOW_MS,
      });
      return {
        result,
        requestWitness: seam.requested.find((url) => !url.endsWith('/api/v4/user')) ?? '',
      };
    },
    async nextPage(continuation) {
      seam = gitlabHarness(routes);
      const result = await scanGitlabTriageSource({
        scan: { v: 1, instance: gitlabInstance(), page: { kind: 'continuation', continuation } },
        connectedAccounts: seam.connectedAccounts,
        fetcher: seam.fetcher,
        signal: new AbortController().signal,
        nowMs: GITLAB_NOW_MS,
      });
      return {
        result,
        requestWitness: seam.requested.find((url) => !url.endsWith('/api/v4/user')) ?? '',
      };
    },
    async detail(localRef) {
      const detail = gitlabHarness({
        '/api/v4/user': { body: GITLAB_VIEWER },
        '/api/v4/projects/3/merge_requests/7': { body: mergeRequestList[0] },
      });
      return getGitlabTriageEntry({
        get: { v: 1, instance: gitlabInstance(), localRef },
        connectedAccounts: detail.connectedAccounts,
        fetcher: detail.fetcher,
        signal: new AbortController().signal,
        nowMs: GITLAB_NOW_MS,
      });
    },
    async providerError() {
      const failed = gitlabHarness({ '/api/v4/user': { status: 503, body: { message: 'down' } } });
      const result = await scanGitlabTriageSource({
        scan: { v: 1, instance: gitlabInstance(), page: { kind: 'initial', limit: 2 } },
        connectedAccounts: failed.connectedAccounts,
        fetcher: failed.fetcher,
        signal: new AbortController().signal,
        nowMs: GITLAB_NOW_MS,
      });
      if (result.kind !== 'failed') throw new Error('expected GitLab provider failure');
      return result;
    },
  };
}

const BITBUCKET_WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';

function bitbucketInstance() {
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid: BITBUCKET_WORKSPACE_UUID });
  if (!encoded.ok) throw new Error('Bitbucket conformance configuration must encode');
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: bitbucketAccountRef('account-1') },
    localInstanceKey: BITBUCKET_WORKSPACE_UUID,
    configuration: { v: 1 as const, token: encoded.token },
    locator: { v: 1 as const, displayLabel: 'Example Workspace' },
  };
}

function bitbucketRoute(overrides: Readonly<Record<string, BitbucketStubReply>> = {}) {
  return (url: string): BitbucketStubReply | undefined => {
    for (const [fragment, reply] of Object.entries(overrides)) {
      if (url.includes(fragment)) return reply;
    }
    if (url.includes('/2.0/user/workspaces')) return { body: bitbucketWorkspaces };
    if (url.includes('/2.0/user')) return { body: bitbucketCurrentUser };
    if (url.includes('/pullrequests/42')) return { body: bitbucketPullRequest };
    if (url.includes('/2.0/repositories/') && url.includes('/pullrequests')) {
      return { body: { pagelen: 10, page: 1, values: [] } };
    }
    if (url.includes('/2.0/repositories/')) return { body: bitbucketRepositories };
    if (url.includes('/pullrequests/')) return { body: bitbucketPageOne };
    return undefined;
  };
}

function bitbucketBoundary(overrides: Readonly<Record<string, BitbucketStubReply>> = {}) {
  const accounts = createBitbucketConnectedAccounts({ accounts: [{ accountId: 'account-1' }] });
  const provider = createBitbucketHttp(bitbucketRoute(overrides));
  return { runtime: createBitbucketRuntime(accounts.connectedAccounts, provider.http), requests: provider.requests };
}

function bitbucketCase(): TriageSourceAdapterConformanceCase {
  let boundary = bitbucketBoundary();
  return {
    name: 'Bitbucket',
    expectedFirstPageEntryIds: ['42', '41'],
    async discover() {
      const current = bitbucketBoundary();
      const result = await listBitbucketSourceInstances(current.runtime);
      return result.kind === 'failed' ? 0 : result.candidates.length;
    },
    async firstPage() {
      boundary = bitbucketBoundary();
      const result = await scanBitbucketSource(boundary.runtime, {
        v: 1,
        instance: bitbucketInstance(),
        page: { kind: 'initial', limit: 32 },
      });
      return { result, requestWitness: boundary.requests.at(-1)?.url ?? '' };
    },
    async nextPage(continuation) {
      boundary = bitbucketBoundary();
      const result = await scanBitbucketSource(boundary.runtime, {
        v: 1,
        instance: bitbucketInstance(),
        page: { kind: 'continuation', continuation },
      });
      return { result, requestWitness: boundary.requests.at(-1)?.url ?? '' };
    },
    async detail(localRef) {
      const detail = bitbucketBoundary();
      return getBitbucketSourceEntry(detail.runtime, { v: 1, instance: bitbucketInstance(), localRef });
    },
    async providerError() {
      const failed = bitbucketBoundary({ '/2.0/user': { status: 503, body: { error: { message: 'down' } } } });
      const result = await scanBitbucketSource(failed.runtime, {
        v: 1,
        instance: bitbucketInstance(),
        page: { kind: 'initial', limit: 32 },
      });
      if (result.kind !== 'failed') throw new Error('expected Bitbucket provider failure');
      return result;
    },
  };
}

const AZURE_BASE_URL = 'https://dev.azure.com/acme';
const AZURE_SERVICES_ORIGIN = 'https://dev.azure.com';
const AZURE_VIEWER_ID = 'a0d31c2e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const AZURE_PROJECT_ID = '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const AZURE_REPOSITORY_ID = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
const AZURE_ACCOUNT = Object.freeze({
  service: Object.freeze({
    pluginId: 'happier.scm.forge.azure-devops',
    localId: AZURE_DEVOPS_TRIAGE_PURPOSE,
  }),
  accountId: 'account-1',
});
const AZURE_CONNECTION_DATA = Object.freeze({
  authenticatedUser: { id: AZURE_VIEWER_ID, providerDisplayName: 'Ada' },
  deploymentType: 'hosted',
  instanceId: '9d0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
});

function azureInstance() {
  const origin = normalizeAzureDevOpsBaseUrl(AZURE_BASE_URL);
  if (!origin.ok) throw new Error('Azure conformance base URL must normalize');
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: AZURE_ACCOUNT.service.pluginId, localId: 'azure-devops-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: AZURE_ACCOUNT },
    localInstanceKey: AZURE_BASE_URL,
    configuration: encodeAzureSourceConfiguration(origin.origin),
  };
}

function azureProject() {
  return { id: AZURE_PROJECT_ID, name: 'Payments', state: 'wellFormed' };
}

function azureRepository() {
  return {
    id: AZURE_REPOSITORY_ID,
    name: 'checkout',
    project: { id: AZURE_PROJECT_ID, name: 'Payments' },
    defaultBranch: 'refs/heads/main',
    isDisabled: false,
    webUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
  };
}

function azurePullRequest(pullRequestId: number) {
  return {
    pullRequestId,
    repository: azureRepository(),
    title: `Change ${pullRequestId}`,
    status: 'active',
    isDraft: false,
    createdBy: { id: AZURE_VIEWER_ID, displayName: 'Ada' },
    creationDate: '2026-08-01T10:00:00Z',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4' },
    lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6' },
    reviewers: [],
    labels: [],
    url: `${AZURE_BASE_URL}/_apis/git/pullRequests/${pullRequestId}`,
  };
}

type AzureRoute = Readonly<{ status?: number; headers?: Readonly<Record<string, string>>; body: unknown }>;

function azurePage(values: readonly unknown[]): AzureRoute {
  return { body: { count: values.length, value: values } };
}

function azureBoundary(respond: (request: AzureDevOpsHttpRequest) => AzureRoute) {
  const urls: string[] = [];
  const services = {
    connectedAccounts: {
      async listAccounts() {
        return {
          status: 'complete' as const,
          accounts: [{
            account: AZURE_ACCOUNT,
            displayName: 'Acme',
            state: 'connected' as const,
            connectedAccountOrigins: [AZURE_SERVICES_ORIGIN],
            connectedAccountBases: [AZURE_BASE_URL],
          }],
        };
      },
      async getBinding(purpose: string) {
        return {
          purpose,
          service: AZURE_ACCOUNT.service,
          account: AZURE_ACCOUNT,
          target: { kind: 'account' as const, displayName: 'Acme' },
        };
      },
      async materializeListedAccount() {
        return { kind: 'httpHeaders' as const, headers: { authorization: 'Basic conformance' } };
      },
    },
    async transport(request: AzureDevOpsHttpRequest): Promise<AzureDevOpsHttpResponse> {
      urls.push(request.url);
      const route = respond(request);
      return {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json', ...route.headers },
        bodyText: JSON.stringify(route.body),
      };
    },
    now: () => 1_760_000_000_000,
  } as unknown as AzureTriageReadServices;
  return { urls, services };
}

function azureScanResponder(request: AzureDevOpsHttpRequest): AzureRoute {
  if (request.url.includes('_apis/connectionData')) return { body: AZURE_CONNECTION_DATA };
  if (request.url.includes('_apis/projects')) return azurePage([azureProject()]);
  if (request.url.includes('_apis/git/repositories?')) return azurePage([azureRepository()]);
  if (request.url.includes('searchCriteria.creatorId')) {
    return azurePage(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_, index) => azurePullRequest(100 + index)));
  }
  if (request.url.includes('searchCriteria.reviewerId')) {
    return azurePage(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_, index) => azurePullRequest(500 + index)));
  }
  throw new Error(`unexpected Azure request ${request.url}`);
}

function azureCase(): TriageSourceAdapterConformanceCase {
  let boundary = azureBoundary(azureScanResponder);
  return {
    name: 'Azure DevOps',
    expectedFirstPageEntryIds: Array.from(
      { length: AZURE_NATIVE_PAGE_SIZE },
      (_, index) => String(100 + index),
    ),
    async discover() {
      const current = azureBoundary(azureScanResponder);
      const result = await runAzureTriageListInstances({
        connectedAccounts: current.services.connectedAccounts,
        signal: new AbortController().signal,
      });
      return result.kind === 'failed' ? 0 : result.candidates.length;
    },
    async firstPage() {
      boundary = azureBoundary(azureScanResponder);
      const result = await runAzureTriageScan({
        services: boundary.services,
        request: {
          v: 1,
          instance: azureInstance(),
          page: { kind: 'initial', limit: AZURE_NATIVE_PAGE_SIZE },
        },
        signal: new AbortController().signal,
      });
      return {
        result,
        requestWitness: boundary.urls.find((url) => url.includes('searchCriteria.')) ?? '',
      };
    },
    async nextPage(continuation) {
      boundary = azureBoundary(azureScanResponder);
      const result = await runAzureTriageScan({
        services: boundary.services,
        request: { v: 1, instance: azureInstance(), page: { kind: 'continuation', continuation } },
        signal: new AbortController().signal,
      });
      return {
        result,
        requestWitness: boundary.urls.find((url) => url.includes('searchCriteria.')) ?? '',
      };
    },
    async detail(localRef) {
      const detail = azureBoundary((request) => {
        if (request.url.includes('_apis/connectionData')) return { body: AZURE_CONNECTION_DATA };
        if (request.url.includes('/pullrequests/')) return { body: azurePullRequest(Number(localRef.entryId)) };
        throw new Error(`unexpected Azure detail request ${request.url}`);
      });
      return runAzureTriageGet({
        services: detail.services,
        request: { v: 1, instance: azureInstance(), localRef },
        signal: new AbortController().signal,
      });
    },
    async providerError() {
      const failed = azureBoundary((request) => {
        if (request.url.includes('_apis/connectionData')) return { body: AZURE_CONNECTION_DATA };
        if (request.url.includes('_apis/projects')) {
          return { status: 429, headers: { 'retry-after': '30' }, body: { message: 'Throttled.' } };
        }
        throw new Error(`unexpected Azure error request ${request.url}`);
      });
      const result = await runAzureTriageScan({
        services: failed.services,
        request: { v: 1, instance: azureInstance(), page: { kind: 'initial', limit: 8 } },
        signal: new AbortController().signal,
      });
      if (result.kind !== 'failed') throw new Error('expected Azure provider failure');
      return result;
    },
  };
}

/**
 * One explicit QA inventory, not a production registry. Every member invokes the
 * real source operation and mocks only Connected Accounts/HTTP, the genuine host
 * and provider boundaries.
 */
export const TRIAGE_SOURCE_ADAPTER_CONFORMANCE_CASES: readonly TriageSourceAdapterConformanceCase[] =
  Object.freeze([
    azureCase(),
    bitbucketCase(),
    githubCase(),
    gitlabCase(),
    posthogCase(),
    sentryCase(),
  ]);
