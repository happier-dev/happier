import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: unknown) => showMock(config),
        },
    }).module;
});

vi.mock('./SessionHandoffFailureRecoveryModal', () => ({
    SessionHandoffFailureRecoveryModal: () => null,
}));

describe('openSessionHandoffFailureRecoveryModal', () => {
    beforeEach(() => {
        showMock.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('disables backdrop dismissal for the promise-backed modal', async () => {
        showMock.mockImplementation((config: any) => {
            config.props.onResolve(null);
            return 'modal_1';
        });

        const { openSessionHandoffFailureRecoveryModal } = await import('./openSessionHandoffFailureRecoveryModal');

        await openSessionHandoffFailureRecoveryModal({
            title: 'Failure',
            message: 'Something went wrong',
            recovery: { handoffId: 'handoff_1', actions: ['restart_on_source', 'keep_stopped'] },
        });

        expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
            closeOnBackdrop: false,
        }));
    });
});
