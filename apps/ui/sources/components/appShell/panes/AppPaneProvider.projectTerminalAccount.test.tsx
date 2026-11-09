import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

import { View } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { usePaneAnimatedPresence } from '@/components/ui/panels/motion/usePaneAnimatedPresence';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { EMPTY_TERMINAL_WORKSPACE } from '@/components/sessions/terminal/sessionTerminalWorkspace';

// The terminal renderer is a platform boundary; withholding onReady avoids opening a PTY.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef((_props, _ref) => React.createElement('XtermBoundary')),
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
const { invokeSessionTerminalAction } = await import('@/components/sessions/terminal/sessionTerminalActions');
const { readSessionTerminalWorkspaceForScope } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');
const { createTerminalDetailsTab } = await import('@/components/terminal/terminalDetailsTabModel');
const wrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>;

describe('Project terminal private presentation at the existing pane Account boundary', () => {
    beforeEach(async () => { standardCleanup(); await harness.reset(); (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse({})), storage.getState().applyLocalSettings({ })); });
    it('withdraws the old reader while its actual pane exit subtree is still retained', async () => {
        const { Animated } = await import('react-native');
        const serverId = await harness.addHome({ name: 'Terminal exit Home', serverUrl: 'https://terminal-exit.test', accountId: 'bob' });
        storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
        await storage.getState().activateSettingsScope({ serverId, accountId: 'bob' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const workspace = { serverId, workspaceId: 'exit-checkout', machineId: 'machine', rootPath: '/repo' };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: workspace.workspaceId, serverId,
            machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }] });
        const animation = vi.spyOn(Animated, 'timing').mockReturnValue({ start: () => undefined, stop: () => undefined, reset: () => undefined });
        try {
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            const authority = resolveProjectTerminalScope(scopeId, workspace);
            expect(authority).not.toBeNull();
            let dispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | undefined;
            // Native animation and the clock are external boundaries. Keep the real presence
            // owner and its retained React node alive until the test advances the exit clock.
            function Panes() {
                const pane = useAppPaneContext();
                dispatch = pane.dispatch;
                const scope = pane.state.scopes[scopeId];
                const surface = (presentation: 'bottom' | 'right' | 'details') => <ProjectTerminalSurface scopeId={scopeId}
                    workspaceRefId={workspace.workspaceId} machineId={workspace.machineId} rootPath={workspace.rootPath}
                    serverId={serverId} workspace={workspace} presentation={presentation}
                    terminalInstanceId={presentation === 'details' ? 'owned-shell' : undefined} />;
                const bottom = usePaneAnimatedPresence({ targetOpen: scope?.bottom.isOpen ?? false,
                    node: scope?.bottom.isOpen ? <View testID="retained-terminal-bottom">{surface('bottom')}</View> : null,
                    durationMs: motionTokens.durationMs.base, useNativeDriver: false });
                const right = usePaneAnimatedPresence({ targetOpen: scope?.right.isOpen ?? false,
                    node: scope?.right.isOpen ? <View testID="retained-terminal-right">{surface('right')}</View> : null,
                    durationMs: motionTokens.durationMs.base, useNativeDriver: false });
                const details = usePaneAnimatedPresence({ targetOpen: scope?.details.isOpen ?? false,
                    node: scope?.details.isOpen ? <View testID="retained-terminal-details">{surface('details')}</View> : null,
                    durationMs: motionTokens.durationMs.base, useNativeDriver: false });
                return <>{bottom.node}{right.node}{details.node}</>;
            }
            const screen = await renderScreen(<AppPaneProvider><Panes /></AppPaneProvider>);
            expect(resolveProjectTerminalScope(scopeId, workspace)).not.toBeNull();
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await act(async () => {
                dispatch!({ type: 'activateScope', scopeId });
                dispatch!({ type: 'setBottomTabState', scopeId, tabId: 'terminal', nextState: { ...EMPTY_TERMINAL_WORKSPACE, ownerScope: authority!.scope } });
                dispatch!({ type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
                    id: 'owned-shell', target: { kind: 'workspace_shell', workspace },
                } } });
            });
            expect(screen.findAllByType(WorkspaceEmbeddedTerminalPane)).toHaveLength(1);
            expect(screen.root.findAll(node => node.type === 'XtermBoundary')).toHaveLength(1);
            await act(async () => { dispatch!({ type: 'openRight', scopeId, tabId: 'terminal' }); });
            expect(screen.findByTestId('retained-terminal-bottom')).not.toBeNull();
            expect(screen.findAllByType(WorkspaceEmbeddedTerminalPane)).toHaveLength(1);
            expect(screen.findByTestId('retained-terminal-bottom')!.findAll(node => node.type === 'XtermBoundary')).toHaveLength(0);
            await act(async () => { dispatch!({ type: 'openDetailsTab', scopeId, openAs: 'pinned', tab: {
                key: 'terminal:owned-shell', kind: 'terminal', title: 'Shell',
                resource: { kind: 'terminal', terminalInstanceId: 'owned-shell' },
            } }); });
            expect(screen.findByTestId('retained-terminal-right')).not.toBeNull();
            expect(screen.findAllByType(WorkspaceEmbeddedTerminalPane)).toHaveLength(1);
            await act(async () => { dispatch!({ type: 'openBottom', scopeId, tabId: 'terminal' }); });
            expect(screen.findByTestId('retained-terminal-right')).not.toBeNull();
            expect(screen.findAllByType(WorkspaceEmbeddedTerminalPane)).toHaveLength(1);
            expect(screen.findByTestId('retained-terminal-details')).not.toBeNull();
            await act(async () => { dispatch!({ type: 'hideTerminalWorkspace', scopeId }); });
            expect(screen.findByTestId('retained-terminal-bottom')).not.toBeNull();
            expect(screen.findAllByType(WorkspaceEmbeddedTerminalPane)).toHaveLength(0);
            await screen.unmount();
        } finally { animation.mockRestore(); vi.useRealTimers(); }
    });
    it.each([
        { width: 390, renewCredentials: false },
        { width: 1440, renewCredentials: false },
        { width: 390, renewCredentials: true },
    ])('retains a hidden Shell across $width px reload while Account identity hydrates (renewal: $renewCredentials)', async ({ width, renewCredentials }) => {
        const { Dimensions } = await import('react-native');
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width, height: 900 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const serverId = await harness.addHome({ name: 'Retained Home', serverUrl: 'https://pane-retained.test', accountId: 'bob' });
        storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
        await storage.getState().activateSettingsScope({ serverId, accountId: 'bob' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const ref = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        const scopeId = buildProjectPaneScopeId(ref.id, serverId);
        const original = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            for (let index = 0; index < 4; index += 1) {
                expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId,
                    target: { kind: 'workspace_shell', workspace: { serverId, machineId: ref.machineId, workspaceId: ref.id, rootPath: ref.rootPath } },
                    title: `Retained hidden Shell ${index + 1}` } })).toMatchObject({ ok: true });
            }
            original.getCurrent().dispatch({ type: 'hideTerminalWorkspace', scopeId });
        });
        const retained = readSessionTerminalWorkspaceForScope(scopeId);
        expect(retained?.tabs.map(tab => tab.terminals[0].title)).toEqual([
            'Retained hidden Shell 1', 'Retained hidden Shell 2', 'Retained hidden Shell 3', 'Retained hidden Shell 4',
        ]);
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://pane-retained.test', { serverId });
        expect(credentials).not.toBeNull();
        await original.unmount();
        storage.setState({ profileScope: null });
        let resumeCredentials!: () => void;
        const pendingCredentials = new Promise<void>(resolve => { resumeCredentials = resolve; });
        const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        // Device secure storage is the real asynchronous hydration boundary.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (...args) => {
            await pendingCredentials;
            return readCredentials(...args);
        });
        const restored = await renderHook(useAppPaneContext, { wrapper });
        try {
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toEqual([]);
            await act(async () => restored.getCurrent().dispatch({ type: 'activateScope', scopeId }));
            expect(paneUiState.read(scopeId)?.bottom.tabState.terminal).toEqual(retained);
            if (renewCredentials) {
                await act(async () => {
                    expect(await TokenStorage.setCredentialsForServerUrl('https://pane-retained.test', { serverId }, credentials!)).toBe(true);
                });
                expect(paneUiState.read(scopeId)?.bottom.tabState.terminal).toEqual(retained);
            }
            await act(async () => {
                resumeCredentials();
                storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            });
            expect(readSessionTerminalWorkspaceForScope(scopeId)).toEqual(retained);
            expect(restored.getCurrent().state.scopes[scopeId].bottom.isOpen).toBe(false);
            await act(async () => restored.getCurrent().dispatch({ type: 'openBottom', scopeId, tabId: 'terminal' }));
            expect(readSessionTerminalWorkspaceForScope(scopeId)).toEqual(retained);
            expect(restored.getCurrent().state.scopes[scopeId].bottom.isOpen).toBe(true);
        } finally {
            resumeCredentials();
            credentialRead.mockRestore();
            viewport.mockRestore();
            await restored.unmount();
        }
    });
    it('changes only main visibility without changing Account-qualified pane contents', async () => {
        const serverId = await harness.addHome({ name: 'Focus Home', serverUrl: 'https://pane-focus.test', accountId: 'alice' });
        const scopeId = buildProjectPaneScopeId('accepted', serverId);
        const host = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            host.getCurrent().dispatch({ type: 'activateScope', scopeId });
            host.getCurrent().dispatch({ type: 'openRight', scopeId });
        });
        const scopes = host.getCurrent().state.scopes;
        for (const hidden of [true, false]) {
            await act(async () => host.getCurrent().dispatch({ type: 'setMainHidden', scopeId, hidden }));
            expect(host.getCurrent().state.scopes[scopeId].mainHidden).toBe(hidden);
            expect(host.getCurrent().state.scopes[scopeId].right).toBe(scopes[scopeId].right);
            expect(host.getCurrent().state.scopes[scopeId].details).toBe(scopes[scopeId].details);
            expect(host.getCurrent().state.scopes[scopeId].bottom).toBe(scopes[scopeId].bottom);
        }
        await host.unmount();
    });
    it('keeps a hidden Shell listed after other routes exceed the pane memory limit and a reload', async () => {
        const serverId = await harness.addHome({ name: 'Retained inventory Home', serverUrl: 'https://pane-inventory.test', accountId: 'bob' });
        storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
        await storage.getState().activateSettingsScope({ serverId, accountId: 'bob' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const ref = { id: 'inventory-checkout', serverId, machineId: 'machine', rootPath: '/accepted', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        const scopeId = buildProjectPaneScopeId(ref.id, serverId);
        const host = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId,
                target: { kind: 'workspace_shell', workspace: { serverId, machineId: ref.machineId, workspaceId: ref.id, rootPath: ref.rootPath } },
                title: 'Retained inventory Shell' } })).toMatchObject({ ok: true });
            host.getCurrent().dispatch({ type: 'hideTerminalWorkspace', scopeId });
        });
        const retained = paneUiState.read(scopeId)?.bottom.tabState.terminal;
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1);
        await act(async () => {
            const limit = host.getCurrent().state.limits.maxScopesInMemory;
            for (let index = 0; index <= limit; index += 1) {
                host.getCurrent().dispatch({ type: 'activateScope', scopeId: `session:inventory-route-${index}` });
            }
        });
        expect(paneUiState.read(scopeId)?.bottom.tabState.terminal).toEqual(retained);
        await act(async () => host.getCurrent().dispatch({ type: 'activateScope', scopeId }));
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0].terminals[0].title).toBe('Retained inventory Shell');
        await host.unmount();
        const restored = await renderHook(useAppPaneContext, { wrapper });
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0].terminals[0].title).toBe('Retained inventory Shell');
        await restored.unmount();
    });
    it.each(['cold', 'late'] as const)('does not disclose Bob persisted members on %s hydration under Cara', async hydration => {
        const serverId = await harness.addHome({ name: 'Persisted Home', serverUrl: 'https://pane-persisted.test', accountId: 'bob' });
        storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
        await storage.getState().activateSettingsScope({ serverId, accountId: 'bob' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const ref = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        const scopeId = buildProjectPaneScopeId(ref.id, serverId);
        const bobHost = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId,
                target: { kind: 'workspace_shell', workspace: { serverId, machineId: ref.machineId, workspaceId: ref.id, rootPath: ref.rootPath } },
                title: 'Persisted Bob private label' } })).toMatchObject({ ok: true });
        });
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0].terminals[0].title).toBe('Persisted Bob private label');
        const persisted = paneUiState.read(scopeId)!;
        await bobHost.unmount();
        await act(async () => {
            await harness.switchAccount(serverId, 'cara');
            storage.getState().activateProfileScope({ serverId, accountId: 'cara' });
            await storage.getState().activateSettingsScope({ serverId, accountId: 'cara' });
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        });
        if (hydration === 'late') paneUiState.remove(scopeId);
        const caraHost = await renderHook(useAppPaneContext, { wrapper });
        if (hydration === 'late') await act(async () => paneUiState.set(scopeId, persisted));
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toEqual([]);
        expect(paneUiState.read(scopeId)?.bottom.tabState.terminal).toEqual(EMPTY_TERMINAL_WORKSPACE);
        await caraHost.unmount();
    });
    it.each(['different-account', 'logout'] as const)('clears hidden Bob members on %s, preserves another Home, and stays empty on remount', async transition => {
        const otherHome = await harness.addHome({ name: 'Other Home', serverUrl: 'https://pane-other.test', accountId: 'dana', active: false });
        const serverId = await harness.addHome({ name: 'Bob Home', serverUrl: 'https://pane-bob.test', accountId: 'bob' });
        await harness.requireUiApproval(serverId, 'machines.terminal.open');
        storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
        await storage.getState().activateSettingsScope({ serverId, accountId: 'bob' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const ref = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        const scopeId = buildProjectPaneScopeId(ref.id, serverId);
        const otherScope = buildProjectPaneScopeId('other-accepted', otherHome);
        const host = await renderHook(useAppPaneContext, { wrapper });
        await act(async () => {
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId,
                target: { kind: 'workspace_shell', workspace: { serverId, machineId: ref.machineId, workspaceId: ref.id, rootPath: ref.rootPath } }, title: 'Bob private label' } })).toMatchObject({ ok: true });
        });
        await act(async () => {
            host.getCurrent().dispatch({ type: 'setBottomTabState', scopeId: otherScope, tabId: 'terminal',
                nextState: { v: 1, ownerScope: { serverId: otherHome, accountId: 'dana' }, tabs: [], activeTabId: null, showList: false } });
            host.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId: otherScope, command: { type: 'open',
                terminal: { id: 'other-member', title: 'Dana shell', target: { kind: 'workspace_shell', workspace: {
                    serverId: otherHome, machineId: 'other-machine', workspaceId: 'other-accepted', rootPath: '/other',
                } } } } });
            host.getCurrent().dispatch({ type: 'closeBottom', scopeId });
        });
        const otherBefore = readSessionTerminalWorkspaceForScope(otherScope);
        const bobMember = readSessionTerminalWorkspaceForScope(scopeId)!.tabs[0].terminals[0];
        await act(async () => host.getCurrent().dispatch({ type: 'openDetailsTab', scopeId,
            tab: createTerminalDetailsTab({ terminalInstanceId: bobMember.id, title: 'Bob private terminal view', cwd: '/bob-private-root' }), openAs: 'pinned' }));
        await act(async () => {
            if (transition === 'logout') {
                const { TokenStorage } = await import('@/auth/storage/tokenStorage');
                expect(await TokenStorage.removeCredentialsForServerUrl('https://pane-bob.test', { serverId })).toBe(true);
                storage.setState({ profileScope: null });
            } else {
                await harness.switchAccount(serverId, 'cara');
                storage.getState().activateProfileScope({ serverId, accountId: 'cara' });
                await storage.getState().activateSettingsScope({ serverId, accountId: 'cara' });
                applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
            }
        });
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toEqual([]);
        expect(Object.values(host.getCurrent().state.scopes[scopeId].details.tabsByKey)).toEqual([]);
        expect(readSessionTerminalWorkspaceForScope(otherScope)).toEqual(otherBefore);
        await host.unmount();
        const remount = await renderHook(useAppPaneContext, { wrapper });
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toEqual([]);
        expect(readSessionTerminalWorkspaceForScope(otherScope)).toEqual(otherBefore);
        await remount.unmount();
    });
});
