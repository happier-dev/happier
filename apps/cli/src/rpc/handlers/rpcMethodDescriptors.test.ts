import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_INTERNAL_METHOD_FAMILIES } from '@happier-dev/protocol/rpc/methodDescriptors';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { resolveMachineRpcGovernance } from '@happier-dev/protocol/machines/peer/mediation/rpc/governanceV1';
import { INTERNAL_ONLY_RPC_METHODS } from './_internalAllowlist';

function fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

it('preserves route policy and governance for the complete RPC catalog and every Action-coverage membership', () => {
    const methods = [...Object.values(RPC_METHODS), ...Object.values(SESSION_RPC_METHODS)];
    const declaredCoverage = INTERNAL_ONLY_RPC_METHODS.map(row => row.method);
    const coveredMethods = new Set(declaredCoverage);
    for (const family of Object.values(RPC_INTERNAL_METHOD_FAMILIES)) {
        for (const method of family) {
            expect(coveredMethods.has(method), method).toBe(true);
            expect(resolveMachineRpcGovernance(method).rpcClassification, method).toBe('internal_only');
        }
    }

    // Baseline from the pre-consolidation source. Compare the complete
    // authority shape, excluding the prose and historical owner label.
    expect(methods).toHaveLength(644);
    expect(fingerprint(methods.map(method => {
        const { rationale, ownerPacket, ...policy } = resolveMachineRpcRoutePolicy(method);
        return [policy, resolveMachineRpcGovernance(method)];
    }))).toBe('e6f05e0cc4bb7b0b2dc0bb93eb4dd62a97d9aff8db043a107a44dda41609814f');
    expect(fingerprint(declaredCoverage)).toBe('9895ee1be7115aa91fd5f409b70870d8e748231d5c99201b676647bcc66508d7');
});
