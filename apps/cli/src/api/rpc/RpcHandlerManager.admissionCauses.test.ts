import { describe, expect, it } from 'vitest';
import { RpcHandlerManager } from './RpcHandlerManager';

describe('RPC admission refusal causes', () => {
    it.each([
        ['machine_admission', 'machineAdmission'],
        ['caller_input_authorization', 'callerInputAuthorization'],
    ] as const)('carries the deciding %s branch without running the handler', async (phase, field) => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
        let effects = 0;
        rpc.registerHandler('demo.effect', () => { effects += 1; return { ok: true }; });
        // Malformed data is supplied at the actual public transport boundary.
        const response = await rpc.handleRequest({ method: 'machine:demo.effect', params: { privateOperand: 'never-copy' },
            [field]: JSON.parse('{"privateCredential":"never-copy"}') });
        expect(response).toMatchObject({ errorCode: 'RPC_FORBIDDEN', effectAttempted: false,
            failureCause: { phase: `rpc.admission.${phase}`, errorClass: 'UnknownThrownValue', errorCode: 'RPC_FORBIDDEN', httpStatus: null } });
        expect(effects).toBe(0);
        expect(JSON.stringify(response)).not.toContain('never-copy');
        expect(await rpc.handleRequest({ method: 'machine:demo.effect', params: {} })).toEqual({ ok: true });
        expect(effects).toBe(1);
    });
});
