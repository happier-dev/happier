import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { SidebarNavigator } from '@/components/navigation/shell/SidebarNavigator';
import { standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceRuntimeLevelStore, type VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { VoiceEnergyAppProvider, useVoiceInputSourceActive } from './VoiceEnergyAppProvider';
import { useVoiceEnergy, useVoiceEnergyPresence } from './useVoiceEnergy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorage = getStorage().getState();

describe('Voice app provider navigation cost', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let input: VoiceRuntimeLevelWriter | null = null;

    beforeEach(() => {
        getStorage().setState(initialStorage, true);
        resetVoiceSessionStoreForTests();
    });

    afterEach(() => {
        act(() => { tree?.unmount(); input?.close(); });
        tree = null;
        input = null;
        standardCleanup();
        resetVoiceSessionStoreForTests();
        getStorage().setState(initialStorage, true);
    });

    it('causes zero navigation invalidations at cold mount and on five idle Voice publications', async () => {
        let sidebarCommits = 0;
        let navigationRenders = 0;
        let energyRenders = 0;
        const capture: boolean[] = [];
        let presence: ReturnType<typeof useVoiceEnergyPresence> | null = null;
        function EnergyConsumer(): null {
            useVoiceEnergy();
            presence = useVoiceEnergyPresence();
            energyRenders += 1;
            return null;
        }
        function CaptureConsumer(): null {
            capture.push(useVoiceInputSourceActive());
            return null;
        }
        // Deliberately not memoized: this measures propagation from the Voice
        // owner without relying on SidebarNavigator's existing React.memo.
        function NavigationBoundary(): React.ReactElement {
            navigationRenders += 1;
            return <React.Profiler id="SidebarNavigator" onRender={() => { sidebarCommits += 1; }}>
                <SidebarNavigator />
            </React.Profiler>;
        }
        await act(async () => {
            tree = renderer.create(<InjectedAuthProvider credentials={null}>
                <AppPaneProvider><VoiceEnergyAppProvider>
                    <EnergyConsumer />
                    <CaptureConsumer />
                    <NavigationBoundary />
                </VoiceEnergyAppProvider></AppPaneProvider>
            </InjectedAuthProvider>);
        });
        // Navigation has its own cold-mount subscriptions/effects. Their
        // commits are not Voice invalidations; retain that measured baseline.
        const coldSidebarCommits = sidebarCommits;
        expect(coldSidebarCommits).toBeGreaterThan(0);
        expect(navigationRenders).toBe(1);
        expect(energyRenders).toBe(1);
        expect(capture).toEqual([false]);

        // Five separate startup publications, not one React-batched write.
        for (let i = 0; i < 5; i += 1) {
            await act(async () => {
                getStorage().setState((state) => ({ settings: { ...state.settings,
                    voice: { ...state.settings.voice },
                } }));
                setVoiceSessionSnapshot({ adapterId: null, sessionId: null,
                    status: 'disconnected', mode: 'idle', canStop: false });
            });
        }
        expect(sidebarCommits - coldSidebarCommits).toBe(0);
        expect(navigationRenders).toBe(1);
        expect(energyRenders).toBe(1);
        expect(capture).toEqual([false]);

        // Real lifecycle control: a mounted light registers and capture opens.
        await act(async () => { presence!.acquire(); });
        await act(async () => {
            input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'sidebar-cost' });
        });
        expect(capture).toEqual([false, true]);
        await act(async () => { input!.close(); input = null; presence!.release(); });
        expect(capture).toEqual([false, true, false]);
        expect(energyRenders).toBe(1);
        expect(sidebarCommits - coldSidebarCommits).toBe(0);
        expect(navigationRenders).toBe(1);

        // The navigation subtree is live: its own setting reaches the real
        // FullSidebarNavigator even though Voice did not invalidate it.
        await act(async () => {
            getStorage().setState((state) => ({ localSettings: { ...state.localSettings,
                sidebarCollapsed: !state.localSettings.sidebarCollapsed,
            } }));
        });
        expect(sidebarCommits - coldSidebarCommits).toBe(1);
    });
});
