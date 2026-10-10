import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { PluginSurfacePaneLaunchScope, usePluginSurfacePaneLaunchScope } from './pluginSurfaceDestinationNavigation';

installDisconnectedServerSocketBoundary();
await import('@/sync/syncEngine');

it('refreshes pane authority after render-time Account retirement without updating a sibling during render', async () => {
    const http = createHomeHubArtifactHttpBoundary('account-a');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://pane-launch.test', accountId: 'account-a', request: http.request });
    const warnings: string[] = [];
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const message = args.map(String).join(' ');
        if (message.includes('Cannot update a component')) warnings.push(message);
        else originalConsoleError(...args);
    });
    const observed: { current: ReturnType<typeof usePluginSurfacePaneLaunchScope> } = { current: null };
    function Probe() {
        observed.current = usePluginSurfacePaneLaunchScope();
        return null;
    }
    function CapturingSibling() {
        captureActiveServerAccountScopeLifetime();
        return null;
    }
    const MountedPane = React.memo(function MountedPane() {
        return <PluginSurfacePaneLaunchScope><Probe /></PluginSurfacePaneLaunchScope>;
    });
    let tree: ReturnType<typeof create> | undefined;
    try {
        await act(async () => {
            tree = create(<><MountedPane /></>);
        });
        const accountA = captureActiveServerAccountScopeLifetime();
        expect(accountA?.isCurrent()).toBe(true);

        // Exercise the active-scope owner's documented direct-change fence.
        // No scope/lifetime/store helper is mocked: a sibling discovers the
        // replacement through the real storage reader while React renders.
        storage.setState({ profileScope: { serverId: connection.home.id, accountId: 'account-b' } });
        await act(async () => {
            tree!.update(<><MountedPane /><CapturingSibling /></>);
        });
        expect(accountA?.isCurrent()).toBe(false);
        expect(observed.current?.accountLifetime?.scope.accountId).toBe('account-b');
        expect(warnings).toEqual([]);
    } finally {
        await act(async () => { tree?.unmount(); });
        await connection.dispose();
        consoleError.mockRestore();
    }
});

it('keeps exact pane authority unavailable instead of borrowing the active Account when its supplied lifetime is null or retired', async () => {
    const http = createHomeHubArtifactHttpBoundary('exact-pane-account-a');
    const connection = await restoreServerAccountForTest({
        serverUrl: 'https://exact-pane-launch.test',
        accountId: 'exact-pane-account-a',
        request: http.request,
    });
    const observed: { current: ReturnType<typeof usePluginSurfacePaneLaunchScope> } = { current: null };
    function Probe() {
        observed.current = usePluginSurfacePaneLaunchScope();
        return null;
    }
    let tree: ReturnType<typeof create> | undefined;
    try {
        const exactLifetime = captureActiveServerAccountScopeLifetime();
        expect(exactLifetime?.isCurrent()).toBe(true);
        await act(async () => {
            tree = create(<PluginSurfacePaneLaunchScope accountLifetime={null}><Probe /></PluginSurfacePaneLaunchScope>);
        });
        expect(observed.current?.accountLifetime).toBeNull();

        await act(async () => {
            tree!.update(<PluginSurfacePaneLaunchScope accountLifetime={exactLifetime}><Probe /></PluginSurfacePaneLaunchScope>);
        });
        expect(observed.current?.accountLifetime).toBe(exactLifetime);

        await act(async () => {
            storage.getState().activateProfileScope({ serverId: connection.home.id, accountId: 'exact-pane-account-b' });
            tree!.update(<PluginSurfacePaneLaunchScope accountLifetime={exactLifetime}><Probe /></PluginSurfacePaneLaunchScope>);
        });
        expect(exactLifetime?.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('exact-pane-account-b');
        expect(observed.current?.accountLifetime).toBe(exactLifetime);
        expect(observed.current?.accountLifetime?.isCurrent()).toBe(false);
    } finally {
        await act(async () => { tree?.unmount(); });
        await connection.dispose();
    }
});
