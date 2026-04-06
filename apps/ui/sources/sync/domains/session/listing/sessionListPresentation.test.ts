import { describe, expect, it } from 'vitest';
import type { SessionListViewItem } from './sessionListViewData';
import { applySessionListPresentation, resolveSessionListSourceData, resolveVisibleSessionListSummary } from './sessionListPresentation';

function makeHeader(title: string): SessionListViewItem {
    return { type: 'header', title };
}

function makeSession(id: string, serverId: string, serverName: string): SessionListViewItem {
    return {
        type: 'session',
        session: {
            id,
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: null,
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        },
        serverId,
        serverName,
    };
}

function makeDirectSession(id: string, serverId: string, serverName: string): SessionListViewItem {
    return {
        type: 'session',
        session: {
            id,
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                path: '',
                directSessionV1: { v: 1 },
            },
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        },
        serverId,
        serverName,
    };
}

describe('applySessionListPresentation', () => {
    it('returns input unchanged when concurrent mode is disabled', () => {
        const data: SessionListViewItem[] = [
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-b', 'Server B'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: false,
            presentation: 'grouped',
        });

        expect(result).toBe(data);
    });

    it('groups by server when concurrent grouped presentation is enabled', () => {
        const data: SessionListViewItem[] = [
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-b', 'Server B'),
            makeSession('s3', 'server-a', 'Server A'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'grouped',
        });

        expect(result.map((item) => {
            if (item.type === 'header') {
                return `header:${item.headerKind ?? 'date'}:${item.title}`;
            }
            if (item.type === 'session') {
                return `session:${item.session.id}:${item.serverId}`;
            }
            return 'unreachable';
        })).toEqual([
            'header:server:Server A',
            'header:date:Today',
            'session:s1:server-a',
            'session:s3:server-a',
            'header:server:Server B',
            'session:s2:server-b',
        ]);
    });

    it('removes synthetic server headers in flat-with-badge presentation', () => {
        const data: SessionListViewItem[] = [
            { type: 'header', title: 'Server A', headerKind: 'server', serverId: 'server-a', serverName: 'Server A' },
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'flat-with-badge',
        });

        expect(result.map((item) => (item.type === 'header' ? `${item.headerKind ?? 'date'}:${item.title}` : item.type))).toEqual([
            'date:Today',
            'session',
        ]);
    });

    it('returns the original array when flat-with-badge presentation has nothing to strip', () => {
        const data: SessionListViewItem[] = [
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'flat-with-badge',
        });

        expect(result).toBe(data);
    });

    it('returns the original array when grouped presentation has a single visible server and nothing to regroup', () => {
        const data: SessionListViewItem[] = [
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'grouped',
        });

        expect(result).toBe(data);
    });

    it('returns the original array when grouped presentation is already canonical', () => {
        const data: SessionListViewItem[] = [
            { type: 'header', title: 'Server A', headerKind: 'server', serverId: 'server-a', serverName: 'Server A' },
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-a', 'Server A'),
            { type: 'header', title: 'Server B', headerKind: 'server', serverId: 'server-b', serverName: 'Server B' },
            makeSession('s3', 'server-b', 'Server B'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'grouped',
        });

        expect(result).toBe(data);
    });

    it('returns the original array when grouped presentation selection already covers every visible server', () => {
        const data: SessionListViewItem[] = [
            { type: 'header', title: 'Server A', headerKind: 'server', serverId: 'server-a', serverName: 'Server A' },
            makeSession('s1', 'server-a', 'Server A'),
            { type: 'header', title: 'Server B', headerKind: 'server', serverId: 'server-b', serverName: 'Server B' },
            makeSession('s2', 'server-b', 'Server B'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'grouped',
            selectedServerIds: ['server-a', 'server-b'],
        });

        expect(result).toBe(data);
    });

    it('filters list rows by selected server ids when provided', () => {
        const data: SessionListViewItem[] = [
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-b', 'Server B'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'flat-with-badge',
            selectedServerIds: ['server-b'],
        });

        expect(result.map((item) => (item.type === 'session' ? item.session.id : item.type))).toEqual(['s2']);
    });

    it('returns the original array when flat-with-badge selection already covers every visible server', () => {
        const data: SessionListViewItem[] = [
            makeHeader('Today'),
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-b', 'Server B'),
        ];

        const result = applySessionListPresentation(data, {
            enabled: true,
            presentation: 'flat-with-badge',
            selectedServerIds: ['server-a', 'server-b'],
        });

        expect(result).toBe(data);
    });
});
