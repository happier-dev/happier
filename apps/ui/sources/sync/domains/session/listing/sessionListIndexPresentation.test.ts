import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    applySessionListIndexPresentation,
    resolveSessionListSourceIndex,
    resolveVisibleSessionListIndexSummary,
} from './sessionListIndexPresentation';

function makeHeader(title: string, partial?: Partial<Extract<SessionListIndexItem, { type: 'header' }>>): SessionListIndexItem {
    return {
        type: 'header',
        title,
        ...(partial ?? {}),
    };
}

function makeSession(sessionId: string, serverId: string, serverName: string, partial?: Partial<Extract<SessionListIndexItem, { type: 'session' }>>): SessionListIndexItem {
    return {
        type: 'session',
        sessionId,
        serverId,
        serverName,
        ...(partial ?? {}),
    };
}

describe('resolveSessionListSourceIndex', () => {
    it('keeps resolved server index visible when some selected servers are still loading', () => {
        const activeIndex: SessionListIndexItem[] = [
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = resolveSessionListSourceIndex({
            enabled: true,
            activeServerId: 'server-a',
            activeIndex,
            byServerId: {
                'server-a': activeIndex,
                'server-b': null,
            },
            selectedServerIds: ['server-a', 'server-b'],
        });

        expect(result).toBe(activeIndex);
    });
});

describe('resolveVisibleSessionListIndexSummary', () => {
    it('counts sessions using the renderable resolver for direct-vs-persisted storage filters', () => {
        const index: SessionListIndexItem[] = [
            makeSession('direct-1', 'server-a', 'Server A', { storageKind: 'direct' }),
            makeSession('persisted-1', 'server-a', 'Server A', { storageKind: 'persisted' }),
        ];

        expect(resolveVisibleSessionListIndexSummary({
            enabled: false,
            activeServerId: 'server-a',
            activeIndex: index,
        }, 'direct')).toEqual({
            sessionsReady: true,
            sessionCount: 1,
        });
    });

    it('treats partially resolved selected-server sources as ready (stale-while-revalidate)', () => {
        const activeIndex: SessionListIndexItem[] = [
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = resolveVisibleSessionListIndexSummary({
            enabled: true,
            activeServerId: 'server-a',
            activeIndex,
            byServerId: {
                'server-a': activeIndex,
                'server-b': null,
            },
            selectedServerIds: ['server-a', 'server-b'],
        }, 'all');

        expect(result).toEqual({
            sessionsReady: true,
            sessionCount: 1,
        });
    });
});

describe('applySessionListIndexPresentation', () => {
    it('groups by server when concurrent grouped presentation is enabled', () => {
        const data: SessionListIndexItem[] = [
            makeHeader('Today', { headerKind: 'date' }),
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-b', 'Server B'),
            makeSession('s3', 'server-a', 'Server A'),
        ];

        const result = applySessionListIndexPresentation(data, {
            enabled: true,
            presentation: 'grouped',
        });

        expect(result.map((item) => {
            if (item.type === 'header') {
                return `header:${item.headerKind ?? 'date'}:${item.title}`;
            }
            return `session:${item.sessionId}:${item.serverId}`;
        })).toEqual([
            'header:server:Server A',
            'header:date:Today',
            'session:s1:server-a',
            'session:s3:server-a',
            'header:server:Server B',
            'session:s2:server-b',
        ]);
    });
});
