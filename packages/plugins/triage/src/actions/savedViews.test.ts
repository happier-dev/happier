import { describe, expect, it } from 'vitest';

import { TRIAGE_LIST_NO_FILTERS_V1 } from '../projection/listWindow.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../settings/savedViews.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { administerTriageSavedView, readTriageSavedViewsForSurface } from './savedViews.js';
import type { TriageAdministerSavedViewInputV1 } from './savedViewsProtocol.js';

const MINTED = '00000001-0000-4000-8000-000000000000';

function deps(fixture: ReturnType<typeof createTestkitAccountKv>) {
    return { catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => MINTED };
}

const createInput: TriageAdministerSavedViewInputV1 = {
    v: 1,
    kind: 'create',
    expectedRevision: 'absent',
    label: 'Needs my review',
    filters: TRIAGE_LIST_NO_FILTERS_V1,
    order: 'smart',
    smartPolicy: { v: 1, precedence: ['attention', 'activity'] },
    select: true,
};

describe('the saved-view Actions', () => {
    it('transports the caller intent to the one writer and returns the authoritative set', async () => {
        const fixture = createTestkitAccountKv();

        const created = await administerTriageSavedView(createInput, deps(fixture));

        expect(created.status).toBe('applied');
        // The id is minted at the writer, not by the caller: a client-chosen id
        // would let two devices claim one view.
        expect(created.views?.map((view) => view.viewId)).toEqual([MINTED]);
        expect(created.selectedViewId).toBe(MINTED);
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toMatchObject({ selectedViewId: MINTED });
    });

    it('refuses a repeated Smart predicate rather than ranking it', async () => {
        const fixture = createTestkitAccountKv();
        const writesBefore = fixture.setCallCount();

        const result = await administerTriageSavedView({
            ...createInput,
            smartPolicy: { v: 1, precedence: ['attention', 'attention'] },
        }, deps(fixture));

        // The wire bounds the shape; the closed policy owner rejects the
        // vocabulary, and nothing reached the Account KV value.
        expect(result).toEqual({ v: 1, status: 'rejected', reason: 'smartPolicy' });
        expect(fixture.setCallCount()).toBe(writesBefore);
    });

    it('reports an unknown view without writing, and never invents one', async () => {
        const fixture = createTestkitAccountKv();
        await administerTriageSavedView(createInput, deps(fixture));
        const writesBefore = fixture.setCallCount();

        expect(await administerTriageSavedView({
            v: 1,
            kind: 'select',
            viewId: '00000002-0000-4000-8000-000000000000',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        }, deps(fixture))).toEqual({ v: 1, status: 'unknownView' });
        expect(fixture.setCallCount()).toBe(writesBefore);
    });

    it('reports a stored value it cannot read as unavailable rather than as an empty set', async () => {
        const fixture = createTestkitAccountKv({
            [TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1]: { v: 2, views: [], selectedViewId: null },
        });

        const read = await readTriageSavedViewsForSurface({ v: 1 }, deps(fixture));

        // `absent` here would invite the surface to offer a create that
        // destroys a newer client's views.
        expect(read).toEqual({
            v: 1,
            availability: 'unavailable',
            views: [],
            selectedViewId: null,
            revision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        });
        expect(await administerTriageSavedView({
            ...createInput,
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        }, deps(fixture)))
            .toEqual({ v: 1, status: 'unreadable' });
    });

    it('reads back the exact stored lens after a write', async () => {
        const fixture = createTestkitAccountKv();
        await administerTriageSavedView({
            ...createInput,
            filters: {
                ...TRIAGE_LIST_NO_FILTERS_V1,
                types: [{ source: { pluginId: 'happier.github', localId: 'github' }, kindId: 'pull-request' }],
            },
        }, deps(fixture));

        const read = await readTriageSavedViewsForSurface({ v: 1 }, deps(fixture));

        expect(read.availability).toBe('parsed');
        expect(read.views[0]?.filters.types).toEqual([
            { source: { pluginId: 'happier.github', localId: 'github' }, kindId: 'pull-request' },
        ]);
        expect(read.views[0]?.order).toBe('smart');
        expect(read.views[0]?.smartPolicy).toEqual({ v: 1, precedence: ['attention', 'activity'] });
    });

    it('refuses a stale surface draft and returns the current revision after an applied write', async () => {
        const fixture = createTestkitAccountKv();
        const created = await administerTriageSavedView(createInput, deps(fixture));
        if (created.status !== 'applied' || created.revision === undefined) throw new Error('setup failed');

        const renamed = await administerTriageSavedView({
            ...createInput,
            kind: 'update',
            viewId: MINTED,
            label: 'Renamed by A',
            expectedRevision: created.revision,
        }, deps(fixture));
        expect(renamed.status).toBe('applied');

        const stale = await administerTriageSavedView({
            ...createInput,
            kind: 'update',
            viewId: MINTED,
            label: 'Needs my review',
            order: 'oldest',
            expectedRevision: created.revision,
        }, deps(fixture));

        expect(stale).toEqual({ v: 1, status: 'conflict' });
        expect((await readTriageSavedViewsForSurface({ v: 1 }, deps(fixture))).views[0])
            .toMatchObject({ label: 'Renamed by A', order: 'smart' });
    });
});
