// @vitest-environment jsdom
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, installBrowserClipboardBoundary, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createPluginDeclarativeModelFixture } from '@/dev/testkit/fixtures/pluginDeclarativeModelFixture';
import { OpenableContentStatResultV1Schema } from '@happier-dev/protocol/plugins/openableContent';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
const viewerViewport = vi.hoisted(() => ({ width: 1280 }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    // The host renderer has no measured recycler viewport; keep the real File rows.
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    // The host renderer has no measured RN list viewport; real File code rows still render.
    return createReactNativeWebMock({ ...createCapturingFlatListMock({ renderItems: true }).module,
        useWindowDimensions: () => ({ width: viewerViewport.width, height: 900, scale: 1, fontScale: 1 }) });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const filePath = 'assets/logo-dark.svg';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="black" /></svg>';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let scmDiff = '';
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
let viewerStatBytes: Uint8Array | null;
let settingsRequests: Array<{ method: string; status: number }>;
let accountSettings: ReturnType<typeof createAccountSettingsHttpBoundary>;
let settingsWrites: Array<{ expectedVersion: number; viewer: unknown }>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ImageWell } = await import('@/components/ui/media/ImageWell');
const { Modal, ModalProvider } = await import('@/modal');
const { PluginDetailsDestinationLaunchScope, createPluginDetailsDestinationSurfaceRenderer } = await import('@/components/appShell/panes/details/surfaces/pluginDetailsDestination');

function installedViewerProjection(platform: 'web' | 'ios' = 'web') {
    const installedPackagesById: Record<string, unknown> = {};
    const entriesById: Record<string, unknown> = {};
    for (let index = 1; index <= 11; index += 1) {
        const suffix = String(index).padStart(2, '0');
        const pluginId = `com.external.viewer-${suffix}`;
        const occurrenceId = `${pluginId}#1`;
        const executionOrigin = { serverIdentityId: 'srv_svg_preview', materializationRef: {
            machineId: fixture.scope.machineId, materializationId: `${pluginId}-installed`, pluginId,
        } };
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'text-viewer',
            rendererId: 'text-renderer', container: 'detailsTab', target: { kind: 'project' }, instancePolicy: 'singleton' });
        if (!binding) throw new Error('External viewer fixture must have an admitted destination');
        installedPackagesById[pluginId] = { id: pluginId, displayName: `External viewer ${suffix}`, version: '1.0.0',
            enabled: true, occurrenceId, source: { kind: 'path', locator: `/plugins/${pluginId}` },
            sourceCustody: { kind: 'development', registeredRootId: `${pluginId}-root` }, declaresContributionPoints: false };
        const viewerId = `openableContentViewer:${pluginId}:text`;
        entriesById[viewerId] = { id: viewerId, pluginId, occurrenceId, executionOrigin,
            contributionKind: 'openableContentViewer', descriptorId: 'text', identity: { pluginId, localId: 'text' },
            viewer: { contentClasses: ['text'], mimeTypes: ['text/plain'] }, destination: { pluginId, localId: 'text-viewer' } };
        const placementId = `surfacePlacement:${pluginId}:text-viewer`;
        entriesById[placementId] = { id: placementId, pluginId, occurrenceId, executionOrigin,
            contributionKind: 'surfacePlacement', descriptorId: 'text-viewer', binding, target: binding.target,
            renderer: { kind: 'declarative', contributionId: 'text-renderer', model: createPluginDeclarativeModelFixture({
                pluginId, localId: 'text-renderer', occurrenceId,
                document: { version: 1, root: { kind: 'text', text: `External viewer ${suffix} mounted` } },
            }) }, display: { developerFallback: `External viewer ${suffix}` },
            availability: { state: 'available', reason: 'available', diagnostics: [] } };
    }
    // This is the daemon wire boundary; matching, choice and mount normalization remain real.
    return normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById, actionsById: {}, familiesById: { pluginUi: { family: 'pluginUi', entriesById } } }), platform);
}

function InstalledViewerFileHost(props: Readonly<{ projection: PluginUiProjectionModel; platform: 'web' | 'ios'; formFactor: 'phone' | 'tablet' }>) {
    const pane = useAppPaneScope('project:installed-viewers');
    React.useEffect(() => {
        pane.openDetailsTab({ key: 'file:notes.txt', kind: 'workspace-file',
            title: 'notes.txt', resource: { filePath: 'notes.txt' } }, { intent: 'pinned' });
    }, [pane.openDetailsTab]);
    const tab = pane.scopeState?.details.tabs.find(candidate => candidate.key === pane.scopeState?.details.activeTabKey);
    if (!tab) return null;
    const scope = { ...fixture.scope, kind: 'project' as const, workspaceRefId: 'project:installed-viewers' };
    const details: DetailsSurfaceRenderInputV1 = { tab, scope, region: 'details', active: true,
        descriptor: { surfaceId: tab.kind, resourceKey: tab.key, scope, region: 'details', status: 'available' },
        callbacks: { replaceTab: pane.replaceDetailsTab } };
    const renderer = createPluginDetailsDestinationSurfaceRenderer({ targetKind: 'project', projection: props.projection,
        mount: { ...fixture.scope, projectId: scope.workspaceRefId, platform: props.platform, formFactor: props.formFactor,
            projectionPhase: 'current', projectionInteractionEnabled: true } });
    return <PluginDetailsDestinationLaunchScope>{renderer.canRender(details) ? renderer.render(details) : (
        <WorkspaceFileDetailsView targetKind="project" workspaceRefId={scope.workspaceRefId}
            scopeId="project:installed-viewers" scope={fixture.scope} filePath="notes.txt" sessionIdForAugmentation={null}
            openableContentViewer={{ targetKind: 'project', projection: props.projection, platform: props.platform,
                scopedLaunchFacts: { ...fixture.scope, interactionEnabled: true }, details }} />
    )}</PluginDetailsDestinationLaunchScope>;
}
beforeEach(async () => {
    standardCleanup();
    viewerViewport.width = 1280;
    clipboard.setStringAsync.mockClear();
    installBrowserClipboardBoundary(async text => { await clipboard.setStringAsync(text); });
    // jsdom supplies the web modal DOM; Node supplies real, fetchable Blob URLs.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    portalBoundary = installReactDomPortalBoundaryForTests();
    actionRequests = [];
    readInputs = [];
    scmDiff = '';
    viewerStatBytes = null;
    settingsRequests = [];
    settingsWrites = [];
    transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const settings = createAccountSettingsHttpBoundary({ serverUrl: 'https://session-file-views.test',
        initialAccounts: [{ accountId: 'alice', snapshot: { content: { t: 'plain', v: {} }, version: 0 } }] });
    accountSettings = settings;
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_svg_preview', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => {
            readInputs.push(input);
            return transfer.rpc({ targetId: 'm1',
                method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input });
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_svg_preview', machineCarrierOrigin: transfer.origin,
        // Private requester admission needs current Account provenance, not the legacy Home token default.
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const settingsResponse = settings.handle(url, init);
            if (settingsResponse) {
                settingsRequests.push({ method: init?.method ?? 'GET', status: settingsResponse.status });
                if (init?.method === 'POST') {
                    const body = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    settingsWrites.push({ expectedVersion: body.expectedVersion,
                        viewer: body.content?.t === 'plain' ? body.content.v.workspaceFileViewerPreferencesV1 : null });
                }
                return settingsResponse;
            }
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: scmDiff }
            : request.method === RPC_METHODS.STAT_FILE && viewerStatBytes
                ? { success: true, exists: true, kind: 'file', sizeBytes: viewerStatBytes.byteLength,
                    modifiedMs: 1, contentHash: bytesToHex(sha256(viewerStatBytes)) }
                : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('SVG File page preview dispatch', () => {
    it('selects, clears and refuses stale viewer preferences through the real Account Action CAS', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { WorkspaceFileViewerPreferencesV1Schema } = await import('@happier-dev/protocol/account/settings/workspaceFileViewerPreferencesV1');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: fixture.scope.serverId, expectedAccountId: 'alice' };
        const selector = { kind: 'mime', value: ' Text/Plain ' };
        expect(await executor.execute('file.view.preference.set', {
            mutation: { kind: 'select', selector, viewer: { kind: 'builtin' } }, expectedSettingsVersion: 0,
        }, context)).toEqual({ ok: true, result: { status: 'applied', settingsVersion: 1 } });
        expect(WorkspaceFileViewerPreferencesV1Schema.parse(settingsWrites.at(-1)?.viewer)).toEqual({
            v: 1, selections: { 'mime:text/plain': { kind: 'builtin' } },
        });
        expect(await executor.execute('file.view.preference.set', {
            mutation: { kind: 'clear', selector }, expectedSettingsVersion: 0,
        }, context)).toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
        expect(settingsWrites).toHaveLength(1);
        expect(await executor.execute('file.view.preference.set', {
            mutation: { kind: 'clear', selector }, expectedSettingsVersion: 1,
        }, context)).toEqual({ ok: true, result: { status: 'applied', settingsVersion: 2 } });
        expect(WorkspaceFileViewerPreferencesV1Schema.parse(settingsWrites.at(-1)?.viewer)).toEqual({ v: 1, selections: {} });
    });

    it.each(['disabled', 'conflict'] as const)('leaves preferences and the delivered viewer unchanged when its preference Action is refused (%s)', async (refusal) => {
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const accountScope = getActiveServerAccountScope();
        if (!accountScope) throw new Error('Viewer admission requires the restored Account');
        const raw = {
            actionsSettingsV1: { v: 1, actions: refusal === 'disabled' ? { 'file.view.preference.set': { enabled: false } } : {} },
            workspaceFileViewerPreferencesV1: { v: 1, selections: {
                'mime:text/plain': { kind: 'plugin', pluginId: 'com.external.viewer-11', contributionLocalId: 'text' },
            } },
        };
        await fixture.storage.getState().activateSettingsScope(accountScope);
        fixture.storage.getState().applySettingsForScope(accountScope, settingsParse({}), 0);
        viewerStatBytes = new TextEncoder().encode('plain notes\n');
        transfer.setPayload(viewerStatBytes, 'notes.txt');
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope,
            id: 'project:installed-viewers', label: null, createdAtMs: 1, lastOpenedAtMs: null }] });
        const screen = await fixture.render(<ModalProvider><InstalledViewerFileHost projection={installedViewerProjection()} platform="web" formFactor="tablet" /></ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.external.viewer-11:text')?.props.disabled).not.toBe(true));
            accountSettings.replaceAccountSettings('alice', { content: { t: 'plain', v: raw }, version: refusal === 'conflict' ? 18 : 17 });
            await act(async () => fixture.storage.getState().applySettingsForScope(accountScope, settingsParse(raw), 17));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('External viewer 11 mounted'));
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:builtin');
            await flushHookEffects({ cycles: 4 });
            expect(settingsWrites).toEqual([]);
            expect(fixture.storage.getState().settings.workspaceFileViewerPreferencesV1).toEqual(raw.workspaceFileViewerPreferencesV1);
            expect(screen.getTextContent()).toContain('External viewer 11 mounted');
        } finally { await screen.unmount(); }
    });

    it('ignores unrelated accepted settings revisions while keeping viewer readiness and preferences fresh', async () => {
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { paneUiState } = await import('@/sync/domains/state/filePaneUiState');
        const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
        const accountScope = getActiveServerAccountScope();
        if (!accountScope) throw new Error('Viewer locality requires the restored Account');
        await fixture.storage.getState().activateSettingsScope(accountScope);
        fixture.storage.getState().applySettingsForScope(accountScope, settingsParse({}), 0);
        viewerStatBytes = new TextEncoder().encode('plain notes\n');
        transfer.setPayload(viewerStatBytes, 'notes.txt');
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope,
            id: 'project:installed-viewers', label: null, createdAtMs: 1, lastOpenedAtMs: null }] });
        let commits = 0;
        let panePublications = 0;
        const projection = installedViewerProjection();
        const screen = await fixture.render(<ModalProvider><React.Profiler id="file-viewer" onRender={() => { commits += 1; }}>
            <InstalledViewerFileHost projection={projection} platform="web" formFactor="tablet" />
        </React.Profiler></ModalProvider>);
        const unsubscribe = paneUiState.subscribe(() => { panePublications += 1; });
        const choiceId = 'plugin-details-viewer-choice:openableContentViewer:com.external.viewer-11:text';
        try {
            await vi.waitFor(() => expect(screen.findByTestId(choiceId), screen.getTextContent()).not.toBeNull());
            await vi.waitFor(() => expect(screen.findByTestId(choiceId)?.props.disabled).not.toBe(true));
            await flushHookEffects({ cycles: 4 });
            commits = 0;
            panePublications = 0;
            for (let version = 1; version <= 16; version += 1) {
                await act(async () => fixture.storage.getState().applySettingsForScope(accountScope, settingsParse({
                    ...fixture.storage.getState().settings, analyticsOptOut: version % 2 === 1,
                }), version));
            }
            expect(fixture.storage.getState().settingsVersion).toBe(16);
            expect({ commits, panePublications }).toEqual({ commits: 0, panePublications: 0 });

            await act(async () => fixture.storage.getState().clearSettingsScope());
            await vi.waitFor(() => expect(screen.findByTestId(choiceId)?.props.disabled).toBe(true));
            await act(async () => fixture.storage.getState().activateSettingsScope(accountScope));
            await vi.waitFor(() => expect(screen.findByTestId(choiceId)?.props.disabled).not.toBe(true));
            const viewerSettings = {
                analyticsOptOut: false,
                workspaceFileViewerPreferencesV1: { v: 1, selections: {
                    'mime:text/plain': { kind: 'plugin', pluginId: 'com.external.viewer-11', contributionLocalId: 'text' },
                } },
            };
            await act(async () => fixture.storage.getState().applySettingsForScope(accountScope, settingsParse({
                ...fixture.storage.getState().settings, ...viewerSettings,
            }), 17));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('External viewer 11 mounted'));
            expect(screen.findByType(PluginSurfacePlacementHost).props.placement.binding.destination).toEqual({
                pluginId: 'com.external.viewer-11', localId: 'text-viewer',
            });
            // The staged command outlives many revisions. Its CAS must use the latest admitted version,
            // not the version from the render that originally supplied the choice callback.
            // Serve the raw server snapshot, not its parsed runtime projection: the latter includes
            // derived/legacy settings that Sync must clean up before the one-shot viewer mutation.
            accountSettings.replaceAccountSettings('alice', { content: { t: 'plain', v: viewerSettings }, version: 17 });
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:builtin');
            await vi.waitFor(() => expect(fixture.storage.getState().settingsVersion).toBe(18));
            expect(settingsRequests).toContainEqual({ method: 'POST', status: 200 });
            const builtinPreferences = {
                v: 1, selections: { 'mime:text/plain': { kind: 'builtin' } },
            };
            expect(settingsWrites).toEqual([{ expectedVersion: 17, viewer: builtinPreferences }]);
            expect(fixture.storage.getState().settings.workspaceFileViewerPreferencesV1).toEqual(builtinPreferences);
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('plain notes'));
            expect(screen.getTextContent()).not.toContain('External viewer 11 mounted');
        } finally { unsubscribe(); await screen.unmount(); }
    });

    it('keeps the real File page usable when recent-history KV writes are refused and records its next activation after recovery', async () => {
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { recentWorkspaceFilesState } = await import('@/sync/domains/state/filePaneUiState');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { recentWorkspaceFilesKey } = await import('@/sync/domains/workspaces/files/recentWorkspaceFiles');
        const { tryBuildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const accountScope = getActiveServerAccountScope();
        const workspaceKey = tryBuildWorkspaceCacheKey(fixture.scope);
        if (!accountScope || !workspaceKey) throw new Error('File history requires an exact Account/workspace fixture');
        const recordKey = recentWorkspaceFilesKey(accountScope, workspaceKey);
        recentWorkspaceFilesState.set(workspaceKey, ['legacy-only.txt']);
        const deviceStorage = getPersistenceStorage();
        const set = deviceStorage.set.bind(deviceStorage);
        let refused = 0;
        let refuse = true;
        // MMKV is the physical persistence boundary; the File page, recorder and keyed owner stay real.
        const write = vi.spyOn(deviceStorage, 'set').mockImplementation((key, value) => {
            if (refuse && key.startsWith('ui-state:recent-workspace-files-v1:')) {
                refused += 1;
                throw new Error('Device history storage refused');
            }
            set(key, value);
        });
        const file = (path: string) => <ModalProvider><WorkspaceFileDetailsView scopeId="project:history-refusal"
            scope={fixture.scope} filePath={path} sessionIdForAugmentation={null} presentation="screen" /></ModalProvider>;
        let screen: Awaited<ReturnType<typeof fixture.render>> | undefined;
        try {
            screen = await fixture.render(file(filePath));
            await vi.waitFor(() => expect(refused).toBeGreaterThan(0));
            await screen.pressByTestIdAsync('file-details-view-mode:file');
            expect(screen.getTextContent()).toContain(svg);
            expect(recentWorkspaceFilesState.read(recordKey)).toBeUndefined();
            expect(recentWorkspaceFilesState.read(workspaceKey)).toEqual(['legacy-only.txt']);

            refuse = false;
            const recoveredPath = 'assets/recovered.svg';
            transfer.setPayload(new TextEncoder().encode(svg), recoveredPath);
            await screen.update(fixture.wrap(file(recoveredPath)));
            await vi.waitFor(() => expect(recentWorkspaceFilesState.read(recordKey)).toEqual([recoveredPath]));
            await screen.pressByTestIdAsync('file-details-view-mode:file');
            expect(screen.getTextContent()).toContain(svg);
            expect(recentWorkspaceFilesState.read(workspaceKey)).toEqual(['legacy-only.txt']);
        } finally { write.mockRestore(); await screen?.unmount(); }
    });

    it.each([
        { platform: 'web', formFactor: 'tablet' },
        { platform: 'web', formFactor: 'phone' },
        { platform: 'ios', formFactor: 'phone' },
    ] as const)('offers the installed external viewer through its private File holder into the real $platform/$formFactor destination mount', async ({ platform, formFactor }) => {
        viewerViewport.width = formFactor === 'phone' ? 390 : 1280;
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const accountScope = getActiveServerAccountScope();
        if (!accountScope) throw new Error('Installed viewer fixture requires the restored Account');
        // Seed the initial server snapshot through the real scoped Settings owner, as the other Action fixtures do.
        await fixture.storage.getState().activateSettingsScope(accountScope);
        fixture.storage.getState().applySettingsForScope(accountScope, settingsParse({}), 0);
        // Openable content requires the daemon's byte-revision facts, not the cheap browsing stat.
        viewerStatBytes = new TextEncoder().encode('plain notes\n');
        transfer.setPayload(viewerStatBytes, 'notes.txt');
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope,
            id: 'project:installed-viewers', label: null, createdAtMs: 1, lastOpenedAtMs: null }] });
        const screen = await fixture.render(<ModalProvider><InstalledViewerFileHost projection={installedViewerProjection(platform)} platform={platform} formFactor={formFactor} /></ModalProvider>);
        const lastChoice = 'plugin-details-viewer-choice:openableContentViewer:com.external.viewer-11:text';
        try {
            await vi.waitFor(() => expect(screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.external.viewer-01:text'), screen.getTextContent()).not.toBeNull());
            // A real matching contribution beyond the old cap must be offered, not merely kept in a catalog.
            expect(screen.findByTestId(lastChoice)).not.toBeNull();
            await vi.waitFor(() => expect(screen.findByTestId(lastChoice)?.props.disabled).not.toBe(true));
            await screen.pressByTestIdAsync(lastChoice);
            await vi.waitFor(() => expect(fixture.storage.getState().settings.workspaceFileViewerPreferencesV1,
                JSON.stringify({ settingsRequests, settingsVersion: fixture.storage.getState().settingsVersion,
                    settingsScope: fixture.storage.getState().settingsScope, text: screen.getTextContent() })).toMatchObject({
                v: 1, selections: { 'mime:text/plain': { kind: 'plugin', pluginId: 'com.external.viewer-11', contributionLocalId: 'text' } },
            }));
            expect(settingsRequests).toContainEqual({ method: 'POST', status: 200 });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('External viewer 11 mounted'));
            // Exercise the public host admission as well as the real File holder. A freshly returned
            // viewer can have a pending plugin-daemon connection while its independent file binding works.
            const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces');
            const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const readSelectedFile = async (connectionPending = false) => {
                const mounted = screen.findByType(PluginSurfacePlacementHost);
                const binding = mounted.props.binding.openableContent;
                const ref = mounted.props.launchInput;
                expect(binding.ref).toEqual(ref);
                const controller = createBoundPluginSurfaceController({
                    facts: {
                        pluginId: 'com.external.viewer-11', contributionId: 'text-viewer',
                        surfaceId: 'surfacePlacement:com.external.viewer-11:text-viewer',
                        placement: 'projectSurface', platform, ...fixture.scope,
                        occurrenceId: mounted.props.placement.occurrenceId,
                        executionOrigin: mounted.props.placement.executionOrigin,
                        accountLifetime: captureActiveServerAccountScopeLifetime(), interactionEnabled: true,
                        daemonInteractionEnabled: !connectionPending,
                        isDaemonConnectionPending: () => connectionPending,
                    },
                    binding: { openableContent: binding },
                });
                try {
                    const statResult = await controller.hostApi.handleRequest({
                        version: 1, requestId: 'selected-file-stat', surface: controller.surfaceContext,
                        method: 'statOpenableContent', payload: { ref },
                    });
                    expect(statResult).toMatchObject({ status: 'ready' });
                    const stat = OpenableContentStatResultV1Schema.parse(statResult);
                    if (stat.status !== 'ready') throw new Error('Selected file must be readable');
                    return await controller.hostApi.handleRequest({
                        version: 1, requestId: 'selected-file-read', surface: controller.surfaceContext,
                        method: 'readOpenableContent', payload: { ref, expectedRevision: stat.revision, maxBytes: 256 * 1024 },
                    });
                } finally { controller.dispose(); }
            };
            expect(await readSelectedFile()).toMatchObject({ status: 'ready', content: { kind: 'utf8', text: 'plain notes\n' } });
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
            await act(async () => { fixture.storage.getState().applySettingsLocal({ experiments: true,
                featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': false,
                    'files.diffSyntaxHighlighting': false, 'files.editor': true } }); });
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel), screen.getTextContent()).toHaveLength(1));
            await act(async () => { screen.findByType(FileEditorPanel).props.onReady?.(); });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit.kind).toBe('done'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('External viewer 11 mounted'));
            expect(await readSelectedFile(true)).toMatchObject({ status: 'ready', content: { kind: 'utf8', text: 'plain notes\n' } });
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:openableContentViewer:com.external.viewer-10:text');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('External viewer 10 mounted'));
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:builtin');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('plain notes'));
            expect(screen.getTextContent()).not.toContain('External viewer 11 mounted');
            expect(settingsWrites.map(write => write.expectedVersion)).toEqual([0, 1, 2]);
        } finally { await screen.unmount(); }
    });

    it('mentions the file through the shared chooser and real mounted composer transaction owner', async () => {
        const { createExistingSessionComposerDocumentOwner } = await import('@/components/sessions/composer/existingSessionComposerDocumentOwner');
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { ComposerEntityDropTarget } = await import('@/components/sessions/composer/ComposerEntityDropTarget');
        const { SelectionList } = await import('@/components/ui/selectionList');
        const scope = { serverId: fixture.scope.serverId, accountId: 'alice' };
        const ref = { kind: 'session' as const, sessionId: fixture.session.id };
        const document = createExistingSessionComposerDocumentOwner({ scope, ref });
        document.replaceDocument({ text: 'Explain', structuredInputMentions: [], composerAttachments: [] });
        let unregister = () => {};
        try {
            await act(async () => {
                unregister = registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, {
                    readRevision: () => document.read().revision,
                    readScope: () => scope,
                    readSnapshot: () => projectComposerDocumentSnapshot({ owner: document, attachmentCatalog: { entriesById: null },
                        presentation: { layout: 'wrap', focused: false, editable: true, submittable: true, submitting: false, running: false } }),
                    replace: (text, revision) => revision === document.read().revision
                        ? document.replaceDocument({ ...document.read().document, text }) : document.read().revision,
                    commitDocument: ({ expectedRevision, mutation }) => document.apply(expectedRevision, mutation),
                });
            });
            const screen = await fixture.render(<ModalProvider>
                <WorkspaceFileDetailsView targetKind="session" scopeId="session:share" scope={fixture.scope}
                    filePath={filePath} sessionIdForAugmentation={fixture.session.id} />
                <ComposerEntityDropTarget id="file-share-composer" scope={scope} refValue={ref} bounds={() => null}
                    inputRef={{ current: null }} presented editable fileScope={fixture.scope} kinds={['file']} />
            </ModalProvider>);
            await vi.waitFor(() => expect(screen.findAllByType(ImageWell)).toHaveLength(1));
            await flushHookEffects({ cycles: 4 });
            const attach = screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'mentionInComposer');
            expect(attach).toBeDefined();
            let completion: Promise<void> | undefined;
            await act(async () => { completion = attach.onSelect(); });
            // The lazy modal mounts before its effect opens the staged carry.
            // Wait for the real actionable destination, not just the list shell.
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.root.findAllByType(SelectionList)).toHaveLength(1);
                const options = screen.findByType(SelectionList).props.rootStep.sections
                    .flatMap((section: { options: Array<{ id: string; disabled?: boolean }> }) => section.options);
                expect(options.some((item: { disabled?: boolean }) => !item.disabled), JSON.stringify(options)).toBe(true);
            });
            const chooser = screen.findByType(SelectionList);
            const options = chooser.props.rootStep.sections.flatMap((section: { options: Array<{ id: string; disabled?: boolean }> }) => section.options);
            const option = options.find((item: { disabled?: boolean }) => !item.disabled);
            await act(async () => { chooser.props.onSelect(option.id); });
            await act(async () => { await completion; });
            expect(document.read().document.text).toContain('Explain');
            expect(document.read().document.text).toContain('logo-dark.svg');
            expect(document.read().document.structuredInputMentions).toHaveLength(1);
            await screen.unmount();
        } finally { unregister(); }
    });

    it('opens binary-classified bytes as read-only text from the card, its one entry, and returns through the chooser', async () => {
        const binaryPath = 'opaque.bin';
        const text = 'misclassified source text\n';
        fixture.storage.getState().applySettingsLocal({ filesEditorWebMonacoEnabled: true,
            featureToggles: { ...fixture.storage.getState().settings.featureToggles, 'files.editor': true } });
        transfer.setPayload(new TextEncoder().encode(text), binaryPath);
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({
            entries: [{ path: binaryPath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
                hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
                stats: { pendingAdded: 0, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: true } }],
        }));
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const target = { ...fixture.scope, kind: 'project' as const, workspaceRefId: 'project:text-preview' };
        const host = {
            targetKind: 'project' as const, projection: EMPTY_PLUGIN_UI_PROJECTION, platform: 'web' as const,
            scopedLaunchFacts: { ...fixture.scope, interactionEnabled: true },
            details: {
                tab: { key: `file:${binaryPath}`, kind: 'workspace-file', title: binaryPath,
                    resource: { filePath: binaryPath }, isPreview: true, isPinned: false },
                descriptor: { surfaceId: 'workspace-file', resourceKey: `file:${binaryPath}`, scope: target,
                    region: 'details', status: 'available' },
                scope: target, region: 'details', active: true, callbacks: {},
            },
        } satisfies import('./WorkspaceFileDetailsView').WorkspaceFileOpenableContentViewerHost;
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:text-preview" scope={fixture.scope} filePath={binaryPath}
                sessionIdForAugmentation={null} openableContentViewer={host} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findByTestId('file-viewer-body-identity-learn-more')).not.toBeNull());
            await flushHookEffects({ cycles: 4 });
            expect(readInputs).toEqual([]);
            // One entry point (lab FV2b): the identity card's quiet "Open as text" link. No chooser band repeats it.
            expect(screen.findByTestId('plugin-details-viewer-choice:text')).toBeNull();
            expect(screen.findByTestId('plugin-details-viewer-choice:builtin')).toBeNull();
            await screen.pressByTestIdAsync('file-viewer-body-identity-learn-more');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(text.trim()));
            expect(screen.findByTestId('file-viewer-body-identity')).toBeNull();
            const { FilePageHeader } = await import('../file/FilePageHeader');
            expect(screen.findByType(FilePageHeader).props.fileEditorEnabled).toBe(false);
            expect(readInputs).toContainEqual(expect.objectContaining({ path: '/workspace/opaque.bin' }));
            // Once the card has gone, the chooser is the way back to the built-in view.
            await vi.waitFor(() => expect(screen.findByTestId('plugin-details-viewer-choice:builtin'), screen.getTextContent()).not.toBeNull());
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:builtin');
            await vi.waitFor(() => expect(screen.findByTestId('file-viewer-body-identity'), screen.getTextContent()).not.toBeNull());
        } finally { await screen.unmount(); }
    });

    it.each([false, true])('offers Open Changes only when the shown scope has changes for the file (changed %s)', async (changed) => {
        const textPath = 'notes.txt';
        transfer.setPayload(new TextEncoder().encode('plain notes\n'), textPath);
        if (changed) {
            scmDiff = 'diff --git a/notes.txt b/notes.txt\n@@ -1 +1 @@\n-old notes\n+plain notes\n';
            fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({
                entries: [{ path: textPath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
                    hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
                    stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: false } }],
            }));
        }
        const onOpenChanges = vi.fn();
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="workspace:open-changes" scope={fixture.scope} filePath={textPath}
                sessionIdForAugmentation={null} onOpenChanges={onOpenChanges} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('plain notes'));
            await flushHookEffects({ cycles: 4 });
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const ids = () => screen.findByType(FilePageHeader).props.menuActions.map((item: { id: string }) => item.id);
            // The same predicate as Discard all changes in this file: the two appear and disappear together.
            if (changed) await vi.waitFor(() => expect(ids()).toContain('discard'));
            expect(ids().includes('openChanges')).toBe(changed);
            expect(ids().includes('discard')).toBe(changed);
        } finally { await screen.unmount(); }
    });

    it('draws no viewer choice band for a text file that has nothing else to open with', async () => {
        const textPath = 'notes.txt';
        const text = 'plain notes\n';
        transfer.setPayload(new TextEncoder().encode(text), textPath);
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const target = { ...fixture.scope, kind: 'project' as const, workspaceRefId: 'project:text-notes' };
        const host = {
            targetKind: 'project' as const, projection: EMPTY_PLUGIN_UI_PROJECTION, platform: 'web' as const,
            scopedLaunchFacts: { ...fixture.scope, interactionEnabled: true },
            details: {
                tab: { key: `file:${textPath}`, kind: 'workspace-file', title: textPath,
                    resource: { filePath: textPath }, isPreview: true, isPinned: false },
                descriptor: { surfaceId: 'workspace-file', resourceKey: `file:${textPath}`, scope: target,
                    region: 'details', status: 'available' },
                scope: target, region: 'details', active: true, callbacks: {},
            },
        } satisfies import('./WorkspaceFileDetailsView').WorkspaceFileOpenableContentViewerHost;
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:text-notes" scope={fixture.scope} filePath={textPath}
                sessionIdForAugmentation={null} openableContentViewer={host} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(text.trim()));
            await flushHookEffects({ cycles: 4 });
            expect(screen.findByTestId('plugin-details-viewer-choice:builtin')).toBeNull();
            expect(screen.findByTestId('plugin-details-viewer-choice:text')).toBeNull();
            // ⋯ › Info opens the facts of this file (the text's encoding facts are an object, not a name).
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const info = screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'info');
            await act(async () => { await info.onSelect(); });
            await vi.waitFor(() => expect(screen.findByTestId('file-info-dialog')).not.toBeNull());
            expect(screen.findByTestId('file-info-lines')).not.toBeNull();
            await act(async () => Modal.hideAll());
        } finally { await screen.unmount(); }
    });

    it.each([null, 's1'])('keeps the Project link and publication source with augmentation %s', async (augmentation) => {
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope, id: 'project-svg', label: null,
            createdAtMs: 1, lastOpenedAtMs: null }] });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:svg-preview" targetKind="project" workspaceRefId="project-svg"
                scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={augmentation} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findAllByType(ImageWell)).toHaveLength(1));
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const ids = screen.findByType(FilePageHeader).props.menuActions.map((item: { id: string }) => item.id);
            expect(ids).toEqual(expect.arrayContaining(['copyLink', 'info', 'background', 'saveAsArtifact']));
            await act(async () => { await screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'saveAsArtifact').onSelect(); });
            const { SaveFileAsArtifactDialog } = await import('../file/SaveFileAsArtifactDialog');
            const dialog = screen.findByType(SaveFileAsArtifactDialog);
            expect(dialog.props.source).toMatchObject({ sourceSessionId: null,
                sourceWorkspace: { machineId: fixture.scope.machineId, rootPath: fixture.scope.rootPath } });
            expect(dialog.props.onOpenArtifact).toEqual(expect.any(Function));
            await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-save')?.props.disabled).toBe(false));
            await act(async () => Modal.hideAll());
            await flushHookEffects({ cycles: 4 });
            const menu = screen.findByType(FilePageHeader).props.menuActions;
            const alerts = vi.spyOn(Modal, 'alert');
            await act(async () => { await menu.find((item: { id: string }) => item.id === 'copyLink').onSelect(); });
            const { buildWorkspaceFileLink } = await import('@/utils/url/sessionFileDeepLink');
            expect(clipboard.setStringAsync.mock.calls.at(-1)?.[0], JSON.stringify({ ui: screen.getTextContent(), alerts: alerts.mock.calls })).toBe(buildWorkspaceFileLink({
                target: { kind: 'project', workspaceRefId: 'project-svg', ...fixture.scope }, path: filePath,
            }));
            await act(async () => { await menu.find((item: { id: string }) => item.id === 'copyPath').onSelect({ altKey: true }); });
            expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(`/workspace/${filePath}`);
        } finally { await screen.unmount(); }
    });

    it('opens held XML in the image Preview, switches to Source and back, then opens those held bytes in the stage', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:svg-preview" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect({ actionRequests, readInputs }).toMatchObject({
                actionRequests: expect.arrayContaining(['/v1/actions/daemon.filesystem.readFile']),
                readInputs: expect.arrayContaining([expect.objectContaining({ path: '/workspace/assets/logo-dark.svg' })]),
            }));
            // An SVG renders as an image (PROGRAM D-F1): Preview is the default view and Source is one tap away.
            await vi.waitFor(() => expect(screen.findAllByType(ImageWell)).toHaveLength(1));
            // Its facts say what the picture is, never how many lines its XML has (lab FV4s "646 × 854 · SVG · 8.5 KB").
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const facts = () => (screen.findByType(FilePageHeader).props.summaryFacts ?? []) as readonly string[];
            expect(facts()).toContain('SVG image');
            expect(facts().some((fact) => /line/i.test(fact))).toBe(false);
            await screen.pressByTestIdAsync('file-details-view-mode:file');
            expect(screen.findAllByType(ImageWell)).toHaveLength(0);
            expect(screen.getTextContent()).toContain(svg);
            await screen.pressByTestIdAsync('file-details-view-mode:markdown');
            expect(screen.findAllByType(ImageWell)).toHaveLength(1);
            const previewUri = screen.findByTestId('file-viewer-body-picture')!.props.source.uri as string;
            expect(previewUri).toMatch(/^blob:/);
            expect(await (await fetch(previewUri)).text()).toBe(svg);
            expect(transfer.prepares).toHaveLength(0);

            await screen.pressByTestIdAsync('file-details-view-mode:file');
            expect(screen.findAllByType(ImageWell)).toHaveLength(0);
            expect(screen.getTextContent()).toContain(svg);
            await screen.pressByTestIdAsync('file-details-view-mode:markdown');
            await screen.pressByTestIdAsync('file-viewer-body-open');
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-image')).not.toBeNull());
            const stageUri = screen.findByTestId('media-stage-image')!.props.source.uri as string;
            expect(stageUri).toMatch(/^blob:/);
            expect(await (await fetch(stageUri)).text()).toBe(svg);
            // File SVG is already read text: expansion must not start a binary file acquisition.
            expect(transfer.prepares).toHaveLength(0);

            await act(async () => Modal.hideAll());
            await screen.pressByTestIdAsync('file-details-view-mode:file');
            const updatedSvg = svg.replace('black', 'white');
            transfer.setPayload(new TextEncoder().encode(updatedSvg), filePath);
            // A changed working-tree entry publishes a refresh; timestamp-only equivalent snapshots are suppressed.
            await act(async () => fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ fetchedAt: 2,
                entries: [{ path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
                    hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
                    stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: false } }],
            })));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(updatedSvg));
            await screen.pressByTestIdAsync('file-details-view-mode:markdown');
            await screen.pressByTestIdAsync('file-viewer-body-open');
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-image')).not.toBeNull());
            const updatedStageUri = screen.findByTestId('media-stage-image')!.props.source.uri as string;
            expect(await (await fetch(updatedStageUri)).text()).toBe(updatedSvg);
            expect(transfer.prepares).toHaveLength(0);
        } finally { await act(async () => { await screen.unmount(); }); }
    });
});
