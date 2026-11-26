import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useComputerTargetPicker, type ComputerTargetPickerInput } from './useComputerTargetPicker';

// The Action front door is the boundary: the machine's list answers, nothing else is reached.
const execute: ComputerTargetPickerInput['execute'] = async () => ({
    ok: true,
    result: { targets: [], grants: { capture: 'granted', input: 'granted' } },
} as never);

function pickerInput(overrides: Partial<ComputerTargetPickerInput> = {}): ComputerTargetPickerInput {
    return {
        scope: { serverId: 'home', sessionId: 'session', machineId: 'machine' },
        execute,
        currentTargetKey: null,
        onSelected: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}

describe('useComputerTargetPicker initial access', () => {
    it('opens on See it when nothing is shared yet, so widening to use is an explicit choice', async () => {
        const hook = await renderHook(useComputerTargetPicker, { initialProps: pickerInput() });
        expect(hook.getCurrent().access).toBe('see');
        await hook.unmount();
    });

    it.each(['see', 'use'] as const)('opens on the current share’s access (%s)', async access => {
        const hook = await renderHook(useComputerTargetPicker, { initialProps: pickerInput({ access, currentTargetKey: 'window:1' }) });
        expect(hook.getCurrent().access).toBe(access);
        await hook.unmount();
    });
});

it('retains the Machine’s typed list refusal for picker recovery', async () => {
    const refusal = { ok: false, errorCode: 'action_forbidden', error: 'Private Machine diagnostic',
        requestId: 'computer-picker-list', effectAttempted: false,
        failureCause: { phase: 'home.action.admission', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 },
    } as const;
    const hook = await renderHook(useComputerTargetPicker, { initialProps: pickerInput({ execute: async () => refusal }) });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({
            kind: 'failed', code: 'action_forbidden', actionFailure: refusal,
        }));
    } finally { await hook.unmount(); }
});

it.each(['share', 'stopSharing', 'requestSettings'] as const)('keeps the %s refusal in the picker recovery', async operation => {
    const refusal = { ok: false, errorCode: 'action_forbidden', error: 'Private Machine diagnostic',
        requestId: 'computer-picker-operation', effectAttempted: false,
        failureCause: { phase: 'home.action.admission', errorClass: 'HttpStatusError', errorCode: 'forbidden', httpStatus: 403 },
    } as const;
    let answerTypedRefusal = false;
    const window = { target: { kind: 'window', displayId: 'screen', pid: 4, windowId: 2 }, title: 'Editor' };
    const boundary: ComputerTargetPickerInput['execute'] = async () => answerTypedRefusal ? refusal : {
        ok: true, result: { targets: [window], grants: { capture: operation === 'requestSettings' ? 'denied' : 'granted', input: 'granted' } },
    };
    const hook = await renderHook(useComputerTargetPicker, { initialProps: pickerInput({ execute: boundary }) });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        answerTypedRefusal = true;
        if (operation === 'requestSettings') {
            hook.getCurrent().requestSettings('capture');
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ openSettings: 'failed', openSettingsFailure: refusal }));
        } else {
            hook.getCurrent()[operation]();
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ noticeCode: 'action_forbidden', noticeFailure: refusal }));
        }
    } finally { await hook.unmount(); }
});

describe('useComputerTargetPicker initial choice', () => {
    it('preselects the only choice the Machine offers, so Share is one press', async () => {
        const display = { target: { kind: 'display', displayId: 'display-1' }, title: 'Built-in display' };
        const oneDisplay: ComputerTargetPickerInput['execute'] = async () => ({
            ok: true,
            result: { targets: [display], grants: { capture: 'granted', input: 'granted' } },
        } as never);
        const hook = await renderHook(useComputerTargetPicker, { initialProps: pickerInput({ execute: oneDisplay }) });
        await vi.waitFor(() => expect(hook.getCurrent().state.kind).toBe('ready'));
        expect(hook.getCurrent().selectedKey).toBe(JSON.stringify(['display-1', 'display']));
        await hook.unmount();
    });
});
