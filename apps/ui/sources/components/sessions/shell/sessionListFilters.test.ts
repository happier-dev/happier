import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/state/storage';

import { filterSessionListItemsForHeaderControls } from './sessionListFilters';

function sessionItem(
    id: string,
    metadata: NonNullable<Extract<SessionListViewItem, { type: 'session' }>['session']['metadata']>,
    overrides: Partial<Pick<Extract<SessionListViewItem, { type: 'session' }>, 'groupKey' | 'groupKind' | 'section'>> = {},
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        serverId: 'server-a',
        groupKey: overrides.groupKey ?? 'active',
        groupKind: overrides.groupKind ?? 'active',
        section: overrides.section ?? 'active',
        session: {
            id,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        },
    };
}

const activeHeader: Extract<SessionListViewItem, { type: 'header' }> = {
    type: 'header',
    title: 'Active',
    headerKind: 'active',
    groupKey: 'active',
    serverId: 'server-a',
};

const inactiveHeader: Extract<SessionListViewItem, { type: 'header' }> = {
    type: 'header',
    title: 'Inactive',
    headerKind: 'inactive',
    groupKey: 'inactive',
    serverId: 'server-a',
};

describe('filterSessionListItemsForHeaderControls', () => {
    it('filters sessions by metadata and prunes empty headers', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: 'Production release',
                path: '/repo/api',
                host: 'api-host',
            }),
            sessionItem('beta', {
                name: 'Draft docs',
                summaryText: 'Readme pass',
                path: '/repo/docs',
                host: 'docs-host',
            }),
        ], {
            searchQuery: 'production',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'alpha',
        ]);
    });

    it('finds a session by its pasted session id', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('cmabc123XYZ', { name: 'Deploy fix', summaryText: null, path: '/repo/api', host: 'api-host' }),
            sessionItem('cmdef456', { name: 'Draft docs', summaryText: null, path: '/repo/docs', host: 'docs-host' }),
        ], {
            searchQuery: '  cmABC123xyz ',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'cmabc123XYZ',
        ]);
    });

    it('includes only the project and parent folder of a matching row', () => {
        const project = (title: string) => ({ type: 'header', headerKind: 'project', title } as const);
        const folder = (title: string, depth: number) => ({ type: 'header', headerKind: 'folder', title, depth } as const);
        const row = (id: string, name: string, folderDepth: number) => ({
            ...sessionItem(id, { name, path: '/repo', host: 'host' }), folderDepth,
        });

        expect(filterSessionListItemsForHeaderControls([
            activeHeader,
            project('Unrelated project'),
            row('unrelated', 'Other work', 0),
            project('Matching project'),
            folder('Parent folder', 0),
            folder('Unrelated child', 1),
            row('child', 'Draft notes', 2),
            row('parent', 'Install guide', 1),
        ], {
            searchQuery: 'guide', selectedTags: [], sessionTags: {}, searchableTextBySessionKey: {},
        }).map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active', 'Matching project', 'Parent folder', 'parent',
        ]);
    });

    it('filters sessions by decrypted text already present in the store', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
            sessionItem('beta', {
                name: 'Draft docs',
                summaryText: null,
                path: '/repo/docs',
                host: 'docs-host',
            }),
        ], {
            searchQuery: 'invoice parser',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {
                'server-a:beta': 'Please repair the invoice parser regression.',
            },
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'beta',
        ]);
    });

    it('keeps a memory-matched session when local searchable text does not match', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
            sessionItem('beta', {
                name: 'Draft docs',
                summaryText: null,
                path: '/repo/docs',
                host: 'docs-host',
            }),
        ], {
            searchQuery: 'vector cache',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
            memoryMatchedSessionKeys: new Set(['server-a:beta']),
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'beta',
        ]);
    });

    it('keeps non-query filters conjunctive for memory-matched sessions', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
            sessionItem('beta', {
                name: 'Draft docs',
                summaryText: null,
                path: '/repo/docs',
                host: 'docs-host',
            }),
        ], {
            searchQuery: 'vector cache',
            selectedTags: ['release'],
            sessionTags: {
                'server-a:alpha': ['release'],
                'server-a:beta': ['later'],
            },
            searchableTextBySessionKey: {},
            memoryMatchedSessionKeys: new Set(['server-a:beta']),
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
        ]);
    });

    it('keeps sessions that match any selected tag', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
            sessionItem('beta', {
                name: 'Draft docs',
                summaryText: null,
                path: '/repo/docs',
                host: 'docs-host',
            }),
        ], {
            searchQuery: '',
            selectedTags: ['release', 'billing'],
            sessionTags: {
                'server-a:alpha': ['ops'],
                'server-a:beta': ['billing'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'beta',
        ]);
    });

    it('keeps a primary header when active filters match no sessions', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
        ], {
            searchQuery: '',
            selectedTags: ['missing'],
            sessionTags: {
                'server-a:alpha': ['release'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
        ]);
    });

    it('filters across groups while preserving the first primary header as the controls anchor', () => {
        const result = filterSessionListItemsForHeaderControls([
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
            inactiveHeader,
            sessionItem('beta', {
                name: 'Draft docs',
                summaryText: null,
                path: '/repo/docs',
                host: 'docs-host',
            }, {
                groupKey: 'inactive',
                section: 'inactive',
            }),
        ], {
            searchQuery: '',
            selectedTags: ['later'],
            sessionTags: {
                'server-a:alpha': ['release'],
                'server-a:beta': ['later'],
            },
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'Inactive',
            'beta',
        ]);
    });

    it('preserves the active controls anchor header instead of the first primary header', () => {
        const pinnedHeader: Extract<SessionListViewItem, { type: 'header' }> = {
            type: 'header',
            title: 'Pinned',
            headerKind: 'pinned',
            groupKey: 'pinned',
            serverId: 'server-a',
        };
        const result = filterSessionListItemsForHeaderControls([
            pinnedHeader,
            sessionItem('alpha', {
                name: 'Pinned task',
                summaryText: null,
                path: '/repo/pinned',
                host: 'pinned-host',
            }, {
                groupKey: 'pinned',
                groupKind: 'pinned',
            }),
            activeHeader,
            sessionItem('beta', {
                name: 'Active task',
                summaryText: null,
                path: '/repo/active',
                host: 'active-host',
            }),
        ], {
            searchQuery: 'nothing matches',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
            controlsAnchorKey: 'active',
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
        ]);
    });
});
