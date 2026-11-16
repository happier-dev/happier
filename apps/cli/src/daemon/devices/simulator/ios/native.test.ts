import { describe, expect, it } from 'vitest';

import { resolveIosSimulatorNativeProducer } from './native';

describe('iOS native producer availability', () => {
    it('reports the packaged loader cause without advertising capture when native loading fails', () => {
        const result = resolveIosSimulatorNativeProducer({ platform: 'darwin', arch: 'arm64', loadAddon: () => {
            throw Object.assign(new Error('missing framework'), { code: 'ERR_DLOPEN_FAILED' });
        } });
        expect(result).toMatchObject({ ok: false, health: { status: 'unavailable', reasonCode: 'ios_native_producer_unavailable',
            diagnostics: [{ code: 'ios_native_producer_load_failed', nativeCode: 'ERR_DLOPEN_FAILED' }] } });
    });

    it('keeps unsupported hosts from loading the macOS arm64 addon', () => {
        const result = resolveIosSimulatorNativeProducer({ platform: 'linux', arch: 'arm64', loadAddon: () => { throw new Error('must not load'); } });
        expect(result).toMatchObject({ ok: false, health: { reasonCode: 'unsupported_host' } });
    });
});
