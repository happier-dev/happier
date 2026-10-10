import { describe, expect, it } from 'vitest';
import * as owner from './remoteHostCatalogSnapshot';

describe('scoped Remote host publication', () => {
    it('retains display continuity while withdrawing stale authority and clears refused Account data', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const host = { id: 'host', name: 'Host', ssh: { target: 'dev@example.test', authMode: 'agent' as const },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        const ready = { status: 'ready' as const, hosts: [host], diagnostics: [], revision: 2 };
        owner.applyRemoteHostCatalogSnapshot(scope, ready, true);
        const initial = owner.getRemoteHostCatalogSnapshot(scope)!;
        owner.beginRemoteHostCatalogLoad(scope);
        expect(owner.getRemoteHostCatalogSnapshot(scope)).toMatchObject({ stale: true, catalog: { status: 'loading' } });
        expect(owner.getRemoteHostCatalogSnapshot(scope)?.data).toBe(initial.data);
        owner.applyRemoteHostCatalogSnapshot(scope, ready, false);
        expect(owner.getRemoteHostCatalogSnapshot(scope)?.catalog.status).toBe('loading');
        owner.applyRemoteHostCatalogSnapshot(scope, ready, true);
        expect(owner.getRemoteHostCatalogSnapshot(scope)?.data).toBe(initial.data);
        const restored = owner.getRemoteHostCatalogSnapshot(scope);
        owner.applyRemoteHostCatalogSnapshot({ serverId: 'other', accountId: 'account' }, ready, true);
        expect(owner.getRemoteHostCatalogSnapshot(scope)).toBe(restored);
        owner.applyRemoteHostCatalogSnapshot(scope, { ...ready, cleanup: 'pending' }, true);
        expect(owner.getRemoteHostCatalogSnapshot(scope)).toMatchObject({ stale: false, catalog: { cleanup: 'pending' } });
        owner.applyRemoteHostCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        expect(owner.getRemoteHostCatalogSnapshot(scope)?.data).toBe(initial.data);
        owner.applyRemoteHostCatalogSnapshot(scope, { status: 'unavailable', reason: 'unsupported' }, true);
        expect(owner.getRemoteHostCatalogSnapshot(scope)?.data).toBeNull();
        owner.applyRemoteHostCatalogSnapshot(scope, ready, true);
        owner.applyRemoteHostCatalogSnapshot(scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        expect(owner.getRemoteHostCatalogSnapshot(scope)?.data).toBeNull();
    });
});
