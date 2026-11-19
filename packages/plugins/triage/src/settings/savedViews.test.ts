import type { TriageListSortV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';

import type { SurfaceFilterSelectionV1 } from '../projection/listWindow.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../projection/listWindow.js';
import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../corpus/query/smartPolicy.js';
import {
    CORPUS_EMPTY_SAVED_VIEWS_V1,
    MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1,
    TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1,
    mutateTriageSavedViews,
    parseTriageSavedViews,
    readTriageSavedViews,
} from './savedViews.js';
import { createTestkitAccountKv } from './testkit/accountKv.test-support.js';

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });

it('persists and restores Tasks audiences through the same saved-view value', async () => {
    const fixture = createTestkitAccountKv();
    const deps = createDeps(fixture);
    const result = await create(fixture, deps, 'Agent work', { filters: filters({ tasks: 'agents' }) });
    expect(result.status).toBe('applied');
    const read = await readTriageSavedViews(deps);
    expect(read.value.views[0]?.filters.tasks).toBe('agents');
});

function filters(overrides: Partial<SurfaceFilterSelectionV1> = {}): SurfaceFilterSelectionV1 {
    return { ...TRIAGE_LIST_NO_FILTERS_V1, ...overrides };
}

function scopeValues(count: number) {
    return Array.from({ length: count }, (_unused, index) => ({
        source: SOURCE,
        collisionScope: `example/${'r'.repeat(120)}-${index}`,
    }));
}

function mintIds(): () => string {
    let counter = 0;
    return () => {
        counter += 1;
        return `${counter.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    };
}

function createDeps(fixture: ReturnType<typeof createTestkitAccountKv>) {
    return { catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: mintIds() };
}

async function create(
    fixture: ReturnType<typeof createTestkitAccountKv>,
    deps: ReturnType<typeof createDeps>,
    label: string,
    overrides: Partial<Readonly<{
        query: string;
        filters: SurfaceFilterSelectionV1;
        order: 'newest' | 'oldest' | 'smart';
        sort?: TriageListSortV1;
    }>> = {},
) {
    void fixture;
    return await mutateTriageSavedViews(deps, {
        kind: 'create',
        expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        label,
        query: overrides.query ?? '',
        filters: overrides.filters ?? filters(),
        order: overrides.order ?? 'newest',
        ...(overrides.sort === undefined ? {} : { sort: overrides.sort }),
        smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
    });
}

describe('parseTriageSavedViews', () => {
    it('ignores retired Account selection and drops it on the next catalog write', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const created = await create(fixture, deps, 'Work');
        if (created.status !== 'applied') throw new Error('setup failed');
        fixture.seed(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1, { ...created.value, selectedViewId: created.viewId });
        expect((await readTriageSavedViews(deps)).value).not.toHaveProperty('selectedViewId');
        await mutateTriageSavedViews(deps, {
            kind: 'delete', viewId: created.viewId!,
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        });
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toEqual({ v: 1, views: [] });
    });
    it('reads unknown saved-view fields recursively and retains canonical writes', async () => {
        const fixture = createTestkitAccountKv();
        const viewId = '00000001-0000-4000-8000-000000000000';
        const canonical = {
            viewId, label: 'Work', query: '', order: 'smart' as const, view: 'board' as const,
            filters: filters({ scopes: [{ source: SOURCE, collisionScope: 'example/repository' }] }),
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        };
        fixture.seed(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1, {
            v: 1, selectedViewId: viewId, retiredCatalog: true,
            views: [{ ...canonical, label: '  Work\n  ', retiredView: true,
                smartPolicy: { ...canonical.smartPolicy, retiredPolicy: true },
                filters: { ...canonical.filters, retiredFilters: true, scopes: [{
                    source: { ...SOURCE, retiredSource: true }, collisionScope: 'example/repository', retiredScope: true,
                }] },
            }],
        });
        const deps = createDeps(fixture);
        expect((await readTriageSavedViews(deps)).value).toEqual({ v: 1, views: [canonical] });
        expect((await mutateTriageSavedViews(deps, {
            ...canonical, kind: 'update', expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        })).status).toBe('applied');
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toEqual({ v: 1, views: [canonical] });
    });

    it('reads an absent value as the deterministic unsaved default', () => {
        expect(parseTriageSavedViews(undefined)).toEqual({ kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 });
        expect(parseTriageSavedViews(null)).toEqual({ kind: 'absent', value: CORPUS_EMPTY_SAVED_VIEWS_V1 });
        expect(CORPUS_EMPTY_SAVED_VIEWS_V1).toEqual({ v: 1, views: [] });
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
     * this build never produced does not silently enter the readable set, so the user would lose
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

    it('ignores a retired selection that names no stored view', () => {
        const parsed = parseTriageSavedViews({ v: 1, views: [], selectedViewId: 'not-a-stored-view' });
        expect(parsed.kind).toBe('parsed');
        expect(parsed.value).not.toHaveProperty('selectedViewId');
    });
});

describe('mutateTriageSavedViews', () => {
    it('persists two instances of one source as distinct filter choices', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const selected = filters({ sources: [
            { source: SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
            { source: SOURCE, sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
        ], scopes: [
            { source: SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111', unitId: 'team-a' },
            { source: SOURCE, sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
        ] });
        const result = await create(fixture, deps, 'Two accounts', { filters: selected });
        expect(result.status).toBe('applied');
        expect((await readTriageSavedViews(deps)).value.views[0]?.filters).toEqual(selected);
    });

    it('refuses a stale full-view draft instead of overwriting a newer rename', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const created = await create(fixture, deps, 'Original name');
        if (created.status !== 'applied') throw new Error('setup failed');

        // Both editors opened the same durable document revision. A renames the
        // view, then B submits the stale full draft it formed before that rename.
        const shared = await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) });
        const original = shared.value.views[0];
        if (original === undefined) throw new Error('setup failed');
        const command = (label: string, order: 'newest' | 'oldest') => ({
            kind: 'update' as const,
            viewId: original.viewId,
            label,
            query: original.query,
            filters: original.filters,
            order,
            smartPolicy: original.smartPolicy,
            expectedRevision: shared.revision,
        });

        expect(await mutateTriageSavedViews(deps, command('Renamed by A', 'newest')))
            .toMatchObject({ status: 'applied' });
        expect(await mutateTriageSavedViews(deps, command('Original name', 'oldest')))
            .toEqual({ status: 'conflict' });

        const after = await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) });
        expect(after.value.views[0]).toMatchObject({ label: 'Renamed by A', order: 'newest' });
    });

    it('restores a source-owned field sort exactly after restart and deletes only the named view', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);

        const lens = filters({
            sources: [{ source: SOURCE }],
            states: ['open'],
            attention: ['required'],
        });
        const first = await create(fixture, deps, 'Needs my review', {
            query: 'authentication',
            filters: lens,
            order: 'smart',
            sort: { field: 'created', direction: 'asc' },
        });
        const second = await create(fixture, deps, 'Everything');
        expect(first.status).toBe('applied');
        expect(second.status).toBe('applied');
        if (first.status !== 'applied' || second.status !== 'applied') return;

        // "Restart": a fresh reader over the same stored bytes, with no
        // in-process state carried across.
        const restarted = await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) });
        expect(restarted.value).not.toHaveProperty('selectedViewId');
        expect(restarted.value.views).toHaveLength(2);
        expect(restarted.value.views[0]).toEqual({
            viewId: first.viewId,
            label: 'Needs my review',
            query: 'authentication',
            filters: lens,
            order: 'smart',
            sort: { field: 'created', direction: 'asc' },
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            view: 'list',
        });

        // Catalog deletion removes only the named definition.
        const deleted = await mutateTriageSavedViews(deps, {
            kind: 'delete', viewId: second.viewId, expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        });
        expect(deleted.status).toBe('applied');
        const afterDelete = await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) });
        expect(afterDelete.value.views.map((view) => view.viewId)).toEqual([first.viewId]);
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1))
            .not.toHaveProperty('selectedViewId');
    });

    it('keys definitions on the minted view id rather than an index or a display label', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const first = await create(fixture, deps, 'Mine');
        const second = await create(fixture, deps, 'Mine');
        if (first.status !== 'applied' || second.status !== 'applied') return;
        expect(first.viewId).not.toBe(second.viewId);

        await mutateTriageSavedViews(deps, {
            kind: 'delete', viewId: first.viewId, expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        });

        // Same-name views remain independently addressable.
        const after = await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) });
        expect(after.value.views[0]?.viewId).toBe(second.viewId);
        expect(after.value.views).toHaveLength(1);
        expect(await mutateTriageSavedViews(deps, {
            kind: 'delete', viewId: first.viewId, expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        }))
            .toEqual({ status: 'unknownView' });
    });

    it('enforces label shape, duplicate identity and the canonical whole-value bound before CAS', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);

        const longLabel = 'a'.repeat(4 * 1024);
        expect((await create(fixture, deps, longLabel)).status).toBe('applied');
        // A trimmed label is measured after trimming, and the stored value is
        // exactly what was validated.
        const trimmed = await create(fixture, deps, `   ${longLabel}   `);
        expect(trimmed.status).toBe('applied');
        if (trimmed.status === 'applied') {
            const stored = (await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) })).value.views
                .find((view) => view.viewId === trimmed.viewId);
            expect(stored?.label).toBe(longLabel);
        }

        const writesBeforeRejections = fixture.setCallCount();
        expect(await create(fixture, deps, '')).toEqual({ status: 'rejected', reason: 'label' });
        expect(await create(fixture, deps, '   ')).toEqual({ status: 'rejected', reason: 'label' });
        expect(await create(fixture, deps, '本'.repeat(1_024)))
            .toMatchObject({ status: 'applied' });

        // Facet cardinality is governed by the complete serialized value, not
        // an independent member count. Duplicates still reject by canonical
        // identity rather than by object reference.
        expect(await create(fixture, deps, 'Sixteen scopes', {
            filters: filters({ scopes: scopeValues(16) }),
        })).toMatchObject({ status: 'applied' });
        expect(await create(fixture, deps, 'Seventeen scopes', {
            filters: filters({ scopes: scopeValues(17) }),
        })).toMatchObject({ status: 'applied' });
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

        // Nothing above reached the Account KV value.
        expect(fixture.setCallCount()).toBe(writesBeforeRejections + 3);

        // The whole serialized value is bounded, not each member: a set of
        // individually valid views that together overflow is rejected.
        const wide = createTestkitAccountKv();
        const wideDeps = createDeps(wide);
        let overflowed: string | null = null;
        for (let index = 0; index < 1_000; index += 1) {
            const result = await mutateTriageSavedViews(wideDeps, {
                kind: 'create',
                expectedRevision: wide.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
                label: `view ${index}`,
                query: '',
                filters: filters({ scopes: scopeValues(17) }),
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            });
            if (result.status === 'rejected') {
                overflowed = result.reason;
                break;
            }
        }
        expect(overflowed).toBe('valueTooLarge');
        const serialized = JSON.stringify(wide.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1));
        expect(new TextEncoder().encode(serialized).byteLength)
            .toBeLessThanOrEqual(MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1);
    });

    it('refuses non-UUID ids and control characters without replacing the saved definition', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const original = await create(fixture, deps, 'Existing view');
        if (original.status !== 'applied') throw new Error('setup failed');
        const value = fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1);

        const command = {
            kind: 'update',
            expectedRevision: original.revision,
            query: 'updated lens',
            filters: filters(),
            order: 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        } as const;
        expect(await mutateTriageSavedViews(deps, {
            ...command, viewId: 'not-a-uuid', label: 'Other view',
        })).toEqual({ status: 'unknownView' });
        expect(await mutateTriageSavedViews(deps, {
            ...command, viewId: original.viewId, label: 'Line one\nLine two',
        })).toEqual({ status: 'rejected', reason: 'label' });
        expect(await create(fixture, deps, 'Title\u0000with a control'))
            .toEqual({ status: 'rejected', reason: 'label' });
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toEqual(value);
        expect(fixture.setCallCount()).toBe(1);
    });

    it('admits a thirty-third view when the serialized Account KV value still fits', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        for (let index = 0; index < 33; index += 1) {
            expect(await create(fixture, deps, `view ${index}`)).toMatchObject({ status: 'applied' });
        }
        expect((await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) })).value.views)
            .toHaveLength(33);
    });

    it('admits more than sixteen values in a facet while the complete saved value fits', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);

        expect(await create(fixture, deps, 'Broad scope', {
            filters: filters({ scopes: scopeValues(17) }),
        })).toMatchObject({ status: 'applied' });
        expect((await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) })).value.views[0]?.filters.scopes)
            .toHaveLength(17);
    });

    it('rejects an order or Smart policy outside the closed vocabulary', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        expect(await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Bad order',
            query: '',
            filters: filters(),
            order: 'attention' as unknown as 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        })).toEqual({ status: 'rejected', reason: 'order' });
        expect(await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Bad policy',
            query: '',
            filters: filters(),
            order: 'smart',
            smartPolicy: { v: 1, precedence: ['attention', 'staleness'] } as never,
        })).toEqual({ status: 'rejected', reason: 'smartPolicy' });
    });

    it('retains the Smart policy across a non-Smart order switch', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const created = await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Activity first',
            query: '',
            filters: filters(),
            order: 'smart',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        });
        if (created.status !== 'applied') throw new Error('setup failed');

        const updated = await mutateTriageSavedViews(deps, {
            kind: 'update',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            viewId: created.viewId,
            label: 'Activity first',
            query: '',
            filters: filters(),
            order: 'newest',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        });
        expect(updated.status).toBe('applied');

        const stored = (await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) })).value.views[0];
        expect(stored?.order).toBe('newest');
        // The policy survives an order the policy does not apply to, so
        // switching back does not silently reset the user's preference.
        expect(stored?.smartPolicy).toEqual({ v: 1, precedence: ['activity', 'attention'] });
    });

    it('returns the typed conflict without overwriting a competing writer', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const created = await create(fixture, deps, 'Mine');
        if (created.status !== 'applied') throw new Error('setup failed');

        // Another device writes between our read and our write.
        fixture.armConcurrentWrite(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1, {
            v: 1,
            views: [],
            selectedViewId: null,
        });
        const result = await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Ours',
            query: '',
            filters: filters(),
            order: 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
        });

        expect(result).toEqual({ status: 'conflict' });
        expect(fixture.rejectedExpectedVersions()).toHaveLength(1);
        // The competing write survives: there is no last-writer-wins merge and
        // no hidden local copy.
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1))
            .toEqual({ v: 1, views: [], selectedViewId: null });
    });

    it('surfaces a non-conflict Account KV failure instead of reporting it as a conflict', async () => {
        // The host raises five distinguishable codes plus abort and store
        // failures from this one call. Reporting any of them as `conflict`
        // tells the user their views were changed elsewhere and to retry, when
        // in fact the write is refused for a reason retrying cannot resolve.
        const failures: readonly Error[] = [
            new PluginError({
                code: 'plugin_account_storage_value_invalid',
                message: "Triage saved views failed Account KV validation",
            }),
            new PluginError({
                code: 'plugin_account_storage_unavailable',
                message: "Plugin Account KV has no bound Account persistence owner",
            }),
            // Not every refusal is a PluginError: an abort or a store failure
            // reaches the caller as itself.
            new Error('account data store unavailable'),
        ];

        for (const failure of failures) {
            const fixture = createTestkitAccountKv();
            const catalog = fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1);
            const deps = {
                catalog: {
                    read: catalog.read.bind(catalog),
                    write: async () => {
                        throw failure;
                    },
                },
                mintViewId: mintIds(),
            };

            await expect(mutateTriageSavedViews(deps, {
                kind: 'create',
                expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
                label: 'Mine',
                query: '',
                filters: filters(),
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            })).rejects.toBe(failure);
        }
    });

    it('refuses to write over a stored value it cannot read', async () => {
        const fixture = createTestkitAccountKv({
            [TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1]: { v: 2, views: [], selectedViewId: null },
        });
        const deps = createDeps(fixture);
        const writesBefore = fixture.setCallCount();

        expect(await create(fixture, deps, 'Mine')).toEqual({ status: 'unreadable' });
        expect(fixture.setCallCount()).toBe(writesBefore);
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1))
            .toEqual({ v: 2, views: [], selectedViewId: null });

        // The list still works: an unreadable value reads as the default lens
        // and says so, rather than failing the surface.
        const read = await readTriageSavedViews({ catalog: fixture.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1) });
        expect(read.kind).toBe('unreadable');
        expect(read.value).toEqual(CORPUS_EMPTY_SAVED_VIEWS_V1);
    });

    it('stores the canonical source-neutral lens with no derived tag or extra member', async () => {
        const fixture = createTestkitAccountKv();
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
        expect(fixture.read(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1)).toEqual({
            v: 1,
            views: [{
                viewId: created.viewId,
                label: 'Canonical',
                query: '',
                filters: lens,
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
                view: 'list',
            }],
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

    it('remembers the view per saved view, reading a view saved before views existed as List', async () => {
        const fixture = createTestkitAccountKv();
        const deps = createDeps(fixture);
        const created = await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Mine',
            query: '',
            filters: filters(),
            order: 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            view: 'list',
        });
        if (created.status !== 'applied') throw new Error('setup failed');
        expect(created.value.views[0]?.view).toBe('list');
        const board = await mutateTriageSavedViews(deps, {
            kind: 'create',
            expectedRevision: fixture.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Board',
            query: '',
            filters: filters(),
            order: 'newest',
            smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            view: 'board',
        });
        if (board.status !== 'applied') throw new Error(`board view not stored: ${JSON.stringify(board)}`);
        expect(board.value.views.map((view) => view.view)).toEqual(['list', 'board']);

        const earlier = parseTriageSavedViews({
            v: 1,
            views: [{
                viewId: '00000001-0000-4000-8000-000000000000',
                label: 'Before views',
                query: '',
                filters: filters(),
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
            }],
            selectedViewId: null,
        });
        expect(earlier.kind).toBe('parsed');
        expect(earlier.value.views[0]?.view).toBe('list');

        // A view this build does not know belongs to a newer writer: the set is refused whole, never rewritten.
        const newer = parseTriageSavedViews({
            v: 1,
            views: [{
                viewId: '00000001-0000-4000-8000-000000000000',
                label: 'Later',
                query: '',
                filters: filters(),
                order: 'newest',
                smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
                view: 'timeline',
            }],
            selectedViewId: null,
        });
        expect(newer.kind).toBe('unreadable');
    });
});
