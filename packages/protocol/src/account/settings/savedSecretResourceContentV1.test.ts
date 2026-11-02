import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1 } from './personalSavedSecretActionsV1.js';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { ACCOUNT_SETTING_MAX_STRING_BYTES } from './catalog/accountSettingBounds.js';
import {
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1,
  SavedSecretResourceContentV1Schema,
  SavedSecretResourceStoredContentV1Schema,
  openSavedSecretResourceStoredContentV1,
  sealSavedSecretResourceStoredContentV1,
  prepareSavedSecretResourceUpdateContentV1,
} from './savedSecretResourceContentV1.js';
import {
  SavedSecretResourceContentV1Schema as BrowserSafeSavedSecretResourceContentV1Schema,
  SavedSecretResourceStoredContentV1Schema as BrowserSafeSavedSecretResourceStoredContentV1Schema,
} from './savedSecretResourceContentSchemaV1.js';

const content = Object.freeze({
  v: 1 as const,
  name: 'Production token',
  kind: 'token' as const,
  value: 'secret-value',
});

function deterministicRandomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + 1) & 0xff);
}

function sealRawPayload(payload: unknown, resourceDataKey: Uint8Array): string {
  const nonce = deterministicRandomBytes(tweetnacl.secretbox.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const boxed = tweetnacl.secretbox(plaintext, nonce, resourceDataKey);
  const combined = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce);
  combined.set(boxed, nonce.length);
  return encodeBase64(combined, 'base64');
}

describe('savedSecretResourceContentV1', () => {
  it('admits one passkey source at the incumbent create Action without a scalar value', () => {
    const source = { kind: 'passkey' as const, rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG',
      privateKey: 'BwgJ', algorithm: -7 as const, signCount: 0, backupEligibility: true, backupState: true };
    const schema = PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.create'];
    expect(schema.parse({ name: 'Passkey', kind: 'other', source })).toEqual({ name: 'Passkey', kind: 'other', source });
    expect(schema.safeParse({ name: 'Passkey', kind: 'other', source, value: 'flattened' }).success).toBe(false);
    expect(schema.safeParse({ name: 'Passkey', kind: 'token', source }).success).toBe(false);
  });
  it('keeps imported RP and credential identity immutable on edit while rename converts retained Plain custody', () => {
    const source = { kind: 'passkey' as const, rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG',
      privateKey: 'BwgJ', algorithm: -7 as const, signCount: 0, backupEligibility: true, backupState: true };
    const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'key', mode: 'plain',
      content: { v: 2, name: 'Passkey', kind: 'other', source } });
    const base = { resourceId: 'key', resourceMode: 'plain' as const, accountMode: 'e2ee' as const, storedContent };
    expect(prepareSavedSecretResourceUpdateContentV1({ ...base, nextName: 'Renamed' })).toEqual({
      content: { v: 2, name: 'Renamed', kind: 'other', source }, mode: 'e2ee', toMode: 'e2ee' });
    expect(prepareSavedSecretResourceUpdateContentV1({ ...base, nextValue: 'scalar replacement' })).toBeNull();
    expect(prepareSavedSecretResourceUpdateContentV1({ ...base, nextSource: {
      kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'vault' }, account: 'account', reference: 'locator',
    } })).toBeNull();
    expect(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.update'].safeParse({ secretId: 'key', expectedUpdatedAt: 1,
      source: { ...source, rpId: 'attacker.example' } }).success).toBe(false);
  });
  it('keeps imported passkey material inside the resource envelope in both Account modes', () => {
    const passkey = { v: 2 as const, name: 'Example passkey', kind: 'other' as const,
      source: { kind: 'passkey' as const, rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG',
        privateKey: 'cHJpdmF0ZS1wYXNza2V5LWtleS1tYXRlcmlhbA==', algorithm: -7 as const, signCount: 12, backupEligibility: true, backupState: true } };
    const parsed = SavedSecretResourceContentV1Schema.parse(passkey);
    const resourceDataKey = new Uint8Array(32).fill(7);
    const plain = sealSavedSecretResourceStoredContentV1({ resourceId: 'passkey-1', mode: 'plain', content: parsed });
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'passkey-1', mode: 'plain', storedContent: plain })).toEqual(passkey);
    const encrypted = sealSavedSecretResourceStoredContentV1({ resourceId: 'passkey-1', mode: 'e2ee', content: parsed,
      resourceDataKey, randomBytes: deterministicRandomBytes });
    expect(encrypted.t).toBe('encrypted');
    expect(JSON.stringify(encrypted)).not.toContain(passkey.source.privateKey);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'passkey-1', mode: 'e2ee', storedContent: encrypted,
      resourceDataKey })).toEqual(passkey);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'passkey-2', mode: 'e2ee', storedContent: encrypted,
      resourceDataKey })).toBeNull();
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'passkey-1', mode: 'plain', storedContent: encrypted })).toBeNull();
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...passkey, value: 'must-not-flatten' }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...passkey, source: { ...passkey.source, algorithm: -257 } }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...passkey, source: { ...passkey.source, backupEligibility: false } }).success).toBe(false);
  });
  it('round trips an external descriptor without a copied value in both Account modes', () => {
    const external = { v: 2 as const, name: 'Vault token', kind: 'token' as const,
      source: { kind: 'external' as const, contribution: { pluginId: 'acme.vault', localId: 'vault' },
        account: 'my-account', reference: 'op://vault/item/token' } };
    const parsed = SavedSecretResourceContentV1Schema.parse(external);
    for (const mode of ['plain', 'e2ee'] as const) {
      const resourceDataKey = new Uint8Array(32).fill(9);
      const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'external', mode, content: parsed,
        resourceDataKey, randomBytes: deterministicRandomBytes });
      expect(openSavedSecretResourceStoredContentV1({ resourceId: 'external', mode, storedContent, resourceDataKey })).toEqual(external);
      expect(prepareSavedSecretResourceUpdateContentV1({ resourceId: 'external', resourceMode: mode, accountMode: mode,
        storedContent, resourceDataKey, nextName: 'Renamed' })?.content).toEqual({ ...external, name: 'Renamed' });
    }
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...external, value: 'copied' }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...external, source: { ...external.source, machineId: 'pinned' } }).success).toBe(false);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'external', mode: 'plain',
      storedContent: { t: 'plain', v: { ...external, v: 3 } } })).toBeNull();
  });
  it('opens a retained resource by its own mode and owns the update mode and explicit Home directive', () => {
    const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'retained-key', mode: 'plain', content });
    const input = { resourceId: 'retained-key', resourceMode: 'plain' as const, accountMode: 'e2ee' as const,
      storedContent, nextValue: 'rotated-key' };
    expect(prepareSavedSecretResourceUpdateContentV1(input)).toEqual({
      content: { ...content, value: 'rotated-key' }, mode: 'e2ee', toMode: 'e2ee',
    });
    expect(prepareSavedSecretResourceUpdateContentV1({ ...input, toMode: 'plain' })).toEqual({
      content: { ...content, value: 'rotated-key' }, mode: 'plain', toMode: 'plain',
    });
    expect(prepareSavedSecretResourceUpdateContentV1({ ...input, resourceMode: 'e2ee' })).toBeNull();
  });
  it('opens retained plain and encrypted Secret content while keeping declared bindings and writes strict', () => {
    const resourceDataKey = new Uint8Array(32).fill(7);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-1', mode: 'plain',
      storedContent: { t: 'plain', v: { ...content, retired: true }, retired: true } })).toEqual(content);
    const payload = { v: 1, resourceId: 'resource-1', mode: 'e2ee', content: { ...content, retired: true }, retired: true };
    const storedContent = { t: 'encrypted', c: sealRawPayload(payload, resourceDataKey), retired: true };
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-1', mode: 'e2ee', storedContent, resourceDataKey }))
      .toEqual(content);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-2', mode: 'e2ee', storedContent, resourceDataKey }))
      .toBeNull();
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-1', mode: 'plain',
      storedContent: { t: 'plain', v: { ...content, value: '' }, retired: true } })).toBeNull();
    expect(SavedSecretResourceContentV1Schema.safeParse(payload.content).success).toBe(false);
  });
  it('keeps the action-admitted content schemas browser-neutral while crypto retains the compatibility export', () => {
    expect(SavedSecretResourceContentV1Schema).toBe(BrowserSafeSavedSecretResourceContentV1Schema);
    expect(SavedSecretResourceStoredContentV1Schema).toBe(BrowserSafeSavedSecretResourceStoredContentV1Schema);
  });

  it('keeps content and both stored envelope arms closed while reusing Saved Secret field bounds', () => {
    expect(SavedSecretResourceContentV1Schema.parse(content)).toEqual(content);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, extra: true }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, name: 'n'.repeat(101) }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, kind: 'certificate' }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, value: '' }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.parse({ ...content, value: ' \t ' }).value).toBe(' \t ');
    expect(SavedSecretResourceContentV1Schema.safeParse({
      ...content,
      value: 'x'.repeat(ACCOUNT_SETTING_MAX_STRING_BYTES + 1),
    }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({
      ...content,
      value: '\u0000'.repeat(ACCOUNT_SETTING_MAX_STRING_BYTES),
    }).success).toBe(false);

    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'plain', v: content, extra: true }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'encrypted', c: 'AA==', extra: true }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'encrypted', c: 'AA==' }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'encrypted', c: 'not canonical base64' }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({
      t: 'encrypted',
      c: encodeBase64(new Uint8Array(SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1), 'base64'),
    }).success).toBe(true);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({
      t: 'encrypted',
      c: encodeBase64(new Uint8Array(SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1 + 1), 'base64'),
    }).success).toBe(false);
  });

  it('round-trips E2EE content and binds ciphertext to its resource id and mode', () => {
    const resourceDataKey = new Uint8Array(32).fill(7);
    const stored = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      content,
      resourceDataKey,
      randomBytes: deterministicRandomBytes,
    });

    expect(stored.t).toBe('encrypted');
    expect(SavedSecretResourceStoredContentV1Schema.parse(stored)).toEqual(stored);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: stored,
      resourceDataKey,
    })).toEqual(content);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-2',
      mode: 'e2ee',
      storedContent: stored,
      resourceDataKey,
    })).toBeNull();
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'plain',
      storedContent: stored,
    })).toBeNull();

    const corrupted = decodeBase64(stored.t === 'encrypted' ? stored.c : '', 'base64');
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: { t: 'encrypted', c: encodeBase64(corrupted, 'base64') },
      resourceDataKey,
    })).toBeNull();
  });

  it.each([
    ['wrong codec version', { v: 2, resourceId: 'resource-1', mode: 'e2ee', content }],
    ['wrong bound mode', { v: 1, resourceId: 'resource-1', mode: 'plain', content }],
  ])('rejects decrypted payloads with %s', (_label, payload) => {
    const resourceDataKey = new Uint8Array(32).fill(7);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: { t: 'encrypted', c: sealRawPayload(payload, resourceDataKey) },
      resourceDataKey,
    })).toBeNull();
  });

  it('seals and opens a plain resource without key material or randomness', () => {
    const stored = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'plain',
      content,
    });

    expect(stored).toEqual({ t: 'plain', v: content, storage: { kind: 'value' } });
    expect(SavedSecretResourceStoredContentV1Schema.parse(stored)).toEqual(stored);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'plain',
      storedContent: stored,
    })).toEqual(content);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: stored,
      resourceDataKey: new Uint8Array(32).fill(7),
    })).toBeNull();
  });
});
