import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import type { SessionDraftLocalSupplement } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    createActionOperationReentryRegistry,
    resolvePersistedNewSessionOperationIdentity,
    type NewSessionOperationReentryRegistration,
} from './actionOperationReentry';

const draftScope = { serverId: 'server-1', accountId: 'account-1' } as const;
const draftId = '8e0a5dd1-b1df-43dd-b51e-b7787b30362e';

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
    const registration = registry.registerNewSession({ requestId: 'spawn-1', draftScope, draftId });
    if (!registration) throw new Error('expected workflow registration');
    return registration;
}

describe('action operation state-aware re-entry', () => {
    it('allows only one live outer workflow owner and permits reentry after that owner releases', () => {
        const registry = createActionOperationReentryRegistry();
        const first = register(registry);

        expect(registry.canAutomaticallyReenterNewSession(operation('succeeded'))).toBe(false);
        expect(registry.registerNewSession({ requestId: 'spawn-1', draftScope, draftId })).toBeNull();

        first.release();
        expect(registry.canAutomaticallyReenterNewSession(operation('succeeded'))).toBe(true);
        expect(registry.registerNewSession({ requestId: 'spawn-1', draftScope, draftId })).not.toBeNull();
    });

    it('does not automatically rerun a workflow already completed or left for explicit setup retry', () => {
        const registry = createActionOperationReentryRegistry();
        const setup = register(registry);
        setup.markSetupNeedsAttention('session-1');
        setup.release();
        expect(registry.canAutomaticallyReenterNewSession(operation('succeeded'))).toBe(false);

        const manualRetry = register(registry);
        manualRetry.markWorkflowComplete('session-1');
        manualRetry.release();
        expect(registry.canAutomaticallyReenterNewSession(operation('succeeded'))).toBe(false);
    });
    it('reattaches a normal new-session screen from persisted draft and custody identities after reload', () => {
        expect(resolvePersistedNewSessionOperationIdentity({
            draftScope,
            draftId,
            draft: {
                launchUserAttemptId: 'attempt-1',
                launchCurrentnessCapture: {
                    userAttemptId: 'attempt-1',
                    currentness: {
                        address: { kind: 'newSession', draftId },
                        mutationIds: { 'composer.text': 'mutation-1' },
                    },
                },
            },
            operations: [operation('running')],
            findCustody: () => ({
                v: 2,
                scope: draftScope,
                machineId: 'machine-1',
                targetFingerprint: 'target-1',
                userAttemptId: 'attempt-1',
                nonce: 'spawn-1',
                phase: 'spawning',
                createdSessionId: null,
                firstTurnLocalId: 'first-turn-1',
                attachmentMessageLocalId: 'attachments-1',
            }),
        })).toMatchObject({
            operation: { operationId: 'operation-1', state: 'running' },
            custody: { userAttemptId: 'attempt-1', nonce: 'spawn-1' },
            launchCurrentness: { mutationIds: { 'composer.text': 'mutation-1' } },
        });
    });

    it('does not reattach a persisted launch across account, machine, or request identity', () => {
        const custody = {
            v: 2 as const,
            scope: draftScope,
            machineId: 'machine-1',
            targetFingerprint: 'target-1',
            userAttemptId: 'attempt-1',
            nonce: 'spawn-1',
            phase: 'spawning' as const,
            createdSessionId: null,
            firstTurnLocalId: 'first-turn-1',
            attachmentMessageLocalId: 'attachments-1',
        };
        const resolve = (candidate: ActionOperationSnapshotV1) => resolvePersistedNewSessionOperationIdentity({
            draftScope,
            draftId,
            draft: { launchUserAttemptId: 'attempt-1' },
            operations: [candidate],
            findCustody: () => custody,
        });

        expect(resolve({ ...operation('running'), requestId: 'other-request' })).toBeNull();
        expect(resolve({
            ...operation('running'),
            scope: { accountId: 'other-account', machineId: 'machine-1' },
        })).toBeNull();
        expect(resolve({
            ...operation('running'),
            scope: { accountId: 'account-1', machineId: 'other-machine' },
        })).toBeNull();
    });

    it('does not expose launch currentness captured for another attempt or draft', () => {
        const resolve = (capture: NonNullable<SessionDraftLocalSupplement['launchCurrentnessCapture']>) => (
            resolvePersistedNewSessionOperationIdentity({
                draftScope,
                draftId,
                draft: { launchUserAttemptId: 'attempt-1', launchCurrentnessCapture: capture },
                operations: [operation('running')],
                findCustody: () => ({
                    v: 2,
                    scope: draftScope,
                    machineId: 'machine-1',
                    targetFingerprint: 'target-1',
                    userAttemptId: 'attempt-1',
                    nonce: 'spawn-1',
                    phase: 'spawning',
                    createdSessionId: null,
                    firstTurnLocalId: 'first-turn-1',
                    attachmentMessageLocalId: 'attachments-1',
                }),
            })?.launchCurrentness
        );
        const currentness = {
            address: { kind: 'newSession', draftId } as const,
            mutationIds: { 'composer.text': 'mutation-1' },
        };

        expect(resolve({ userAttemptId: 'attempt-2', currentness })).toBeNull();
        expect(resolve({
            userAttemptId: 'attempt-1',
            currentness: {
                ...currentness,
                address: { kind: 'newSession', draftId: '5f70a446-6688-4f50-b599-a017b285b7f1' },
            },
        })).toBeNull();
    });

    it('reopens the existing scoped draft while spawn or outer setup remains actionable', () => {
        const registry = createActionOperationReentryRegistry();
        const registration = register(registry);
        const hasDraft = () => true;

        expect(registry.resolve(operation('running'), { hasDraft })).toEqual({
            kind: 'new_session',
            draftScope,
            draftId,
            operationId: 'operation-1',
        });

        registration.markSetupNeedsAttention('session-1');
        expect(registry.resolve(operation('succeeded'), { hasDraft })).toEqual({
            kind: 'new_session',
            draftScope,
            draftId,
            operationId: 'operation-1',
        });
        expect(registry.resolvePresentation(operation('succeeded'))).toEqual({
            kind: 'setup_needs_attention',
        });
    });

    it.each(['failed', 'cancelled'] as const)('reopens the editable form after %s', (state) => {
        const registry = createActionOperationReentryRegistry();
        register(registry);
        expect(registry.resolve(operation(state), { hasDraft: () => true })).toEqual({
            kind: 'new_session',
            draftScope,
            draftId,
            operationId: 'operation-1',
        });
    });

    it('opens the created session only after the full New Session workflow succeeds', () => {
        const registry = createActionOperationReentryRegistry();
        const registration = register(registry);
        registration.markWorkflowComplete('session-1');

        expect(registry.resolve(operation('succeeded'), { hasDraft: () => false })).toEqual({
            kind: 'session',
            sessionId: 'session-1',
            serverId: 'server-1',
        });
    });

    it('falls back to standard detail when no retained origin can reconstruct a form', () => {
        const registry = createActionOperationReentryRegistry();
        register(registry);
        expect(registry.resolve(operation('running'), { hasDraft: () => false })).toEqual({ kind: 'detail' });
        expect(registry.resolve({ ...operation('running'), requestId: 'unknown' }, { hasDraft: () => true })).toEqual({ kind: 'detail' });
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
        registry.registerNewSession({ requestId: 'one', draftScope, draftId });
        registry.registerNewSession({ requestId: 'two', draftScope, draftId });
        registry.registerNewSession({ requestId: 'three', draftScope, draftId });

        expect(registry.readRequestIds()).toEqual(['two', 'three']);
    });

    it('does not let a colliding request id reopen another account draft', () => {
        const registry = createActionOperationReentryRegistry();
        registry.registerNewSession({ requestId: 'shared-request', draftScope, draftId });
        registry.registerNewSession({
            requestId: 'shared-request',
            draftScope: { serverId: 'server-2', accountId: 'account-2' },
            draftId: '5f70a446-6688-4f50-b599-a017b285b7f1',
        });

        expect(registry.resolve({
            ...operation('running'),
            requestId: 'shared-request',
            scope: { accountId: 'account-1', machineId: 'machine-1' },
        }, { hasDraft: () => true })).toEqual({ kind: 'new_session', draftScope, draftId, operationId: 'operation-1' });
        expect(registry.resolve({
            ...operation('running'),
            requestId: 'shared-request',
            scope: { accountId: 'account-3', machineId: 'machine-1' },
        }, { hasDraft: () => true })).toEqual({ kind: 'detail' });
    });
});
