import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { Modal } from '@/modal';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
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

function prepareRegisteredSource(runtime: ReturnType<typeof createEntityDragDropRuntime>) {
    const scope = { serverId: 'home', accountId: 'account' };
    const dispose = runtime.registerSource({ id: 'source', scope,
        getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'session' } }),
        isCurrent: () => true });
    return { sourceId: 'source', dispose };
}

describe('useSessionListMoveSheet', () => {
    beforeEach(() => { vi.mocked(Modal.alert).mockClear(); });
    beforeAll(async () => {
        await import('./SessionListMoveSheet');
    });

    it('reports a source that disappeared before opening the move chooser', async () => {
        const hook = await renderHook(() => useSessionListMoveSheet());
        const runtime = createEntityDragDropRuntime();
        await act(async () => {
            void hook.getCurrent().openMoveSheet({
                sourceLabel: 'Planning', runtime,
                prepareSource: () => {
                    buildSessionListDragSource({ tree: buildSessionListTreeRows({ items: [] }), sourceRowId: 'missing' });
                    return null;
                },
            });
            await Promise.resolve();
        });
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'errors.unknownError');
    });

    it('opens a card modal and resolves with the acknowledged owner outcome', async () => {
        modalMock.show.mockClear();
        modalMock.hide.mockClear();
        const hook = await renderHook(() => useSessionListMoveSheet());

        const runtime = createEntityDragDropRuntime();
        let selection: Promise<EntityDropOutcomeV1 | null>;
        await act(async () => {
            selection = hook.getCurrent().openMoveSheet({
                sourceLabel: 'Planning',
                runtime,
                prepareSource: () => prepareRegisteredSource(runtime),
            });
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            expect(modalMock.show).toHaveBeenCalled();
        });
        // The card names the move in the shared title band (with its close button).
        expect(modalMock.show).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ kind: 'card', title: 'sessionsList.moveSheetTitle' }),
        }));
        const config = modalMock.show.mock.calls[0]?.[0] as { props?: { onComplete?: (outcome: EntityDropOutcomeV1) => void } };
        await act(async () => {
            config.props?.onComplete?.({ status: 'applied' });
        });

        await expect(selection!).resolves.toEqual({ status: 'applied' });
        expect(modalMock.hide).toHaveBeenCalledWith('move-sheet-modal');
        expect(runtime.begin('source', 'keyboard')).toBeNull();
    });

    it('resolves null when the sheet is cancelled', async () => {
        modalMock.show.mockClear();
        modalMock.hide.mockClear();
        const hook = await renderHook(() => useSessionListMoveSheet());

        const runtime = createEntityDragDropRuntime();
        let selection: Promise<EntityDropOutcomeV1 | null>;
        await act(async () => {
            selection = hook.getCurrent().openMoveSheet({
                sourceLabel: 'Planning',
                runtime,
                prepareSource: () => prepareRegisteredSource(runtime),
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
        expect(runtime.begin('source', 'keyboard')).toBeNull();
    });
});
