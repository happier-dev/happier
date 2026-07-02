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

const now = 1_000_000;

function busyModeChangeSession(overrides?: Record<string, unknown>) {
    return {
        thinking: true,
        thinkingAt: now,
        active: true,
        presence: 'online',
        agentStateVersion: 1,
        agentState: {
            controlledByUser: false,
            capabilities: { inFlightSteer: true },
        },
        pendingVersion: 0,
        pendingCount: 0,
        metadata: { permissionMode: 'default', flavor: 'claude' },
        permissionMode: 'plan',
        permissionModeUpdatedAt: now,
        ...overrides,
    } as any;
}

function baseOpts(overrides?: Record<string, unknown>) {
    return {
        session: busyModeChangeSession(),
        agentId: 'claude' as const,
        text: 'do the thing',
        configuredMode: 'agent_queue' as const,
        busySteerSendPolicy: 'steer_immediately' as const,
        permissionModeApplyTiming: 'current_turn' as const,
        nonSteerableSendPrompt: 'on' as const,
        nowMs: now,
        ...overrides,
    };
}

async function resolvePlan(overrides?: Record<string, unknown>) {
    const { resolveNonSteerableSendPlan } = await import('./nonSteerableSendPreflight');
    return resolveNonSteerableSendPlan(baseOpts(overrides) as any);
}

async function resolvePlanWithChoice(
    overrides: Record<string, unknown> | undefined,
    buttonText: string,
) {
    const { resolveNonSteerableSendPlan } = await import('./nonSteerableSendPreflight');
    const planPromise = resolveNonSteerableSendPlan(baseOpts(overrides) as any);
    await Promise.resolve();
    expect(alertAsyncMock).toHaveBeenCalledTimes(1);
    const buttons = alertAsyncMock.mock.calls[0]?.[2] as unknown as AlertButton[];
    const button = buttons.find((b) => b.text === buttonText);
    expect(button, `button ${buttonText} in ${buttons.map((b) => b.text).join(', ')}`).toBeTruthy();
    button?.onPress?.();
    return planPromise;
}

describe('resolveNonSteerableSendPlan (G4 busy-send preflight)', () => {
    beforeEach(() => {
        alertAsyncMock.mockClear();
    });

    it('proceeds silently when the prompt setting is off', async () => {
        const plan = await resolvePlan({ nonSteerableSendPrompt: 'off' });
        expect(plan).toEqual({ kind: 'proceed' });
        expect(alertAsyncMock).not.toHaveBeenCalled();
    });

    it('proceeds silently for force-immediate sends (explicit user intent)', async () => {
        const plan = await resolvePlan({ forceImmediate: true });
        expect(plan).toEqual({ kind: 'proceed' });
        expect(alertAsyncMock).not.toHaveBeenCalled();
    });

    it('proceeds silently for explicit queue-to-pending intent', async () => {
        const plan = await resolvePlan({ explicitPendingIntent: true });
        expect(plan).toEqual({ kind: 'proceed' });
        expect(alertAsyncMock).not.toHaveBeenCalled();
    });

    it('proceeds silently when the session is idle (no blocker)', async () => {
        const plan = await resolvePlan({
            session: busyModeChangeSession({ thinking: false, thinkingAt: 0 }),
        });
        expect(plan).toEqual({ kind: 'proceed' });
        expect(alertAsyncMock).not.toHaveBeenCalled();
    });

    it('proceeds silently when the mode change is stale (pre-turn) — X2 freshness gate', async () => {
        const plan = await resolvePlan({
            session: busyModeChangeSession({ permissionModeUpdatedAt: now - 10 }),
        });
        expect(plan).toEqual({ kind: 'proceed' });
        expect(alertAsyncMock).not.toHaveBeenCalled();
    });

    it('queue choice proceeds with no flags (decision layer queues honestly)', async () => {
        const plan = await resolvePlanWithChoice(undefined, 'agentInput.nonSteerableSend.queueForAfterTurn');
        expect(plan).toEqual({ kind: 'proceed' });
    });

    it('interrupt choice proceeds with explicit interrupt mode', async () => {
        const plan = await resolvePlanWithChoice(undefined, 'agentInput.nonSteerableSend.interruptAndSend');
        expect(plan).toEqual({ kind: 'proceed', explicitMode: 'interrupt' });
    });

    it('cancel choice cancels the send', async () => {
        const plan = await resolvePlanWithChoice(undefined, 'common.cancel');
        expect(plan).toEqual({ kind: 'cancelled' });
    });

    it('never offers apply-and-steer when the capability is not published (fail-closed)', async () => {
        await resolvePlanWithChoice(undefined, 'common.cancel');
        const buttons = alertAsyncMock.mock.calls[0]?.[2] as unknown as AlertButton[];
        expect(buttons.map((b) => b.text)).not.toContain('agentInput.nonSteerableSend.applySettingAndSteer');
        expect(buttons.map((b) => b.text)).not.toContain('agentInput.nonSteerableSend.applyNamedSettingAndSteer');
    });

    it('apply-and-steer choice carries the in-turn apply flag when the capability is published', async () => {
        const plan = await resolvePlanWithChoice(
            {
                session: busyModeChangeSession({
                    agentState: {
                        controlledByUser: false,
                        capabilities: { inFlightSteer: true, inFlightConfigApplySupported: true },
                    },
                }),
            },
            // The mode-change blocker provides setting/value labels, so the named variant is used.
            'agentInput.nonSteerableSend.applyNamedSettingAndSteer',
        );
        expect(plan).toEqual({ kind: 'proceed', applyConfigAndSteer: true });
    });

    it('steer-without-applying choice defers the config and rides the published mode', async () => {
        const plan = await resolvePlanWithChoice(undefined, 'agentInput.nonSteerableSend.steerWithoutApplying');
        expect(plan).toEqual({
            kind: 'proceed',
            steerWithoutConfig: true,
            steerWithoutConfigMetaOverrides: { permissionMode: 'default' },
        });
    });

    it('special commands offer only queue/interrupt/cancel', async () => {
        const plan = await resolvePlanWithChoice(
            { text: '/clear' },
            'agentInput.nonSteerableSend.queueForAfterTurn',
        );
        const [, message, buttons] = alertAsyncMock.mock.calls[0] as unknown as [string, string, AlertButton[]];
        expect(message).toBe('agentInput.nonSteerableSend.specialCommandMessage');
        expect(buttons.map((b) => b.text)).toEqual([
            'agentInput.nonSteerableSend.queueForAfterTurn',
            'agentInput.nonSteerableSend.interruptAndSend',
            'common.cancel',
        ]);
        expect(plan).toEqual({ kind: 'proceed' });
    });
});
