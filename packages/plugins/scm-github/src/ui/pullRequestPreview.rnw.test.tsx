// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../triage/contribution.js';
import {
  OBSERVED_HEAD,
  previewStatusInput,
  previewStatusTransport,
} from '../triage/testkit/githubMutation.test-support.js';
import { renderSurface } from './renderSurface.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Awaited<ReturnType<typeof createPluginTestkit>>[] = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(() => surface.dispose());
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

const SHA = OBSERVED_HEAD.slice(0, 7);

/** The PR Overview, mounted over the real plugin Actions; only GitHub HTTP and Home Actions are stubbed. */
async function mountOverview(
  options: Parameters<typeof previewStatusTransport>[0],
  serverId: string | null = 'srv_preview',
) {
  const transport = previewStatusTransport({
    pullRequestState: 'open',
    ...options,
  });
  const plugin = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate, activateAccount },
    services: transport.context.services,
  });
  plugins.push(plugin);
  const publication = previewStatusInput();
  const request = {
    v: 1,
    instance: publication.instance,
    localRef: publication.localRef,
    routingToken: publication.routingToken,
  };
  const input = TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    panel: 'overview',
    instance: publication.instance,
    observation: {
      entryRef: {
        source: publication.instance.instance.source,
        ...publication.localRef,
      },
      observedAtMs: 1,
      locator: { v: 1, routingToken: publication.routingToken },
      snapshot: {
        v: 1,
        title: 'Keep the cart after sign-in',
        scopeLabel: 'octo-org/example-app',
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts: [],
        reviewRevision: {
          headSha: OBSERVED_HEAD,
          baseSha: 'a'.repeat(40),
          nativeRevision: OBSERVED_HEAD,
        },
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
  const previewReads: unknown[] = [];
  const opened: unknown[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: 'pr-preview', mountNonce: 'pr-preview-mount' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      launchInput: input,
      surfaceContext: {
        ...createSurfaceContextFixture(),
        ...(serverId === null
          ? {}
          : { accountScope: { serverId, accountId: 'preview-owner' } }),
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        openDeployment: ({ request }) => { opened.push(request); },
        executeAction: async ({ action, input: actionInput, signal }) => {
          if (typeof action === 'string' || actionInput === undefined)
            throw new Error('Expected registered GitHub Action');
          if (action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readPreview)
            previewReads.push(actionInput);
          return plugin.invokeAction(action.localId, actionInput, {
            surface: 'ui',
            signal,
          });
        },
      },
    });
  });
  mounted.push(detail);
  // The agent path: the same registered Action, with the same exact entry and Home.
  const agentRead = () =>
    plugin.invokeAction(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readPreview, {
      ...request,
      serverId: 'srv_preview',
    });
  return { detail, previewReads, agentRead, opened };
}

describe('the PR Overview Preview step', () => {
  it('shows a ready preview with the owner URL, from one read the agent makes too', async () => {
    const { detail, previewReads, agentRead } = await mountOverview({
      operation: 'deploy',
      domainState: 'active',
      domainPath: '/app',
    });
    await vi.waitFor(() => detail.getByText(`Deployed ${SHA}`));
    await vi.waitFor(() => detail.getByText('https://pr-1284.example.test/app'));
    expect(previewReads).toHaveLength(1);
    expect(await agentRead()).toMatchObject({ kind: 'preview', previews: [{ state: 'ready', targetUrl: 'https://pr-1284.example.test/app' }] });
  });

  it('says a preview is deploying and gives no address yet', async () => {
    const { detail, agentRead } = await mountOverview({
      operation: 'deploy',
      receiptState: 'running',
      domainState: 'active',
    });
    await vi.waitFor(() => detail.getByText(`Deploying ${SHA}`));
    await expect(
      detail.getByText('https://pr-1284.example.test'),
    ).rejects.toThrow();
    expect(await agentRead()).toMatchObject({ kind: 'preview', previews: [{ state: 'deploying', targetUrl: null }] });
  });

  it('says the last run failed', async () => {
    const { detail, agentRead } = await mountOverview({
      operation: 'deploy',
      receiptState: 'failed',
    });
    await vi.waitFor(() => detail.getByText('Last run failed'));
    expect(await agentRead()).toMatchObject({ kind: 'preview', previews: [{ state: 'failed' }] });
  });

  it('says a preview cleaned up after the pull request is removed', async () => {
    const { detail, agentRead } = await mountOverview({});
    await vi.waitFor(() => detail.getByText('Removed'));
    expect(await agentRead()).toMatchObject({ kind: 'preview', previews: [{ state: 'removed' }] });
  });

  it('keeps a ready preview beside a sibling that could not be read', async () => {
    const { detail, agentRead } = await mountOverview({ operation: 'deploy', domainState: 'active',
      multiplePreviews: true, unavailableFirstPreview: true });
    await vi.waitFor(() => detail.getByText('2 previews'));
    await vi.waitFor(() => detail.getByText('https://second.example.test/'));
    await vi.waitFor(() => detail.getByText('Unavailable'));
    expect(await agentRead()).toMatchObject({ kind: 'preview', previews: [{ kind: 'unavailable' }, { state: 'ready' }] });
  });

  it('opens a failed deploy\'s receipt in Happier', async () => {
    const { detail, opened } = await mountOverview({ operation: 'deploy', receiptState: 'failed' });
    await detail.press(await vi.waitFor(() => detail.getByRole('button', { name: 'Open receipt' })));
    expect(opened).toEqual([{ environmentId: 'preview-child', receiptId: 'preview-teardown', serverId: 'srv_preview' }]);
  });

  it('says cleanup stopped and retries it at the Environment', async () => {
    const { detail, opened, agentRead } = await mountOverview({ receiptState: 'failed', pullRequestState: undefined });
    await vi.waitFor(() => detail.getByText('Cleanup stopped'));
    await detail.press(await detail.getByRole('button', { name: 'Retry cleanup' }));
    expect(opened).toEqual([{ environmentId: 'preview-child', serverId: 'srv_preview' }]);
    expect(await agentRead()).toMatchObject({ previews: [{ operation: 'teardown', state: 'failed' }] });
  });

  it('offers Clean up for a closed pull request whose preview is still up', async () => {
    const { detail, opened } = await mountOverview({ operation: 'deploy', domainState: 'active', pullRequestState: undefined });
    await detail.press(await vi.waitFor(() => detail.getByRole('button', { name: 'Clean up' })));
    expect(opened).toEqual([{ environmentId: 'preview-child', serverId: 'srv_preview' }]);
  });

  it('links a removed preview to its History', async () => {
    const { detail, opened } = await mountOverview({});
    await detail.press(await vi.waitFor(() => detail.getByRole('button', { name: 'History' })));
    expect(opened).toEqual([{ environmentId: 'preview-child', tab: 'history', serverId: 'srv_preview' }]);
  });

  it('does not read a preview without an active Home', async () => {
    const { detail, previewReads } = await mountOverview(
      { operation: 'deploy', domainState: 'active' },
      null,
    );
    await vi.waitFor(() => detail.getByText('The ask'));
    expect(previewReads).toHaveLength(0);
  });
});
