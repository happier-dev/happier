import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    snapshotConnectedAccountEstablishedResult,
} from './producerResultSnapshot';

describe('connected-account producer result snapshots', () => {
    it('detaches subscription observations from mutable producer state', () => {
        const operation = { kind: 'quota' } as const;
        const options = { quotaLeafUnavailable: false } as const;
        for (const status of ['subscribed', 'unavailable'] as const) {
            const subscription = {
                status,
                renewal: 'off',
                observedAtMs: 100,
                staleAfterMs: 1_000,
                currentPeriodEndAtMs: 200,
                lastRefreshError: { observedAtMs: 110, code: 'network' },
            };
            const quota = { observedAtMs: 110, limits: [{ id: 'requests', remaining: 3 }], subscription };
            const result = snapshotConnectedAccountEstablishedResult(operation, quota, options);
            expect(result).toEqual(quota);
            if (!result || !('limits' in result)) throw new Error('Expected a quota snapshot');
            subscription.observedAtMs = 900;
            subscription.lastRefreshError.observedAtMs = 900;
            expect(result.subscription).toMatchObject({ observedAtMs: 100, lastRefreshError: { observedAtMs: 110 } });
        }
    });
    it('preserves diagnostic and health facts for the wire owner', () => {
        const result = snapshotConnectedAccountEstablishedResult(
            Object.freeze({ kind: 'status' as const }),
            Object.freeze({
                status: 'connected',
                displayName: 'Account A',
                scopes: Object.freeze(['read']),
                diagnostic: Object.freeze({
                    code: 'provider_notice',
                    severity: 'warning',
                    message: 'The provider recommends reconnecting soon.',
                    details: Object.freeze({ retryable: true }),
                    remediation: Object.freeze({ kind: 'retry' as const }),
                }),
            }),
            Object.freeze({ quotaLeafUnavailable: false }),
        );

        expect(result).toEqual({
            status: 'connected',
            displayName: 'Account A',
            scopes: ['read'],
            diagnostic: {
                code: 'provider_notice',
                severity: 'warning',
                message: 'The provider recommends reconnecting soon.',
                details: { retryable: true },
                remediation: { kind: 'retry' },
            },
        });
    });

    it('accepts Buffer file bytes and snapshots them as a detached Uint8Array', () => {
        const source = Buffer.from([1, 2, 3]);
        const result = snapshotConnectedAccountEstablishedResult(
            Object.freeze({
                kind: 'materialize' as const,
                request: Object.freeze({
                    kind: 'files' as const,
                    fileIds: Object.freeze(['credential']),
                }),
            }),
            Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({ credential: source }),
            }),
            Object.freeze({ quotaLeafUnavailable: false }),
        );

        if (result.kind !== 'files') throw new Error('Expected file materialization');
        const bytes = result.files.credential;
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(bytes)).toBe(false);
        expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
        expect([...bytes]).toEqual([1, 2, 3]);
        source[0] = 9;
        expect([...bytes]).toEqual([1, 2, 3]);
    });
});
