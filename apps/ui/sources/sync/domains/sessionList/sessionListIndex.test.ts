import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '../session/listing/sessionListRenderable';
import type { SessionListViewItem } from '../session/listing/sessionListViewData';
import { buildSessionListIndexFromViewData, buildSessionListIndexNodeId } from './sessionListIndex';

function makeRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
    };
}

describe('buildSessionListIndexFromViewData', () => {
    it('builds stable node ids without relying on item index', () => {
        const sessionNodeId = buildSessionListIndexNodeId({
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
        });
        expect(sessionNodeId).toBe(buildSessionListIndexNodeId({
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
        }));

        const headerNodeId = buildSessionListIndexNodeId({
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            serverId: 'server-a',
            serverName: 'Server A',
        });
        expect(headerNodeId).toBe(buildSessionListIndexNodeId({
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            serverId: 'server-a',
            serverName: 'Server A',
        }));
    });

    it('reuses the previous index reference when inputs are semantically identical', () => {
        const session = makeRenderable('s1');
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1' },
            {
                type: 'session',
                session,
                serverId: 'server-a',
                serverName: 'Server A',
                section: 'active',
                groupKey: 'g1',
                groupKind: 'date',
            },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            { ...viewData[0] },
            { ...(viewData[1] as Extract<SessionListViewItem, { type: 'session' }>) },
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).toBe(first);
    });

    it('reuses unchanged session index items even when the list order changes', () => {
        const s1 = makeRenderable('s1');
        const s2 = makeRenderable('s2');
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1' },
            { type: 'session', session: s1, serverId: 'server-a', serverName: 'Server A', groupKey: 'g1', groupKind: 'date' },
            { type: 'session', session: s2, serverId: 'server-a', serverName: 'Server A', groupKey: 'g1', groupKind: 'date' },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            viewData[0],
            viewData[2] as Extract<SessionListViewItem, { type: 'session' }>,
            viewData[1] as Extract<SessionListViewItem, { type: 'session' }>,
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).not.toBeNull();

        const firstS1 = (first ?? []).find((item) => item.type === 'session' && item.sessionId === 's1');
        const secondS1 = (second ?? []).find((item) => item.type === 'session' && item.sessionId === 's1');
        expect(secondS1).toBe(firstS1);
    });

    it('reuses unchanged header index items even when their position changes', () => {
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'day:today', serverId: 'server-a', serverName: 'Server A' },
            { type: 'header', title: 'Earlier', headerKind: 'date', groupKey: 'day:earlier', serverId: 'server-a', serverName: 'Server A' },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            viewData[1],
            viewData[0],
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).not.toBeNull();

        const firstHeader = (first ?? []).find((item) => item.type === 'header' && item.title === 'Today');
        const secondHeader = (second ?? []).find((item) => item.type === 'header' && item.title === 'Today');
        expect(secondHeader).toBe(firstHeader);
    });
});
