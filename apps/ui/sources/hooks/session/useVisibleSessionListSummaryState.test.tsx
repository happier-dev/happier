import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

const summaryState = vi.hoisted(() => ({
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'srv-a',
        allowedServerIds: ['srv-a'],
        explicit: false,
        activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
    } as any,
    activeIndex: null as SessionListIndexItem[] | null,
    byServerId: {
        'srv-a': [
            {
                type: 'session',
                sessionId: 'session-1',
                storageKind: 'direct',
                serverId: 'srv-a',
                serverName: 'Server A',
            },
        ] as SessionListIndexItem[],
    },
    rowsByServerId: {
        'srv-a': {
            'session-1': {
                id: 'session-1',
                seq: 0,
                createdAt: 0,
                updatedAt: 0,
                active: false,
                activeAt: 0,
                archivedAt: null,
                pendingVersion: undefined,
                pendingCount: undefined,
                metadataVersion: 0,
                agentStateVersion: 0,
                metadata: {
                    path: '',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'codex',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'codexHome', home: 'user' },
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 0,
                owner: undefined,
                accessLevel: undefined,
                canApprovePermissions: undefined,
                hasPendingPermissionRequests: undefined,
                hasPendingUserActionRequests: undefined,
                hasUnreadMessages: false,
                keepVisibleWhenInactive: false,
            } satisfies SessionListRenderableSession,
        },
    } as Record<string, Record<string, SessionListRenderableSession>>,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListIndexByServerId: () => summaryState.byServerId,
            useSessionListRowStateByServerId: () => summaryState.rowsByServerId,
        },
    });
});

vi.mock('./useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => summaryState.selection,
}));

describe('useVisibleSessionListSummaryState', () => {
    afterEach(() => {
        standardCleanup();
        summaryState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        };
        summaryState.activeIndex = null;
        summaryState.byServerId = {
            'srv-a': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    storageKind: 'direct',
                    serverId: 'srv-a',
                    serverName: 'Server A',
                },
            ],
        };
        summaryState.rowsByServerId = {
            'srv-a': {
                'session-1': summaryState.rowsByServerId['srv-a']['session-1'],
            },
        };
    });

    it('returns the canonical summary together with the current selection', async () => {
        const { useVisibleSessionListSummaryState } = await import('./useVisibleSessionListSummaryState');
        const hook = await renderHook(() => useVisibleSessionListSummaryState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            selection: summaryState.selection,
            summary: expect.objectContaining({
                sessionsReady: true,
                sessionCount: 1,
            }),
        }));
    });
});
