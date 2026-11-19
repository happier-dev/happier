// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createPluginUiActionControlTestHost,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1, GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../triage/contribution.js';
import { GithubPreviewResultV1Schema } from '../triage/detail/contracts.js';
import {
  OBSERVED_HEAD,
  previewStatusInput,
  previewStatusTransport,
} from '../triage/testkit/githubMutation.test-support.js';
import { renderSurface } from './renderSurface.js';
import type { PluginUiResourceReference } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';

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
  directTabs = false,
  settlement?: PluginUiActionControlExecution,
) {
  const transportOptions = {
    pullRequestState: 'open',
    ...options,
  } satisfies Parameters<typeof previewStatusTransport>[0];
  const transport = previewStatusTransport(transportOptions);
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
    ...(directTabs ? {} : { panel: 'overview' }),
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
  const previewRequestIds: string[] = [];
  const resourceReads: unknown[] = [];
  let resourceReference: PluginUiResourceReference | undefined;
  let digest = `sha256:${'1'.repeat(64)}`;
  const opened: unknown[] = [];
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    if (typeof action === 'string' || action.localId !== GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus || input === undefined)
      throw new Error('Expected the declared Preview publication Action with prepared input');
    return settlement ?? { ok: true, result: await plugin.invokeAction(action.localId, input, { surface: 'ui' }) };
  });
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: 'pr-preview', mountNonce: 'pr-preview-mount' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      launchInput: input,
      surfaceContext: {
        ...createSurfaceContextFixture(),
        ...(directTabs ? { page: { columnVisible: true, navigation: {
          pageKind: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-detail/pull-request' },
          presentation: 'top', tabIds: ['overview', 'files'],
        } } } : {}),
        ...(serverId === null
          ? {}
          : { accountScope: { serverId, accountId: 'preview-owner' } }),
      },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        actionControl: controls.handler,
        readResource: async ({ resource }) => {
          resourceReads.push(resource);
          return { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ digest })), digest };
        },
        watchResource: async ({ resource }) => {
          if (typeof resource !== 'string' && 'readAuthority' in resource)
            throw new Error('Expected the Preview receipt Resource watch');
          resourceReference = resource;
          return { digest };
        },
        openDeployment: ({ request }) => { opened.push(request); },
        executeAction: async ({ action, input: actionInput, signal, requestId }) => {
          if (typeof action === 'string' || actionInput === undefined)
            throw new Error('Expected registered GitHub Action');
          if (action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus)
            throw new Error('Person writes must use the host Action control');
          if (action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readPreview) {
            previewReads.push(actionInput);
            previewRequestIds.push(requestId);
          }
          return plugin.invokeAction(action.localId, actionInput, {
            surface: 'ui',
            signal,
            requestId,
          });
        },
      },
    });
  });
  mounted.push(detail);
  // The agent path: the same registered Action, with the same exact entry and Home.
  const agentRead = (requestId?: string) =>
    plugin.invokeAction(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readPreview, {
      ...request,
      serverId: 'srv_preview',
    }, { requestId });
  const changed = async (patch: Parameters<typeof previewStatusTransport>[0] = {}) => {
    Object.assign(transportOptions, patch);
    digest = `sha256:${'2'.repeat(64)}`;
    await act(async () => {
      if (resourceReference) detail.invalidateResource(resourceReference, digest);
    });
  };
  const lastPreviewRequestId = () => {
    const requestId = previewRequestIds.at(-1);
    if (requestId === undefined) throw new Error('Expected an issued Preview request');
    return requestId;
  };
  return { detail, controls, previewReads, agentRead, opened, resourceReads, changed, lastPreviewRequestId, requests: transport.requests };
}

describe('the PR Overview Preview step', () => {
  it('keeps the native Preview refusal and issued request identity in Details', async () => {
    const { detail, agentRead, changed, lastPreviewRequestId } = await mountOverview({ operation: 'deploy', domainState: 'active' });
    await vi.waitFor(() => detail.getByText(`Deployed ${SHA}`));
    // The deployment Resource push rereads Preview, leaving the successful Overview in place.
    await changed({ previewQueryError: 'deployment_access_denied' });
    const result = GithubPreviewResultV1Schema.parse(await agentRead(lastPreviewRequestId()));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') {
      throw new Error('Expected the registered Preview producer refusal');
    }
    expect(result.failure.requestId).toBe(lastPreviewRequestId());
    await detail.press(await vi.waitFor(() => detail.getByRole('button', { name: 'Details' })));
    await expect(detail.getByText(result.failure.code)).resolves.toBeDefined();
    await expect(detail.getByText('Request ID')).resolves.toBeDefined();
    await expect(detail.getByText(lastPreviewRequestId())).resolves.toBeDefined();
  });

  it.each([false, true])('keeps an unavailable Preview child in Details (multiple=%s)', async (multiplePreviews) => {
    const { detail, agentRead, lastPreviewRequestId } = await mountOverview({
      operation: 'deploy', domainState: 'active', unavailableFirstPreview: true, multiplePreviews,
    });
    await vi.waitFor(lastPreviewRequestId);
    const result = GithubPreviewResultV1Schema.parse(await agentRead(lastPreviewRequestId()));
    expect(result.kind).toBe('preview');
    if (result.kind !== 'preview' || result.previews[0]?.kind !== 'unavailable') {
      throw new Error('Expected the registered child read refusal');
    }
    expect(result.previews[0].failure.requestId).toBe(lastPreviewRequestId());
    await detail.press(await vi.waitFor(() => detail.getByRole('button', { name: 'Details' })));
    await expect(detail.getByText(result.previews[0].failure.code)).resolves.toBeDefined();
    await expect(detail.getByText('Request ID')).resolves.toBeDefined();
    await expect(detail.getByText(lastPreviewRequestId())).resolves.toBeDefined();
  });

  it.each(['permission', 'transport', 'malformed'] as const)('keeps a ready Preview when its publication read fails (%s) and exposes that refusal in Details', async (failure) => {
    const { detail, agentRead, changed, lastPreviewRequestId } = await mountOverview({
      operation: 'deploy', domainState: 'active',
    });
    await vi.waitFor(() => detail.getByText('https://pr-1284.example.test/'));
    await changed(failure === 'permission'
      ? { publicationReadDenied: true } : { publicationReadFailure: failure });
    const result = GithubPreviewResultV1Schema.parse(await agentRead(lastPreviewRequestId()));
    if (result.kind !== 'preview' || result.previews[0]?.kind !== 'preview'
      || result.previews[0].publication?.kind !== 'unavailable') {
      throw new Error('Expected a ready Preview with a failed publication read');
    }
    expect(result.previews[0].state).toBe('ready');
    expect(result.previews[0].publication.failure.requestId).toBe(lastPreviewRequestId());
    await detail.press(await vi.waitFor(() => detail.getByRole('button', { name: 'Details' })));
    await expect(detail.getByText(result.previews[0].publication.failure.code)).resolves.toBeDefined();
    await expect(detail.getByText('Request ID')).resolves.toBeDefined();
    await expect(detail.getByText(lastPreviewRequestId())).resolves.toBeDefined();
    expect(await detail.getByText('https://pr-1284.example.test/')).toBeDefined();
  });

  it('shows a paused controller separately from the ready app and opens its existing settings', async () => {
    const { detail, agentRead, opened, requests, changed } = await mountOverview({
      operation: 'deploy', domainState: 'active', controllerState: 'paused', existing: true,
    });
    await vi.waitFor(() => detail.getByText(`Deployed ${SHA}`));
    await vi.waitFor(() => detail.getByText('Controller paused'));
    expect(await detail.getByText('https://pr-1284.example.test/')).toBeDefined();
    expect(await agentRead()).toMatchObject({ kind: 'preview', previews: [{ state: 'ready',
      controller: { machineId: 'preview-controller', state: 'paused' } }] });
    await detail.press(await detail.getByRole('button', { name: 'Choose another controller' }));
    expect(opened).toEqual([{ environmentId: 'preview-child', tab: 'settings', serverId: 'srv_preview' }]);
    await changed({ controllerState: 'available' });
    await vi.waitFor(async () => { await expect(detail.getByText('Controller paused')).rejects.toThrow(); });
    expect(await agentRead()).toMatchObject({ previews: [{ state: 'ready', controller: { state: 'available' } }] });
    expect(await detail.getByText('https://pr-1284.example.test/')).toBeDefined();
    expect(requests.filter(request => request.method === 'POST'
      && new URL(request.url).pathname.endsWith(`/statuses/${OBSERVED_HEAD}`))).toHaveLength(0);
  });

  it('keeps unknown controller presence distinct from paused work', async () => {
    const { detail, agentRead } = await mountOverview({ operation: 'teardown', receiptState: 'running', controllerState: 'unknown' });
    await vi.waitFor(() => detail.getByText('Removing the preview'));
    await vi.waitFor(() => detail.getByText('Controller availability unknown'));
    await expect(detail.getByText('Controller paused')).rejects.toThrow();
    expect(await agentRead()).toMatchObject({ previews: [{ operation: 'teardown', state: 'deploying',
      controller: { machineId: 'preview-controller', state: 'unknown' } }] });
  });

  it('offers controller recovery for a created child before its first deployment receipt', async () => {
    const { detail, agentRead } = await mountOverview({ noReceipt: true, controllerState: 'paused' });
    await vi.waitFor(() => detail.getByText('Controller paused'));
    expect(await agentRead()).toMatchObject({ previews: [{ kind: 'unavailable',
      controller: { machineId: 'preview-controller', state: 'paused' } }] });
    expect(await detail.getByRole('button', { name: 'Choose another controller' })).toBeDefined();
  });

  it('retries the PR update while keeping the ready preview and its address', async () => {
    const { detail, requests, controls } = await mountOverview({ operation: 'deploy', domainState: 'active' });
    await vi.waitFor(() => detail.getByText(`Deployed ${SHA}`));
    await act(() => controls.press('Retry PR update'));
    await vi.waitFor(() => detail.getByText('PR updated'));
    expect(await detail.getByText('https://pr-1284.example.test/')).toBeDefined();
    expect(requests.filter(request => request.method === 'POST'
      && new URL(request.url).pathname.endsWith(`/statuses/${OBSERVED_HEAD}`))).toHaveLength(1);
  });
  it.each(['approval_rejected', 'approval_canceled'])('keeps a declined PR update quiet (%s)', async errorCode => {
    const { detail, requests, controls } = await mountOverview({ operation: 'deploy', domainState: 'active' }, 'srv_preview', false,
      { ok: false, errorCode, error: 'Confirmation declined' });
    await vi.waitFor(() => detail.getByText('PR update pending'));
    await act(() => controls.press('Retry PR update'));
    await expect(detail.getByText('PR update pending')).resolves.toBeDefined();
    expect(requests.filter(request => request.method === 'POST'
      && new URL(request.url).pathname.endsWith(`/statuses/${OBSERVED_HEAD}`))).toHaveLength(0);
  });

  it('keeps the exact domain refusal instead of reporting a successful PR update', async () => {
    const { detail, controls } = await mountOverview({ operation: 'deploy', domainState: 'active' }, 'srv_preview', false,
      { ok: true, result: { kind: 'refused', reason: 'head_advanced' } });
    await vi.waitFor(() => detail.getByText('PR update pending'));
    await act(() => controls.press('Retry PR update'));
    await expect(detail.getByText('PR update unavailable')).resolves.toBeDefined();
    await expect(detail.getByText('head_advanced')).resolves.toBeDefined();
    await expect(detail.getByText('https://pr-1284.example.test/')).resolves.toBeDefined();
  });

  it.each([
    { ok: true, result: { kind: 'uncertain' } },
    { ok: false, errorCode: 'action_outcome_unknown', error: 'Receipt unavailable', requestId: 'preview-status-uncertain' },
  ] satisfies PluginUiActionControlExecution[])('keeps an uncertain PR update distinct from a failure (%j)', async settlement => {
    const { detail, controls } = await mountOverview({ operation: 'deploy', domainState: 'active' }, 'srv_preview', false, settlement);
    await vi.waitFor(() => detail.getByText('PR update pending'));
    await act(() => controls.press('Retry PR update'));
    await expect(detail.getByText('PR update not confirmed')).resolves.toBeDefined();
    await expect(detail.getByText('https://pr-1284.example.test/')).resolves.toBeDefined();
    if (!settlement.ok) {
      await detail.press(await detail.getByRole('button', { name: 'Details' }));
      await expect(detail.getByText('preview-status-uncertain')).resolves.toBeDefined();
    }
  });

  it.each(['deploy', 'teardown'] as const)('updates a same-head %s receipt after its deployment collection changes', async operation => {
    const options: Parameters<typeof previewStatusTransport>[0] = { operation, receiptState: 'running', domainState: 'active' };
    const { detail, previewReads, changed } = await mountOverview(options);
    await vi.waitFor(() => detail.getByText(operation === 'deploy' ? `Deploying ${SHA}` : 'Removing the preview'));
    await changed({ receiptState: undefined });
    await vi.waitFor(() => detail.getByText(operation === 'deploy' ? `Deployed ${SHA}` : 'Removed'));
    expect(previewReads).toHaveLength(2);
    await changed();
    expect(previewReads).toHaveLength(2);
  });

  it('reads no previews or deployment Resource while hidden and observes current state on return', async () => {
    const { detail, previewReads, resourceReads, changed } = await mountOverview({ operation: 'deploy', receiptState: 'running', domainState: 'active' }, 'srv_preview', true);
    await vi.waitFor(() => detail.getByText(`Deploying ${SHA}`));
    await act(async () => { await detail.press(await detail.getByRole('tab', { name: 'Files' })); });
    const before = [previewReads.length, resourceReads.length];
    await changed({ receiptState: undefined });
    expect([previewReads.length, resourceReads.length]).toEqual(before);
    await act(async () => { await detail.press(await detail.getByRole('tab', { name: 'Overview' })); });
    await vi.waitFor(() => detail.getByText(`Deployed ${SHA}`));
  });
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
