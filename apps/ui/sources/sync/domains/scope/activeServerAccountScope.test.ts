import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'srv_identity',
    serverUrl: 'https://relay.example.test',
    generation: 0,
}));

const storageState = vi.hoisted(() => ({
    profileScope: null as null | { serverId: string; accountId: string },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/domains/state/storageStateReaderBridge', () => ({
    readRegisteredStorageState: () => storageState,
}));

describe('getActiveServerAccountScope', () => {
    beforeEach(() => {
        activeServerSnapshot.serverId = 'srv_identity';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.generation = 0;
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
});
