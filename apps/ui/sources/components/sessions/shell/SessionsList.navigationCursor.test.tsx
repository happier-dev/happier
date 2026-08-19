import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    readSessionNavigationCursor,
    resetSessionNavigationCursorForTests,
} from '@/sync/domains/session/navigation/sessionNavigationCursorStore';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({ pathname: '/' }));

installSessionShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: () => routeState.pathname }).module;
    },
});

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@/hooks/server/useEffectiveServerSelection', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/hooks/server/useEffectiveServerSelection')>(),
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: ['server_a'],
    }),
}));

const listViewData = vi.hoisted(() => ({
    items: null as any[] | null,
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => listViewData.items,
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

function sessionRow(sessionId: string) {
    return {
        type: 'session',
        serverId: 'server_a',
        serverName: 'Server A',
        groupKey: 'group-a',
        groupKind: 'date',
        session: {
            id: sessionId,
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadata: { path: '/tmp/project', host: 'host', homeDir: '/tmp', machineId: 'machine-1' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        },
    };
}

async function renderSessionsList(dataActive: boolean) {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(
        <SessionsList surfaceOwnership={{ ownerKey: 'phone-root', visible: true, dataActive, interactive: dataActive }} />,
    );
}

describe('SessionsList session-navigation cursor publication', () => {
    beforeEach(() => {
        resetSessionNavigationCursorForTests();
        routeState.pathname = '/';
        listViewData.items = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'group-a', serverId: 'server_a', serverName: 'Server A' },
            sessionRow('s1'),
            sessionRow('s2'),
            sessionRow('s3'),
        ];
    });

    afterEach(() => {
        standardCleanup();
    });

    it('publishes the order it renders while the surface is data-active', async () => {
        await renderSessionsList(true);

        const cursor = readSessionNavigationCursor();
        expect(cursor?.identity.origin).toBe('session-list');
        expect(cursor?.entries.map((entry) => entry.sessionKey)).toEqual([
            'server_a:s1',
            'server_a:s2',
            'server_a:s3',
        ]);
    });

    it('stops publishing once the surface goes data-inactive', async () => {
        await renderSessionsList(false);

        expect(readSessionNavigationCursor()).toBeNull();
    });
});
