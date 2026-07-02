import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ConnectedServiceSwitchDeferralConflictError,
    createConnectedServiceSwitchDeferralQueue,
    type ConnectedServiceSwitchTarget,
} from './connectedServiceSwitchDeferralQueue';

function target(overrides: Partial<ConnectedServiceSwitchTarget> = {}): ConnectedServiceSwitchTarget {
    return {
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        generation: 5,
        ...overrides,
    };
}

describe('connectedServiceSwitchDeferralQueue', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('defers restart_resume until assistant-message-end when the session is mid-turn', async () => {
        const emitSessionEvent = vi.fn();
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
            emitSessionEvent,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'manual',
            target: target(),
            runSwitch,
        });

        expect(runSwitch).not.toHaveBeenCalled();
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferred',
            policy: 'defer_until_turn_boundary',
            awaitingBoundary: true,
            timeoutMs: 60_000,
        }));

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        await pending;

        expect(runSwitch).toHaveBeenCalledTimes(1);
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferral_completed',
            reason: 'completed_at_boundary',
        }));
    });

    it('defers automatic restarts while resumed provider work has an active task marker', async () => {
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });

        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target(),
            runSwitch,
        });

        expect(runSwitch).not.toHaveBeenCalled();

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        await pending;

        expect(runSwitch).toHaveBeenCalledTimes(1);
    });

    it('exposes current turn in-flight state for continuation eligibility', () => {
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
        });

        expect(queue.isTurnInFlight('sess_1')).toBe(false);

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        expect(queue.isTurnInFlight('sess_1')).toBe(true);

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        expect(queue.isTurnInFlight('sess_1')).toBe(false);
    });

    it('exposes lifecycle evidence so recovery can distinguish first-prompt retry from mid-turn continuation', () => {
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
        });

        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: false,
            lastEvent: null,
            hasProviderActivityThisTurn: false,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: true,
            lastEvent: 'prompt_or_steer',
            hasProviderActivityThisTurn: false,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });
        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: true,
            lastEvent: 'task_started',
            hasProviderActivityThisTurn: true,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: false,
            lastEvent: 'assistant_message_end',
            hasProviderActivityThisTurn: true,
        });
    });

    it('falls back to abort-and-restart exactly once when boundary timeout expires', async () => {
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'manual',
            target: target(),
            runSwitch,
        });

        vi.advanceTimersByTime(59_999);
        expect(runSwitch).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        await pending;

        expect(runSwitch).toHaveBeenCalledTimes(1);

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        expect(runSwitch).toHaveBeenCalledTimes(1);
    });

    it('bypasses deferral when HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL is enabled', async () => {
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: true,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        await queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'manual',
            target: target(),
            runSwitch,
        });

        expect(runSwitch).toHaveBeenCalledTimes(1);
    });

    it('treats turn cancellation as a real boundary completion instead of a cancelled switch', async () => {
        const emitSessionEvent = vi.fn();
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
            emitSessionEvent,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'manual',
            target: target(),
            runSwitch,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'turn_cancelled' });
        await pending;

        expect(runSwitch).toHaveBeenCalledTimes(1);
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferral_completed',
            reason: 'completed_at_boundary',
        }));
    });

    it('exposes the canonical turn lifecycle state for policy callers', () => {
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
        });

        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: false,
            lastEvent: null,
            hasProviderActivityThisTurn: false,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: true,
            lastEvent: 'prompt_or_steer',
            hasProviderActivityThisTurn: false,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        expect(queue.getTurnLifecycleState('sess_1')).toEqual({
            inFlight: false,
            lastEvent: 'assistant_message_end',
            hasProviderActivityThisTurn: false,
        });
    });

    it('coalesces same-target requests, cancels superseded requests, and rejects older generations', async () => {
        const emitSessionEvent = vi.fn();
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
            emitSessionEvent,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

        const first = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target({ generation: 5 }),
            runSwitch,
        });
        const coalesced = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target({ generation: 5 }),
            runSwitch,
        });
        const replacedByNewerGeneration = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target({ profileId: 'backup', generation: 6 }),
            runSwitch,
        });

        await expect(queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target({ profileId: 'older', generation: 4 }),
            runSwitch,
        })).rejects.toMatchObject({ code: 'group_generation_conflict' });

        const replacedByManual = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'manual',
            target: target({ profileId: 'manual', generation: 6 }),
            runSwitch,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        await expect(first).rejects.toMatchObject({ code: 'switch_cancelled' });
        await expect(coalesced).rejects.toMatchObject({ code: 'switch_cancelled' });
        await expect(replacedByNewerGeneration).rejects.toMatchObject({ code: 'switch_cancelled' });
        await expect(replacedByManual).resolves.toBeUndefined();

        expect(runSwitch).toHaveBeenCalledTimes(1);
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferral_superseded',
        }));
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferral_completed',
            reason: 'switch_cancelled',
        }));
    });

    it('defers quota pre-turn switchUntilIdle and runs before the next forwardable turn when idle is reached', async () => {
        const emitSessionEvent = vi.fn();
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
            emitSessionEvent,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });

        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_idle',
            source: 'automatic',
            target: target(),
            runSwitch,
        });

        expect(runSwitch).not.toHaveBeenCalled();
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferred',
            policy: 'defer_until_idle',
            awaitingBoundary: false,
        }));

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        expect(runSwitch).not.toHaveBeenCalled();

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
        await pending;
        expect(runSwitch).toHaveBeenCalledTimes(1);
    });

    it('settles a pending switch on session_restarting without emitting a cancelled/terminated event', async () => {
        const emitSessionEvent = vi.fn();
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
            emitSessionEvent,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target(),
            runSwitch,
        });

        queue.cancelSession('sess_1', 'session_restarting');
        await expect(pending).resolves.toBeUndefined();
        expect(runSwitch).not.toHaveBeenCalled();
        expect(emitSessionEvent).not.toHaveBeenCalledWith(
            'sess_1',
            expect.objectContaining({ type: 'connected_service_account_switch_deferral_completed' }),
        );
    });

    it('cancels pending switches on session termination and daemon shutdown with completion reasons', async () => {
        const emitSessionEvent = vi.fn();
        const runSwitch = vi.fn(async () => {});
        const queue = createConnectedServiceSwitchDeferralQueue({
            timeoutMs: 60_000,
            disableDeferral: false,
            emitSessionEvent,
        });

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
        const pending = queue.requestSwitch({
            sessionId: 'sess_1',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target(),
            runSwitch,
        });

        queue.cancelSession('sess_1', 'session_terminated');
        await expect(pending).rejects.toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);
        expect(runSwitch).not.toHaveBeenCalled();

        queue.recordTurnLifecycleEvent({ sessionId: 'sess_2', event: 'prompt_or_steer' });
        const pendingSecond = queue.requestSwitch({
            sessionId: 'sess_2',
            policy: 'defer_until_turn_boundary',
            source: 'automatic',
            target: target({ serviceId: 'anthropic' }),
            runSwitch,
        });
        queue.cancelAll('daemon_shutdown');
        await expect(pendingSecond).rejects.toBeInstanceOf(ConnectedServiceSwitchDeferralConflictError);

        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_account_switch_deferral_completed',
            reason: 'session_terminated',
        }));
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_2', expect.objectContaining({
            type: 'connected_service_account_switch_deferral_completed',
            reason: 'daemon_shutdown',
        }));
    });
});
