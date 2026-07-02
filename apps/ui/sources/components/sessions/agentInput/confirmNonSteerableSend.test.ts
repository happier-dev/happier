import type { IModal } from '@/modal';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AlertButton = { text: string; style?: string; onPress?: () => void };

const alertAsyncMock = vi.hoisted(() => vi.fn<IModal['alertAsync']>(() => new Promise<void>(() => {})));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alertAsync: alertAsyncMock,
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('confirmNonSteerableSend (G4 busy-send honesty affordance)', () => {
    beforeEach(() => {
        alertAsyncMock.mockClear();
    });

    async function present(
        reason: 'mode_change_refused' | 'special_command' | 'provider_config_change_refused',
        opts?: Record<string, unknown>,
    ) {
        const { confirmNonSteerableSend } = await import('./confirmNonSteerableSend');
        const promise = confirmNonSteerableSend(reason, opts);
        await Promise.resolve();
        expect(alertAsyncMock).toHaveBeenCalledTimes(1);
        const [title, message, buttons] = alertAsyncMock.mock.calls[0] as unknown as [string, string, AlertButton[]];
        return { promise, title, message, buttons };
    }

    it('offers Queue / Interrupt & send / cancel and resolves queue', async () => {
        const { promise, title, message, buttons } = await present('mode_change_refused');
        expect(title).toBe('agentInput.nonSteerableSend.title');
        expect(message).toBe('agentInput.nonSteerableSend.modeChangeMessage');
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
        buttons[0]?.onPress?.();
        await expect(promise).resolves.toBe('queue');
    });

    it('resolves interrupt_and_send for the interrupt action', async () => {
        const { promise, buttons } = await present('mode_change_refused');
        buttons[1]?.onPress?.();
        await expect(promise).resolves.toBe('interrupt_and_send');
    });

    it('uses the special-command copy and resolves cancel on the cancel action', async () => {
        const { promise, message, buttons } = await present('special_command');
        expect(message).toBe('agentInput.nonSteerableSend.specialCommandMessage');
        buttons[2]?.onPress?.();
        await expect(promise).resolves.toBe('cancel');
    });

    it('uses the provider-config copy for provider-owned blockers', async () => {
        const { message } = await present('provider_config_change_refused');
        expect(message).toBe('agentInput.nonSteerableSend.providerConfigMessage');
    });

    it('resolves cancel when the alert is dismissed without a button press', async () => {
        alertAsyncMock.mockImplementationOnce(async () => {});
        const { confirmNonSteerableSend } = await import('./confirmNonSteerableSend');
        await expect(confirmNonSteerableSend('mode_change_refused')).resolves.toBe('cancel');
    });

    it('offers "Apply setting & steer now" first when the backend published in-flight config apply', async () => {
        const { promise, buttons } = await present('mode_change_refused', { offerApplyAndSteer: true });
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.applySettingAndSteer',
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
        buttons[0]?.onPress?.();
        await expect(promise).resolves.toBe('apply_and_steer');
    });

    it('never offers the apply option for special commands', async () => {
        const { buttons } = await present('special_command', { offerApplyAndSteer: true });
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
    });

    it('names the setting and value on the apply option when labels are provided', async () => {
        const { promise, buttons } = await present('mode_change_refused', {
            offerApplyAndSteer: true,
            settingLabel: 'Permission mode',
            valueLabel: 'Plan',
        });
        expect(buttons[0]?.text).toBe('agentInput.nonSteerableSend.applyNamedSettingAndSteer');
        buttons[0]?.onPress?.();
        await expect(promise).resolves.toBe('apply_and_steer');
    });

    it('offers "Steer now without applying" for a mode change whenever steering itself is safe', async () => {
        const { promise, buttons } = await present('mode_change_refused', {
            offerApplyAndSteer: true,
            offerSteerWithoutApplying: true,
        });
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.applySettingAndSteer',
            'agentInput.nonSteerableSend.steerWithoutApplying',
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
        buttons[1]?.onPress?.();
        await expect(promise).resolves.toBe('steer_without_applying');
    });

    it('offers the defer option even when in-flight apply is unsupported (its main value)', async () => {
        const { promise, buttons } = await present('mode_change_refused', {
            offerSteerWithoutApplying: true,
        });
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.steerWithoutApplying',
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
        buttons[0]?.onPress?.();
        await expect(promise).resolves.toBe('steer_without_applying');
    });

    it('never offers the defer option for special commands (the text IS the command)', async () => {
        const { buttons } = await present('special_command', {
            offerSteerWithoutApplying: true,
        });
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
    });
});
