import { describe, expect, it } from 'vitest';

import { chooseSubmitMode } from './submitMode';

describe('chooseSubmitMode', () => {
    it('preserves interrupt mode', () => {
        expect(chooseSubmitMode({
            configuredMode: 'interrupt',
            session: { metadata: {} } as any,
        })).toBe('interrupt');
    });

    it('falls back to agent_queue when configuredMode=server_pending but the server does not support pending', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            session: { metadata: {} } as any,
        })).toBe('agent_queue');
    });

    it('preserves explicit server_pending mode when pending is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            session: {
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('uses agent_queue while thinking when configuredMode=server_pending and in-flight steer is supported and the session is online+ready', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            busySteerSendPolicy: 'steer_immediately',
            session: {
                thinking: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('prefers server_pending while controlledByUser when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                agentState: { controlledByUser: true },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending while thinking when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('keeps agent_queue while thinking when in-flight steer is supported and the session is online+ready', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('prefers server_pending while thinking when in-flight steer is supported but the user prefers server_pending', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'server_pending',
            session: {
                thinking: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        } as any)).toBe('server_pending');
    });

    it('prefers server_pending when the session is offline but queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 0,
                agentStateVersion: 0,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending when the agent is not ready but queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 'online',
                agentStateVersion: 0,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('keeps agent_queue if queue is not supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('keeps agent_queue when pending is supported but the CLI version is too old (prevents stranded pending)', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 0,
                agentStateVersion: 0,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: { version: '0.0.1' },
            } as any,
        })).toBe('agent_queue');
    });
});
