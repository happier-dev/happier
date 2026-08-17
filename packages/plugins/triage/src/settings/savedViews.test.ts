import { describe, expect, it } from 'vitest';

import type { SurfaceFilterSelectionV1 } from '../projection/listWindow.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../projection/listWindow.js';
import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../corpus/query/smartPolicy.js';
import {
    CORPUS_EMPTY_SAVED_VIEWS_V1,
    MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1,
    MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1,
    MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1,
    MAX_TRIAGE_SAVED_VIEWS_V1,
    TRIAGE_SAVED_VIEWS_SETTING_ID_V1,
    mutateTriageSavedViews,
    parseTriageSavedViews,
    readTriageSavedViews,
} from './savedViews.js';
import { createTestkitAccountSettings } from './testkit/accountSettings.test-support.js';

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });

function filters(overrides: Partial<SurfaceFilterSelectionV1> = {}): SurfaceFilterSelectionV1 {
    return { ...TRIAGE_LIST_NO_FILTERS_V1, ...overrides };
}

function mintIds(): () => string {
    let counter = 0;
    return () => {
        counter += 1;
        return `${counter.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    };
}

function createDeps(fixture: ReturnType<typeof createTestkitAccountSettings>) {
    return { settings: fixture.settings, mintViewId: mintIds() };
}

async function create(
    fixture: ReturnType<typeof createTestkitAccountSettings>,
    deps: ReturnType<typeof createDeps>,
    label: string,
    overrides: Partial<Readonly<{ filters: SurfaceFilterSelectionV1; order: 'newest' | 'oldest' | 'smart' }>> = {},
) {
    void fixture;
    return await mutateTriageSavedViews(deps, {
        kind: 'create',
        label,
        filters: overrides.filters ?? filters(),
        order: overrides.order ?? 'newest',
        smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        select: true,
    });
}

describe('parseTriageSavedViews', () => {
    it('reads an absent value as the deterministic unsaved default', () => {
        expect(parseTriageSavedViews(undefined)).toEqual({ kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 });
        expect(parseTriageSavedViews(null)).toEqual({ kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 });
        expect(CORPUS_EMPTY_SAVED_VIEWS_V1).toEqual({ v: 1, views: [], selectedViewId: null });
    });

    it('reports a stored value it cannot read instead of silently becoming the default', () => {
        // A default-shaped answer here is what would let the next write destroy
        // durable user state a newer build wrote and this one cannot parse.
        const unreadable = parseTriageSavedViews({ v: 2, views: [], selectedViewId: null });
        expect(unreadable.kind).toBe('unreadable');
        expect(unreadable.value).toEqual(CORPUS_EMPTY_SAVED_VIEWS_V1);
    });

    /**
     * The reader meets the same whole-value bound the writer enforces.
     *
     * A reader that accepted what its own writer refuses is how a stored value
     * this build never produced returns an Action result past the host's 1 MiB
     * gate — and that gate rejects the result whole, so the user would lose
     * every saved view instead of getting the honest `unreadable` answer.
     */
    it('refuses a stored value larger than the bound its own writer enforces', () => {
        // Every member is one this build knows, and every one of them would be
        // accepted on its own: only the whole value is too large. A selection
        // naming no stored view is otherwise cleared and read as `parsed`.
        const oversized = {
            v: 1,
            views: [],
            selectedViewId: 'a'.repeat(MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1),
        };

        expect(parseTriageSavedViews(oversized).kind).toBe('unreadable');
    });

    it('drops a selection that names no stored view rather than restoring a nonexistent one', () => {
        const parsed = parseTriageSavedViews({ v: 1, views: [], selectedViewId: 'not-a-stored-view' });
        expect(parsed.kind).toBe('parsed');
        expect(parsed.value.selectedViewId).toBeNull();
    });
});

describe('mutateTriageSavedViews', () => {
    it('restores the selected saved view exactly after restart and clears selection when it is deleted', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);

        const lens = filters({
            sources: [{ source: SOURCE }],
            states: ['open'],
            attention: ['required'],
        });
        const first = await create(fixture, deps, 'Needs my review', { filters: lens, order: 'smart' });
        const second = await create(fixture, deps, 'Everything');
        expect(first.status).toBe('applied');
        expect(second.status).toBe('applied');
        if (first.status !== 'applied' || second.status !== 'applied') return;

        // "Restart": a fresh reader over the same stored bytes, with no
        // in-process state carried across.
        const restarted = await readTriageSavedViews({ settings: fixture.settings });
        expect(restarted.value.selectedViewId).toBe(second.viewId);
        expect(restarted.value.views).toHaveLength(2);
        expect(restarted.value.views[0]).toEqual({
            viewId: first.viewId,
            label: 'Needs my review',
            filters: lens,
            order: 'smart',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        });

        // Deleting the selected view clears the selection in the same write.
        const deleted = await mutateTriageSavedViews(deps, { kind: 'delete', viewId: second.viewId });
        expect(deleted.status).toBe('applied');
        const afterDelete = await readTriageSavedViews({ settings: fixture.settings });
        expect(afterDelete.value.selectedViewId).toBeNull();
        expect(afterDelete.value.views.map((view) => view.viewId)).toEqual([first.viewId]);
        // Asserted on the stored bytes, not only on the parsed read: leaving a
        // dangling id in durable state and repairing it on every read would
        // look identical here while silently persisting a selection that names
        // nothing.
        expect(fixture.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1))
            .toMatchObject({ selectedViewId: null });

        // Deleting an unselected view leaves the selection alone.
        await mutateTriageSavedViews(deps, { kind: 'select', viewId: first.viewId });
        const third = await create(fixture, deps, 'Third');
        if (third.status !== 'applied') return;
        await mutateTriageSavedViews(deps, { kind: 'select', viewId: first.viewId });
        await mutateTriageSavedViews(deps, { kind: 'delete', viewId: third.viewId });
        expect((await readTriageSavedViews({ settings: fixture.settings })).value.selectedViewId)
            .toBe(first.viewId);
    });

    it('keys selection on the minted view id rather than an index or a display label', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);
        const first = await create(fixture, deps, 'Mine');
        const second = await create(fixture, deps, 'Mine');
        if (first.status !== 'applied' || second.status !== 'applied') return;
        expect(first.viewId).not.toBe(second.viewId);

        await mutateTriageSavedViews(deps, { kind: 'select', viewId: second.viewId });
        await mutateTriageSavedViews(deps, { kind: 'delete', viewId: first.viewId });

        // An index- or label-keyed selection would now name the wrong view.
        const after = await readTriageSavedViews({ settings: fixture.settings });
        expect(after.value.selectedViewId).toBe(second.viewId);
        expect(after.value.views).toHaveLength(1);
        expect(await mutateTriageSavedViews(deps, { kind: 'select', viewId: first.viewId }))
            .toEqual({ status: 'unknownView' });
        expect(await mutateTriageSavedViews(deps, { kind: 'delete', viewId: first.viewId }))
            .toEqual({ status: 'unknownView' });
    });

    it('enforces label, view count, facet cardinality and whole-value bounds before CAS', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);

        const maximalLabel = 'a'.repeat(MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1);
        expect((await create(fixture, deps, maximalLabel)).status).toBe('applied');
        // A trimmed label is measured after trimming, and the stored value is
        // exactly what was validated.
        const trimmed = await create(fixture, deps, `   ${maximalLabel}   `);
        expect(trimmed.status).toBe('applied');
        if (trimmed.status === 'applied') {
            const stored = (await readTriageSavedViews({ settings: fixture.settings })).value.views
                .find((view) => view.viewId === trimmed.viewId);
            expect(stored?.label).toBe(maximalLabel);
        }

        const writesBeforeRejections = fixture.setCallCount();
        expect(await create(fixture, deps, '')).toEqual({ status: 'rejected', reason: 'label' });
        expect(await create(fixture, deps, '   ')).toEqual({ status: 'rejected', reason: 'label' });
        // 129 bytes: one over, measured in UTF-8 bytes and not characters.
        expect(await create(fixture, deps, 'a'.repeat(MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1 + 1)))
            .toEqual({ status: 'rejected', reason: 'label' });
        // A three-byte code point counts three times, so 43 of them overflow.
        expect(await create(fixture, deps, '本'.repeat(43)))
            .toEqual({ status: 'rejected', reason: 'label' });
        expect(await create(fixture, deps, '本'.repeat(42))).toMatchObject({ status: 'applied' });

        // Facet cardinality: 16 accepted, 17 rejected, duplicates rejected by
        // canonical identity rather than by object reference.
        const scopeValues = (count: number) => Array.from({ length: count }, (_unused, index) => ({
            source: SOURCE,
            // Padded so the whole-value bound is reached by a set of
            // individually valid views rather than by one oversized member.
            collisionScope: `example/${'r'.repeat(120)}-${index}`,
        }));
        expect(await create(fixture, deps, 'Sixteen scopes', {
            filters: filters({ scopes: scopeValues(MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1) }),
        })).toMatchObject({ status: 'applied' });
        expect(await create(fixture, deps, 'Seventeen scopes', {
            filters: filters({ scopes: scopeValues(MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 + 1) }),
        })).toEqual({ status: 'rejected', reason: 'facetLimit' });
        expect(await create(fixture, deps, 'Duplicate scopes', {
            filters: filters({
                scopes: [
                    { source: SOURCE, collisionScope: 'example/repository' },
                    { source: { ...SOURCE }, collisionScope: 'example/repository' },
                ],
            }),
        })).toEqual({ status: 'rejected', reason: 'duplicateFacetValue' });
        expect(await create(fixture, deps, 'Duplicate states', {
            filters: filters({ states: ['open', 'open'] }),
        })).toEqual({ status: 'rejected', reason: 'duplicateFacetValue' });

        // Nothing above reached the Settings record.
        expect(fixture.setCallCount()).toBe(writesBeforeRejections + 2);

        // The whole serialized value is bounded, not each member: a set of
        // individually valid views that together overflow is rejected.
        const wide = createTestkitAccountSettings();
        const wideDeps = createDeps(wide);
        let overflowed: string | null = null;
        for (let index = 0; index < MAX_TRIAGE_SAVED_VIEWS_V1; index += 1) {
            const result = await mutateTriageSavedViews(wideDeps, {
                kind: 'create',
                label: `view ${index}`,
                filters: filters({ scopes: scopeValues(MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1) }),
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            });
            if (result.status === 'rejected') {
                overflowed = result.reason;
                break;
            }
        }
        expect(overflowed).toBe('valueTooLarge');
        const serialized = JSON.stringify(wide.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1));
        expect(new TextEncoder().encode(serialized).byteLength)
            .toBeLessThanOrEqual(MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1);
    });

    it('rejects the thirty-third view rather than trimming the set', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);
        for (let index = 0; index < MAX_TRIAGE_SAVED_VIEWS_V1; index += 1) {
            expect(await create(fixture, deps, `view ${index}`)).toMatchObject({ status: 'applied' });
        }
        expect(await create(fixture, deps, 'one too many'))
            .toEqual({ status: 'rejected', reason: 'viewLimit' });
        expect((await readTriageSavedViews({ settings: fixture.settings })).value.views)
            .toHaveLength(MAX_TRIAGE_SAVED_VIEWS_V1);
    });

    it('rejects an order or Smart policy outside the closed vocabulary', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);
        expect(await mutateTriageSavedViews(deps, {
            kind: 'create',
            label: 'Bad order',
            filters: filters(),
            order: 'attention' as unknown as 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        })).toEqual({ status: 'rejected', reason: 'order' });
        expect(await mutateTriageSavedViews(deps, {
            kind: 'create',
            label: 'Bad policy',
            filters: filters(),
            order: 'smart',
            smartPolicy: { v: 1, precedence: ['attention', 'staleness'] } as never,
        })).toEqual({ status: 'rejected', reason: 'smartPolicy' });
    });

    it('retains the Smart policy across a non-Smart order switch', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);
        const created = await mutateTriageSavedViews(deps, {
            kind: 'create',
            label: 'Activity first',
            filters: filters(),
            order: 'smart',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        });
        if (created.status !== 'applied') throw new Error('setup failed');

        const updated = await mutateTriageSavedViews(deps, {
            kind: 'update',
            viewId: created.viewId,
            label: 'Activity first',
            filters: filters(),
            order: 'newest',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        });
        expect(updated.status).toBe('applied');

        const stored = (await readTriageSavedViews({ settings: fixture.settings })).value.views[0];
        expect(stored?.order).toBe('newest');
        // The policy survives an order the policy does not apply to, so
        // switching back does not silently reset the user's preference.
        expect(stored?.smartPolicy).toEqual({ v: 1, precedence: ['activity', 'attention'] });
    });

    it('returns the typed conflict without overwriting a competing writer', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);
        const created = await create(fixture, deps, 'Mine');
        if (created.status !== 'applied') throw new Error('setup failed');

        // Another device writes between our read and our write.
        fixture.armConcurrentWrite(TRIAGE_SAVED_VIEWS_SETTING_ID_V1, {
            v: 1,
            views: [],
            selectedViewId: null,
        });
        const result = await mutateTriageSavedViews(deps, {
            kind: 'create',
            label: 'Ours',
            filters: filters(),
            order: 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        });

        expect(result).toEqual({ status: 'conflict' });
        expect(fixture.rejectedExpectedRevisions()).toHaveLength(1);
        // The competing write survives: there is no last-writer-wins merge and
        // no hidden local copy.
        expect(fixture.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1))
            .toEqual({ v: 1, views: [], selectedViewId: null });
    });

    it('refuses to write over a stored value it cannot read', async () => {
        const fixture = createTestkitAccountSettings({
            [TRIAGE_SAVED_VIEWS_SETTING_ID_V1]: { v: 2, views: [], selectedViewId: null },
        });
        const deps = createDeps(fixture);
        const writesBefore = fixture.setCallCount();

        expect(await create(fixture, deps, 'Mine')).toEqual({ status: 'unreadable' });
        expect(fixture.setCallCount()).toBe(writesBefore);
        expect(fixture.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1))
            .toEqual({ v: 2, views: [], selectedViewId: null });

        // The list still works: an unreadable value reads as the default lens
        // and says so, rather than failing the surface.
        const read = await readTriageSavedViews({ settings: fixture.settings });
        expect(read.kind).toBe('unreadable');
        expect(read.value).toEqual(CORPUS_EMPTY_SAVED_VIEWS_V1);
    });

    it('stores the canonical source-neutral lens with no derived tag or extra member', async () => {
        const fixture = createTestkitAccountSettings();
        const deps = createDeps(fixture);
        const lens = filters({
            sources: [{ source: SOURCE }],
            types: [{ source: SOURCE, kindId: 'pull-request' }],
            scopes: [{ source: SOURCE, collisionScope: 'example/repository' }],
        });
        const created = await create(fixture, deps, 'Canonical', { filters: lens });
        if (created.status !== 'applied') throw new Error('setup failed');

        // The persisted spelling is the canonical private identity, byte for
        // byte. A resurrected `scopeTag` encoder would show up here as an extra
        // member and reintroduce the rekey-invalidation bug it caused.
        expect(fixture.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1)).toEqual({
            v: 1,
            views: [{
                viewId: created.viewId,
                label: 'Canonical',
                filters: lens,
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            }],
            selectedViewId: created.viewId,
        });

        // An unknown facet member cannot ride along into the durable value.
        expect(await create(fixture, deps, 'Tagged', {
            filters: filters({
                scopes: [{
                    source: SOURCE,
                    collisionScope: 'example/repository',
                    scopeTag: 'derived',
                } as never],
            }),
        })).toEqual({ status: 'rejected', reason: 'filterValue' });
    });
});
