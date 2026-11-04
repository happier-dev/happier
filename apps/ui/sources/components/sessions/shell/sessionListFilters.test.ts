import { describe, expect, it } from 'vitest';

import { buildSessionListIndexEntityId, buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import { filterSessionListItemsForHeaderControls, projectSessionListItemsForHeaderControls } from './sessionListFilters';

const activeHeader: Extract<SessionListIndexItem, { type: 'header' }> = {
    type: 'header',
    title: 'Active',
    headerKind: 'active',
    groupKey: 'active',
    serverId: 'server-a',
};

function sessionItem(
    sessionId: string,
    overrides: Partial<Pick<Extract<SessionListIndexItem, { type: 'session' }>, 'groupKey' | 'groupKind' | 'section'>> = {},
): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId,
        serverId: 'server-a',
        section: overrides.section ?? 'active',
        groupKey: overrides.groupKey ?? 'active',
        groupKind: overrides.groupKind ?? 'active',
    };
}

const inactiveHeader: Extract<SessionListIndexItem, { type: 'header' }> = {
    type: 'header',
    title: 'Inactive',
    headerKind: 'inactive',
    groupKey: 'inactive',
    serverId: 'server-a',
};

function key(sessionId: string): string {
    return sessionAddressKey({ serverId: 'server-a', sessionId });
}

describe('filterSessionListItemsForHeaderControls', () => {
    it('reports distinct direct Find hits without counting retained ancestors or attention copies', () => {
        const parent = sessionItem('parent');
        const child = { ...sessionItem('child'), reportsDepth: 1 };
        const mirror = { ...sessionItem('child'), occurrenceRole: 'needsYou' as const, groupKey: 'attention' };
        const items = [activeHeader, parent, child, { ...activeHeader, groupKey: 'attention', headerKind: 'attention' as const }, mirror];
        const projection = projectSessionListItemsForHeaderControls(items, {
            searchQuery: 'invoice', selectedTagIds: [], searchableTextBySessionKey: { [key('child')]: 'repair invoice' },
        });
        expect(projection.items).toEqual(items);
        expect([...projection.matchedEntityIds]).toEqual([buildSessionListIndexEntityId(child)]);
    });
    it('keeps a matching reports tree in parent order instead of ranking a child above its parent', () => {
        const items = [activeHeader, sessionItem('lead'), { ...sessionItem('step'), reportsDepth: 1 }];
        expect(filterSessionListItemsForHeaderControls(items, {
            searchQuery: 'invoice', selectedTagIds: [],
            searchableTextBySessionKey: { [key('lead')]: 'invoice planning', [key('step')]: 'invoice' },
            primarySearchableTextBySessionKey: { [key('step')]: 'invoice' },
        })).toEqual(items);
    });
    it('searches private Run metadata with a kind-qualified key and retains the parent of a matching step', () => {
        const run = { type: 'workflow_run', serverId: 'server-a', runId: 'shared-id', groupKey: 'active' } as const;
        const items = [activeHeader, sessionItem('shared-id'), run,
            { ...sessionItem('step'), reportsDepth: 1 }];
        const input = { searchQuery: 'invoice', selectedTagIds: [],
            searchableTextBySessionKey: { [key('shared-id')]: 'ordinary session', [key('step')]: 'repair invoice' },
            searchableTextByWorkflowRunKey: { [buildSessionListIndexNodeId(run)]: 'publish report' } };
        expect(filterSessionListItemsForHeaderControls(items, input)).toEqual([activeHeader, run, items[3]]);
        expect(filterSessionListItemsForHeaderControls(items, { ...input, searchQuery: 'publish' }))
            .toEqual([activeHeader, run]);
        expect(filterSessionListItemsForHeaderControls(items, { ...input, searchQuery: 'ordinary' }))
            .toEqual([activeHeader, items[1]]);
    });
    it('filters sessions by indexed search text and prunes empty headers', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            sessionItem('beta'),
        ], {
            searchQuery: 'invoice parser',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {
                [key('beta')]: 'Please repair the invoice parser regression.',
            },
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'beta',
        ]);
    });

    it('leaves no empty date header when a Recent activity search matches only one day', () => {
        const dateHeader = (title: string, groupKey: string): Extract<SessionListIndexItem, { type: 'header' }> => ({
            type: 'header',
            title,
            headerKind: 'date',
            groupKey,
            serverId: 'server-a',
        });

        const result = filterSessionListItemsForHeaderControls([
            dateHeader('Today', 'recent:day:2026-02-17'),
            sessionItem('today-a', { groupKey: 'recent:day:2026-02-17', groupKind: 'date' }),
            dateHeader('Yesterday', 'recent:day:2026-02-16'),
            sessionItem('yesterday-a', { groupKey: 'recent:day:2026-02-16', groupKind: 'date' }),
            sessionItem('yesterday-b', { groupKey: 'recent:day:2026-02-16', groupKind: 'date' }),
        ], {
            searchQuery: 'invoice parser',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {
                [key('yesterday-b')]: 'Please repair the invoice parser regression.',
            },
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Yesterday',
            'yesterday-b',
        ]);
    });

    it('keeps the Active section above the surviving date group and drops the empty one', () => {
        const dateHeader = (title: string, groupKey: string): Extract<SessionListIndexItem, { type: 'header' }> => ({
            type: 'header',
            title,
            headerKind: 'date',
            groupKey,
            serverId: 'server-a',
        });

        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            dateHeader('Today', 'active:day:2026-02-17'),
            sessionItem('today-a', { groupKey: 'active:day:2026-02-17', groupKind: 'date' }),
            dateHeader('Yesterday', 'active:day:2026-02-16'),
            sessionItem('yesterday-a', { groupKey: 'active:day:2026-02-16', groupKind: 'date' }),
            inactiveHeader,
            sessionItem('archived-a', {
                section: 'inactive',
                groupKey: 'inactive',
            }),
        ], {
            searchQuery: 'invoice parser',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {
                [key('yesterday-a')]: 'Please repair the invoice parser regression.',
            },
        });

        // The section a row belongs to is not a sibling of its date group: Active &
        // inactive must still say which section the surviving day sits in.
        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'Yesterday',
            'yesterday-a',
        ]);
    });

    it('keeps the whole ancestor chain from primary section through server and folder headers', () => {
        const serverHeader: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header',
            title: 'Home A',
            headerKind: 'server',
            groupKey: 'server:server-a',
            serverId: 'server-a',
        };
        const folderHeader = (
            title: string,
            groupKey: string,
            folderDepth: number,
        ): Extract<SessionListIndexItem, { type: 'header' }> => ({
            type: 'header',
            title,
            headerKind: 'folder',
            groupKey,
            serverId: 'server-a',
            folderDepth,
        });

        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            serverHeader,
            folderHeader('Billing', 'folder:billing', 0),
            sessionItem('billing-a', { groupKey: 'folder:billing', groupKind: 'folder' }),
            folderHeader('Invoices', 'folder:billing/invoices', 1),
            sessionItem('invoices-a', { groupKey: 'folder:billing/invoices', groupKind: 'folder' }),
        ], {
            searchQuery: 'invoice parser',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {
                [key('invoices-a')]: 'Please repair the invoice parser regression.',
            },
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'Home A',
            'Billing',
            'Invoices',
            'invoices-a',
        ]);
    });

    it('keeps a memory-matched session when local searchable text does not match', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            sessionItem('beta'),
        ], {
            searchQuery: 'vector cache',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {},
            memoryMatchedSessionKeys: new Set([key('beta')]),
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'beta',
        ]);
    });

    it('stable-partitions a grouped session run into exact, metadata, then provider-ordered transcript bands', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('transcript-second'),
            sessionItem('metadata'),
            sessionItem('exact'),
            sessionItem('transcript-first'),
        ], {
            searchQuery: 'payments',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {
                [key('metadata')]: 'release payments migration',
                [key('exact')]: 'exact\nPayments',
            },
            primarySearchableTextBySessionKey: {
                [key('exact')]: 'Payments',
            },
            memoryMatchedSessionKeys: new Set([
                key('transcript-first'),
                key('transcript-second'),
            ]),
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'exact',
            'metadata',
            'transcript-first',
            'transcript-second',
        ]);
    });

    it('keeps selected tag filters conjunctive for memory-matched sessions', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            sessionItem('beta'),
        ], {
            searchQuery: 'vector cache',
            selectedTagIds: [{ serverId: 'server-a', tagId: 'tag-release' }],
            sessionTagIdsBySessionKey: {
                [key('alpha')]: ['tag-release'],
                [key('beta')]: ['tag-later'],
            },
            searchableTextBySessionKey: {},
            memoryMatchedSessionKeys: new Set([key('beta')]),
        });

        expect(result).toEqual([]);
    });

    it('keeps sessions matching any selected tag', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            sessionItem('beta'),
        ], {
            searchQuery: '',
            selectedTagIds: [
                { serverId: 'server-a', tagId: 'tag-release' },
                { serverId: 'server-a', tagId: 'tag-billing' },
            ],
            sessionTagIdsBySessionKey: {
                [key('alpha')]: ['tag-ops'],
                [key('beta')]: ['tag-billing'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'beta',
        ]);
    });

    it('prunes a primary header when active filters match no sessions', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
        ], {
            searchQuery: '',
            selectedTagIds: [{ serverId: 'server-a', tagId: 'tag-missing' }],
            sessionTagIdsBySessionKey: {
                [key('alpha')]: ['tag-release'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result).toEqual([]);
    });

    it('filters across groups without preserving an empty controls-anchor header', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            inactiveHeader,
            sessionItem('beta', {
                section: 'inactive',
                groupKey: 'inactive',
            }),
        ], {
            searchQuery: '',
            selectedTagIds: [{ serverId: 'server-a', tagId: 'tag-later' }],
            sessionTagIdsBySessionKey: {
                [key('alpha')]: ['tag-release'],
                [key('beta')]: ['tag-later'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Inactive',
            'beta',
        ]);
    });

    it('returns no header-only remainder when nothing matches', () => {
        const pinnedHeader: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header',
            title: 'Pinned',
            headerKind: 'pinned',
            groupKey: 'pinned',
            serverId: 'server-a',
        };
        const result = filterSessionListItemsForHeaderControls([
            pinnedHeader,
            sessionItem('alpha', {
                groupKey: 'pinned',
                groupKind: 'pinned',
            }),
            activeHeader,
            sessionItem('beta'),
        ], {
            searchQuery: 'nothing matches',
            selectedTagIds: [],
            sessionTagIdsBySessionKey: {},
            searchableTextBySessionKey: {},
        });

        // The stable search chrome owns the field's lifetime, so no header is kept
        // alive purely to host it; the list-level no-results message reports zero hits.
        expect(result).toEqual([]);
    });

    it('matches the Home-local tag id rather than the label beside it', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            sessionItem('beta'),
        ], {
            searchQuery: '',
            // The selection is an opaque id; `urgent` is only what the tag reads as.
            selectedTagIds: [{ serverId: 'server-a', tagId: 'tag_01HX' }],
            sessionTagIdsBySessionKey: {
                [key('alpha')]: ['tag_01HX'],
                [key('beta')]: ['urgent'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'alpha',
        ]);
    });

    it('never lets one Home tag match another Home row that merely reads the same', () => {
        const homeBHeader: Extract<SessionListIndexItem, { type: 'header' }> = {
            type: 'header',
            title: 'Home B',
            headerKind: 'server',
            groupKey: 'server-b',
            serverId: 'server-b',
        };
        const homeBSession: Extract<SessionListIndexItem, { type: 'session' }> = {
            type: 'session',
            sessionId: 'beta',
            serverId: 'server-b',
            section: 'active',
            groupKey: 'server-b',
            groupKind: 'active',
        };

        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha'),
            homeBHeader,
            homeBSession,
        ], {
            searchQuery: '',
            // Both Homes call their tag `urgent`; only Home A's id is selected.
            selectedTagIds: [{ serverId: 'server-a', tagId: 'tag-a-1' }],
            sessionTagIdsBySessionKey: {
                [key('alpha')]: ['tag-a-1'],
                [sessionAddressKey({ serverId: 'server-b', sessionId: 'beta' })]: ['tag-b-7'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : item.runId)).toEqual([
            'Active',
            'alpha',
        ]);
    });
});
