import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFindSeedHandoff } from '@/components/appShell/panes/fileFindSeedHandoff';

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'srv_identity',
    serverUrl: 'https://relay.example.test',
    generation: 0,
}));

const appliedServerSnapshot = vi.hoisted(() => ({
    serverId: 'srv_identity',
    serverUrl: 'https://relay.example.test',
    generation: 0,
}));

const appliedRuntime = vi.hoisted(() => ({ available: true }));

const storageState = vi.hoisted(() => ({
    profileScope: null as null | { serverId: string; accountId: string },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/runtime/orchestration/appliedActiveServerRuntime', () => ({
    getAppliedActiveServerSnapshot: () => appliedServerSnapshot,
    isAppliedActiveServerRuntimeAvailable: () => appliedRuntime.available,
}));

vi.mock('@/sync/domains/state/storageStateReaderBridge', () => ({
    readRegisteredStorageState: () => storageState,
}));

describe('getActiveServerAccountScope', () => {
    beforeEach(() => {
        activeServerSnapshot.serverId = 'srv_identity';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.generation = 0;
        appliedServerSnapshot.serverId = 'srv_identity';
        appliedServerSnapshot.serverUrl = 'https://relay.example.test';
        appliedServerSnapshot.generation = 0;
        appliedRuntime.available = true;
        storageState.profileScope = null;
    });

    async function lifetimeApi() {
        const module = await import('./activeServerAccountScope') as typeof import('./activeServerAccountScope') & {
            captureActiveServerAccountScopeLifetime?: () => null | Readonly<{
                scope: Readonly<{ serverId: string; accountId: string }>;
                isCurrent(): boolean;
                onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
            }>;
            retireActiveServerAccountScopeLifetime?: () => void;
        };
        expect(module.captureActiveServerAccountScopeLifetime).toBeTypeOf('function');
        expect(module.retireActiveServerAccountScopeLifetime).toBeTypeOf('function');
        if (!module.captureActiveServerAccountScopeLifetime || !module.retireActiveServerAccountScopeLifetime) {
            throw new Error('Expected the active Account-scope lifetime owner.');
        }
        return module;
    }

    it('returns the active scope when both the snapshot and stored scope use the identity id', async () => {
        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-1' };

        const { getActiveServerAccountScope } = await import('./activeServerAccountScope');

        expect(getActiveServerAccountScope()).toEqual({
            serverId: 'srv_identity',
            accountId: 'account-1',
        });
    });

    it('qualifies active-only content reads to the requested Home without inferring a missing Home', async () => {
        const { selectActiveServerAccountScopeForServer } = await import('./activeServerAccountScope');
        const scope = { serverId: 'srv_identity', accountId: 'account-a' };
        expect(selectActiveServerAccountScopeForServer(scope, ' srv_identity ')).toBe(scope);
        expect(selectActiveServerAccountScopeForServer(scope, 'other-home')).toBeNull();
        expect(selectActiveServerAccountScopeForServer(scope, null)).toBeNull();
        expect(selectActiveServerAccountScopeForServer(scope, '')).toBeNull();
        expect(selectActiveServerAccountScopeForServer(null, 'srv_identity')).toBeNull();
    });

    it('does not treat a legacy host-derived scope as active after the snapshot resolves to identity', async () => {
        storageState.profileScope = { serverId: 'localhost-18829', accountId: 'account-1' };

        const { getActiveServerAccountScope } = await import('./activeServerAccountScope');

        expect(getActiveServerAccountScope()).toBeNull();
    });

    it('retires a captured Account lifetime synchronously before cancellation callbacks and isolates callback failures', async () => {
        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await lifetimeApi();

        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime).not.toBeNull();
        if (!lifetime) throw new Error('Expected Account A lifetime.');
        expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
        expect(lifetime.scope).toEqual(storageState.profileScope);
        expect(lifetime.isCurrent()).toBe(true);

        const calls: string[] = [];
        lifetime.onRetire(() => {
            expect(lifetime.isCurrent()).toBe(false);
            calls.push('failing');
            throw new Error('one consumer failed');
        });
        lifetime.onRetire(() => {
            expect(lifetime.isCurrent()).toBe(false);
            calls.push('later');
        });
        const removed = lifetime.onRetire(() => { calls.push('removed'); });
        removed.dispose();
        removed.dispose();

        retireActiveServerAccountScopeLifetime();
        retireActiveServerAccountScopeLifetime();

        expect(lifetime.isCurrent()).toBe(false);
        expect(calls).toEqual(['failing', 'later']);

        lifetime.onRetire(() => { calls.push('late'); });
        expect(calls).toEqual(['failing', 'later', 'late']);
    });

    it('does not reuse a captured lifetime across an Account change with the same server', async () => {
        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await lifetimeApi();

        const accountA = captureActiveServerAccountScopeLifetime();
        expect(accountA).not.toBeNull();
        if (!accountA) throw new Error('Expected Account A lifetime.');

        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-b' };
        const accountB = captureActiveServerAccountScopeLifetime();

        expect(accountA.isCurrent()).toBe(false);
        expect(accountB).not.toBeNull();
        expect(accountB).not.toBe(accountA);
        expect(accountB?.scope).toEqual(storageState.profileScope);
        expect(accountB?.isCurrent()).toBe(true);

        retireActiveServerAccountScopeLifetime();
    });

    it('retires pending file Find seeds and rejects a different Home with the same Account id', async () => {
        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await lifetimeApi();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected current Account lifetime.');
        const handoff = createFileFindSeedHandoff();
        const destination = { host: 'project' as const, id: 'project-a', accountId: 'account-a', path: 'src/a.ts',
            scope: { serverId: 'srv_identity', machineId: 'machine-a', rootPath: '/repo' } };
        const seed = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: destination.path } };
        const wrongHome = { ...destination, scope: { ...destination.scope, serverId: 'other-home' } };
        handoff.stage(wrongHome, seed, lifetime);
        expect(handoff.peek(wrongHome)).toBeNull();
        handoff.stage(destination, seed, lifetime);
        expect(handoff.peek(destination)).toEqual(seed);
        retireActiveServerAccountScopeLifetime();
        expect(handoff.peek(destination)).toBeNull();
    });

    it('keeps the applied lifetime through staging, then retires it when the singleton runtime resets', async () => {
        storageState.profileScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await lifetimeApi();

        const accountA = captureActiveServerAccountScopeLifetime();
        expect(accountA).not.toBeNull();
        if (!accountA) throw new Error('Expected Account A lifetime.');

        activeServerSnapshot.serverId = 'srv_next';
        activeServerSnapshot.serverUrl = 'https://next.example.test';
        activeServerSnapshot.generation = 1;
        expect(captureActiveServerAccountScopeLifetime()).toBe(accountA);
        expect(accountA.isCurrent()).toBe(true);

        appliedRuntime.available = false;
        expect(captureActiveServerAccountScopeLifetime()).toBeNull();
        expect(accountA.isCurrent()).toBe(false);

        appliedServerSnapshot.serverId = 'srv_next';
        appliedServerSnapshot.serverUrl = 'https://next.example.test';
        appliedServerSnapshot.generation = 1;
        appliedRuntime.available = true;
        storageState.profileScope = { serverId: 'srv_next', accountId: 'account-b' };
        const accountB = captureActiveServerAccountScopeLifetime();
        expect(accountB).not.toBeNull();
        expect(accountB).not.toBe(accountA);
        expect(accountB?.scope).toEqual(storageState.profileScope);

        retireActiveServerAccountScopeLifetime();
    });
});
