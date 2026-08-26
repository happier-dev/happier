import type {
  ConnectedAccountMetadataList,
  ConnectedAccountMaterialization,
  QualifiedConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import {
  TriageGetResultV1Schema,
  TriageListInstancesResultV1Schema,
  TriagePrepareReviewWorkspaceResultV1Schema,
  TriageScanResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriagePrepareReviewWorkspaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { encodeAzureSourceConfiguration } from './configuration.js';
import { AZURE_DEVOPS_TRIAGE_PURPOSE } from './descriptor.js';
import {
  AZURE_NATIVE_PAGE_SIZE,
  runAzureTriageGet,
  runAzureTriageListInstances,
  runAzureTriagePrepareReviewWorkspace,
  runAzureTriageScan,
  type AzureTriageAccountService,
  type AzureTriageReadServices,
} from './operations.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import type { AzureDevOpsHttpRequest, AzureDevOpsHttpResponse } from './types.js';

const BASE_URL = 'https://dev.azure.com/acme';
/** The bare origin HostAccess governs by. It is never the value a REST path is built beneath. */
const SERVICES_ORIGIN = 'https://dev.azure.com';
/** An Azure DevOps Server deployment: an arbitrary host plus a case-bearing collection path. */
const SERVER_ORIGIN = 'https://server.example';
const SERVER_BASE_URL = 'https://server.example/tfs/DefaultCollection';
const VIEWER_ID = 'a0d31c2e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const PROJECT_ID = '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const REPOSITORY_ID = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
const FORK_REPOSITORY_ID = '4dc8d8ef-4a33-4179-9e5e-4774e4e84b77';

function accountRef(accountId: string): QualifiedConnectedAccountRef {
  return {
    service: { pluginId: 'happier.scm.forge.azure-devops', localId: AZURE_DEVOPS_TRIAGE_PURPOSE },
    accountId,
  };
}

function configuredOrigin(raw = BASE_URL) {
  const result = normalizeAzureDevOpsBaseUrl(raw);
  if (!result.ok) throw new Error('fixture base is not normalizable');
  return result.origin;
}

function configuredInstance(
  overrides: Partial<TriageConfiguredSourceInstanceV1> = {},
): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: accountRef('account-1') },
    localInstanceKey: BASE_URL,
    configuration: encodeAzureSourceConfiguration(configuredOrigin()),
    ...overrides,
  };
}

const CONNECTION_DATA = {
  authenticatedUser: { id: VIEWER_ID, providerDisplayName: 'Ada' },
  deploymentType: 'hosted',
  instanceId: '9d0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
};

function project(id = PROJECT_ID, name = 'Payments') {
  return { id, name, state: 'wellFormed' };
}

function repository(id = REPOSITORY_ID, name = 'checkout') {
  return {
    id,
    name,
    project: { id: PROJECT_ID, name: 'Payments' },
    defaultBranch: 'refs/heads/main',
    isDisabled: false,
    webUrl: `https://dev.azure.com/acme/Payments/_git/${name}`,
  };
}

function pullRequest(pullRequestId: number, overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId,
    repository: repository(),
    title: `Change ${pullRequestId}`,
    status: 'active',
    isDraft: false,
    createdBy: { id: VIEWER_ID, displayName: 'Ada' },
    creationDate: '2026-08-01T10:00:00Z',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4' },
    lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6' },
    reviewers: [],
    labels: [],
    url: `https://dev.azure.com/acme/_apis/git/pullRequests/${pullRequestId}`,
    ...overrides,
  };
}

type Route = Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}>;

type Recorder = Readonly<{
  services: AzureTriageReadServices;
  urls: string[];
  materializedAccounts: QualifiedConnectedAccountRef[];
  /** The origin each materialization was requested for — the fact HostAccess governs by. */
  materializedOrigins: string[];
}>;

/**
 * The bases the fixture account publishes.
 *
 * Both deployments the read tests exercise are listed, because every authorized read
 * re-confirms its exact configured base against this listing before a credential is
 * materialized: an account that no longer publishes the base is a stale configured
 * instance, not a reader who should silently get org A's rows with org B's token.
 */
const PUBLISHED_BASES: readonly string[] = [BASE_URL, SERVER_BASE_URL];

function createRecorder(
  respond: (request: AzureDevOpsHttpRequest) => Route,
  options: Readonly<{
    now?: number;
    publishedBases?: readonly string[];
    accountListing?: ConnectedAccountMetadataList;
  }> = {},
): Recorder {
  const urls: string[] = [];
  const materializedAccounts: QualifiedConnectedAccountRef[] = [];
  const materializedOrigins: string[] = [];
  return {
    urls,
    materializedAccounts,
    materializedOrigins,
    services: {
      connectedAccounts: {
        async listAccounts() {
          return options.accountListing ?? {
            status: 'complete' as const,
            accounts: [{
              account: accountRef('account-1'),
              displayName: 'Acme',
              state: 'connected' as const,
              connectedAccountOrigins: [SERVICES_ORIGIN, SERVER_ORIGIN],
              connectedAccountBases: options.publishedBases ?? PUBLISHED_BASES,
            }],
          };
        },
        async getBinding(purpose) {
          return {
            purpose,
            service: accountRef('account-1').service,
            account: accountRef('account-1'),
            target: { kind: 'account' as const, displayName: 'Acme' },
          };
        },
        async materializeListedAccount(request): Promise<ConnectedAccountMaterialization> {
          materializedAccounts.push(request.account);
          if (request.materialization.kind !== 'httpHeaders') {
            throw new Error('the source must ask for HTTP headers');
          }
          materializedOrigins.push(request.materialization.origin);
          return { kind: 'httpHeaders', headers: { authorization: 'Basic <pat>' } };
        },
      },
      async transport(request: AzureDevOpsHttpRequest): Promise<AzureDevOpsHttpResponse> {
        urls.push(request.url);
        const route = respond(request);
        return {
          status: route.status ?? 200,
          headers: { 'content-type': 'application/json', ...route.headers },
          bodyText: typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
        };
      },
      now: () => options.now ?? 1_760_000_000_000,
    },
  };
}

function page(values: readonly unknown[]): Route {
  return { body: { count: values.length, value: values } };
}

function happyPath(pullRequests: Readonly<{
  authored?: readonly unknown[];
  reviewer?: readonly unknown[];
}> = {}): (request: AzureDevOpsHttpRequest) => Route {
  return (request) => {
    if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
    if (request.url.includes('_apis/projects')) return page([project()]);
    if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
    if (request.url.includes('searchCriteria.creatorId')) {
      return page(pullRequests.authored ?? [pullRequest(17)]);
    }
    if (request.url.includes('searchCriteria.reviewerId')) {
      return page(pullRequests.reviewer ?? []);
    }
    throw new Error(`unexpected request: ${request.url}`);
  };
}

describe('Azure DevOps Triage listInstances', () => {
  /**
   * One listed account exactly as the host publishes it.
   *
   * The two facts are deliberately different values here, because the host owner makes them
   * different: `connectedAccountOrigins` is admitted only as a bare `scheme://host[:port]`, while
   * `connectedAccountBases` carries the organization or collection path segment beneath it. A
   * fixture that repeated one value in both fields could not tell a source that routes by the base
   * apart from one that routes by the origin.
   */
  function listedAccount(input: Readonly<{
    accountId: string;
    displayName?: string;
    origins?: readonly string[];
    bases?: readonly string[];
  }>) {
    return {
      account: accountRef(input.accountId),
      displayName: input.displayName ?? 'Acme',
      state: 'connected' as const,
      connectedAccountOrigins: input.origins ?? [SERVICES_ORIGIN],
      connectedAccountBases: input.bases ?? [BASE_URL],
    };
  }

  function lister(
    result: unknown,
    calls: string[] = [],
    /** `null` is a purpose the host holds no selection for. */
    binding: Awaited<ReturnType<AzureTriageAccountService['getBinding']>> | undefined = undefined,
  ): AzureTriageAccountService {
    return {
      async listAccounts(request) {
        calls.push(request.purpose);
        if (result instanceof Error) throw result;
        return result as Awaited<ReturnType<AzureTriageAccountService['listAccounts']>>;
      },
      async getBinding(purpose) {
        calls.push(`getBinding:${purpose}`);
        return binding === undefined
          ? ({ purpose } as Awaited<ReturnType<AzureTriageAccountService['getBinding']>>)
          : binding;
      },
      async materializeListedAccount() {
        throw new Error('listInstances must not materialize a credential');
      },
    };
  }

  /**
   * A reader with no connected Azure DevOps account has configured nothing. The
   * host declines to list an unbound purpose, and reporting that decline as
   * `account-listing-failed` accuses a provider this source never contacted.
   */
  it('reports an unbound purpose as a complete empty candidate set', async () => {
    const calls: string[] = [];

    const result = await runAzureTriageListInstances({
      connectedAccounts: lister(
        Object.assign(new Error('resource not selected'), {
          code: 'plugin_host_access_resource_not_selected',
        }),
        calls,
        null,
      ),
      signal: new AbortController().signal,
    });

    expect(TriageListInstancesResultV1Schema.parse(result)).toEqual(result);
    expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
    expect(calls).toEqual([
      AZURE_DEVOPS_TRIAGE_PURPOSE,
      `getBinding:${AZURE_DEVOPS_TRIAGE_PURPOSE}`,
    ]);
  });

  it('still fails a refused listing while the purpose is bound', async () => {
    const result = await runAzureTriageListInstances({
      connectedAccounts: lister(new Error('listing unavailable')),
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected a failed result');
    expect(result.failure.code).toBe('azure-devops/account-listing-failed');
  });

  it('projects two purpose-scoped account rows into two candidates with their exact binding refs', async () => {
    const calls: string[] = [];
    const result = await runAzureTriageListInstances({
      connectedAccounts: lister({
        status: 'complete',
        accounts: [
          listedAccount({ accountId: 'account-1' }),
          listedAccount({ accountId: 'account-2', displayName: 'Acme (bot)' }),
        ],
      }, calls),
      signal: new AbortController().signal,
    });

    expect(TriageListInstancesResultV1Schema.parse(result)).toEqual(result);
    expect(calls).toEqual([AZURE_DEVOPS_TRIAGE_PURPOSE]);
    if (result.kind !== 'complete') throw new Error('expected a complete result');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.binding.account.accountId))
      .toEqual(['account-1', 'account-2']);
    for (const candidate of result.candidates) {
      expect(candidate.binding.purpose).toBe(AZURE_DEVOPS_TRIAGE_PURPOSE);
      // §3.1: the local key is the source-native scope only; re-encoding the account there
      // would create a second account-identity carrier.
      expect(candidate.localInstanceKey).toBe(BASE_URL);
      expect(candidate.configuration.token).not.toContain('account-');
      expect(candidate.keyStability).toBe('locatorDerived');
    }
  });

  it('carries every configured-base candidate instead of imposing a local thirty-two-instance ceiling', async () => {
    const result = await runAzureTriageListInstances({
      connectedAccounts: lister({
        status: 'complete',
        accounts: Array.from({ length: 33 }, (_unused, index) => listedAccount({
          accountId: `account-${index + 1}`,
        })),
      }),
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected a complete result');
    expect(result.candidates).toHaveLength(33);
  });

  it('maps a truncated listing to incomplete and a listing failure to failed, never complete', async () => {
    const truncated = await runAzureTriageListInstances({
      connectedAccounts: lister({
        status: 'truncated',
        accounts: [listedAccount({ accountId: 'account-1' })],
      }),
      signal: new AbortController().signal,
    });
    expect(TriageListInstancesResultV1Schema.parse(truncated)).toEqual(truncated);
    expect(truncated.kind).toBe('incomplete');
    if (truncated.kind !== 'incomplete') throw new Error('expected incomplete');
    expect(truncated.candidates).toHaveLength(1);
    expect(truncated.failure?.code).toBe('azure-devops/account-listing-truncated');

    const failed = await runAzureTriageListInstances({
      connectedAccounts: lister(new Error('listing unavailable')),
      signal: new AbortController().signal,
    });
    expect(TriageListInstancesResultV1Schema.parse(failed)).toEqual(failed);
    expect(failed.kind).toBe('failed');
  });

  it('mints one candidate per configured base for both Services and Server deployments', async () => {
    // The two deployment kinds differ only in the base the user configured: Services lives beneath
    // `https://dev.azure.com/{organization}` and Server beneath `https://{host}/{collection path}`.
    // Nothing here classifies them — a candidate is built from the configured base alone.
    const result = await runAzureTriageListInstances({
      connectedAccounts: lister({
        status: 'complete',
        accounts: [
          listedAccount({ accountId: 'services-account' }),
          listedAccount({
            accountId: 'server-account',
            displayName: 'Contoso TFS',
            origins: [SERVER_ORIGIN],
            bases: [SERVER_BASE_URL],
          }),
        ],
      }),
      signal: new AbortController().signal,
    });

    expect(TriageListInstancesResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'complete') throw new Error('expected a complete result');
    expect(result.failures).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.localInstanceKey))
      .toEqual([BASE_URL, SERVER_BASE_URL]);
    // The display label is the deployment's own organization or collection segment, and the
    // configured base — never the bare origin — is what the candidate routes and links by.
    expect(result.candidates.map((candidate) => candidate.locator.displayLabel))
      .toEqual(['acme', 'DefaultCollection']);
    expect(result.candidates.map((candidate) => candidate.locator.displayPath))
      .toEqual([BASE_URL, SERVER_BASE_URL]);
    for (const candidate of result.candidates) {
      expect(candidate.configuration.token).toContain(candidate.localInstanceKey);
    }
  });

  it('records an exact-binding failure instead of omitting an account with no configured base', async () => {
    const result = await runAzureTriageListInstances({
      connectedAccounts: lister({
        status: 'complete',
        accounts: [listedAccount({ accountId: 'account-1', origins: [], bases: [] })],
      }),
      signal: new AbortController().signal,
    });
    expect(TriageListInstancesResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'complete') throw new Error('expected a complete result');
    expect(result.candidates).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.binding.account.accountId).toBe('account-1');
    expect(result.failures[0]?.failure.code).toBe('azure-devops/configured-base-unavailable');
  });

  it('refuses to mint a candidate from a base that names no organization or collection', async () => {
    // A configured base may legitimately be a bare origin — the host's base normalizer accepts a
    // pathless value — but every Azure DevOps REST path lives beneath an organization (Services) or
    // collection (Server) path segment, so such a base cannot address `_apis/projects` at all.
    // Emitting a candidate anyway would put a row in Settings whose every scan fails with a routing
    // error the user cannot act on; the exact-binding failure names the missing fact instead.
    const result = await runAzureTriageListInstances({
      connectedAccounts: lister({
        status: 'complete',
        accounts: [listedAccount({ accountId: 'account-1', bases: [SERVICES_ORIGIN] })],
      }),
      signal: new AbortController().signal,
    });

    expect(TriageListInstancesResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'complete') throw new Error('expected a complete result');
    expect(result.candidates).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.localInstanceKey).toBe(SERVICES_ORIGIN);
    expect(result.failures[0]?.failure.code).toBe('azure-devops/organization-scope-unavailable');
    expect(result.failures[0]?.failure.class).toBe('unsupportedContract');
  });
});

describe('Azure DevOps Triage scan', () => {
  it('walks projects, then repositories, then the two viewer lanes, with every URL version-pinned', async () => {
    const recorder = createRecorder(happyPath());
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 32 },
      },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0];
    if (observation?.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.localRef.entryId).toBe('17');
    expect(observation.viewer.involvement).toEqual(['author']);

    // Azure has no organization-wide pull-request list: the walk is projects → repositories →
    // per-repository lanes, and both lanes are distinct provider queries.
    expect(recorder.urls.some((url) => url.includes('_apis/projects'))).toBe(true);
    expect(recorder.urls.some((url) => url.includes('_apis/git/repositories?'))).toBe(true);
    expect(recorder.urls.filter((url) => url.includes('searchCriteria.creatorId'))).toHaveLength(1);
    expect(recorder.urls.filter((url) => url.includes('searchCriteria.reviewerId'))).toHaveLength(1);
    for (const url of recorder.urls) expect(url).toContain('api-version=');
    // Every request is built beneath the configured organization base, while the credential is
    // materialized for the bare origin HostAccess admits.
    for (const url of recorder.urls) expect(url.startsWith(`${BASE_URL}/`)).toBe(true);
    expect([...new Set(recorder.materializedOrigins)]).toEqual([SERVICES_ORIGIN]);
    // §3.1/§5: only the exact configured binding account is reauthorized.
    expect(recorder.materializedAccounts).toEqual([accountRef('account-1')]);
    expect(JSON.stringify(result)).not.toContain('Basic');
  });

  /**
   * The highest-severity currentness case this source has.
   *
   * A credential is minted for an ORIGIN, and every Azure DevOps Services organization shares
   * `https://dev.azure.com`. So origin admission alone cannot tell an account configured for
   * `…/acme` from that same account reconnected to a different organization: the configured
   * instance keeps routing `…/acme` paths and authorizing them with the new organization's
   * credential. Nothing after discovery looked at the path again.
   */
  it('refuses a configured base its account no longer publishes, before any credential or request', async () => {
    const recorder = createRecorder(happyPath(), {
      // The account was reconnected to another organization. Same host, same admitted origin.
      publishedBases: ['https://dev.azure.com/other-org'],
    });

    const result = await runAzureTriageScan({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 32 },
      },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'failed') throw new Error('a stale configured base must not be read');
    expect(result.failure.code).toBe('azure-devops/configured-base-stale');
    expect(result.failure.class).toBe('unsupportedContract');
    // Zero of both: no credential was minted for the new organization, and no path under the
    // old one was requested.
    expect(recorder.materializedAccounts).toHaveLength(0);
    expect(recorder.urls).toHaveLength(0);
  });

  it('does not report a configured account disconnected when a truncated listing omitted it', async () => {
    const recorder = createRecorder(happyPath(), {
      accountListing: { status: 'truncated', accounts: [] },
    });

    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 8 } },
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected an attributed incomplete listing');
    expect(result.failure.code).toBe('azure-devops/configured-account-listing-truncated');
    expect(result.failure.class).toBe('transient');
    expect(result.failure.code).not.toBe('azure-devops/configured-account-unavailable');
    expect(recorder.materializedAccounts).toHaveLength(0);
  });

  it('walks an Azure DevOps Server collection base while still authorizing by its bare origin', async () => {
    // Server differs from Services only in the base the user configured: an arbitrary host plus a
    // case-bearing collection path. Nothing classifies the deployment; the same walk runs beneath
    // whichever base the account published.
    const recorder = createRecorder(happyPath());
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance({
          localInstanceKey: SERVER_BASE_URL,
          configuration: encodeAzureSourceConfiguration(configuredOrigin(SERVER_BASE_URL)),
        }),
        page: { kind: 'initial', limit: 32 },
      },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(result.observations).toHaveLength(1);
    expect(recorder.urls.length).toBeGreaterThan(0);
    for (const url of recorder.urls) expect(url.startsWith(`${SERVER_BASE_URL}/`)).toBe(true);
    // The collection path routes; it is never folded into the origin the host admits.
    expect([...new Set(recorder.materializedOrigins)]).toEqual([SERVER_ORIGIN]);
  });

  it('attributes a failed repository frontier as partial health rather than an empty lane', async () => {
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) {
        return { status: 403, body: { message: 'Access denied.', typeKey: 'AccessDenied' } };
      }
      throw new Error(`unexpected request: ${request.url}`);
    });
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 32 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.failure.class).toBe('permission');
    expect(recorder.urls.some((url) => url.includes('searchCriteria'))).toBe(false);
  });

  it('keeps already-observed rows and reports partial when a later frontier read fails', async () => {
    let repositoryReads = 0;
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) {
        repositoryReads += 1;
        return repositoryReads === 1
          ? page([repository()])
          : { status: 500, body: { message: 'Server error.' } };
      }
      if (request.url.includes('searchCriteria.creatorId')) return page([pullRequest(17)]);
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 32 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error('a partial read must not discard observations');
    expect(result.observations).toHaveLength(1);
    expect(result.evidence.kind).toBe('partial');
  });

  it('reports moving offset-paging once a lane needed more than one page', async () => {
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
      if (request.url.includes('searchCriteria.creatorId')) {
        const skip = Number(new URL(request.url).searchParams.get('$skip') ?? '0');
        return skip === 0
          ? page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
            pullRequest(100 + index)
          )))
          : page([pullRequest(200)]);
      }
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 64 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(result.observations.length).toBe(AZURE_NATIVE_PAGE_SIZE + 1);
    // $top/$skip over a mutating list skips and duplicates by construction, so a lane that
    // needed a second page can only claim `moving`.
    expect(result.evidence.kind).toBe('moving');
    const advanced = recorder.urls.filter((url) => url.includes(`$skip=${AZURE_NATIVE_PAGE_SIZE}`));
    expect(advanced.length).toBe(1);
  });

  it('reports a single-page lane as a finished walk rather than moving', async () => {
    const recorder = createRecorder(happyPath());
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 64 } },
      signal: new AbortController().signal,
    });
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(result.evidence.kind).toBe('walkFinished');
  });

  it('keeps reporting a walk as moving after the repository that offset-paged is behind it', async () => {
    // `sources/SCM.md` §6.5: the frontier's lanes hold only the repository being walked now, so
    // the moment the walk advances past the repository whose lane offset-paged, the sticky set is
    // the only record that this walk paged an offset at all. A per-call evidence computation
    // reports `walkFinished` here, because the call that settles the walk never paged itself.
    const SECOND_REPOSITORY_ID = 'ffb7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) {
        return page([repository(), repository(SECOND_REPOSITORY_ID, 'billing')]);
      }
      const walkingSecond = request.url.includes(SECOND_REPOSITORY_ID);
      if (request.url.includes('searchCriteria.creatorId')) {
        if (walkingSecond) {
          return page([
            pullRequest(900, { repository: repository(SECOND_REPOSITORY_ID, 'billing') }),
          ]);
        }
        const skip = Number(new URL(request.url).searchParams.get('$skip') ?? '0');
        return skip === 0
          ? page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
            pullRequest(100 + index)
          )))
          : page([pullRequest(200)]);
      }
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });

    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 64 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(result.kind).toBe('complete');
    expect(recorder.urls.some((url) => url.includes(SECOND_REPOSITORY_ID))).toBe(true);
    expect(result.evidence).toEqual({ kind: 'moving', reason: 'offset-paging' });
  });

  it('visits every open lane once before letting one lane take a second page', async () => {
    // `sources/SCM.md` §2.8b: lane selection is round-robin over the lanes still open — one
    // native page from each open lane before any lane deep-pages again. With a first lane that
    // always has another page, a first-open-lane walk never reaches the reviewer lane at all.
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
      if (request.url.includes('searchCriteria.creatorId')) {
        return page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
          pullRequest(100 + index)
        )));
      }
      if (request.url.includes('searchCriteria.reviewerId')) {
        return page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
          pullRequest(500 + index)
        )));
      }
      throw new Error(`unexpected request: ${request.url}`);
    });

    // 64 admits exactly two 30-row native pages; the third does not fit.
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 64 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(recorder.urls.filter((url) => url.includes('searchCriteria.creatorId'))).toHaveLength(1);
    expect(recorder.urls.filter((url) => url.includes('searchCriteria.reviewerId'))).toHaveLength(1);
    const entryIds = result.observations.map((observation) => (
      observation.kind === 'present' ? Number(observation.localRef.entryId) : -1
    ));
    expect(entryIds.some((entryId) => entryId >= 100 && entryId < 200)).toBe(true);
    expect(entryIds.some((entryId) => entryId >= 500 && entryId < 600)).toBe(true);
  });

  it('resumes the lane rotation the continuation carried instead of restarting at the first lane', async () => {
    // The rotation position is serialized precisely because a walk this deep spans pages: with a
    // budget that admits exactly one native page per call, a resumed walk that restarted at lane
    // zero would re-query the authored lane on every call and never reach the reviewer lane —
    // which is the same monopoly the in-call round-robin exists to prevent.
    const respond = (request: AzureDevOpsHttpRequest): Route => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
      if (request.url.includes('searchCriteria.creatorId')) {
        return page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
          pullRequest(100 + index)
        )));
      }
      if (request.url.includes('searchCriteria.reviewerId')) {
        return page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
          pullRequest(500 + index)
        )));
      }
      throw new Error(`unexpected request: ${request.url}`);
    };

    const first = createRecorder(respond);
    const firstResult = await runAzureTriageScan({
      services: first.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: AZURE_NATIVE_PAGE_SIZE },
      },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(firstResult)).toEqual(firstResult);
    if (firstResult.kind !== 'page') throw new Error('expected a resumable page');
    expect(first.urls.filter((url) => url.includes('searchCriteria.creatorId'))).toHaveLength(1);
    expect(first.urls.filter((url) => url.includes('searchCriteria.reviewerId'))).toHaveLength(0);

    const second = createRecorder(respond);
    const secondResult = await runAzureTriageScan({
      services: second.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: firstResult.continuation },
      },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(secondResult)).toEqual(secondResult);
    if (secondResult.kind === 'failed') {
      throw new Error(`unexpected failure: ${secondResult.failure.code}`);
    }
    expect(second.urls.filter((url) => url.includes('searchCriteria.reviewerId'))).toHaveLength(1);
    expect(second.urls.filter((url) => url.includes('searchCriteria.creatorId'))).toHaveLength(0);
    const resumedIds = secondResult.observations.map((observation) => (
      observation.kind === 'present' ? Number(observation.localRef.entryId) : -1
    ));
    expect(resumedIds.every((entryId) => entryId >= 500 && entryId < 600)).toBe(true);
  });

  it('keeps resumed lane offsets bound to the active repository when another repository is inserted', async () => {
    const INSERTED_REPOSITORY_ID = '11111111-2222-4333-8444-555555555555';
    const first = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
      if (request.url.includes('searchCriteria.creatorId')) {
        return page(Array.from({ length: AZURE_NATIVE_PAGE_SIZE }, (_unused, index) => (
          pullRequest(100 + index)
        )));
      }
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });
    const firstResult = await runAzureTriageScan({
      services: first.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: AZURE_NATIVE_PAGE_SIZE },
      },
      signal: new AbortController().signal,
    });
    if (firstResult.kind !== 'page') throw new Error('expected a resumable first page');

    const second = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/git/repositories?')) {
        return page([
          repository(INSERTED_REPOSITORY_ID, 'inserted'),
          repository(),
        ]);
      }
      if (request.url.includes('searchCriteria.creatorId')) return page([]);
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });
    const secondResult = await runAzureTriageScan({
      services: second.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: firstResult.continuation },
      },
      signal: new AbortController().signal,
    });

    if (secondResult.kind === 'failed') throw new Error(secondResult.failure.code);
    const firstResumedLaneUrl = second.urls.find((url) => url.includes('searchCriteria.'));
    expect(firstResumedLaneUrl).toContain(REPOSITORY_ID);
    expect(firstResumedLaneUrl).toContain('searchCriteria.reviewerId');
    expect(firstResumedLaneUrl).not.toContain(INSERTED_REPOSITORY_ID);
  });

  it('charges the page budget in raw provider rows so omitted rows cannot overfill the page', async () => {
    // `sources/SCM.md` §6.5 budget accounting: an undecodable pull-request row has still
    // consumed provider position, so it costs budget and appears in `omittedItemCount`.
    // Charging only mapped observations lets a lane of undecodable rows leave the budget
    // unspent, after which the next page overfills and CONTRACT §5.1 rejects the whole result.
    const undecodableRow = { pullRequestId: null, repository: { id: REPOSITORY_ID } };
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
      if (request.url.includes('searchCriteria.creatorId')) {
        const skip = Number(new URL(request.url).searchParams.get('$skip') ?? '0');
        return skip === 0
          ? page(Array.from({ length: 4 }, () => undecodableRow))
          : page(Array.from({ length: 4 }, (_unused, index) => pullRequest(700 + index)));
      }
      if (request.url.includes('searchCriteria.reviewerId')) {
        return page(Array.from({ length: 4 }, (_unused, index) => pullRequest(800 + index)));
      }
      throw new Error(`unexpected request: ${request.url}`);
    });

    const limit = 4;
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    const omitted = result.evidence.kind === 'partial' ? result.evidence.omittedItemCount ?? 0 : 0;
    expect(omitted).toBe(4);
    expect(result.observations.length + omitted).toBeLessThanOrEqual(limit);
  });

  it('attributes an undecodable repository row as partial health without charging the entry omission count', async () => {
    // A repository is a scope the walk could not enter, not an entry it omitted: the number of
    // pull requests lost is unknown, and counting it as an omitted entry would break the
    // `observations.length + omittedItemCount <= limit` bound the target enforces. The reason
    // name is `sources/SCM.md` §2.8b's closed sticky vocabulary — the same one Bitbucket's
    // bespoke repository-enumeration boolean folded into — rather than a source-local word.
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) return page([project()]);
      if (request.url.includes('_apis/git/repositories?')) {
        return page([repository(), { id: 'not-a-guid', name: 'broken' }]);
      }
      if (request.url.includes('searchCriteria.creatorId')) return page([pullRequest(17)]);
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });

    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 1 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    expect(result.evidence.kind).toBe('partial');
    if (result.evidence.kind !== 'partial') throw new Error('expected partial evidence');
    expect(result.evidence.reason).toBe('repository-enumeration-incomplete');
    expect(result.evidence.omittedItemCount).toBeUndefined();
    expect(result.observations.length).toBeLessThanOrEqual(1);
  });

  it('binds the submitted limit into the continuation and restarts on an undecodable token', async () => {
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) {
        const token = new URL(request.url).searchParams.get('continuationToken');
        return token === null
          ? { headers: { 'x-ms-continuationtoken': 'project-2' }, body: { count: 1, value: [project()] } }
          : page([]);
      }
      if (request.url.includes('_apis/git/repositories?')) return page([repository()]);
      if (request.url.includes('searchCriteria.creatorId')) {
        return page(Array.from({ length: 2 }, (_unused, index) => pullRequest(300 + index)));
      }
      if (request.url.includes('searchCriteria.reviewerId')) return page([]);
      throw new Error(`unexpected request: ${request.url}`);
    });

    const first = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 2 } },
      signal: new AbortController().signal,
    });
    expect(TriageScanResultV1Schema.parse(first)).toEqual(first);
    if (first.kind !== 'page') throw new Error('a saturated projection budget must return a page');
    expect(first.observations).toHaveLength(2);
    expect(first.continuation.token).not.toContain('Basic');
    expect(first.continuation.token).not.toContain('account-1');

    const rejected = await runAzureTriageScan({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: { v: 1, token: '{"v":9}' } },
      },
      signal: new AbortController().signal,
    });
    expect(rejected.kind).toBe('failed');
    if (rejected.kind !== 'failed') throw new Error('expected failed');
    expect(rejected.failure.class).toBe('unsupportedContract');
  });

  it('settles a throttled provider response as failed with its own absolute deadline', async () => {
    const recorder = createRecorder((request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('_apis/projects')) {
        return { status: 429, headers: { 'retry-after': '30' }, body: { message: 'Throttled.' } };
      }
      throw new Error(`unexpected request: ${request.url}`);
    }, { now: 1_760_000_000_000 });

    const result = await runAzureTriageScan({
      services: recorder.services,
      request: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 8 } },
      signal: new AbortController().signal,
    });

    expect(TriageScanResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.failure.class).toBe('rateLimit');
    expect(result.failure.retryNotBeforeMs).toBe(1_760_000_030_000);
  });

  it('refuses a configuration token that does not decode rather than guessing a route', async () => {
    const recorder = createRecorder(happyPath());
    const result = await runAzureTriageScan({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance({ configuration: { v: 1, token: '{"v":1,"baseUrl":"nope"}' } }),
        page: { kind: 'initial', limit: 8 },
      },
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.failure.class).toBe('unsupportedContract');
    expect(recorder.urls).toHaveLength(0);
  });
});

describe('Azure DevOps Triage get', () => {
  function pullRequestRoute(response: Route): (request: AzureDevOpsHttpRequest) => Route {
    return (request) => {
      if (request.url.includes('_apis/connectionData')) return { body: CONNECTION_DATA };
      if (request.url.includes('/pullrequests/')) return response;
      throw new Error(`unexpected request: ${request.url}`);
    };
  }

  const localRef = {
    kindId: 'pull-request',
    collisionScope: '',
    entryId: '17',
  };

  async function get(route: (request: AzureDevOpsHttpRequest) => Route, scope: string) {
    const recorder = createRecorder(route);
    const result = await runAzureTriageGet({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        localRef: { ...localRef, collisionScope: scope },
        lastKnownLocator: { v: 1, routingToken: 'acme/Payments/checkout' },
      },
      signal: new AbortController().signal,
    });
    return { result, recorder };
  }

  function scopeFor(base = BASE_URL): string {
    const origin = configuredOrigin(base);
    return `azure-devops:${encodeBase64UrlForTest(origin.baseUrl)}:${REPOSITORY_ID}`;
  }

  function encodeBase64UrlForTest(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  it('returns the exact input local ref as present and never absent for an ambiguous 404', async () => {
    const present = await get(pullRequestRoute({ body: pullRequest(17) }), scopeFor());
    expect(TriageGetResultV1Schema.parse(present.result)).toEqual(present.result);
    expect(present.result.kind).toBe('present');
    expect(present.result.localRef).toEqual({ ...localRef, collisionScope: scopeFor() });
    // The opaque locator is this source's only endpoint route. The immutable collision scope is
    // checked against the provider response, but it is never unpacked into a REST path.
    expect(present.recorder.urls.join('\n')).toContain(
      '/Payments/_apis/git/repositories/checkout/pullrequests/17?',
    );

    const missing = await get(
      pullRequestRoute({ status: 404, body: { message: 'Not found.', typeKey: 'NotFound' } }),
      scopeFor(),
    );
    expect(TriageGetResultV1Schema.parse(missing.result)).toEqual(missing.result);
    // Azure documents 404 as nonexistent OR not permitted to view; concluding absence would
    // delete a row the user simply cannot see.
    expect(missing.result.kind).toBe('unresolved');
    if (missing.result.kind !== 'unresolved') throw new Error('expected unresolved');
    expect(missing.result.failure.code).toBe('azure-devops/not-found-or-forbidden');
  });

  it('reports no involvement for a viewer who neither authored nor was asked to review', async () => {
    const { result } = await get(
      pullRequestRoute({
        body: pullRequest(17, { createdBy: { id: '11111111-2222-4333-8444-555555555555' } }),
      }),
      scopeFor(),
    );
    expect(TriageGetResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'present') throw new Error('expected present');
    expect(result.viewer.involvement).toEqual([]);
  });

  it('maps a non-zero returned reviewer vote to participating and retains the native vote fact', async () => {
    const { result } = await get(
      pullRequestRoute({
        body: pullRequest(17, {
          createdBy: { id: '11111111-2222-4333-8444-555555555555' },
          reviewers: [{ id: VIEWER_ID, displayName: 'Ada', vote: 10, isRequired: true }],
        }),
      }),
      scopeFor(),
    );
    if (result.kind !== 'present') throw new Error('expected present');
    expect(result.viewer.involvement).toEqual(['participating']);
    expect(result.snapshot.facts.map((fact) => fact.id)).toContain('azure-devops/reviewer-vote');
  });

  it('refuses a local ref minted against a different configured base without calling the provider', async () => {
    const { result, recorder } = await get(
      pullRequestRoute({ body: pullRequest(17) }),
      scopeFor('https://dev.azure.com/other'),
    );
    expect(TriageGetResultV1Schema.parse(result)).toEqual(result);
    if (result.kind !== 'unresolved') throw new Error('expected unresolved');
    expect(result.failure.class).toBe('unsupportedContract');
    expect(recorder.urls).toHaveLength(0);
  });

  it('refuses a response whose repository or number is not the one that was requested', async () => {
    const { result } = await get(
      pullRequestRoute({
        body: pullRequest(18, { repository: repository('11111111-2222-4333-8444-555555555555') }),
      }),
      scopeFor(),
    );
    if (result.kind !== 'unresolved') throw new Error('expected unresolved');
    expect(result.failure.class).toBe('unsupportedContract');
  });

  it('fails a first read with no locator instead of reconstructing an endpoint from identity', async () => {
    const recorder = createRecorder(pullRequestRoute({ body: pullRequest(17) }));
    const result = await runAzureTriageGet({
      services: recorder.services,
      request: {
        v: 1,
        instance: configuredInstance(),
        localRef: { ...localRef, collisionScope: scopeFor() },
      },
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('unresolved');
    expect(recorder.urls).toHaveLength(0);
  });
});

describe('Azure DevOps review-workspace preparation', () => {
  function scopeFor(base = BASE_URL): string {
    const origin = configuredOrigin(base);
    return `azure-devops:${Buffer.from(origin.baseUrl, 'utf8').toString('base64url')}:${REPOSITORY_ID}`;
  }

  function input(overrides: Partial<TriagePrepareReviewWorkspaceInputV1> = {}) {
    const instance = configuredInstance();
    return {
      v: 1 as const,
      instance,
      entryRef: {
        source: instance.instance.source,
        kindId: 'pull-request',
        collisionScope: scopeFor(),
        entryId: '17',
      },
      lastKnownLocator: { v: 1, routingToken: 'acme/Payments/checkout' },
      observed: {
        baseSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        headSha: 'b3f1c0a9d2e4789012345678901234567890abcd',
        nativeRevision: 'b3f1c0a9d2e4789012345678901234567890abcd',
        observedAtMs: 1_760_000_000_000,
      },
      workspace: {
        serverId: 'server-1',
        machineId: 'machine-1',
        rootPath: '/selected/workspace',
      },
      ...overrides,
    } satisfies TriagePrepareReviewWorkspaceInputV1;
  }

  function workspaceServices(
    recorder: Recorder,
    execute: ReturnType<typeof vi.fn>,
  ) {
    return {
      ...recorder.services,
      actions: { execute } as unknown as ActionsService,
    };
  }

  it('reauthorizes and rereads the exact PR before materializing its fork source tip', async () => {
    const recorder = createRecorder((request) => {
      if (!request.url.includes('/pullrequests/')) throw new Error(`unexpected request: ${request.url}`);
      return {
        body: pullRequest(17, {
          sourceRefName: 'refs/heads/feature/fork',
          lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4789012345678901234567890abcd' },
          lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6789012345678901234567890abcd' },
          // `forkSource` must win over this target-adjacent sourceRepository value.
          sourceRepository: {
            id: REPOSITORY_ID,
            remoteUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
          },
          forkSource: {
            repository: {
              id: FORK_REPOSITORY_ID,
              remoteUrl: 'https://dev.azure.com/acme/Forks/_git/contributor',
            },
          },
        }),
      };
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/selected/workspace/.happier/worktrees/feature-fork',
      branchName: 'feature/fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));
    const signal = new AbortController().signal;

    const result = await runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input(),
      signal,
    });

    expect(TriagePrepareReviewWorkspaceResultV1Schema.parse(result)).toEqual(result);
    expect(result).toEqual({
      kind: 'prepared',
      repositoryPath: '/selected/workspace/.happier/worktrees/feature-fork',
      branch: 'feature/fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' },
      pullRequest: { number: 17 },
    });
    expect(recorder.materializedAccounts).toEqual([accountRef('account-1')]);
    expect(recorder.urls.join('\n')).toContain(
      '/Payments/_apis/git/repositories/checkout/pullrequests/17?',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/selected/workspace',
        displayName: 'feature/fork',
        sourceTip: {
          repository: {
            kind: 'azure-devops',
            deployment: 'https://dev.azure.com/acme',
            repository: 'acme/Forks/contributor',
          },
          cloneUrl: 'https://dev.azure.com/acme/Forks/_git/contributor',
          branch: 'feature/fork',
          sourceHeadSha: 'b3f1c0a9d2e4789012345678901234567890abcd',
          fetchRef: 'refs/heads/feature/fork',
        },
      },
      { signal },
    );
  });

  it('refuses a moved observed head before the generic local materializer runs', async () => {
    const recorder = createRecorder((request) => {
      if (!request.url.includes('/pullrequests/')) throw new Error(`unexpected request: ${request.url}`);
      return {
        body: pullRequest(17, {
          sourceRepository: {
            id: REPOSITORY_ID,
            remoteUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
          },
          lastMergeSourceCommit: { commitId: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
          lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6789012345678901234567890abcd' },
        }),
      };
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/selected/workspace/.happier/worktrees/feature',
      branchName: 'feature',
      created: false,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));

    await expect(runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a moved observed base before the generic local materializer runs', async () => {
    const recorder = createRecorder((request) => {
      if (!request.url.includes('/pullrequests/')) throw new Error(`unexpected request: ${request.url}`);
      return {
        body: pullRequest(17, {
          sourceRepository: {
            id: REPOSITORY_ID,
            remoteUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
          },
          lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4789012345678901234567890abcd' },
          lastMergeTargetCommit: { commitId: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        }),
      };
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/selected/workspace/.happier/worktrees/feature',
      branchName: 'feature',
      created: false,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));

    await expect(runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a mismatched observed native revision before the generic local materializer runs', async () => {
    const recorder = createRecorder((request) => {
      if (!request.url.includes('/pullrequests/')) throw new Error(`unexpected request: ${request.url}`);
      return {
        body: pullRequest(17, {
          sourceRepository: {
            id: REPOSITORY_ID,
            remoteUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
          },
          lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4789012345678901234567890abcd' },
          lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6789012345678901234567890abcd' },
        }),
      };
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/selected/workspace/.happier/worktrees/feature',
      branchName: 'feature',
      created: false,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));

    await expect(runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input({
        observed: {
          baseSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          headSha: 'b3f1c0a9d2e4789012345678901234567890abcd',
          nativeRevision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          observedAtMs: 1_760_000_000_000,
        },
      }),
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a stale source locator rather than accepting a response routed by identity', async () => {
    const recorder = createRecorder((request) => {
      if (!request.url.includes('/pullrequests/')) throw new Error(`unexpected request: ${request.url}`);
      return {
        body: pullRequest(17, {
          sourceRepository: {
            id: REPOSITORY_ID,
            remoteUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
          },
          lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4789012345678901234567890abcd' },
          lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6789012345678901234567890abcd' },
        }),
      };
    });
    const execute = vi.fn();

    await expect(runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input({ lastKnownLocator: { v: 1, routingToken: 'acme/Payments/renamed' } }),
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a missing matched workspace remote to workspaceMismatch', async () => {
    const recorder = createRecorder((request) => {
      if (!request.url.includes('/pullrequests/')) throw new Error(`unexpected request: ${request.url}`);
      return {
        body: pullRequest(17, {
          sourceRepository: {
            id: REPOSITORY_ID,
            remoteUrl: 'https://dev.azure.com/acme/Payments/_git/checkout',
          },
          lastMergeSourceCommit: { commitId: 'b3f1c0a9d2e4789012345678901234567890abcd' },
          lastMergeTargetCommit: { commitId: 'a1b2c3d4e5f6789012345678901234567890abcd' },
        }),
      };
    });
    const execute = vi.fn(async () => ({
      success: false as const,
      error: 'The selected workspace has no matching remote.',
      errorCode: 'REMOTE_NOT_FOUND' as const,
    }));

    await expect(runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'workspaceMismatch' });
  });

  it('requires an explicit selected workspace without provider or local work', async () => {
    const recorder = createRecorder((request) => {
      throw new Error(`workspaceRequired must not read the provider: ${request.url}`);
    });
    const execute = vi.fn();

    await expect(runAzureTriagePrepareReviewWorkspace({
      services: workspaceServices(recorder, execute),
      request: input({ workspace: null }),
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'workspaceRequired' });
    expect(recorder.materializedAccounts).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
