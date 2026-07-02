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
            firstTurnLocalId: 'first-turn-stable',
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
            firstTurnLocalId: 'first-turn-stable',
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

    it('matches attempts only against the launch scope they were created for', () => {
        const attempt = launchAttemptModule.createNewSessionLaunchAttempt({
            prompt: '',
            displayText: '',
            scopeKey: 'machine:m1|server:server-a|path:/repo',
            createId: (prefix) => `${prefix}-stable`,
        });

        expect(attempt.scopeKey).toBe('machine:m1|server:server-a|path:/repo');
        expect(typeof launchAttemptApi.isNewSessionLaunchAttemptInScope).toBe('function');
        if (typeof launchAttemptApi.isNewSessionLaunchAttemptInScope !== 'function') return;

        expect(launchAttemptApi.isNewSessionLaunchAttemptInScope(attempt, 'machine:m1|server:server-a|path:/repo')).toBe(true);
        expect(launchAttemptApi.isNewSessionLaunchAttemptInScope(attempt, 'machine:m1|server:server-b|path:/repo')).toBe(false);
    });
});
