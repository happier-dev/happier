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
    it('keeps ordinary idle input durable with the enqueue action', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: idle, nowMs: now })).toMatchObject({
            mode: 'server_pending',
            requestedAction: { v: 1, kind: 'enqueue' },
        });
    });

    it('uses steer_if_active only when the live capability says steering is available', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: steerable, nowMs: now })).toMatchObject({
            requestedAction: { v: 1, kind: 'steer_if_active' },
        });
        expect(decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            session: { ...steerable, agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: false } } },
            nowMs: now,
        })).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' } });
    });

    it('maps force-immediate and interrupt to explicit urgent actions', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: steerable, nowMs: now, forceImmediate: true }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'steer_now' } });
        expect(decideSessionMessageDelivery({ configuredMode: 'interrupt', session: idle, nowMs: now }))
            .toMatchObject({ mode: 'server_pending', requestedAction: { v: 1, kind: 'send_now' } });
    });

    it('uses send_now for inactive sessions so wake can consume the same row', () => {
        expect(decideSessionMessageDelivery({ configuredMode: 'agent_queue', session: { ...idle, active: false }, nowMs: now }))
            .toMatchObject({ requestedAction: { v: 1, kind: 'send_now' } });
    });
});
