import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';

import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';

import { useSessionListRenderModels } from './useSessionListRenderModels';

describe('useSessionListRenderModels', () => {
    it('reuses the same empty render model bundle for empty visible list input', async () => {
        const paneState: VisibleSessionListPaneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListIndex: [],
            hasHiddenInactiveSessions: false,
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
            ] as any[],
            hasHiddenInactiveSessions: false,
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
});
