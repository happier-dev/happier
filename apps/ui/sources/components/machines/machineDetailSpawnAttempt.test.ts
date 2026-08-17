import { describe, expect, it, vi } from 'vitest';

import { resolveMachineDetailSpawnAttempt } from './machineDetailSpawnAttempt';

describe('resolveMachineDetailSpawnAttempt', () => {
    it('retains one explicit attempt identity for the same launch intent and rotates on intent change', () => {
        const createUserAttemptId = vi.fn()
            .mockReturnValueOnce('attempt-a')
            .mockReturnValueOnce('attempt-b');
        const first = resolveMachineDetailSpawnAttempt({
            current: null,
            signature: 'machine-a:/repo',
            createUserAttemptId,
        });
        const retry = resolveMachineDetailSpawnAttempt({
            current: first,
            signature: 'machine-a:/repo',
            createUserAttemptId,
        });
        const changed = resolveMachineDetailSpawnAttempt({
            current: retry,
            signature: 'machine-a:/other',
            createUserAttemptId,
        });

        expect(retry).toBe(first);
        expect(changed).toEqual({
            signature: 'machine-a:/other',
            userAttemptId: 'attempt-b',
        });
    });

    it('keeps the V2 creation key stable for retries and rotates it only with the user attempt', () => {
        const createUserAttemptId = vi.fn()
            .mockReturnValueOnce('attempt-a')
            .mockReturnValueOnce('attempt-b');

        const first = resolveMachineDetailSpawnAttempt({
            current: null,
            signature: 'machine-a:/repo',
            createUserAttemptId,
        });
        const retry = resolveMachineDetailSpawnAttempt({
            current: first,
            signature: 'machine-a:/repo',
            createUserAttemptId,
        });
        const changedIntent = resolveMachineDetailSpawnAttempt({
            current: retry,
            signature: 'machine-a:/other',
            createUserAttemptId,
        });

        expect(first.userAttemptId).toBe('attempt-a');
        expect(retry.userAttemptId).toBe(first.userAttemptId);
        expect(changedIntent.userAttemptId).toBe('attempt-b');
        expect(changedIntent.userAttemptId).not.toBe(first.userAttemptId);
    });
});
