import { describe, expect, it } from 'vitest';

describe('Android emulator platform adapter', () => {
    it('uses an Android-owned unavailable diagnostic instead of iOS private assumptions', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({ bridgeAvailable: false });
        expect(adapter.platform).toBe('android');
        expect(adapter.usesPrivateFrameworks).toBe(false);
        await expect(adapter.capture({ simulatorId: 'emu_1' })).resolves.toEqual({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
            requiredOwner: 'android_emulator_capture_input_bridge',
        });
    });
});
