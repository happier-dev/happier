import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from './base64.js';
import { stringifySerializedJsonValue } from './serializedJsonValue.js';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '../testing/accountScopedCipherFixtures.js';

import {
  accountScopedCiphertextBase64LengthForPlaintextBytes,
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
  it('owns the exact padded-base64 boundary for account-scoped ciphertext', () => {
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey: new Uint8Array(32).fill(3) };
    const payload = 'x'.repeat(137);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_session_draft_private_payload',
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });
    expect(ciphertext.length).toBe(accountScopedCiphertextBase64LengthForPlaintextBytes(serializedBytes));
  });

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

  it('rejects connected service quota snapshots as a durable account-scoped persistence kind', () => {
    const kind: AccountScopedBlobKind = 'connected_service_quota_snapshot';
    const machineKey = new Uint8Array(32).fill(5);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: Date.now(), meters: [] };

    expect(() => sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    })).toThrow(/legacy read-only/i);
  });

  it('opens legacy connected service quota snapshot ciphertext in compatibility mode', () => {
    const machineKey = new Uint8Array(32).fill(5);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: Date.now(), meters: [] };
    const ciphertext = sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material,
      ciphertext,
    });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for provider account usage snapshots', () => {
    const kind = 'provider_account_usage_snapshot' as AccountScopedBlobKind;
    const machineKey = new Uint8Array(32).fill(6);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { v: 1, recordId: 'paug_v1_example', meters: [] };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material,
      ciphertext,
    })).toBeNull();
    const opened = openAccountScopedBlobCiphertext({
      kind,
      material,
      ciphertext,
    });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('keeps existing account-scoped v1 kind bytes stable while adding provider usage snapshots, session organization display, and first intent', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const randomBytes = deterministicRandomBytesFactory();

    const sessionRespawnCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material,
      payload: { env: {} },
      randomBytes,
    });
    const providerUsageCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'provider_account_usage_snapshot' as AccountScopedBlobKind,
      material,
      payload: { v: 1, recordId: 'paug_v1_example', meters: [] },
      randomBytes,
    });
    const sessionOrganizationDisplayCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'session_organization_display',
      material,
      payload: { label: 'Project A' },
      randomBytes,
    });
    const sessionFirstIntentCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'session_first_intent',
      material,
      payload: { localId: 'first-turn-1', content: { type: 'text', text: 'private prompt' } },
      randomBytes,
    });

    expect(decodeBase64(sessionRespawnCiphertext, 'base64')[1]).toBe(5);
    expect(decodeBase64(providerUsageCiphertext, 'base64')[1]).toBe(6);
    expect(decodeBase64(sessionOrganizationDisplayCiphertext, 'base64')[1]).toBe(7);
    expect(decodeBase64(sessionFirstIntentCiphertext, 'base64')[1]).toBe(8);
    expect(openAccountScopedBlobCiphertext({
      kind: 'session_organization_display',
      material,
      ciphertext: sessionOrganizationDisplayCiphertext,
    })?.value).toEqual({ label: 'Project A' });
    expect(openAccountScopedBlobCiphertext({
      kind: 'session_first_intent',
      material,
      ciphertext: sessionFirstIntentCiphertext,
    })?.value).toEqual({ localId: 'first-turn-1', content: { type: 'text', text: 'private prompt' } });
    expect(openAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material,
      ciphertext: sessionFirstIntentCiphertext,
    })).toBeNull();
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

  it('opens legacy secretbox ciphertext encrypted with the recovery secret and unwraps serialized JSON envelopes (backcompat)', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    const nonce = new Uint8Array(24).fill(4);
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(payload));
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

  it('opens legacy secretbox ciphertext encrypted with the machine key and unwraps serialized JSON envelopes (backcompat)', () => {
    const kind: AccountScopedBlobKind = 'automation_template_payload';
    const machineKey = new Uint8Array(32).fill(6);
    const payload = { directory: '/tmp/project', prompt: 'Run checks' };

    const nonce = new Uint8Array(24).fill(8);
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, machineKey);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened?.format).toBe('legacy_secretbox');
    expect(opened?.value).toEqual(payload);
  });

  it('falls back to legacy secretbox opening even when nonce collides with account-scoped magic bytes', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    // Collision case: legacy nonce begins with the account-scoped magic byte and kind byte.
    const nonce = new Uint8Array(24).fill(4);
    nonce[0] = 0xa1;
    nonce[1] = 1; // account_settings kind byte

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

  it('keeps the new-session draft payload in an immutable account-scoped cipher domain', () => {
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey: new Uint8Array(32).fill(11) };
    const payload = { v: 1, address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' } };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_session_draft_private_payload',
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(decodeBase64(ciphertext, 'base64')[1]).toBe(10);
    expect(openAccountScopedBlobCiphertext({
      kind: 'account_session_draft_private_payload',
      material,
      ciphertext,
    })?.value).toEqual(payload);
    expect(openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      ciphertext,
    })).toBeNull();
  });
});
