import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import {
    createActionOperationReentryRegistry,
    type NewSessionOperationReentryRegistration,
} from './actionOperationReentry';

const draftScope = { serverId: 'server-1', accountId: 'account-1' } as const;

function operation(state: ActionOperationSnapshotV1['state']): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        requestId: 'spawn-1',
        revision: state === 'accepted' ? 1 : 2,
        actionId: 'session.spawn_new',
        state,
        scope: { accountId: 'account-1', machineId: 'machine-1' },
        title: 'Create session',
        createdAt: 1,
        ...(state === 'succeeded'
            ? { settledAt: 2, result: { type: 'success', sessionId: 'session-1' } }
            : {}),
        ...(state === 'failed'
            ? { settledAt: 2, error: { errorCode: 'spawn_failed', error: 'Failed' } }
            : {}),
        ...(state === 'cancelled' ? { settledAt: 2 } : {}),
        cancellation: 'unsupported',
    };
}

function register(registry: ReturnType<typeof createActionOperationReentryRegistry>): NewSessionOperationReentryRegistration {
    return registry.registerNewSession({ requestId: 'spawn-1', draftScope });
}

describe('action operation state-aware re-entry', () => {
    it('reopens the existing scoped draft while spawn or outer setup remains actionable', () => {
        const registry = createActionOperationReentryRegistry();
        const registration = register(registry);
        const loadDraft = () => ({ launchUserAttemptId: 'attempt-1' });

        expect(registry.resolve(operation('running'), { loadDraft })).toEqual({
            kind: 'new_session',
            draftScope,
            operationId: 'operation-1',
        });

        registration.markSetupNeedsAttention('session-1');
        expect(registry.resolve(operation('succeeded'), { loadDraft })).toEqual({
            kind: 'new_session',
            draftScope,
            operationId: 'operation-1',
        });
        expect(registry.resolvePresentation(operation('succeeded'))).toEqual({
            kind: 'setup_needs_attention',
        });
    });

    it.each(['failed', 'cancelled'] as const)('reopens the editable form after %s', (state) => {
        const registry = createActionOperationReentryRegistry();
        register(registry);
        expect(registry.resolve(operation(state), { loadDraft: () => ({ input: 'kept' }) })).toEqual({
            kind: 'new_session',
            draftScope,
            operationId: 'operation-1',
        });
    });

    it('opens the created session only after the full New Session workflow succeeds', () => {
        const registry = createActionOperationReentryRegistry();
        const registration = register(registry);
        registration.markWorkflowComplete('session-1');

        expect(registry.resolve(operation('succeeded'), { loadDraft: () => null })).toEqual({
            kind: 'session',
            sessionId: 'session-1',
            serverId: 'server-1',
        });
    });

    it('falls back to standard detail when no retained origin can reconstruct a form', () => {
        const registry = createActionOperationReentryRegistry();
        register(registry);
        expect(registry.resolve(operation('running'), { loadDraft: () => null })).toEqual({ kind: 'detail' });
        expect(registry.resolve({ ...operation('running'), requestId: 'unknown' }, { loadDraft: () => ({}) })).toEqual({ kind: 'detail' });
    });

    it('keeps an actionable fork in operation detail and opens the child session after success', () => {
        const registry = createActionOperationReentryRegistry();
        const running = {
            ...operation('running'),
            actionId: 'session.fork',
            requestId: 'fork-request-1',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'parent-session' },
        };

        expect(registry.resolve(running)).toEqual({ kind: 'detail' });
        expect(registry.resolve({
            ...running,
            state: 'succeeded',
            settledAt: 2,
            result: { ok: true, childSessionId: 'child-session' },
        })).toEqual({
            kind: 'session',
            sessionId: 'child-session',
            serverId: null,
        });
    });

    it('keeps an actionable handoff in operation detail and opens its session after success', () => {
        const registry = createActionOperationReentryRegistry();
        const running = {
            ...operation('running'),
            actionId: 'session.handoff',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'handoff-session' },
        };

        expect(registry.resolve(running)).toEqual({ kind: 'detail' });
        expect(registry.resolve({
            ...running,
            state: 'succeeded',
            settledAt: 2,
            result: { ok: true, handoffId: 'handoff-1' },
        })).toEqual({
            kind: 'session',
            sessionId: 'handoff-session',
            serverId: null,
        });
    });

    it('uses standard detail when successful fork or handoff destination references are unavailable', () => {
        const registry = createActionOperationReentryRegistry();
        expect(registry.resolve({ ...operation('succeeded'), actionId: 'session.fork', result: { ok: true } })).toEqual({ kind: 'detail' });
        expect(registry.resolve({ ...operation('succeeded'), actionId: 'session.handoff' })).toEqual({ kind: 'detail' });
    });

    it('bounds retained request references without storing operation input', () => {
        const registry = createActionOperationReentryRegistry({ maxEntries: 2 });
        registry.registerNewSession({ requestId: 'one', draftScope });
        registry.registerNewSession({ requestId: 'two', draftScope });
        registry.registerNewSession({ requestId: 'three', draftScope });

        expect(registry.readRequestIds()).toEqual(['two', 'three']);
    });

    it('does not let a colliding request id reopen another account draft', () => {
        const registry = createActionOperationReentryRegistry();
        registry.registerNewSession({ requestId: 'shared-request', draftScope });
        registry.registerNewSession({
            requestId: 'shared-request',
            draftScope: { serverId: 'server-2', accountId: 'account-2' },
        });

        expect(registry.resolve({
            ...operation('running'),
            requestId: 'shared-request',
            scope: { accountId: 'account-1', machineId: 'machine-1' },
        }, { loadDraft: () => ({}) })).toEqual({ kind: 'new_session', draftScope, operationId: 'operation-1' });
        expect(registry.resolve({
            ...operation('running'),
            requestId: 'shared-request',
            scope: { accountId: 'account-3', machineId: 'machine-1' },
        }, { loadDraft: () => ({}) })).toEqual({ kind: 'detail' });
    });
});
