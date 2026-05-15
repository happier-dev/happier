import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { TreeDropResult } from '@/components/ui/treeDragDrop';

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
        const blockedResult: TreeDropResult = {
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
});
