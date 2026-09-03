import { beforeEach, describe, expect, it, vi } from 'vitest';

const modalShowMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => 'handoff-progress-modal'));
const modalHideMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));
const modalUpdateMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (...args: unknown[]) => modalShowMock(...args),
            hide: (...args: unknown[]) => modalHideMock(...args),
            update: (...args: unknown[]) => modalUpdateMock(...args),
        },
    }).module;
});

import { createActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { openObservedSessionHandoffProgressModal } from './openSessionHandoffProgressModal';

describe('observed session handoff progress presentation', () => {
    beforeEach(() => {
        modalShowMock.mockClear();
        modalHideMock.mockClear();
        modalUpdateMock.mockClear();
    });

    it('streams pushed operation revisions into the modal and detaches observation when collapsed', async () => {
        const store = createActionOperationStore();
        const presentation = openObservedSessionHandoffProgressModal({
            requestId: 'handoff-request-1',
            sessionId: 'session-1',
            workspaceTransferEnabled: true,
            store,
        });

        store.merge({
            version: 1,
            operationId: 'handoff-operation-1',
            requestId: 'handoff-request-1',
            revision: 1,
            actionId: 'session.handoff',
            state: 'running',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Hand off session',
            createdAt: 1,
            startedAt: 2,
            progress: { kind: 'determinate', current: 1, total: 2, label: 'Transferring' },
            cancellation: 'supported',
        });

        expect(modalUpdateMock).toHaveBeenCalledWith('handoff-progress-modal', {
            operation: expect.objectContaining({ revision: 1, requestId: 'handoff-request-1' }),
        });
        expect(presentation.isAttached()).toBe(true);

        const config = modalShowMock.mock.calls[0]?.[0] as { onRequestClose?: () => void } | undefined;
        config?.onRequestClose?.();
        store.merge({
            ...store.getState().operationsById.get('handoff-operation-1')!,
            revision: 2,
        });

        expect(presentation.isAttached()).toBe(false);
        expect(modalUpdateMock).toHaveBeenCalledTimes(1);
    });
});
