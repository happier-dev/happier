import { describe, expect, it } from 'vitest';
import { createWorkBoardV1, WorkBoardsV1Schema } from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeSessionListFilterV1} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { buildSessionListFilterQueryHomes } from '@/components/sessions/shell/search/sessionListViewFilters';

import { fromStoredSessionListFilter, toStoredSessionListFilter } from '@/components/sessions/shell/search/storedSessionListFilter';
import { createFilteredBoardRoute, readFilteredBoardRoute } from '../boardsRoutes';

describe('board Sessions filter', () => {
    it('reopens unknown core and extension restrictions without broadening the stored selector', () => {
        const filter = { ...normalizeSessionListFilterV1({ homeServerIds: ['home-a'] }),
            futureCore: { value: 'narrow' }, extensions: { 'acme.future': { kind: 'future', value: true } } };
        const saved = WorkBoardsV1Schema.parse({ v: 1, boards: [{ ...createWorkBoardV1({ id: 'future', name: 'Future' }), source: { picked: [], filter } }] });
        const editor = fromStoredSessionListFilter(saved.boards[0]!.source.filter!, ['home-a']);
        expect(editor).toMatchObject(filter);
        expect(toStoredSessionListFilter(editor)).toEqual(filter);
    });
    it('opens a transient Board using the same qualified filter, and rejects malformed route filters', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', show: 'both',
            homeServerIds: ['home-a'], underSessionId: 'manager / one' });
        const route = createFilteredBoardRoute(filter);
        const value = new URL(route, 'https://example.test').searchParams.get('filter');
        expect(readFilteredBoardRoute(value)).toEqual(filter);
        expect(readFilteredBoardRoute('{')).toBeNull();
        expect(readFilteredBoardRoute(JSON.stringify({ ...filter, underSessionId: 3 }))).toBeNull();
        expect(readFilteredBoardRoute(JSON.stringify({ ...filter, unknown: true }))).toBeNull();
    });
    it('passes a saved coordinator filter to the canonical Home subtree query and preserves it through editing', () => {
        const filter = normalizeSessionListFilterV1({
            scope: 'all_accessible', homeServerIds: ['home-a'], underSessionId: 'coordinator',
        });
        const saved = WorkBoardsV1Schema.parse({ v: 1, boards: [{
            ...createWorkBoardV1({ id: 'tree', name: 'Payments' }), source: { picked: [], filter }, mode: 'by_status',
        }] }).boards[0]!;
        const editor = fromStoredSessionListFilter(saved.source.filter!, ['home-a', 'home-b']);
        const queries = buildSessionListFilterQueryHomes(editor, {
            storage: 'active', includeInactive: false, mountedHomeServerIds: ['home-a', 'home-b'],
        });
        expect(queries.map(({ serverId, query }) => ({ serverId, underSessionId: query.underSessionId })))
            .toEqual([{ serverId: 'home-a', underSessionId: 'coordinator' }]);
        expect(toStoredSessionListFilter(editor)).toEqual(filter);
        expect(saved.source.picked).toEqual([]);
    });

    it('opens the shared editor with every mounted Home selected when the board names none', () => {
        expect(fromStoredSessionListFilter(normalizeSessionListFilterV1(), ['home-a', 'home-b'])).toMatchObject({
            homeServerIds: ['home-a', 'home-b'],
            searchQuery: '',
        });
        const narrowed = normalizeSessionListFilterV1({ homeServerIds: ['home-b'], scope: 'following' });
        expect(fromStoredSessionListFilter(narrowed, ['home-a', 'home-b'])).toMatchObject({ homeServerIds: ['home-b'], scope: 'following' });
    });

    it('stores the editor result as the board filter: the selection only, never UI search text', () => {
        const stored = toStoredSessionListFilter({
            ...normalizeSessionListFilterV1({ scope: 'all_accessible', attention: 'needs_my_attention', homeServerIds: ['home-a', 'home-a'] }),
            searchQuery: 'draft',
        });
        expect(stored).toEqual(normalizeSessionListFilterV1({
            scope: 'all_accessible', attention: 'needs_my_attention', homeServerIds: ['home-a'],
        }));
        expect(stored).not.toHaveProperty('searchQuery');
    });
});
