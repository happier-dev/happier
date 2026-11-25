// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  TriageDetailSurfaceInputV1JsonSchema, type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { AZURE_DEVOPS_PLUGIN } from '../../../../scm-azure-devops/src/manifest.js';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS } from '../../../../scm-azure-devops/src/triage/actions.js';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, AZURE_DEVOPS_TRIAGE_DESCRIPTOR, AZURE_DEVOPS_TRIAGE_PURPOSE } from '../../../../scm-azure-devops/src/triage/descriptor.js';
import { encodeAzureSourceConfiguration } from '../../../../scm-azure-devops/src/triage/configuration.js';
import { buildAzureCollisionScope } from '../../../../scm-azure-devops/src/triage/identity.js';
import { normalizeAzureDevOpsBaseUrl } from '../../../../scm-azure-devops/src/triage/origin.js';
import { renderSurface as renderAzure } from '../../../../scm-azure-devops/src/ui/renderSurface.js';
import { GITLAB_PLUGIN } from '../../../../scm-gitlab/src/manifest.js';
import { GITLAB_TRIAGE_ACTION_IDS, GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../../../scm-gitlab/src/triage/contribution.js';
import { createStubGitlabTransport, gitlabTestConfiguredInstance, GITLAB_TEST_COLLISION_SCOPE } from '../../../../scm-gitlab/src/triage/testkit/gitlabTriage.test-support.js';
import { renderSurface as renderGitlab } from '../../../../scm-gitlab/src/ui/renderSurface.js';
import { readTriageEntryDetail } from '../../actions/readEntryDetail.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailInputV1Schema } from '../../actions/entryDetailProtocol.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryInputV1Schema } from '../../actions/reobserveEntryProtocol.js';
import { reobserveTriageEntry } from '../../actions/reobserveEntry.js';
import type { TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { toTriageWireObservation } from '../../projection/listWindowWire.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { administerConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { createTestkitSourceSessionRelations } from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { projectTriageWindowRow } from '../marks/pinnedRows.js';
import { TRIAGE_UNREAD_ACTIONS_V1 } from '../actions/actionsCommand.js';
import type { TriageMountedActionsV1 } from '../actions/useTriageActions.js';
import { TriageDetailRegion } from './region.js';
import { useTriagePostMutationRow } from './useTriagePostMutationRow.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const actions: TriageMountedActionsV1 = { read: TRIAGE_UNREAD_ACTIONS_V1, revision: null, actions: [],
  loaded: false, busy: false, notice: null, unavailableReason: null, retry() {},
  resolveForExecution: async () => ({ status: 'missing' }), administer: async () => null };
const lanes = Object.freeze([]);

function gitlabFixture() {
  const route = 'group/subgroup/project';
  let checksReads = 0;
  let reviewReads = 0;
  const transport = createStubGitlabTransport({ respond: request => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith('/user')) return { status: 200, body: { id: 41, username: 'viewer' } };
    if (path.endsWith('/merge_requests/7')) return { status: 200, body: {
      id: 700, project_id: 3, iid: 7, references: { full: route + '!7' }, title: 'Change 7',
      state: 'opened', draft: false, sha: 'a'.repeat(40), author: { username: 'author' },
      source_branch: 'feature', target_branch: 'main', detailed_merge_status: 'mergeable', reviewers: [],
    } };
    if (path.endsWith('/pipelines')) {
      // Opening row metadata asks for just the newest pipeline status.
      if (url.searchParams.get('per_page') !== '1') checksReads += 1;
      return { status: 200, body: [] };
    }
    if (path.endsWith('/approvals')) {
      reviewReads += 1;
      return { status: 200, body: { approvals_required: 1, approvals_left: 0,
        approved_by: [{ user: { username: 'reviewer-one' } }] } };
    }
    if (path.endsWith('/diffs') || path.endsWith('/notes') || path.endsWith('/discussions')) return { status: 200, body: [] };
    return { status: 403, body: {} };
  } });
  return {
    module: GITLAB_PLUGIN, descriptor: GITLAB_TRIAGE_SOURCE_DESCRIPTOR_V1, render: renderGitlab,
    get: GITLAB_TRIAGE_ACTION_IDS.get, instance: gitlabTestConfiguredInstance(),
    localRef: { kindId: 'merge-request', collisionScope: GITLAB_TEST_COLLISION_SCOPE, entryId: '7' },
    route, services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts },
    status: 'Mergeable', checks: 'No checks', body: 'Merge status: Mergeable',
    reviewer: 'reviewer-one', checksPanel: 'No pipelines', checksReads: () => checksReads, reviewReads: () => reviewReads,
  };
}

function azureFixture() {
  const base = 'https://dev.azure.com/QACollection';
  let checksReads = 0;
  const normalized = normalizeAzureDevOpsBaseUrl(base);
  if (!normalized.ok) throw new Error('Invalid Azure fixture base');
  const repository = { id: 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b', name: 'gateway',
    project: { id: '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d', name: 'Payments' } };
  const collisionScope = buildAzureCollisionScope({ origin: normalized.origin, repositoryId: repository.id });
  if (collisionScope === null) throw new Error('Invalid Azure fixture scope');
  const source = { pluginId: AZURE_DEVOPS_PLUGIN.manifest.id, localId: 'azure-devops-forge' };
  const account = { service: { pluginId: source.pluginId, localId: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID }, accountId: 'account-1' };
  const instance: TriageConfiguredSourceInstanceV1 = { v: 1,
    instance: { source, sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' }, localInstanceKey: base,
    binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account }, configuration: encodeAzureSourceConfiguration(normalized.origin), locator: { v: 1, displayLabel: "QACollection" } };
  const viewer = { id: 'a0d31c2e-4f50-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Ada' };
  const connectedAccounts = {
    async listAccounts() {
      return { status: 'complete' as const, accounts: [{ account, displayName: 'Azure fixture', state: 'connected' as const,
        connectedAccountOrigins: ['https://dev.azure.com'], connectedAccountBases: [base] }] };
    },
    async getBinding() {
      return { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, service: account.service, account, target: { kind: 'account' as const, displayName: 'Azure fixture' } };
    },
    async materializeListedAccount() { return { kind: 'httpHeaders' as const, headers: { authorization: 'Basic test-only' } }; },
  };
  const page = (value: readonly unknown[]) => ({ count: value.length, value });
  const http = { async request({ url }: { url: string }) {
    const path = new URL(url).pathname.toLowerCase();
    let body: unknown;
    if (path.endsWith('/connectiondata')) body = { authenticatedUser: viewer, deploymentType: 'hosted' };
    else if (path.endsWith('/pullrequests/22')) body = {
      pullRequestId: 22, repository, title: 'Change 22', status: 'active', isDraft: false, createdBy: viewer,
      creationDate: '2026-08-01T10:00:00Z', sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
      mergeStatus: 'succeeded', supportsIterations: true, lastMergeSourceCommit: { commitId: 'a'.repeat(40) }, reviewers: [],
    };
    else if (path.endsWith('/iterations')) body = page([{ id: 1 }]);
    else if (path.endsWith('/changes')) body = { changeEntries: [{ changeTrackingId: 1, changeType: 'edit', item: { path: '/src/a.ts' } }] };
    else if (path.endsWith('/evaluations')) {
      checksReads += 1;
      body = page([{ evaluationId: 'build-1', status: 'rejected',
        configuration: { isBlocking: true, type: { id: 'aaaaaaaa-0000-0000-0000-000000000000', displayName: 'Build gate' } } }]);
    }
    else if (path.endsWith('/statuses')) body = page([]);
    else throw new Error('Unexpected Azure fixture request ' + path);
    return { status: 200, finalUrl: url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
  } };
  return {
    module: AZURE_DEVOPS_PLUGIN, descriptor: AZURE_DEVOPS_TRIAGE_DESCRIPTOR, render: renderAzure,
    get: AZURE_DEVOPS_TRIAGE_ACTION_IDS.get, instance,
    localRef: { kindId: 'pull-request', collisionScope, entryId: '22' },
    route: 'QACollection/Payments/gateway', services: { http, connectedAccounts },
    status: 'Succeeded', checks: '1 failing', body: 'Build gate', reviewer: 'Not available from this source',
    checksPanel: 'Policy evaluations', checksReads: () => checksReads, reviewReads: null,
  };
}

describe('mounted change-request header and Overview', () => {
  it.each([['GitLab', gitlabFixture], ['Azure DevOps', azureFixture]] as const)('uses the settled %s detail facts', async (_name, fixture) => {
    const provider = fixture();
    const instance = { ...provider.instance, locator: { v: 1 as const, displayLabel: provider.route } };
    const source = instance.instance.source;
    const entryRef = { ...provider.localRef, source };
    const selection = { sectionId: null, entryRef, sourceInstanceId: instance.instance.sourceInstanceId,
      lastKnownLocator: { v: 1 as const, routingToken: provider.route } };
    const kit = await createPluginTestkit({ manifest: provider.module.manifest, module: provider.module, services: provider.services });
    const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
    const custody = { kind: 'development' as const, registeredRootId: 'fixture' };
    const target = { pluginId: 'happier.triage', occurrenceId: 'triage-open', sourceCustody: custody };
    const contributor = { pluginId: source.pluginId, contributionId: source.localId, occurrenceId: 'source-open', sourceCustody: custody };
    const point = { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol };
    const get = { point, contributor, role: 'get', action: { pluginId: source.pluginId, localId: provider.get } };
    const detailSurface = { point, contributor, role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1, presentation: 'content' as const };
    const admitted = [{ contributor, descriptor: provider.descriptor, operations: { get } }] as unknown as readonly TriageAdmittedSourceV1[];
    const corpus = createTestkitCorpusCollections();
    const { instance: _ref, ...draft } = instance;
    await administerConfiguredSourceInstance({ collections: corpus.collections, source,
      declaredPurpose: instance.binding.purpose, request: { kind: 'create', draft: { ...draft, keyStability: 'stable' } }, nowMs: 1,
      mintSourceInstanceId: () => instance.instance.sourceInstanceId });
    const relations = createTestkitSourceSessionRelations({ collections: corpus.collections, contributions: admitted });
    function Open() {
      const [tab, setTab] = React.useState('overview');
      const [session, setSession] = React.useState<string | null>(null);
      const detail = useTriagePostMutationRow(null, lanes, selection);
      if (detail.row === null) return <Text value="Opening change request" />;
      return <TriageDetailRegion row={detail.row} rows={[detail.row]} lanes={lanes}
        completePostMutation={detail.completePostMutation} exactRead={detail.exactRead} connectionLabel="Fixture"
        tabSelection={{ value: tab, onChange: setTab }}
        sessionSelection={{ value: session, onChange: setSession, onAvailableSessionsChange() {}, onLoadMore() {} }}
        admittedInstance={instance} target={{ kind: 'entry', ...selection }} actions={actions} originComposer={null}
        pin={{ row: projectTriageWindowRow(detail.row, new Map()), handlers: { busyKey: null, unavailableReason: null, onSetPinned() {} } }} />;
    }
    let context!: Parameters<typeof renderAzure>[0];
    const surface = defineUiSurface(renderContext => { context = renderContext; return <Open />; });
    const renderer = { id: 'source-detail', kind: 'declarative' as const, root: { kind: 'text' as const, text: 'Source detail' } };
    const contributorManifest = definePlugin({ id: source.pluginId, version: '1.0.0', ui: { renderers: [renderer] } }).manifest;
    const identity = { pluginId: source.pluginId, localId: renderer.id };
    const mount = { kind: 'targetedSurface', target, point, contributor,
      role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1, presentation: 'content', inputSchema: TriageDetailSurfaceInputV1JsonSchema,
      rendererChain: [identity],
      selectedRenderer: { identity, renderer: { kind: 'declarative', contributionId: renderer.id, model: {
        identity: { ...identity, qualifiedId: source.pluginId + '/' + renderer.id, occurrenceId: contributor.occurrenceId },
        visible: true, requiredHostMethods: [], declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { ...renderer.root, path: 'root', order: 0 } } },
        availability: { state: 'available', reason: 'available', diagnostics: [] } },
      executionOrigin: { serverIdentityId: 'srv_test', materializationRef: { machineId: 'machine-test', materializationId: 'source-open', pluginId: source.pluginId } },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: { target: { pluginId: source.pluginId, occurrenceId: contributor.occurrenceId, sourceCustody: custody }, points: [] },
    } as const;
    let shell: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => {
        shell = await createPluginUiTestkit({ identity: { instanceId: 'source-open', mountNonce: 'source-open' },
          authorPlugin: { id: target.pluginId, version: '0.0.0' }, surface,
          surfaceContext: createSurfaceContextFixture({ targetedContributions: { target, points: [{ pointId: point.pointId,
            protocols: [{ protocol, contributions: [{ contributor, protocol, descriptor: provider.descriptor,
              operations: [get], surfaces: [detailSurface] }] }] }] } }),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({
            ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(), sessions: true, overlays: true,
            targetedSurfaces: { readCurrentMounts: () => [mount], readContributorManifest: () => contributorManifest,
              renderAdmittedContent: ({ launchInput }) => provider.render({ ...context, launchInput, activity: { active: true } }) as React.ReactElement },
          }),
          handlers: { executeAction: async request => {
            const id = typeof request.action === 'string' ? request.action : request.action.localId;
            if (typeof request.action !== 'string' && request.action.pluginId === source.pluginId) {
              return kit.invokeAction(id, request.input!, { surface: 'ui', signal: request.signal });
            }
            if (id === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
              const input = TriageReobserveEntryInputV1Schema.parse(request.input);
              const result = await reobserveTriageEntry({ ...input, lastKnownLocator: selection.lastKnownLocator }, {
                readConfiguredInstance: async () => instance, readSourceSnapshot: async () => ({ contributions: admitted }),
                signal: request.signal, nowMs: () => Date.now(),
                executeGet: (_operation, getInput, options) => kit.invokeAction(provider.get, getInput, { surface: 'ui', signal: options?.signal }),
              });
              if (result.kind !== 'observed') return result;
              const { entryRef: ref, ...observation } = result.observation;
              return { ...result, entryRef: ref, observation: toTriageWireObservation(observation) };
            }
            if (id === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
              return readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(request.input), { sourceRelations: relations, signal: request.signal });
            }
            throw new Error('Unexpected Triage Action ' + id);
          } },
        });
      });
      const cell = (name: string) => document.querySelector('[data-testid="triage-detail-facts.' + name + '"]')?.textContent;
      await vi.waitFor(() => expect(document.body.textContent).toContain(provider.body));
      await vi.waitFor(() => {
        expect(cell('status')).toContain(provider.status);
        expect(cell('checks')).toContain(provider.checks);
        expect(cell('reviewers')).toContain(provider.reviewer);
      });
      if (shell === undefined) throw new Error('Detail did not mount');
      const view = shell;
      await act(async () => { await view.press(await view.getByRole('tab', { name: 'Checks' })); });
      await expect(view.getByText(provider.checksPanel)).resolves.toBeDefined();
      expect(cell('checks')).toContain(provider.checks);
      expect(provider.checksReads()).toBe(1);
      if (provider.reviewReads !== null) {
        await act(async () => { await view.press(await view.getByRole('tab', { name: 'Activity' })); });
        await expect(view.getByText('Approved by')).resolves.toBeDefined();
        expect(cell('reviewers')).toContain(provider.reviewer);
        expect(provider.reviewReads()).toBe(1);
      }
    } finally {
      await act(async () => { await shell?.dispose(); });
      await kit.dispose();
    }
  });
});
