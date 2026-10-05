import * as React from 'react';
import { act } from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { PersonalHomeBootstrapContent, PersonalHomeBootstrapGate, usePersonalHomeBootReadiness } from './PersonalHomeBootstrapGate';
import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';

const reducedMotionSpy = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionSpy(),
    readReducedMotionPreference: () => reducedMotionSpy(),
}));

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

function ReadinessProbe() {
    const readiness = usePersonalHomeBootReadiness();
    return <View testID={`boot-${readiness.kind}`} />;
}

/** Runs the real first-run path while `ensure-home-ready` completes. */
async function renderBootstrapThroughHomeReady() {
    let homeReady = false;
    let releaseHome!: () => void;
    const ensureHomeReady = vi.fn(() => new Promise<void>((resolve) => {
        releaseHome = () => {
            homeReady = true;
            resolve();
        };
    }));
    const screen = await renderScreen(
        <PersonalHomeBootstrapGate
            isDesktopHost
            isDesktopMainWindow
            readFacts={async () => homeReady ? homeReadyFacts : pendingFacts}
            operations={{ 'ensure-home-ready': ensureHomeReady }}
        >
            <View testID="normal-shell">
                <PersonalHomeBootstrapContent><View testID="ready-home-content" /></PersonalHomeBootstrapContent>
            </View>
            <ReadinessProbe />
        </PersonalHomeBootstrapGate>,
    );

    await flushHookEffects({ cycles: 4, turns: 2 });
    // Automatic startup owns only Home content; the normal shell remains reachable.
    expect(ensureHomeReady).toHaveBeenCalled();
    expect(screen.findByTestId('personal-home-setup-surface')).not.toBeNull();
    expect(screen.findByTestId('ready-home-content')).not.toBeNull();
    expect(screen.findByTestId('personal-home-bootstrap-backdrop')?.props.pointerEvents).toBe('none');
    expect(screen.findByTestId('normal-shell')).not.toBeNull();
    expect(screen.findByTestId('boot-starting')).not.toBeNull();
    const retainedHomeContent = screen.findByTestId('ready-home-content');

    releaseHome();
    await flushHookEffects({ cycles: 6, turns: 3 });
    expect(screen.findByTestId('boot-ready')).not.toBeNull();
    expect(screen.findByTestId('ready-home-content')).toBe(retainedHomeContent);
    expect(screen.findByTestId('personal-home-bootstrap-backdrop')?.props.pointerEvents).toBe('auto');
    return screen;
}

describe('Personal Home shell reveal', () => {
    it('does not report local-Home startup on a non-desktop host', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost={false} isDesktopMainWindow={false}>
                <ReadinessProbe />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('boot-ready')).not.toBeNull();
    });

    it('shows the shell while the automatic local Home is starting', async () => {
        let releaseHome!: () => void;
        const ensureHomeReady = vi.fn(() => new Promise<void>((resolve) => { releaseHome = resolve; }));
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate
                isDesktopHost
                isDesktopMainWindow
                readFacts={async () => pendingFacts}
                operations={{ 'ensure-home-ready': ensureHomeReady }}
            >
                <View testID="normal-shell" />
                <ReadinessProbe />
            </PersonalHomeBootstrapGate>,
        );
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(ensureHomeReady).toHaveBeenCalled();
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('boot-starting')).not.toBeNull();
        await act(async () => { releaseHome(); });
    });

    it('keeps the shell mounted when automatic startup completes', async () => {
        reducedMotionSpy.mockReturnValue(false);
        const screen = await renderBootstrapThroughHomeReady();

        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('ready-home-content')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-reveal')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-reveal')?.props.pointerEvents).toBe('none');
    });

    it('also keeps the shell as the only frame under reduced motion', async () => {
        reducedMotionSpy.mockReturnValue(true);
        const screen = await renderBootstrapThroughHomeReady();

        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-reveal')).toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
    });
});
