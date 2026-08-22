import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    readSessionNavigationCursor,
    resetSessionNavigationCursorForTests,
} from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/' }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

// The rows are the list's presentation, not its order. Ordering, capture and the step
// decision are what this suite is about, so the row tree is stubbed while the real
// view state, the real ordering owner and the real cursor store all run.
vi.mock('./sessionListVirtualizedContent', () => ({
    SessionListVirtualizedContent: () => null,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => null,
    useAuth: () => ({ refreshFromActiveServer: async () => undefined }),
}));

function sessionRow(sessionId: string): SessionListIndexItem {
    return {
        type: 'session',
        sessionId,
        serverId: 'server_a',
        groupKey: 'group-a',
        groupKind: 'date',
    };
}

function buildPaneState(items: readonly SessionListIndexItem[]): VisibleSessionListPaneState {
    return {
        summary: { sessionsReady: true, sessionCount: items.filter((item) => item.type === 'session').length },
        visibleSessionListIndex: items,
        hasHiddenInactiveSessions: false,
        folderFocus: null,
        showLoading: false,
        showEmptyState: false,
    };
}

const ORDERED_LIST: readonly SessionListIndexItem[] = [
    { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'group-a', serverId: 'server_a' },
    sessionRow('s1'),
    sessionRow('s2'),
    sessionRow('s3'),
];

/**
 * Renders the list surface and, beside it, the cockpit's step decision for one session —
 * the two ends of the corridor. Nothing between them is stubbed, so this fails if the
 * surface stops publishing, if the published rows stop matching the rendered ones, or if
 * the reader stops resolving an anchor inside them.
 */
async function renderListAndNeighbours(params: Readonly<{
    items: readonly SessionListIndexItem[];
    dataActive: boolean;
    anchorSessionId: string;
}>) {
    const { SessionsListView } = await import('./SessionsList');
    const { useSessionCockpitLateralNavigation } = await import(
        '@/components/navigation/mobile/chrome/lateralSwipe/useSessionCockpitLateralNavigation'
    );

    const observed: { previous: string | null; next: string | null } = { previous: null, next: null };
    function NeighbourProbe() {
        const navigation = useSessionCockpitLateralNavigation({
            sessionId: params.anchorSessionId,
            serverId: 'server_a',
        });
        observed.previous = navigation.previous?.sessionId ?? null;
        observed.next = navigation.next?.sessionId ?? null;
        return null;
    }

    const screen = await renderScreen(
        <>
            <SessionsListView
                storageKind="all"
                paneState={buildPaneState(params.items)}
                pathname="/"
                surfaceOwnership={{
                    ownerKey: 'phone-root',
                    visible: true,
                    dataActive: params.dataActive,
                    interactive: params.dataActive,
                }}
            />
            <NeighbourProbe />
        </>,
    );
    return { observed, screen };
}

describe('SessionsList session-navigation cursor publication', () => {
    beforeEach(() => {
        resetSessionNavigationCursorForTests();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('publishes the order it renders while the surface is data-active', async () => {
        await renderListAndNeighbours({ items: ORDERED_LIST, dataActive: true, anchorSessionId: 's2' });

        const cursor = readSessionNavigationCursor();
        expect(cursor?.identity.origin).toBe('session-list');
        expect(cursor?.entries.map((entry) => entry.sessionKey)).toEqual([
            'server_a:s1',
            'server_a:s2',
            'server_a:s3',
        ]);
    });

    it('resolves the cockpit step to the sessions either side of the open one', async () => {
        const { observed } = await renderListAndNeighbours({
            items: ORDERED_LIST,
            dataActive: true,
            anchorSessionId: 's2',
        });

        expect(observed.previous).toBe('s1');
        expect(observed.next).toBe('s3');
    });

    it('clamps at the ends of the captured order instead of wrapping', async () => {
        const { observed } = await renderListAndNeighbours({
            items: ORDERED_LIST,
            dataActive: true,
            anchorSessionId: 's1',
        });

        expect(observed.previous).toBeNull();
        expect(observed.next).toBe('s2');
    });

    it('stops publishing once the surface goes data-inactive', async () => {
        await renderListAndNeighbours({ items: ORDERED_LIST, dataActive: false, anchorSessionId: 's2' });

        expect(readSessionNavigationCursor()).toBeNull();
    });
});
