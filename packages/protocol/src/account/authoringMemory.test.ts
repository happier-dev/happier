import { describe, expect, it } from 'vitest';
import {
  AuthoringMemoryContentV1Schema,
  AuthoringMemoryPrivatePayloadV1Schema,
  assertAuthoringMemoryContentForModeV1,
} from './authoringMemory.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';

describe('authoring-memory envelopes', () => {
  it('preserves opaque strict JSON engine carriers, and rejects values outside JSON', () => {
    const value = { v: 1, modelSelection: { future: { nested: [null, false, 2] } }, unknown: 'preserve' };
    expect(AuthoringMemoryContentV1Schema.parse({ t: 'plain', v: value })).toEqual({ t: 'plain', v: value });
    expect(AuthoringMemoryContentV1Schema.safeParse({ t: 'plain', v: { invalid: undefined } }).success).toBe(false);
    expect(AuthoringMemoryContentV1Schema.safeParse({ t: 'plain', v: value, extra: true }).success).toBe(false);
    expect(AuthoringMemoryPrivatePayloadV1Schema.parse({ key: 'engineSelection:default:agent:codex', value })).toEqual({ key: 'engineSelection:default:agent:codex', value });
  });

  it('requires the persisted Account mode and exact cipher purpose', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const randomBytes = (length: number) => new Uint8Array(length).fill(8);
    const encrypted = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'authoring_memory', material, payload: { key: 'lastUsedProfile', value: 'profile' }, randomBytes }) };
    expect(assertAuthoringMemoryContentForModeV1(encrypted, 'e2ee')).toEqual(encrypted);
    expect(() => assertAuthoringMemoryContentForModeV1(encrypted, 'plain')).toThrow();
    expect(() => assertAuthoringMemoryContentForModeV1({ t: 'plain', v: 'profile' }, 'e2ee')).toThrow();
    expect(() => assertAuthoringMemoryContentForModeV1({ t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: {}, randomBytes }) }, 'e2ee')).toThrow();
  });

  it('drops additive persisted envelope fields while mutation content remains strict', () => {
    const stored = { t: 'plain', v: { opaque: { future: true } }, futureEnvelopeField: true };
    expect(assertAuthoringMemoryContentForModeV1(stored, 'plain')).toEqual({ t: 'plain', v: stored.v });
    expect(AuthoringMemoryContentV1Schema.safeParse(stored).success).toBe(false);
    expect(() => assertAuthoringMemoryContentForModeV1(stored, 'e2ee')).toThrow();
  });
});
