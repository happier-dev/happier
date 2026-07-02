import { describe, expect, it } from 'vitest';

describe('iOS simulator platform adapter', () => {
    it('keeps private-framework capture isolated behind typed unavailable diagnostics', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({ helperAvailable: false });
        expect(adapter.platform).toBe('ios');
        expect(adapter.usesPrivateFrameworks).toBe(true);
        await expect(adapter.capture({ simulatorId: 'sim_1' })).resolves.toEqual({
            ok: false,
            reasonCode: 'ios_private_helper_unavailable',
            requiredOwner: 'signed_ios_simulator_private_framework_helper',
            privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
        });
    });
});
