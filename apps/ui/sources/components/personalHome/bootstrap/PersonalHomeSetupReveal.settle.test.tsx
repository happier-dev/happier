import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { PersonalHomeBootstrapContent, PersonalHomeBootstrapGate } from './PersonalHomeBootstrapGate';
import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
    readReducedMotionPreference: () => false,
}));

// The reveal unmounts WHEN ITS ANIMATION LANDS, so this suite opts the canonical reanimated mock
// into settling `withTiming` completion callbacks. Without it a stuck overlay would be invisible.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});

const pendingFacts: PersonalHomeFacts = {
    hostIsDesktop: true,
    isDesktopMainWindow: true,
    explicitlySelectedOtherHome: false,
    completedPersonalHomeProfile: null,
    candidateLocalProfile: null,
    relayRuntime: null,
    localHomeReachability: 'unknown',
    localHomeIdentity: null,
    localHomeAuth: 'unknown',
    anonymousSignup: 'unknown',
    daemon: null,
    activeTask: null,
};

const homeReadyFacts: PersonalHomeFacts = {
    ...pendingFacts,
    relayRuntime: {
        relayUrl: 'http://127.0.0.1:3005',
        installed: true,
        healthy: true,
        serviceActive: true,
        status: 'healthy',
        anonymousSignupEnabled: false,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:3005' },
    },
    localHomeReachability: 'reachable',
    localHomeIdentity: 'srv_home_b',
    localHomeAuth: 'present',
    anonymousSignup: 'disabled',
    completedPersonalHomeProfile: {
        id: 'p1',
        name: 'Personal Home',
        serverUrl: 'http://127.0.0.1:3005',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
        source: 'desktop-personal-home',
    },
    daemon: { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'machine_1' },
};

describe('Personal Home shell reveal settling', () => {
    it('hands the frame to the shell once the settle lands', async () => {
        let homeReady = false;
        let releaseHome!: () => void;
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate
                isDesktopHost
                isDesktopMainWindow
                readFacts={async () => homeReady ? homeReadyFacts : pendingFacts}
                operations={{
                    'ensure-home-ready': () => new Promise<void>((resolve) => {
                        releaseHome = () => {
                            homeReady = true;
                            resolve();
                        };
                    }),
                }}
            >
                <View testID="normal-shell">
                    <PersonalHomeBootstrapContent><View testID="ready-home-content" /></PersonalHomeBootstrapContent>
                </View>
            </PersonalHomeBootstrapGate>,
        );

        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).not.toBeNull();
        expect(screen.findByTestId('ready-home-content')).not.toBeNull();

        releaseHome();
        await flushHookEffects({ cycles: 6, turns: 3 });

        // No overlay survives its own animation: the shell owns the frame outright.
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-reveal')).toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
        expect(screen.findByTestId('ready-home-content')).not.toBeNull();
    });
});
