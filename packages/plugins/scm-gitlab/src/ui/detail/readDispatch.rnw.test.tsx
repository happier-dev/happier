// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { describeTriageSourceFailureV1, TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITLAB_PLUGIN_ID, GITLAB_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/contribution.js';
import { GitlabChangesInputV1Schema, GitlabChangesResultV1Schema } from '../../triage/detail/contracts.js';
import { createStubGitlabTransport, gitlabTestConfiguredInstance, GITLAB_TEST_COLLISION_SCOPE } from '../../triage/testkit/gitlabTriage.test-support.js';
import { renderSurface } from '../renderSurface.js';

/** A Files row names itself by its path (its title is middle-ellipsized, so the path is not one text node). */
async function fileShown(detail: PluginUiTestkit, path: string, settle = true): Promise<boolean> {
  for (let turn = 0; ; turn += 1) {
    const shown = (await detail.queryAllByRole('button')).some(button => button.name?.startsWith(path));
    if (shown || !settle || turn >= 20) return shown;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(async () => { await surface.dispose(); });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});
type DetailPanel = 'overview' | 'activity' | 'files' | 'checks' | 'actions';

function launchInput(panel: DetailPanel) {
  const instance = gitlabTestConfiguredInstance();
  return TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel, instance,
    observation: { entryRef: { source: instance.instance.source, kindId: 'merge-request', collisionScope: GITLAB_TEST_COLLISION_SCOPE, entryId: '412' },
      observedAtMs: 1_760_000_700_000, locator: { v: 1, routingToken: 'group/project' },
      snapshot: { v: 1, title: 'Read dispatch', scopeLabel: 'group/project', state: { presentation: 'active', nativeLabel: 'Opened' }, facts: [] }, viewer: { involvement: [] } }, linkedSessions: [] });
}
async function mountRegisteredChanges(
  misbind: false | 'approvals' | 'comparison' = false,
  status: number | 'transport' | 'invalidJson' | 'invalidShape' = 200,
  panel: DetailPanel = 'files',
) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const transport = createStubGitlabTransport({ respond: request => {
    if (status === 'transport') throw new Error('Network unavailable');
    if (status === 'invalidJson') return { status: 200, bodyText: '{' };
    if (status === 'invalidShape') return { status: 200, body: {} };
    if (status !== 200) return { status, body: {} };
    if (request.url.includes('/diffs')) return { status: 200, body: [{ old_path: 'src/dispatch.ts', new_path: 'src/dispatch.ts', new_file: false, renamed_file: false, deleted_file: false }] };
    if (request.url.endsWith('/approvals')) return { status: 200, body: { approvals_required: 1, approvals_left: 1, approved_by: [] } };
    if (request.url.endsWith('/approval_rules')) return { status: 200, body: [] };
    const path = new URL(request.url).pathname;
    if (path.endsWith('/user')) return { status: 200, body: { id: 18, username: 'viewer' } };
    if (/\/(notes|discussions|pipelines|resource_(state|label|milestone)_events)$/u.test(path)) return { status: 200, body: [] };
    if (request.url.endsWith('/merge_requests/412')) return { status: 200, body: {
      project_id: 3, iid: 412, references: { full: 'group/project!412' }, sha: 'c'.repeat(40), changes_count: '1',
      diff_refs: { base_sha: 'a'.repeat(40), start_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) },
    } };
    throw new Error(`Unexpected GitLab route: ${request.url}`);
  } });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
    connectedAccounts: transport.context.services.connectedAccounts,
    http: { ...transport.context.services.http, request: async (request, options) => {
      await pending;
      return transport.context.services.http.request(request, options);
    } },
  } });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  const actions: string[] = [];
  const issuedRequestIds: string[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({ identity: { instanceId: 'gitlab-dispatch', mountNonce: 'gitlab-dispatch-mount' },
      authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface(context => {
        const body = renderSurface({ ...context, launchInput: launchInput(panel) });
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected native detail');
        return body;
      }), launchInput: launchInput(panel), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input, requestId }) => {
        if (typeof action === 'string' || action.pluginId !== GITLAB_PLUGIN_ID || input === undefined) throw new Error('Wrong Action owner');
        issuedRequestIds.push(requestId);
        actions.push(action.localId);
        const changes = action.localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges;
        const request = misbind && changes ? GitlabChangesInputV1Schema.parse(input) : null;
        const result = await plugin.invokeAction(request === null || misbind === 'comparison' ? action.localId : GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals,
          request === null ? input : misbind === 'comparison' ? { ...request, comparison: true }
            : { v: 1, instance: request.instance, localRef: request.localRef, routingToken: request.routingToken }, { surface: 'ui', requestId });
        if (changes) producerResults.push(result);
        return result;
      } },
    });
  });
  mounted.push(detail);
  return { detail, producerResults, release, issuedRequestIds, actions, requests: transport.requests };
}
describe('registered GitLab detail read dispatch', () => {
  it.each([
    ['overview', [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges, GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines]],
    ['files', [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges]],
    ['checks', [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines]],
    ['activity', [
      GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes, GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions,
      GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents, GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents,
      GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents, GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals,
    ]],
    ['actions', []],
  ] as const)('keeps the opened GitLab merge request %s reads scoped to the mounted surface', async (panel, panelActions) => {
    const { detail, release, actions, requests } = await mountRegisteredChanges(false, 200, panel);
    await act(async () => { release(); });
    // The admitted Overview seed is intentionally absent in this fixture.
    const expected = [GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview, ...panelActions].sort();
    expect([...actions].sort()).toEqual(expected);
    expect(requests.length).toBeGreaterThanOrEqual(actions.length);
    const openedRequests = requests.length;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { await detail.retire(); });
    expect([...actions].sort()).toEqual(expected);
    expect(requests).toHaveLength(openedRequests);
  });

  it.each([
    [429, 'rateLimit', 'too-many-requests'],
    ['transport', 'transient', 'transport-failed'],
    ['invalidJson', 'unsupportedContract', 'undecodable-body'],
    ['invalidShape', 'unsupportedContract', 'gitlab-detail-response-invalid'],
  ] as const)('shows the registered provider %s failure code and the actual read request identity in Details', async (status, failureClass, code) => {
    const { detail, producerResults, release, issuedRequestIds } = await mountRegisteredChanges(false, status);
    await act(async () => { release(); });
    expect(GitlabChangesResultV1Schema.parse(producerResults[0])).toMatchObject({ kind: 'unavailable', failure: { class: failureClass, code, requestId: issuedRequestIds[0] } });
    const details = await detail.getByRole('button', { name: 'Details' });
    await act(async () => { await detail.press(details); });
    await expect(detail.getByText('Code')).resolves.toBeDefined();
    await expect(detail.getByText('Request ID')).resolves.toBeDefined();
    await expect(detail.getByText(issuedRequestIds[0]!)).resolves.toBeDefined();
  });
  it('retains pending and settled changes across equivalent parsed launch input', async () => {
    const { detail, producerResults, release } = await mountRegisteredChanges();
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { release(); });
    expect(producerResults).toHaveLength(1);
    expect(GitlabChangesResultV1Schema.parse(producerResults[0])).toMatchObject({ kind: 'changes', rows: [{ path: 'src/dispatch.ts' }] });
    expect(await fileShown(detail, 'src/dispatch.ts')).toBe(true);
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(await fileShown(detail, 'src/dispatch.ts')).toBe(true);
    expect(producerResults).toHaveLength(1);
  });
  it.each(['approvals', 'comparison'] as const)('rejects a mis-bound registered %s producer', async (mode) => {
    const { detail, producerResults, release } = await mountRegisteredChanges(mode);
    await act(async () => { release(); });
    expect(producerResults).toHaveLength(1);
    expect(GitlabChangesResultV1Schema.safeParse(producerResults[0]).success).toBe(mode === 'comparison');
    await expect(detail.getByText(describeTriageSourceFailureV1({ class: 'unsupportedContract', code: 'gitlab-detail-result-unreadable' }, 'GitLab could not complete this read.'))).resolves.toBeDefined();
  });
});
