import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

const openSessionHandoffPickerMock = vi.hoisted(() => vi.fn());
const runSessionHandoffUiFlowMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const readSessionHandoffSessionActivityMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/sessions/handoff/openSessionHandoffPicker', () => ({
    openSessionHandoffPicker: (...args: unknown[]) => openSessionHandoffPickerMock(...args),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: (...args: unknown[]) => modalConfirmMock(...args),
        },
    }).module;
});

vi.mock('./readSessionHandoffSessionActivity', () => ({
    readSessionHandoffSessionActivity: (...args: unknown[]) => readSessionHandoffSessionActivityMock(...args),
}));

vi.mock('./runSessionHandoffUiFlow', () => ({
    runSessionHandoffUiFlow: (...args: unknown[]) => runSessionHandoffUiFlowMock(...args),
}));

installSessionHandoffCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: (...args: unknown[]) => modalConfirmMock(...args),
            },
        }).module;
    },
});

describe('runSessionHandoffPickerFlow', () => {
    beforeEach(() => {
        openSessionHandoffPickerMock.mockReset();
        runSessionHandoffUiFlowMock.mockReset();
        modalConfirmMock.mockReset();
        readSessionHandoffSessionActivityMock.mockReset();
        readSessionHandoffSessionActivityMock.mockReturnValue({ active: false });
    });

    it('returns null when the picker is dismissed', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce(null);

        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        const result = await runSessionHandoffPickerFlow({
            execute: vi.fn() as any,
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
            placement: 'session_info',
        });

        expect(openSessionHandoffPickerMock).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
        });
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(runSessionHandoffUiFlowMock).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    it('forwards the picker selection into the handoff UI flow without a warning for inactive sessions', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'persisted',
            workspaceTransfer: {
                enabled: true,
                strategy: 'transfer_snapshot',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
        });
        runSessionHandoffUiFlowMock.mockResolvedValueOnce({ ok: true, handoffId: 'handoff_1' });

        const execute = vi.fn();
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        const result = await runSessionHandoffPickerFlow({
            execute: execute as any,
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
            placement: 'session_action_menu',
        });

        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(runSessionHandoffUiFlowMock).toHaveBeenCalledWith({
            execute,
            sessionId: 'sess_1',
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'persisted',
            workspaceTransfer: {
                enabled: true,
                strategy: 'transfer_snapshot',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            context: {
                defaultSessionId: 'sess_1',
                serverId: 'server_a',
                surface: 'ui_button',
                placement: 'session_action_menu',
            },
        });
        expect(result).toEqual({ ok: true, handoffId: 'handoff_1' });
    });

    it('shows a stop-first confirmation before handing off an active session and continues when confirmed', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'machine_target',
        });
        readSessionHandoffSessionActivityMock.mockReturnValueOnce({ active: true });
        modalConfirmMock.mockResolvedValueOnce(true);
        runSessionHandoffUiFlowMock.mockResolvedValueOnce({ ok: true, handoffId: 'handoff_2' });

        const execute = vi.fn();
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        const result = await runSessionHandoffPickerFlow({
            execute: execute as any,
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
            placement: 'session_info',
        });

        expect(modalConfirmMock).toHaveBeenCalledWith(
            'sessionHandoff.activeWarning.title',
            'sessionHandoff.activeWarning.message',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionHandoff.activeWarning.confirm',
                destructive: true,
            },
        );
        expect(runSessionHandoffUiFlowMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ ok: true, handoffId: 'handoff_2' });
    });

    it('cancels an active-session handoff when the stop-first confirmation is declined', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'machine_target',
        });
        readSessionHandoffSessionActivityMock.mockReturnValueOnce({ active: true });
        modalConfirmMock.mockResolvedValueOnce(false);

        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        const result = await runSessionHandoffPickerFlow({
            execute: vi.fn() as any,
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            serverId: 'server_a',
            placement: 'session_info',
        });

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);
        expect(runSessionHandoffUiFlowMock).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false, handled: true });
    });
});
