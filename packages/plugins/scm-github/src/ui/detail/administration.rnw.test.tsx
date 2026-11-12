// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit, createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture,
  type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { configuredInstance, json, OBSERVED_HEAD, PULL_REQUEST_PATH, pullRequestBody,
  REPOSITORY_KEY, REPOSITORY_PATH } from '../../triage/testkit/githubMutation.test-support.js';
import { createStubGithubTransport, readRecordedJsonBody } from '../../triage/testkit/githubTriage.test-support.js';
import { GITHUB_ISSUE_RESPONSE, GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../triage/__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Awaited<ReturnType<typeof createPluginTestkit>>[] = [];
const actionHosts = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(() => surface.dispose());
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

async function mount(kind: 'issue' | 'pull-request', merged = true, refuse = false, childrenComplete?: boolean, holdFacts = false, archived = false) {
  const opened: unknown[] = [];
  const configuredReads: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  let refuseNext = false;
  let refuseFacts = false;
  let releaseFacts = () => {};
  let factsStarted = () => {};
  const factsStartedPromise = new Promise<void>(resolve => { factsStarted = resolve; });
  const factsGate = new Promise<void>(resolve => { releaseFacts = resolve; });
  let settleMutation = () => {};
  const mutationSettled = new Promise<void>(resolve => { settleMutation = resolve; });
  const instance = configuredInstance();
  const sourceConfiguration = encodeGithubTriageConfiguration({ v: 1,
    selection: { kind: 'selected', unitIds: [REPOSITORY_KEY, 'next/destination'] } });
  if (sourceConfiguration === null) throw new Error('Expected configured repository token');
  const stub = createStubGithubTransport({ respond: request => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === REPOSITORY_PATH) return json({ ...GITHUB_REPOSITORY_RESPONSE, archived });
    if (request.method === 'GET' && path === '/repos/next/destination') return json({ ...GITHUB_REPOSITORY_RESPONSE,
      id: 9000, node_id: 'R_DEST', full_name: 'next/destination', name: 'destination', owner: { login: 'next' } });
    if (request.method === 'GET' && path === PULL_REQUEST_PATH) return json(pullRequestBody({ state: merged ? 'closed' : 'open', merged }));
    if (request.method === 'GET' && path === `${REPOSITORY_PATH}/issues/7`) return json({ ...GITHUB_ISSUE_RESPONSE,
      number: 7, node_id: 'I_ADMIN' });
    if (request.method !== 'POST' || path !== '/graphql') return undefined;
    const body = readRecordedJsonBody(request) as { query: string; variables?: { state?: string; number?: number } };
    if (body.query.includes('query GithubIssueFacts')) {
      factsStarted();
      if (refuseFacts) return json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] });
      const response = json({ data: { repository: { databaseId: 4210,
        issue: body.variables?.number === 8 ? { isPinned: false, viewerSubscription: 'SUBSCRIBED' }
          : { isPinned: true, viewerSubscription: 'IGNORED' } } } });
      return holdFacts ? factsGate.then(() => response) : response;
    }
    if (body.query.startsWith('query')) return undefined;
    if (refuse || refuseNext) {
      refuseNext = false;
      return json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] });
    }
    if (body.query.includes('updateSubscription')) return json({ data: { updateSubscription: {
      subscribable: { id: 'I_ADMIN', viewerSubscription: body.variables?.state },
    } } });
    if (body.query.includes('unpinIssue')) return json({ data: { unpinIssue: { issue: { id: 'I_ADMIN', isPinned: false } } } });
    if (body.query.includes('pinIssue')) return json({ data: { pinIssue: { issue: { id: 'I_ADMIN', isPinned: true } } } });
    if (body.query.includes('revertPullRequest')) return json({ data: { revertPullRequest: {
      pullRequest: { id: GITHUB_PULL_REQUEST_RESPONSE.node_id }, revertPullRequest: { id: 'PR_REVERT', number: 1300,
        url: `https://github.com/${REPOSITORY_KEY}/pull/1300`, repository: { databaseId: 4210, name: 'example-app', owner: { login: 'octo-org' } } },
    } } });
    if (body.query.includes('transferIssue')) return json({ data: { transferIssue: { issue: { id: 'I_ADMIN', number: 44,
      url: 'https://github.com/next/destination/issues/44', repository: { id: 'R_DEST', databaseId: 9000, name: 'destination', owner: { login: 'next' } } } } } });
    return json({ data: { deleteIssue: { repository: { databaseId: 4210 } } } });
  } });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
  plugins.push(plugin);
  let launch = TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel: 'actions', instance,
    observation: { entryRef: { source: instance.instance.source, kindId: kind, collisionScope: 'github:4210', entryId: kind === 'issue' ? '7' : '1284' },
      observedAtMs: 1, locator: { v: 1, routingToken: REPOSITORY_KEY },
      snapshot: { v: 1, title: 'Keep one normalization owner', scopeLabel: REPOSITORY_KEY,
        state: { presentation: kind === 'pull-request' && merged ? 'resolved' : 'active', nativeLabel: merged ? 'Merged' : 'Open' }, facts: [],
        ...(childrenComplete === undefined ? {} : { relations: { children: { total: 3, completed: 1,
          ...(childrenComplete ? { complete: true } : {}), entries: [
            { source: instance.instance.source, kindId: 'issue', collisionScope: 'github:9876', entryId: '42',
              title: 'Exact cross-repository child', locator: { v: 1, routingToken: 'other-org/child-repo' } },
            { source: instance.instance.source, kindId: 'issue', collisionScope: 'github:4210', entryId: '43',
              title: 'Second child', locator: { v: 1, routingToken: REPOSITORY_KEY } },
          ] } } }),
        ...(kind === 'pull-request' ? { reviewRevision: { headSha: OBSERVED_HEAD, baseSha: 'a'.repeat(40), nativeRevision: OBSERVED_HEAD } } : {}) },
      viewer: { involvement: [] } }, linkedSessions: [] });
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    if (typeof action === 'string') throw new Error('Expected registered GitHub Action');
    const invocation = plugin.invokeAction(action.localId, input, { surface: 'ui' });
    pending.push(invocation);
    try { return { ok: true, result: await invocation }; }
    finally { settleMutation(); }
  });
  let detail!: PluginUiTestkit;
  const adapter = createPluginUiRnwSemanticSurfaceAdapter({ overlays: true });
  let textCount = async (_content: string) => 0;
  await act(async () => {
    detail = await createPluginUiTestkit({ identity: { instanceId: 'admin-detail', mountNonce: 'admin-detail-mount' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' }, surface: context => renderSurface({ ...context, launchInput: launch }), launchInput: launch,
      surfaceContext: createSurfaceContextFixture(), adapter: { mount: async options => {
        const surface = await adapter.mount(options);
        textCount = async content => (await surface.snapshot()).texts?.filter(text => text.content === content).length ?? 0;
        return surface;
      } },
      handlers: { actionControl: controls.handler, openResource: ({ resource }) => { opened.push(resource); }, executeAction: async ({ action, input, signal }) => {
        if (typeof action === 'string' || input === undefined) throw new Error('Expected registered Action');
        // Another plugin's public Action is a true host boundary; GitHub's own Actions run their real registration and HTTP client.
        if (action.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1) {
          configuredReads.push(input);
          return { kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured: {
            ...instance, configuration: { v: 1, token: sourceConfiguration },
          } }, { v: 1, lifecycle: 'active', configured: { ...instance,
            binding: { purpose: 'github-api', account: { service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }, accountId: 'foreign' } },
            configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'selected', unitIds: ['foreign/repository'] } })! },
          } }] };
        }
        try {
          const invocation = plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
          pending.push(invocation);
          return await invocation;
        } finally {
          if (Object.values(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1).some(id => id === action.localId)) {
            settleMutation();
          }
        }
      } },
    });
  });
  mounted.push(detail);
  actionHosts.set(detail, controls);
  const settleWrite = () => act(async () => {
    await mutationSettled;
  });
  return { detail, controls, opened, configuredReads, settleWrite, releaseFacts, textCount,
    settleFactsStarted: () => act(async () => { await factsStartedPromise; }),
    switchEntry: () => act(async () => {
      launch = { ...launch, observation: { ...launch.observation, entryRef: { ...launch.observation.entryRef, entryId: '8' } } };
      await detail.updateSurface(createSurfaceContextFixture());
    }),
    settleActions: () => act(async () => { await Promise.all(pending); }),
    refuseNext: () => { refuseNext = true; },
    refuseFacts: () => { refuseFacts = true; },
    factsReads: () => stub.requests.filter(request => request.method === 'POST'
      && (readRecordedJsonBody(request) as { query?: string }).query?.includes('query GithubIssueFacts')),
    writes: () => stub.requests.filter(request => request.method === 'POST'
    && (readRecordedJsonBody(request) as { query?: string }).query?.startsWith('mutation')) };
}

async function press(detail: PluginUiTestkit, name: string) {
  await act(async () => {
    const controls = actionHosts.get(detail);
    if (controls?.presentation(name)) await controls.press(name);
    else await detail.press(await detail.getByRole('button', { name }));
  });
}

describe('GitHub entry administration controls', () => {
  it('keeps issue notification demand and facts with their exact entry when the surface changes target', async () => {
    const { detail, factsReads, settleActions, switchEntry } = await mount('issue', false);
    await press(detail, 'Notifications');
    await settleActions();
    expect((await detail.getByRole('switch', { name: 'Pinned to the repository' })).state?.checked).toBe(true);
    await switchEntry();
    expect(await detail.queryByRole('switch', { name: 'Pinned to the repository' })).toBeUndefined();
    expect(factsReads()).toHaveLength(1);
    await press(detail, 'Notifications');
    await settleActions();
    expect(factsReads()).toHaveLength(2);
    expect((await detail.getByRole('switch', { name: 'Pinned to the repository' })).state?.checked).toBe(false);
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(true);
  });

  it('reads issue notification facts once on expansion, shows no guessed toggles, and uses successive write receipts', async () => {
    const { detail, factsReads, writes, releaseFacts, settleActions, settleFactsStarted, refuseNext } = await mount('issue', false, false, undefined, true);
    expect(factsReads()).toHaveLength(0);
    expect(await detail.queryByRole('switch', { name: 'Subscribed' })).toBeUndefined();
    expect(await detail.queryByRole('switch', { name: 'Pinned to the repository' })).toBeUndefined();
    await press(detail, 'Notifications');
    await settleFactsStarted();
    expect(factsReads()).toHaveLength(1);
    expect(await detail.queryByRole('switch', { name: 'Subscribed' })).toBeUndefined();
    expect(await detail.queryByRole('switch', { name: 'Pinned to the repository' })).toBeUndefined();
    releaseFacts();
    await settleActions();
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(false);
    expect((await detail.getByRole('switch', { name: 'Pinned to the repository' })).state?.checked).toBe(true);
    for (const [name, checked] of [['Pinned to the repository', false], ['Pinned to the repository', true],
      ['Subscribed', true], ['Subscribed', false]] as const) {
      await act(async () => { await detail.press(await detail.getByRole('switch', { name })); });
      await settleActions();
      expect((await detail.getByRole('switch', { name })).state?.checked).toBe(checked);
    }
    refuseNext();
    await act(async () => { await detail.press(await detail.getByRole('switch', { name: 'Subscribed' })); });
    await settleActions();
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(false);
    expect((await detail.getByRole('switch', { name: 'Pinned to the repository' })).state?.checked).toBe(true);
    expect(writes().map(readRecordedJsonBody)).toEqual([
      expect.objectContaining({ query: expect.stringContaining('unpinIssue') }),
      expect.objectContaining({ query: expect.stringContaining('pinIssue') }),
      expect.objectContaining({ variables: { subscribableId: 'I_ADMIN', state: 'SUBSCRIBED' } }),
      expect.objectContaining({ variables: { subscribableId: 'I_ADMIN', state: 'UNSUBSCRIBED' } }),
      expect.objectContaining({ variables: { subscribableId: 'I_ADMIN', state: 'SUBSCRIBED' } }),
    ]);
    expect(factsReads()).toHaveLength(1);
    await press(detail, 'Notifications');
    expect(await detail.queryByRole('switch', { name: 'Subscribed' })).toBeUndefined();
    await press(detail, 'Notifications');
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(false);
    expect((await detail.getByRole('switch', { name: 'Pinned to the repository' })).state?.checked).toBe(true);
    expect(factsReads()).toHaveLength(1);
  });

  it('settles denied issue facts without guessing switches or automatically rereading', async () => {
    const { detail, factsReads, refuseFacts, settleActions } = await mount('issue', false);
    refuseFacts();
    await press(detail, 'Notifications');
    await settleActions();
    await expect(detail.getByText('Notifications could not be read.')).resolves.toBeDefined();
    expect(await detail.queryByRole('switch', { name: 'Subscribed' })).toBeUndefined();
    expect(await detail.queryByRole('switch', { name: 'Pinned to the repository' })).toBeUndefined();
    expect(await detail.queryByRole('button', { name: 'Retry' })).toBeUndefined();
    await press(detail, 'Details');
    await expect(detail.getByText('github_forbidden')).resolves.toBeDefined();
    expect(factsReads()).toHaveLength(1);
  });

  it('shows exact observed children and partial coverage without offering an incomplete reorder', async () => {
    const { detail, writes } = await mount('issue', true, false, false);
    await press(detail, 'Sub-issues, 1 of 3 done');
    await expect(detail.getByText('#42 Exact cross-repository child')).resolves.toBeDefined();
    await expect(detail.getByText('#43 Second child')).resolves.toBeDefined();
    await expect(detail.getByText('Showing the first 2')).resolves.toBeDefined();
    expect((await detail.getAllByRole('button')).some(button => button.name?.startsWith('Move '))).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('keeps observed sub-issues readable when the existing repository capability denies ordering', async () => {
    const { detail, writes, settleActions, textCount } = await mount('issue', false, false, true, false, true);
    await settleActions();
    const archivedReasons = await textCount('This repository is archived.');
    await press(detail, 'Sub-issues, 1 of 3 done');
    await expect(detail.getByText('#42 Exact cross-repository child')).resolves.toBeDefined();
    expect(await textCount('This repository is archived.')).toBe(archivedReasons + 1);
    expect(writes()).toEqual([]);
  });

  it('opens a merged PR revert through the registered Action and replaces the form with its new PR receipt', async () => {
    const { detail, controls, opened, writes, settleWrite } = await mount('pull-request');
    await press(detail, 'Revert…');
    expect(controls.presentation('Open revert PR')).toMatchObject({ disabled: false });
    await press(detail, 'Open revert PR');
    await settleWrite();
    expect(writes().map(readRecordedJsonBody)).toEqual([expect.objectContaining({ variables: {
      pullRequestId: GITHUB_PULL_REQUEST_RESPONSE.node_id, title: 'Revert "#1284 Keep one normalization owner"', draft: false,
    } })]);
    await expect(detail.getByText('Opened #1300')).resolves.toBeDefined();
    expect(await detail.queryByRole('button', { name: 'Open revert PR' })).toBeUndefined();
    await press(detail, 'Open');
    expect(opened).toEqual([{ kind: 'pullRequest', url: `https://github.com/${REPOSITORY_KEY}/pull/1300` }]);
  });

  it('offers no revert on an unmerged PR', async () => {
    const { detail } = await mount('pull-request', false);
    expect(await detail.queryByRole('button', { name: 'Revert…' })).toBeUndefined();
  });

  it('reads same-connection configured repository choices only when Transfer is opened and opens the moved issue', async () => {
    const { detail, controls, configuredReads, opened, writes, settleWrite } = await mount('issue');
    expect(configuredReads).toHaveLength(0);
    await press(detail, 'Transfer to another repository…');
    await press(detail, 'Destination repository');
    expect(await detail.queryByText('foreign/repository')).toBeUndefined();
    await act(async () => { await detail.press(await detail.getByRole('menuitemradio', { name: 'next/destination' })); });
    await act(async () => { await detail.press(await detail.getByRole('switch', { name: 'Create missing labels' })); });
    expect(controls.presentation('Transfer')).toMatchObject({ disabled: false });
    await press(detail, 'Transfer');
    await settleWrite();
    expect(writes().map(readRecordedJsonBody)).toEqual([expect.objectContaining({ variables: {
      issueId: 'I_ADMIN', repositoryId: 'R_DEST', createLabelsIfMissing: true,
    } })]);
    await expect(detail.getByText('Moved to next/destination #44')).resolves.toBeDefined();
    await press(detail, 'Open');
    expect(opened).toEqual([{ kind: 'issue', url: 'https://github.com/next/destination/issues/44' }]);
  });

  it('names the issue and irreversible consequence before deleting, then retires the write into its receipt', async () => {
    const { detail, controls, writes, settleWrite } = await mount('issue');
    await press(detail, 'Delete issue…');
    await expect(detail.getByText('Delete #7 · Keep one normalization owner')).resolves.toBeDefined();
    await expect(detail.getByText('This permanently deletes the issue and its comments on GitHub. It cannot be undone.')).resolves.toBeDefined();
    expect(controls.presentation('Delete issue')).toMatchObject({ disabled: false });
    await press(detail, 'Delete issue');
    await settleWrite();
    expect(writes()).toHaveLength(1);
    await expect(detail.getByText('Deleted on GitHub')).resolves.toBeDefined();
    expect(await detail.queryByRole('button', { name: 'Delete issue' })).toBeUndefined();
  });

  it('keeps a refused revert editable and never claims a created PR', async () => {
    const { detail, controls, writes, settleWrite } = await mount('pull-request', true, true);
    await press(detail, 'Revert…');
    await press(detail, 'Open revert PR');
    await settleWrite();
    expect(writes()).toHaveLength(1);
    expect(await detail.queryByText('Opened #1300')).toBeUndefined();
    expect(controls.presentation('Open revert PR')).toMatchObject({ disabled: false });
  });
});
