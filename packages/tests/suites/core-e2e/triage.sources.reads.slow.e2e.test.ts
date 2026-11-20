// QB-12/QB-14/QB-17/QB-84/QB-86, U-SCM, U-SENTRY-READ and U-PH-READ: real Account Actions,
// server/Postgres and daemon; only the external provider TLS socket is replaced.
// Native rendering, Composer disclosure and real-provider tenancy are separate gates.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { maxHeaderSize } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as connectionOutputs } from '@happier-dev/protocol/connect/configurationActionsV1';
import { QualifiedConnectedAccountListResponseV4Schema, QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TriageSourceAdministrationActionResultV1Schema, TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageListInstancesResultV1Schema, TriageGetResultV1Schema, TriageScanResultV1Schema,
  TriageConfiguredSourceConnectedAccountInstanceV1Schema, MAX_TRIAGE_LIST_SOURCE_BATCH_V1, MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
  type TriageSourceInstanceDraftV1, type TriageConfiguredSourceConnectedAccountInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import sentryPackage from '../../../plugins/sentry/package.json';
import { PLUGIN_MANIFEST as sentryManifest } from '../../../plugins/sentry/src/manifest';
import { activate as activateSentry } from '../../../plugins/sentry/src/accountRuntime';
import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID, SENTRY_CONNECTED_ACCOUNT_ID, SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_SCOPE_SEPARATOR } from '../../../plugins/sentry/src/sentryContracts';
import { SENTRY_CLOUD_MODE_ID, SENTRY_REGION_CONFIGURATION_FIELD, SENTRY_TOKEN_CREDENTIAL_KEY } from '../../../plugins/sentry/src/auth/connectedAccountRuntime';
import { SentryReadEventResultV1Schema } from '../../../plugins/sentry/src/detail/detailContracts';
import sentryOrganizations from '../../../plugins/sentry/src/fixtures/organizationsCloudPage.json';
import sentryPage from '../../../plugins/sentry/src/fixtures/issuesListPage1.json';
import sentryIssue from '../../../plugins/sentry/src/fixtures/issueDetail.json';
import posthogPackage from '../../../plugins/posthog/package.json';
import { PLUGIN_MANIFEST as posthogManifest } from '../../../plugins/posthog/src/manifest';
import { activate as activatePosthog } from '../../../plugins/posthog/src/accountRuntime';
import { POSTHOG_ACTION_IDS, POSTHOG_PLUGIN_ID, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_PERSONAL_API_KEY_MODE_ID, POSTHOG_PERSONAL_API_KEY_FIELD_ID, POSTHOG_API_ORIGIN_FIELD_ID } from '../../../plugins/posthog/src/posthogContracts';
import { PosthogSampledEventsResultV1Schema } from '../../../plugins/posthog/src/source/detail/issueEventsContract';
import { POSTHOG_ISSUE_EVENTS_INCLUDE } from '../../../plugins/posthog/src/api/types/events';
import posthogOrganizations from '../../../plugins/posthog/src/api/__fixtures__/organizationsPage.json';
import posthogProjects from '../../../plugins/posthog/src/api/__fixtures__/organizationProjectsPage.json';
import posthogPage from '../../../plugins/posthog/src/api/__fixtures__/queryIssuesPage1.json';
import posthogIssue from '../../../plugins/posthog/src/api/__fixtures__/crudIssueRead.json';
import posthogDetail from '../../../plugins/posthog/src/api/__fixtures__/queryIssueDetail.json';
import posthogEvents from '../../../plugins/posthog/src/api/__fixtures__/queryIssueEventsPage.json';
import gitlabPackage from '../../../plugins/scm-gitlab/package.json';
import { GITLAB_PLUGIN } from '../../../plugins/scm-gitlab/src/manifest';
import { activate as activateGitlab } from '../../../plugins/scm-gitlab/src/accountRuntime';
import { GITLAB_PLUGIN_ID, GITLAB_CONNECTED_ACCOUNT_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID, GITLAB_TRIAGE_ACTION_IDS } from '../../../plugins/scm-gitlab/src/triage/contribution';
import { GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID, GITLAB_ORIGIN_CONFIGURATION_FIELD, GITLAB_TOKEN_CREDENTIAL_KEY } from '../../../plugins/scm-gitlab/src/auth/connectedAccountRuntime';
import gitlabMergeRequests from '../../../plugins/scm-gitlab/src/triage/__fixtures__/mergeRequestList.json';
import bitbucketPackage from '../../../plugins/scm-bitbucket/package.json';
import { BITBUCKET_PLUGIN } from '../../../plugins/scm-bitbucket/src/manifest';
import { activate as activateBitbucket } from '../../../plugins/scm-bitbucket/src/accountRuntime';
import { BITBUCKET_PLUGIN_ID, BITBUCKET_TRIAGE_CONTRIBUTION_ID } from '../../../plugins/scm-bitbucket/src/bitbucketContracts';
import { BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID, BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, BITBUCKET_TRIAGE_ACTION_IDS } from '../../../plugins/scm-bitbucket/src/triage/source/descriptor';
import bitbucketUser from '../../../plugins/scm-bitbucket/src/triage/fixtures/currentUser.json';
import bitbucketWorkspaces from '../../../plugins/scm-bitbucket/src/triage/fixtures/userWorkspacesPage.json';
import bitbucketRepositories from '../../../plugins/scm-bitbucket/src/triage/fixtures/workspaceRepositoriesPage.json';
import bitbucketPullRequest from '../../../plugins/scm-bitbucket/src/triage/fixtures/pullRequestSelf.json';
import azurePackage from '../../../plugins/scm-azure-devops/package.json';
import { AZURE_DEVOPS_PLUGIN } from '../../../plugins/scm-azure-devops/src/manifest';
import { activate as activateAzure } from '../../../plugins/scm-azure-devops/src/accountRuntime';
import { AZURE_DEVOPS_PLUGIN_ID } from '../../../plugins/scm-azure-devops/src/azureDevopsContracts';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, AZURE_DEVOPS_TRIAGE_PURPOSE, AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID } from '../../../plugins/scm-azure-devops/src/triage/descriptor';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS } from '../../../plugins/scm-azure-devops/src/triage/actions';
import { AZURE_DEVOPS_MANUAL_MODE_ID, AZURE_DEVOPS_BASE_CONFIGURATION_FIELD, encodeAzureDevOpsPatAuthorization } from '../../../plugins/scm-azure-devops/src/auth/azureDevopsConnectedAccountRuntime';
import azureConnection from '../../../plugins/scm-azure-devops/src/triage/fixtures/connectionData.json';
import azureProjects from '../../../plugins/scm-azure-devops/src/triage/fixtures/projects.page1.json';
import azurePullRequests from '../../../plugins/scm-azure-devops/src/triage/fixtures/pullRequests.authored.page1.json';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema, type TriageListEntriesInputV1 } from '../../../plugins/triage/src/actions/listEntriesProtocol';
import { createTriageListWindowStore } from '../../../plugins/triage/src/projection/listWindowStore';
import { installDeviceWriteTraps } from '../../../plugins/triage/src/projection/noPersistence.test-support';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1, TRIAGE_LIST_DEFAULT_LENS_V1, triageEntryRowKey } from '../../../plugins/triage/src/projection/listWindow';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryResultV1Schema } from '../../../plugins/triage/src/actions/reobserveEntryProtocol';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema } from '../../../plugins/triage/src/actions/entryDetailProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { createServerLightDatabaseClient } from '../../src/testkit/process/serverLightDatabase';
import { startHttpRequestRecordingProxy } from '../../src/testkit/httpRequestRecordingProxy';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-sources-reads' });
const sentryService = { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONNECTED_ACCOUNT_ID };
const posthogService = { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE };
const tokens = { us: 'constructed-sentry-us-read-token', usSecond: 'constructed-sentry-us-second-read-token', de: 'constructed-sentry-de-read-token', posthog: 'constructed-posthog-read-token', gitlab: 'constructed-gitlab-read-token', bitbucket: 'constructed-bitbucket-read-token', azure: 'constructed-azure-read-token' };
const fingerprint = (token: string) => `sha256:${createHash('sha256').update(token).digest('hex')}`;
const providerHosts = ['us.sentry.io', 'de.sentry.io', 'eu.posthog.com', 'gitlab.com', 'api.bitbucket.org', 'dev.azure.com'];
const canary = 'unapproved-raw-provider-canary';

it('reads five external sources with exact Account bindings and pages a 500+3 source window through local lenses', async () => {
  const testDir = run.testDir(randomUUID());
  const homeDir = join(testDir, 'daemon-home');
  const cleanup: Array<() => void | Promise<void>> = [];
  let sentryStatus = 200;
  let sentryDeniedFingerprint: string | null = null;
  let boundsMode = false;
  let catalogMode = false;
  let nativeCursorBoundaryMode = false;
  const nativeCursorExchanges: Array<{ organizationId: string; requestedCursor: string | null;
    nextCursor: string | null; cursorBytes: number; headerBytes: number }> = [];
  const catalogOrganizations = Array.from({ length: MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1 },
    (_, index) => ({ ...sentryOrganizations.body[0], id: String(880_000 + index),
      slug: `bounds-org-${index}`, name: `Bounds organization ${index}` }));
  let forgeIdentityMismatch: string | null = null;
  let readOnlyWindow = false;
  const rejectedPosthogToken = 'constructed-posthog-rejected-token';
  let confirmedRejectedPosthogToken = false;
  const readWindowWrites: Array<{ method: string; path: string }> = [];
  const listResultUtf8Bytes: number[] = [];
  try {
    const proxy = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: providerHosts,
      responseForRequest(request) {
        const host = request.connectTarget.split(':')[0];
        const url = new URL(request.path, `https://${host}`);
        if (host === 'us.sentry.io' || host === 'de.sentry.io') {
          const origin = url.origin;
          const headers = { link: `<${origin}${url.pathname}>; rel="next"; results="false"` };
          if (url.pathname === '/api/0/organizations/') return { statusCode: 200, headers,
            body: (catalogMode ? catalogOrganizations : sentryOrganizations.body).map(row => ({ ...row, links: { ...row.links, regionUrl: origin } })) };
          if (sentryStatus !== 200 || request.authorizationFingerprint === sentryDeniedFingerprint) return {
            statusCode: sentryStatus === 200 ? 403 : sentryStatus, body: { detail: 'Constructed provider refusal' } };
          const catalogOrganizationId = /^\/api\/0\/organizations\/(\d+)\/issues\/$/.exec(url.pathname)?.[1];
          if (catalogMode && catalogOrganizationId !== undefined
            && catalogOrganizations.some(row => row.id === catalogOrganizationId)) {
            const offset = Number(url.searchParams.get('cursor')?.split(':')[1] ?? '0');
            const limit = Number(url.searchParams.get('limit'));
            if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
              return { statusCode: 400, body: { detail: 'Invalid fixture paging geometry' } };
            }
            const total = 3;
            const nextOffset = Math.min(offset + limit, total);
            const body = Array.from({ length: nextOffset - offset }, (_, index) => {
              const position = offset + index;
              const id = String(7_000_000 + position);
              return { ...sentryPage.body[0], id,
                title: `catalog ${catalogOrganizationId} position ${position}`,
                lastSeen: new Date(Date.UTC(2026, 7, 14) - position * 1_000).toISOString(),
                permalink: `${origin}/issues/${id}/` };
            });
            let cursor = `1755000000000:${nextOffset}:0`;
            const next = new URL(url);
            next.searchParams.set('cursor', cursor);
            let link = `<${next.href}>; rel="next"; results="${nextOffset < total}"; cursor="${cursor}"`;
            if (!nativeCursorBoundaryMode) return { statusCode: 200, headers: { link }, body };
            // Undici's real native HTTP parser counts header names and values,
            // rejects >= node:http.maxHeaderSize, and owns this transport bound.
            // Fix the ordinary response metadata so one extra zero in this
            // numeric cursor would cross that boundary in the two-copy Link.
            // This is the maximum for THIS fixture header layout, not a Sentry
            // cursor quota or the protocol's much larger token-byte ceiling.
            const fixedHeaders = { 'content-type': 'application/json',
              date: 'Fri, 14 Aug 2026 00:00:00 GMT', connection: 'close',
              'content-length': String(Buffer.byteLength(JSON.stringify(body), 'utf8')) };
            const fixedBytes = Object.entries({ ...fixedHeaders, link }).reduce((sum, [name, value]) =>
              sum + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8'), 0);
            const padding = Math.floor((maxHeaderSize - 1 - fixedBytes) / 2);
            cursor = `${'0'.repeat(padding)}${cursor}`;
            next.searchParams.set('cursor', cursor);
            link = `<${next.href}>; rel="next"; results="${nextOffset < total}"; cursor="${cursor}"`;
            nativeCursorExchanges.push({ organizationId: catalogOrganizationId,
              requestedCursor: url.searchParams.get('cursor'), nextCursor: nextOffset < total ? cursor : null,
              cursorBytes: Buffer.byteLength(cursor, 'utf8'), headerBytes: fixedBytes + padding * 2 });
            return { statusCode: 200, headers: { ...fixedHeaders, link }, body };
          }
          if (boundsMode && url.pathname === '/api/0/organizations/7701/issues/') {
            // QB86's external source specimens: one deep lane and one shallow
            // lane. The real Sentry decoder and scan own every observation.
            const total = host === 'us.sentry.io' ? 500 : 3;
            const offset = Number(url.searchParams.get('cursor')?.split(':')[1] ?? '0');
            const limit = Number(url.searchParams.get('limit'));
            if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
              return { statusCode: 400, body: { detail: 'Invalid fixture paging geometry' } };
            }
            const nextOffset = Math.min(offset + limit, total);
            const cursor = `1755000000000:${nextOffset}:0`;
            const next = new URL(url);
            next.searchParams.set('cursor', cursor);
            return { statusCode: 200,
              headers: { link: `<${next.href}>; rel="next"; results="${nextOffset < total}"; cursor="${cursor}"` },
              body: Array.from({ length: nextOffset - offset }, (_, index) => {
                const position = offset + index;
                const id = String(6_500_000 + position);
                return { ...sentryPage.body[0], id,
                  title: position === total - 1 ? `${host} bounds tail` : `${host} bounds row ${position}`,
                  lastSeen: new Date(Date.UTC(2026, 7, 14) - position * 1_000).toISOString(),
                  permalink: `${origin}/issues/${id}/` };
              }),
            };
          }
          if (url.pathname === '/api/0/organizations/7701/issues/') return { statusCode: 200, headers,
            body: [{ ...sentryPage.body[0], title: `${host} issue` }] };
          if (url.pathname === `/api/0/organizations/7701/issues/${sentryIssue.body.id}/`) return { statusCode: 200,
            body: { ...sentryIssue.body, title: `${host} issue` } };
          if (url.pathname.includes('/events/')) return { statusCode: 200, body: {
            eventID: 'a'.repeat(32), groupID: sentryIssue.body.id,
            dateCreated: '2026-08-14T07:55:10.000Z', title: 'Projected exception',
            formatted: canary, request: { data: canary, headers: [['authorization', canary]], cookies: [['session', canary]] },
            contexts: { private: canary }, tags: [{ key: 'environment', value: 'production', unexpected: canary }],
            user: { id: '7', email: canary, unexpected: canary },
            _meta: { user: { email: { '': { rem: [['@email', 's', 0, canary.length]] } } } },
            entries: [{ type: 'exception', data: { values: [{ type: 'TypeError', value: 'Projected exception',
              stacktrace: { frames: [{ filename: 'src/checkout.ts', function: 'checkout', lineNo: 42, inApp: true, vars: { secret: canary } }] } }] } },
              { type: 'unsupported-private-section', data: { secret: canary } }],
          } };
        }
        if (host === 'eu.posthog.com') {
          if (url.pathname === '/api/organizations/' && request.authorizationFingerprint === fingerprint(rejectedPosthogToken)) {
            if (confirmedRejectedPosthogToken) return { statusCode: 403, body: { detail: 'Constructed credential refusal' } };
            confirmedRejectedPosthogToken = true;
          }
          if (url.pathname === '/api/organizations/') return { statusCode: 200, body: { ...posthogOrganizations, count: 1, next: null } };
          if (url.pathname.endsWith('/projects/')) return { statusCode: 200,
            body: { ...posthogProjects, count: 1, next: null, results: [posthogProjects.results[0]] } };
          if (url.pathname.endsWith('/query/issues/')) return { statusCode: 200,
            body: { ...posthogPage, results: [posthogPage.results[0]], hasMore: false, nextOffset: null } };
          if (url.pathname.endsWith(`/issues/${posthogIssue.id}/`)) return { statusCode: 200, body: posthogIssue };
          if (url.pathname.endsWith('/query/issue/')) return { statusCode: 200, body: posthogDetail };
          if (url.pathname.endsWith('/query/issue_events/')) return { statusCode: 200, body: {
            ...posthogEvents, hasMore: false, nextOffset: null,
            results: posthogEvents.results.map(row => ({ ...row, distinct_id: canary,
              properties: { ...row.properties, internal_customer_note: canary, $email: canary, $ip: canary } })),
          } };
        }
        if (host === 'gitlab.com') {
          if (url.pathname === '/api/v4/user') return { statusCode: 200, body: { id: 1, username: 'example-user' } };
          if (url.pathname.endsWith('/merge_requests/7')) return { statusCode: 200,
            body: { ...gitlabMergeRequests[0], ...(forgeIdentityMismatch === host ? { project_id: 999 } : {}) } };
          if (url.pathname === '/api/v4/merge_requests') return { statusCode: 200,
            body: url.searchParams.get('scope') === 'created_by_me' ? [gitlabMergeRequests[0]] : [] };
          if (url.pathname === '/api/v4/issues' || url.pathname.endsWith('/pipelines')) return { statusCode: 200, body: [] };
        }
        if (host === 'api.bitbucket.org') {
          if (url.pathname === '/2.0/user') return { statusCode: 200, body: bitbucketUser };
          if (url.pathname === '/2.0/user/workspaces') return { statusCode: 200,
            body: { ...bitbucketWorkspaces, size: 1, values: [bitbucketWorkspaces.values[0]] } };
          if (url.pathname.endsWith('/pullrequests/42')) {
            const body = structuredClone(bitbucketPullRequest);
            if (forgeIdentityMismatch === host) {
              body.source.repository.uuid = '{2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901}';
              body.destination.repository.uuid = '{2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901}';
            }
            return { statusCode: 200, body };
          }
          if (url.pathname.includes('/pullrequests')) return { statusCode: 200,
            body: { pagelen: 10, page: 1, values: url.pathname.endsWith('/statuses') ? [] : [bitbucketPullRequest] } };
          if (url.pathname.startsWith('/2.0/repositories/')) return { statusCode: 200,
            body: { ...bitbucketRepositories, values: [bitbucketRepositories.values[0]] } };
        }
        if (host === 'dev.azure.com') {
          if (url.pathname.endsWith('/_apis/connectionData')) return { statusCode: 200, body: azureConnection };
          if (url.pathname.endsWith('/_apis/projects')) return { statusCode: 200, body: azureProjects };
          if (url.pathname.endsWith('/_apis/git/repositories')) return { statusCode: 200,
            body: { count: 1, value: [azurePullRequests.value[0]!.repository] } };
          if (/\/pullrequests\/22$/iu.test(url.pathname)) return { statusCode: 200,
            body: { ...azurePullRequests.value[0], ...(forgeIdentityMismatch === host ? {
              repository: { ...azurePullRequests.value[0]!.repository, id: 'f4b7c210-55ae-4d31-8a6c-2b90d5e1c773' },
            } : {}) } };
          if (/\/pullrequests$/iu.test(url.pathname)) return { statusCode: 200,
            body: { count: 1, value: [azurePullRequests.value[0]] } };
        }
        return { statusCode: 404, body: { error: 'unrecognized-provider-fixture-route' } };
      } });
    cleanup.push(() => proxy.stop());
    // Provider clients execute real HTTP over TLS through the recording CONNECT
    // proxy, which replaces only the third-party service boundary.
    const requireCli = createRequire(join(repoRootDir(), 'apps/cli/package.json'));
    type HttpBoundary = { fetch: typeof fetch; ProxyAgent: new (input: { uri: string; requestTls: { ca: Buffer } }) => { close(): Promise<void> } };
    const undici: HttpBoundary = requireCli('undici/index.js'); // The untyped third-party HTTP adapter is isolated here.
    const dispatcher = new undici.ProxyAgent({ uri: proxy.url, requestTls: { ca: await readFile(proxy.caCertPath) } });
    cleanup.push(() => dispatcher.close());
    const originalFetch = globalThis.fetch;
    const originalUndiciFetch = undici.fetch;
    const external = (input: Parameters<typeof fetch>[0]) => providerHosts.includes(new URL(
      typeof input === 'object' && 'url' in input ? input.url : String(input)).hostname);
    const proxyFetch: typeof fetch = (input, init) => originalUndiciFetch(input,
      { ...init, dispatcher } as RequestInit); // Undici's public dispatcher extends the platform RequestInit.
    globalThis.fetch = (input, init) => external(input) ? proxyFetch(input, init) : originalFetch(input, init);
    undici.fetch = (input, init) => external(input) ? proxyFetch(input, init) : originalUndiciFetch(input, init);
    cleanup.push(() => { globalThis.fetch = originalFetch; undici.fetch = originalUndiciFetch; });
    const preloadPath = join(testDir, 'provider-tls-preload.mjs');
    await writeFile(preloadPath, `import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const requireCli = createRequire(${JSON.stringify(join(repoRootDir(), 'apps/cli/package.json'))});
const undici = requireCli('undici/index.js');
const dispatcher = new undici.ProxyAgent({ uri: ${JSON.stringify(proxy.url)}, requestTls: { ca: await readFile(${JSON.stringify(proxy.caCertPath)}) } });
const originalFetch = globalThis.fetch;
const originalUndiciFetch = undici.fetch;
const external = input => ${JSON.stringify(providerHosts)}.includes(new URL(typeof input === 'object' && 'url' in input ? input.url : String(input)).hostname);
undici.fetch = (input, init) => originalUndiciFetch(input, external(input) ? { ...init, dispatcher } : init);
globalThis.fetch = (input, init) => external(input) ? originalUndiciFetch(input, { ...init, dispatcher }) : originalFetch(input, init);
`);
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href, '--import', pathToFileURL(preloadPath).href].filter(Boolean).join(' ');
    const server = await startServerLight({ testDir, dbProvider: 'postgres', extraEnv: { NODE_OPTIONS: sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
    cleanup.push(() => server.stop());
    const auth = await createTestAuth(server.baseUrl);
    await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    const daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
      ...process.env, NODE_OPTIONS: sourceOptions, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } });
    cleanup.push(() => daemon.stop());
    const accountProxy = await startHttpRequestRecordingProxy({ targetBaseUrl: server.baseUrl,
      onRequestStart(request) {
        const path = new URL(request.path, server.baseUrl).pathname;
        if (readOnlyWindow && (path === PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1
          || (request.method === 'POST' && path.startsWith('/v1/account/plugin-storage/')))) {
          readWindowWrites.push({ method: request.method, path });
          throw new Error('Read-only source journey attempted a durable Account write');
        }
      },
    });
    cleanup.push(() => accountProxy.stop());
    if (!server.databaseUrl) throw new Error('Source-read fixture omitted PostgreSQL URL');
    const database = await createServerLightDatabaseClient('postgres', server.databaseUrl);
    cleanup.push(() => database.$disconnect());
    const accountId = readAccountIdFromToken(auth.token);
    if (!accountId) throw new Error('Source-read fixture omitted Account identity');
    // Physical Account snapshots catch writes from the daemon that would bypass
    // the UI recording socket. Deliberate connection/configuration writes occur
    // before each snapshot window. No independent daemon-local storage claim.
    const durableSnapshot = () => database.$queryRawUnsafe(`
      SELECT jsonb_build_object(
        'kv', (SELECT COALESCE(jsonb_agg(to_jsonb(k) ORDER BY k.key), '[]'::jsonb)
          FROM "UserKVStore" k WHERE k."accountId" = $1),
        'rows', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r."pluginId", r."collectionId", r."rowId"), '[]'::jsonb)
          FROM "PluginCollectionRow" r WHERE r."accountId" = $1),
        'projections', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p."pluginId", p."collectionId", p."rowId", p."fieldId"), '[]'::jsonb)
          FROM "PluginCollectionProjection" p WHERE p."accountId" = $1),
        'indexStates', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
          FROM "PluginCollectionIndexState" s WHERE s."accountId" = $1),
        'indexEntries', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e."indexStateId", e."rowId"), '[]'::jsonb)
          FROM "PluginCollectionIndexEntry" e JOIN "PluginCollectionIndexState" s ON s.id = e."indexStateId"
          WHERE s."accountId" = $1),
        'relations', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb)
          FROM "PluginCollectionRelation" l WHERE l."accountId" = $1)) AS snapshot;
    `, accountId);
    const client = await connectUiTriageActionClient({ serverUrl: accountProxy.baseUrl,
      addressAnchorUrl: server.baseUrl, accountSecret: auth.accountSigningSeed,
      additionalPlugins: [{ packageName: sentryPackage.name, manifest: sentryManifest, activate: activateSentry }, { packageName: posthogPackage.name, manifest: posthogManifest, activate: activatePosthog },
        { packageName: gitlabPackage.name, manifest: GITLAB_PLUGIN.manifest, activate: activateGitlab }, { packageName: bitbucketPackage.name, manifest: BITBUCKET_PLUGIN.manifest, activate: activateBitbucket },
        { packageName: azurePackage.name, manifest: AZURE_DEVOPS_PLUGIN.manifest, activate: activateAzure }] });
    cleanup.push(() => client.close());
    await waitFor(() => client.isAccountReady(), { context: 'source-read Account readiness' });
    // Call-through observers on the physical Machine transports establish that
    // these native Account source legs never send provider rows to the daemon.
    const machineTransport = await client.observeMachineTransport();
    cleanup.push(machineTransport.dispose);
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: client.serverId };
    const invoke = async (pluginId: string, localId: string, input: unknown) => {
      const result = await client.executeConfirmed('action.invoke', { action: { pluginId, localId }, input }, context);
      expect(result, JSON.stringify({ action: { pluginId, localId }, result })).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`Source read Action ${pluginId}/${localId} refused (${result.errorCode})`);
      if (pluginId === 'happier.triage' && localId === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        // This native Account path enforces the targeted result schema, not an
        // external-Action transport envelope. Record its real return bytes only.
        listResultUtf8Bytes.push(Buffer.byteLength(JSON.stringify(result), 'utf8'));
      }
      return result.result;
    };
    const connect = async (service: QualifiedConnectedAccountRef['service'], modeId: string,
      values: Record<string, string>, fields: Record<string, string>) => {
      const begun = await client.executeConfirmed('connectedServices.authentication.beginConnect', { service, modeId }, context);
      expect(begun, JSON.stringify(begun)).toMatchObject({ ok: true });
      if (!begun.ok) throw new Error(`Source connection refused (${begun.errorCode})`);
      const attempt = connectionOutputs['connectedServices.authentication.beginConnect'].parse(begun.result);
      expect(attempt).toMatchObject({ status: Object.keys(values).length ? 'configurationRequired' : 'awaitingManual', attemptId: expect.any(String) });
      if ((attempt.status !== 'configurationRequired' && attempt.status !== 'awaitingManual') || !attempt.attemptId) throw new Error('Missing fresh source configuration attempt');
      if (attempt.status === 'configurationRequired') {
        const replacement = await client.executeConfirmed('connectedServices.configuration.replace', {
        target: { kind: 'attempt', attemptId: attempt.attemptId }, expectedRevision: null, values, secretValues: {},
      }, context);
      expect(replacement, JSON.stringify(replacement)).toMatchObject({ ok: true });
      if (!replacement.ok) throw new Error(`Source configuration refused (${replacement.errorCode})`);
      const committed = connectionOutputs['connectedServices.configuration.replace'].parse(replacement.result);
      expect(await client.executeConfirmed('connectedServices.authentication.continueConnect', {
        attemptId: attempt.attemptId, expectedConfigurationRevision: committed.revision,
      }, context)).toMatchObject({ ok: true, result: { status: 'awaitingManual' } });
      }
      const submitted = await client.executeConfirmed('connectedServices.authentication.submitManual', { attemptId: attempt.attemptId, fields }, context);
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true, result: { status: 'connected' } });
      if (!submitted.ok) throw new Error(`Source credential submission refused (${submitted.errorCode})`);
      const connected = connectionOutputs['connectedServices.authentication.submitManual'].parse(submitted.result);
      if (connected.status !== 'connected') throw new Error(`Source connection did not complete (${connected.status})`);
      // Purpose admission reads the subscribed Account profile. The submitted
      // credential's effect can settle before that profile reaches this client.
      await client.waitForConnectedAccountProfile(connected.account);
      return connected.account;
    };
    const us = await connect(sentryService, SENTRY_CLOUD_MODE_ID, { [SENTRY_REGION_CONFIGURATION_FIELD]: 'us' }, { [SENTRY_TOKEN_CREDENTIAL_KEY]: tokens.us });
    const usSecond = await connect(sentryService, SENTRY_CLOUD_MODE_ID, { [SENTRY_REGION_CONFIGURATION_FIELD]: 'us' }, { [SENTRY_TOKEN_CREDENTIAL_KEY]: tokens.usSecond });
    const de = await connect(sentryService, SENTRY_CLOUD_MODE_ID, { [SENTRY_REGION_CONFIGURATION_FIELD]: 'de' }, { [SENTRY_TOKEN_CREDENTIAL_KEY]: tokens.de });
    const ph = await connect(posthogService, POSTHOG_PERSONAL_API_KEY_MODE_ID, { [POSTHOG_API_ORIGIN_FIELD_ID]: 'https://eu.posthog.com' }, { [POSTHOG_PERSONAL_API_KEY_FIELD_ID]: tokens.posthog });

    const selectDiscovery = async (pluginId: string, localId: string, purpose: string, accounts: readonly QualifiedConnectedAccountRef[]) => {
      const service = accounts[0]!.service;
      const groupId = `source-reads-${randomUUID()}`;
      const created = await client.executeConfirmed('connectedServices.pools.create', { service, group: { groupId } }, context);
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
      if (!created.ok) throw new Error(`Source Account pool refused (${created.errorCode})`);
      let group = connectionOutputs['connectedServices.pools.create'].parse(created.result).group;
      for (const account of accounts) {
        const added = await client.executeConfirmed('connectedServices.pools.members.add', {
          group: { service, groupId }, expectedGeneration: group.generation,
          expectedIncarnation: group.incarnation, connectedAccountId: account.accountId,
        }, context);
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
        if (!added.ok) throw new Error(`Source Account pool member refused (${added.errorCode})`);
        group = connectionOutputs['connectedServices.pools.members.add'].parse(added.result).group;
      }
      // Adding a member does not choose it. Purpose admission requires an
      // active usable member; discovery can then enumerate the whole pool.
      const groupRef = { service, groupId };
      const activeMemberId = accounts[0]!.accountId;
      const activated = await client.executeConfirmed('connectedServices.pools.switchNow', {
        group: groupRef, expectedGeneration: group.generation,
        expectedIncarnation: group.incarnation, expectedRuntimeStateRevision: group.runtimeStateRevision,
        connectedAccountId: activeMemberId,
      }, context);
      expect(activated).toMatchObject({ ok: true });
      // The chooser reads the Account profile after the pool update is published.
      await waitFor(() => client.readConnectedAccountPoolActiveMember(groupRef) === activeMemberId,
        { context: 'source-discovery pool selection appears in the Account profile' });
      const selection = await client.executeConfirmed('connectedServices.purposes.default.set', {
        purpose: { consumer: { pluginId, localId }, purpose }, target: { kind: 'group', ...groupRef },
      }, context);
      expect(selection.ok, selection.ok ? undefined : `${pluginId}: ${selection.errorCode}`).toBe(true);
    };
    await selectDiscovery(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.listInstances, SENTRY_CONNECTED_ACCOUNT_PURPOSE, [us, usSecond, de]);
    await selectDiscovery(POSTHOG_PLUGIN_ID, POSTHOG_ACTION_IDS.listInstances, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, [ph]);
    proxy.clear();
    const sentryDiscovery = TriageListInstancesResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.listInstances, { v: 1 }));
    expect(sentryDiscovery).toMatchObject({ kind: 'complete', failures: [] });
    if (sentryDiscovery.kind === 'failed') throw new Error('Sentry discovery failed');
    expect(sentryDiscovery.candidates.map(candidate => 'account' in candidate.binding ? candidate.binding.account.accountId : null).sort())
      .toEqual([us.accountId, usSecond.accountId, de.accountId].sort());
    expect(sentryDiscovery.candidates.map(candidate => candidate.localInstanceKey).sort()).toEqual([
      `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`, `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`, `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
    ].sort());
    expect(new Set(proxy.entries().map(row => row.authorizationFingerprint))).toEqual(new Set([tokens.us, tokens.usSecond, tokens.de].map(fingerprint)));
    const phDiscovery = TriageListInstancesResultV1Schema.parse(await invoke(POSTHOG_PLUGIN_ID, POSTHOG_ACTION_IDS.listInstances, { v: 1 }));
    expect(phDiscovery).toMatchObject({ kind: 'complete', failures: [], candidates: [{ binding: { account: ph } }] });
    if (phDiscovery.kind === 'failed') throw new Error('PostHog discovery failed');

    // Connect succeeds, then PostHog refuses the same credential during the daemon's status check.
    const rejectedPosthog = await connect(posthogService, POSTHOG_PERSONAL_API_KEY_MODE_ID,
      { [POSTHOG_API_ORIGIN_FIELD_ID]: 'https://eu.posthog.com' }, { [POSTHOG_PERSONAL_API_KEY_FIELD_ID]: rejectedPosthogToken });
    const query = new URLSearchParams({
      service: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, posthogService),
    });
    const readRejectedProfile = async () => {
      const response = await fetch(`${server.baseUrl}/v4/connect/qualified/accounts?${query}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      expect(response.ok).toBe(true);
      return QualifiedConnectedAccountListResponseV4Schema.parse(await response.json()).accounts
        .find(profile => profile.ref.accountId === rejectedPosthog.accountId);
    };
    await waitFor(async () => (await readRejectedProfile())?.status === 'needs_reauth',
      { context: 'PostHog status rejection published by the daemon' });
    expect(await readRejectedProfile()).toMatchObject({
      status: 'needs_reauth', configurationReady: true, statusReason: 'provider_403', providerHttpStatus: 403,
    });
    console.info('POSTHOG_REAUTH_LISTING_VERIFIED');

    const configure = async (pluginId: string, sourceId: string, draft: TriageSourceInstanceDraftV1) => {
      const source = { pluginId, localId: sourceId };
      const administered = TriageSourceAdministrationActionResultV1Schema.parse(await invoke('happier.triage',
        TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, { v: 1, kind: 'create', source, draft }));
      expect(administered).toMatchObject({ kind: 'active' });
      if (administered.kind !== 'active') throw new Error(`Source configuration did not activate (${administered.kind})`);
      const read = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke('happier.triage',
        TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1, source }));
      if (read.kind !== 'read') throw new Error(`Configured source read refused (${read.kind})`);
      const configured = read.instances.find(row => row.configured.instance.sourceInstanceId === administered.sourceInstanceId)?.configured;
      if (!configured) throw new Error('Configured source was not persisted');
      expect(configured.binding).toEqual(draft.binding);
      return TriageConfiguredSourceConnectedAccountInstanceV1Schema.parse(configured);
    };
    const sentryInstances: TriageConfiguredSourceConnectedAccountInstanceV1[] = [];
    for (const draft of sentryDiscovery.candidates) sentryInstances.push(await configure(SENTRY_PLUGIN_ID, 'sentry-issues', draft));
    const posthogInstance = await configure(POSTHOG_PLUGIN_ID, 'posthog-error-tracking', phDiscovery.candidates[0]!);
    const listed = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage', TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
      { v: 1, sources: { kind: 'allConfigured' }, limit: 20, order: 'newest' }));
    expect(listed.window.coverage).toBe('complete');
    expect(listed.window.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryRef: expect.objectContaining({ source: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-issues' } }) }),
      expect.objectContaining({ entryRef: expect.objectContaining({ source: { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-error-tracking' } }) }),
    ]));
    const sentryRows = listed.window.rows.filter(row => row.entryRef.source.pluginId === SENTRY_PLUGIN_ID);
    expect(sentryRows).toHaveLength(2);
    expect(sentryRows.find(row => row.entryRef.collisionScope === `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`))
      .toMatchObject({ observedByCount: 2, otherObservations: [expect.any(Object)] });
    expect(sentryRows.find(row => row.entryRef.collisionScope === `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`))
      .toMatchObject({ observedByCount: 1, otherObservations: [] });
    // Two US credentials yield two observations of one identity, while DE is distinct.
    const sentryRefs: unknown[] = [];
    for (const instance of sentryInstances) {
      const scan = TriageScanResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.scan,
        { v: 1, instance, page: { kind: 'initial', limit: 10 } }));
      expect(scan).toMatchObject({ kind: 'complete', observations: [{ kind: 'present' }] });
      if (scan.kind === 'failed' || !scan.observations[0]) throw new Error('Sentry scan did not materialize the issue');
      const localRef = scan.observations[0].localRef;
      sentryRefs.push(localRef);
      proxy.clear();
      const present = TriageGetResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.get, { v: 1, instance, localRef }));
      expect(present).toMatchObject({ kind: 'present', localRef, snapshot: { title: `${new URL(instance.localInstanceKey.split(SENTRY_SCOPE_SEPARATOR)[0]!).hostname} issue` } });
      const entryRef = { source: instance.instance.source, ...localRef };
      const selection = { v: 1, entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
      expect(TriageReadEntryDetailResultV1Schema.parse(await invoke('happier.triage', TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, selection)))
        .toMatchObject({ kind: 'read', instance, linkedSessions: [] });
      expect(TriageReobserveEntryResultV1Schema.parse(await invoke('happier.triage', TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, selection)))
        .toMatchObject({ kind: 'observed', entryRef, observation: { sourceInstanceId: instance.instance.sourceInstanceId, outcome: { kind: 'present' } } });
      const token = instance.binding.account.accountId === us.accountId ? tokens.us : instance.binding.account.accountId === usSecond.accountId ? tokens.usSecond : tokens.de;
      sentryStatus = 403;
      expect(TriageGetResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.get, { v: 1, instance, localRef })))
        .toMatchObject({ kind: 'unresolved', localRef, failure: { class: 'permission' } });
      sentryStatus = 200;
      expect(TriageGetResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.get, { v: 1, instance, localRef })))
        .toMatchObject({ kind: 'present', localRef });
      expect(new Set(proxy.entries().map(row => row.authorizationFingerprint))).toEqual(new Set([fingerprint(token)]));
      expect(new Set(proxy.entries().map(row => row.connectTarget))).toEqual(new Set([`${new URL(instance.localInstanceKey.split(SENTRY_SCOPE_SEPARATOR)[0]!).hostname}:443`]));
    }
    const usRefs = sentryRefs.filter(ref => ref && typeof ref === 'object' && 'collisionScope' in ref && ref.collisionScope === `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`);
    expect(usRefs).toHaveLength(2);
    expect(usRefs[0]).toEqual(usRefs[1]);
    const usInstance = sentryInstances.find(instance => instance.binding.account.accountId === us.accountId)!;
    const sentryRef = { kindId: 'error-issue', collisionScope: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`, entryId: sentryIssue.body.id };
    proxy.clear();
    const projected = SentryReadEventResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.readEvent,
      { v: 1, instance: usInstance, localRef: sentryRef, selector: { kind: 'representative' } }));
    expect(projected, projected.kind === 'unavailable' ? projected.failure.code : undefined)
      .toMatchObject({ kind: 'event', projection: { eventId: 'a'.repeat(32), sections: [
        expect.objectContaining({ kind: 'exception' }),
        { kind: 'unsupported', entryType: 'unsupported-private-section' },
      ] } });
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(new Set(proxy.entries().map(row => row.authorizationFingerprint))).toEqual(new Set([fingerprint(tokens.us)]));
    expect(new Set(proxy.entries().map(row => row.connectTarget))).toEqual(new Set(['us.sentry.io:443']));

    const phScan = TriageScanResultV1Schema.parse(await invoke(POSTHOG_PLUGIN_ID, POSTHOG_ACTION_IDS.scan,
      { v: 1, instance: posthogInstance, page: { kind: 'initial', limit: 10 } }));
    expect(phScan).toMatchObject({ kind: 'complete', observations: [{ kind: 'present' }] });
    if (phScan.kind === 'failed' || !phScan.observations[0]) throw new Error('PostHog scan did not materialize the issue');
    const phRef = phScan.observations[0].localRef;
    expect(phRef).toEqual({ kindId: 'error-issue', collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1', entryId: posthogIssue.id });
    proxy.clear();
    const phGet = TriageGetResultV1Schema.parse(await invoke(POSTHOG_PLUGIN_ID, POSTHOG_ACTION_IDS.get,
      { v: 1, instance: posthogInstance, localRef: phRef }));
    expect(phGet).toMatchObject({ kind: 'present', localRef: phRef, snapshot: { title: posthogIssue.description } });
    const phEntryRef = { source: posthogInstance.instance.source, ...phRef };
    const phSelection = { v: 1, entryRef: phEntryRef, sourceInstanceId: posthogInstance.instance.sourceInstanceId };
    expect(TriageReadEntryDetailResultV1Schema.parse(await invoke('happier.triage', TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, phSelection)))
      .toMatchObject({ kind: 'read', instance: posthogInstance, linkedSessions: [] });
    expect(TriageReobserveEntryResultV1Schema.parse(await invoke('happier.triage', TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, phSelection)))
      .toMatchObject({ kind: 'observed', entryRef: phEntryRef, observation: { sourceInstanceId: posthogInstance.instance.sourceInstanceId, outcome: { kind: 'present' } } });
    const samples = PosthogSampledEventsResultV1Schema.parse(await invoke(POSTHOG_PLUGIN_ID, POSTHOG_ACTION_IDS.issueEvents,
      { v: 1, instance: posthogInstance, localRef: phRef, limit: 3 }));
    expect(samples).toMatchObject({ kind: 'sampled', events: [expect.objectContaining({ uuid: posthogEvents.results[0]!.uuid }), expect.any(Object), expect.any(Object)] });
    expect(JSON.stringify(samples)).not.toContain(canary);
    expect(JSON.stringify(samples)).not.toContain('must-not-survive');
    expect(new Set(proxy.entries().map(row => row.authorizationFingerprint))).toEqual(new Set([fingerprint(tokens.posthog)]));
    expect(new Set(proxy.entries().map(row => row.connectTarget))).toEqual(new Set(['eu.posthog.com:443']));
    const eventRequest = proxy.entries().find(row => row.path.includes('/query/issue_events/'));
    expect(eventRequest).toBeDefined();
    expect(JSON.parse(eventRequest!.body)).toMatchObject({ include: [...POSTHOG_ISSUE_EVENTS_INCLUDE] });

    const gl = await connect({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_CONNECTED_ACCOUNT_ID },
      GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID, { [GITLAB_ORIGIN_CONFIGURATION_FIELD]: 'https://gitlab.com' },
      { [GITLAB_TOKEN_CREDENTIAL_KEY]: tokens.gitlab });
    const bbIdentity = 'fixture-reader@example.invalid';
    const bb = await connect({ pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID },
      'manual', {}, { identity: bbIdentity, token: tokens.bitbucket });
    const azure = await connect({ pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID },
      AZURE_DEVOPS_MANUAL_MODE_ID, { [AZURE_DEVOPS_BASE_CONFIGURATION_FIELD]: 'https://dev.azure.com/exampleorg' },
      { token: tokens.azure });
    const forgeCases = [
      { pluginId: GITLAB_PLUGIN_ID, sourceId: GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID, actions: GITLAB_TRIAGE_ACTION_IDS,
        purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: gl, host: 'gitlab.com', authorization: tokens.gitlab,
        repository: { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example-group/example-subgroup/example-project' },
        expectedRef: { kindId: 'merge-request', collisionScope: 'gitlab:aHR0cHM6Ly9naXRsYWIuY29t:3', entryId: '7' }, title: gitlabMergeRequests[0]!.title },
      { pluginId: BITBUCKET_PLUGIN_ID, sourceId: BITBUCKET_TRIAGE_CONTRIBUTION_ID, actions: BITBUCKET_TRIAGE_ACTION_IDS,
        purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: bb, host: 'api.bitbucket.org',
        authorization: `Basic ${Buffer.from(`${bbIdentity}:${tokens.bitbucket}`).toString('base64')}`,
        repository: { kind: 'bitbucket', deployment: 'https://bitbucket.org', repository: bitbucketPullRequest.destination.repository.full_name },
        expectedRef: { kindId: 'pull-request', collisionScope: 'bitbucket:{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}', entryId: '42' }, title: bitbucketPullRequest.title },
      { pluginId: AZURE_DEVOPS_PLUGIN_ID, sourceId: AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID, actions: AZURE_DEVOPS_TRIAGE_ACTION_IDS,
        purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: azure, host: 'dev.azure.com', authorization: encodeAzureDevOpsPatAuthorization(tokens.azure),
        repository: { kind: 'azure-devops', deployment: 'https://dev.azure.com/exampleorg', repository: 'exampleorg/Payments/gateway' },
        expectedRef: { kindId: 'pull-request', collisionScope: 'azure-devops:aHR0cHM6Ly9kZXYuYXp1cmUuY29tL2V4YW1wbGVvcmc:5febef5a-833d-4e14-b9c0-14cb638f91e6', entryId: '22' }, title: azurePullRequests.value[0]!.title },
    ];
    for (const sourceCase of forgeCases) {
      await selectDiscovery(sourceCase.pluginId, sourceCase.actions.listInstances, sourceCase.purpose, [sourceCase.account]);
      const discovered = TriageListInstancesResultV1Schema.parse(await invoke(sourceCase.pluginId, sourceCase.actions.listInstances, { v: 1 }));
      expect(discovered, JSON.stringify(discovered)).toMatchObject({ kind: 'complete', failures: [], candidates: [{ binding: { account: sourceCase.account } }] });
      if (discovered.kind === 'failed' || !discovered.candidates[0]) throw new Error('Forge discovery did not produce its bound instance');
      const instance = await configure(sourceCase.pluginId, sourceCase.sourceId, discovered.candidates[0]);
      proxy.clear();
      const scanned = TriageScanResultV1Schema.parse(await invoke(sourceCase.pluginId, sourceCase.actions.scan,
        { v: 1, instance, page: { kind: 'initial', limit: 20 } }));
      if (scanned.kind === 'failed') throw new Error(`${sourceCase.pluginId} scan failed (${scanned.failure.code})`);
      expect(scanned.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'present', localRef: sourceCase.expectedRef }),
      ]));
      if (sourceCase.pluginId === GITLAB_PLUGIN_ID) {
        expect(scanned).toMatchObject({ kind: 'page', evidence: { kind: 'partial', reason: 'lane-unavailable' },
          continuation: { token: expect.any(String) } });
      }
      const observed = scanned.observations.find(row => row.localRef.entryId === sourceCase.expectedRef.entryId);
      if (observed?.kind !== 'present') throw new Error('Forge scan did not materialize its own immutable fixture identity');
      expect(observed.repository).toEqual(sourceCase.repository);
      const localRef = observed.localRef;
      const input = { v: 1, instance, localRef, lastKnownLocator: observed.locator };
      expect(TriageGetResultV1Schema.parse(await invoke(sourceCase.pluginId, sourceCase.actions.get, input)))
        .toMatchObject({ kind: 'present', localRef: sourceCase.expectedRef, snapshot: { title: sourceCase.title }, repository: sourceCase.repository });
      const entryRef = { source: instance.instance.source, ...localRef };
      const selection = { v: 1, entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
      expect(TriageReadEntryDetailResultV1Schema.parse(await invoke('happier.triage', TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, selection)))
        .toMatchObject({ kind: 'read', instance, linkedSessions: [] });
      expect(TriageReobserveEntryResultV1Schema.parse(await invoke('happier.triage', TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
        { ...selection, lastKnownLocator: observed.locator })))
        .toMatchObject({ kind: 'observed', entryRef, observation: { sourceInstanceId: instance.instance.sourceInstanceId,
          outcome: { kind: 'present', snapshot: { title: sourceCase.title }, repository: sourceCase.repository } } });
      // A successful body with another immutable repository/project id cannot replace this entry.
      forgeIdentityMismatch = sourceCase.host;
      expect(TriageGetResultV1Schema.parse(await invoke(sourceCase.pluginId, sourceCase.actions.get, input)))
        .toMatchObject({ kind: 'unresolved', localRef: sourceCase.expectedRef });
      forgeIdentityMismatch = null;
      expect(TriageGetResultV1Schema.parse(await invoke(sourceCase.pluginId, sourceCase.actions.get, input)))
        .toMatchObject({ kind: 'present', localRef: sourceCase.expectedRef, repository: sourceCase.repository });
      expect(new Set(proxy.entries().map(row => row.authorizationFingerprint))).toEqual(new Set([fingerprint(sourceCase.authorization)]));
      expect(new Set(proxy.entries().map(row => row.connectTarget))).toEqual(new Set([`${sourceCase.host}:443`]));
    }
    const mixed = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage', TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
      { v: 1, sources: { kind: 'allConfigured' }, limit: 20, order: 'newest' }));
    expect(mixed.window.coverage).toBe('partial');
    for (const sourceCase of forgeCases) expect(mixed.window.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryRef: { source: { pluginId: sourceCase.pluginId, localId: sourceCase.sourceId }, ...sourceCase.expectedRef },
        observation: expect.objectContaining({ outcome: expect.objectContaining({ kind: 'present', repository: sourceCase.repository }) }) }),
    ]));
    for (const token of Object.values(tokens)) expect(JSON.stringify([listed, projected, phGet, samples, mixed])).not.toContain(token);

    // Source facets project locally. Retire the other constructed connections
    // through their public lifecycle so the acquisition itself is really 500+3.
    // The setup-free Task source stays mounted and empty.
    const retireExternalSourcesExcept = async (keep: ReadonlySet<string>) => {
      const configured = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke('happier.triage',
        TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1 }));
      if (configured.kind !== 'read') throw new Error(`Source inventory refused (${configured.kind})`);
      expect(configured.status).toBe('complete');
      for (const record of configured.instances) {
        const instance = record.configured.instance;
        if (record.lifecycle !== 'active' || !('account' in record.configured.binding)
          || keep.has(instance.sourceInstanceId)) continue;
        expect(TriageSourceAdministrationActionResultV1Schema.parse(await invoke('happier.triage',
          TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, { v: 1, kind: 'remove', source: instance.source,
            sourceInstanceId: instance.sourceInstanceId }))).toMatchObject({ kind: 'removed',
          sourceInstanceId: instance.sourceInstanceId });
      }
    };
    // The forge window is honestly partial even with healthy HTTP. Isolate
    // the Sentry/PostHog lanes before testing a newly failed credential.
    await retireExternalSourcesExcept(new Set([...sentryInstances, posthogInstance]
      .map(instance => instance.instance.sourceInstanceId)));

    // U-AGGREGATE-TRUTH: one failed credential keeps this mount's last good
    // observation while its own typed lane reports the refusal. The other US
    // credential still observes the same identity through its exact binding.
    const aggregateStore = createTriageListWindowStore({ nowMs: Date.now,
      async readEntries(input) {
        return TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
          TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, input));
      },
    });
    const beforeAggregate = await durableSnapshot();
    machineTransport.reset();
    const aggregateDeviceTraps = installDeviceWriteTraps({ asyncStorage: AsyncStorage });
    readOnlyWindow = true;
    try {
      await aggregateStore.refresh('view');
      const initial = aggregateStore.getSnapshot();
      expect(initial.window?.coverage).toBe('complete');
      expect(initial.loadMore).toMatchObject({ kind: 'exhausted' });
      const initialKeys = initial.window!.rows.map(row => triageEntryRowKey(row.entryRef)).sort();
      const usRow = initial.window!.rows.find(row => row.entryRef.collisionScope ===
        `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`)!;
      expect(usRow.observations).toHaveLength(2);
      const previous = usRow.observations.find(observation =>
        observation.sourceInstanceId === usInstance.instance.sourceInstanceId)!;
      expect(previous.outcome.kind).toBe('present');
      sentryDeniedFingerprint = fingerprint(tokens.us);
      proxy.clear();
      await aggregateStore.refresh('manual');
      const failed = aggregateStore.getSnapshot();
      expect(failed.error).toBeUndefined();
      expect(failed.freshness).toBe('stale');
      expect(failed.window?.coverage).toBe('partial');
      expect(failed.window?.rows.map(row => triageEntryRowKey(row.entryRef)).sort()).toEqual(initialKeys);
      expect(failed.window?.lanes.filter(lane => lane.health.kind === 'failed')).toEqual([
        expect.objectContaining({ sourceInstanceId: usInstance.instance.sourceInstanceId,
          exhausted: false, health: { kind: 'failed', failure: expect.objectContaining({ class: 'permission' }) } }),
      ]);
      const retained = failed.window!.rows.find(row => triageEntryRowKey(row.entryRef) === triageEntryRowKey(usRow.entryRef))!;
      expect(retained.observations.find(observation =>
        observation.sourceInstanceId === usInstance.instance.sourceInstanceId)?.outcome).toEqual(previous.outcome);
      expect(proxy.entries().filter(request => request.authorizationFingerprint === fingerprint(tokens.us)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ connectTarget: 'us.sentry.io:443' })]));
      sentryDeniedFingerprint = null;
      await aggregateStore.refresh('manual');
      const recovered = aggregateStore.getSnapshot();
      expect(recovered.window?.coverage).toBe('complete');
      expect(recovered.loadMore).toMatchObject({ kind: 'exhausted' });
      expect(recovered.window?.lanes.some(lane => lane.health.kind === 'failed')).toBe(false);
      expect(recovered.window?.rows.map(row => triageEntryRowKey(row.entryRef)).sort()).toEqual(initialKeys);
      expect(readWindowWrites).toEqual([]);
      expect(await durableSnapshot()).toEqual(beforeAggregate);
      expect(machineTransport.counts()).toEqual({ active: 0, scoped: 0 });
      expect(aggregateDeviceTraps.attempts).toEqual([]);
    } finally {
      readOnlyWindow = false;
      aggregateDeviceTraps.restore();
      sentryDeniedFingerprint = null;
      aggregateStore.dispose();
    }

    // QB86: reuse this journey's actual Account/server/Postgres/daemon wiring.
    // This is a 500+3 reachability proof. The transport batch below uses native
    // short cursors; maximal-token and loaded-browser performance are separate.
    const shallowInstance = sentryInstances.find(instance => instance.binding.account.accountId === de.accountId)!;
    const selectedInstances = [usInstance, shallowInstance];
    await retireExternalSourcesExcept(new Set(selectedInstances.map(instance => instance.instance.sourceInstanceId)));
    const lens = { ...TRIAGE_LIST_DEFAULT_LENS_V1,
      filters: { ...TRIAGE_LIST_DEFAULT_LENS_V1.filters,
        sources: selectedInstances.map(instance => ({ source: instance.instance.source,
          sourceInstanceId: instance.instance.sourceInstanceId })) } };
    const actionInputs: TriageListEntriesInputV1[] = [];
    boundsMode = true;
    proxy.clear();
    const windowStore = createTriageListWindowStore({ lens, nowMs: Date.now,
      async readEntries(input) {
        actionInputs.push(input);
        const page = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
          TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, input));
        expect(page.window.rows.length).toBeLessThanOrEqual(input.limit);
        return page;
      },
    });
    const issueRequests = () => proxy.entries().filter(request => new URL(request.path,
      `https://${request.connectTarget}`).pathname === '/api/0/organizations/7701/issues/');
    const rows = () => windowStore.getSnapshot().window?.rows ?? [];
    const rowKeys = () => rows().map(row => triageEntryRowKey(row.entryRef));
    const beforeBounds = await durableSnapshot();
    machineTransport.reset();
    const boundsDeviceTraps = installDeviceWriteTraps({ asyncStorage: AsyncStorage });
    readOnlyWindow = true;
    try {
      await windowStore.refresh('view');
      expect(windowStore.getSnapshot().error).toBeUndefined();
      expect(windowStore.getSnapshot().window?.coverage).toBe('partial');
      expect(windowStore.getSnapshot().loadMore).toMatchObject({ kind: 'available' });
      expect(rows().filter(row => row.entryRef.collisionScope ===
        `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`)).toHaveLength(3);
      expect(rows().some(row => row.entryRef.collisionScope ===
        `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`)).toBe(true);
      // Both lanes get a slice before the deep lane takes another. The actual
      // HTTPS boundary records the source's retained page geometry.
      const firstRequests = issueRequests();
      expect(firstRequests).toHaveLength(selectedInstances.length);
      expect(new Set(firstRequests.map(request => request.connectTarget)))
        .toEqual(new Set(['us.sentry.io:443', 'de.sentry.io:443']));
      expect(firstRequests.every(request => !new URL(request.path,
        `https://${request.connectTarget}`).searchParams.has('cursor'))).toBe(true);
      const initialKeys = rowKeys();
      const readsBeforeColdTailQuery = actionInputs.length;
      const requestsBeforeColdTailQuery = proxy.entries().length;
      windowStore.setLens({ ...lens, query: 'us.sentry.io bounds tail' });
      expect(rows()).toEqual([]);
      windowStore.setLens(lens);
      expect(rowKeys()).toEqual(initialKeys);
      expect(actionInputs).toHaveLength(readsBeforeColdTailQuery);
      expect(proxy.entries()).toHaveLength(requestsBeforeColdTailQuery);

      // User continuation demand is the only acquisition trigger. Each press
      // must append real identities; a dropped token fails at the first stuck
      // page rather than being hidden behind a retry or iteration ceiling.
      while (windowStore.getSnapshot().loadMore?.kind === 'available') {
        const beforeAppend = rows().length;
        await windowStore.loadMore();
        expect(rows().length).toBeGreaterThan(beforeAppend);
        expect(new Set(rowKeys()).size).toBe(rows().length);
      }
      expect(windowStore.getSnapshot().loadMore).toMatchObject({ kind: 'exhausted' });
      expect(rows()).toHaveLength(503);
      expect(rows().some(row => row.entryRef.entryId === String(6_500_000 + 499)
        && row.entryRef.collisionScope === `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`)).toBe(true);
      expect(actionInputs.filter(input => input.limit > 0).every(input =>
        input.limit <= MAX_TRIAGE_LIST_WINDOW_ROWS_V1)).toBe(true);
      expect(issueRequests().filter(request => request.connectTarget === 'de.sentry.io:443')).toHaveLength(1);

      const allKeys = [...rowKeys()].sort();
      const readsBeforeLensChange = actionInputs.length;
      const requestsBeforeLensChange = proxy.entries().length;
      for (const order of ['newest', 'oldest'] as const) {
        windowStore.setLens({ ...lens, order });
        const times = rows().map(row => row.sortAtMs);
        expect(times).toEqual([...times].sort((left, right) =>
          order === 'newest' ? right - left : left - right));
        expect([...rowKeys()].sort()).toEqual(allKeys);
      }
      windowStore.setLens({ ...lens, order: 'smart' });
      expect([...rowKeys()].sort()).toEqual(allKeys);
      windowStore.setLens({ ...lens, query: 'us.sentry.io bounds tail' });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.entryRef.entryId).toBe(String(6_500_000 + 499));
      windowStore.setLens({ ...lens, query: `absent-bounds-${randomUUID()}` });
      expect(rows()).toEqual([]);
      windowStore.setLens(lens);
      expect([...rowKeys()].sort()).toEqual(allKeys);
      expect(actionInputs).toHaveLength(readsBeforeLensChange);
      expect(proxy.entries()).toHaveLength(requestsBeforeLensChange);
      expect(readWindowWrites).toEqual([]);
      expect(await durableSnapshot()).toEqual(beforeBounds);
      expect(machineTransport.counts()).toEqual({ active: 0, scoped: 0 });
      expect(boundsDeviceTraps.attempts).toEqual([]);
    } finally {
      readOnlyWindow = false;
      boundsDeviceTraps.restore();
      windowStore.dispose();
      boundsMode = false;
    }


    // A catalog transport page does not cap configured membership.
    // Configure 33 real source instances through discovery and administration;
    // the same mounted owner must enumerate beyond one catalog transport page.
    await retireExternalSourcesExcept(new Set());
    catalogMode = true;
    await selectDiscovery(SENTRY_PLUGIN_ID, SENTRY_ACTION_IDS.listInstances, SENTRY_CONNECTED_ACCOUNT_PURPOSE, [us]);
    const catalogDiscovery = TriageListInstancesResultV1Schema.parse(await invoke(SENTRY_PLUGIN_ID,
      SENTRY_ACTION_IDS.listInstances, { v: 1 }));
    expect(catalogDiscovery).toMatchObject({ kind: 'complete', failures: [] });
    if (catalogDiscovery.kind === 'failed') throw new Error('Catalog source discovery failed');
    expect(catalogDiscovery.candidates).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1);
    const catalogInstances: TriageConfiguredSourceConnectedAccountInstanceV1[] = [];
    for (const draft of catalogDiscovery.candidates) catalogInstances.push(await configure(SENTRY_PLUGIN_ID, 'sentry-issues', draft));
    const catalogIds = new Set(catalogInstances.map(instance => instance.instance.sourceInstanceId));
    const catalogInputs: TriageListEntriesInputV1[] = [];
    const catalogPages: ReturnType<typeof TriageListEntriesResultV1Schema.parse>[] = [];
    proxy.clear();
    const catalogStore = createTriageListWindowStore({ nowMs: Date.now,
      async readEntries(input) {
        catalogInputs.push(input);
        const result = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
          TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, input));
        if (input.limit === 0) catalogPages.push(result);
        return result;
      },
    });
    const beforeCatalog = await durableSnapshot();
    machineTransport.reset();
    const catalogDeviceTraps = installDeviceWriteTraps({ asyncStorage: AsyncStorage });
    readOnlyWindow = true;
    try {
      await catalogStore.refresh('view');
      expect(catalogStore.getSnapshot().error).toBeUndefined();
      expect(catalogPages.length).toBeGreaterThan(1);
      expect(catalogPages[0]).toMatchObject({ configuredSourcesStatus: 'truncated',
        configuredSourcesNextCursor: expect.any(String) });
      expect(catalogInputs.some(input => input.sources.kind === 'allConfigured'
        && input.sources.cursor !== undefined)).toBe(true);
      expect(catalogStore.getSnapshot().configuredSources.filter(source => catalogIds.has(source.sourceInstanceId)))
        .toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1);
      // The catalog's32-source transport width is not a selected-source cap.
      // Exercise that exact canonical witness separately, using only the opaque
      // Collection addresses the real mounted enumeration just published.
      const catalogSources = catalogStore.getSnapshot().configuredSources.filter(source => catalogIds.has(source.sourceInstanceId))
        .map(source => ({ sourceInstanceId: source.sourceInstanceId, configurationRowId: source.configurationRowId }));
      const batchSources = catalogSources.slice(0, MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
      nativeCursorBoundaryMode = true;
      expect(batchSources).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
      const batchInput: TriageListEntriesInputV1 = { v: 1, sources: { kind: 'selected', sourceInstances: batchSources },
        limit: MAX_TRIAGE_LIST_SOURCE_BATCH_V1, order: 'newest' };
      let batchPage = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
        TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, batchInput));
      expect(batchPage.window.coverage).toBe('partial');
      expect(batchPage.window.continuations).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
      expect(new Set(batchPage.window.continuations?.map(lane => lane.sourceInstanceId)))
        .toEqual(new Set(batchSources.map(source => source.sourceInstanceId)));
      for (const lane of batchPage.window.continuations ?? []) {
        expect(lane.continuation).toBeDefined();
        expect(Buffer.byteLength(lane.continuation?.token ?? '', 'utf8'))
          .toBeLessThanOrEqual(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
      }
      const batchKeys = new Set(batchPage.window.rows.map(row => triageEntryRowKey(row.entryRef)));
      while (batchPage.window.continuations?.length) {
        const before = batchKeys.size;
        batchPage = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
          TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, { ...batchInput, resume: batchPage.window.continuations }));
        for (const row of batchPage.window.rows) batchKeys.add(triageEntryRowKey(row.entryRef));
        expect(batchKeys.size).toBeGreaterThan(before);
      }
      expect(batchPage.window.coverage).toBe('complete');
      expect(batchKeys.size).toBe(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 * 3);
      expect(nativeCursorExchanges).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 * 3);
      for (const exchange of nativeCursorExchanges) {
        expect(exchange.headerBytes).toBeLessThan(maxHeaderSize);
        expect(exchange.headerBytes + 2).toBeGreaterThanOrEqual(maxHeaderSize);
        expect(exchange.cursorBytes).toBeGreaterThan(0);
        if (exchange.nextCursor !== null) {
          // The target kept the source token opaque. Observe the provider's
          // exact emitted cursor returning through the next real HTTP request.
          expect(nativeCursorExchanges.some(next => next.organizationId === exchange.organizationId
            && next.requestedCursor === exchange.nextCursor)).toBe(true);
        }
      }

      // Selected membership is uncapped too. With one row of capacity, the
      // public mixed frontier puts every unvisited lane before a prior lane's
      // second page. Resuming that published order must reach a different lane.
      const rotationInput: TriageListEntriesInputV1 = { ...batchInput, limit: 1,
        sources: { kind: 'selected', sourceInstances: catalogSources } };
      const rotationFirst = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
        TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, rotationInput));
      expect(rotationFirst.configuredSources).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1);
      expect(rotationFirst.window).toMatchObject({ coverage: 'partial', rows: [expect.any(Object)] });
      expect(rotationFirst.window.continuations).toHaveLength(MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1);
      expect(rotationFirst.window.continuations?.filter(lane => lane.continuation !== undefined)).toHaveLength(1);
      const nextSourceId = rotationFirst.window.continuations?.[0]?.sourceInstanceId;
      expect(nextSourceId).not.toBe(rotationFirst.window.rows[0]?.observation.sourceInstanceId);
      const rotationNext = TriageListEntriesResultV1Schema.parse(await invoke('happier.triage',
        TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, { ...rotationInput, resume: rotationFirst.window.continuations }));
      expect(rotationNext.window).toMatchObject({ coverage: 'partial',
        rows: [{ observation: { sourceInstanceId: nextSourceId } }] });
      expect(new Set(rotationNext.window.continuations?.map(lane => lane.sourceInstanceId))).toEqual(catalogIds);
      expect(rotationNext.window.continuations?.filter(lane => lane.continuation !== undefined)).toHaveLength(2);
      nativeCursorBoundaryMode = false;
      const scopes = new Set(catalogOrganizations.map(row => `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${row.id}`));
      const catalogRows = () => (catalogStore.getSnapshot().window?.rows ?? []).filter(row => scopes.has(row.entryRef.collisionScope));
      while (catalogStore.getSnapshot().loadMore?.kind === 'available') {
        const count = catalogRows().length;
        await catalogStore.loadMore();
        expect(catalogRows().length).toBeGreaterThan(count);
        expect(new Set(catalogRows().map(row => triageEntryRowKey(row.entryRef))).size).toBe(catalogRows().length);
      }
      expect(catalogStore.getSnapshot().loadMore).toMatchObject({ kind: 'exhausted' });
      expect(catalogRows()).toHaveLength((MAX_TRIAGE_LIST_SOURCE_BATCH_V1 + 1) * 3);
      expect(catalogRows().some(row => row.entryRef.collisionScope ===
        `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${catalogOrganizations.at(-1)!.id}`
        && row.entryRef.entryId === String(7_000_000 + 2))).toBe(true);
      expect(readWindowWrites).toEqual([]);
      expect(await durableSnapshot()).toEqual(beforeCatalog);
      expect(machineTransport.counts()).toEqual({ active: 0, scoped: 0 });
      expect(catalogDeviceTraps.attempts).toEqual([]);
    } finally {
      readOnlyWindow = false;
      catalogDeviceTraps.restore();
      catalogStore.dispose();
      catalogMode = false;
      nativeCursorBoundaryMode = false;
    }
    console.info(`TRIAGE_SOURCE_READ_BOUNDS ${JSON.stringify({ listResults: listResultUtf8Bytes.length,
      maximumActionResultUtf8Bytes: Math.max(...listResultUtf8Bytes),
      nativeHttpHeaderLimitBytes: maxHeaderSize,
      maximumFixtureCursorUtf8Bytes: Math.max(...nativeCursorExchanges.map(exchange => exchange.cursorBytes)),
      maximumFixtureHeaderBytes: Math.max(...nativeCursorExchanges.map(exchange => exchange.headerBytes)) })}`);

  } finally {
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Source-read journey cleanup failed');
  }
}, 0);
