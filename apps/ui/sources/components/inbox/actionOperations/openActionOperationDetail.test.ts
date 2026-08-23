import { beforeEach, describe, expect, it, vi } from 'vitest';

const show = vi.hoisted(() => vi.fn(() => 'modal-1'));

vi.mock('@/modal', () => ({ Modal: { show } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./ActionOperationDetailModal', () => ({ ActionOperationDetailModal: 'ActionOperationDetailModal' }));

describe('openActionOperationDetail', () => {
    beforeEach(() => show.mockClear());

    it('opens the shared live detail by operation id', async () => {
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        openActionOperationDetail('operation-1');

        expect(show).toHaveBeenCalledWith({
            component: 'ActionOperationDetailModal',
            props: { operationId: 'operation-1' },
            closeOnBackdrop: true,
            accessibilityLabel: 'inbox.actionOperations.detailAccessibilityLabel',
        });
    });
});
