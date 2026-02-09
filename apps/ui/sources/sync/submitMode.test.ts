import { describe, expect, it } from 'vitest';

import { chooseSubmitMode } from './submitMode';

describe('chooseSubmitMode', () => {
    it('preserves interrupt mode', () => {
        expect(chooseSubmitMode({
            configuredMode: 'interrupt',
            session: { metadata: {} } as any,
        })).toBe('interrupt');
    });

    it('preserves explicit server_pending mode', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            session: { metadata: {} } as any,
        })).toBe('server_pending');
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
