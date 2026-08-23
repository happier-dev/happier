import { afterEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import type { SessionListIndexItem } from './sessionListIndex';
import type { SessionListAttentionPromotionOptions } from './attentionPromotion/sessionListAttentionPromotion';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';
import { PINNED_GROUP_KEY_V1 } from './sessionListOrderingStateV1';
import { SESSION_LIST_WORKING_RETENTION_LIMIT_MS } from './placement/sessionListWorkingRetention';

function makeSessionRow(
    id: string,
    partial?: Partial<SessionListRenderableSession>,
): SessionListRenderableSession {
    return {
        id,
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
        metadata: null,
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
        ...(partial ?? {}),
    };
}

function makeResolver(rowsByKey: Record<string, SessionListRenderableSession>) {
    return (serverId: string | null | undefined, sessionId: string) => {
        const key = `${String(serverId ?? '').trim()}:${String(sessionId ?? '').trim()}`;
        return rowsByKey[key] ?? null;
    };
}

function makeIterableCountingSource(
    items: ReadonlyArray<SessionListIndexItem>,
): SessionListIndexItem[] & { readonly iterationCount: number } {
    let iterationCount = 0;
    const source = [...items] as SessionListIndexItem[] & { readonly iterationCount: number };
    Object.defineProperty(source, 'iterationCount', {
        get: () => iterationCount,
    });
    Object.defineProperty(source, Symbol.iterator, {
        value: function* iterateSource() {
            for (let index = 0; index < source.length; index += 1) {
                iterationCount += 1;
                yield source[index]!;
            }
        },
    });
    return source;
}

describe('computeVisibleSessionListIndex', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('returns the original array when custom ordering inputs are no-ops', () => {
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 20 }),
                's1:b': makeSessionRow('b', { createdAt: 20, updatedAt: 30 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: [] },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
    });

    it('uses the normalized organization projection instead of legacy pin and order inputs', () => {
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'org-pinned', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'org-first', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'legacy-pinned', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:org-pinned': makeSessionRow('org-pinned', { createdAt: 10, updatedAt: 10 }),
                's1:org-first': makeSessionRow('org-first', { createdAt: 20, updatedAt: 20 }),
                's1:legacy-pinned': makeSessionRow('legacy-pinned', { createdAt: 30, updatedAt: 30 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:legacy-pinned'],
            sessionListGroupOrderV1: { [groupKey]: ['s1:legacy-pinned'] },
            normalizedOrganizationProjection: {
                pinnedSessionKeys: ['s1:org-pinned'],
                sessionListGroupOrder: {
                    [groupKey]: ['s1:org-first', 's1:legacy-pinned'],
                },
                sessionWorkspaceOrder: {},
            },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'session' ? item.sessionId : `${item.headerKind}:${item.title}`)).toEqual([
            'pinned:Pinned',
            'org-pinned',
            'active:Active',
            'project:~/repo',
            'org-first',
            'legacy-pinned',
        ]);
    });

    it('records numeric ordering metadata when telemetry is enabled', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const dateGroupKey = 'server:s1:day:2026-02-17';
        const projectGroupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroupKey },
            { type: 'session', sessionId: 'date-a', serverId: 's1', section: 'inactive', groupKey: dateGroupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'date-b', serverId: 's1', section: 'inactive', groupKey: dateGroupKey, groupKind: 'date' },
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            { type: 'session', sessionId: 'project-a', serverId: 's1', section: 'active', groupKey: projectGroupKey, groupKind: 'project' },
        ];

        computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:date-a': makeSessionRow('date-a', { createdAt: 10, updatedAt: 10, meaningfulActivityAt: 300_000 }),
                's1:date-b': makeSessionRow('date-b', { createdAt: 20, updatedAt: 20, meaningfulActivityAt: 600_000 }),
                's1:project-a': makeSessionRow('project-a', { createdAt: 30, updatedAt: 30 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'created',
            sessionListFolderSortModeV1: 'mixed',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((candidate) => candidate.name === 'sync.sessions.list.visible.compute');

        expect(event?.fields).toMatchObject({
            orderingMode: 1,
            effectiveFolderSortMode: 0,
            effectiveModeOverrides: 1,
            bucketSortApplied: 1,
        });
        expect(Object.values(event?.fields ?? {}).every((value) => typeof value === 'number')).toBe(true);
    });

    it('records missing pinned keys and visible placeholder rows in compute telemetry', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'pinned-present', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'visible-placeholder', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:pinned-present': makeSessionRow('pinned-present', {
                    createdAt: 10,
                    updatedAt: 20,
                    metadata: { path: '/repo' },
                }),
                's1:visible-placeholder': makeSessionRow('visible-placeholder', {
                    createdAt: 20,
                    updatedAt: 30,
                    metadata: null,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-present', 's1:pinned-missing'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((candidate) => candidate.name === 'sync.sessions.list.visible.compute');

        expect(event?.fields).toMatchObject({
            missingPinnedSessionKeys: 1,
            visiblePlaceholderRows: 1,
        });
    });

    it('records visible placeholder rows when the projection returns the no-op source', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'visible-placeholder', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:visible-placeholder': makeSessionRow('visible-placeholder', {
                    metadata: null,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((candidate) => candidate.name === 'sync.sessions.list.visible.compute');

        expect(event?.fields).toMatchObject({
            missingPinnedSessionKeys: 0,
            visiblePlaceholderRows: 1,
        });
    });

    it('records telemetry without adding a source rescan', () => {
        const groupKey = 'server:s1:active:project:repo';
        const baseSource: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];
        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 20, updatedAt: 20, meaningfulActivityAt: 20 }),
            's1:b': makeSessionRow('b', { createdAt: 10, updatedAt: 10, meaningfulActivityAt: 10 }),
        });
        const commonParams = {
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'created' as const,
            sessionListFolderSortModeV1: 'foldersFirst' as const,
            presentation: { enabled: false, presentation: 'grouped' as const, selectedServerIds: [] },
        };

        const disabledSource = makeIterableCountingSource(baseSource);
        syncPerformanceTelemetry.configure({ enabled: false });
        computeVisibleSessionListIndex({
            ...commonParams,
            source: disabledSource,
        });
        const disabledIterationCount = disabledSource.iterationCount;

        const enabledSource = makeIterableCountingSource(baseSource);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        computeVisibleSessionListIndex({
            ...commonParams,
            source: enabledSource,
        });

        expect(enabledSource.iterationCount).toBe(disabledIterationCount);
    });

    it('orders sessions by bucketed meaningful activity when ordering mode is updated', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'd', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'c', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 900_000, meaningfulActivityAt: 300_000 }),
                's1:b': makeSessionRow('b', { createdAt: 30, updatedAt: 100, meaningfulActivityAt: 900_000 }),
                's1:c': makeSessionRow('c', { createdAt: 20, updatedAt: 100, meaningfulActivityAt: 900_000 }),
                's1:d': makeSessionRow('d', { createdAt: 20, updatedAt: 100, meaningfulActivityAt: 900_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:c', 's1:b'] },
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['b', 'c', 'd', 'a']);
    });

    it('keeps updated ordering stable for meaningful activity changes inside the same bucket', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'newer-created', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'older-created', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newer-created': makeSessionRow('newer-created', { createdAt: 2_000, updatedAt: 1, meaningfulActivityAt: 1 }),
                's1:older-created': makeSessionRow('older-created', { createdAt: 1_000, updatedAt: 299_000, meaningfulActivityAt: 299_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
    });

    it('reorders updated sessions when meaningful activity crosses a bucket boundary', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'newer-created', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'older-created-active', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newer-created': makeSessionRow('newer-created', { createdAt: 2_000, updatedAt: 20, meaningfulActivityAt: 1 }),
                's1:older-created-active': makeSessionRow('older-created-active', { createdAt: 1_000, updatedAt: 10, meaningfulActivityAt: 300_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['older-created-active', 'newer-created']);
    });

    it('uses updated ordering for inactive date groups even when user ordering mode is custom', () => {
        const groupKey = 'server:s1:inactive:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'oldest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'newest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'middle', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newest': makeSessionRow('newest', { createdAt: 30, meaningfulActivityAt: 900_000 }),
                's1:middle': makeSessionRow('middle', { createdAt: 20, meaningfulActivityAt: 600_000 }),
                's1:oldest': makeSessionRow('oldest', { createdAt: 10, meaningfulActivityAt: 300_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:oldest', 's1:newest', 's1:middle'] },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('does not force updated ordering for date groups in the unified sessions section', () => {
        const groupKey = 'server:s1:sessions:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'oldest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'newest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newest': makeSessionRow('newest', { createdAt: 20, meaningfulActivityAt: 600_000 }),
                's1:oldest': makeSessionRow('oldest', { createdAt: 10, meaningfulActivityAt: 300_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
    });

    it('applies custom ordering to inactive date rows in the unified sessions section', () => {
        const groupKey = 'server:s1:sessions:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'newest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'oldest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newest': makeSessionRow('newest', { createdAt: 20, meaningfulActivityAt: 600_000 }),
                's1:oldest': makeSessionRow('oldest', { createdAt: 10, meaningfulActivityAt: 300_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:oldest', 's1:newest'] },
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['oldest', 'newest']);
    });

    it('keeps new sessions before stale custom group order entries', () => {
        const groupKey = 'server:s1:active:project:abc123';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'new-session', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'older-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'older-b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:new-session': makeSessionRow('new-session', { createdAt: 300, updatedAt: 300, active: true }),
                's1:older-a': makeSessionRow('older-a', { createdAt: 200, updatedAt: 200, active: true }),
                's1:older-b': makeSessionRow('older-b', { createdAt: 100, updatedAt: 100, active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older-b', 's1:older-a'] },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['new-session', 'older-b', 'older-a']);
    });

    it('applies mixed folder and session ordering inside a workspace root project group', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const planningFolderGroupKey = `${projectGroupKey}:folder:planning`;
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: planningFolderGroupKey,
                groupKind: 'folder',
                folderId: 'planning',
                folderDepth: 1,
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: projectGroupKey,
                groupKind: 'project',
                folderId: null,
                folderDepth: 0,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:in-folder': makeSessionRow('in-folder', { active: true }),
                's1:at-root': makeSessionRow('at-root', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [projectGroupKey]: ['s1:at-root', 'folder:planning'] },
            sessionListOrderingModeV1: 'custom',
            sessionListFolderSortModeV1: 'mixed',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            's:at-root',
            'h:folder:Planning',
            's:in-folder',
        ]);
    });

    it('applies section-agnostic workspace ordering within each visible activity section', () => {
        const activeAlpha = 'server:s1:project:alpha';
        const activeBeta = 'server:s1:project:beta';
        const inactiveAlpha = 'server:s1:project:alpha';
        const inactiveBeta = 'server:s1:project:beta';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: activeAlpha, workspaceKey: 'workspace-alpha' },
            { type: 'session', sessionId: 'active-alpha', serverId: 's1', section: 'active', groupKey: activeAlpha, groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Beta', serverId: 's1', groupKey: activeBeta, workspaceKey: 'workspace-beta' },
            { type: 'session', sessionId: 'active-beta', serverId: 's1', section: 'active', groupKey: activeBeta, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: inactiveAlpha, workspaceKey: 'workspace-alpha' },
            { type: 'session', sessionId: 'inactive-alpha', serverId: 's1', section: 'inactive', groupKey: inactiveAlpha, groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Beta', serverId: 's1', groupKey: inactiveBeta, workspaceKey: 'workspace-beta' },
            { type: 'session', sessionId: 'inactive-beta', serverId: 's1', section: 'inactive', groupKey: inactiveBeta, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-alpha': makeSessionRow('active-alpha', { active: true }),
                's1:active-beta': makeSessionRow('active-beta', { active: true }),
                's1:inactive-alpha': makeSessionRow('inactive-alpha'),
                's1:inactive-beta': makeSessionRow('inactive-beta'),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {
                'server:s1:workspaces': ['workspace:workspace-beta', 'workspace:workspace-alpha'],
            },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        )).toEqual([
            'h:active:Active',
            'h:project:Beta',
            's:active-beta',
            'h:project:Alpha',
            's:active-alpha',
            'h:inactive:Inactive',
            'h:project:Beta',
            's:inactive-beta',
            'h:project:Alpha',
            's:inactive-alpha',
        ]);
    });

    it('preserves workspace structural order when date ordering is active', () => {
        const activeAlpha = 'server:s1:project:alpha';
        const activeBeta = 'server:s1:project:beta';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: activeAlpha, workspaceKey: 'workspace-alpha' },
            { type: 'session', sessionId: 'active-alpha', serverId: 's1', section: 'active', groupKey: activeAlpha, groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Beta', serverId: 's1', groupKey: activeBeta, workspaceKey: 'workspace-beta' },
            { type: 'session', sessionId: 'active-beta', serverId: 's1', section: 'active', groupKey: activeBeta, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-alpha': makeSessionRow('active-alpha', { createdAt: 10, meaningfulActivityAt: 10 }),
                's1:active-beta': makeSessionRow('active-beta', { createdAt: 20, meaningfulActivityAt: 20 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {
                'server:s1:workspaces': ['workspace:workspace-beta', 'workspace:workspace-alpha'],
            },
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        )).toEqual([
            'h:active:Active',
            'h:project:Beta',
            's:active-beta',
            'h:project:Alpha',
            's:active-alpha',
        ]);
    });

    it('keeps date ordering scoped to each activity section for repeated project groups', () => {
        const projectGroupKey = 'server:s1:project:alpha';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: projectGroupKey },
            { type: 'session', sessionId: 'active-old', serverId: 's1', section: 'active', groupKey: projectGroupKey, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: projectGroupKey },
            { type: 'session', sessionId: 'inactive-new', serverId: 's1', section: 'inactive', groupKey: projectGroupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-old': makeSessionRow('active-old', { createdAt: 10, meaningfulActivityAt: 10 }),
                's1:inactive-new': makeSessionRow('inactive-new', { createdAt: 20, meaningfulActivityAt: 900_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section}`
        )).toEqual([
            'h:active:Active',
            'h:project:Alpha',
            's:active-old:active',
            'h:inactive:Inactive',
            'h:project:Alpha',
            's:inactive-new:inactive',
        ]);
    });

    it('uses explicit single-section mode for custom ordering in project groups without sessions marker', () => {
        const projectGroupKey = 'server:s1:project:alpha';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: projectGroupKey },
            { type: 'session', sessionId: 'active-session', serverId: 's1', section: 'active', groupKey: projectGroupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive-session', serverId: 's1', section: 'inactive', groupKey: projectGroupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-session': makeSessionRow('active-session', { active: true, createdAt: 10 }),
                's1:inactive-session': makeSessionRow('inactive-session', { active: false, createdAt: 20 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [projectGroupKey]: ['s1:inactive-session', 's1:active-session'] },
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section}`
        )).toEqual([
            'h:sessions:Sessions',
            'h:project:Alpha',
            's:inactive-session:inactive',
            's:active-session:active',
        ]);
    });

    it('uses explicit single-section mode for updated ordering in project groups without sessions marker', () => {
        const projectGroupKey = 'server:s1:project:alpha';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: projectGroupKey },
            { type: 'session', sessionId: 'active-old', serverId: 's1', section: 'active', groupKey: projectGroupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive-new', serverId: 's1', section: 'inactive', groupKey: projectGroupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-old': makeSessionRow('active-old', { active: true, createdAt: 10, meaningfulActivityAt: 10 }),
                's1:inactive-new': makeSessionRow('inactive-new', { active: false, createdAt: 20, meaningfulActivityAt: 900_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated',
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section}`
        )).toEqual([
            'h:sessions:Sessions',
            'h:project:Alpha',
            's:inactive-new:inactive',
            's:active-old:active',
        ]);
    });

    it('preserves folder structural order and forces folders first when date ordering is active', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const alphaFolderGroupKey = `${projectGroupKey}:folder:alpha`;
        const betaFolderGroupKey = `${projectGroupKey}:folder:beta`;
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Alpha',
                serverId: 's1',
                groupKey: alphaFolderGroupKey,
                folderId: 'alpha',
                folderDepth: 0,
                workspace,
            },
            { type: 'session', sessionId: 'alpha-session', serverId: 's1', section: 'active', groupKey: alphaFolderGroupKey, groupKind: 'folder', folderId: 'alpha', folderDepth: 1 },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Beta',
                serverId: 's1',
                groupKey: betaFolderGroupKey,
                folderId: 'beta',
                folderDepth: 0,
                workspace,
            },
            { type: 'session', sessionId: 'beta-session', serverId: 's1', section: 'active', groupKey: betaFolderGroupKey, groupKind: 'folder', folderId: 'beta', folderDepth: 1 },
            { type: 'session', sessionId: 'root-session', serverId: 's1', section: 'active', groupKey: projectGroupKey, groupKind: 'project', folderId: null, folderDepth: 0 },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:alpha-session': makeSessionRow('alpha-session', { createdAt: 30, meaningfulActivityAt: 30 }),
                's1:beta-session': makeSessionRow('beta-session', { createdAt: 20, meaningfulActivityAt: 20 }),
                's1:root-session': makeSessionRow('root-session', { createdAt: 10, meaningfulActivityAt: 10 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {
                [projectGroupKey]: ['s1:root-session', 'folder:beta', 'folder:alpha'],
            },
            sessionListOrderingModeV1: 'updated',
            sessionListFolderSortModeV1: 'mixed',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            'h:folder:Beta',
            's:beta-session',
            'h:folder:Alpha',
            's:alpha-session',
            's:root-session',
        ]);
    });

    it('keeps folder structural order scoped to each activity section for repeated project groups', () => {
        const projectGroupKey = 'server:s1:project:abc123';
        const alphaFolderGroupKey = `${projectGroupKey}:folder:alpha`;
        const betaFolderGroupKey = `${projectGroupKey}:folder:beta`;
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const makeFolderHeader = (
            title: string,
            folderId: string,
            groupKey: string,
        ): SessionListIndexItem => ({
            type: 'header',
            headerKind: 'folder',
            title,
            serverId: 's1',
            groupKey,
            folderId,
            folderDepth: 0,
            workspace,
        });
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: projectGroupKey },
            makeFolderHeader('Alpha folder', 'alpha', alphaFolderGroupKey),
            { type: 'session', sessionId: 'active-alpha', serverId: 's1', section: 'active', groupKey: alphaFolderGroupKey, groupKind: 'folder', folderId: 'alpha', folderDepth: 1 },
            makeFolderHeader('Beta folder', 'beta', betaFolderGroupKey),
            { type: 'session', sessionId: 'active-beta', serverId: 's1', section: 'active', groupKey: betaFolderGroupKey, groupKind: 'folder', folderId: 'beta', folderDepth: 1 },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Alpha', serverId: 's1', groupKey: projectGroupKey },
            makeFolderHeader('Alpha folder', 'alpha', alphaFolderGroupKey),
            { type: 'session', sessionId: 'inactive-alpha', serverId: 's1', section: 'inactive', groupKey: alphaFolderGroupKey, groupKind: 'folder', folderId: 'alpha', folderDepth: 1 },
            makeFolderHeader('Beta folder', 'beta', betaFolderGroupKey),
            { type: 'session', sessionId: 'inactive-beta', serverId: 's1', section: 'inactive', groupKey: betaFolderGroupKey, groupKind: 'folder', folderId: 'beta', folderDepth: 1 },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-alpha': makeSessionRow('active-alpha', { createdAt: 10, meaningfulActivityAt: 10 }),
                's1:active-beta': makeSessionRow('active-beta', { createdAt: 20, meaningfulActivityAt: 20 }),
                's1:inactive-alpha': makeSessionRow('inactive-alpha', { createdAt: 30, meaningfulActivityAt: 30 }),
                's1:inactive-beta': makeSessionRow('inactive-beta', { createdAt: 40, meaningfulActivityAt: 40 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [projectGroupKey]: ['folder:beta', 'folder:alpha'] },
            sessionListOrderingModeV1: 'updated',
            sessionListFolderSortModeV1: 'mixed',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.map((item) => item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section}`
        )).toEqual([
            'h:active:Active',
            'h:project:Alpha',
            'h:folder:Beta folder',
            's:active-beta:active',
            'h:folder:Alpha folder',
            's:active-alpha:active',
            'h:inactive:Inactive',
            'h:project:Alpha',
            'h:folder:Beta folder',
            's:inactive-beta:inactive',
            'h:folder:Alpha folder',
            's:inactive-alpha:inactive',
        ]);
    });

    it('keeps child folders before direct sessions by default inside a folder', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const planningFolderGroupKey = `${projectGroupKey}:folder:planning`;
        const childFolderGroupKey = `${projectGroupKey}:folder:child`;
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Child',
                serverId: 's1',
                groupKey: childFolderGroupKey,
                folderId: 'child',
                folderDepth: 1,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'child-session',
                serverId: 's1',
                section: 'active',
                groupKey: childFolderGroupKey,
                groupKind: 'folder',
                folderId: 'child',
                folderDepth: 2,
            },
            {
                type: 'session',
                sessionId: 'direct-session',
                serverId: 's1',
                section: 'active',
                groupKey: planningFolderGroupKey,
                groupKind: 'folder',
                folderId: 'planning',
                folderDepth: 1,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:child-session': makeSessionRow('child-session', { active: true }),
                's1:direct-session': makeSessionRow('direct-session', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [planningFolderGroupKey]: ['s1:direct-session', 'folder:child'] },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            'h:folder:Planning',
            'h:folder:Child',
            's:child-session',
            's:direct-session',
        ]);
    });

    it('orders pinned sessions across activity sections by selected date ordering mode instead of dormant pinned order', () => {
        const activeGroupKey = 'server:s1:active:project:repo';
        const inactiveGroupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroupKey },
            { type: 'session', sessionId: 'active-old-pinned', serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'active-mid-pinned', serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: inactiveGroupKey },
            { type: 'session', sessionId: 'inactive-new-pinned', serverId: 's1', section: 'inactive', groupKey: inactiveGroupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-old-pinned': makeSessionRow('active-old-pinned', { createdAt: 300, meaningfulActivityAt: 300_000 }),
                's1:active-mid-pinned': makeSessionRow('active-mid-pinned', { createdAt: 200, meaningfulActivityAt: 600_000 }),
                's1:inactive-new-pinned': makeSessionRow('inactive-new-pinned', { createdAt: 100, meaningfulActivityAt: 900_000 }),
                's1:normal': makeSessionRow('normal', { createdAt: 400, meaningfulActivityAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:active-old-pinned', 's1:active-mid-pinned', 's1:inactive-new-pinned'],
            sessionListGroupOrderV1: {
                [PINNED_GROUP_KEY_V1]: ['s1:active-old-pinned', 's1:active-mid-pinned', 's1:inactive-new-pinned'],
            },
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((item) => item.sessionId)).toEqual([
            'inactive-new-pinned',
            'active-mid-pinned',
            'active-old-pinned',
        ]);
    });

    it('uses pinned key order before stable fallback when ordering mode is custom', () => {
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'pinned-first', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'fallback-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'fallback-b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:pinned-first': makeSessionRow('pinned-first', { createdAt: 10, meaningfulActivityAt: 300_000 }),
                's1:fallback-a': makeSessionRow('fallback-a', { createdAt: 30, meaningfulActivityAt: 900_000 }),
                's1:fallback-b': makeSessionRow('fallback-b', { createdAt: 20, meaningfulActivityAt: 600_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-first', 's1:fallback-a', 's1:fallback-b'],
            sessionListGroupOrderV1: {
                [PINNED_GROUP_KEY_V1]: ['s1:pinned-first'],
            },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((item) => item.sessionId)).toEqual([
            'pinned-first',
            'fallback-a',
            'fallback-b',
        ]);
    });

    it('orders pinned sessions by bucketed activity when updated ordering is active', () => {
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'pinned-first', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'fallback-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'fallback-b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:pinned-first': makeSessionRow('pinned-first', { createdAt: 10, meaningfulActivityAt: 300_000 }),
                's1:fallback-a': makeSessionRow('fallback-a', { createdAt: 30, meaningfulActivityAt: 900_000 }),
                's1:fallback-b': makeSessionRow('fallback-b', { createdAt: 20, meaningfulActivityAt: 600_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-first', 's1:fallback-a', 's1:fallback-b'],
            sessionListGroupOrderV1: {
                [PINNED_GROUP_KEY_V1]: ['s1:pinned-first'],
            },
            sessionListOrderingModeV1: 'updated',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((item) => item.sessionId)).toEqual([
            'fallback-a',
            'fallback-b',
            'pinned-first',
        ]);
    });

    it('promotes pinned rows needing attention before the pinned section while preserving pinned state', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'pinned', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'quiet-pinned', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:pinned': makeSessionRow('pinned', { latestReadyEventSeq: 4, latestReadyEventAt: 30, lastViewedSessionSeq: 1 }),
                's1:quiet-pinned': makeSessionRow('quiet-pinned', { latestReadyEventSeq: 4, latestReadyEventAt: 10, lastViewedSessionSeq: 4 }),
                's1:ready': makeSessionRow('ready', { latestReadyEventSeq: 4, latestReadyEventAt: 20, lastViewedSessionSeq: 1 }),
                's1:normal': makeSessionRow('normal', { latestReadyEventSeq: 4, latestReadyEventAt: 10, lastViewedSessionSeq: 4 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned', 's1:quiet-pinned'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.pinned === true ? 'pinned' : 'unpinned'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:pinned:attention:pinned:ready',
            's:ready:attention:unpinned:ready',
            'h:pinned:Pinned',
            's:quiet-pinned:pinned:pinned:none',
            'h:date:Today',
            's:normal:date:unpinned:none',
        ]);
    });

    it('promotes server-backed pinned foreground and background work before pinned/ready placement', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'pinned-ready', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:pinned-ready': makeSessionRow('pinned-ready', {
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: 30,
                    lastViewedSessionSeq: 1,
                    updatedAt: 30,
                }),
                's1:pinned-working': makeSessionRow('pinned-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: now - 1_000,
                    lastViewedSessionSeq: 1,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 10_000,
                    runtimeActivityRevision: 1,
                    updatedAt: 20,
                }),
                's1:ready': makeSessionRow('ready', {
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: 20,
                    lastViewedSessionSeq: 1,
                    updatedAt: 10,
                }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 40,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            normalizedOrganizationProjection: {
                pinnedSessionKeys: ['s1:pinned-ready', 's1:pinned-working'],
                sessionListGroupOrder: {
                    [PINNED_GROUP_KEY_V1]: ['s1:pinned-ready', 's1:pinned-working'],
                },
                sessionWorkspaceOrder: {},
            },
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind ?? 'unknown'}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.pinned === true ? 'pinned' : 'unpinned'}:${item.attentionPromotionReason ?? 'none'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:attention',
            's:pinned-ready:attention:pinned:ready:none',
            's:ready:attention:unpinned:ready:none',
            'h:working',
            's:pinned-working:working:pinned:none:working',
            's:working:working:unpinned:none:working',
        ]);
        expect(result.filter((item) => item.type === 'session' && item.sessionId === 'pinned-working')).toHaveLength(1);
    });

    it('promotes completed turns that are newer than the read cursor even without a ready event', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'completed', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'read', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:completed': makeSessionRow('completed', {
                    seq: 5,
                    updatedAt: 30,
                    latestTurnStatus: 'completed',
                    latestReadyEventSeq: null,
                    lastViewedSessionSeq: 4,
                }),
                's1:read': makeSessionRow('read', {
                    seq: 5,
                    updatedAt: 20,
                    latestTurnStatus: 'completed',
                    latestReadyEventSeq: null,
                    lastViewedSessionSeq: 5,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:completed:attention:ready',
            'h:date:Today',
            's:read:date:none',
        ]);
    });

    it.each(['global', 'withinGroups'] as const)(
        'moves generic unread sessions into attention placement in %s mode and restores them when read',
        (mode) => {
            const groupKey = 'server:s1:day:2026-02-17';
            const source: SessionListIndexItem[] = [
                { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
                { type: 'session', sessionId: 'claude-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
                { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            ];
            const claudeSession = makeSessionRow('claude-unread', {
                seq: 742,
                lastViewedSessionSeq: 738,
                hasUnreadMessages: true,
                meaningfulActivityAt: 7_390,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 7_000,
                latestReadyEventSeq: 110,
                latestReadyEventAt: 1_100,
            });
            const common = {
                source,
                hideInactiveSessions: false,
                pinnedSessionKeysV1: [],
                sessionListGroupOrderV1: {},
                sessionListOrderingModeV1: 'custom' as const,
                presentation: { enabled: false, presentation: 'grouped' as const, selectedServerIds: [] },
                attentionPromotion: { mode },
            };

            const unreadResult = computeVisibleSessionListIndex({
                ...common,
                resolveSessionRow: makeResolver({
                    's1:claude-unread': claudeSession,
                    's1:quiet': makeSessionRow('quiet'),
                }),
            })!;
            const unreadItem = unreadResult.find((item) => item.type === 'session' && item.sessionId === 'claude-unread');

            expect(unreadItem).toMatchObject({
                groupKind: mode === 'global' ? 'attention' : 'date',
                attentionPromotionReason: 'unread',
            });
            if (mode === 'global') {
                expect(unreadResult[0]).toMatchObject({ type: 'header', headerKind: 'attention' });
            }

            const readResult = computeVisibleSessionListIndex({
                ...common,
                resolveSessionRow: makeResolver({
                    's1:claude-unread': {
                        ...claudeSession,
                        lastViewedSessionSeq: 742,
                        hasUnreadMessages: false,
                    },
                    's1:quiet': makeSessionRow('quiet'),
                }),
            })!;
            const readItem = readResult.find((item) => item.type === 'session' && item.sessionId === 'claude-unread');

            expect(readItem).toMatchObject({ groupKind: 'date' });
            expect(readItem?.type === 'session' ? readItem.attentionPromotionReason : undefined).toBeUndefined();
            expect(readResult.some((item) => item.type === 'header' && item.headerKind === 'attention')).toBe(false);
        },
    );

    it('preserves a selected unread row reason and exact attention position until navigation releases retention', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'existing-ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'selected-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'other-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const selectedUnread = makeSessionRow('selected-unread', {
            seq: 742,
            hasUnreadMessages: true,
            meaningfulActivityAt: 200,
            latestReadyEventSeq: 110,
            latestReadyEventAt: 100,
            lastViewedSessionSeq: 738,
        });
        const rows = {
            's1:existing-ready': makeSessionRow('existing-ready', {
                latestReadyEventSeq: 50,
                latestReadyEventAt: 50,
                lastViewedSessionSeq: 1,
            }),
            's1:selected-unread': selectedUnread,
            's1:other-unread': makeSessionRow('other-unread', {
                seq: 500,
                hasUnreadMessages: true,
                meaningfulActivityAt: 150,
                latestReadyEventSeq: 100,
                latestReadyEventAt: 40,
                lastViewedSessionSeq: 101,
            }),
        };
        const common = {
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as const,
            presentation: { enabled: false, presentation: 'grouped' as const, selectedServerIds: [] },
        };
        const summarizeAttention = (items: ReadonlyArray<SessionListIndexItem>) => items
            .filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session' && item.groupKind === 'attention')
            .map((item) => `${item.sessionId}:${item.attentionPromotionReason ?? 'none'}`);

        const initial = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver(rows),
            attentionPromotion: { mode: 'global' },
        })!;
        expect(summarizeAttention(initial)).toEqual([
            'existing-ready:ready',
            'selected-unread:unread',
            'other-unread:unread',
        ]);

        const readRows = {
            ...rows,
            's1:selected-unread': {
                ...selectedUnread,
                lastViewedSessionSeq: 742,
                hasUnreadMessages: false,
            },
        };
        const retained = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver(readRows),
            attentionPromotion: {
                mode: 'global',
                retainedPlacements: [{ key: 's1:selected-unread', reason: 'unread' }],
            },
        })!;
        expect(summarizeAttention(retained)).toEqual([
            'existing-ready:ready',
            'selected-unread:unread',
            'other-unread:unread',
        ]);

        const released = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver(readRows),
            attentionPromotion: { mode: 'global' },
        })!;
        expect(summarizeAttention(released)).toEqual([
            'existing-ready:ready',
            'other-unread:unread',
        ]);
        expect(released.find((item) => item.type === 'session' && item.sessionId === 'selected-unread')).toMatchObject({
            groupKind: 'date',
        });
    });

    // Retention holds the row the user is READING in place, and it worked only
    // because opening an unread row left the live placement with no reason at
    // all. Standing turns "no reason" into a reason, so the floor fires the
    // instant `unread` clears — and since reason priority is the primary sort,
    // the kept row drops to the bottom of the band under the reader instead of
    // waiting for them to navigate away.
    it('holds a kept unread row at its attention position while it is open, releasing it to the standing floor on navigation', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'existing-ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'selected-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'other-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const selectedUnread = makeSessionRow('selected-unread', {
            seq: 742,
            hasUnreadMessages: true,
            meaningfulActivityAt: 200,
            latestReadyEventSeq: 110,
            latestReadyEventAt: 100,
            lastViewedSessionSeq: 738,
        });
        const readRows = {
            's1:existing-ready': makeSessionRow('existing-ready', {
                latestReadyEventSeq: 50,
                latestReadyEventAt: 50,
                lastViewedSessionSeq: 1,
            }),
            's1:selected-unread': { ...selectedUnread, lastViewedSessionSeq: 742, hasUnreadMessages: false },
            's1:other-unread': makeSessionRow('other-unread', {
                seq: 500,
                hasUnreadMessages: true,
                meaningfulActivityAt: 150,
                latestReadyEventSeq: 100,
                latestReadyEventAt: 40,
                lastViewedSessionSeq: 101,
            }),
        };
        const common = {
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as const,
            presentation: { enabled: false, presentation: 'grouped' as const, selectedServerIds: [] },
        };
        const standingPolicy = {
            defaultStanding: false,
            overridesBySessionKey: { 's1:selected-unread': true },
        };
        const summarizeAttention = (items: ReadonlyArray<SessionListIndexItem>) => items
            .filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session' && item.groupKind === 'attention')
            .map((item) => `${item.sessionId}:${item.attentionPromotionReason ?? 'none'}`);

        const retained = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver(readRows),
            attentionPromotion: {
                mode: 'global',
                standingPolicy,
                retainedPlacements: [{ key: 's1:selected-unread', reason: 'unread' }],
            },
        })!;
        expect(summarizeAttention(retained)).toEqual([
            'existing-ready:ready',
            'selected-unread:unread',
            'other-unread:unread',
        ]);

        const released = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver(readRows),
            attentionPromotion: { mode: 'global', standingPolicy },
        })!;
        expect(summarizeAttention(released)).toEqual([
            'existing-ready:ready',
            'other-unread:unread',
            'selected-unread:standing',
        ]);
    });

    it('promotes completed turns even when stale thinking flags remain', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'completed', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:completed': makeSessionRow('completed', {
                    seq: 5,
                    updatedAt: 30,
                    latestTurnStatus: 'completed',
                    latestReadyEventSeq: null,
                    lastViewedSessionSeq: 4,
                    thinking: true,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:attention',
            's:completed:attention:ready',
        ]);
    });

    it('keeps globally promoted inactive sessions visible when inactive sessions are hidden', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:ready': makeSessionRow('ready', { latestReadyEventSeq: 4, latestReadyEventAt: 20, lastViewedSessionSeq: 1 }),
                's1:normal': makeSessionRow('normal'),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:ready:attention',
        ]);
    });

    it('keeps the unified sessions section header when inactive rows are hidden', () => {
        const groupKey = 'server:s1:sessions:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'active', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive', serverId: 's1', section: 'inactive', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active': makeSessionRow('active', { active: true }),
                's1:inactive': makeSessionRow('inactive', { active: false }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section ?? 'unknown'}`
        ))).toEqual([
            'h:sessions:Sessions',
            'h:project:repo',
            's:active:active',
        ]);
    });

    it('promotes active permission blockers even while the turn is in progress', () => {
        const now = Date.now();
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'permission', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];
        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                }),
                's1:permission': makeSessionRow('permission', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingPermissionRequests: true,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:permission:attention:permission_required',
            'h:active:Active',
            'h:project:~/repo',
            's:working:project:none',
        ]);
    });

    it('promotes pinned working rows before the pinned section while preserving pinned state', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-normal', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:normal': makeSessionRow('normal', { active: true, presence: 'online', updatedAt: 10 }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
                's1:pinned-working': makeSessionRow('pinned-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 20,
                }),
                's1:pinned-normal': makeSessionRow('pinned-normal', { active: true, presence: 'online', updatedAt: 5 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-working', 's1:pinned-normal'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind ?? 'unknown'}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.pinned === true ? 'pinned' : 'unpinned'}`
        ))).toEqual([
            'h:working',
            's:working:working:unpinned',
            's:pinned-working:working:pinned',
            'h:pinned',
            's:pinned-normal:pinned:pinned',
            'h:active',
            'h:project',
            's:normal:project:unpinned',
        ]);
    });

    it('keeps global working placement in source order when updatedAt changes', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'first-working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'second-working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:first-working': makeSessionRow('first-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 10,
                }),
                's1:second-working': makeSessionRow('second-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 10_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['first-working', 'second-working']);
    });

    it('orders pending attention rows by pendingRequestObservedAt instead of updatedAt', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'action-older', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'action-newer', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'blocked-pending', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'permission-older', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'permission-newer', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:action-older': makeSessionRow('action-older', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingUserActionRequests: true,
                    pendingRequestObservedAt: now - 10_000,
                    updatedAt: now,
                }),
                's1:action-newer': makeSessionRow('action-newer', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingUserActionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: now - 10_000,
                }),
                's1:blocked-pending': makeSessionRow('blocked-pending', {
                    pendingBlockedCount: 1,
                    updatedAt: now - 500,
                    hasPendingUserActionRequests: false,
                    hasPendingPermissionRequests: false,
                    pendingRequestObservedAt: undefined,
                }),
                's1:permission-older': makeSessionRow('permission-older', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 20_000,
                    updatedAt: now,
                }),
                's1:permission-newer': makeSessionRow('permission-newer', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 2_000,
                    updatedAt: now - 20_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')
            .map((item) => `${item.sessionId}:${item.attentionPromotionReason ?? 'none'}`)).toEqual([
                'blocked-pending:action_required',
                'action-newer:action_required',
                'action-older:action_required',
                'permission-newer:permission_required',
                'permission-older:permission_required',
            ]);
    });

    it('orders fallback ready attention rows by turn status observation when ready timestamp is absent', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'older-ready', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'newer-ready', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:older-ready': makeSessionRow('older-ready', {
                    seq: 8,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 10_000,
                    latestReadyEventAt: null,
                    lastViewedSessionSeq: 7,
                    updatedAt: now,
                }),
                's1:newer-ready': makeSessionRow('newer-ready', {
                    seq: 9,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    latestReadyEventAt: null,
                    lastViewedSessionSeq: 8,
                    updatedAt: now - 10_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['newer-ready', 'older-ready']);
    });

    it('moves working sessions to the top of their current group in within-groups mode', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:normal': makeSessionRow('normal', { active: true, presence: 'online', updatedAt: 10 }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'withinGroups' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            's:working:project',
            's:normal:project',
        ]);
    });

    it('emits the retained working reason for within-groups placement of stale retained sessions', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    activeAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'withinGroups' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:active',
            'h:project',
            's:working:project:working-retained',
        ]);
    });

    it('retains stale working placement across recompute', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    activeAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        // Retained placement keeps the session in the working group but is
        // surfaced as the distinct 'working-retained' reason so rows can
        // render a paused indicator instead of pretending live activity.
        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:working',
            's:working:working:working-retained',
        ]);
    });

    it('emits the plain working reason for sessions with live working signals', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: false,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:working',
            's:working:working:working',
        ]);
    });

    it('promotes foreground and background activity into the global working group', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'foreground', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'background', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:foreground': makeSessionRow('foreground', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
                's1:background': makeSessionRow('background', {
                    active: true,
                    activeAt: now - 10_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 5_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 1_000,
                    runtimeActivityRevision: 1,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:working:Working',
            's:foreground:working:working',
            's:background:working:working',
        ]);
    });

    it('marks background activity as working alongside foreground work in within-group mode', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'foreground', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'background', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:foreground': makeSessionRow('foreground', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
                's1:background': makeSessionRow('background', {
                    active: true,
                    activeAt: now - 10_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 5_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 1_000,
                    runtimeActivityRevision: 1,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'withinGroups' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}:${item.groupKey ?? 'none'}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:active:Active:none',
            'h:project:~/repo:server:s1:active:project:repo',
            's:foreground:project:working',
            's:background:project:working',
        ]);
    });

    it('keeps long-running canonical background activity in Working without an observedAt lease', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'background', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:background': makeSessionRow('background', {
                    active: true,
                    activeAt: now - 10_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 5_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 10_000,
                    runtimeActivityRevision: 1,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:working:Working',
            's:background:working:working',
        ]);
    });

    it('keeps working placement when active heartbeat refreshes an in-progress turn after legacy thinking clears', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: false,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:working',
            's:working:working:working',
        ]);
    });

    it('bounds retained working placement', () => {
        const now = 100_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    activeAt: now - SESSION_LIST_WORKING_RETENTION_LIMIT_MS - 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - SESSION_LIST_WORKING_RETENTION_LIMIT_MS - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        expect(result.some((item) => item.type === 'session' && item.workingPlacementReason === 'working')).toBe(false);
    });

    it('does not extend retained working placement from generic row updates', () => {
        const now = 100_000_000;
        const staleAnchor = now - SESSION_LIST_WORKING_RETENTION_LIMIT_MS - 1_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    activeAt: staleAnchor,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: staleAnchor,
                    thinkingAt: staleAnchor,
                    optimisticThinkingAt: staleAnchor,
                    updatedAt: now - 1_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        expect(result.some((item) => item.type === 'session' && item.workingPlacementReason === 'working')).toBe(false);
    });

    it('keeps fresh working placement ahead of stale ready metadata', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    seq: 12,
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: now - 120_000,
                    lastViewedSessionSeq: 9,
                    updatedAt: now - 1_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:working',
            's:working:working:none:working',
        ]);
    });

    it('prioritizes retained ready placement over retained working placement', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    seq: 5,
                    active: true,
                    activeAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    latestReadyEventSeq: 5,
                    latestReadyEventAt: now - 1_000,
                    lastViewedSessionSeq: 4,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
            workingPlacement: { mode: 'global' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:attention',
            's:working:attention:ready:none',
        ]);
    });

    it.each(['completed', 'failed', 'cancelled'] as const)(
        'removes retained working placement when latest turn status is %s',
        (latestTurnStatus) => {
            const now = 1_000_000;
            const groupKey = 'server:s1:active:project:repo';
            const source: SessionListIndexItem[] = [
                { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
                { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
                { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            ];

            const result = computeVisibleSessionListIndex({
                source,
                resolveSessionRow: makeResolver({
                    's1:working': makeSessionRow('working', {
                        active: true,
                        presence: 'online',
                        latestTurnStatus,
                        latestTurnStatusObservedAt: now - 1_000,
                        updatedAt: 30,
                    }),
                }),
                hideInactiveSessions: false,
                pinnedSessionKeysV1: [],
                sessionListGroupOrderV1: {},
                sessionListOrderingModeV1: 'custom',
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                workingPlacement: { mode: 'global' },
                retainWorkingSessionKeys: ['s1:working'],
                nowMs: now,
            })!;

            expect(result.some((item) => item.type === 'session' && item.workingPlacementReason === 'working')).toBe(false);
        },
    );

    it.each([
        ['inactive', { active: false, presence: 'online' as const, archivedAt: null }],
        ['offline', { active: true, presence: 1, archivedAt: null }],
        ['archived', { active: true, presence: 'online' as const, archivedAt: 123 }],
    ])('removes retained working placement when the row is %s', (_label, rowState) => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    ...rowState,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
            retainWorkingSessionKeys: ['s1:working'],
            nowMs: now,
        })!;

        expect(result.some((item) => item.type === 'session' && item.workingPlacementReason === 'working')).toBe(false);
    });

    it('clears stale attention metadata when within-group working placement applies', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            {
                type: 'session',
                sessionId: 'working',
                serverId: 's1',
                section: 'active',
                groupKey,
                groupKind: 'project',
                attentionPromotionReason: 'ready',
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'withinGroups' },
            nowMs: now,
        })!;

        expect(result).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({
                type: 'session',
                sessionId: 'working',
                attentionPromotionReason: undefined,
                workingPlacementReason: 'working',
            }),
        ]);
    });

    it('moves a completed unread session from working placement to attention placement', () => {
        const now = Date.now();
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'completed', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:completed': makeSessionRow('completed', {
                    seq: 5,
                    active: false,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    meaningfulActivityAt: now - 980,
                    latestReadyEventSeq: null,
                    lastViewedSessionSeq: 4,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global' },
            workingPlacement: { mode: 'global' },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:attention:Needs attention',
            's:completed:attention:ready',
        ]);
    });

    it('keeps attention sessions inside their current groups when within-groups mode is selected', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const params = {
            source,
            resolveSessionRow: makeResolver({
                's1:normal': makeSessionRow('normal'),
                's1:ready': makeSessionRow('ready', { latestReadyEventSeq: 4, latestReadyEventAt: 20, lastViewedSessionSeq: 1 }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'withinGroups' } satisfies SessionListAttentionPromotionOptions,
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            attentionPromotion: SessionListAttentionPromotionOptions;
        };

        const result = computeVisibleSessionListIndex(params)!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        ))).toEqual([
            'h:date:Today',
            's:ready:date:ready',
        ]);
    });

    it('clears stale working metadata when within-group attention placement applies', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            {
                type: 'session',
                sessionId: 'ready',
                serverId: 's1',
                section: 'inactive',
                groupKey,
                groupKind: 'date',
                workingPlacementReason: 'working',
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:ready': makeSessionRow('ready', {
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: now - 1_000,
                    lastViewedSessionSeq: 1,
                }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'withinGroups' },
            nowMs: now,
        })!;

        expect(result).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({
                type: 'session',
                sessionId: 'ready',
                attentionPromotionReason: 'ready',
                workingPlacementReason: undefined,
            }),
        ]);
    });
});

describe('unread attention ordering stability', () => {
    it('does not re-sort the attention lane when an unread row only receives newer activity', () => {
        const groupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'older-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'newer-unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const olderUnread = makeSessionRow('older-unread', {
            seq: 742,
            lastViewedSessionSeq: 738,
            hasUnreadMessages: true,
            unreadSince: 1_000,
            meaningfulActivityAt: 1_000,
            updatedAt: 1_000,
        });
        const newerUnread = makeSessionRow('newer-unread', {
            seq: 91,
            lastViewedSessionSeq: 80,
            hasUnreadMessages: true,
            unreadSince: 2_000,
            meaningfulActivityAt: 2_000,
            updatedAt: 2_000,
        });
        const common = {
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as const,
            presentation: { enabled: false, presentation: 'grouped' as const, selectedServerIds: [] },
            attentionPromotion: { mode: 'global' as const },
            nowMs: 10_000,
        };
        const attentionOrder = (items: ReadonlyArray<SessionListIndexItem>) => items
            .filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> =>
                item.type === 'session' && item.groupKind === 'attention')
            .map((item) => item.sessionId);

        const initial = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver({
                's1:older-unread': olderUnread,
                's1:newer-unread': newerUnread,
            }),
        })!;
        expect(attentionOrder(initial)).toEqual(['newer-unread', 'older-unread']);

        // A new message lands in the still-unread older row. It stays unread,
        // so its position must not move.
        const afterActivity = computeVisibleSessionListIndex({
            ...common,
            resolveSessionRow: makeResolver({
                's1:older-unread': {
                    ...olderUnread,
                    seq: 743,
                    meaningfulActivityAt: 9_000,
                    updatedAt: 9_000,
                },
                's1:newer-unread': newerUnread,
            }),
        })!;
        expect(attentionOrder(afterActivity)).toEqual(['newer-unread', 'older-unread']);
    });
});
