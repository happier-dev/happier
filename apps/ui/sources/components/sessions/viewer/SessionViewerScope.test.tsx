import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

import { useOptionalSessionViewerController, type SessionViewerController } from './SessionViewerController';
import { SessionViewerScope } from './SessionViewerScope';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { PanePresentationProvider } from '@/components/appShell/panes/panePresentation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
let deviceType: 'phone' | 'desktop' = 'desktop';
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => deviceType }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const storage = createStorageStoreMock({
        sessions: {
            session_online: createSessionFixture({ id: 'session_online', serverId: 'server_1' }),
            session_offline: createSessionFixture({ id: 'session_offline', serverId: 'server_1', metadata: { path: '/work', host: 'h', machineId: 'machine-off' } }),
            session_nomachine: createSessionFixture({ id: 'session_nomachine', serverId: 'server_1', metadata: { path: '/work', host: 'h' } }),
        },
        machineListByServerId: { server_1: [createMachineFixture(), createMachineFixture({ id: 'machine-off', active: false })] },
    });
    return createStorageModuleStub({ storage, getStorage: () => storage });
});

let controller: SessionViewerController | null = null;
let pane: AppPaneScopeApi | null = null;
const presentPane = vi.fn();
function Probe() {
    controller = useOptionalSessionViewerController();
    pane = useAppPaneScope(createSessionPaneScopeId('session_online', 'server_1'));
    return null;
}

async function mount(sessionId: string) {
    await renderScreen(
        <AppPaneProvider>
            <PanePresentationProvider value={presentPane}>
                <SessionViewerScope sessionId={sessionId} serverId="server_1"><Probe /></SessionViewerScope>
            </PanePresentationProvider>
        </AppPaneProvider>,
    );
}

describe('SessionViewerScope presentable sources', () => {
    beforeEach(() => { controller = null; deviceType = 'desktop'; presentPane.mockClear(); });

    it('presents the Computer while the Session\'s Machine is unreachable, but not the Browser', async () => {
        await mount('session_offline');
        expect(controller?.canPresentSource('computer')).toBe(true);
        expect(controller?.canPresentSource('browser')).toBe(false);
    });

    it('presents both sources on a reachable Machine and neither for a Session with no Machine', async () => {
        await mount('session_online');
        expect(controller?.canPresentSource('computer')).toBe(true);
        expect(controller?.canPresentSource('browser')).toBe(true);

        await mount('session_nomachine');
        expect(controller?.canPresentSource('computer')).toBe(false);
        expect(controller?.canPresentSource('browser')).toBe(false);
    });

    it('reveals the phone cockpit Chat, where the viewer docks, when the viewer is opened from another surface', async () => {
        deviceType = 'phone';
        const switchSurface = vi.fn();
        await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface, returnToPreviousSurface: () => {} }}>
                    <SessionViewerScope sessionId="session_online" serverId="server_1"><Probe /></SessionViewerScope>
                </SessionCockpitSurfaceNavigationProvider>
            </AppPaneProvider>,
        );
        await act(async () => { controller?.port.apply({ kind: 'viewer.open', source: 'computer' }); });
        expect(controller?.state).toMatchObject({ source: 'computer', mode: 'docked' });
        expect(switchSurface).toHaveBeenCalledWith('chat');
    });

    describe.each(['viewer.open', 'viewer.source.select'] as const)('docked source handoff through %s', (kind) => {
        it.each(['computer', 'browser'] as const)('presents the target %s pane on the first source change', async (source) => {
            await mount('session_online');
            const previous = source === 'computer' ? 'browser' : 'computer';
            await act(async () => { controller!.port.apply({ kind: 'viewer.open', source: previous }); });
            await act(async () => { controller!.apply({ kind: 'viewer.dock' }); });
            expect(source === 'computer' ? pane!.scopeState!.details.isOpen : pane!.scopeState!.right.isOpen).toBe(false);
            await act(async () => { expect(controller!.port.apply({ kind, source })).toMatchObject({ status: 'applied' }); });
            expect(controller!.state).toMatchObject({ mode: 'docked', source });
            expect(source === 'computer' ? pane!.scopeState!.details.isOpen : pane!.scopeState!.right.isOpen).toBe(true);
            if (source === 'browser') expect(pane!.scopeState!.right.activeTabId).toBe('browser');
        });
    });

    it.each(['computer', 'browser'] as const)('presents the changed %s source when an expanded dock is restored', async (source) => {
        await mount('session_online');
        const previous = source === 'computer' ? 'browser' : 'computer';
        await act(async () => { controller!.port.apply({ kind: 'viewer.open', source: previous }); });
        await act(async () => { controller!.apply({ kind: 'viewer.dock' }); });
        await act(async () => { controller!.port.apply({ kind: 'viewer.expand' }); });
        await act(async () => { controller!.port.apply({ kind: 'viewer.source.select', source }); });
        expect(source === 'computer' ? pane!.scopeState!.details.isOpen : pane!.scopeState!.right.isOpen).toBe(false);
        await act(async () => { expect(controller!.port.apply({ kind: 'viewer.restore' })).toMatchObject({ status: 'applied' }); });
        expect(controller!.state).toMatchObject({ mode: 'docked', source });
        expect(source === 'computer' ? pane!.scopeState!.details.isOpen : pane!.scopeState!.right.isOpen).toBe(true);
        if (source === 'browser') expect(pane!.scopeState!.right.activeTabId).toBe('browser');
    });

    describe('Float view', () => {
        const otherTab = { key: 'file:a', kind: 'file', title: 'a', resource: { kind: 'file', path: 'a' } } as const;
        const open = (source: 'computer' | 'browser') => act(async () => { controller?.port.apply({ kind: 'viewer.open', source }); });
        const apply = (intent: Parameters<SessionViewerController['apply']>[0]) => act(async () => { controller?.apply(intent); });

        it('closes the Details pane the dock opened, so the transcript reads underneath the floating frame', async () => {
            await mount('session_online');
            await open('computer');
            await apply({ kind: 'viewer.dock' });
            expect(pane?.scopeState?.details.isOpen).toBe(true);
            await apply({ kind: 'viewer.float' });
            expect(controller?.state.mode).toBe('floating');
            expect(pane?.scopeState?.details.isOpen).toBe(false);
        });

        it('returns Details to the tabs it held before the dock, without the viewer tab', async () => {
            await mount('session_online');
            await act(async () => { pane?.openDetailsTab(otherTab, { intent: 'pinned' }); });
            await open('computer');
            await apply({ kind: 'viewer.dock' });
            expect(pane?.scopeState?.details.tabs.map(tab => tab.key)).toContain('file:a');
            await apply({ kind: 'viewer.float' });
            expect(pane?.scopeState?.details.isOpen).toBe(true);
            expect(pane?.scopeState?.details.tabs.map(tab => tab.key)).toEqual(['file:a']);
        });

        it.each([false, true])('returns the Browser dock to its previous right pane without navigating (previously open: %s)', async (previouslyOpen) => {
            await mount('session_online');
            if (previouslyOpen) await act(async () => { pane?.openRight({ tabId: 'git', present: false }); });
            await open('browser');
            await apply({ kind: 'viewer.dock' });
            expect(pane?.scopeState?.right.isOpen).toBe(true);
            expect(pane?.scopeState?.right.activeTabId).toBe('browser');
            expect(presentPane).not.toHaveBeenCalled();
            expect(resolveRightSidebarTabs({ scope: 'session', presentation: 'desktop' })
                .map(tab => tab.id)).toContain(pane?.scopeState?.right.activeTabId);
            await apply({ kind: 'viewer.float' });
            expect(pane?.scopeState?.right.isOpen).toBe(previouslyOpen);
            if (previouslyOpen) expect(pane?.scopeState?.right.activeTabId).toBe('git');
            expect(presentPane).not.toHaveBeenCalled();
        });
    });
});
