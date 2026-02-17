import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';
import { encodeBase64 } from './base64.js';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedBlobKind,
  type AccountScopedCryptoMaterial,
  deriveAccountMachineKeyFromRecoverySecret,
} from './accountScopedCipher.js';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('accountScopedCipher', () => {
  it('seals/opens without Buffer or atob/btoa globals', () => {
    const prevBuffer = (globalThis as any).Buffer;
    const prevAtob = (globalThis as any).atob;
    const prevBtoa = (globalThis as any).btoa;
    (globalThis as any).Buffer = undefined;
    (globalThis as any).atob = undefined;
    (globalThis as any).btoa = undefined;

    try {
      const kind: AccountScopedBlobKind = 'account_settings';
      const machineKey = new Uint8Array(32).fill(9);
      const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
      const payload = { claudeLocalPermissionBridgeEnabled: true, schemaVersion: 1 };

      const ciphertext = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
      expect(opened?.format).toBe('account_scoped_v1');
      expect(opened?.value).toEqual(payload);
    } finally {
      (globalThis as any).Buffer = prevBuffer;
      (globalThis as any).atob = prevAtob;
      (globalThis as any).btoa = prevBtoa;
    }
  });

  it('seals and opens v1 ciphertext with dataKey material', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const machineKey = new Uint8Array(32).fill(9);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { claudeLocalPermissionBridgeEnabled: true, schemaVersion: 1 };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for connected service credentials', () => {
    const kind: AccountScopedBlobKind = 'connected_service_credential';
    const machineKey = new Uint8Array(32).fill(4);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { serviceId: 'openai-codex', profileId: 'work', token: 'ciphertext-payload' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for connected service quota snapshots', () => {
    const kind: AccountScopedBlobKind = 'connected_service_quota_snapshot';
    const machineKey = new Uint8Array(32).fill(5);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: Date.now(), meters: [] };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({
      kind,
      material,
      ciphertext,
    });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('allows legacy and dataKey devices to read the same v1 ciphertext', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(7);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);

    const legacyMaterial: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const dataKeyMaterial: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { codexBackendMode: 'acp' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material: legacyMaterial,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({ kind, material: legacyMaterial, ciphertext })?.value).toEqual(payload);
    expect(openAccountScopedBlobCiphertext({ kind, material: dataKeyMaterial, ciphertext })?.value).toEqual(payload);
  });

  it('opens legacy secretbox ciphertext encrypted with the recovery secret (backcompat)', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    const nonce = new Uint8Array(24).fill(4);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, recoverySecret);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened?.format).toBe('legacy_secretbox');
    expect(opened?.value).toEqual(payload);
  });

  it('returns null when kind does not match', () => {
    const payload = { x: 1 };
    const machineKey = new Uint8Array(32).fill(8);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({ kind: 'automation_template_payload', material, ciphertext })).toBeNull();
  });
});
