// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { Button, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageReobserveEntryInputV1Schema } from '../../actions/reobserveEntryProtocol.js';
import { reobserveTriageEntry } from '../../actions/reobserveEntry.js';
import type { TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { toTriageWireObservation } from '../../projection/listWindowWire.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { useTriagePostMutationRow } from './useTriagePostMutationRow.js';
import { getGithubTriageEntry } from '../../../../scm-github/src/triage/operations.js';
import { encodeGithubTriageConfiguration } from '../../../../scm-github/src/triage/configuration.js';
import { GITHUB_ISSUE_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../../scm-github/src/triage/__fixtures__/githubResponses.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT } from '../../../../scm-github/src/triage/testkit/githubTriage.test-support.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../../scm-github/src/observations/githubProviderContracts.js';
import { activate, activateAccount } from '../../../../scm-github/src/activate.js';
import { PLUGIN_MANIFEST as GITHUB_MANIFEST } from '../../../../scm-github/src/manifest.js';
import { renderSurface as renderGithubSurface } from '../../../../scm-github/src/ui/renderSurface.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../../../scm-github/src/triage/contribution.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  TriageDetailSurfaceInputV1JsonSchema } from '@happier-dev/triage-protocol/v1';
import { TriageDetailRegion } from './region.js';
import { projectTriageWindowRow } from '../marks/pinnedRows.js';
import { TRIAGE_UNREAD_ACTIONS_V1 } from '../actions/actionsCommand.js';
import type { TriageMountedActionsV1 } from '../actions/useTriageActions.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { administerConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { linkEntryToSession } from '../../sessions/entrySessionLinks.js';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { createTestkitSourceSessionRelations } from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { readTriageEntryDetail } from '../../actions/readEntryDetail.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailInputV1Schema } from '../../actions/entryDetailProtocol.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from '../../actions/reobserveEntryProtocol.js';
import { createTriageReadFixPullRequestsActionHandler } from '../../actions/fixPullRequests.js';
import { TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1, TriageReadFixPullRequestsInputV1Schema,
  type TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageDataActionContext } from '../../actions/dataContext.js';
import { createTriageReadTaskOriginErrorActionHandler } from '../../actions/taskOrigin.js';
import { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageReadTaskOriginErrorInputV1Schema } from '../../actions/taskOriginProtocol.js';
import { testkitEntryRef, testkitObservation, testkitPresentOutcome } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('one opened GitHub issue read owner', () => {
  it('refreshes full fields once for a newer source revision and ignores unchanged publications', async () => {
    const entryRef = testkitEntryRef();
    const lanes = Object.freeze([]);
    let revision = 1;
    let observedAtMs = 10;
    let reads = 0;
    const observation = () => testkitObservation({ observedAtMs,
      outcome: testkitPresentOutcome({ sourceUpdatedAtMs: revision }) });
    const row = () => foldTriageListWindow({ observations: [{ ...observation(), entryRef }], lanes,
      configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation().sourceInstanceId],
      lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observedAtMs }).rows[0]!;
    const surface = defineUiSurface(() => {
      const [published, setPublished] = React.useState(row);
      const detail = useTriagePostMutationRow(published, lanes);
      return <><Text value={`Full notes:${detail.exactRead?.taskFields?.body ?? 'reading'}`} />
        <Button title="Publish source change" onPress={() => { revision = 2; observedAtMs++; setPublished(row()); }} />
        <Button title="Publish same source revision" onPress={() => { observedAtMs++; setPublished(row()); }} /></>;
    });
    let shell: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => {
        shell = await createPluginUiTestkit({ identity: { instanceId: 'revision-owner', mountNonce: 'revision-owner' },
          authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
          // The host Action transport supplies admitted source results; the opening lifecycle stays real.
          handlers: { executeAction: request => {
            TriageReobserveEntryInputV1Schema.parse(request.input);
            reads++;
            return { kind: 'observed', entryRef, observation: toTriageWireObservation(observation()),
              taskFields: { body: `Source revision ${revision}` } };
          } } });
      });
      await shell!.getByText('Full notes:Source revision 1');
      expect(reads).toBe(1);
      await act(async () => { await shell!.press(await shell!.getByRole('button', { name: 'Publish source change' })); });
      await vi.waitFor(() => expect(document.body.textContent?.includes('Full notes:Source revision 2')).toBe(true));
      expect(reads).toBe(2);
      await act(async () => { await shell!.press(await shell!.getByRole('button', { name: 'Publish same source revision' })); });
      expect(reads).toBe(2);
      expect(document.body.textContent?.includes('Full notes:Source revision 2')).toBe(true);
    } finally { await act(async () => { await shell?.dispose(); }); }
  });

  it('composed issue open reads each GitHub resource once while retaining the complete detail', async () => {
    const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
    const route = 'octo-org/example-app';
    const entryRef = { source, kindId: 'issue', collisionScope: `github:${GITHUB_REPOSITORY_RESPONSE.id}`, entryId: '7' };
    const original = createTriageSourceV1Fixture().configuredInstance;
    const instance = { ...original, instance: { ...original.instance, source },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } })! } };
    const selection = { sectionId: null, entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
    const completeBody = `${'Complete issue body retained by Overview.\n\n'.repeat(240)}End of complete issue notes.`;
    const issue = (number: number) => ({ ...GITHUB_ISSUE_RESPONSE, number,
      title: number === 7 ? 'One composed issue' : `Related issue ${number}`,
      body: number === 7 ? completeBody : `Related issue ${number} notes`,
      assignees: [],
      labels: [{ id: 11, name: 'issue-open-proof', color: '2563eb' }],
      repository_url: `https://api.github.com/repos/${route}`, html_url: `https://github.com/${route}/issues/${number}` });
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/issues/7')) return { status: 200, body: issue(7) };
      if (path.endsWith('/parent')) return { status: 200, body: issue(6) };
      if (path.endsWith('/sub_issues')) return { status: 200, body: [issue(8)] };
      if (path.endsWith('/blocked_by')) return { status: 200, body: [issue(9)] };
      return undefined;
    } });
    const github = await createPluginTestkit({ manifest: GITHUB_MANIFEST, module: { activate, activateAccount },
      services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts } });
    const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
    const target = { pluginId: 'happier.triage', occurrenceId: 'triage-open', sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } };
    const contributor = { pluginId: source.pluginId, contributionId: source.localId, occurrenceId: 'github-open',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'github-root' } };
    const point = { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol };
    const operations = (['get', 'edit', 'readFixPullRequests'] as const).map(role => ({ point, contributor, role,
      action: { pluginId: source.pluginId, localId: GITHUB_TRIAGE_ACTION_IDS_V1[role] } }));
    const detailSurface = { point, contributor, role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1, presentation: 'content' as const };
    // Opaque admission handles and the renderer module are supplied by the host.
    // Every source Action below is registered by the real GitHub plugin.
    const admitted = [{ contributor, descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
      operations: { get: operations[0], edit: operations[1], readFixPullRequests: operations[2] } }] as unknown as readonly TriageAdmittedSourceV1[];
    const corpus = createTestkitCorpusCollections();
    const { instance: _instanceRef, ...draft } = instance;
    await administerConfiguredSourceInstance({ collections: corpus.collections, source,
      declaredPurpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, request: { kind: 'create', draft }, nowMs: 1,
      mintSourceInstanceId: () => instance.instance.sourceInstanceId });
    await linkEntryToSession({ collections: corpus.collections, entryRef,
      display: { locator: { v: 1, routingToken: route }, scopeLabel: route },
      sessionId: SessionIdSchema.parse('session-composed-issue'), nowMs: 2 });
    const relations = createTestkitSourceSessionRelations({ collections: corpus.collections, contributions: admitted });
    const catalog: TriageMountedActionsV1 = { read: TRIAGE_UNREAD_ACTIONS_V1, revision: null, actions: [],
      loaded: false, busy: false, notice: null, unavailableReason: null, retry() {},
      resolveForExecution: async () => ({ status: 'missing' }), administer: async () => null };
    const scope = createTriageEphemeralSharedScopeFixture();
    const lanes = Object.freeze([]);
    let availableSessions: readonly TriageLinkedSessionProjectionV1[] = [];
    const publishSessions = (sessions: readonly TriageLinkedSessionProjectionV1[]) => { availableSessions = sessions; };
    function OpenIssue() {
      const detail = useTriagePostMutationRow(null, lanes, selection);
      const [tab, setTab] = React.useState('overview');
      const [session, setSession] = React.useState<string | null>(null);
      if (detail.row === null) return <Text value="Opening issue" />;
      return <TriageDetailRegion row={detail.row} rows={[detail.row]} lanes={lanes}
        completePostMutation={detail.completePostMutation} exactRead={detail.exactRead} connectionLabel="GitHub fixture"
        target={{ kind: 'entry', ...selection }} actions={catalog} originComposer={null}
        pin={{ row: projectTriageWindowRow(detail.row, new Map()), handlers: { busyKey: null, unavailableReason: null, onSetPinned() {} } }}
        tabSelection={{ value: tab, onChange: setTab }}
        sessionSelection={{ value: session, onChange: setSession, onAvailableSessionsChange: publishSessions, onLoadMore() {} }} />;
    }
    let context!: Parameters<typeof renderGithubSurface>[0];
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
      executionOrigin: { serverIdentityId: 'srv_test', materializationRef: { machineId: 'machine-test', materializationId: 'github-open', pluginId: source.pluginId } },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: { target: { pluginId: source.pluginId, occurrenceId: contributor.occurrenceId, sourceCustody: contributor.sourceCustody }, points: [] } };
    let shell: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      await act(async () => {
      shell = await createPluginUiTestkit({ identity: { instanceId: 'composed-issue-open', mountNonce: 'composed-issue-open' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
        surfaceContext: createSurfaceContextFixture({ targetedContributions: { target, points: [{ pointId: point.pointId,
          protocols: [{ protocol, contributions: [{ contributor, protocol, descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
            operations, surfaces: [detailSurface] }] }] }] } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope, sessions: true, overlays: true,
          targetedSurfaces: { readCurrentMounts: () => [mount], readContributorManifest: () => contributorManifest,
            renderAdmittedContent: ({ launchInput }) => renderGithubSurface({ ...context, launchInput, activity: { active: true } }) as React.ReactElement } }),
        handlers: { executeAction: async request => {
          if (typeof request.action !== 'string' && request.action.pluginId === GITHUB_PLUGIN_ID) {
            return github.invokeAction(request.action.localId, request.input!, { surface: 'ui', signal: request.signal });
          }
          const id = typeof request.action === 'string' ? request.action : request.action.localId;
          // The Account storage and admitted-operation dispatcher are host boundaries.
          // Marks, relationship composition and native fix lookup use their real owners.
          const accountContext = { signal: request.signal, invokedAtMs: 3, surface: 'ui', services: {
            storage: { account: { collection: (definition: { id: string }) => definition.id === 'source-instances'
              ? corpus.collections.sourceInstances : definition.id === 'session-links' ? corpus.collections.sessionLinks : corpus.collections.userMarks } },
            targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: admitted }), dispose() {} }) },
            actions: { executeAdmittedTargetedOperation: (operation: unknown, input: Parameters<typeof github.invokeAction>[1], options?: { signal?: AbortSignal }) =>
              github.invokeAction((operation as typeof operations[number]).action.localId, input, { surface: 'ui', signal: options?.signal }) },
          } } as unknown as TriageDataActionContext;
          if (id === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
            const input = TriageReobserveEntryInputV1Schema.parse(request.input);
            const result = await reobserveTriageEntry({ ...input, lastKnownLocator: { v: 1, routingToken: route } }, {
              readConfiguredInstance: async () => instance, readAdmittedSources: async () => admitted, signal: request.signal,
              executeGet: async (_operation, getInput, options) => github.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, getInput,
                { surface: 'ui', signal: options?.signal }), nowMs: () => Date.now() });
            if (result.kind !== 'observed') return result;
            const { entryRef: ref, ...observation } = result.observation;
            return { ...result, entryRef: ref, observation: toTriageWireObservation(observation) };
          }
          if (id === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) return readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(request.input),
            { sourceRelations: relations, readSessionSummary: async () => ({ title: 'Linked issue work', updatedAtMs: 3 }), signal: request.signal });
          if (id === TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1) return createTriageReadFixPullRequestsActionHandler()(
            TriageReadFixPullRequestsInputV1Schema.parse(request.input), accountContext);
          if (id === TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1) return createTriageReadTaskOriginErrorActionHandler()(
            TriageReadTaskOriginErrorInputV1Schema.parse(request.input), accountContext);
          throw new Error(`Unexpected composed issue Action: ${id}`);
        } } });
      });
      await vi.waitFor(() => expect(document.body.textContent).toContain('One composed issue'));
      await vi.waitFor(() => expect(document.body.textContent).toContain('Complete issue body retained by Overview.'));
      expect(document.body.textContent?.includes('End of complete issue notes.')).toBe(true);
      await vi.waitFor(() => expect(document.body.textContent).toContain('issue-open-proof'));
      await expect(shell!.getByRole('tab', { name: 'Overview' })).resolves.toBeDefined();
      await expect(shell!.getByRole('tab', { name: 'Activity' })).resolves.toBeDefined();
      expect(document.body.textContent).toContain('Session');
      expect(document.body.textContent).toContain('monalisa');
      expect(document.body.textContent).toContain(route);
      expect(availableSessions).toMatchObject([{ sessionId: 'session-composed-issue', updatedAtMs: 3 }]);
      const paths = transport.requests.map(request => new URL(request.url).pathname).sort();
      expect(paths).toEqual([`/repos/${route}`, `/repos/${route}/issues/7`, `/repos/${route}/issues/7/parent`,
        `/repos/${route}/issues/7/sub_issues`, `/repos/${route}/issues/7/dependencies/blocked_by`].sort());
    } finally { await act(async () => { await shell?.dispose(); }); await github.dispose(); }
  });

  it.each(['close', 'refresh'] as const)('shares detail/companion HTTP reads, keeps fresh reads and supports %s during an open read', async (duringRead) => {
    const sourceFixture = createTriageSourceV1Fixture();
    const route = 'octo-org/example-app';
    const entryRef = { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' },
      kindId: 'issue', collisionScope: `github:${GITHUB_REPOSITORY_RESPONSE.id}`, entryId: '7' };
    const instance = { ...sourceFixture.configuredInstance,
      instance: { ...sourceFixture.configuredInstance.instance, source: entryRef.source },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } })! } };
    const selection = { sectionId: null, entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
    let title = 'First open';
    let childNumber = 8;
    let holdIssueRead: Promise<void> | null = null;
    const issue = (number: number) => ({ ...GITHUB_ISSUE_RESPONSE, number, title,
      repository_url: `https://api.github.com/repos/${route}`, html_url: `https://github.com/${route}/issues/${number}` });
    const respond: Parameters<typeof createStubGithubTransport>[0]['respond'] = request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/issues/7')) {
        const body = issue(7);
        return holdIssueRead === null ? { status: 200, body }
          : holdIssueRead.then(() => ({ status: 200, body }));
      }
      if (path.endsWith('/parent')) return { status: 200, body: issue(6) };
      if (path.endsWith('/sub_issues')) return { status: 200, body: [issue(childNumber)] };
      if (path.endsWith('/blocked_by')) return { status: 200, body: [issue(9)] };
      return undefined;
    };
    // Independent detail/companion artifacts have distinct host service facades.
    // Sharing belongs to their Account/plugin scope, above either HTTP client.
    const transports = [createStubGithubTransport({ respond }), createStubGithubTransport({ respond })];
    let entryGets = 0;
    // Host admission supplies opaque handles; all source logic, qualification,
    // folding and the GitHub API client are real beneath the HTTP boundary.
    const admitted = [{ contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId },
      descriptor: { ...sourceFixture.descriptor, kinds: [{ id: 'issue', displayName: 'Issue', pluralDisplayName: 'Issues', workflowSubject: 'issue' }] },
      operations: { get: {} } }] as unknown as readonly TriageAdmittedSourceV1[];
    const scope = createTriageEphemeralSharedScopeFixture();
    const lanes = Object.freeze([]);
    function Reader({ name, open }: { name: string; open: boolean }) {
      const detail = useTriagePostMutationRow(null, lanes, open ? selection : null);
      const snapshot = detail.row?.observations[0]?.outcome;
      return <><Text value={`${name}:${snapshot?.kind === 'present' ? `${snapshot.snapshot.title}:${snapshot.snapshot.relations?.children?.entries?.[0]?.entryId}` : 'reading'}`} />
        <Button title={`Refresh ${name}`} onPress={detail.completePostMutation} /></>;
    }
    const surface = defineUiSurface(() => {
      const [open, setOpen] = React.useState(true);
      const [detailOpen, setDetailOpen] = React.useState(true);
      return <><Button title="Toggle issue" onPress={() => setOpen(value => !value)} />
        <Button title="Close detail" onPress={() => setDetailOpen(false)} />
        <Reader name="detail" open={open && detailOpen} /><Reader name="companion" open={open} /></>;
    });
    const shell = await createPluginUiTestkit({
      identity: { instanceId: 'issue-open', mountNonce: 'issue-open' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
      handlers: { executeAction: async request => {
        const http = transports[entryGets++ % transports.length]!;
        const input = TriageReobserveEntryInputV1Schema.parse(request.input);
        const result = await reobserveTriageEntry({ ...input, lastKnownLocator: { v: 1, routingToken: route } }, {
          readConfiguredInstance: async () => instance, readAdmittedSources: async () => admitted,
          signal: request.signal,
          executeGet: async (_operation, getInput, options) => getGithubTriageEntry(getInput,
            { ...http.context, signal: options?.signal ?? http.context.signal }), nowMs: () => Date.now(),
        });
        if (result.kind !== 'observed') throw new Error(result.kind);
        const { entryRef, ...observation } = result.observation;
        return { kind: 'observed', entryRef, observation: toTriageWireObservation(observation) };
      } },
    });
    const expectedPaths = [`/repos/${route}`, `/repos/${route}/issues/7`,
      `/repos/${route}/issues/7/parent`, `/repos/${route}/issues/7/sub_issues`, `/repos/${route}/issues/7/dependencies/blocked_by`].sort();
    const paths = () => transports.flatMap(http => http.requests.map(request => new URL(request.url).pathname)).sort();
    try {
      await vi.waitFor(() => expect(paths().length).toBeGreaterThanOrEqual(expectedPaths.length));
      expect(paths()).toEqual(expectedPaths);
      expect(entryGets).toBe(1);
      await vi.waitFor(async () => {
        await expect(shell.getByText('detail:First open:8')).resolves.toBeDefined();
        await expect(shell.getByText('companion:First open:8')).resolves.toBeDefined();
      });
      // One entry get: one issue DTO, one repository identity, three relations.
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      title = 'Fresh next open'; childNumber = 10;
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      await shell.getByText('detail:Fresh next open:10');
      await shell.getByText('companion:Fresh next open:10');
      expect(paths()).toEqual([...expectedPaths, ...expectedPaths].sort());
      title = 'Explicitly refreshed'; childNumber = 11;
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Refresh detail' })); });
      await shell.getByText('detail:Explicitly refreshed:11');
      expect(paths()).toEqual([...expectedPaths, ...expectedPaths, ...expectedPaths].sort());
      // Leaving one surface must not cancel the other borrower's same read.
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      const held = Promise.withResolvers<void>();
      holdIssueRead = held.promise;
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      await vi.waitFor(() => expect(entryGets).toBe(4));
      if (duringRead === 'refresh') {
        title = 'Changed during open';
        holdIssueRead = null;
        let refresh: Promise<void> | undefined;
        try {
          await act(async () => { refresh = shell.press(await shell.getByRole('button', { name: 'Refresh detail' })); });
          await vi.waitFor(() => expect(entryGets).toBe(5));
          await vi.waitFor(async () => { await expect(shell.getByText('detail:Changed during open:11')).resolves.toBeDefined(); });
        } finally {
          await act(async () => { held.resolve(); await refresh; });
        }
        expect(paths()).toEqual(Array.from({ length: 5 }, () => expectedPaths).flat().sort());
        return;
      }
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close detail' })); });
      await act(async () => { held.resolve(); });
      await vi.waitFor(async () => {
        await expect(shell.getByText('companion:Explicitly refreshed:11')).resolves.toBeDefined();
      });
      expect(paths()).toEqual(Array.from({ length: 4 }, () => expectedPaths).flat().sort());
    } finally { await shell.dispose(); }
  });
});
