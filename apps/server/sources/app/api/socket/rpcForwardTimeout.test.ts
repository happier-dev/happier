import { describe, expect, it } from 'vitest';

import { resolveRpcForwardTimeoutMs } from './rpcForwardTimeout';

describe('resolveRpcForwardTimeoutMs', () => {
    it('keeps execution-run admission, input, and waits under caller and lifecycle cancellation without widening ordinary RPC calls', () => {
        for (const method of [
            'execution.run.start',
            'execution.run.start.v2',
            'execution.run.ensure',
            'execution.run.ensureOrStart',
            'execution.run.send',
            'execution.run.action',
            'execution.run.stream.start',
            'execution.run.stream.start.v2',
            'execution.run.stream.cancel',
            'execution.run.stop',
            'execution.run.wait',
        ]) {
            expect(resolveRpcForwardTimeoutMs(`sess_1:${method}`)).toBe(2_147_483_647);
            expect(resolveRpcForwardTimeoutMs(`sess_1:${method}`, 1)).toBe(2_147_483_647);
        }
        expect(resolveRpcForwardTimeoutMs('sess_1:execution.run.wait', 180_000)).toBe(2_147_483_647);
        expect(resolveRpcForwardTimeoutMs('sess_1:execution.run.get')).toBe(30_000);
        expect(resolveRpcForwardTimeoutMs('sess_1:execution.run.stream.read')).toBe(30_000);
    });
});
