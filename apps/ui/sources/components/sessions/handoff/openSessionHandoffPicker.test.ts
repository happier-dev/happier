import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());
const refreshMachinesThrottledMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<void>>(async () => {}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (config: unknown) => showMock(config),
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: (params: unknown) => refreshMachinesThrottledMock(params),
    },
}));

vi.mock('./SessionHandoffPickerModal', () => ({
    SessionHandoffPickerModal: () => null,
}));

describe('openSessionHandoffPicker', () => {
    beforeEach(() => {
        showMock.mockReset();
        refreshMachinesThrottledMock.mockReset();
        refreshMachinesThrottledMock.mockResolvedValue(undefined);
        showMock.mockImplementation((config: any) => {
            config.props.onResolve(null);
            return 'modal_1';
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('refreshes machines before opening the picker modal', async () => {
        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');

        await openSessionHandoffPicker({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
        });

        expect(refreshMachinesThrottledMock).toHaveBeenCalledWith({ staleMs: 0, force: true });
        expect(showMock).toHaveBeenCalledTimes(1);
        expect(refreshMachinesThrottledMock.mock.invocationCallOrder[0]).toBeLessThan(showMock.mock.invocationCallOrder[0]);
    });

    it('still opens the picker modal when the refresh fails', async () => {
        refreshMachinesThrottledMock.mockRejectedValueOnce(new Error('network down'));
        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');

        await expect(openSessionHandoffPicker({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
        })).resolves.toBeNull();

        expect(refreshMachinesThrottledMock).toHaveBeenCalledWith({ staleMs: 0, force: true });
        expect(showMock).toHaveBeenCalledTimes(1);
    });
});
