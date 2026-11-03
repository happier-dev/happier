import { describe, expect, it } from 'vitest';
import { SettingsDeclarationActionInputSchemasV1 } from '../../actions/settingsDeclarationActionFamily.js';
import { CollectionSpacesStoredReadV1Schema, CollectionSpacesV1Schema, createDefaultCollectionSpaceV1,
    reduceCollectionSpacesV1, resolveCollectionSpacesV1, resolveCollectionSpaceSelectionV1, selectCollectionSpaceV1,
    type CollectionSpaceOperationV1, type CollectionSpacesV1 } from './collectionSpacesV1.js';
import { matchSessionListFilterV1 } from '../../sessions/listFilter/sessionListFilterV1.js';

function invoke(catalog: CollectionSpacesV1, input: CollectionSpaceOperationV1): CollectionSpacesV1 {
    const admitted = SettingsDeclarationActionInputSchemasV1['settings.invoke'].parse({ anchor: 'session.list.spaces', input });
    if (admitted.input?.kind !== 'collection_space') throw new Error('Expected space intent');
    const result = reduceCollectionSpacesV1(catalog, admitted.input);
    if (!result.ok) throw new Error(result.reason);
    return result.value;
}
const empty: CollectionSpacesV1 = { v: 1, spaces: [] };
const custom = (id: string) => ({ ...createDefaultCollectionSpaceV1('sessionWork'), id, name: id });

describe('collection spaces', () => {
    it('rebases a membership mode edit without replacing associations added while the editor was open', () => {
        const admitted = SettingsDeclarationActionInputSchemasV1['settings.invoke'].parse({ anchor: 'session.list.spaces', input: {
            kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'edit', spaceId: 'mixed', changes: { membership: { mode: 'manual_only' } } },
        } });
        if (admitted.input?.kind !== 'collection_space') throw new Error('Expected space intent');
        const tag = { serverId: 'home-a', accountId: 'alice', tagId: 'new-while-editing' };
        const current = invoke({ v: 1, spaces: [custom('mixed')] }, { kind: 'collection_space', entityKind: 'sessionWork',
            mutation: { op: 'associateTag', spaceId: 'mixed', tag } });
        expect(reduceCollectionSpacesV1(current, admitted.input)).toMatchObject({ ok: true, value: {
            spaces: [{ membership: { mode: 'manual_only', tags: [tag] } }],
        } });
    });
    it('rebases qualified membership association without losing other authorities or manual-only mode', () => {
        const tag = { serverId: 'home-a', accountId: 'alice', tagId: 'internal-a' };
        const other = { serverId: 'home-b', accountId: 'alice', tagId: 'internal-b' };
        const catalog = CollectionSpacesV1Schema.parse({ v: 1, spaces: [{ ...custom('manual'), membership: { mode: 'manual_only', tags: [other] } }] });
        const associated = invoke(catalog, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'associateTag', spaceId: 'manual', tag } });
        expect(associated.spaces[0]).toMatchObject({ membership: { mode: 'manual_only', tags: [other, tag] } });
        expect(invoke(associated, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'associateTag', spaceId: 'manual', tag } })).toBe(associated);
        const competing = invoke(associated, { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'associateTag', spaceId: 'manual', tag: { ...tag, tagId: 'overlapping-first-use' },
        } });
        expect(competing.spaces[0]).toMatchObject({ membership: { mode: 'manual_only', tags: [other, tag] } });
        expect(CollectionSpacesV1Schema.safeParse({ v: 1, spaces: [{ ...createDefaultCollectionSpaceV1('workflow'), membership: { mode: 'manual_only', tags: [] } }] }).success).toBe(false);
    });
    it('derives all entity defaults without materializing settings and preserves empty selection sets', () => {
        expect(resolveCollectionSpacesV1(empty, 'sessionWork').map(space => space.id)).toEqual(['my-work']);
        expect(resolveCollectionSpacesV1(empty, 'workflow')[0]?.filter).toEqual({ view: 'all' });
        expect(resolveCollectionSpacesV1(empty, 'discussion')[0]?.filter).toEqual({ state: 'active', attention: 'any', unreadOnly: false });
        expect(empty.spaces).toEqual([]);
        const value = CollectionSpacesV1Schema.parse({ v: 1, spaces: [{ ...custom('none'), filter: {
            ...custom('none').filter, homeServerIds: [], startedBy: [],
        } }] });
        expect(value.spaces[0]?.filter).toMatchObject({ homeServerIds: [], startedBy: [] });
    });

    it('reorders only its entity subsequence and resets default content at its current ordinal', () => {
        const workflow = { ...createDefaultCollectionSpaceV1('workflow'), id: 'automation' };
        const catalog: CollectionSpacesV1 = { v: 1, spaces: [custom('a'), workflow, custom('b')] };
        const reordered = invoke(catalog, { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'reorder', spaceId: 'my-work', beforeSpaceId: null,
        } });
        expect(resolveCollectionSpacesV1(reordered, 'sessionWork').map(space => space.id)).toEqual(['a', 'b', 'my-work']);
        expect(reordered.spaces.find(space => space.id === 'automation')).toBe(workflow);
        const edited = invoke(reordered, { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'edit', spaceId: 'my-work', changes: { name: 'Custom default', includeNeedsYouEverywhere: true },
        } });
        const reset = invoke(edited, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'resetDefault' } });
        expect(resolveCollectionSpacesV1(reset, 'sessionWork').map(space => space.id)).toEqual(['a', 'b', 'my-work']);
        expect(reset.spaces[3]).toEqual(createDefaultCollectionSpaceV1('sessionWork'));
        expect(reset.spaces.find(space => space.id === 'automation')).toBe(workflow);
    });

    it('materializes and resets My work with the captured global defaults rather than an empty Home selection', () => {
        const defaultSpace = { ...createDefaultCollectionSpaceV1('sessionWork'), filter: {
            ...createDefaultCollectionSpaceV1('sessionWork').filter, homeServerIds: ['home-a', 'home-b'], source: 'direct' as const,
        } };
        const operation = { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'edit', spaceId: 'my-work', changes: { name: 'Mine' },
        } } as const;
        const result = reduceCollectionSpacesV1(empty, operation, { sessionWork: defaultSpace });
        expect(result).toMatchObject({ ok: true, value: { spaces: [{ name: 'Mine', filter: { homeServerIds: ['home-a', 'home-b'], source: 'direct' } }] } });
        if (!result.ok) throw new Error(result.reason);
        expect(reduceCollectionSpacesV1(result.value, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'resetDefault' } }, { sessionWork: defaultSpace }))
            .toEqual({ ok: true, value: { v: 1, spaces: [defaultSpace] } });
    });

    it('accepts a reorder before the virtual default destination without disturbing another entity', () => {
        const workflow = { ...createDefaultCollectionSpaceV1('workflow'), id: 'flows' };
        const result = reduceCollectionSpacesV1({ v: 1, spaces: [custom('a'), workflow, custom('b')] }, {
            kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'reorder', spaceId: 'b', beforeSpaceId: 'my-work' },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(resolveCollectionSpacesV1(result.value, 'sessionWork').map(space => space.id)).toEqual(['b', 'my-work', 'a']);
        expect(result.value.spaces.find(space => space.id === 'flows')).toBe(workflow);
    });

    it('rebases field intents against the winning catalog without replacing concurrent properties or other spaces', () => {
        const old = custom('a');
        const winner = { ...old, includeNeedsYouEverywhere: true };
        const other = custom('b');
        const workflow = { ...createDefaultCollectionSpaceV1('workflow'), id: 'flows', name: 'Concurrent flows' };
        const rebased = invoke({ v: 1, spaces: [winner, workflow, other] }, { kind: 'collection_space', entityKind: 'sessionWork',
            mutation: { op: 'edit', spaceId: 'a', changes: { name: ' Rename ' } } });
        expect(rebased.spaces[0]).toMatchObject({ name: 'Rename', includeNeedsYouEverywhere: true });
        expect(rebased.spaces[1]).toBe(workflow);
        expect(rebased.spaces[2]).toBe(other);
        const removed = invoke(rebased, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'delete', spaceId: 'a' } });
        expect(removed.spaces).toEqual([workflow, other]);
        expect(reduceCollectionSpacesV1(removed, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'edit', spaceId: 'a', changes: { name: 'Late' } } }))
            .toEqual({ ok: false, reason: 'space_not_found' });
        expect(reduceCollectionSpacesV1(removed, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'delete', spaceId: 'flows' } }))
            .toEqual({ ok: false, reason: 'space_entity_mismatch' });
    });

    it('appends a minted identity beyond the shortcut count and refuses a retried duplicate create', () => {
        const spaces = Array.from({ length: 11 }, (_, index) => custom(`space-${index}`));
        const operation = { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'create', space: { ...custom('new'), name: 'space-0' },
        } } as const;
        const created = invoke({ v: 1, spaces }, operation);
        expect(resolveCollectionSpacesV1(created, 'sessionWork').map(space => space.id)).toEqual(['my-work', ...spaces.map(space => space.id), 'new']);
        expect(created.spaces[0]).toBe(spaces[0]);
        expect(reduceCollectionSpacesV1(created, operation)).toEqual({ ok: false, reason: 'space_already_exists' });
    });

    it('rejects unsupported new filter selections while preserving opaque narrowing on an unrelated edit', () => {
        const space = { ...custom('future-plugin'), filter: { ...custom('future-plugin').filter,
            extensions: { 'removed.plugin/release': { kind: 'boolean' as const, value: true } },
        } };
        expect(reduceCollectionSpacesV1(empty, { kind: 'collection_space', entityKind: 'sessionWork', mutation: { op: 'create', space } }))
            .toEqual({ ok: false, reason: 'unsupported_filter_fields' });
        const persisted: CollectionSpacesV1 = { v: 1, spaces: [space] };
        expect(reduceCollectionSpacesV1(persisted, { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'edit', spaceId: space.id, changes: { name: 'Retained' },
        } })).toMatchObject({ ok: true, value: { spaces: [{ name: 'Retained', filter: space.filter }] } });
        expect(reduceCollectionSpacesV1(persisted, { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
            op: 'edit', spaceId: space.id, changes: { filter: space.filter },
        } })).toEqual({ ok: false, reason: 'unsupported_filter_fields' });
    });

    it('keeps selection device, Account and entity local and waits for authoritative deletion before fallback', () => {
        const local = selectCollectionSpaceV1({ v: 1, byAccountScope: {} }, 'home/account', 'sessionWork', 'a');
        expect(selectCollectionSpaceV1(local, 'home/account', 'sessionWork', 'a')).toBe(local);
        expect(resolveCollectionSpaceSelectionV1(local, 'home/account', 'sessionWork', [], { authoritative: false })).toBe('a');
        expect(resolveCollectionSpaceSelectionV1(local, 'home/account', 'sessionWork', [], { authoritative: true })).toBe('my-work');
        expect(resolveCollectionSpaceSelectionV1(local, 'other/account', 'sessionWork', [], { authoritative: false })).toBe('my-work');
        expect(resolveCollectionSpaceSelectionV1(local, 'home/account', 'workflow', [], { authoritative: true })).toBe('all-workflows');
    });

    it('preserves future narrowing through the persisted catalog and never turns it into a match', () => {
        const future = { ...custom('future'), filter: { ...custom('future').filter, homeServerIds: ['home'], futureScope: { selected: ['narrow'] } } };
        expect(CollectionSpacesV1Schema.safeParse({ v: 1, spaces: [future] }).success).toBe(false);
        const read = CollectionSpacesStoredReadV1Schema.parse({ v: 1, spaces: [future] });
        const space = read.spaces[0];
        expect(space?.entityKind).toBe('sessionWork');
        if (space?.entityKind !== 'sessionWork') throw new Error('Expected session space');
        expect(matchSessionListFilterV1(space.filter, { serverId: 'home', kind: 'session', startedBy: 'you', scopeMatches: { my_work: true } })).toBe('unavailable');
    });
});
