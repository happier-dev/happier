import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());
const hideMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const refreshMachinesThrottledMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<void>>(async () => {}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: unknown) => showMock(config),
            hide: (id: string) => hideMock(id),
        },
    }).module;
});

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
        hideMock.mockReset();
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

    it('still opens the picker modal when the refresh hangs (never resolves)', async () => {
        vi.useFakeTimers();
        refreshMachinesThrottledMock.mockImplementationOnce(() => new Promise(() => {}));

        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');

        const promise = openSessionHandoffPicker({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
        });

        // The picker should not block indefinitely waiting for machine refresh.
        await vi.advanceTimersByTimeAsync(3500);

        await expect(promise).resolves.toBeNull();
        expect(showMock).toHaveBeenCalledTimes(1);
        expect(refreshMachinesThrottledMock).toHaveBeenCalledWith({ staleMs: 0, force: true });
    });

    it('resolves the picker selection and hides the modal without letting a later close callback turn it into a cancel', async () => {
        let capturedConfig: any = null;
        showMock.mockImplementation((config: any) => {
            capturedConfig = config;
            return 'modal_1';
        });

        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');

        const promise = openSessionHandoffPicker({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
        });

        await vi.waitFor(() => {
            expect(capturedConfig).not.toBeNull();
        });

        capturedConfig.props.onResolve({
            targetMachineId: 'machine_target',
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
        });
        capturedConfig.onRequestClose();

        await expect(promise).resolves.toEqual({
            targetMachineId: 'machine_target',
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
        });
        expect(hideMock).toHaveBeenCalledWith('modal_1');
    });
});
