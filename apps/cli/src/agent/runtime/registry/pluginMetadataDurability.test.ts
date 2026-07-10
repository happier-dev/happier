import { describe, expect, it } from 'vitest';

import { splitDurableRegisteredSessionStateMetadata } from './pluginMetadataDurability';

function createUsageLimitRecoveryValue() {
    return {
        v: 1,
        status: 'waiting',
        resumePromptMode: 'standard',
        issueFingerprint: 'issue-1',
        armedAtMs: 1,
        resetAtMs: null,
        nextCheckAtMs: 2,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native', serviceId: null },
    };
}

describe('splitDurableRegisteredSessionStateMetadata', () => {
    it('strips invalid registered durable metadata instead of persisting it as opaque metadata', () => {
        const split = splitDurableRegisteredSessionStateMetadata({
            sessionId: 'sess-1',
            current: { unrelated: true },
            candidate: {
                unrelated: true,
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'waiting',
                    action: {
                        url: 'https://example.invalid/login?token=secret',
                    },
                },
            },
            source: 'runtime',
        });

        expect(split.metadata).toEqual({ unrelated: true });
        expect(split.mutations).toEqual([]);
    });

    it('restores current registered durable metadata when a plugin writes an invalid candidate value', () => {
        const currentValue = createUsageLimitRecoveryValue();
        const split = splitDurableRegisteredSessionStateMetadata({
            sessionId: 'sess-1',
            current: {
                unrelated: true,
                sessionUsageLimitRecoveryV1: currentValue,
            },
            candidate: {
                unrelated: false,
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'waiting',
                    providerLimitId: 'limit-secret',
                },
            },
            source: 'runtime',
        });

        expect(split.metadata).toEqual({
            unrelated: false,
            sessionUsageLimitRecoveryV1: currentValue,
        });
        expect(split.mutations).toEqual([]);
    });
});
