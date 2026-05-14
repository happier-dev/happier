import { beforeEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { useSessionListRenderModels } from './useSessionListRenderModels';

describe('useSessionListRenderModels', () => {
    beforeEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('reuses the same empty render model bundle for empty visible list input', async () => {
        const paneState: VisibleSessionListPaneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListIndex: [],
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: true,
        };

        const hook = await renderHook((input: { paneState: VisibleSessionListPaneState }) =>
            useSessionListRenderModels({
                paneState: input.paneState,
                collapsedGroupKeys: {},
                allMachines: [],
                workspaceLabels: {},
                workspaceRefs: [],
                pinnedKeySet: new Set<string>(),
                sessionTags: {},
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }), {
            initialProps: { paneState },
        });

        const first = hook.getCurrent();
        const second = await hook.rerender({ paneState });

        expect(first).toBe(second);
        expect(first).toMatchObject({
            listItems: [],
            hasMultipleMachines: false,
            projectHeaderViewModelState: {
                projectHeaderViewModelByGroupKey: expect.any(Map),
                scopeHintByLegacyWorkspaceKey: expect.any(Map),
            },
            reachableSessionDisplayById: expect.any(Map),
            rowViewModels: [],
        });
        expect(first.reachableSessionDisplayById.size).toBe(0);
        expect(first.projectHeaderViewModelState.projectHeaderViewModelByGroupKey.size).toBe(0);
        expect(first.projectHeaderViewModelState.scopeHintByLegacyWorkspaceKey.size).toBe(0);
    });

    it('reuses the same non-empty render model bundle when fresh empty shell inputs are normalized', async () => {
        const paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListIndex: [
                {
                    type: 'session',
                    sessionId: 'session-1',
                },
            ] satisfies ReadonlyArray<SessionListIndexItem>,
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: false,
        } as VisibleSessionListPaneState;

        const hook = await renderHook((input: {
            paneState: VisibleSessionListPaneState;
            collapsedGroupKeys: Record<string, boolean>;
            workspaceLabels: Record<string, string>;
            workspaceRefs: Array<{
                id: string;
                serverId: string;
                machineId: string;
                rootPath: string;
                label: string | null;
                createdAtMs: number;
                lastOpenedAtMs: number | null;
            }>;
            sessionTags: Record<string, string[]>;
        }) =>
            useSessionListRenderModels({
                paneState: input.paneState,
                collapsedGroupKeys: input.collapsedGroupKeys,
                allMachines: [],
                workspaceLabels: input.workspaceLabels,
                workspaceRefs: input.workspaceRefs,
                pinnedKeySet: new Set<string>(),
                sessionTags: input.sessionTags,
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }), {
            initialProps: {
                paneState,
                collapsedGroupKeys: {},
                workspaceLabels: {},
                workspaceRefs: [],
                sessionTags: {},
            },
        });

        const first = hook.getCurrent();
        const second = await hook.rerender({
            paneState,
            collapsedGroupKeys: {},
            workspaceLabels: {},
            workspaceRefs: [],
            sessionTags: {},
        });

        expect(first).toBe(second);
        expect(first.listItems).toHaveLength(1);
        expect(first.rowViewModels).toHaveLength(1);
    });

    it('records low-volume render derivation telemetry for non-empty list models', async () => {
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();
        const paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListIndex: [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'active',
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    groupKey: 'active',
                },
            ] satisfies ReadonlyArray<SessionListIndexItem>,
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: false,
        } as VisibleSessionListPaneState;

        await renderHook(() =>
            useSessionListRenderModels({
                paneState,
                collapsedGroupKeys: {},
                allMachines: [],
                workspaceLabels: {},
                workspaceRefs: [],
                pinnedKeySet: new Set<string>(),
                sessionTags: {},
                selectedSessionId: 'session-1',
                showServerBadge: false,
                showPinnedServerBadge: false,
            }));

        const events = syncPerformanceTelemetry.snapshot().events;
        expect(events.find((event) => event.name === 'ui.sessionsList.render.collapsedFiltering')?.fields)
            .toMatchObject({ items: 2, collapsedGroups: 0 });
        expect(events.find((event) => event.name === 'ui.sessionsList.render.reachabilityDisplayMap')?.fields)
            .toMatchObject({ items: 2, machines: 0, displayRows: 1 });
        expect(events.find((event) => event.name === 'ui.sessionsList.render.selectedMapping')?.fields)
            .toMatchObject({ items: 2, selectable: 1 });
        syncPerformanceTelemetry.configure({ enabled: false });
    });
});
