import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    applyLocalServiceInventoryRefreshStarted,
    applyLocalServiceInventorySnapshot,
} from '@/sync/domains/local/services/inventory/store';
import {
    buildLocalServiceInventoryRow,
    buildLocalServiceInventoryState,
    createMachineFixture,
    flushHookEffects,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    type LocalServiceLauncherSnapshot,
} from '@/sync/domains/local/services/launch';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { Text } from '@/components/ui/text/Text';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';

import { ProjectPageBackProvider } from '@/components/projects/detail/projectPageBack';
import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import type { UserProfile } from '@happier-dev/protocol';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { commitPreferredLanguage, getPreferredLanguage } from '@/text/preferredLanguage';

function collectText(node: ReactTestInstance): string {
    return node.children.map((child) => typeof child === 'string' ? child : collectText(child)).join(' ');
}

const deviceState = vi.hoisted(() => ({ type: 'tablet' as 'phone' | 'tablet' }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useDeviceType: () => deviceState.type,
}));

function PlacementProbe(): React.ReactElement {
    return <Text testID="placement-probe">Runs on</Text>;
}

/** The pane header as the sidebar/cockpit hosts draw it: the title plus what the tab published. */
function HeaderProbe(): React.ReactElement {
    const published = usePublishedPaneHeaderContent('services');
    return (
        <PaneHeader
            testID="probe-header"
            title="Local services"
            line={published?.line ?? null}
            actions={published?.action}
        />
    );
}

function inHeaderHost(children: React.ReactNode): React.ReactElement {
    return (
        <PaneHeaderSlotProvider>
            <HeaderProbe />
            <PaneHeaderSlotScope slotKey="services">{children}</PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    );
}

const MACBOOK_ONLINE = { name: 'MacBook Pro', homeDir: null, reachability: 'reachable' as const };
const MACBOOK_OFFLINE = { name: 'MacBook Pro', homeDir: null, reachability: 'unreachable' as const };

async function expandRow(screen: Awaited<ReturnType<typeof renderScreen>>, rowTestID: string): Promise<void> {
    await pressTestInstanceAsync(screen.findByTestId(`${rowTestID}-item`), `${rowTestID}-item`);
}

function launcherStateWith(targets: LocalServiceLauncherSnapshot['targets'], sessionId?: string) {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        ...(sessionId ? { sessionId } : {}),
        updatedAt: 3_000,
        targets,
    });
}

const openableTarget = {
    id: 'inventory:openable-row',
    source: 'inventory_entry' as const,
    sourceClass: { kind: 'inventory_entry' as const, inventoryEntryId: 'openable-row' },
    machineId: 'machine-a',
    sessionId: 'session-a',
    title: 'Openable preview',
    subtitle: 'localhost:5173',
    confidence: 'high' as const,
    state: 'available' as const,
    actions: ['open' as const],
    browserTarget: {
        kind: 'externalUrl' as const,
        targetId: 'inventory-loopback:openable-row',
        url: 'http://127.0.0.1:5173/',
        display: { title: 'Openable preview', addressLabel: 'localhost:5173' },
    },
};

describe('DetectedLocalServicesPane', () => {
    it.each(['tablet', 'phone'] as const)('commits no unchanged Service row details across repeated scan observations, then renders a real change (%s)', async device => {
        deviceState.type = device;
        const originalLanguage = getPreferredLanguage();
        const inventoryRow = buildLocalServiceInventoryRow({ id: 'openable-row' });
        let inventory = buildLocalServiceInventoryState({ rows: [inventoryRow] });
        let launcher = launcherStateWith([openableTarget]);
        let commits = 0;
        const placement = () => <React.Profiler id="service-row-detail" onRender={() => { commits++; }}>
            <Text>{`language:${getPreferredLanguage()}`}</Text>
        </React.Profiler>;
        const render = () => <DetectedLocalServicesPane inventoryState={inventory} launcherState={launcher}
            machine={MACBOOK_ONLINE} publicPreviewState={null} renderServicePlacement={placement} testID="scan-cost" />;
        const screen = await renderScreen(render());
        try {
            await expandRow(screen, 'scan-cost-row:inventory:openable-row');
            await flushHookEffects();
            expect(commits).toBeGreaterThan(0);
            commits = 0;
            for (let generation = 2; generation <= 76; generation++) {
                inventory = applyLocalServiceInventorySnapshot(inventory, { v: 1, machineId: 'machine-a',
                    generatedAt: generation * 4_000, refreshState: 'idle', diagnostics: [],
                    entries: [{ ...inventoryRow, lastSeenAt: generation * 4_000 }] });
                launcher = applyLocalServiceLauncherSnapshot(launcher, { v: 1, machineId: 'machine-a',
                    updatedAt: generation * 4_000, targets: [structuredClone(openableTarget)] });
                await screen.update(render());
            }
            expect(commits).toBe(0);
            launcher = applyLocalServiceLauncherSnapshot(launcher, { v: 1, machineId: 'machine-a',
                updatedAt: 400_000, targets: [{ ...openableTarget, title: 'Changed service' }] });
            await screen.update(render());
            expect(commits).toBeGreaterThan(0);
            expect(screen.getTextContent()).toContain('Changed service');
            const nextLanguage = originalLanguage === 'fr' ? 'en' : 'fr';
            await act(async () => { commitPreferredLanguage(nextLanguage); });
            expect(screen.getTextContent()).toContain(`language:${nextLanguage}`);
        } finally {
            await screen.unmount(); deviceState.type = 'tablet'; commitPreferredLanguage(originalLanguage);
        }
    });
    it('keeps one declared Service selected through native handoffs and phone recomposition', async () => {
        const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-web', source: 'managed_service',
            machineId: 'machine-a', title: 'Web', confidence: 'high', state: 'unavailable',
            unavailableReason: 'launch_unavailable',
            workspace: { serverId: 'home', machineId: 'machine-a', workspaceId: 'source-ref', rootPath: '/source' },
            declaration: { workspaceRefId: 'source-ref', selection: { kind: 'manifest', name: 'web' } } });
        const worker = LocalServiceLaunchTargetV1Schema.parse({ ...declaration, id: 'worker-web', machineId: 'worker',
            workspace: { ...declaration.workspace, machineId: 'worker', workspaceId: 'worker-ref', rootPath: '/copy' },
            declaration: { workspaceRefId: 'worker-ref', selection: { kind: 'manifest', name: 'web' } },
            sourceClass: { kind: 'managed_service', managedServiceId: 'worker-instance' },
            state: 'available', unavailableReason: undefined, serviceState: 'running', actions: ['manage'] });
        const pane = (target: typeof declaration) => <DetectedLocalServicesPane
            inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            launcherState={{ ...launcherStateWith([target]), rowIdsByTargetId: new Map([[target.id, declaration.id]]) }}
            renderServicePlacement={() => <PlacementProbe />} testID="continuity" />;
        deviceState.type = 'tablet';
        const screen = await renderScreen(pane(declaration));
        try {
            await expandRow(screen, 'continuity-row:source-web');
            expect(screen.findByTestId('placement-probe')).toBeTruthy();
            await screen.update(pane(worker));
            expect(screen.findByTestId('continuity-row:source-web-expansion')).toBeTruthy();
            expect(screen.findByTestId('placement-probe')).toBeTruthy();
            deviceState.type = 'phone';
            await screen.update(pane(worker));
            expect(screen.findByTestId('continuity-detail')).toBeTruthy();
            expect(screen.findAllByType(PlacementProbe)).toHaveLength(1);
            await screen.update(pane(declaration));
            expect(screen.findByTestId('continuity-detail')).toBeTruthy();
            deviceState.type = 'tablet';
            await screen.update(pane(declaration));
            expect(screen.findByTestId('continuity-row:source-web-expansion')).toBeTruthy();
            expect(screen.findAllByType(PlacementProbe)).toHaveLength(1);
            deviceState.type = 'phone';
            await screen.update(pane(declaration));
            await pressTestInstanceAsync(screen.findByTestId('continuity-detail-back'), 'back');
            deviceState.type = 'tablet';
            await screen.update(pane(declaration));
            expect(screen.findByTestId('continuity-row:source-web-expansion')).toBeNull();
        } finally { deviceState.type = 'tablet'; await screen.unmount(); }
    });
    it('resolves the unavailable binding Machine through the real scoped row wiring', async () => {
        const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const home = await createPlainArtifactHomeFixture('https://service-binding-machine.test');
        const serverId = home.home.id;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previous = storage.getState();
        const source = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        const worker = createMachineFixture({ id: 'worker', active: false, activeAt: 0,
            metadata: { ...source.metadata!, displayName: 'Windows workstation' } });
        storage.setState({ machines: { 'machine-a': source, worker }, machineListByServerId: { [serverId]: [source, worker] } });
        const target = LocalServiceLaunchTargetV1Schema.parse({ id: 'web', source: 'managed_service',
            machineId: source.id, title: 'Web', confidence: 'high', state: 'unavailable',
            unavailableReason: 'project_service_binding_unavailable', unavailableMachineId: worker.id,
            workspace: { serverId, machineId: source.id, workspaceId: 'source-ref', rootPath: '/source' },
            declaration: { workspaceRefId: 'source-ref', selection: { kind: 'manifest', name: 'web' } } });
        try {
            const screen = await renderScreen(<DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={launcherStateWith([target])} machine={MACBOOK_ONLINE}
                sourceMachineId={source.id} serverId={serverId} testID="binding-pane" />);
            try {
                expect(collectText(screen.findByTestId('binding-pane-row:web-reason')!)).toContain('Windows workstation');
                expect(screen.findByTestId('binding-pane-row:web-start')).toBeNull();
                await act(async () => {
                    const renamed = { ...worker, metadata: { ...worker.metadata!, displayName: 'Build desktop' } };
                    storage.setState({ machines: { 'machine-a': source, worker: renamed }, machineListByServerId: { [serverId]: [source, renamed] } });
                });
                expect(collectText(screen.findByTestId('binding-pane-row:web-reason')!)).toContain('Build desktop');
            } finally { await screen.unmount(); }
        } finally { storage.setState(previous); await home.dispose(); }
    });
    it('uses the actual worker Machine for row facts and Last known independently of the Source', async () => {
        const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const home = await createPlainArtifactHomeFixture('https://worker-services-presence.test');
        const serverId = home.home.id;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previous = storage.getState();
        const source = createMachineFixture({ id: 'machine-a', active: false, activeAt: 0 });
        const worker = createMachineFixture({ id: 'worker', activeAt: Date.now(), metadata: { ...source.metadata!, displayName: 'Build worker' } });
        storage.setState({ machines: { 'machine-a': source, worker }, machineListByServerId: { [serverId]: [source, worker] } });
        const target = { id: 'worker-jobs', source: 'managed_service' as const,
            sourceClass: { kind: 'managed_service' as const, managedServiceId: 'worker-jobs' },
            machineId: 'worker', title: 'Jobs', confidence: 'high' as const, state: 'available' as const,
            serviceState: 'running' as const, actions: ['manage' as const] };
        try {
            const screen = await renderScreen(<DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={launcherStateWith([target])} machine={MACBOOK_OFFLINE}
                sourceMachineId="machine-a" serverId={serverId} renderServicePlacement={() => <PlacementProbe />}
                testID="worker-pane" />);
            expect(collectText(screen.findByTestId('worker-pane-row:worker-jobs')!)).toContain('on Build worker');
            expect(collectText(screen.findByTestId('worker-pane-row:worker-jobs')!)).not.toContain('Last known');
            await act(async () => {
                const offlineWorker = { ...worker, active: false, activeAt: 0 };
                storage.setState({ machines: { 'machine-a': source, worker: offlineWorker }, machineListByServerId: { [serverId]: [source, offlineWorker] } });
            });
            await vi.waitFor(() => expect(collectText(screen.findByTestId('worker-pane-row:worker-jobs')!)).toContain('Last known'));
            await screen.unmount();
        } finally { storage.setState(previous); await home.dispose(); }
    });

    it('observes worker public policy and create/revoke snapshots without inheriting Source exposures', async () => {
        const { resetLocalServicePublicPreviewStoreForTests, publishLocalServicePublicPreviewSnapshot } =
            await import('@/sync/domains/local/services/publicPreview/sharedStore');
        resetLocalServicePublicPreviewStoreForTests();
        const workerTarget = { ...openableTarget, id: 'inventory:worker-listener',
            sourceClass: { kind: 'inventory_entry' as const, inventoryEntryId: 'worker-listener' },
            actions: ['open_preview' as const, 'register_preview' as const], machineId: 'worker', sessionId: 'worker-session', browserTarget: {
                kind: 'localServicePreview' as const, targetId: 'same-preview', machineId: 'worker', sessionId: 'worker-session',
            } };
        const exposure = { exposureId: 'same-exposure', previewId: 'same-preview', machineId: 'worker',
            sessionId: 'worker-session', mode: 'secret_link' as const, state: 'active' as const,
            publicUrl: 'https://worker.test/share', issuedAt: Date.now(), expiresAt: Date.now() + 600_000,
            auditEventIds: [], rateLimitProfileId: 'default' };
        const workerSnapshot = { v: 1 as const, machineId: 'worker', sessionId: 'worker-session', generatedAt: Date.now(),
            refreshState: 'idle' as const, policy: { enabled: true, allowedModes: ['secret_link' as const], maxTtlMs: 600_000,
                maxConcurrentExposures: 1, dnsTlsRequired: true, auditRequired: true, rateLimitProfileIds: ['default'] },
            exposures: [] as (typeof exposure)[], diagnostics: [] };
        const sourceState = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            ...workerSnapshot, machineId: 'machine-a', sessionId: undefined, policy: { ...workerSnapshot.policy, enabled: false },
            exposures: [{ ...exposure, machineId: 'machine-a', sessionId: undefined, publicUrl: 'https://source.test/share' }],
        });
        const { createLocalServicePublicPreviewActions } = await import('./publicPreviewActions');
        const actions = createLocalServicePublicPreviewActions({ machineId: 'machine-a', serverId: 'home',
            runtimeActionExecute: async (request) => {
                expect(request.input).toMatchObject({ machineId: 'worker', sessionId: 'worker-session' });
                const exposures = request.actionId === 'localServices.publicPreview.create' ? [exposure] : [];
                publishLocalServicePublicPreviewSnapshot({ machineId: 'worker', serverId: 'home', sessionId: 'worker-session' }, {
                    ...workerSnapshot, exposures,
                });
                return { ok: true };
            } });
        try {
            const screen = await renderScreen(<DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })} launcherState={launcherStateWith([workerTarget])}
                sourceMachineId="machine-a" serverId="home" publicPreviewState={sourceState}
                publicPreviewEnabled publicPreviewStatusClient={async ({ request }) => {
                    expect(request.machineId).toBe('worker');
                    return { ok: true, snapshot: workerSnapshot };
                }} publicPreviewActions={actions} testID="worker-pane" />);
            await flushHookEffects();
            await expandRow(screen, 'worker-pane-row:inventory:worker-listener');
            const prefix = 'worker-pane-row:inventory:worker-listener-public-preview';
            const shareId = 'worker-pane-row:inventory:worker-listener-share';
            expect(screen.findByTestId(shareId)).toBeTruthy();
            await act(async () => { await actions.create(workerTarget); });
            expect(screen.findByTestId(`${prefix}-exposure:same-exposure`)).toBeTruthy();
            expect(screen.getTextContent()).toContain('worker.test');
            expect(screen.getTextContent()).not.toContain('source.test');
            await act(async () => { await actions.revoke(exposure); });
            expect(screen.findAllByTestId(`${prefix}-exposure:same-exposure`)).toHaveLength(0);
            expect(screen.findByTestId(shareId)).toBeTruthy();
            await screen.unmount();
        } finally { resetLocalServicePublicPreviewStoreForTests(); }
    });
    it('renders loading state before the first inventory snapshot', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [], generatedAt: 0, refreshState: 'refreshing' })}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-loading')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-loading-card')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-loading-loading-spinner')).toBeTruthy();
    });

    it('renders empty state after an idle empty snapshot as an invitation (pane-states E)', async () => {
        const onRefresh = vi.fn();
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                machine={MACBOOK_ONLINE}
                onRefresh={onRefresh}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-empty')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-empty-card')).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).toContain('Preview what you’re building');
        expect(text).toContain('Dev servers started in this workspace show up here');
        await pressTestInstanceAsync(screen.findByTestId('local-services-pane-empty-action'), 'empty action');
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('leads the empty state to where a service is declared, with re-reading as the second move', async () => {
        const onRefresh = vi.fn();
        const onAddService = vi.fn();
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                machine={MACBOOK_ONLINE}
                onRefresh={onRefresh}
                onAddService={onAddService}
                testID="local-services-pane"
            />,
        );
        expect(screen.getTextContent()).toContain('Add a service');
        await pressTestInstanceAsync(screen.findByTestId('local-services-pane-empty-action'), 'add a service');
        expect(onAddService).toHaveBeenCalledTimes(1);
        expect(onRefresh).not.toHaveBeenCalled();
        await pressTestInstanceAsync(screen.findByTestId('local-services-pane-empty-secondary-action'), 'check again');
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('says the machine is offline instead of an empty or failed scan when it cannot be reached', async () => {
        const onRefresh = vi.fn();
        const screen = await renderScreen(inHeaderHost(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [], refreshState: 'error' })}
                machine={MACBOOK_OFFLINE}
                onRefresh={onRefresh}
                testID="local-services-pane"
            />,
        ));
        expect(screen.findByTestId('local-services-pane-offline-card')).toBeTruthy();
        expect(screen.findAllByTestId('local-services-pane-error-card')).toHaveLength(0);
        expect(screen.findByTestId('probe-header.subtitle')).toBeTruthy();
        expect(screen.getTextContent()).toContain('MacBook Pro is offline');
        await pressTestInstanceAsync(screen.findByTestId('local-services-pane-offline-action'), 'offline action');
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('keeps last-known rows under one offline line while the machine is unreachable', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                machine={MACBOOK_OFFLINE}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-row:inventory:openable-row')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-offline-line')).toBeTruthy();
    });

    it('renders terminal error state through the shared surface state card', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [],
                    refreshState: 'error',
                    diagnostics: [{ code: 'scanner_permission_denied', severity: 'error' }],
                })}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-error')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-error-card')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('scanner_permission_denied');
        expect(screen.findByTestId('local-services-pane-error-diagnostic-scanner_permission_denied')).toBeTruthy();
    });

    it('names the scan failure cause on the whole-pane error state, not only its title', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [],
                    refreshState: 'error',
                    diagnostics: [{ code: 'linux_procfs_scan_failed', severity: 'error' }],
                })}
                testID="local-services-pane"
            />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('Local service scan needs attention');
        expect(text).toContain("This machine couldn't list its running processes");
        expect(text).not.toContain('linux_procfs_scan_failed');
    });

    it.each([
        { retainedRows: true, root: '/tmp/QAR90S-R3', displayedRoot: '/tmp/QAR90S-R3' },
        { retainedRows: true, root: '/home/alice/project', displayedRoot: '~/project' },
        { retainedRows: false, root: '/tmp/QAR90S-R3', displayedRoot: '/tmp/QAR90S-R3' },
    ])('names the unreadable root and permission cause, then clears on recovery ($retainedRows, $root)', async ({ retainedRows, root, displayedRoot }) => {
        const onRefresh = vi.fn();
        const rows = retainedRows ? [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })] : [];
        const launcherState = launcherStateWith(retainedRows ? [openableTarget] : []);
        const machine = { ...MACBOOK_ONLINE, homeDir: '/home/alice' };
        const render = (failed: boolean) => <DetectedLocalServicesPane
            inventoryState={buildLocalServiceInventoryState({
                rows,
                refreshState: failed ? 'error' : 'idle',
                diagnostics: failed ? [{
                    code: 'local_services_declaration_observation_unavailable', severity: 'warning',
                    message: JSON.stringify({ root, role: 'project_root', syscall: 'watch', code: 'EACCES' }),
                }] : [],
            })}
            launcherState={launcherState} machine={machine} onRefresh={onRefresh} testID="scan-root"
        />;
        const screen = await renderScreen(render(true));
        expect(screen.getTextContent()).toContain(displayedRoot);
        expect(screen.getTextContent().toLowerCase()).toContain('no permission');
        expect(screen.getTextContent()).not.toContain('EACCES');
        expect(screen.getTextContent()).not.toContain('project_root');
        if (retainedRows) {
            expect(screen.findByTestId('scan-root-row:inventory:openable-row')).toBeTruthy();
            await pressTestInstanceAsync(screen.findByTestId('scan-root-error-check-again'), 'check again');
            expect(onRefresh).toHaveBeenCalledTimes(1);
        }
        await screen.update(render(false));
        expect(screen.getTextContent()).not.toContain(displayedRoot);
        expect(screen.getTextContent().toLowerCase()).not.toContain('no permission');
    });

    it.each([
        'native error: private diagnostic text',
        JSON.stringify({ root: 42, code: 'EACCES', message: 'private diagnostic text' }),
    ])('keeps unstructured or invalid observation metadata out of the scan banner (%s)', async message => {
        const screen = await renderScreen(<DetectedLocalServicesPane
            inventoryState={buildLocalServiceInventoryState({
                rows: [buildLocalServiceInventoryRow({ id: 'openable-row' })], refreshState: 'error',
                diagnostics: [{ code: 'local_services_declaration_observation_unavailable', severity: 'warning', message }],
            })}
            launcherState={launcherStateWith([openableTarget])} testID="scan-root"
        />);
        expect(screen.getTextContent()).toContain('Local service scan needs attention');
        expect(screen.getTextContent()).not.toContain('private diagnostic text');
        expect(screen.getTextContent()).not.toContain('EACCES');
    });

    it('renders error diagnostics without clearing cached row state', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    refreshState: 'error',
                    rows: [buildLocalServiceInventoryRow({ id: 'stale-service', state: 'stale' })],
                    diagnostics: [{ code: 'scanner_permission_denied', severity: 'error' }],
                })}
                launcherState={launcherStateWith([{
                    id: 'inventory:stale-service',
                    source: 'inventory_entry',
                    machineId: 'machine-a',
                    title: 'Stale service',
                    confidence: 'low',
                    state: 'stale',
                    unavailableReason: 'stale_service',
                    actions: [],
                }])}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId('local-services-pane-row:inventory:stale-service')).toBeTruthy();
        // FIX-E2: the diagnostics banner renders neutral product copy — the raw scan code is NOT
        // leaked into visible text; it survives only on the diagnostics-only testID/a11y hint.
        expect(screen.getTextContent()).not.toContain('scanner_permission_denied');
        expect(screen.getTextContent()).toContain('Local service scan needs attention');
        expect(screen.findByTestId('local-services-pane-error-code-scanner_permission_denied')).toBeTruthy();
    });

    it('keeps declared rows under one typed scan reason that can check again', async () => {
        const onRefresh = vi.fn();
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    refreshState: 'error',
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                    diagnostics: [
                        { code: 'local_services_accepted_workspaces_unavailable', severity: 'warning' },
                        { code: 'local_services_inventory_scan_failed', severity: 'error' },
                    ],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                onRefresh={onRefresh}
                testID="local-services-pane"
            />,
        );
        expect(screen.findByTestId(`local-services-pane-row:${openableTarget.id}`)).toBeTruthy();
        // One cause, one line: the failed scan leads; the code stays on the diagnostics-only marker.
        expect(screen.findByTestId('local-services-pane-error-code-local_services_inventory_scan_failed')).toBeTruthy();
        expect(screen.findAllByTestId('local-services-pane-error-code-local_services_accepted_workspaces_unavailable')).toHaveLength(0);
        expect(screen.getTextContent()).toContain("This machine couldn't list its running processes");
        expect(screen.getTextContent()).not.toContain('local_services_inventory_scan_failed');
        await act(async () => { screen.pressByTestId('local-services-pane-error-check-again'); });
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('publishes how many run on which machine and a refresh to the pane header, with no count in the body', async () => {
        const onRefresh = vi.fn();
        const screen = await renderScreen(inHeaderHost(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                machine={MACBOOK_ONLINE}
                sessionId="session-a"
                onRefresh={onRefresh}
                testID="local-services-pane"
            />,
        ));
        expect(screen.findByTestId('probe-header.subtitle')).toBeTruthy();
        expect(screen.getTextContent()).toContain('1 running on MacBook Pro');
        // The body no longer draws its own "N services · M running" strip.
        expect(screen.findAllByTestId('local-services-pane-count-badge')).toHaveLength(0);
        await pressTestInstanceAsync(screen.findByTestId('local-services-pane-refresh'), 'header refresh');
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('counts the rendered Running rows when the launcher observation precedes inventory metadata', async () => {
        const screen = await renderScreen(inHeaderHost(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={launcherStateWith([openableTarget, { ...openableTarget,
                    id: 'inventory:second', title: 'Second listener', subtitle: 'localhost:5174',
                    sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'second' },
                    browserTarget: { ...openableTarget.browserTarget, targetId: 'inventory-loopback:second',
                        url: openableTarget.browserTarget.url.replace(':5173', ':5174'),
                        display: { title: 'Second listener', addressLabel: 'localhost:5174' } },
                }], 'session-a')}
                machine={MACBOOK_ONLINE}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        ));
        expect(screen.findByTestId('local-services-pane-row:inventory:openable-row')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-row:inventory:second')).toBeTruthy();
        expect(collectText(screen.findByTestId('probe-header.subtitle')!)).toContain('2 running');
        expect(collectText(screen.findByTestId('probe-header.subtitle')!)).not.toContain('Nothing running');
    });

    it('claims nothing about what runs while the first scan is loading or has failed', async () => {
        for (const refreshState of ['refreshing', 'error'] as const) {
            const screen = await renderScreen(inHeaderHost(
                <DetectedLocalServicesPane
                    inventoryState={buildLocalServiceInventoryState({ rows: [], generatedAt: 0, refreshState })}
                    machine={MACBOOK_ONLINE}
                    testID="local-services-pane"
                />,
            ));
            const header = screen.findByTestId('probe-header.subtitle');
            if (!header) throw new Error('Expected the Local Services header');
            expect(collectText(header)).toContain('MacBook Pro');
            expect(collectText(header)).not.toContain('Nothing running');
            await screen.unmount();
        }
    });

    it('an empty workspace scope says nothing runs in this workspace, never on the whole machine', async () => {
        // A preview of this Machine can be open while the workspace has no service of its own.
        for (const [scope, expected] of [['workspace', 'Nothing running in this workspace'], ['machine', 'Nothing running on MacBook Pro']] as const) {
            const screen = await renderScreen(inHeaderHost(
                <DetectedLocalServicesPane
                    inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                    launcherState={launcherStateWith([])}
                    machine={MACBOOK_ONLINE}
                    scope={scope}
                    testID="local-services-pane"
                />,
            ));
            const header = screen.findByTestId('probe-header.subtitle');
            if (!header) throw new Error('Expected the Local Services header');
            expect(collectText(header)).toContain(expected);
            await screen.unmount();
        }
    });

    it('renders the empty state when a valid scan has no launcher targets', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'inventory-only', state: 'listening' })],
                })}
                launcherState={launcherStateWith([])}
                testID="local-services-pane"
            />,
        );

        expect(screen.findByTestId('local-services-pane-empty')).toBeTruthy();
        expect(screen.findAllByTestId('local-services-pane-launcher-unavailable')).toHaveLength(0);
        expect(screen.findAllByTestId('local-services-pane-row:inventory:inventory-only')).toHaveLength(0);
        expect(screen.findAllByTestId('local-services-pane-row:inventory:inventory-only-open')).toHaveLength(0);
    });

    it('sections rows into running, ready to start and elsewhere on the machine, in ranking order (D1, D6, lab S)', async () => {
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [
                        buildLocalServiceInventoryRow({ id: 'my-session', state: 'listening', port: 5173 }),
                        buildLocalServiceInventoryRow({ id: 'other-session', state: 'listening', port: 5174 }),
                    ],
                })}
                launcherState={launcherStateWith([
                    {
                        id: 'inventory:my-session',
                        source: 'inventory_entry',
                        machineId: 'machine-a',
                        sessionId: 'session-a',
                        title: 'My session',
                        confidence: 'high',
                        state: 'available',
                        actions: ['open'],
                        browserTarget: { kind: 'externalUrl', targetId: 'l1', url: 'http://127.0.0.1:5173/', display: { title: 'My session' } },
                    },
                    {
                        id: 'inventory:other-session',
                        source: 'inventory_entry',
                        machineId: 'machine-a',
                        sessionId: 'session-b',
                        title: 'Other session',
                        confidence: 'high',
                        state: 'available',
                        actions: ['open'],
                        browserTarget: { kind: 'externalUrl', targetId: 'l2', url: 'http://127.0.0.1:5174/', display: { title: 'Other session' } },
                    },
                    {
                        id: 'package:web:dev',
                        source: 'package_script',
                        machineId: 'machine-a',
                        workspaceId: 'workspace-a',
                        workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/workspace' },
                        cwd: '/workspace',
                        declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'native',
                            source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } } },
                        title: 'web:dev',
                        confidence: 'medium',
                        state: 'available',
                        actions: ['start'],
                    },
                ], 'session-a')}
                sessionId="session-a"
                scope="machine"
                machine={MACBOOK_ONLINE}
                testID="local-services-pane"
            />,
        );
        // Sections by what you can do (lab S): running here, ready to start, elsewhere on the machine.
        expect(screen.findByTestId('local-services-pane-section-running')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-section-ready')).toBeTruthy();
        expect(screen.findByTestId('local-services-pane-section-elsewhere')).toBeTruthy();
        const sectionText = screen.getTextContent();
        expect(sectionText).toContain('Ready to start');
        expect(sectionText).toContain('Elsewhere on MacBook Pro');
        // No raw reason token rendered (D6, master §3.4).
        expect(screen.getTextContent()).not.toContain('launch_unavailable');

        const order = screen
            .findAll((node) => typeof node.props?.testID === 'string'
                && /^local-services-pane-row:(inventory:my-session|inventory:other-session|package:web:dev)$/.test(node.props.testID))
            .map((node) => node.props.testID as string);
        expect(order.indexOf('local-services-pane-row:inventory:my-session'))
            .toBeLessThan(order.indexOf('local-services-pane-row:package:web:dev'));
        expect(order.indexOf('local-services-pane-row:package:web:dev'))
            .toBeLessThan(order.indexOf('local-services-pane-row:inventory:other-session'));
    });

    it('threads onOpenServiceInBrowser to an openable row and invokes it with the open target', async () => {
        const onOpenServiceInBrowser = vi.fn();
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                sessionId="session-a"
                onOpenServiceInBrowser={onOpenServiceInBrowser}
                testID="local-services-pane"
            />,
        );
        // One tap: a running row's Open is on the row itself; no expansion first (services lab O).
        await pressTestInstanceAsync(
            screen.findByTestId('local-services-pane-row:inventory:openable-row-open'),
            'local-services-pane-row:inventory:openable-row-open',
        );
        expect(onOpenServiceInBrowser).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ id: 'inventory:openable-row' }),
        );
    });

    /**
     * §5.7's capability, at its current owner.
     *
     * U-10 hoisted the exposure group out of the rows because every qualifying row repeated the group
     * heading and rescanned the exposure set. Lab S puts the live link back with its service, but only
     * inside the ONE expanded row: collapsed rows render no public-preview UI at all, so neither the
     * repeated heading nor the per-row rescan returns. Relocated, not removed.
     */
    it('shows the live public link inside its service row expansion (§5.7, lab S signature)', async () => {
        const previewTarget = {
            id: 'inventory:dashboard-listener',
            source: 'inventory_entry' as const,
            sourceClass: { kind: 'inventory_entry' as const, inventoryEntryId: 'dashboard-listener' },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Dashboard preview',
            confidence: 'high' as const,
            state: 'available' as const,
            actions: ['open_preview' as const, 'register_preview' as const],
            browserTarget: {
                kind: 'localServicePreview' as const,
                targetId: 'preview_1',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        };
        const exposure = {
            exposureId: 'public_preview_1',
            previewId: 'preview_1',
            sessionId: 'session-a',
            machineId: 'machine-a',
            mode: 'secret_link' as const,
            state: 'active' as const,
            publicUrl: 'https://preview.example.test/s/public_preview_1',
            issuedAt: 1_000,
            expiresAt: 601_000,
            auditEventIds: ['audit_1'],
            rateLimitProfileId: 'default',
        };
        const publicPreviewState = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            generatedAt: 4_000,
            refreshState: 'idle',
            policy: {
                enabled: true,
                allowedModes: ['secret_link'],
                maxTtlMs: 600_000,
                maxConcurrentExposures: 2,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ['default'],
            },
            exposures: [exposure],
            diagnostics: [],
        });

        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={launcherStateWith([previewTarget], 'session-a')}
                publicPreviewState={publicPreviewState}
                publicPreviewActions={{ create: vi.fn(), copyUrl: vi.fn(), revoke: vi.fn() }}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        // The live link belongs to its service: it shows in that row's expansion, not as a pane group.
        expect(screen.findAllByTestId('local-services-pane-public-preview')).toHaveLength(0);
        await expandRow(screen, 'local-services-pane-row:inventory:dashboard-listener');
        expect(screen.findByTestId('local-services-pane-row:inventory:dashboard-listener-public-preview-exposure:public_preview_1-revoke')).toBeTruthy();
    });

    it('renders disabled public-preview state for a plain loopback open target (§5.7)', async () => {
        const publicPreviewState = applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            generatedAt: 4_000,
            refreshState: 'idle',
            policy: {
                enabled: true,
                allowedModes: ['secret_link'],
                maxTtlMs: 600_000,
                maxConcurrentExposures: 2,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ['default'],
            },
            exposures: [],
            diagnostics: [],
        });
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={launcherStateWith([openableTarget], 'session-a')}
                publicPreviewState={publicPreviewState}
                publicPreviewActions={{ create: vi.fn(), copyUrl: vi.fn(), revoke: vi.fn() }}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        await expandRow(screen, 'local-services-pane-row:inventory:openable-row');
        expect(screen.findByTestId('local-services-pane-row:inventory:openable-row-public-preview-target:inventory:openable-row-disabled')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Open a local preview before creating a public link.');
        expect(screen.findAll((node) => String(node.props?.testID ?? '').endsWith('-create'))).toHaveLength(0);
    });

    it('keeps the prior hydrated rows mounted while the launcher is refreshing (§5.8 keep-last-good)', async () => {
        const refreshingLauncher = {
            ...launcherStateWith([openableTarget], 'session-a'),
            refreshStatus: 'refreshing' as const,
        };
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                })}
                launcherState={refreshingLauncher}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        );
        // FIX-C: no visible refresh banner — a banner that toggled on every background poll
        // caused layout-shift flicker. The hydrated rows stay mounted (keep-last-good) while the
        // launcher revalidates; the refresh is silent.
        expect(screen.findAllByTestId('local-services-pane-refreshing')).toHaveLength(0);
        expect(screen.findByTestId('local-services-pane-row:inventory:openable-row')).toBeTruthy();
    });

    /**
     * R2b-11 / plan 22 §2, lab PAGEp: on a phone the list pushes the service's detail (Address,
     * Runs on, Share, Stop last) instead of growing the row in place; Back returns to the same list.
     */
    it('pushes the service detail on a phone and returns to the list on Back', async () => {
        deviceState.type = 'phone';
        const focus = vi.fn();
        try {
            const screen = await renderScreen(
                <DetectedLocalServicesPane
                    inventoryState={buildLocalServiceInventoryState({
                        rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                    })}
                    launcherState={launcherStateWith([openableTarget], 'session-a')}
                    sessionId="session-a"
                    onOpenServiceInBrowser={vi.fn()}
                    renderServicePlacement={() => <PlacementProbe />}
                    testID="local-services-pane"
                />,
                { createNodeMock: (element) => element.props.testID === 'local-services-pane-row:inventory:openable-row-item' ? { focus } : null },
            );
            const rowTestID = 'local-services-pane-row:inventory:openable-row';
            await expandRow(screen, rowTestID);
            // No inline growth on a phone: the detail is its own page with the same body.
            expect(screen.findAllByTestId(`${rowTestID}-expansion`)).toHaveLength(0);
            expect(screen.findByTestId('local-services-pane-detail')).toBeTruthy();
            expect(screen.findByTestId('placement-probe')).toBeTruthy();
            expect(screen.findByTestId('local-services-pane-detail-row-address')).toBeTruthy();
            expect(screen.findByTestId('local-services-pane-list')?.props.accessibilityElementsHidden).toBe(true);

            await pressTestInstanceAsync(screen.findByTestId('local-services-pane-detail-back'), 'back');
            expect(screen.findAllByTestId('local-services-pane-detail')).toHaveLength(0);
            expect(screen.findByTestId('local-services-pane-list')?.props.accessibilityElementsHidden).toBe(false);
            expect(screen.findByTestId(rowTestID)).toBeTruthy();
            expect(focus).toHaveBeenCalled();
        } finally {
            deviceState.type = 'tablet';
        }
    });

    /**
     * Phone detail inside a Project: the Project's own top bar is the one Back. The pane hands it the
     * way out while the detail is open and draws no second arrow; with no such host it keeps its own.
     */
    it('leaves Back to the Project bar when one hosts the page, and returns to the list through it', async () => {
        deviceState.type = 'phone';
        const register = vi.fn();
        try {
            const screen = await renderScreen(
                <ProjectPageBackProvider value={register}>
                    <DetectedLocalServicesPane
                        inventoryState={buildLocalServiceInventoryState({
                            rows: [buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' })],
                        })}
                        launcherState={launcherStateWith([openableTarget], 'session-a')}
                        sessionId="session-a"
                        onOpenServiceInBrowser={vi.fn()}
                        renderServicePlacement={() => <PlacementProbe />}
                        testID="local-services-pane"
                    />
                </ProjectPageBackProvider>,
            );
            expect(register).not.toHaveBeenCalled();
            await expandRow(screen, 'local-services-pane-row:inventory:openable-row');
            expect(screen.findByTestId('local-services-pane-detail')).toBeTruthy();
            expect(screen.findAllByTestId('local-services-pane-detail-back')).toHaveLength(0);
            const back = register.mock.calls.at(-1)?.[0] as (() => void) | null;
            expect(typeof back).toBe('function');
            await act(async () => { back?.(); });
            expect(screen.findAllByTestId('local-services-pane-detail')).toHaveLength(0);
            expect(register.mock.calls.at(-1)?.[0]).toBeNull();
        } finally {
            deviceState.type = 'tablet';
        }
    });

    /** R2a-F13: a teammate's service names who started it from a known profile; the viewer's own does not. */
    it('names who started a service only when it is someone else the client already knows', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const profile = (id: string, name: string) => ({ id, name, firstName: null, lastName: null, avatar: null, username: name.toLowerCase(),
            bio: null, badges: [], status: 'friend', publicKey: null }) as unknown as UserProfile;
        act(() => { getStorage().getState().applyUsers({ 'ana-account': profile('ana-account', 'Ana'), 'viewer-account': profile('viewer-account', 'Me') }); });
        const managed = (id: string, startedByAccountId: string) => ({
            id, source: 'managed_service' as const, sourceClass: { kind: 'managed_service' as const, managedServiceId: id },
            machineId: 'machine-a', title: id, confidence: 'high' as const, state: 'available' as const, serviceState: 'running' as const,
            actions: ['manage' as const], startedByAccountId,
        });
        const screen = await renderScreen(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={launcherStateWith([managed('docs', 'ana-account'), managed('jobs', 'viewer-account'), managed('api', 'unknown-account')])}
                machine={MACBOOK_ONLINE}
                viewerAccountId="viewer-account"
                testID="local-services-pane"
            />,
        );
        const text = (rowId: string) => {
            const node = screen.findByTestId(`local-services-pane-row:${rowId}-meta`);
            return node ? collectText(node) : '';
        };
        expect(text('docs')).toContain('Started by Ana on MacBook Pro');
        expect(text('jobs')).not.toContain('Started by');
        expect(text('api')).not.toContain('Started by');
        expect(text('api')).not.toContain('unknown-account');
    });

    it('keeps Happier’s own services in one closed group that the header count leaves out', async () => {
        const happierTarget = {
            ...openableTarget,
            id: 'inventory:happier-ui',
            sourceClass: { kind: 'inventory_entry' as const, inventoryEntryId: 'happier-ui' },
            kind: 'happier' as const,
            title: 'Happier (internal dev)',
            browserTarget: { ...openableTarget.browserTarget, targetId: 'inventory-loopback:happier-ui' },
        };
        const screen = await renderScreen(inHeaderHost(
            <DetectedLocalServicesPane
                inventoryState={buildLocalServiceInventoryState({
                    rows: [
                        buildLocalServiceInventoryRow({ id: 'openable-row', state: 'listening' }),
                        buildLocalServiceInventoryRow({ id: 'happier-ui', state: 'listening', port: 19364 }),
                    ],
                })}
                launcherState={launcherStateWith([openableTarget, happierTarget], 'session-a')}
                machine={MACBOOK_ONLINE}
                sessionId="session-a"
                testID="local-services-pane"
            />,
        ));

        expect(screen.findByTestId('local-services-pane-section-happier')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Happier services (1)');
        // Closed by default: its rows are not mounted until the person opens the group.
        expect(screen.findAllByTestId('local-services-pane-row:inventory:happier-ui')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('1 running on MacBook Pro');
        await pressTestInstanceAsync(screen.findByTestId('local-services-pane-happier-item'), 'happier group');
        expect(screen.findByTestId('local-services-pane-row:inventory:happier-ui')).toBeTruthy();
    });
});
