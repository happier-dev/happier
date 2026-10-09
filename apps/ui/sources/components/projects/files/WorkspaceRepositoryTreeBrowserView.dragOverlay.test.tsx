// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createRepositoryPickerInputHost, nativeDocumentPickerBoundary } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit')).createModalModuleMock().module);
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
// React DOM's portal is an external renderer boundary; retain the real carried preview inline.
vi.mock('@/utils/web/reactDomCjs', () => {
    const reactDom = { createPortal: (content: React.ReactNode) => content };
    return { requireReactDOM: () => reactDom, preloadReactDOM: async () => reactDom };
});

// Node does not apply Metro's platform suffix resolution; execute the real web owner.
vi.mock('@/hooks/ui/useWebFileDropZone', () => import('@/hooks/ui/useWebFileDropZone.web'));

vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

describe('WorkspaceRepositoryTreeBrowserView (drag overlay)', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let restoreLocks = () => {};
    beforeAll(async () => {
        const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        restoreLocks = installWebLockManagerMock().restore;
        await prepareSessionFilesViewTestkit();
    });
    afterAll(() => restoreLocks());
    beforeEach(async () => {
        // Browser feature detection is an external platform boundary.
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: '/repo', entries: [], truncated: false };
            if (request.method === RPC_METHODS.STAT_FILE) return { success: true, exists: false };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
    });

    afterEach(async () => {
        standardCleanup();
        await fixture?.dispose();
        vi.unstubAllGlobals();
    });

    function statRequests() { return fixture.requests.filter(request => request.method === RPC_METHODS.STAT_FILE); }
    async function renderBrowser(inputs: HTMLInputElement[] = []) {
        const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
        const { useActiveServerAccountScope, useServerScopedMachine, useLocalSetting } = await import('@/sync/domains/state/storage');
        const { useServerFeaturesSnapshotForServerId } = await import('@/sync/domains/features/featureDecisionRuntime');
        const { isBrowserIrohHost } = await import('@/sync/runtime/browserIroh/hostEligibility');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const { isIrohMachineTransferLifecycleAvailable, subscribeIrohMachineTransferLifecycleAvailability } = await import('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle');
        const { isMachineDaemonFiniteTransferApplicationSupported } = await import('@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState');
        const { readCurrentMachineIrohEndpoint, resolveMachineCarrierPreselection } = await import('@/sync/domains/transfers/runtime/transferRuntime/routing/resolveMachineCarrierPreselection');
        let admission: unknown;
        // Diagnose the actual admission inputs, without substituting any owner decision.
        function AdmissionProjection() {
            const account = useActiveServerAccountScope();
            const machine = useServerScopedMachine(fixture.scope.serverId, fixture.scope.machineId);
            const applicationCarrierEligibility = useLocalSetting('homeApplicationCarrierEligibility');
            const features = useServerFeaturesSnapshotForServerId(fixture.scope.serverId);
            const nativeLifecycleAvailable = React.useSyncExternalStore(subscribeIrohMachineTransferLifecycleAvailability,
                isIrohMachineTransferLifecycleAvailable, isIrohMachineTransferLifecycleAvailable);
            const endpoint = readCurrentMachineIrohEndpoint({ capabilities: machine?.operationProtocolCapabilities,
                revision: machine?.operationProtocolCapabilitiesRevision, active: machine?.active, revokedAt: machine?.revokedAt });
            const host = isBrowserIrohHost() ? { kind: 'browser' as const }
                : { kind: 'native' as const, lifecycleAvailable: nativeLifecycleAvailable };
            const finiteTransferApplicationSupported = isMachineDaemonFiniteTransferApplicationSupported(machine?.daemonState);
            const preselection = resolveMachineCarrierPreselection({ applicationCarrierEligibility, host, targetEndpoint: endpoint,
                finiteTransferApplicationSupported, serverFeatures: features.status === 'ready' ? features.features : null });
            admission = { account, machineOnline: machine ? isMachineOnline(machine) : false,
                machine: machine ? { active: machine.active, activeAt: machine.activeAt, kind: machine.kind,
                capabilitiesRevision: machine.operationProtocolCapabilitiesRevision } : null,
                applicationCarrierEligibility, featuresStatus: features.status,
                machineFeatures: features.status === 'ready' ? features.features.features.machines : null,
                endpoint, host, finiteTransferApplicationSupported, preselection: preselection.kind };
            return null;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const dropZone = document.createElement('div');
        screen = await fixture.render(
            <><AdmissionProjection /><WorkspaceRepositoryTreeBrowserView
                scope={fixture.scope}
                scmSnapshot={null}
                onOpenFile={vi.fn()}
            /></>,
            { createNodeMock: element => {
                if (element.props.testID === 'repository-tree-drop-zone') return dropZone;
                const testId = element.props['data-testid'];
                return createRepositoryPickerInputHost(element, inputs,
                    () => screen?.findAllByProps({ 'data-testid': testId })[0]?.props.onChange);
            } },
        );
        return { screen, dropZone, admission: () => JSON.stringify(admission) };
    }
    async function drag(host: HTMLElement, type: string, dataTransfer: Readonly<{ types: string[]; files?: File[] }>) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 120, clientY: 60 });
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        await act(async () => host.dispatchEvent(event));
    }

    it('surfaces the hovered upload destination in the drop overlay', async () => {
        const { screen, dropZone, admission } = await renderBrowser();
        const row = document.createElement('div');
        row.setAttribute('data-repository-drop-destination', 'src/components');
        row.setAttribute('data-repository-drop-hover', 'src/components');
        dropZone.appendChild(row);
        await drag(row, 'dragenter', { types: ['Files'] });
        expect(screen.findByTestId('repository-tree-drop-overlay'), admission()).toBeTruthy();
        expect(screen.getTextContent()).toContain('src/components');
    });

    it('shows drop feedback and dispatches files to the row at release rather than an earlier hover', async () => {
        const { screen, dropZone, admission } = await renderBrowser();
        await drag(dropZone, 'dragenter', { types: ['Files'] });
        expect(screen.findByTestId('repository-tree-drop-overlay'), admission()).toBeTruthy();

        const file = new File(['hello'], 'a.txt');
        const releaseRow = document.createElement('div');
        releaseRow.setAttribute('data-repository-drop-destination', 'src/release');
        dropZone.appendChild(releaseRow);
        await drag(releaseRow, 'drop', { types: ['Files'], files: [file] });
        await flushHookEffects();

        await vi.waitFor(() => expect(statRequests()).toContainEqual(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: '/repo/src/release/a.txt' },
        })));
    });

    it.each(['files', 'folder'] as const)('acquires an Action %s picker and preserves its exact requested destination', async kind => {
        const inputs: HTMLInputElement[] = [];
        const { admission } = await renderBrowser(inputs);
        const input = inputs.find(candidate => candidate.hasAttribute('webkitdirectory') === (kind === 'folder'))!;
        expect(input).toBeTruthy();
        const clicked = vi.fn();
        input.addEventListener('click', clicked);
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
            workspace: fixture.scope,
            kind, destinationDir: 'requested/subdir',
        }), admission()).toEqual({ status: 'requested' });
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(statRequests()).toHaveLength(0);
        const file = new File(['hello'], 'a.txt');
        const relativePath = kind === 'folder' ? 'docs/a.txt' : 'a.txt';
        Object.defineProperty(file, 'webkitRelativePath', { value: kind === 'folder' ? relativePath : '' });
        Object.defineProperty(input, 'files', { value: [file] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        await vi.waitFor(() => expect(statRequests()).toContainEqual(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.STAT_FILE, payload: { path: `/repo/requested/subdir/${relativePath}` },
        })));
    });

    it.each(['workspace', 'account', 'home'] as const)('retires an open Action picker after its %s changes', async changed => {
        const inputs: HTMLInputElement[] = [];
        const { screen, admission } = await renderBrowser(inputs);
        const input = inputs.find(candidate => !candidate.hasAttribute('webkitdirectory'))!;
        expect(await invokeRepositoryUploadPick({
            scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
            workspace: fixture.scope,
            kind: 'files', destinationDir: 'requested/subdir',
        }), admission()).toEqual({ status: 'requested' });
        if (changed === 'workspace') {
            const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
            await screen.update(fixture.wrap(<WorkspaceRepositoryTreeBrowserView scope={{ ...fixture.scope, rootPath: '/other' }} scmSnapshot={null} onOpenFile={vi.fn()} />));
        } else {
            const { getStorage } = await import('@/sync/domains/state/storage');
            await act(async () => getStorage().setState({ profileScope: {
                serverId: changed === 'home' ? 'other-home' : fixture.scope.serverId, accountId: 'other-account',
            } }));
            // Returning to the same Account must not revive the earlier OS selection.
            if (changed === 'account') await act(async () => getStorage().setState({ profileScope: { serverId: fixture.scope.serverId, accountId: 'alice' } }));
        }
        const previousStats = statRequests().length;
        Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.txt')] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flushHookEffects();
        expect(statRequests()).toHaveLength(previousStats);
    });

    it('retires a native picker awaiting OS selection before transferring under another Account', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        let finishSelection!: (value: unknown) => void;
        nativeDocumentPickerBoundary.mockImplementationOnce(() => new Promise(resolve => { finishSelection = resolve; }));
        try {
            const { admission } = await renderBrowser();
            const requested = invokeRepositoryUploadPick({
                scope: { serverId: fixture.scope.serverId, accountId: 'alice' },
                workspace: fixture.scope,
                kind: 'files', destinationDir: 'requested/subdir',
            });
            await vi.waitFor(() => expect(finishSelection, admission()).toBeTypeOf('function'));
            const { getStorage } = await import('@/sync/domains/state/storage');
            await act(async () => getStorage().setState({ profileScope: { serverId: fixture.scope.serverId, accountId: 'other-account' } }));
            await act(async () => {
                finishSelection({ canceled: false, assets: [{ uri: 'file:///selected/a.txt', name: 'a.txt', size: 5, mimeType: 'text/plain' }] });
                await expect(requested).resolves.toEqual({ status: 'cancelled' });
            });
            expect(statRequests()).toHaveLength(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
        }
    });
});
