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
