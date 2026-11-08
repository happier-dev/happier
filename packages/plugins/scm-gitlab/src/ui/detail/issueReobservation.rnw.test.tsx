// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  TriageDetailSurfaceInputV1JsonSchema, TriageDetailSurfaceInputV1Schema, TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
  TriageReadFixPullRequestsInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITLAB_PLUGIN_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_TRIAGE_ACTION_IDS,
  GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1, GITLAB_TRIAGE_MUTATION_ACTION_IDS } from '../../triage/contribution.js';
import { createStubGitlabTransport, gitlabTestConfiguredInstance,
  GITLAB_TEST_COLLISION_SCOPE } from '../../triage/testkit/gitlabTriage.test-support.js';
import issues from '../../triage/__fixtures__/issueList.json' with { type: 'json' };
import { renderSurface } from '../renderSurface.js';
import { useTriagePostMutationRow } from '../../../../triage/src/ui/detail/useTriagePostMutationRow.js';
import { TriageDetailRegion } from '../../../../triage/src/ui/detail/region.js';
import { projectTriageWindowRow } from '../../../../triage/src/ui/marks/pinnedRows.js';
import { TRIAGE_UNREAD_ACTIONS_V1 } from '../../../../triage/src/ui/actions/actionsCommand.js';
import type { TriageMountedActionsV1 } from '../../../../triage/src/ui/actions/useTriageActions.js';
import { reobserveTriageEntry } from '../../../../triage/src/actions/reobserveEntry.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryInputV1Schema } from '../../../../triage/src/actions/reobserveEntryProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailInputV1Schema } from '../../../../triage/src/actions/entryDetailProtocol.js';
import { readTriageEntryDetail } from '../../../../triage/src/actions/readEntryDetail.js';
import type { TriageAdmittedSourceV1 } from '../../../../triage/src/actions/listEntries.js';
import type { TriageDataActionContext } from '../../../../triage/src/actions/dataContext.js';
import { createTriageReadFixPullRequestsActionHandler } from '../../../../triage/src/actions/fixPullRequests.js';
import { createTriageReadTaskOriginErrorActionHandler } from '../../../../triage/src/actions/taskOrigin.js';
import { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageReadTaskOriginErrorInputV1Schema } from '../../../../triage/src/actions/taskOriginProtocol.js';
import { toTriageWireObservation } from '../../../../triage/src/projection/listWindowWire.js';
import { createTestkitCorpusCollections } from '../../../../triage/src/corpus/testkit/corpusCollections.test-support.js';
import { administerConfiguredSourceInstance } from '../../../../triage/src/corpus/configuration/administerConfiguredSourceInstance.js';
import { createTestkitSourceSessionRelations } from '../../../../triage/src/sessions/testkit/entrySessionTestkit.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from '../../../../triage/src/ui/window/ephemeralSharedScope.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the composed GitLab issue write and exact-read owner', () => {
  it('updates the mounted Overview and inverse operand after a confirmed native assignee write', async () => {
    const route = 'example-group/example-subgroup/example-project';
    const instance = gitlabTestConfiguredInstance({ locator: { v: 1, displayLabel: 'GitLab.com' } });
    const source = instance.instance.source;
    const entryRef = { source, kindId: 'issue', collisionScope: GITLAB_TEST_COLLISION_SCOPE, entryId: '7' };
    const selection = { sectionId: null, entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
    const before = '2026-08-09T15:31:51.081Z';
    const after = '2026-08-09T15:31:51.082Z';
    let changed = false;
    let removed = false;
    const completeBody = `${'The confirmed issue description is complete.\n\n'.repeat(240)}End of confirmed issue description.`;
    const transport = createStubGitlabTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v4/user') return { status: 200, body: { id: 18, username: 'example-author' } };
      if (path.endsWith('/issues/7') && request.method === 'GET') return { status: 200, body: {
        ...issues[0], updated_at: changed ? after : before,
        description: changed ? completeBody : 'The original issue description.',
        assignees: changed ? [{ username: 'example-assignee' }, { username: 'concurrent-assignee' },
          ...(removed ? [] : [{ username: 'our-assignee' }])] : issues[0]!.assignees,
        labels: changed ? ['bug', 'frontend', 'concurrent-label'] : ['bug', 'frontend'],
      } };
      if (path === '/api/graphql' && request.method === 'POST') {
        const body = JSON.parse(request.body!) as { variables: { operationMode: string } };
        changed = true;
        removed = body.variables.operationMode === 'REMOVE';
        return { status: 200, body: { data: { issueSetAssignees: { errors: [] } } } };
      }
      return undefined;
    } });
    const gitlab = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount },
      services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts } });
    const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
    const target = { pluginId: 'happier.triage', occurrenceId: 'triage-issue', sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } };
    const contributor = { pluginId: source.pluginId, contributionId: source.localId, occurrenceId: 'gitlab-issue',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'gitlab-root' } };
    const point = { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol };
    const get = { point, contributor, role: 'get', action: { pluginId: source.pluginId, localId: GITLAB_TRIAGE_ACTION_IDS.get } };
    const detailSurface = { point, contributor, role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1, presentation: 'content' as const };
    // Opaque host admission and Account storage are the boundaries. The registered
    // Actions, exact read, publication, detail composition and native UI stay real.
    const admitted = [{ contributor, descriptor: GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1,
      operations: { get } }] as unknown as readonly TriageAdmittedSourceV1[];
    const corpus = createTestkitCorpusCollections();
    const { instance: _instanceRef, ...draft } = instance;
    await administerConfiguredSourceInstance({ collections: corpus.collections, source,
      declaredPurpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, request: { kind: 'create', draft }, nowMs: 1,
      mintSourceInstanceId: () => instance.instance.sourceInstanceId });
    const relations = createTestkitSourceSessionRelations({ collections: corpus.collections, contributions: admitted });
    const catalog: TriageMountedActionsV1 = { read: TRIAGE_UNREAD_ACTIONS_V1, revision: null, actions: [],
      loaded: false, busy: false, notice: null, unavailableReason: null, retry() {},
      resolveForExecution: async () => ({ status: 'missing' }), administer: async () => null };
    const lanes = Object.freeze([]);
    function OpenIssue() {
      const detail = useTriagePostMutationRow(null, lanes, selection);
      const [tab, setTab] = React.useState('overview');
      if (detail.row === null) return null;
      return <><Button title="Refresh issue" onPress={detail.completePostMutation} />
        <TriageDetailRegion row={detail.row} rows={[detail.row]} lanes={lanes}
          completePostMutation={detail.completePostMutation} exactRead={detail.exactRead} connectionLabel="GitLab fixture"
          target={{ kind: 'entry', ...selection }} actions={catalog} originComposer={null}
          pin={{ row: projectTriageWindowRow(detail.row, new Map()), handlers: { busyKey: null, unavailableReason: null, onSetPinned() {} } }}
          tabSelection={{ value: tab, onChange: setTab }}
          sessionSelection={{ value: null, onChange() {}, onAvailableSessionsChange() {}, onLoadMore() {} }} /></>;
    }
    let context!: Parameters<typeof renderSurface>[0];
    const surface = defineUiSurface(renderContext => { context = renderContext; return <OpenIssue />; });
    const contributorManifest = definePlugin({ id: source.pluginId, version: '1.0.0',
      ui: { renderers: [{ id: 'source-detail', kind: 'declarative', root: { kind: 'text', text: 'Host renderer placeholder' } }] } }).manifest;
    const mount = { kind: 'targetedSurface', target, point, contributor,
      role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1, presentation: 'content', inputSchema: TriageDetailSurfaceInputV1JsonSchema,
      rendererChain: [{ pluginId: source.pluginId, localId: 'source-detail' }],
      selectedRenderer: { identity: { pluginId: source.pluginId, localId: 'source-detail' },
        renderer: { kind: 'declarative', contributionId: 'source-detail', model: {
          identity: { pluginId: source.pluginId, localId: 'source-detail', qualifiedId: `${source.pluginId}/source-detail`, occurrenceId: contributor.occurrenceId },
          visible: true, requiredHostMethods: [], declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
          root: { kind: 'text', path: 'root', order: 0, text: 'Host renderer placeholder' } } },
        availability: { state: 'available', reason: 'available', diagnostics: [] } },
      executionOrigin: { serverIdentityId: 'srv_test', materializationRef: { machineId: 'machine-test', materializationId: 'gitlab-issue', pluginId: source.pluginId } },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: { target: { pluginId: source.pluginId, occurrenceId: contributor.occurrenceId, sourceCustody: contributor.sourceCustody }, points: [] } };
    const operands: unknown[] = [];
    const mountedSourceUpdates: unknown[] = [];
    let shell: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => {
        shell = await createPluginUiTestkit({ identity: { instanceId: 'composed-gitlab-issue', mountNonce: 'composed-gitlab-issue' },
          authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
          surfaceContext: createSurfaceContextFixture({ targetedContributions: { target, points: [{ pointId: point.pointId,
            protocols: [{ protocol, contributions: [{ contributor, protocol, descriptor: GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1,
              operations: [get], surfaces: [detailSurface] }] }] }] } }),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(), sessions: true, overlays: true,
            targetedSurfaces: { readCurrentMounts: () => [mount], readContributorManifest: () => contributorManifest,
              renderAdmittedContent: ({ launchInput }) => {
                mountedSourceUpdates.push(TriageDetailSurfaceInputV1Schema.parse(launchInput).observation.sourceUpdatedAtMs);
                return renderSurface({ ...context, launchInput, activity: { active: true } }) as React.ReactElement;
              } } }),
          handlers: { executeAction: async request => {
            if (typeof request.action !== 'string' && request.action.pluginId === GITLAB_PLUGIN_ID) {
              if (request.action.localId === GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign) operands.push(request.input);
              return gitlab.invokeAction(request.action.localId, request.input!, { surface: 'ui', signal: request.signal });
            }
            const id = typeof request.action === 'string' ? request.action : request.action.localId;
            const accountContext = { signal: request.signal, invokedAtMs: 3, surface: 'ui', services: {
              storage: { account: { collection: (definition: { id: string }) => definition.id === 'source-instances'
                ? corpus.collections.sourceInstances : definition.id === 'session-links' ? corpus.collections.sessionLinks : corpus.collections.userMarks } },
              targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: admitted }), dispose() {} }) },
            } } as unknown as TriageDataActionContext;
            if (id === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
              const input = TriageReobserveEntryInputV1Schema.parse(request.input);
              const result = await reobserveTriageEntry({ ...input, lastKnownLocator: { v: 1, routingToken: route } }, {
                readConfiguredInstance: async () => instance, readAdmittedSources: async () => admitted, signal: request.signal,
                executeGet: async (_operation, getInput, options) => gitlab.invokeAction(GITLAB_TRIAGE_ACTION_IDS.get, getInput,
                  { surface: 'ui', signal: options?.signal }), nowMs: () => Date.now() });
              if (result.kind !== 'observed') return result;
              const { entryRef: ref, ...observation } = result.observation;
              return { ...result, entryRef: ref, observation: toTriageWireObservation(observation) };
            }
            if (id === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) return readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(request.input),
              { sourceRelations: relations, readSessionSummary: async () => null, signal: request.signal });
            if (id === TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1) return createTriageReadFixPullRequestsActionHandler()(
              TriageReadFixPullRequestsInputV1Schema.parse(request.input), accountContext);
            if (id === TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1) return createTriageReadTaskOriginErrorActionHandler()(
              TriageReadTaskOriginErrorInputV1Schema.parse(request.input), accountContext);
            throw new Error(`Unexpected composed GitLab Action: ${id}`);
          } } });
      });
      await shell!.getByText('The original issue description.');
      await act(async () => { await shell!.press(await shell!.getByRole('button', { name: 'More actions' })); });
      await act(async () => { await shell!.press(await shell!.getByRole('menuitem', { name: 'Change on GitLab' })); });
      await shell!.getByRole('textbox', { label: 'Assignee username' });
      await act(async () => {
        const field = document.querySelector<HTMLInputElement>('input[aria-label="Assignee username"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'our-assignee');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { await shell!.press(await shell!.getByRole('button', { name: 'Add assignees' })); });
      await vi.waitFor(() => expect(changed).toBe(true));
      await vi.waitFor(() => expect(mountedSourceUpdates).toContain(Date.parse(after)));
      await vi.waitFor(() => expect(document.body.textContent?.includes('End of confirmed issue description.')).toBe(true));
      expect(document.body.textContent).toContain('concurrent-label');
      await act(async () => { await shell!.press(await shell!.getByRole('button', { name: 'Remove assignees' })); });
      await vi.waitFor(() => expect(removed).toBe(true));
      expect(operands).toMatchObject([{ observedRevision: before, operation: 'add' }, { observedRevision: after, operation: 'remove' }]);
      expect(transport.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    } finally { await act(async () => { await shell?.dispose(); }); await gitlab.dispose(); }
  }, 30_000);
});
