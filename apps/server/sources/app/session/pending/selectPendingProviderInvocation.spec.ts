import { describe, expect, it, vi } from 'vitest';

import { selectPendingProviderInvocation } from './selectPendingProviderInvocation';

const row = (localId: string, kind: 'enqueue' | 'steer_if_active' | 'steer_now' | 'send_now', position: number) => ({
    localId,
    position,
    requestedAction: { v: 1 as const, kind },
});

describe('selectPendingProviderInvocation', () => {
    it('reads Runtime Activity only after the FIFO action requires idle admission', () => {
        const readRuntimeActivity = vi.fn(() => 'idle' as const);
        const select = (kind: 'enqueue' | 'send_now') => selectPendingProviderInvocation({
            rows: [row('x', kind, 1)],
            foregroundState: 'ready',
            deliveryTiming: 'after_runtime_idle',
            readRuntimeActivity,
        });

        expect(select('send_now')).toEqual({ localId: 'x', providerAction: 'send' });
        expect(readRuntimeActivity).not.toHaveBeenCalled();

        expect(select('enqueue')).toEqual({ localId: 'x', providerAction: 'send' });
        expect(readRuntimeActivity).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['send_now', 'active_unsteerable', { localId: 'selected', providerAction: 'interrupt_and_send' }],
        ['steer_now', 'active_steerable', { localId: 'selected', providerAction: 'steer' }],
        ['steer_if_active', 'active_steerable', { localId: 'selected', providerAction: 'steer' }],
    ] as const)('selects the exact later %s row while its ordinary FIFO neighbor remains queued', (
        kind,
        foregroundState,
        expected,
    ) => {
        expect(selectPendingProviderInvocation({
            rows: [row('fifo', 'enqueue', 1), row('selected', kind, 2)],
            foregroundState,
            deliveryTiming: 'after_runtime_idle',
            readRuntimeActivity: () => 'active',
        })).toEqual(expected);
    });

    it('treats a later steer-if-active row as exact only while the foreground is steerable', () => {
        const rows = [row('fifo', 'enqueue', 1), row('selected', 'steer_if_active', 2)];
        expect(selectPendingProviderInvocation({
            rows,
            foregroundState: 'active_steerable',
            deliveryTiming: 'after_runtime_idle',
            readRuntimeActivity: () => 'active',
        })).toEqual({ localId: 'selected', providerAction: 'steer' });
        expect(selectPendingProviderInvocation({
            rows,
            foregroundState: 'ready',
            deliveryTiming: 'after_foreground_ready',
            readRuntimeActivity: () => 'idle',
        })).toEqual({ localId: 'fifo', providerAction: 'send' });
    });

    it('rejects malformed non-null row actions instead of executing them as ordinary enqueue', () => {
        expect(() => selectPendingProviderInvocation({
            rows: [{ localId: 'bad', position: 1, requestedAction: { v: 1, kind: 'interrupt_and_send' } }],
            foregroundState: 'ready',
            deliveryTiming: 'after_foreground_ready',
            readRuntimeActivity: () => 'idle',
        })).toThrow('Malformed non-null Pending requested action');
    });

    it('does not let a malformed later action prevent the valid FIFO head from materializing', () => {
        expect(selectPendingProviderInvocation({
            rows: [
                row('head', 'enqueue', 1),
                { localId: 'later-bad', position: 2, requestedAction: { v: 1, kind: 'future_action' } },
            ],
            foregroundState: 'ready',
            deliveryTiming: 'after_foreground_ready',
            readRuntimeActivity: () => 'idle',
        })).toEqual({ localId: 'head', providerAction: 'send' });
    });

    it.each([
        ['enqueue', 'ready', 'after_foreground_ready', false, { localId: 'x', providerAction: 'send' }],
        ['enqueue', 'ready', 'after_runtime_idle', true, { localId: 'x', providerAction: 'send' }],
        ['enqueue', 'ready', 'after_runtime_idle', false, { deferredReason: 'waiting_for_runtime_activity' }],
        ['enqueue', 'active_steerable', 'after_foreground_ready', true, { deferredReason: 'waiting_for_foreground_turn' }],
        ['steer_if_active', 'active_steerable', 'after_runtime_idle', false, { localId: 'x', providerAction: 'steer' }],
        ['steer_if_active', 'ready', 'after_foreground_ready', false, { localId: 'x', providerAction: 'send' }],
        ['steer_if_active', 'ready', 'after_runtime_idle', false, { deferredReason: 'waiting_for_runtime_activity' }],
        ['steer_now', 'active_steerable', 'after_runtime_idle', false, { localId: 'x', providerAction: 'steer' }],
        ['steer_now', 'ready', 'after_runtime_idle', false, { blockedLocalId: 'x', blockedReason: 'steering_unavailable' }],
        ['steer_now', 'active_unsteerable', 'after_runtime_idle', false, { blockedLocalId: 'x', blockedReason: 'steering_unavailable' }],
        ['send_now', 'active_steerable', 'after_runtime_idle', false, { localId: 'x', providerAction: 'interrupt_and_send' }],
        ['send_now', 'active_unsteerable', 'after_runtime_idle', false, { localId: 'x', providerAction: 'interrupt_and_send' }],
        ['send_now', 'ready', 'after_runtime_idle', false, { localId: 'x', providerAction: 'send' }],
    ] as const)(
        '%s with %s foreground, %s timing, and activity-idle=%s resolves at the Pending owner',
        (kind, foregroundState, deliveryTiming, runtimeActivityIdle, expected) => {
            expect(selectPendingProviderInvocation({
                rows: [row('x', kind, 1)],
                foregroundState,
                deliveryTiming,
                readRuntimeActivity: () => runtimeActivityIdle ? 'idle' : 'active',
            })).toEqual(expected);
        },
    );

    it('returns no pending row for an empty queue', () => {
        expect(selectPendingProviderInvocation({
            rows: [],
            foregroundState: 'ready',
            deliveryTiming: 'after_foreground_ready',
            readRuntimeActivity: () => 'idle',
        })).toEqual({ deferredReason: 'no_pending' });
    });

    it('distinguishes active Activity from unknown or unavailable Activity', () => {
        const params = {
            rows: [row('x', 'enqueue', 1)],
            foregroundState: 'ready' as const,
            deliveryTiming: 'after_runtime_idle' as const,
        };
        expect(selectPendingProviderInvocation({ ...params, readRuntimeActivity: () => 'active' }))
            .toEqual({ deferredReason: 'waiting_for_runtime_activity' });
        expect(selectPendingProviderInvocation({ ...params, readRuntimeActivity: () => 'unknown' }))
            .toEqual({ deferredReason: 'runtime_activity_unknown' });
    });

    it('lets an exact later action bypass an unresolved blocked queue predecessor', () => {
        expect(selectPendingProviderInvocation({
            rows: [
                { ...row('uncertain', 'enqueue', 1), deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain' },
                row('urgent', 'send_now', 2),
            ],
            foregroundState: 'ready',
            deliveryTiming: 'after_foreground_ready',
            readRuntimeActivity: () => 'idle',
        })).toEqual({ localId: 'urgent', providerAction: 'send' });
    });

    it.each(['send_now', 'steer_now'] as const)(
        'keeps a later %s row behind a delivering queue head',
        (kind) => {
            expect(selectPendingProviderInvocation({
                rows: [
                    { ...row('claimed', 'enqueue', 1), deliveryState: 'delivering' },
                    row('urgent', kind, 2),
                ],
                foregroundState: 'active_steerable',
                deliveryTiming: 'after_foreground_ready',
                readRuntimeActivity: () => 'idle',
            })).toEqual({ deferredReason: 'waiting_for_predecessor' });
        },
    );
});
