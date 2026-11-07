import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/state/storage';

import { filterSessionListItemsForHeaderControls } from './sessionListFilters';

function sessionItem(
    id: string,
    metadata: NonNullable<Extract<SessionListViewItem, { type: 'session' }>['session']['metadata']>,
    overrides: Partial<Pick<Extract<SessionListViewItem, { type: 'session' }>, 'groupKey' | 'groupKind' | 'section' | 'folderId' | 'folderDepth'>> = {},
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        serverId: 'server-a',
        groupKey: overrides.groupKey ?? 'active',
        groupKind: overrides.groupKind ?? 'active',
        section: overrides.section ?? 'active',
        ...(overrides.folderId !== undefined ? { folderId: overrides.folderId } : {}),
        ...(overrides.folderDepth !== undefined ? { folderDepth: overrides.folderDepth } : {}),
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

    it('filters across groups while keeping every main section heading', () => {
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

    it('keeps main section headings that have no matches while searching', () => {
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
            inactiveHeader,
            sessionItem('gamma', {
                name: 'Old task',
                summaryText: null,
                path: '/repo/old',
                host: 'old-host',
            }, {
                groupKey: 'inactive',
                section: 'inactive',
            }),
        ], {
            searchQuery: 'active task',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Pinned',
            'Active',
            'beta',
            'Inactive',
        ]);
    });

    it('keeps server headings while searching so repeated main sections stay attributable', () => {
        const serverHeader: Extract<SessionListViewItem, { type: 'header' }> = {
            type: 'header',
            title: 'Server A',
            headerKind: 'server',
            serverId: 'server-a',
        };
        const result = filterSessionListItemsForHeaderControls([
            serverHeader,
            activeHeader,
            sessionItem('alpha', {
                name: 'Deploy fix',
                summaryText: null,
                path: '/repo/api',
                host: 'api-host',
            }),
        ], {
            searchQuery: 'nothing matches',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Server A',
            'Active',
        ]);
    });

    it('drops a project heading without matches when a later project in the same section matches', () => {
        const result = filterSessionListItemsForHeaderControls([
            inactiveHeader,
            projectHeader('Concierge'),
            sessionItem('alpha', {
                name: 'Claude stations',
                summaryText: null,
                path: '/repo/sample-project',
                host: 'host',
            }, { groupKey: 'project:Concierge', groupKind: 'project', section: 'inactive' }),
            projectHeader('Reaper'),
            sessionItem('beta', {
                name: 'MCU platform',
                summaryText: null,
                path: '/repo/reaper',
                host: 'host',
            }, { groupKey: 'project:Reaper', groupKind: 'project', section: 'inactive' }),
        ], {
            searchQuery: 'mcu',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Inactive',
            'Reaper',
            'beta',
        ]);
    });

    it('shows only the folder headings on the path to a matching session', () => {
        // Folder children are listed before the parent folder's own sessions.
        const result = filterSessionListItemsForHeaderControls([
            inactiveHeader,
            projectHeader('Concierge'),
            folderHeader('Docs', 0),
            folderHeader('Drafts', 1),
            sessionItem('draft', {
                name: 'Draft notes',
                summaryText: null,
                path: '/repo/sample-project',
                host: 'host',
            }, { groupKey: 'folder:Drafts', groupKind: 'folder', section: 'inactive', folderId: 'Drafts', folderDepth: 2 }),
            sessionItem('guide', {
                name: 'Install guide',
                summaryText: null,
                path: '/repo/sample-project',
                host: 'host',
            }, { groupKey: 'folder:Docs', groupKind: 'folder', section: 'inactive', folderId: 'Docs', folderDepth: 1 }),
            sessionItem('root', {
                name: 'Root task',
                summaryText: null,
                path: '/repo/sample-project',
                host: 'host',
            }, { groupKey: 'project:Concierge', groupKind: 'project', section: 'inactive', folderId: null, folderDepth: 0 }),
        ], {
            searchQuery: 'guide',
            selectedTags: [],
            sessionTags: {},
            searchableTextBySessionKey: {},
        });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Inactive',
            'Concierge',
            'Docs',
            'guide',
        ]);
    });
});

function projectHeader(title: string): Extract<SessionListViewItem, { type: 'header' }> {
    return {
        type: 'header',
        title,
        headerKind: 'project',
        groupKey: `project:${title}`,
        serverId: 'server-a',
    };
}

function folderHeader(title: string, depth: number): Extract<SessionListViewItem, { type: 'header' }> {
    return {
        type: 'header',
        title,
        headerKind: 'folder',
        groupKey: `folder:${title}`,
        folderId: title,
        depth,
        serverId: 'server-a',
    };
}
