import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPromptMachineTransferFixture, installPromptMachineSocketBoundary } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { installPromptAssetsCommonModuleMocks } from './promptAssetsScreenTestHelpers';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptMachineSocketBoundary();
installPromptAssetsCommonModuleMocks({ storage: original => original(), reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
} });
const { storage } = await import('@/sync/domains/state/storage');
const { PromptAssetExportScreen } = await import('./PromptAssetExportScreen');
const docType: PromptAssetTypeDescriptorV1 = { id: 'claude.command', providerId: 'claude', title: 'Commands', description: 'Markdown',
    libraryKind: 'doc', supportsScope: { user: true, project: true }, supportsFiles: false, formatId: 'markdown_utf8_v1',
    defaultRoots: [], capabilities: {} };
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let previousState: ReturnType<typeof storage.getState>;
beforeEach(() => { previousState = storage.getState(); });
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); storage.setState(previousState, true); });

async function seed(serverId: string, title: string, markdown: string) {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
        await account.workflowArtifacts.create({ artifactId: 'same-doc', header: { v: 1, kind: 'prompt_doc.v2', title },
            body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }) });
    } finally { account.dispose(); }
}

describe('PromptAssetExportScreen exact library Home', () => {
    it('exports the selected inactive library document through an independent same-id Machine and preserves its legacy original-Home link', async () => {
        await loadSyncSingletonForTests();
        const libraryUrl = 'https://selected-export-library.test';
        const machineUrl = 'https://selected-export-machine.test';
        const libraryIdentity = 'srv_export_library';
        const machineIdentity = 'srv_export_machine';
        const machineCatalog = createPromptLibraryCatalogBoundary();
        const libraryCatalog = createPromptLibraryCatalogBoundary({ revision: 4, records: [{
            key: 'external-links', value: { v: 1, links: [{ id: 'legacy-link', artifactId: 'same-doc', assetTypeId: docType.id,
                machineId: 'machine-1', scope: 'user', workspacePath: null, externalRef: { relativePath: 'legacy.md' } }] },
        }] });
        // The Machine Home is already displayed/admitted before opening an
        // inactive library. No Home-navigation bootstrap belongs to this flow.
        fixture = await createPromptMachineTransferFixture({ serverUrl: machineUrl, serverIdentityId: machineIdentity,
            selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets, types: [docType],
            handleHomeRequest: machineCatalog.handle,
            libraryHome: { serverUrl: libraryUrl, serverIdentityId: libraryIdentity, handleHomeRequest: libraryCatalog.handle } });
        await seed(fixture.serverId, 'Machine document', 'Wrong Home instructions');
        const libraryHome = fixture.libraryHome;
        if (!libraryHome) throw new Error('Saved inactive library Home was not prepared');
        await seed(libraryHome.serverId, 'Library document', 'Library instructions');
        fixture.selectMachine('machine-1');
        const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/connectionManager');
        expect(getAppliedActiveServerSnapshot()).toMatchObject({ serverId: fixture.scope.serverId });
        expect(storage.getState().isDataReady).toBe(true);
        expect(storage.getState().settingsScope).toEqual(fixture.scope);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const library = await captureLazyActionAccountContext(libraryHome.serverId);
        const libraryScope = library.accountLifetime.scope;
        expect(libraryScope).toEqual(libraryHome.scope);
        try {
            const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
            const { readPromptLibraryArtifactForExport } = await import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations');
            expect(await readPromptLibraryArtifactForExport({ store: createUiPromptLibraryArtifactStore(library.workflowArtifacts, library),
                artifactId: 'same-doc' })).toMatchObject({ libraryKind: 'doc', markdown: 'Library instructions' });
        } finally { library.dispose(); }
        expect(getAppliedActiveServerSnapshot()).toMatchObject({ serverId: fixture.scope.serverId });
        expect(storage.getState().settingsScope).toEqual(fixture.scope);
        const { refreshPromptLibraryCatalog, observePromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        const stopObservation = observePromptLibraryCatalog(libraryScope);
        try {
            await refreshPromptLibraryCatalog(libraryScope);
            const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
            expect(getPromptLibraryCatalogValue(libraryScope, 'external-links'), JSON.stringify(fixture.diagnostic()))
                .toMatchObject({ status: 'ready', stale: false });
            const { machinePromptAssetsListTypes } = await import('@/sync/ops/machinePromptAssets');
            const admittedTypes = await machinePromptAssetsListTypes('machine-1', { serverId: fixture.serverId });
            expect(admittedTypes).toMatchObject({ ok: true, types: [{ id: docType.id, libraryKind: 'doc', supportsScope: { user: true } }] });
            const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
            const screen = await renderScreen(<PromptAssetExportScreen artifactId="same-doc" serverId={libraryHome.serverId}
                initialSelection={{ scope: 'user', assetTypeId: docType.id }} />);
            await vi.waitFor(() => expect(screen.findByTestId('promptAssetExport.export')?.props.disabled, JSON.stringify({ ...fixture.diagnostic(),
                catalog: getPromptLibraryCatalogValue(libraryScope, 'external-links'),
                admittedTypes,
                freshTarget: resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: machineIdentity, machineId: 'machine-1' }),
                isDataReady: storage.getState().isDataReady,
                appliedHome: getAppliedActiveServerSnapshot(),
                target: screen.findByTestId('promptAssetExport.targetInput')?.props.value,
                renderedText: screen.findAll(node => typeof node.props.children === 'string').map(node => node.props.children),
            })).toBe(false));
            expect(screen.findByTestId('promptAssetExport.linked')).toBeNull();
            expect(screen.findByTestId('promptAssetExport.targetInput')?.props.value).not.toBe('legacy.md');
            await screen.pressByTestIdAsync('promptAssetExport.export');
            await vi.waitFor(() => expect(fixture.uploadedRequests.some(request => request.previewOnly === false)).toBe(true));
            const committed = fixture.uploadedRequests.find(request => request.previewOnly === false);
            expect(committed).toMatchObject({ markdown: 'Library instructions' });
            await vi.waitFor(() => expect(libraryCatalog.read('external-links')).toMatchObject({ value: { links: [
                { id: 'legacy-link', externalRef: { relativePath: 'legacy.md' } },
                { artifactId: 'same-doc', machineId: 'machine-1', serverIdentityId: machineIdentity },
            ] } }));
            expect(fixture.daemonRequests.some(request => request.method.endsWith(':daemon.directTransfer.import.prepare'))).toBe(true);
            expect(machineCatalog.read('external-links')).toMatchObject({ value: { links: [] } });
            expect(machineCatalog.requests).toEqual([]);
            expect(storage.getState().settingsScope).toEqual(fixture.scope);
            expect(getAppliedActiveServerSnapshot()).toMatchObject({ serverId: fixture.scope.serverId });
        } finally { stopObservation(); }
    });
});
