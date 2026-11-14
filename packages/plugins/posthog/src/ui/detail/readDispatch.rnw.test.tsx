// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { POSTHOG_PLUGIN_ID, POSTHOG_ACTION_IDS, POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../../posthogContracts.js';
import { encodePosthogConfiguration } from '../../source/instance.js';
import { PosthogIssueActivityInputV1Schema, PosthogIssueActivityResultV1Schema } from '../../source/detail/issueActivityContract.js';
import { POSTHOG_ISSUE_EVENTS_MAX_LIMIT } from '../../api/types/events.js';
import activityPage from '../../api/__fixtures__/issueActivityPage.json' with { type: 'json' };
import sampledPage from '../../api/__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(async () => { await surface.dispose(); });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});
const account = { service: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }, accountId: 'account-1' };
function launchInput() {
  const encoded = encodePosthogConfiguration({ v: 1, organizationUuid: '00000000-0000-4000-8000-0000000000a1',
    environments: [{ teamPathId: 4821, teamUuid: '00000000-0000-4000-8000-0000000000d1', displayName: 'Storefront' }],
    scanWindowPolicy: { kind: 'exact', from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' },
    detailWindowPolicy: { kind: 'exact', from: '2026-07-16T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' } });
  if (!encoded.ok) throw new Error('Expected valid configuration');
  const source = { pluginId: POSTHOG_PLUGIN_ID, localId: 'posthog-error-tracking' };
  return TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel: 'activity',
    instance: { v: 1, instance: { source, sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
      binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account },
      localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1', configuration: { v: 1, token: encoded.token } },
    observation: { entryRef: { source, kindId: 'error-issue', collisionScope: 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1', entryId: '00000000-0000-4000-8000-000000000001' },
      observedAtMs: 1_760_000_700_000, locator: { v: 1 }, snapshot: { v: 1, title: 'Read dispatch', scopeLabel: 'Storefront', state: { presentation: 'active', nativeLabel: 'Active' }, facts: [] }, viewer: { involvement: [] } }, linkedSessions: [] });
}
async function mountRegisteredActivity(misbind = false, status = 200) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
    connectedAccounts: {
      async listAccounts() { return { status: 'complete', accounts: [{ account, displayName: 'PostHog', state: 'connected', connectedAccountOrigins: ['https://eu.posthog.com'], connectedAccountBases: ['https://eu.posthog.com'] }] }; },
      async materializeListedAccount() { return { kind: 'httpHeaders', headers: { authorization: 'Bearer test-only-placeholder' } }; },
    },
    http: { async request(request) {
      requests.push(request.url);
      if (request.url.includes('/activity/')) await pending;
      if (status !== 200) return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode('{}') };
      const body = request.url.includes('/activity/') ? { ...activityPage, next: null } : sampledPage;
      return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
    } },
  } });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  const readRequestIds: string[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({ identity: { instanceId: 'posthog-dispatch', mountNonce: 'posthog-dispatch-mount' },
      authorPlugin: { id: POSTHOG_PLUGIN_ID, version: '0.0.0' }, surface: defineUiSurface(context => {
        const body = renderSurface({ ...context, launchInput: launchInput() });
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected native detail');
        return body;
      }), launchInput: launchInput(), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input, requestId, signal }) => {
        if (typeof action === 'string' || action.pluginId !== POSTHOG_PLUGIN_ID || input === undefined) throw new Error('Wrong Action owner');
        const activity = action.localId === POSTHOG_ACTION_IDS.issueActivity;
        const request = misbind && activity ? PosthogIssueActivityInputV1Schema.parse(input) : null;
        const result = await plugin.invokeAction(request === null ? action.localId : POSTHOG_ACTION_IDS.issueEvents,
          request === null ? input : { v: 1, instance: request.instance, localRef: request.localRef, limit: POSTHOG_ISSUE_EVENTS_MAX_LIMIT }, { surface: 'ui', signal, requestId });
        if (activity) { producerResults.push(result); readRequestIds.push(requestId); }
        return result;
      } },
    });
  });
  mounted.push(detail);
  return { detail, requests, producerResults, readRequestIds, release };
}
describe('registered PostHog activity read dispatch', () => {
  it('shows the registered HTTP failure code and issued request identity in Details', async () => {
    const { detail, producerResults, readRequestIds, release } = await mountRegisteredActivity(false, 429);
    await act(async () => { release(); });
    await vi.waitFor(() => expect(producerResults).toHaveLength(1));
    expect(PosthogIssueActivityResultV1Schema.parse(producerResults[0])).toMatchObject({ kind: 'unavailable', failure: { class: 'rateLimit', code: 'posthog/rate-limited', requestId: readRequestIds[0] } });
    await expect(detail.getByText('posthog/rate-limited')).resolves.toBeDefined();
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Details' })); });
    await expect(detail.getByText('Code')).resolves.toBeDefined();
    await expect(detail.getByText('Request ID')).resolves.toBeDefined();
    await expect(detail.getByText(readRequestIds[0]!)).resolves.toBeDefined();
  });
  it('retains pending and settled activity across equivalent parsed launch input', async () => {
    const { detail, requests, producerResults, release } = await mountRegisteredActivity();
    expect(requests.some(url => url.includes('/activity/'))).toBe(true);
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { release(); });
    expect(producerResults).toHaveLength(1);
    expect(PosthogIssueActivityResultV1Schema.parse(producerResults[0])).toMatchObject({ kind: 'activity', records: [{ actor: 'Dana Okafor' }, { isSystem: true }] });
    await expect(detail.getByText('Dana Okafor')).resolves.toBeDefined();
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await expect(detail.getByText('Dana Okafor')).resolves.toBeDefined();
    expect(producerResults).toHaveLength(1);
  });
  it('rejects a mis-bound registered producer', async () => {
    const { detail, producerResults } = await mountRegisteredActivity(true);
    expect(producerResults).toHaveLength(1);
    expect(PosthogIssueActivityResultV1Schema.safeParse(producerResults[0]).success).toBe(false);
    await expect(detail.getByText('posthog/activity-result-unreadable')).resolves.toBeDefined();
  });
});
