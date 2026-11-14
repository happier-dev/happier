import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { renderScreen, standardCleanup } from '@/dev/testkit';


;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const registerDriverSpy = vi.hoisted(() => vi.fn<(driver: PaneDriver) => () => void>(() => () => {}));

vi.mock('@/components/appShell/panes/AppPaneProvider', () => {
    const ctx = {
        registerDriver: registerDriverSpy,
    };
    return {
        useAppPaneContext: () => ctx,
        useOptionalAppPaneContext: () => ctx,
    };
});

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => null,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: 'ready',
        interactionEnabled: true,
        platform: 'web',
    }),
}));

afterEach(() => {
    standardCleanup();
    driverModule.sessionPaneModulePrefetchLoaders.splice(0, driverModule.sessionPaneModulePrefetchLoaders.length, ...initialLoaders);
    registerDriverSpy.mockClear();
});

vi.mock('./SessionRightPanel', () => ({
    SessionRightPanel: () => React.createElement('SessionRightPanel'),
}));

vi.mock('./SessionDetailsPanel', () => ({
    SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
}));

vi.mock('./bottom/SessionBottomPanel', () => ({
    SessionBottomPanel: () => React.createElement('SessionBottomPanel'),
}));

// Resolve the real hook graph during collection, outside the mount/timer deadline.
const driverModule = await import('./useRegisterSessionPaneDriver');
const initialLoaders = [...driverModule.sessionPaneModulePrefetchLoaders];

describe('useRegisterSessionPaneDriver (module prefetch)', () => {
    it('uses the discovered runtime Home for the mounted pane scope before the route has a server id', async () => {
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
        let scopeId = '';
        const Probe = () => {
            scopeId = useRegisterSessionPaneDriver('same-session', null, {
                pluginUiProjection: null,
                pluginBrowserProjection: null,
                phase: 'current',
                interactionEnabled: true,
                machineId: 'machine-a',
                serverId: 'home-b',
                platform: 'web',
                accountLifetime: null,
            });
            return React.createElement('Probe');
        };
        await renderScreen(<Probe />);
        expect(scopeId).toBe('session:address:home-b:same-session');
        expect(registerDriverSpy.mock.calls.at(-1)?.[0].scopeId).toBe(scopeId);
    });

    it('registers distinct pane scopes for the same session id on two Homes', async () => {
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
        const scopeIds: string[] = [];
        const Probe = () => {
            scopeIds.push(
                useRegisterSessionPaneDriver('same-session', 'server-a'),
                useRegisterSessionPaneDriver('same-session', 'server-b'),
            );
            return React.createElement('Probe');
        };

        await renderScreen(<Probe />);

        expect(scopeIds[0]).not.toBe(scopeIds[1]);
        expect(registerDriverSpy.mock.calls.map(([driver]) => {
            const surfaceScope = driver.surfaceScope;
            return {
                scopeId: driver.scopeId,
                serverId: surfaceScope?.targetKind === 'session' ? surfaceScope.serverId : null,
                sessionId: surfaceScope?.targetKind === 'session' ? surfaceScope.sessionId : null,
            };
        })).toEqual(expect.arrayContaining([
            {
                scopeId: scopeIds[0],
                serverId: 'server-a',
                sessionId: 'same-session',
            },
            {
                scopeId: scopeIds[1],
                serverId: 'server-b',
                sessionId: 'same-session',
            },
        ]));
    });

    it('defers pane module prefetch until after the initial session open window', async () => {
        vi.useFakeTimers();
        try {
            const mod = await import('./useRegisterSessionPaneDriver');
            const loadSubagentDetails = vi.fn(async () => undefined);
            mod.sessionPaneModulePrefetchLoaders.splice(
                0,
                mod.sessionPaneModulePrefetchLoaders.length,
                loadSubagentDetails,
            );

            const Probe = () => {
                mod.useRegisterSessionPaneDriver('s1');
                return React.createElement('Probe');
            };

            await renderScreen(<Probe />);

            expect(loadSubagentDetails).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2999);
            expect(loadSubagentDetails).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(loadSubagentDetails).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles and reports a failed speculative module fetch', async () => {
        const mod = await import('./useRegisterSessionPaneDriver');
        const originalLoaders = [...mod.sessionPaneModulePrefetchLoaders];
        const failure = new TypeError('Failed to fetch');
        // The browser chunk fetch is an external boundary; preserve the real prefetch owner.
        const fetchModule = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mod.sessionPaneModulePrefetchLoaders.splice(0, originalLoaders.length, fetchModule);
        try {
            await expect(mod.prefetchSessionPaneModules()).resolves.toBeUndefined();
            expect(warning).toHaveBeenCalledWith(expect.any(String), failure);
        } finally {
            mod.sessionPaneModulePrefetchLoaders.splice(0, mod.sessionPaneModulePrefetchLoaders.length, ...originalLoaders);
            warning.mockRestore();
        }
    });
});
