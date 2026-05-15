import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import type { SessionListMoveSheetTarget } from './buildSessionListMoveSheetTargets';
import { useSessionListMoveSheet } from './useSessionListMoveSheet';

const modalMock = vi.hoisted(() => {
    const show = vi.fn((_config: unknown) => 'move-sheet-modal');
    const hide = vi.fn();
    return { show, hide };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalMock.show as never,
            hide: modalMock.hide as never,
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const rootTarget: SessionListMoveSheetTarget = {
    id: 'root:workspace-a',
    kind: 'root',
    label: 'Workspace root',
    disabled: false,
    result: {
        instruction: {
            kind: 'move-to-root',
            containerId: 'workspace-a',
            rootId: 'workspace-a',
            depth: 0,
        },
        visual: { kind: 'outline', targetId: 'workspace-a' },
    },
};

describe('useSessionListMoveSheet', () => {
    it('opens a card modal and resolves with the selected target', async () => {
        modalMock.show.mockClear();
        modalMock.hide.mockClear();
        const hook = await renderHook(() => useSessionListMoveSheet());

        let selection: Promise<SessionListMoveSheetTarget | null>;
        await act(async () => {
            selection = hook.getCurrent().openMoveSheet({
                sourceLabel: 'Planning',
                targets: [rootTarget],
            });
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(modalMock.show).toHaveBeenCalled();
        });
        expect(modalMock.show).toHaveBeenCalledWith(expect.objectContaining({
            chrome: { kind: 'card' },
        }));
        const config = modalMock.show.mock.calls[0]?.[0] as { props?: { onSelectTarget?: (target: SessionListMoveSheetTarget) => void } };
        await act(async () => {
            config.props?.onSelectTarget?.(rootTarget);
        });

        await expect(selection!).resolves.toBe(rootTarget);
        expect(modalMock.hide).toHaveBeenCalledWith('move-sheet-modal');
    });

    it('resolves null when the sheet is cancelled', async () => {
        modalMock.show.mockClear();
        modalMock.hide.mockClear();
        const hook = await renderHook(() => useSessionListMoveSheet());

        let selection: Promise<SessionListMoveSheetTarget | null>;
        await act(async () => {
            selection = hook.getCurrent().openMoveSheet({
                sourceLabel: 'Planning',
                targets: [rootTarget],
            });
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(modalMock.show).toHaveBeenCalled();
        });

        const config = modalMock.show.mock.calls[0]?.[0] as { props?: { onCancel?: () => void } };
        await act(async () => {
            config.props?.onCancel?.();
        });

        await expect(selection!).resolves.toBeNull();
        expect(modalMock.hide).toHaveBeenCalledWith('move-sheet-modal');
    });
});
