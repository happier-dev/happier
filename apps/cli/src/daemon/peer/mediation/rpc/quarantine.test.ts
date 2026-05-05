import { describe, expect, it } from 'vitest';

async function importQuarantine() {
    return await import('./quarantine').catch((error: unknown) => ({ importError: error }));
}

describe('direct machine RPC verification failure quarantine', () => {
    it('fails closed after five consecutive grant or nonce verification failures in sixty seconds', async () => {
        const module = await importQuarantine();
        expect(module).toHaveProperty('createPeerMachineRpcVerificationQuarantine');
        if ('importError' in module) throw module.importError;

        const quarantine = module.createPeerMachineRpcVerificationQuarantine({ nowMs: () => 10_000 });
        const key = {
            accountId: 'account_1',
            machineId: 'machine_1',
            endpointFingerprint: 'endpoint_1',
        };

        for (let index = 0; index < 4; index += 1) {
            quarantine.recordVerificationFailure(key);
            expect(quarantine.isQuarantined(key)).toBe(false);
        }

        quarantine.recordVerificationFailure(key);
        expect(quarantine.isQuarantined(key)).toBe(true);
    });
});
