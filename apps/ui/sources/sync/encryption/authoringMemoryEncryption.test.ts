import { describe, expect, it } from 'vitest';
import { createAuthoringMemoryCipher } from './authoringMemoryEncryption';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

describe('authoring memory Account envelope', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(3) };
    const randomBytes = (length: number) => new Uint8Array(length).fill(4);
    it('reads and writes a genuinely keyless plain value', () => {
        const cipher = createAuthoringMemoryCipher({ mode: 'plain', material: null, randomBytes });
        expect(cipher.open('lastUsedProfile', cipher.seal('lastUsedProfile', 'p'))).toBe('p');
    });
    it('binds E2EE content to the exact row, rejecting wrong mode, key and missing material', () => {
        const cipher = createAuthoringMemoryCipher({ mode: 'e2ee', material, randomBytes });
        const content = cipher.seal('lastUsedProfile', 'p');
        expect(cipher.open('lastUsedProfile', content)).toBe('p');
        expect(() => cipher.open('recentMachinePaths', content)).toThrow();
        expect(() => cipher.open('lastUsedProfile', { t: 'plain', v: 'p' })).toThrow();
        const keyless = createAuthoringMemoryCipher({ mode: 'e2ee', material: null, randomBytes });
        expect(() => keyless.open('lastUsedProfile', content)).toThrow();
        expect(() => keyless.seal('lastUsedProfile', 'p')).toThrow();
        const plain = createAuthoringMemoryCipher({ mode: 'plain', material: null, randomBytes });
        expect(() => plain.open('lastUsedProfile', content)).toThrow();
    });
    it('opens persisted E2EE payloads with additive fields without weakening the row binding', () => {
        const cipher = createAuthoringMemoryCipher({ mode: 'e2ee', material, randomBytes });
        const content = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({
            kind: 'authoring_memory', material, randomBytes,
            payload: { key: 'lastUsedProfile', value: 'p', futurePayloadField: { extra: true } },
        }), futureEnvelopeField: true };
        expect(cipher.open('lastUsedProfile', content)).toBe('p');
        expect(() => cipher.open('recentMachinePaths', content)).toThrow();
    });
});
