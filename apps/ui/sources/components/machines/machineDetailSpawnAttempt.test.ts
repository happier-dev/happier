import { describe, expect, it, vi } from 'vitest';

import { resolveMachineDetailSpawnAttempt } from './machineDetailSpawnAttempt';

describe('resolveMachineDetailSpawnAttempt', () => {
    it('retains one explicit attempt identity for the same launch intent and rotates on intent change', () => {
        const createUserAttemptId = vi.fn()
            .mockReturnValueOnce('attempt-a')
            .mockReturnValueOnce('attempt-b');
        const createSpawnNonce = vi.fn()
            .mockReturnValueOnce('nonce-a')
            .mockReturnValueOnce('nonce-b');
        const first = resolveMachineDetailSpawnAttempt({
            current: null,
            signature: 'machine-a:/repo',
            createUserAttemptId,
            createSpawnNonce,
        });
        const retry = resolveMachineDetailSpawnAttempt({
            current: first,
            signature: 'machine-a:/repo',
            createUserAttemptId,
            createSpawnNonce,
        });
        const changed = resolveMachineDetailSpawnAttempt({
            current: retry,
            signature: 'machine-a:/other',
            createUserAttemptId,
            createSpawnNonce,
        });

        expect(retry).toBe(first);
        expect(changed).toEqual({
            signature: 'machine-a:/other',
            userAttemptId: 'attempt-b',
            spawnNonce: 'nonce-b',
        });
    });
});
