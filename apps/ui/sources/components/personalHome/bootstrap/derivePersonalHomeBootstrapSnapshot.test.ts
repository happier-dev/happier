import { describe, expect, it } from 'vitest';

import { derivePersonalHomeBootstrapSnapshot } from './derivePersonalHomeBootstrapSnapshot';
import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';

const profile = {
    id: 'local', name: 'Personal Home', serverUrl: 'http://127.0.0.1:53288',
    createdAt: 1, updatedAt: 1, lastUsedAt: 1,
} as const;

function facts(overrides: Partial<PersonalHomeFacts> = {}): PersonalHomeFacts {
    return {
        hostIsDesktop: true,
        isDesktopMainWindow: true,
        completedPersonalHomeProfile: null,
        candidateLocalProfile: null,
        relayRuntime: { installed: true, healthy: true, status: 'healthy' },
        localHomeReachability: 'reachable',
        localHomeIdentity: 'home-1',
        localHomeAuth: 'present',
        anonymousSignup: 'disabled',
        daemon: null,
        activeTask: null,
        ...overrides,
    };
}

describe('derivePersonalHomeBootstrapSnapshot', () => {
    it('gates while the managed Home runtime is missing', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({ relayRuntime: null }));
        expect(snapshot.phase).toBe('preparing-home');
        expect(snapshot.shouldGateShell).toBe(true);
        expect(snapshot.rows[0]).toMatchObject({ id: 'home', status: 'active' });
    });

    it('resumes at app connection when runtime is healthy but profile/auth is missing', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({
            localHomeIdentity: null,
            localHomeAuth: 'missing',
        }));
        expect(snapshot.phase).toBe('connecting-app');
        expect(snapshot.rows).toEqual([
            { id: 'home', status: 'complete' },
            { id: 'app', status: 'active' },
            { id: 'computer', status: 'pending' },
        ]);
    });

    it('closes signup before releasing the shell', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({ anonymousSignup: 'enabled' }));
        expect(snapshot.phase).toBe('closing-signup');
        expect(snapshot.shouldGateShell).toBe(true);
        expect(snapshot.homeReady).toBe(false);
    });

    it('releases the shell while daemon setup remains pending', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts());
        expect(snapshot.phase).toBe('preparing-computer');
        expect(snapshot.shouldGateShell).toBe(false);
        expect(snapshot.homeReady).toBe(true);
        expect(snapshot.daemonReady).toBe(false);
    });

    it('keeps the shell usable while reporting daemon failure as a blocked secondary row', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({
            daemon: {
                serviceInstalled: true,
                daemonRunning: false,
                needsAuth: false,
                machineId: null,
                error: 'service failed',
            },
        }));
        expect(snapshot.shouldGateShell).toBe(false);
        expect(snapshot.daemonState).toBe('blocked');
        expect(snapshot.rows[2]).toMatchObject({ id: 'computer', status: 'blocked' });
    });

    it('never reopens the gate for a completed Home that is temporarily offline', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({
            completedPersonalHomeProfile: profile,
            relayRuntime: { installed: true, healthy: false, status: 'unhealthy' },
            localHomeReachability: 'unreachable',
            localHomeIdentity: null,
            localHomeAuth: 'unknown',
        }));
        expect(snapshot.shouldGateShell).toBe(false);
        expect(snapshot.homeReady).toBe(true);
    });

    it('blocks on an unclassified local runtime without rewriting it', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({
            candidateLocalProfile: profile,
            completedPersonalHomeProfile: null,
        }));
        expect(snapshot.phase).toBe('blocked');
        expect(snapshot.action).toBe('choose-existing-runtime');
    });

    it('never gates a non-desktop host', () => {
        const snapshot = derivePersonalHomeBootstrapSnapshot(facts({ hostIsDesktop: false, relayRuntime: null }));
        expect(snapshot.shouldGateShell).toBe(false);
        expect(snapshot.phase).toBe('ready');
    });
});
