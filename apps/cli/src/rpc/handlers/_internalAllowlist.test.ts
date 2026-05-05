import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    INTERNAL_ONLY_RPC_METHODS,
    isInternalOnlyRpcMethod,
    validateInternalOnlyRpcMethodEntries,
} from './_internalAllowlist';

describe('INTERNAL_ONLY_RPC_METHODS', () => {
    it('keeps seed entries queryable with owner packet and rationale metadata', () => {
        const result = validateInternalOnlyRpcMethodEntries();

        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(INTERNAL_ONLY_RPC_METHODS.length).toBeGreaterThan(0);
        for (const entry of INTERNAL_ONLY_RPC_METHODS) {
            expect(entry.ownerPacket).toBe('A.12.0');
            expect(entry.rationale.trim().length).toBeGreaterThan(0);
            expect(isInternalOnlyRpcMethod(entry.method)).toBe(true);
        }
    });

    it('rejects duplicate methods and missing rationale metadata', () => {
        const result = validateInternalOnlyRpcMethodEntries([
            { method: 'daemon.lifecycle.stop', rationale: 'daemon lifecycle transport', ownerPacket: 'A.12.0' },
            { method: 'daemon.lifecycle.stop', rationale: 'duplicate transport', ownerPacket: 'A.12.0' },
            { method: 'daemon.lifecycle.restart', rationale: '', ownerPacket: 'A.12.0' },
            { method: 'daemon.lifecycle.pause', rationale: 'missing owner', ownerPacket: '' },
        ]);

        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toEqual([
            'duplicate-method',
            'missing-rationale',
            'missing-owner-packet',
        ]);
    });

    it('leaves session stop for the downstream session-lifecycle migration packet', () => {
        expect(isInternalOnlyRpcMethod(RPC_METHODS.STOP_DAEMON)).toBe(true);
        expect(isInternalOnlyRpcMethod(RPC_METHODS.STOP_SESSION)).toBe(false);
    });
});
