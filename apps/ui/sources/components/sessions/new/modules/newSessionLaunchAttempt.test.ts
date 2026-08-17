import { describe, expect, it } from 'vitest';

import * as launchAttemptModule from './newSessionLaunchAttempt';

const launchAttemptApi = launchAttemptModule as Record<string, unknown>;

describe('newSessionLaunchAttempt', () => {
    it('keeps generated attempt ids stable across phase transitions', () => {
        const attempt = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: 'Investigate checkout failures',
            displayText: 'Investigate checkout failures',
            meta: { source: 'test' },
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            createId: (prefix) => `${prefix}-stable`,
        });

        expect(attempt).toMatchObject({
            attemptId: 'attempt-stable',
            spawnNonce: 'spawn-stable',
            firstTurnLocalId: 'spawn-first-turn:spawn-stable',
            attachmentMessageLocalId: 'attachment-message-stable',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            createdSessionId: null,
            status: 'idle',
            prompt: {
                prompt: 'Investigate checkout failures',
                displayText: 'Investigate checkout failures',
                meta: { source: 'test' },
            },
            phaseErrors: {},
        });

        expect(typeof launchAttemptApi.markNewSessionLaunchAttemptSendingFirstTurn).toBe('function');
        if (typeof launchAttemptApi.markNewSessionLaunchAttemptSendingFirstTurn !== 'function') return;
        expect(typeof launchAttemptApi.markNewSessionLaunchAttemptFailed).toBe('function');
        if (typeof launchAttemptApi.markNewSessionLaunchAttemptFailed !== 'function') return;

        const sending = launchAttemptApi.markNewSessionLaunchAttemptSendingFirstTurn(attempt);
        const created = launchAttemptModule.markNewSessionLaunchAttemptCreated(sending, {
            createdSessionId: 'session-created',
        });
        const failed = launchAttemptApi.markNewSessionLaunchAttemptFailed(created, {
            phase: 'sending_first_turn',
            error: new Error('send failed'),
            retryable: true,
        });

        expect(failed).toMatchObject({
            attemptId: 'attempt-stable',
            spawnNonce: 'spawn-stable',
            firstTurnLocalId: 'spawn-first-turn:spawn-stable',
            attachmentMessageLocalId: 'attachment-message-stable',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            createdSessionId: 'session-created',
            status: 'failed_retryable',
            phaseErrors: {
                sending_first_turn: expect.objectContaining({
                    retryable: true,
                }),
            },
        });
    });

    it('moves first-turn identity with canonical custody when a prior nonce is adopted', () => {
        const attempt = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: 'Investigate checkout failures',
            displayText: 'Investigate checkout failures',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            spawnNonce: 'new-attempt-nonce',
        });

        expect(launchAttemptModule.adoptNewSessionLaunchAttemptCustody(attempt, {
            userAttemptId: 'original-attempt',
            spawnNonce: 'original-nonce',
        })).toMatchObject({
            attemptId: 'original-attempt',
            spawnNonce: 'original-nonce',
            firstTurnLocalId: 'spawn-first-turn:original-nonce',
        });
    });

    it('keeps the persisted attempt identity stable across retries', () => {
        const first = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: 'Investigate checkout failures',
            displayText: 'Investigate checkout failures',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            attemptId: 'retryable-attempt',
        });
        const retry = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: 'Investigate checkout failures',
            displayText: 'Investigate checkout failures',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            attemptId: 'retryable-attempt',
        });
        const newIntent = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: 'Investigate checkout failures',
            displayText: 'Investigate checkout failures',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            attemptId: 'new-attempt',
        });

        expect(first.attemptId).toBe('retryable-attempt');
        expect(retry.attemptId).toBe(first.attemptId);
        expect(newIntent.attemptId).toBe('new-attempt');
        expect(newIntent.attemptId).not.toBe(first.attemptId);
        // A fresh explicit submission owns a fresh spawn nonce and therefore
        // must not borrow the first turn identity of an older attempt.
        expect(newIntent.firstTurnLocalId).not.toBe(first.firstTurnLocalId);
    });

    it('does not spawn again after a session id has been created', () => {
        const attempt = launchAttemptModule.markNewSessionLaunchAttemptCreated(
            launchAttemptModule.createNewSessionLaunchAttempt({
                prompt: '',
                displayText: '',
                scopeKey: 'machine:m1|server:server-a|path:/repo',
                createId: (prefix) => `${prefix}-stable`,
            }),
            { createdSessionId: 'session-created' },
        );

        expect(typeof launchAttemptApi.shouldSpawnForNewSessionLaunchAttempt).toBe('function');
        if (typeof launchAttemptApi.shouldSpawnForNewSessionLaunchAttempt !== 'function') return;

        expect(launchAttemptApi.shouldSpawnForNewSessionLaunchAttempt(attempt)).toBe(false);
    });

    it('matches attempts against their launch scope', () => {
        const attempt = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: '',
            displayText: '',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            createId: (prefix) => `${prefix}-stable`,
        });

        expect(attempt.scopeKey).toBe('machine:m1|server:server-a|path:/repo');
        expect(typeof launchAttemptApi.isNewSessionLaunchAttemptInScope).toBe('function');
        if (typeof launchAttemptApi.isNewSessionLaunchAttemptInScope !== 'function') return;

        expect(launchAttemptApi.isNewSessionLaunchAttemptInScope(
            attempt,
            'machine:m1|server:server-a|path:/repo',
        )).toBe(true);
        expect(launchAttemptApi.isNewSessionLaunchAttemptInScope(
            attempt,
            'machine:m1|server:server-b|path:/repo',
        )).toBe(false);
    });
});
