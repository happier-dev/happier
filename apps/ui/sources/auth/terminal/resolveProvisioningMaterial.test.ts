import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { resolveProvisioningMaterial } from './resolveProvisioningMaterial';

describe('resolveProvisioningMaterial', () => {
    it('returns token-only for plain credentials', () => {
        expect(resolveProvisioningMaterial({ token: 't' })).toEqual({ type: 'tokenOnly' });
    });

    it('retains a valid data key', () => {
        const key = new Uint8Array(32).fill(3);
        expect(resolveProvisioningMaterial({
            token: 't',
            encryption: { publicKey: encodeBase64(key), machineKey: encodeBase64(key) },
        })).toEqual({ type: 'dataKey', key });
    });
});
