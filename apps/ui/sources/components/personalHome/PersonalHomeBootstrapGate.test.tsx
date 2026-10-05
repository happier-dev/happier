import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { PersonalHomeBootstrapContent, PersonalHomeBootstrapGate } from './bootstrap/PersonalHomeBootstrapGate';
import type { PersonalHomeFacts } from './bootstrap/personalHomeBootstrapTypes';

const facts: PersonalHomeFacts = {
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

function TestShell(): React.ReactElement {
    return (
        <View testID="normal-shell">
            <View testID="usable-sidebar" />
            <View testID="home-content">
                <PersonalHomeBootstrapContent>
                    <View testID="ready-home-content" />
                </PersonalHomeBootstrapContent>
            </View>
        </View>
    );
}

describe('PersonalHomeBootstrapGate', () => {
    it('keeps the shell mounted while showing one truthful post-shell pending status', async () => {
        const homeReadyFacts: PersonalHomeFacts = {
            ...facts,
            relayRuntime: {
                relayUrl: 'http://127.0.0.1:3005', installed: true, healthy: true,
                serviceActive: true, status: 'healthy', anonymousSignupEnabled: false,
                purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:3005' },
            },
            localHomeReachability: 'reachable',
            localHomeIdentity: 'srv_home_b',
            localHomeAuth: 'present',
            anonymousSignup: 'disabled',
            completedPersonalHomeProfile: {
                id: 'p1', name: 'Personal Home', serverUrl: 'http://127.0.0.1:3005',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'desktop-personal-home',
            },
            daemon: { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null },
        };
        let daemonReady = false;
        let releasePreparation!: () => void;
        const prepareComputer = vi.fn(() => new Promise<void>((resolve) => {
            releasePreparation = () => {
                daemonReady = true;
                resolve();
            };
        }));
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate
                isDesktopHost isDesktopMainWindow
                readFacts={async () => daemonReady ? {
                    ...homeReadyFacts,
                    daemon: { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'machine_1' },
                } : homeReadyFacts}
                operations={{ 'prepare-computer': prepareComputer }}
            >
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );

        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findAllHostsByTestId('personal-home-bootstrap-pending-strip')).toHaveLength(1);
        expect(screen.findByTestId('personal-home-recovery-retry')).toBeNull();

        releasePreparation();
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
    });

    it.each([
        { name: 'pending', currentFacts: facts },
        {
            name: 'recoverably blocked',
            currentFacts: {
                ...facts,
                relayRuntime: {
                    relayUrl: 'http://127.0.0.1:3005',
                    installed: true,
                    healthy: false,
                    status: 'needs-repair' as const,
                    purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:3005' },
                },
            },
        },
    ])('keeps navigation usable while centered Home content is $name', async ({ currentFacts }) => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost isDesktopMainWindow readFacts={async () => currentFacts}>
                <TestShell />
            </PersonalHomeBootstrapGate>,
        );
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findByTestId('personal-home-setup-surface')).not.toBeNull();
        expect(screen.findByTestId('usable-sidebar')).not.toBeNull();
        expect(screen.findByTestId('ready-home-content')).not.toBeNull();
        const backdrop = screen.findAllHostsByTestId('personal-home-bootstrap-backdrop')[0];
        expect(backdrop?.props.pointerEvents).toBe('none');
        expect(backdrop?.props.accessibilityElementsHidden).toBe(true);
        expect(backdrop?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(screen.findByTestId('personal-home-bootstrap-pending-strip')).toBeNull();
        expect(screen.findByTestId('home-content')?.findAll((node) => node.props.testID === 'personal-home-setup-surface').length).toBeGreaterThan(0);
    });

    it('keeps non-desktop hosts on the normal shell', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost={false} readFacts={async () => facts}>
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
    });

    it('keeps Settings reachable while the desktop Home facts are incomplete', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost isDesktopMainWindow readFacts={async () => facts}>
                <View testID="settings-route" />
            </PersonalHomeBootstrapGate>,
        );
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
        expect(screen.findByTestId('settings-route')).not.toBeNull();
    });

    it('bypasses setup in an overlay window', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate isDesktopHost isDesktopMainWindow={false} readFacts={async () => facts}>
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
    });

    it('bypasses setup for an explicit recovery or callback route', async () => {
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate bypass isDesktopHost isDesktopMainWindow readFacts={async () => facts}>
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
    });

    it('keeps shell children rendered with retry and details after a post-shell daemon failure', async () => {
        const homeReadyFacts: PersonalHomeFacts = {
            ...facts,
            relayRuntime: {
                relayUrl: 'http://127.0.0.1:3005',
                installed: true,
                healthy: true,
                serviceActive: true,
                status: 'healthy',
                purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:3005' },
                anonymousSignupEnabled: false,
            },
            localHomeReachability: 'reachable',
            localHomeIdentity: 'srv_home_b',
            localHomeAuth: 'present',
            anonymousSignup: 'disabled',
            completedPersonalHomeProfile: {
                id: 'p1', name: 'Personal Home', serverUrl: 'http://127.0.0.1:3005',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'desktop-personal-home',
            },
            daemon: {
                serviceInstalled: false,
                daemonRunning: false,
                needsAuth: false,
                machineId: null,
            },
            activeTask: {
                status: 'failed',
                taskId: 'prepare-computer-test',
                currentStepId: null,
                latestMessage: 'Background service did not reach a ready state.',
                awaitingInput: false,
                cancelRequested: false,
                events: [],
                result: {
                    protocolVersion: 1,
                    taskId: 'prepare-computer-test',
                    ok: false,
                    error: { code: 'daemon_not_ready', message: 'Background service did not reach a ready state.' },
                },
            },
        };
        const readFacts = vi.fn<(facts?: unknown) => Promise<PersonalHomeFacts>>()
            .mockResolvedValueOnce(homeReadyFacts)
            .mockResolvedValue(homeReadyFacts);
        const prepareComputer = vi.fn(async () => {
            throw new Error('Background service did not reach a ready state.');
        });
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate
                isDesktopHost
                isDesktopMainWindow
                readFacts={readFacts}
                activeTask={null}
                operations={{ 'prepare-computer': prepareComputer }}
            >
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );

        await flushHookEffects({ cycles: 6, turns: 3 });

        // The Home stays usable: children are rendered and the first-run gate is not reopened.
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();

        // The daemon failure is observable with retry and details actions in the same frame.
        expect(screen.findByTestId('personal-home-recovery-strip')).not.toBeNull();
        expect(screen.findByTestId('personal-home-recovery-retry')).not.toBeNull();
        expect(screen.findByTestId('personal-home-recovery-details')).not.toBeNull();
        expect(screen.root.findAll((node) => node.props.children === 'Background service did not reach a ready state.')).toHaveLength(0);
        await screen.pressByTestIdAsync('personal-home-recovery-details');
        expect(screen.findByTestId('personal-home-recovery-details-panel')).not.toBeNull();
        expect(screen.findByTestId('system-task-progress-card')).not.toBeNull();
        const recoveryStrip = screen.findAllHostsByTestId('personal-home-recovery-strip')[0];
        expect(recoveryStrip?.props.accessibilityLiveRegion).toBe('polite');
        expect(recoveryStrip?.props.accessibilityRole).not.toBe('alert');
    });

    it('shows a truthful recovery strip for post-shell profile completion and retries through the controller operation', async () => {
        const verifiedUnadopted: PersonalHomeFacts = {
            ...facts,
            relayRuntime: {
                relayUrl: 'http://127.0.0.1:3005',
                installed: true,
                healthy: true,
                serviceActive: true,
                status: 'healthy',
                purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:3005' },
                anonymousSignupEnabled: false,
            },
            localHomeReachability: 'reachable',
            localHomeIdentity: 'srv_home_b',
            localHomeAuth: 'present',
            anonymousSignup: 'disabled',
            completedPersonalHomeProfile: null,
            candidateLocalProfile: {
                id: 'p1', name: 'Personal Home', serverUrl: 'http://127.0.0.1:3005',
                serverIdentityId: 'srv_home_b', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            },
            daemon: null,
        };
        const adoptedProfile = {
            id: 'p1', name: 'Personal Home', serverUrl: 'http://127.0.0.1:3005',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        } as NonNullable<PersonalHomeFacts['completedPersonalHomeProfile']>;
        let adopted = false;
        let failFirst = true;
        const readFacts = vi.fn(async (): Promise<PersonalHomeFacts> => adopted
            ? { ...verifiedUnadopted, completedPersonalHomeProfile: adoptedProfile }
            : verifiedUnadopted);
        const ensureHomeReady = vi.fn(async () => {
            if (failFirst) throw new Error('profile store unavailable');
            adopted = true;
        });
        const screen = await renderScreen(
            <PersonalHomeBootstrapGate
                isDesktopHost
                isDesktopMainWindow
                readFacts={readFacts}
                operations={{ 'ensure-home-ready': ensureHomeReady }}
            >
                <View testID="normal-shell" />
            </PersonalHomeBootstrapGate>,
        );

        await flushHookEffects({ cycles: 6, turns: 3 });

        // The shell is released; the pending profile completion is observable as a retryable
        // recovery strip in the same frame, never as a reopened first-run gate.
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
        expect(screen.findByTestId('personal-home-recovery-strip')).not.toBeNull();
        expect(screen.findByTestId('personal-home-recovery-retry')).not.toBeNull();

        failFirst = false;
        await screen.pressByTestIdAsync('personal-home-recovery-retry');
        await flushHookEffects({ cycles: 6, turns: 3 });

        // The retry runs the same canonical ensure-home-ready operation, which completes adoption.
        expect(ensureHomeReady).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('personal-home-recovery-strip')).toBeNull();
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
    });
});
