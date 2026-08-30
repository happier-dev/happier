import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());
const hideMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const sessionHandoffPickerModalStub = vi.hoisted(() => () => null);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: unknown) => showMock(config),
            hide: (id: string) => hideMock(id),
        },
    }).module;
});

vi.mock('./SessionHandoffPickerModal', () => ({
    SessionHandoffPickerModal: sessionHandoffPickerModalStub,
}));

describe('openSessionHandoffPicker', () => {
    beforeEach(() => {
        showMock.mockReset();
        hideMock.mockReset();
        showMock.mockImplementation((config: any) => {
            config.props.onResolve(null);
            return 'modal_1';
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('mounts the concrete picker body immediately instead of a Suspense loading shell', async () => {
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
        const entry = capturedConfig.component(capturedConfig.props);
        expect(entry.type).toBe(sessionHandoffPickerModalStub);

        capturedConfig.props.onResolve(null);
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
