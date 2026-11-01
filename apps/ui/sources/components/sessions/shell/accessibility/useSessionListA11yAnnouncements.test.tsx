import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SessionListTreeDropResult } from '../drop-resolution/sessionListTreeTypes';

import { useSessionListA11yAnnouncements } from './useSessionListA11yAnnouncements';

const announceForAccessibilitySpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        AccessibilityInfo: {
            announceForAccessibility: announceForAccessibilitySpy,
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            const serialized = params ? `:${JSON.stringify(params)}` : '';
            return `${key}${serialized}`;
        },
    });
});

describe('useSessionListA11yAnnouncements', () => {
    it('announces folder assignment without a tree drag result', async () => {
        announceForAccessibilitySpy.mockClear();
        const hook = await renderHook(() => useSessionListA11yAnnouncements());
        hook.getCurrent().announceFolderAssignment({ label: 'Session', destinationLabel: 'Planning', folderId: 'planning' });
        expect(announceForAccessibilitySpy).toHaveBeenCalledWith(expect.stringContaining('sessionsList.dragA11yDroppedNest'));
        hook.getCurrent().announceFolderAssignment({ label: 'Session', destinationLabel: 'Root', folderId: null });
        expect(announceForAccessibilitySpy).toHaveBeenLastCalledWith(expect.stringContaining('sessionsList.dragA11yDroppedRoot'));
    });

    it('announces pickup and successful move outcomes through the native announcer', async () => {
        announceForAccessibilitySpy.mockClear();
        const hook = await renderHook(() => useSessionListA11yAnnouncements());

        hook.getCurrent().announcePickedUp({ label: 'Planning' });
        hook.getCurrent().announceDropResult({
            label: 'Planning',
            destinationLabel: 'Workspace root',
            result: {
                instruction: {
                    kind: 'move-to-root',
                    containerId: 'workspace-a',
                    rootId: 'workspace-a',
                    depth: 0,
                    placement: 'before-first',
                },
                visual: { kind: 'outline', targetId: 'workspace-a' },
            },
        });

        expect(announceForAccessibilitySpy).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('sessionsList.dragA11yPickedUp'),
        );
        expect(announceForAccessibilitySpy).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('sessionsList.dragA11yDroppedRoot'),
        );
    });

    it('announces blocked reasons using the session-list blocked translation branch', async () => {
        announceForAccessibilitySpy.mockClear();
        const hook = await renderHook(() => useSessionListA11yAnnouncements());
        const blockedResult: SessionListTreeDropResult = {
            instruction: { kind: 'blocked', reason: 'descendant-cycle' },
            visual: { kind: 'none' },
        };

        hook.getCurrent().announceDropResult({
            label: 'Planning',
            destinationLabel: 'Planning child',
            result: blockedResult,
        });

        expect(announceForAccessibilitySpy).toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.dragA11yBlocked'),
        );
        expect(announceForAccessibilitySpy).toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.dragA11yBlockedDescendantCycle'),
        );
    });

    it('announces session-list eligibility block reasons instead of the generic tree reason', async () => {
        announceForAccessibilitySpy.mockClear();
        const hook = await renderHook(() => useSessionListA11yAnnouncements());

        hook.getCurrent().announceDropResult({
            label: 'Direct session',
            result: {
                instruction: { kind: 'blocked', reason: 'workspace-scope-mismatch' },
                visual: { kind: 'none' },
                sessionListBlockReason: 'feature-disabled',
            },
        });

        expect(announceForAccessibilitySpy).toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.dragA11yBlockedFeatureDisabled'),
        );
        expect(announceForAccessibilitySpy).not.toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.dragA11yBlockedWorkspaceScope'),
        );
    });

    it('announces the date-ordering block reason for disabled manual reorders', async () => {
        announceForAccessibilitySpy.mockClear();
        const hook = await renderHook(() => useSessionListA11yAnnouncements());

        hook.getCurrent().announceDropResult({
            label: 'Session A',
            result: {
                instruction: { kind: 'blocked', reason: 'same-position' },
                visual: { kind: 'none' },
                sessionListBlockReason: 'date-ordering-mode',
            },
        });

        expect(announceForAccessibilitySpy).toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.dragA11yBlockedDateOrderingMode'),
        );
        expect(announceForAccessibilitySpy).not.toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.dragA11yBlockedSamePosition'),
        );
    });

    it('announces session-list selection counts through the same cross-platform announcer', async () => {
        announceForAccessibilitySpy.mockClear();
        const hook = await renderHook(() => useSessionListA11yAnnouncements());

        hook.getCurrent().announceSelectionCount({ count: 3 });

        expect(announceForAccessibilitySpy).toHaveBeenCalledWith(
            expect.stringContaining('sessionsList.selectionA11ySelectedCount'),
        );
    });
});
