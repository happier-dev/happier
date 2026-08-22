import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    snapshotConnectedAccountEstablishedResult,
} from './producerResultSnapshot';

describe('connected-account producer result snapshots', () => {
    it('projects a bounded protocol diagnostic with health facts', () => {
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

    it('preserves health facts when an optional diagnostic cannot cross the protocol boundary', () => {
        const result = snapshotConnectedAccountEstablishedResult(
            Object.freeze({ kind: 'status' as const }),
            Object.freeze({
                status: 'connected',
                displayName: 'Account A',
                scopes: Object.freeze(['read']),
                diagnostic: Object.freeze({
                    code: 'provider_notice',
                    severity: 'unsupported',
                    message: 'must not cross the host boundary',
                }),
            }),
            Object.freeze({ quotaLeafUnavailable: false }),
        );

        expect(result).toEqual({
            status: 'connected',
            displayName: 'Account A',
            scopes: ['read'],
        });
    });

    it('preserves revocation facts when an optional diagnostic cannot cross the protocol boundary', () => {
        const result = snapshotConnectedAccountEstablishedResult(
            Object.freeze({ kind: 'revoke' as const }),
            Object.freeze({
                status: 'remoteRevoked',
                diagnostic: Object.freeze({
                    code: 'provider_notice',
                    severity: 'unsupported',
                    message: 'must not cross the host boundary',
                }),
            }),
            Object.freeze({ quotaLeafUnavailable: false }),
        );

        expect(result).toEqual({ status: 'remoteRevoked' });
    });

    it('keeps required diagnostic result variants fail-closed', () => {
        const invalidDiagnostic = Object.freeze({
            code: 'provider_notice',
            severity: 'unsupported',
        });

        expect(() => snapshotConnectedAccountEstablishedResult(
            Object.freeze({ kind: 'status' as const }),
            Object.freeze({
                status: 'rejected',
                diagnostic: invalidDiagnostic,
            }),
            Object.freeze({ quotaLeafUnavailable: false }),
        )).toThrow('Connected-account producer result is invalid');

        expect(() => snapshotConnectedAccountEstablishedResult(
            Object.freeze({ kind: 'revoke' as const }),
            Object.freeze({
                status: 'outcomeUnknown',
                diagnostic: invalidDiagnostic,
            }),
            Object.freeze({ quotaLeafUnavailable: false }),
        )).toThrow('Connected-account producer result is invalid');
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
