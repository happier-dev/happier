import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showMock = vi.hoisted(() => vi.fn<(config: unknown) => string>());
const hideMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const updateMock = vi.hoisted(() => vi.fn());
const sessionHandoffPickerModalStub = vi.hoisted(() => () => null);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: (config: unknown) => showMock(config),
            hide: (id: string) => hideMock(id),
            update: (id: string, props: Record<string, unknown>) => updateMock(id, props),
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
        updateMock.mockReset();
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
            workspaceAction: { kind: 'none' },
        });
        capturedConfig.onRequestClose();

        await expect(promise).resolves.toEqual({
            targetMachineId: 'machine_target',
            workspaceAction: { kind: 'none' },
        });
        expect(hideMock).toHaveBeenCalledWith('modal_1');
    });

    it('keeps the submitted picker mounted for conflict review and only redispatches after another explicit submit', async () => {
        let capturedConfig: any = null;
        showMock.mockImplementation((config: any) => { capturedConfig = config; return 'modal_1'; });
        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');
        const onSubmitAgain = vi.fn();
        const onRetained = vi.fn();
        const pending = openSessionHandoffPicker({
            sessionId: 'sess_1', sourceMachineId: 'machine_source', serverId: 'server_a',
            retainOnSubmit: true, onSubmitAgain, onRetained,
        });
        const selection = { targetMachineId: 'machine_target', targetPath: '/project', workspaceAction: { kind: 'linked_workspace' } };
        capturedConfig.props.onResolve(selection);
        await expect(pending).resolves.toEqual(selection);
        expect(hideMock).not.toHaveBeenCalled();
        expect(onRetained).toHaveBeenCalledOnce();
        expect(onSubmitAgain).not.toHaveBeenCalled();
        capturedConfig.props.onResolve(selection);
        expect(onSubmitAgain).toHaveBeenCalledWith(selection);
        onRetained.mock.calls[0]?.[0]();
        expect(hideMock).toHaveBeenCalledWith('modal_1');
    });

    it('permits truthful dismissal during admission and rejects duplicate submit', async () => {
        let capturedConfig: any = null;
        showMock.mockImplementation((config: any) => { capturedConfig = config; return 'modal_1'; });
        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');
        const onRetained = vi.fn();
        const onSubmitAgain = vi.fn();
        const pending = openSessionHandoffPicker({
            sessionId: 'sess_1', serverId: 'server_a', retainOnSubmit: true, onRetained, onSubmitAgain,
        });
        const selection = { targetMachineId: 'machine_target', workspaceAction: { kind: 'none' } };
        capturedConfig.props.onResolve(selection);
        await expect(pending).resolves.toEqual(selection);
        const setAwaitingAdmission = onRetained.mock.calls[0]?.[1] as (awaiting: boolean) => void;
        setAwaitingAdmission(true);
        expect(updateMock).toHaveBeenCalledWith('modal_1', { awaitingAdmission: true });
        capturedConfig.props.onResolve(selection);
        expect(capturedConfig.onDismissRequest?.('shared')).not.toBe(false);
        expect(onSubmitAgain).not.toHaveBeenCalled();
        expect(hideMock).not.toHaveBeenCalled();
        capturedConfig.onRequestClose();
        expect(hideMock).toHaveBeenCalledWith('modal_1');
        setAwaitingAdmission(false);
        capturedConfig.props.onResolve(selection);
        expect(onSubmitAgain).not.toHaveBeenCalled();
    });

    it('keeps an existing-state rejection on the retained picker so the user can correct and resubmit', async () => {
        let capturedConfig: any = null;
        showMock.mockImplementation((config: any) => { capturedConfig = config; return 'modal_1'; });
        const { openSessionHandoffPicker } = await import('./openSessionHandoffPicker');
        const onRetained = vi.fn();
        const onSubmitAgain = vi.fn();
        const pending = openSessionHandoffPicker({
            sessionId: 'sess_1', serverId: 'server_a', retainOnSubmit: true, onRetained, onSubmitAgain,
        });
        const selection = { targetMachineId: 'machine_target', stateTransfer: 'existing', workspaceAction: { kind: 'none' } };
        capturedConfig.props.onResolve(selection);
        await expect(pending).resolves.toEqual(selection);
        const setInlineError = onRetained.mock.calls[0]?.[3] as (code: string | null) => void;
        expect(setInlineError).toBeTypeOf('function');
        setInlineError('existing_session_state_unavailable');
        expect(updateMock).toHaveBeenCalledWith('modal_1', { inlineErrorCode: 'existing_session_state_unavailable' });
        expect(hideMock).not.toHaveBeenCalled();
        capturedConfig.props.onResolve({ ...selection, stateTransfer: 'transfer' });
        expect(onSubmitAgain).toHaveBeenCalledWith(expect.objectContaining({ stateTransfer: 'transfer' }));
        onRetained.mock.calls[0]?.[0]();
    });
});
