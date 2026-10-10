import { describe, expect, it } from 'vitest';
import * as owner from './profileCatalogSnapshot';

describe('scoped Profile publication', () => {
    it('withdraws runtime authority on refresh, retains display rows and rejects retired results', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const record = { v: 1 as const, id: 'p', definition: { kind: 'artifact' as const, artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {} };
        const ready = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const, control: null, controlRevision: 'absent' as const,
            records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 };
        const projection = { cleanup: { status: 'cleanup-pending' as const, reason: 'source-conflict' as const } };
        const artifacts = new Map([['a', { artifactId: 'a', header: { kind: 'launch-profile.v1' }, body: '{}' }]]);
        owner.applyProfileCatalogSnapshot(scope, ready, true, artifacts, projection);
        const initial = owner.getProfileCatalogSnapshot(scope)!;
        expect(initial).toMatchObject({ source: 'destination' });
        owner.beginProfileCatalogLoad(scope);
        expect(owner.getProfileCatalogSnapshot(scope)?.catalog.status).toBe('loading');
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toBe(initial.data);
        expect(owner.getProfileCatalogSnapshot(scope)?.dataComplete).toBe(true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ source: 'destination' });
        expect(owner.getProfileCatalogSnapshot(scope)?.cleanup).toBe(initial.cleanup);
        owner.applyProfileCatalogSnapshot(scope, ready, false);
        expect(owner.getProfileCatalogSnapshot(scope)?.catalog.status).toBe('loading');
        owner.applyProfileCatalogSnapshot(scope, ready, true, artifacts, projection);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toBe(initial.data);
        const restored = owner.getProfileCatalogSnapshot(scope);
        owner.applyProfileCatalogSnapshot({ serverId: 'other', accountId: 'account' }, ready, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(restored);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toBe(initial.data);
        expect(owner.getProfileCatalogSnapshot(scope)?.artifactsById).toBe(initial.artifactsById);
        expect(owner.getProfileCatalogSnapshot(scope)?.catalog.status).toBe('unavailable');
        owner.applyProfileCatalogSnapshot(scope, { ...ready, status: 'partial' }, true, artifacts);
        expect(owner.getProfileCatalogSnapshot(scope)?.dataComplete).toBe(false);
        owner.beginProfileCatalogLoad(scope);
        expect(owner.getProfileCatalogSnapshot(scope)?.dataComplete).toBe(false);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ data: null, source: null, dataComplete: false });
        expect(owner.getProfileCatalogSnapshot(scope)?.cleanup).toBeUndefined();
    });
});
