import { expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { widgetAreaLayoutSurfaceKey } from '../../domains/widgets/widgetAreaLayoutSurface';
import { createArtifactsDomain, type ArtifactsDomain } from './artifacts';

it('publishes only admitted surface revision changes and withdraws lost authority or invalid headers', () => {
    const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'account',
        owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'mine' } };
    const other: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'other' } };
    const row = (target: WidgetSurfaceRefV1): Extract<DecryptedArtifact, { isDecrypted: true }> => ({
        id: buildWidgetSurfaceArtifactIdV1(target), rawHeader: buildWidgetSurfaceArtifactHeaderV1({ v: 1, surface: target, items: [] }),
        title: 'Layout', headerVersion: 1, bodyVersion: 1, isDecrypted: true, seq: 1, createdAt: 1, updatedAt: 1,
        ownerAccountId: target.accountId, access: 'owner',
    });
    const selected = row(surface);
    const unrelated = row(other);
    store.getState().applyArtifacts([selected, unrelated]);
    const key = widgetAreaLayoutSurfaceKey(surface);
    const read = () => store.getState().artifactWidgetAreaLayoutPublications;
    const initial = read();
    const bucket = initial.bySurface.get(key);
    const otherBucket = initial.bySurface.get(widgetAreaLayoutSurfaceKey(other));
    // Caller property order and named-layout selection must address the same base surface.
    expect(widgetAreaLayoutSurfaceKey({ accountId: surface.accountId, owner: { area: 'main', pageId: 'usage', kind: 'corePage' },
        serverId: surface.serverId })).toBe(key);
    expect(bucket?.get(selected.id)).toMatchObject({ headerVersion: 1, bodyVersion: 1 });
    store.getState().updateArtifact({ ...selected, updatedAt: 2, body: 'Opened body' });
    expect(read()).toBe(initial);
    store.getState().updateArtifact({ ...selected, bodyVersion: 2 });
    expect(read().bySurface.get(key)).not.toBe(bucket);
    expect(read().bySurface.get(key)?.get(selected.id)?.bodyVersion).toBe(2);
    expect(read().bySurface.get(widgetAreaLayoutSurfaceKey(other))).toBe(otherBucket);
    store.getState().updateArtifact({ ...selected, bodyVersion: 2, access: 'view' });
    expect(read().bySurface.get(key)).toBeUndefined();
    store.getState().updateArtifact({ ...selected, bodyVersion: 2 });
    expect(read().bySurface.get(key)?.has(selected.id)).toBe(true);
    store.getState().updateArtifact({ ...selected, headerVersion: 2, bodyVersion: 2,
        rawHeader: { ...selected.rawHeader, surface: other } });
    expect(read().bySurface.get(key)).toBeUndefined();
    expect(read().bySurface.get(widgetAreaLayoutSurfaceKey(other))).toBe(otherBucket);
    store.getState().updateArtifact({ ...selected, headerVersion: 3, bodyVersion: 2 });
    expect(read().bySurface.get(key)?.has(selected.id)).toBe(true);
    store.getState().updateArtifact({ ...selected, headerVersion: 4, bodyVersion: 2, ownerAccountId: 'someone-else' });
    expect(read().bySurface.get(key)).toBeUndefined();
    store.getState().updateArtifact({ ...selected, headerVersion: 5, bodyVersion: 2 });
    expect(read().bySurface.get(key)?.has(selected.id)).toBe(true);
    store.getState().applyArtifacts([], store.getState().artifacts);
    expect(read().bySurface.size).toBe(0);
    expect(read().byArtifactId.size).toBe(0);
});
