import { resolveSessionComposerSendActions } from './submitMode';
import { describe, expect, it } from 'vitest';

import { decideSessionMessageDelivery } from './submitMode';

const now = 1_000_000;
const idle = {
    active: true,
    presence: 'online',
    agentStateVersion: 1,
    pendingVersion: 0,
    pendingCount: 0,
    metadata: {},
    thinking: false,
} as any;
const steerable = {
    ...idle,
    thinking: true,
    thinkingAt: now,
    agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
} as any;

describe('decideSessionMessageDelivery row actions', () => {
    it('offers busy steering to a running Session before its live presence is observed (fresh client)', () => {
        const fresh = { ...steerable, presence: undefined, pendingVersion: 2, metadata: { version: '999.0.0' } };
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: fresh, nowMs: now }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'steer_if_active' } });
        expect(resolveSessionComposerSendActions({ session: fresh, configuredMode: 'agent_queue', nowMs: now }).modes)
            .toContain('agent_queue');
        // An observed detach keeps the offline path.
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: { ...fresh, presence: 0 }, nowMs: now }))
            .toMatchObject({ reason: 'offline_pending' });
    });

    it('treats an active online runtime with unchanged empty AgentState as ready for ordinary input', () => {
        expect(decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            session: { ...idle, agentStateVersion: 0, agentState: {} },
            nowMs: now,
        })).toMatchObject({
            mode: 'server_pending',
            reason: 'configured_pending',
            requestedAction: { v: 1, kind: 'enqueue' },
        });
    });

    it('derives the alternate send from the saved busy-turn policy and queue availability', () => {
        const session = { ...steerable, pendingVersion: 2, metadata: { version: '999.0.0' } };
        expect(resolveSessionComposerSendActions({ session, configuredMode: 'server_pending', busySteerSendPolicy: 'server_pending', nowMs: now }))
            .toMatchObject({ alternateMode: 'agent_queue', modes: ['agent_queue', 'server_pending', 'interrupt'] });
        expect(resolveSessionComposerSendActions({ session, configuredMode: 'server_pending', busySteerSendPolicy: 'steer_immediately', nowMs: now }))
            .toMatchObject({ alternateMode: 'server_pending' });
        expect(resolveSessionComposerSendActions({ session: { ...session, metadata: { version: '0.0.1' } }, configuredMode: 'agent_queue', busySteerSendPolicy: 'steer_immediately', nowMs: now }))
            .toMatchObject({ alternateMode: 'agent_queue', modes: ['agent_queue'] });
    });

    it('preserves an explicit steer choice across the foreground ready boundary without interrupting', () => {
        const session = steerable;
        const options = { configuredMode: 'interrupt' as const, explicitMode: 'agent_queue' as const,
            busySteerSendPolicy: 'server_pending' as const, session, nowMs: now };
        expect(decideSessionMessageDelivery(options)).toMatchObject({
            mode: 'server_pending', requestedAction: { v: 1, kind: 'steer_now' },
        });
        expect(decideSessionMessageDelivery({ ...options, session: { ...session, thinking: false } })).toMatchObject({
            mode: 'server_pending', requestedAction: { v: 1, kind: 'steer_now' },
        });
        expect(decideSessionMessageDelivery({ ...options, text: '/clear' })).toMatchObject({
            mode: 'server_pending', requestedAction: { v: 1, kind: 'enqueue' },
        });
    });

    it('keeps ordinary idle input durable with the enqueue action', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: idle, nowMs: now })).toMatchObject({
            mode: 'server_pending',
            requestedAction: { v: 1, kind: 'enqueue' },
        });
    });

    it.each(['agent_queue', 'server_pending'] as const)('honors busy steering with %s only when the live capability is available', (configuredMode) => {
        expect(decideSessionMessageDelivery({ configuredMode, session: steerable, nowMs: now })).toMatchObject({
            requestedAction: { v: 1, kind: 'steer_if_active' },
        });
        expect(decideSessionMessageDelivery({
            configuredMode,
            session: { ...steerable, agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: false } } },
            nowMs: now,
        })).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({
            configuredMode,
            explicitMode: 'server_pending',
            session: steerable,
            nowMs: now,
        })).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({
            configuredMode,
            busySteerSendPolicy: 'server_pending',
            session: steerable,
            nowMs: now,
        })).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
    });

    it('maps force-immediate and interrupt to explicit urgent actions', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: steerable, nowMs: now, forceImmediate: true }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'steer_now' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'interrupt', session: idle, nowMs: now }))
            .toMatchObject({ mode: 'server_pending', requestedAction: { v: 1, kind: 'send_now' } });
    });

    it('defaults inactive sessions to an enqueue row without durable activation', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: { ...idle, active: false }, nowMs: now }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
    });

    it('keeps inactive and offline ordinary input FIFO unless explicitly immediate', () => {
        const inactive = { ...idle, active: false, presence: 0 };
        const offline = { ...idle, presence: 0 };

        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: inactive, nowMs: now }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: inactive, nowMs: now, sessionInactiveResumePolicy: 'when_available' }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: inactive, nowMs: now, sessionInactiveResumePolicy: 'manual' }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: offline, nowMs: now, sessionInactiveResumePolicy: 'when_available' }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: offline, nowMs: now, sessionInactiveResumePolicy: 'online_only' }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', explicitMode: 'server_pending', session: offline, nowMs: now }))
            .toMatchObject({ reason: 'offline_pending', requestedAction: { v: 1, kind: 'enqueue' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: { ...steerable, presence: 0 }, nowMs: now }))
            .toMatchObject({ reason: 'offline_pending', requestedAction: { v: 1, kind: 'enqueue' } });
    });
});
