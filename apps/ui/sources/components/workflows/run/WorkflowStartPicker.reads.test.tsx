import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { SelectionListDynamicSectionResolveResult } from '@/components/ui/selectionList';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { WorkflowStartSelection } from './WorkflowStartPicker';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { createWorkflowDefinition, updateWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { resetWorkflowLibraryReadsForTests } = await import('../library/workflowLibraryReads');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { SelectionList } = await import('@/components/ui/selectionList');
const { WorkflowStartPicker } = await import('./WorkflowStartPicker');

let previousState = storage.getState();
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let artifactAccountId: string | null = null;
let holdBodyRead: Promise<void> | null = null;
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => artifactAccountId, encryptionMode: 'plain' });
const ids = ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102'];

function bodyReads() {
    return home.requests.filter(request => request.method === 'POST' && request.path === '/v1/artifacts/read'
        && Reflect.get(request.body as object, 'projection') !== 'headers'
        || request.method === 'GET' && /^\/v1\/artifacts\/[^/]+$/.test(request.path));
}

beforeEach(async () => {
    previousState = storage.getState();
    artifacts.clear();
    holdBodyRead = null;
    machineRpc.mockReset();
    machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) });
    connection = await restoreServerAccountForTest({ serverUrl: 'http://workflow-picker-reads.test', accountId: 'workflow-picker-reads-account' });
    home = await serveActionHomes({
        homes: [{ key: 'picker', serverUrl: 'http://workflow-picker-reads.test', accountId: 'workflow-picker-reads-account', currentAccount: true }],
        route: async request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (request.path === '/v1/account/project-rows/list') return Response.json(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' }));
            if (request.path === '/v3/automations/query') return Response.json({ automations: [], nextCursor: null });
            if (request.path === '/v1/artifacts' || request.path.startsWith('/v1/artifacts/')) {
                if ((request.method === 'POST' && request.path === '/v1/artifacts/read'
                    && Reflect.get(request.body as object, 'projection') !== 'headers')
                    || request.method === 'GET' && /^\/v1\/artifacts\/[^/]+$/.test(request.path)) await holdBodyRead;
                artifactAccountId = request.accountId;
                return await artifacts.handle(`${request.path}${request.url.search}`, {
                    method: request.method,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal,
                }) ?? undefined;
            }
            return undefined;
        },
    });
    primeServerFeaturesSnapshot({ serverId: home.homes.picker!.id,
        snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    for (const [index, definitionId] of ids.entries()) {
        await createWorkflowDefinition({ definitionId, definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
            metadata: { title: index === 0 ? 'Chosen recipe' : 'Other recipe', description: 'Saved header description' } });
    }
    home.requests.length = 0;
});

afterEach(async () => {
    await standardCleanup();
    resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    await home.dispose();
    await connection.dispose();
    clearDaemonMergedProjectionCacheForTests();
    resetServerFeaturesClientForTests();
    storage.setState(previousState);
    vi.restoreAllMocks();
});

describe('WorkflowStartPicker demanded saved definition reads', () => {
    it('returns a saved reference from its header with zero chosen body reads', async () => {
        const onSelectReference = vi.fn();
        const onRequestClose = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelectReference={onSelectReference} onRequestClose={onRequestClose} maxHeight={600} />);
        await vi.waitFor(() => {
            const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
            const section = root.sections.find(entry => entry.kind === 'dynamic');
            if (section?.kind !== 'dynamic') throw new Error('missing_library');
            expect(section.resolverKey).toContain(ids[0]);
        });
        home.requests.length = 0;
        await act(async () => { await screen.findByType(SelectionList).props.onSelect(ids[0]); });
        expect(onSelectReference).toHaveBeenCalledOnce();
        expect(onSelectReference.mock.calls[0]![0]).toEqual({ name: 'Chosen recipe',
            source: { kind: 'saved', definitionId: ids[0], revision: { headerVersion: 1, bodyVersion: 1 } } });
        expect(onRequestClose).toHaveBeenCalledOnce();
        expect(bodyReads()).toHaveLength(0);
    });

    it('filters headers with zero body reads, ignores unrelated pushes, and reads only the chosen definition', async () => {
        const onSelect = vi.fn<(selection: WorkflowStartSelection) => void>();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={onSelect} onRequestClose={() => {}} maxHeight={600} />);
        const librarySection = () => {
            const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
            const section = root.sections.find(entry => entry.kind === 'dynamic' && entry.id === 'library');
            if (section?.kind !== 'dynamic') throw new Error('missing_library');
            return section;
        };
        await vi.waitFor(() => expect(librarySection().resolverKey).toContain(ids[0]));
        // The library Action currently reads bodies to produce its public header summaries.
        // Isolate extra reads owned by the picker after that existing page has settled.
        home.requests.length = 0;
        let all: SelectionListDynamicSectionResolveResult = { options: [] };
        let filtered: SelectionListDynamicSectionResolveResult = { options: [] };
        await act(async () => {
            [all, filtered] = await Promise.all([
                librarySection().resolve('', new AbortController().signal),
                librarySection().resolve('chosen', new AbortController().signal),
            ]);
        });
        expect(all.options.map(option => option.id)).toEqual(expect.arrayContaining(ids));
        expect(filtered.options.map(option => option.id)).toEqual([ids[0]]);
        expect(bodyReads().map(request => ({ method: request.method, path: request.path, body: request.body }))).toEqual([]);

        await act(async () => publishHomeAccountChange(home.homes.picker!.id, undefined, { workflowDefinitionsAffect: false }));
        expect(bodyReads()).toHaveLength(0);
        await act(async () => { await screen.findByType(SelectionList).props.onSelect(ids[0]); });
        await vi.waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
        expect(bodyReads()).toHaveLength(1);
        expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: ids[0], name: 'Chosen recipe',
            source: { kind: 'saved', definitionId: ids[0] }, definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition });

        const source = onSelect.mock.calls[0]![0].source;
        if (source.kind !== 'saved') throw new Error('missing_saved_source');
        const priorKey = librarySection().resolverKey;
        await updateWorkflowDefinition({ definitionId: ids[0]!, expectedRevision: source.revision,
            definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition, metadata: { title: 'Updated chosen recipe' } });
        await act(async () => publishHomeAccountChange(home.homes.picker!.id, [ids[0]!],
            { workflowDefinitionsAffect: true, changeKinds: ['artifact'] }));
        await vi.waitFor(() => expect(librarySection().resolverKey).not.toEqual(priorKey));
        home.requests.length = 0;
        await act(async () => { await screen.findByType(SelectionList).props.onSelect(ids[0]); });
        expect(onSelect).toHaveBeenCalledTimes(2);
        expect(onSelect.mock.calls[1]![0].name).toBe('Updated chosen recipe');
        expect(onSelect.mock.calls[1]![0].source).not.toEqual(source);
        expect(bodyReads()).toHaveLength(1);
    });

    it('shares the pending highlighted preview read with explicit selection', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={onSelect} onRequestClose={() => {}} maxHeight={600} />);
        await vi.waitFor(() => {
            const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
            const section = root.sections.find(entry => entry.kind === 'dynamic');
            if (section?.kind !== 'dynamic') throw new Error('missing_library');
            expect(section.resolverKey).toContain(ids[0]);
        });
        const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
        const section = root.sections.find(entry => entry.kind === 'dynamic');
        if (section?.kind !== 'dynamic') throw new Error('missing_library');
        home.requests.length = 0;
        let choices: SelectionListDynamicSectionResolveResult = { options: [] };
        await act(async () => { choices = await section.resolve('chosen', new AbortController().signal); });
        const detail = choices.options[0]?.detailContent;
        if (typeof detail !== 'function') throw new Error('missing_preview');
        const held = createDeferred<void>();
        holdBodyRead = held.promise;
        await renderScreen(<>{detail()}</>);
        await vi.waitFor(() => expect(bodyReads()).toHaveLength(1));
        let selection: Promise<void> | undefined;
        await act(async () => { selection = screen.findByType(SelectionList).props.onSelect(ids[0]); });
        expect(onSelect).not.toHaveBeenCalled();
        expect(bodyReads()).toHaveLength(1);
        await act(async () => { held.resolve(); await selection; });
        expect(onSelect).toHaveBeenCalledOnce();
        expect(bodyReads()).toHaveLength(1);
    });

    it('does not publish a chosen definition after its Account lifetime retires during the read', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={onSelect} onRequestClose={() => {}} maxHeight={600} />);
        await vi.waitFor(() => {
            const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
            const section = root.sections.find(entry => entry.kind === 'dynamic');
            if (section?.kind !== 'dynamic') throw new Error('missing_library');
            expect(section.resolverKey).toContain(ids[0]);
        });
        home.requests.length = 0;
        const held = createDeferred<void>();
        holdBodyRead = held.promise;
        let selection: Promise<void> | undefined;
        await act(async () => { selection = screen.findByType(SelectionList).props.onSelect(ids[0]); });
        await vi.waitFor(() => expect(bodyReads()).toHaveLength(1));
        await act(async () => {
            (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
            held.resolve();
            await selection;
        });
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps a pending explicit selection when the highlighted preview changes', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(<WorkflowStartPicker onSelect={onSelect} onRequestClose={() => {}} maxHeight={600} />);
        let section: React.ComponentProps<typeof SelectionList>['rootStep']['sections'][number] | undefined;
        await vi.waitFor(() => {
            const root: React.ComponentProps<typeof SelectionList>['rootStep'] = screen.findByType(SelectionList).props.rootStep;
            section = root.sections.find(entry => entry.kind === 'dynamic');
            if (section?.kind !== 'dynamic') throw new Error('missing_library');
            expect(section.resolverKey).toContain(ids[0]);
        });
        if (section?.kind !== 'dynamic') throw new Error('missing_library');
        const library = section;
        let choices: SelectionListDynamicSectionResolveResult = { options: [] };
        await act(async () => { choices = await library.resolve('', new AbortController().signal); });
        const detail = choices.options.find(option => option.id === ids[1])?.detailContent;
        if (typeof detail !== 'function') throw new Error('missing_preview');
        home.requests.length = 0;
        const held = createDeferred<void>();
        holdBodyRead = held.promise;
        let selection: Promise<void> | undefined;
        await act(async () => { selection = screen.findByType(SelectionList).props.onSelect(ids[0]); });
        await vi.waitFor(() => expect(bodyReads()).toHaveLength(1));
        await renderScreen(<>{detail()}</>);
        await act(async () => { held.resolve(); await selection; });
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect.mock.calls[0]![0].id).toBe(ids[0]);
    });
});
