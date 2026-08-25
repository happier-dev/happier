import { describe, expect, it } from 'vitest';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

import {
    classifyActionOperationSection,
    readActionOperationDestinationSessionId,
    readActionOperationDestinationServerId,
    readActionOperationPluginIdentity,
    resolveActionOperationStatus,
} from './actionOperationPresentation';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];

function operation(overrides: Partial<ActionOperationSnapshot> = {}): ActionOperationSnapshot {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'plugin.example.deploy',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1' },
        title: 'Deploy preview',
        createdAt: 1_000,
        startedAt: 1_010,
        cancellation: 'unsupported',
        ...overrides,
    };
}

describe('action operation inbox presentation', () => {
    it('groups active, attention, and recent operations without treating reconnecting as failure', () => {
        expect(classifyActionOperationSection(operation())).toBe('inProgress');
        expect(classifyActionOperationSection(operation(), 'unavailable')).toBe('needsAttention');
        expect(classifyActionOperationSection(operation(), 'reconnecting')).toBe('inProgress');
        expect(classifyActionOperationSection(operation({
            state: 'failed',
            settledAt: 2_000,
            error: { errorCode: 'handler_failed', error: 'Deployment failed' },
        }))).toBe('needsAttention');
        expect(classifyActionOperationSection(operation({ state: 'cancelled', settledAt: 2_000 }))).toBe('needsAttention');
        expect(classifyActionOperationSection(operation({ state: 'succeeded', settledAt: 2_000 }))).toBe('recent');

        expect(resolveActionOperationStatus(operation(), 'reconnecting')).toEqual({
            tone: 'muted',
            label: { kind: 'host', value: 'reconnecting' },
        });
        expect(resolveActionOperationStatus(operation({
            state: 'failed',
            settledAt: 2_000,
            error: { errorCode: 'handler_failed', error: 'Deployment failed' },
        }), 'unavailable')).toEqual({ tone: 'danger', label: { kind: 'host', value: 'failed' } });
    });

    it('offers an explicit session destination only for successful core operation results', () => {
        expect(readActionOperationDestinationSessionId(operation({
            actionId: 'session.fork',
            state: 'succeeded',
            settledAt: 2_000,
            result: { ok: true, childSessionId: 'child-session' },
        }))).toBe('child-session');
        expect(readActionOperationDestinationSessionId(operation({
            actionId: 'session.spawn_new',
            state: 'succeeded',
            settledAt: 2_000,
            result: { sessionId: 'spawned-session' },
        }))).toBe('spawned-session');
        expect(readActionOperationDestinationServerId(operation({
            actionId: 'session.spawn_new',
            state: 'succeeded',
            settledAt: 2_000,
            result: {
                sessionId: 'spawned-session',
                executionTarget: { serverId: 'server-b', machineId: 'machine-1' },
            },
        }))).toBe('server-b');
        expect(readActionOperationDestinationSessionId(operation({
            actionId: 'session.handoff',
            state: 'succeeded',
            settledAt: 2_000,
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'same-session' },
        }))).toBe('same-session');
        expect(readActionOperationDestinationSessionId(operation({
            actionId: 'plugin.example.deploy',
            state: 'succeeded',
            settledAt: 2_000,
            result: { sessionId: 'not-a-host-owned-destination' },
        }))).toBeNull();
    });

    it('derives plugin identity without treating core session actions as plugins', () => {
        expect(readActionOperationPluginIdentity('acme.preview/deploy')).toBe('acme.preview');
        expect(readActionOperationPluginIdentity('session.fork')).toBeNull();
    });
});
