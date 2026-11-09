import { describe, expect, it } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { useSessionDetailsPanelPluginRuntime } from './useSessionDetailsPanelPluginRuntime';

installSessionDetailsPanelCommonModuleMocks();

describe('useSessionDetailsPanelPluginRuntime', () => {
    it('keeps Details free of unused diagnostics Profile subscriptions while following its registered Machine', async () => {
        const previous = storage.getState();
        storage.setState({ profile: { ...previous.profile, id: 'details-account' } });
        let renders = 0;
        const hook = await renderHook(({ machineId }: { machineId: string }) => {
            renders++;
            return useSessionDetailsPanelPluginRuntime({
                sessionId: 'details-session', routeServerId: 'details-home', pluginUiProjection: null,
                paneSurfaceScope: {
                    targetKind: 'session', sessionId: 'details-session', serverId: 'details-home', machineId,
                    pluginUiProjection: null, pluginBrowserProjection: null, projectionPhase: 'unavailable',
                    interactionEnabled: false, platform: 'web',
                },
            });
        }, { initialProps: { machineId: 'details-machine' } });
        try {
            expect(hook.getCurrent().machineId).toBe('details-machine');
            const before = renders;
            for (let tick = 0; tick < 5; tick++) {
                await act(async () => storage.setState(state => ({ profile: { ...state.profile, timestamp: tick + 1 } })));
            }
            expect(renders - before).toBe(0);
            await act(async () => storage.setState(state => ({ profile: { ...state.profile, id: 'replacement-account' } })));
            expect(renders - before).toBe(0);
            await hook.rerender({ machineId: 'replacement-machine' });
            expect(hook.getCurrent().machineId).toBe('replacement-machine');
        } finally {
            await hook.unmount();
            storage.setState(previous, true);
        }
    });

    it('qualifies direct details with its route Home instead of the locally visible Session Home', async () => {
        const sessions = storage.getState().sessions;
        storage.setState({ sessions: {
            ...sessions,
            'same-session': createSessionFixture({ id: 'same-session', serverId: 'visible-home', metadata: null }),
        } });
        try {
            const hook = await renderHook(() => useSessionDetailsPanelPluginRuntime({
                sessionId: 'same-session',
                routeServerId: 'destination-home',
                pluginUiProjection: null,
            }));
            expect(hook.getCurrent().serverId).toBe('destination-home');
            expect(hook.getCurrent().machineId).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState({ sessions });
        }
    });
});
