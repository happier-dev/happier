import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());
const hideMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const pickerModuleGate = vi.hoisted(() => ({
    block: false,
    release: null as (() => void) | null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: unknown) => showMock(config),
            hide: (id: string) => hideMock(id),
        },
    }).module;
});

vi.mock('./SessionHandoffPickerModal', async () => {
    if (pickerModuleGate.block) {
        await new Promise<void>((resolve) => {
            pickerModuleGate.release = resolve;
        });
    }
    return {
        SessionHandoffPickerModal: () => null,
    };
});

describe('openSessionHandoffPicker', () => {
    beforeEach(() => {
        showMock.mockReset();
        hideMock.mockReset();
        pickerModuleGate.block = false;
        pickerModuleGate.release = null;
        showMock.mockImplementation((config: any) => {
            config.props.onResolve(null);
            return 'modal_1';
        });
    });

    afterEach(() => {
        pickerModuleGate.release?.();
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('shows the modal shell before the picker module finishes loading', async () => {
        pickerModuleGate.block = true;
        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');

        const promise = openSessionHandoffPicker({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
        });

        await Promise.resolve();
        try {
            expect(showMock).toHaveBeenCalledTimes(1);
        } finally {
            pickerModuleGate.release?.();
        }
        await expect(promise).resolves.toBeNull();
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
