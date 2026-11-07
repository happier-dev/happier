// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture,
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
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(() => surface.dispose());
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

async function mount(kind: 'issue' | 'pull-request', merged = true, refuse = false) {
  const opened: unknown[] = [];
  const configuredReads: unknown[] = [];
  let settleMutation = () => {};
  const mutationSettled = new Promise<void>(resolve => { settleMutation = resolve; });
  const instance = configuredInstance();
  const sourceConfiguration = encodeGithubTriageConfiguration({ v: 1,
    selection: { kind: 'selected', unitIds: [REPOSITORY_KEY, 'next/destination'] } });
  if (sourceConfiguration === null) throw new Error('Expected configured repository token');
  const stub = createStubGithubTransport({ respond: request => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === REPOSITORY_PATH) return json(GITHUB_REPOSITORY_RESPONSE);
    if (request.method === 'GET' && path === '/repos/next/destination') return json({ ...GITHUB_REPOSITORY_RESPONSE,
      id: 9000, node_id: 'R_DEST', full_name: 'next/destination', name: 'destination', owner: { login: 'next' } });
    if (request.method === 'GET' && path === PULL_REQUEST_PATH) return json(pullRequestBody({ state: merged ? 'closed' : 'open', merged }));
    if (request.method === 'GET' && path === `${REPOSITORY_PATH}/issues/7`) return json({ ...GITHUB_ISSUE_RESPONSE,
      number: 7, node_id: 'I_ADMIN' });
    if (request.method !== 'POST' || path !== '/graphql') return undefined;
    const body = readRecordedJsonBody(request) as { query: string };
    if (body.query.startsWith('query')) return undefined;
    if (refuse) return json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] });
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
  const launch = TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel: 'actions', instance,
    observation: { entryRef: { source: instance.instance.source, kindId: kind, collisionScope: 'github:4210', entryId: kind === 'issue' ? '7' : '1284' },
      observedAtMs: 1, locator: { v: 1, routingToken: REPOSITORY_KEY },
      snapshot: { v: 1, title: 'Keep one normalization owner', scopeLabel: REPOSITORY_KEY,
        state: { presentation: kind === 'pull-request' && merged ? 'resolved' : 'active', nativeLabel: merged ? 'Merged' : 'Open' }, facts: [],
        ...(kind === 'pull-request' ? { reviewRevision: { headSha: OBSERVED_HEAD, baseSha: 'a'.repeat(40), nativeRevision: OBSERVED_HEAD } } : {}) },
      viewer: { involvement: [] } }, linkedSessions: [] });
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({ identity: { instanceId: 'admin-detail', mountNonce: 'admin-detail-mount' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' }, surface: renderSurface, launchInput: launch,
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { openResource: ({ resource }) => { opened.push(resource); }, executeAction: async ({ action, input, signal }) => {
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
          return await plugin.invokeAction(action.localId, input, { surface: 'ui', signal });
        } finally {
          if (Object.values(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1).some(id => id === action.localId)) {
            settleMutation();
          }
        }
      } },
    });
  });
  mounted.push(detail);
  const settleWrite = () => act(async () => {
    await mutationSettled;
  });
  return { detail, opened, configuredReads, settleWrite, writes: () => stub.requests.filter(request => request.method === 'POST'
    && (readRecordedJsonBody(request) as { query?: string }).query?.startsWith('mutation')) };
}

async function press(detail: PluginUiTestkit, name: string) {
  await act(async () => { await detail.press(await detail.getByRole('button', { name })); });
}

describe('GitHub entry administration controls', () => {
  it('opens a merged PR revert through the registered Action and replaces the form with its new PR receipt', async () => {
    const { detail, opened, writes, settleWrite } = await mount('pull-request');
    await press(detail, 'Revert…');
    expect((await detail.getByRole('button', { name: 'Open revert PR' })).state?.disabled).not.toBe(true);
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
    const { detail, configuredReads, opened, writes, settleWrite } = await mount('issue');
    expect(configuredReads).toHaveLength(0);
    await press(detail, 'Transfer to another repository…');
    await press(detail, 'Destination repository');
    expect(await detail.queryByText('foreign/repository')).toBeUndefined();
    await act(async () => { await detail.press(await detail.getByRole('menuitemradio', { name: 'next/destination' })); });
    await act(async () => { await detail.press(await detail.getByRole('switch', { name: 'Create missing labels' })); });
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
    const { detail, writes, settleWrite } = await mount('issue');
    await press(detail, 'Delete issue…');
    await expect(detail.getByText('Delete #7 · Keep one normalization owner')).resolves.toBeDefined();
    await expect(detail.getByText('This permanently deletes the issue and its comments on GitHub. It cannot be undone.')).resolves.toBeDefined();
    await press(detail, 'Delete issue');
    await settleWrite();
    expect(writes()).toHaveLength(1);
    await expect(detail.getByText('Deleted on GitHub')).resolves.toBeDefined();
    expect(await detail.queryByRole('button', { name: 'Delete issue' })).toBeUndefined();
  });

  it('keeps a refused revert editable and never claims a created PR', async () => {
    const { detail, writes, settleWrite } = await mount('pull-request', true, true);
    await press(detail, 'Revert…');
    await press(detail, 'Open revert PR');
    await settleWrite();
    expect(writes()).toHaveLength(1);
    expect(await detail.queryByText('Opened #1300')).toBeUndefined();
    expect((await detail.getByRole('button', { name: 'Open revert PR' })).state?.disabled).not.toBe(true);
  });
});
