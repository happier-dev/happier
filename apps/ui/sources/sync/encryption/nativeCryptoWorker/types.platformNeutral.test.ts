import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('native crypto worker types', () => {
    it('can be imported without native runtime modules', async () => {
        const module = await import('./types');

        expect(module.NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok).toBe(0);
        expect(module.NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1).toBe('decryptDataKeyEnvelopeV1');
    });

    it('keeps the shared type module platform-neutral', () => {
        const source = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('react-native');
        expect(source).not.toContain('expo-modules-core');
        expect(source).not.toContain('react-native-worklets');
        expect(source).not.toContain('requireNativeModule');
        expect(source).not.toContain('.native');
    });
});
