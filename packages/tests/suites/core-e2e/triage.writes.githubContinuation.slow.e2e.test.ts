// QB-46: the public source scan walks real GitHub HTTP pages through one
// configured Connected Account; only the third-party TLS peer is constructed.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { connectUiTriageActionClient, installPersonTransientConfirmationBoundary } from '@happier-tests/ui-action-client';
import { resetRuntimeFetch, setRuntimeFetch } from '@happier-tests/ui-machine-carrier';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as connectionOutputs } from '@happier-dev/protocol/connect/configurationActionsV1';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
  TriageSourceAdministrationActionResultV1Schema, TriageReadConfiguredSourceInstancesResultV1Schema,
  TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageScanResultV1Schema,
  decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
  type TriageSourceInstanceDraftV1, type TriageScanInputV1,
} from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN } from '../../../plugins/scm-github/src/manifest';
import githubPackage from '../../../plugins/scm-github/package.json';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 } from '../../../plugins/scm-github/src/triage/configuration';
import { GITHUB_SCAN_LANE_ORDER_V1, buildGithubLaneQuery } from '../../../plugins/scm-github/src/triage/scan/query';
import { GITHUB_TOKEN_CREDENTIAL_KEY } from '../../../plugins/scm-github/src/auth/tokenKinds';
import { GITHUB_SEARCH_PULL_REQUEST_ITEM, GITHUB_REPOSITORY_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE, githubSearchResponse } from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { githubChecksBatchResponse } from '../../../plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startConnectedAccountTlsRecordingProxy, type ConnectedAccountTlsResponse } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { sanitizeCliTestEnv } from '../../src/testkit/process/cliTestEnv';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-github-continuation' });
const source = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
const repositories = [
  { route: 'octo-org/example-app', id: '4210', body: GITHUB_REPOSITORY_RESPONSE },
  { route: 'octo-org/example-tools', id: '8815', body: GITHUB_OTHER_REPOSITORY_RESPONSE },
];
// Caller-selected geometry: one row for each repository specimen per call.
// This is not a feature limit; the public scan contract owns admitted limits.
const limit = repositories.length;
const providerPages = [1, 2];

it('QB-46 resumes only unsubmitted GitHub frontiers across five lanes and same-number PRs in two repositories', async () => {
  const testDir = run.testDir(randomUUID());
  const token = `constructed-github-continuation-${randomUUID()}`;
  const tokenFingerprint = `sha256:${createHash('sha256').update(token).digest('hex')}`;
  const repositoryKeys = repositories.map(repository => repository.route);
  const laneQueries = new Map(GITHUB_SCAN_LANE_ORDER_V1.map(laneId => [
    buildGithubLaneQuery({ laneId, repositoryKeys }), laneId,
  ]));
  expect(laneQueries.size).toBe(GITHUB_SCAN_LANE_ORDER_V1.length);
  const servedRows: string[] = [];
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const proxy = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com', 'github.com'],
      responseForRequest(request): ConnectedAccountTlsResponse {
        const url = new URL(request.path, 'https://api.github.com');
        const ok = (body: unknown, statusCode = 200) => ({ statusCode, body });
        if (request.authorizationFingerprint !== tokenFingerprint) return ok({ message: 'Constructed connection required' }, 401);
        if (url.pathname === '/user') return { ...ok({ id: 1146, login: 'continuation-fixture' }), headers: { 'x-oauth-scopes': 'repo' } };
        if (url.pathname === '/graphql') {
          const response = githubChecksBatchResponse({ url: url.href, method: request.method,
            headers: {}, redirect: 'manual', body: Buffer.from(request.body) });
          return { statusCode: response.status, body: response.body };
        }
        const repository = repositories.find(candidate => url.pathname === `/repos/${candidate.route}`
          || url.pathname === `/repositories/${candidate.id}`);
        if (repository) return ok(repository.body);
        if (url.pathname !== '/search/issues') return ok({ message: 'Unexpected continuation fixture route' }, 404);
        const lane = laneQueries.get(url.searchParams.get('q') ?? '');
        const page = Number(url.searchParams.get('page') ?? '1');
        if (!lane || !providerPages.includes(page)) return ok({ message: 'Unknown search frontier' }, 422);
        // Both repositories expose PR #1, then PR #2. A number-only identity
        // loses one sibling; each involvement encounter remains independently submitted.
        const items = repositories.map(candidate => {
          const marker = `frontier-${lane}-${page}-${candidate.id}`;
          servedRows.push(marker);
          return { ...GITHUB_SEARCH_PULL_REQUEST_ITEM, id: Number(candidate.id) * 100 + page,
            node_id: `PR_fixture_${candidate.id}_${page}`, number: page, title: marker,
            url: `https://api.github.com/repos/${candidate.route}/issues/${page}`,
            repository_url: `https://api.github.com/repos/${candidate.route}`,
            html_url: `https://github.com/${candidate.route}/pull/${page}`,
            repository: candidate.body, pull_request: {
              url: `https://api.github.com/repos/${candidate.route}/pulls/${page}`,
              html_url: `https://github.com/${candidate.route}/pull/${page}`, merged_at: null,
            } };
        });
        const body = githubSearchResponse({ items, totalCount: repositories.length * providerPages.length });
        if (page === providerPages.at(-1)) return ok(body);
        // The physical peer issues the next URL, preserving all actual query
        // parameters. Production validates this Link and owns its continuation.
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        return { ...ok(body), headers: { link: `<${next.href}>; rel="next"` } };
      } });
    cleanup.push(() => proxy.stop());
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    const server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
    cleanup.push(() => server.stop());
    const auth = await createTestAuth(server.baseUrl);
    const homeDir = join(testDir, 'daemon-home');
    const { machineId } = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    const daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
      ...sanitizeCliTestEnv(process.env), CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      NODE_OPTIONS: `${sourceOptions} --import ${pathToFileURL(join(repoRootDir(),
        'packages/tests/suites/core-e2e/triage.runtime.github.preload.mjs')).href}`,
      HAPPIER_E2E_TRIAGE_GITHUB_PROXY: proxy.url, HAPPIER_E2E_TRIAGE_GITHUB_CA: proxy.caCertPath,
      GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
    } });
    cleanup.push(() => daemon.stop());
    cleanup.push(installPersonTransientConfirmationBoundary());
    const client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed,
      additionalPlugins: [{ packageName: githubPackage.name, manifest: GITHUB_PLUGIN.manifest, activate: activateGithub }] });
    cleanup.push(() => client.close());
    await waitFor(() => client.isAccountReady() && client.isMachineControlReady(machineId));
    const undici: typeof import('undici') = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url))('undici/index.js');
    const dispatcher = new undici.ProxyAgent({ uri: proxy.url, requestTls: { ca: await readFile(proxy.caCertPath) } });
    const originalFetch = globalThis.fetch.bind(globalThis);
    setRuntimeFetch((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const external = { ...init, dispatcher } satisfies RequestInit & { dispatcher: typeof dispatcher };
      return originalFetch(input, url.hostname === 'api.github.com' ? external : init);
    });
    cleanup.push(async () => { resetRuntimeFetch(); await dispatcher.close(); });
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: client.serverId, defaultSessionMachineId: machineId };
    const action = async (...args: Parameters<typeof client.executeConfirmed>) => {
      const result = await client.executeConfirmed(...args);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(`Continuation journey Action refused (${result.errorCode})`);
      return result.result;
    };
    const invoke = (pluginId: string, localId: string, input: unknown) => action('action.invoke', {
      action: { pluginId, localId }, input,
    }, context);
    const begun = connectionOutputs['connectedServices.authentication.beginConnect'].parse(await action(
      'connectedServices.authentication.beginConnect', { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, modeId: 'fine-grained-pat' }, context));
    if (begun.status !== 'awaitingManual') throw new Error(`GitHub Connect settled ${begun.status}`);
    const connected = connectionOutputs['connectedServices.authentication.submitManual'].parse(await action(
      'connectedServices.authentication.submitManual', { attemptId: begun.attemptId, fields: { [GITHUB_TOKEN_CREDENTIAL_KEY]: token } }, context));
    if (connected.status !== 'connected') throw new Error(`GitHub Connect settled ${connected.status}`);
    await client.waitForConnectedAccountProfile(connected.account);
    const configurationToken = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: repositoryKeys } });
    if (configurationToken === null) throw new Error('GitHub continuation configuration could not encode');
    const draft: TriageSourceInstanceDraftV1 = { v: 1,
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: connected.account },
      localInstanceKey: GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1, keyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
      configuration: { v: 1, token: configurationToken }, locator: { v: 1, displayLabel: 'GitHub continuation fixture' } };
    const created = TriageSourceAdministrationActionResultV1Schema.parse(await invoke('happier.triage',
      TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, { v: 1, kind: 'create', source, draft }));
    if (created.kind !== 'active') throw new Error(`Continuation source create settled ${created.kind}`);
    const read = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await invoke('happier.triage',
      TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1, { v: 1, source }));
    if (read.kind !== 'read') throw new Error(`Continuation source read settled ${read.kind}`);
    const instance = TriageConfiguredSourceConnectedAccountInstanceV1Schema.parse(read.instances.find(
      candidate => candidate.configured.instance.sourceInstanceId === created.sourceInstanceId)?.configured);
    expect(instance.binding.account).toEqual(connected.account);
    const scan = async (page: TriageScanInputV1['page']) => TriageScanResultV1Schema.parse(await invoke(
      GITHUB_PLUGIN_ID, GITHUB_TRIAGE_ACTION_IDS_V1.scan, { v: 1, instance, page }));
    const searches = () => proxy.entries().filter(request => new URL(request.path, 'https://api.github.com').pathname === '/search/issues');
    const delivered: string[] = [];
    let page: TriageScanInputV1['page'] = { kind: 'initial', limit };
    let firstContinuation: string | undefined;
    for (const providerPage of providerPages) {
      for (const lane of GITHUB_SCAN_LANE_ORDER_V1) {
        const beforeRows = servedRows.length;
        const beforeSearches = searches().length;
        const result = await scan(page);
        if (result.kind === 'failed') throw new Error(`GitHub continuation scan failed (${result.failure.code})`);
        expect(result.observations).toHaveLength(repositories.length);
        const omitted = result.evidence.kind === 'partial' ? result.evidence.omittedItemCount ?? 0 : 0;
        expect(result.observations.length + omitted).toBeLessThanOrEqual(limit);
        expect(servedRows.length - beforeRows).toBeLessThanOrEqual(limit);
        const requests = searches().slice(beforeSearches);
        expect(requests).toHaveLength(1);
        const request = new URL(requests[0]!.path, 'https://api.github.com');
        expect(laneQueries.get(request.searchParams.get('q') ?? '')).toBe(lane);
        expect(Number(request.searchParams.get('page') ?? '1')).toBe(providerPage);
        expect(Number(request.searchParams.get('per_page'))).toBe(limit);
        expect(requests[0]!.authorizationFingerprint).toBe(tokenFingerprint);
        expect(result.observations.map(observation => observation.localRef)).toEqual(repositories.map(repository => ({
          kindId: 'pull-request', collisionScope: `github:${repository.id}`, entryId: String(providerPage),
        })));
        for (const [index, observation] of result.observations.entries()) {
          expect(observation.kind).toBe('present');
          if (observation.kind !== 'present') throw new Error('Expected the constructed PR observation');
          const marker = `frontier-${lane}-${providerPage}-${repositories[index]!.id}`;
          expect(observation.snapshot.title).toBe(marker);
          expect(delivered).not.toContain(marker);
          delivered.push(marker);
        }
        const last = providerPage === providerPages.at(-1) && lane === GITHUB_SCAN_LANE_ORDER_V1.at(-1);
        if (last) expect(result).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' } });
        else {
          expect(result.kind).toBe('page');
          if (result.kind !== 'page') throw new Error('GitHub continuation ended before the unsubmitted frontier');
          const continuation = result.continuation.token;
          firstContinuation ??= continuation;
          expect(Buffer.byteLength(continuation, 'utf8')).toBeLessThanOrEqual(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
          // Use the protocol codec, never a second token parser. Already delivered
          // payloads cannot grow the token; only unsubmitted provider frontiers remain.
          const decoded = decodeTriagePagingTokenV1(continuation);
          expect(decoded).not.toBeNull();
          for (const marker of delivered) expect(JSON.stringify(decoded)).not.toContain(marker);
          for (const repository of repositories) expect(JSON.stringify(decoded)).not.toContain(`github:${repository.id}`);
          expect(continuation).not.toContain(token);
          page = { kind: 'continuation', continuation: result.continuation };
        }
      }
    }
    expect(delivered).toHaveLength(repositories.length * providerPages.length * GITHUB_SCAN_LANE_ORDER_V1.length);
    expect(searches()).toHaveLength(providerPages.length * GITHUB_SCAN_LANE_ORDER_V1.length);
    // After the known-good control, altered version and malformed JSON must be
    // typed refusals before any provider search. No private cursor is hand-minted.
    if (!firstContinuation) throw new Error('GitHub never returned a continuation');
    const decoded = decodeTriagePagingTokenV1(firstContinuation);
    const changedVersion = encodeTriagePagingTokenV1({ ...decoded, v: 'unknown-version' });
    if (changedVersion === null) throw new Error('Altered continuation did not fit the public envelope');
    const beforeInvalid = searches().length;
    for (const invalid of [`${firstContinuation}!`, changedVersion]) expect(await scan({ kind: 'continuation',
      continuation: { v: 1, token: invalid } })).toMatchObject({ kind: 'failed', failure: {
        class: 'unsupportedContract', code: 'github_scan_continuation_unrecognized',
      } });
    expect(searches()).toHaveLength(beforeInvalid);
  } finally {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'GitHub continuation journey cleanup failed');
  }
}, 0);
