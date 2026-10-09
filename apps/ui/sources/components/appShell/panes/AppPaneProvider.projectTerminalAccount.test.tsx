import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

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
    beforeEach(async () => { standardCleanup(); await harness.reset(); storage.getState().applyLocalSettings({ appPaneScopesV1: {} }); });
    it('does not disclose Bob persisted members when the pane owner first mounts under Cara', async () => {
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
        await bobHost.unmount();
        await act(async () => {
            await harness.switchAccount(serverId, 'cara');
            storage.getState().activateProfileScope({ serverId, accountId: 'cara' });
            await storage.getState().activateSettingsScope({ serverId, accountId: 'cara' });
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        });
        const caraHost = await renderHook(useAppPaneContext, { wrapper });
        expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toEqual([]);
        await caraHost.unmount();
    });
    it('clears hidden Bob members on the real Account transition, preserves another Home, and stays empty on remount', async () => {
        const otherHome = await harness.addHome({ name: 'Other Home', serverUrl: 'https://pane-other.test', accountId: 'dana', active: false });
        const serverId = await harness.addHome({ name: 'Bob Home', serverUrl: 'https://pane-bob.test', accountId: 'bob' });
        await harness.requireUiApproval(serverId, 'machines.terminal.open');
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
            await harness.switchAccount(serverId, 'cara');
            storage.getState().activateProfileScope({ serverId, accountId: 'cara' });
            await storage.getState().activateSettingsScope({ serverId, accountId: 'cara' });
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
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
