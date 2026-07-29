import { describe, expect, it, vi } from 'vitest';

import {
    mergeUsageLimitRecoveryFieldIntoMetadata,
    persistUsageLimitRecoveryFieldDurably,
} from './persistUsageLimitRecoveryFieldDurably';

const key = 'sessionUsageLimitRecoveryV1';

function intent(issueFingerprint: string, overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        status: 'waiting',
        resumePromptMode: 'standard',
        issueFingerprint,
        armedAtMs: issueFingerprint === 'new' ? 200 : 100,
        resetAtMs: 1_000,
        nextCheckAtMs: 500,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
        ...overrides,
    };
}

describe('mergeUsageLimitRecoveryFieldIntoMetadata', () => {
    it('recomputes a stale write against the latest terminal field', () => {
        const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: { untouched: true, [key]: intent('same', { status: 'exhausted', attemptCount: 3 }) },
            baseMetadata: { [key]: intent('same') },
            candidateMetadata: { [key]: intent('same', { status: 'checking', attemptCount: 1 }) },
        });

        expect(merged).toMatchObject({
            untouched: true,
            [key]: { status: 'exhausted', attemptCount: 3 },
        });
    });

    it('retains the current runtime attempt when a distinct equal-epoch cancellation arrives', () => {
        const current = intent('same', { runtimeAuthRecoveryAttemptId: 'runtime-b' });
        const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: { [key]: current },
            baseMetadata: { [key]: current },
            candidateMetadata: { [key]: intent('same', {
                status: 'cancelled',
                attemptCount: 2,
                runtimeAuthRecoveryAttemptId: 'runtime-a',
            }) },
        });

        expect(merged[key]).toEqual(current);
    });

    it('does not let a stale clear erase a superseding recovery attempt', () => {
        const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: { [key]: intent('new') },
            baseMetadata: { [key]: intent('old') },
            candidateMetadata: {},
        });

        expect(merged[key]).toMatchObject({ issueFingerprint: 'new' });
    });

    it('does not let a stale clear erase a same-issue re-arm', () => {
        const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: { [key]: intent('same', { armedAtMs: 200 }) },
            baseMetadata: { [key]: intent('same', { armedAtMs: 100 }) },
            candidateMetadata: {},
        });

        expect(merged[key]).toMatchObject({
            issueFingerprint: 'same',
            armedAtMs: 200,
        });
    });

    it('fails closed when the latest attempt identity is malformed', () => {
        const malformedLatest = { issueFingerprint: 'same', status: 'waiting' };
        const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: { [key]: malformedLatest },
            baseMetadata: { [key]: intent('same') },
            candidateMetadata: {},
        });

        expect(merged[key]).toEqual(malformedLatest);
    });

    it('clears when the latest field still belongs to the exact base attempt', () => {
        const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: { untouched: true, [key]: intent('same') },
            baseMetadata: { [key]: intent('same') },
            candidateMetadata: {},
        });

        expect(merged).toEqual({ untouched: true });
    });
});

describe('persistUsageLimitRecoveryFieldDurably', () => {
    it('stages exactly one daemon-authored usage-limit field mutation', async () => {
        const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);

        await expect(persistUsageLimitRecoveryFieldDurably({
            sessionId: 'session-1',
            currentMetadata: {},
            nextMetadata: { [key]: intent('new') },
            stageUsageLimitRecoveryMutation,
        })).resolves.toEqual({ [key]: intent('new') });

        expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            deliveryClass: 'durable_required',
            op: { kind: 'set', value: intent('new') },
        }));
    });

    it('rejects malformed usage and non-usage mutations before daemon staging', async () => {
        const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);

        await expect(persistUsageLimitRecoveryFieldDurably({
            sessionId: 'session-1',
            currentMetadata: {},
            nextMetadata: { [key]: { status: 'waiting' } },
            stageUsageLimitRecoveryMutation,
        })).rejects.toThrow('invalid_daemon_usage_limit_recovery_mutation');

        await expect(persistUsageLimitRecoveryFieldDurably({
            sessionId: 'session-1',
            currentMetadata: {},
            nextMetadata: {
                sessionWorkStateV1: { v: 1, items: [], primaryItemId: null, updatedAt: 1 },
            },
            stageUsageLimitRecoveryMutation,
        })).rejects.toThrow('invalid_daemon_usage_limit_recovery_mutation');

        expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
    });

    it('accepts an unchanged valid usage field without staging a duplicate mutation', async () => {
        const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);
        const currentMetadata = { [key]: intent('same') };

        await expect(persistUsageLimitRecoveryFieldDurably({
            sessionId: 'session-1',
            currentMetadata,
            nextMetadata: currentMetadata,
            stageUsageLimitRecoveryMutation,
        })).resolves.toEqual(currentMetadata);

        expect(stageUsageLimitRecoveryMutation).not.toHaveBeenCalled();
    });
});
