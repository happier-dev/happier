// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { describeTriageSourceFailureV1, TRIAGE_SOURCE_FAILURE_COPY_V1, TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { encodeBitbucketConfiguration } from '../../triage/instance.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from '../../triage/source/descriptor.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS, BitbucketBuildsInputV1Schema, BitbucketBuildsResultV1Schema, BitbucketOverviewResultV1Schema } from '../../triage/source/detailContracts.js';
import { accountRef, createConnectedAccountsStub, createHttpStub } from '../../triage/source/testSupport.js';
import pullRequest from '../../triage/fixtures/pullRequestSelf.json' with { type: 'json' };
import currentUser from '../../triage/fixtures/currentUser.json' with { type: 'json' };
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(async () => { await surface.dispose(); });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});
function launchInput() {
  const workspaceUuid = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid });
  if (!encoded.ok) throw new Error('Expected valid configuration');
  const source = { pluginId: BITBUCKET_PLUGIN_ID, localId: 'bitbucket-forge' };
  return TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel: 'checks',
    instance: { v: 1, instance: { source, sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
      binding: { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: accountRef('account-1') }, localInstanceKey: workspaceUuid, configuration: { v: 1, token: encoded.token } },
    observation: { entryRef: { source, kindId: 'pull-request', collisionScope: `bitbucket:${pullRequest.destination.repository.uuid}`, entryId: '42' },
      observedAtMs: 1_760_000_700_000, locator: { v: 1, routingToken: 'example-workspace/deploy-tools' },
      snapshot: { v: 1, title: 'Read dispatch', scopeLabel: 'example-workspace/deploy-tools', state: { presentation: 'active', nativeLabel: 'Open' }, facts: [] }, viewer: { involvement: [] } }, linkedSessions: [] });
}
type DetailPanel = 'checks' | 'overview' | 'files' | 'activity' | 'actions';

async function mountRegisteredDetail(misbind = false, initialPanel: DetailPanel = 'checks', diffFailure?: PluginError, providerFailure = false,
  overviewTransport?: (result: unknown) => Promise<void>) {
  let panel = initialPanel;
  let entryId = '42';
  const input = () => {
    const value = launchInput();
    return { ...value, panel, panelScrollOwner: panel === 'files' || panel === 'activity' ? 'list' as const : 'scrollArea' as const,
      observation: { ...value.observation,
      entryRef: { ...value.observation.entryRef, entryId } } };
  };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let providerRead = 0;
  const transport = createHttpStub(url => {
    if (url.endsWith('/2.0/user')) return { body: currentUser };
    if (providerFailure && (url.includes('/diffstat') || url.includes('/statuses'))) return { status: 404, body: { error: { message: 'Fixture route is missing' } } };
    if (url.includes('/diffstat')) return { body: { values: [] } };
    if (url.endsWith('/diff')) return { bodyBytes: '' };
    if (url.includes('/statuses')) return { body: { values: [{ uuid: '{7c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f}', key: 'PIPELINE', name: 'Dispatch pipeline', state: 'SUCCESSFUL' }] } };
    if (url.includes('/comments') || url.includes('/activity')) return { body: { values: [] } };
    const requestedEntryId = /\/pullrequests\/(\d+)$/u.exec(new URL(url).pathname)?.[1];
    if (requestedEntryId !== undefined) return { body: { ...pullRequest, id: Number(requestedEntryId),
      ...(overviewTransport === undefined ? {} : { summary: { ...pullRequest.summary, raw: `Entry ${requestedEntryId}, provider reply ${++providerRead}` } }),
    } };
    throw new Error(`Unexpected Bitbucket route: ${url}`);
  });
  const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
    connectedAccounts, http: { ...transport.http, request: async (request, options) => {
      if (request.url.includes('/statuses')) await pending;
      return transport.http.request(request, options);
    } },
  } });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  const overviewResults: unknown[] = [];
  const actions: string[] = [];
  const issuedRequestIds: string[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({ identity: { instanceId: 'bitbucket-dispatch', mountNonce: 'bitbucket-dispatch-mount' },
      authorPlugin: { id: BITBUCKET_PLUGIN_ID, version: '0.0.0' }, surface: defineUiSurface(context => {
        const body = renderSurface({ ...context, launchInput: input() });
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected native detail');
        return body;
      }), launchInput: launchInput(), surfaceContext: createSurfaceContextFixture({ translations: {
        'plugins.triage.sourceSettings.failure.permission': TRIAGE_SOURCE_FAILURE_COPY_V1.permission,
      } }), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input, requestId }) => {
        issuedRequestIds.push(requestId);
        if (typeof action === 'string' || action.pluginId !== BITBUCKET_PLUGIN_ID || input === undefined) throw new Error('Wrong Action owner');
        actions.push(action.localId);
        // The host transport boundary can lose a receipt after dispatch.
        if (action.localId === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff && diffFailure !== undefined) throw diffFailure;
        const builds = action.localId === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds;
        const request = misbind && builds ? BitbucketBuildsInputV1Schema.parse(input) : null;
        const result = await plugin.invokeAction(request === null ? action.localId : BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments,
          request === null ? input : request, { surface: 'ui' });
        if (builds) producerResults.push(result);
        if (action.localId === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview) {
          overviewResults.push(result);
          // Delay the genuine registered Action's reply at the host transport boundary.
          await overviewTransport?.(result);
        }
        return result;
      } },
    });
  });
  mounted.push(detail);
  return { detail, producerResults, overviewResults, release, actions, issuedRequestIds, requests: transport.requests,
    async selectPanel(nextPanel: typeof panel, nextEntryId = entryId) {
      panel = nextPanel;
      entryId = nextEntryId;
      await act(async () => { await detail.updateSurface(createSurfaceContextFixture({ translations: {
        'plugins.triage.sourceSettings.failure.permission': TRIAGE_SOURCE_FAILURE_COPY_V1.permission,
      } })); });
    },
  };
}
describe('registered Bitbucket detail read dispatch', () => {
  it.each([
    ['overview', [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview, BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff, BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds]],
    ['files', [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff]],
    ['checks', [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds]],
    ['activity', [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity, BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments]],
    ['actions', [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview]],
  ] as const)('keeps the opened Bitbucket %s reads scoped to that panel', async (panel, expected) => {
    const { detail, release, actions, requests } = await mountRegisteredDetail(false, panel);
    await act(async () => { release(); });
    expect([...actions].sort()).toEqual([...expected].sort());
    expect(requests.length).toBeGreaterThanOrEqual(actions.length);
    const openedRequests = requests.length;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { await detail.retire(); });
    expect([...actions].sort()).toEqual([...expected].sort());
    expect(requests).toHaveLength(openedRequests);
  });

  it.each(['checks', 'overview', 'files'] as const)('discloses the provider code and read request identity on %s', async panel => {
    const { detail, release, issuedRequestIds, actions } = await mountRegisteredDetail(false, panel, undefined, true);
    await act(async () => { release(); });
    const disclosures = await detail.getAllByRole('button', { name: 'Details' });
    for (const disclosure of disclosures) await act(async () => { await detail.press(disclosure); });
    await expect(detail.getByText('route-not-found')).resolves.toBeDefined();
    await expect(detail.getByText('Request ID')).resolves.toBeDefined();
    await expect(detail.getByText('Fixture route is missing')).resolves.toBeDefined();
    const readId = issuedRequestIds[actions.indexOf(panel === 'checks' ? BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds : BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff)]!;
    await expect(detail.getByText(readId)).resolves.toBeDefined();
  });
  it.each([
    ['timeout', 'unknown'],
    ['denied', 'permission'],
  ] as const)('settles a %s diff read as a typed failure on Overview and Files', async (code, failureClass) => {
    const { detail, release, selectPanel } = await mountRegisteredDetail(false, 'overview', new PluginError({ code }));
    await act(async () => { release(); });
    await selectPanel('files');
    const description = failureClass === 'permission'
      ? TRIAGE_SOURCE_FAILURE_COPY_V1.permission
      : describeTriageSourceFailureV1({ class: failureClass, code }, 'Bitbucket could not complete this read.');
    await expect(detail.getByText(description)).resolves.toBeDefined();
    await selectPanel('overview');
    await expect(detail.getByText(pullRequest.summary.raw)).resolves.toBeDefined();
  });

  it('retains the settled Overview across host Files switches but reads a different entry', async () => {
    const { detail, release, actions, overviewResults, requests, selectPanel } = await mountRegisteredDetail(false, 'overview');
    await act(async () => { release(); });
    const overviewReads = () => actions.filter(action => action === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview).length;
    expect(overviewReads()).toBe(1);
    for (let index = 0; index < 4; index += 1) {
      await selectPanel('files');
      await selectPanel('overview');
    }
    expect(overviewReads()).toBe(1);
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(overviewReads()).toBe(1);
    expect(BitbucketOverviewResultV1Schema.parse(overviewResults[0])).toMatchObject({ kind: 'overview',
      description: pullRequest.summary.raw, observation: { kind: 'present' } });
    // The Overview story's discardable Builds interval is a separate read. Its native
    // Action proves the entity before reading statuses, even when Overview is retained.
    expect(actions.filter(action => action === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds)).toHaveLength(5);
    expect(requests.filter(request => new URL(request.url).pathname.endsWith('/statuses'))).toHaveLength(5);
    await selectPanel('overview', '43');
    expect(overviewReads()).toBe(2);
    expect(BitbucketOverviewResultV1Schema.parse(overviewResults[1])).toMatchObject({ kind: 'overview',
      observation: { kind: 'present', localRef: { entryId: '43' } } });
  });
  it('retains pending and settled builds across equivalent parsed launch input', async () => {
    const { detail, producerResults, release } = await mountRegisteredDetail();
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { release(); });
    expect(producerResults).toHaveLength(1);
    expect(BitbucketBuildsResultV1Schema.parse(producerResults[0])).toMatchObject({ kind: 'builds', rows: [{ name: 'Dispatch pipeline' }] });
    await expect(detail.getByText('Dispatch pipeline')).resolves.toBeDefined();
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await expect(detail.getByText('Dispatch pipeline')).resolves.toBeDefined();
    expect(producerResults).toHaveLength(1);
  });
  it('accepts host panel input and refuses an obsolete Overview reply after Overview to Files to Overview', async () => {
    let settleFirst!: () => void;
    const firstReply = new Promise<void>(resolve => { settleFirst = resolve; });
    let overviewReplies = 0;
    const { detail, release, overviewResults, selectPanel } = await mountRegisteredDetail(false, 'overview', undefined, false, async () => {
      if (++overviewReplies === 1) await firstReply;
    });
    try {
      await act(async () => { release(); });
      expect(overviewResults).toHaveLength(1);
      const obsolete = BitbucketOverviewResultV1Schema.parse(overviewResults[0]);
      expect(obsolete.kind).toBe('overview');
      // Live entry changes replace the source mount. Ordinary panel changes
      // retain it and end only the previous panel's activity interval.
      await selectPanel('files');
      await expect(detail.getByText('No changed files')).resolves.toBeDefined();
      await selectPanel('overview');
      expect(overviewResults).toHaveLength(2);
      const current = BitbucketOverviewResultV1Schema.parse(overviewResults[1]);
      if (current.kind !== 'overview' || obsolete.kind !== 'overview'
        || typeof current.description !== 'string' || typeof obsolete.description !== 'string') throw new Error('Expected two distinct Overview replies');
      expect(current.description).not.toBe(obsolete.description);
      await expect(detail.getByText(current.description)).resolves.toBeDefined();
      await act(async () => { settleFirst(); });
      await expect(detail.getByText(current.description)).resolves.toBeDefined();
      await expect(detail.queryByText(obsolete.description)).resolves.toBeUndefined();
      await selectPanel('files');
      await selectPanel('overview');
      await expect(detail.getByText(current.description)).resolves.toBeDefined();
      expect(overviewResults).toHaveLength(2);
    } finally { settleFirst(); }
  });
  it('rejects a mis-bound registered producer', async () => {
    const { detail, producerResults } = await mountRegisteredDetail(true);
    expect(producerResults).toHaveLength(1);
    expect(BitbucketBuildsResultV1Schema.safeParse(producerResults[0]).success).toBe(false);
    await expect(detail.getByText(describeTriageSourceFailureV1({ class: 'unsupportedContract', code: 'bitbucket-detail-result-unreadable' }, 'Bitbucket could not complete this read.'))).resolves.toBeDefined();
  });
});
