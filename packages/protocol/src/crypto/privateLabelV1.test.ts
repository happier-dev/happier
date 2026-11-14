import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';

import { encodeBase64 } from './base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from './encryptedDataKeyEnvelopeV1.js';
import {
  openPrivateLabelV1,
  parsePrivateLabelStoredV1,
  projectPrivateLabelForRecipientV1,
  sealPrivateLabelV1,
  serializePrivateLabelStoredV1,
  validatePrivateLabelStoredForModeV1,
} from './privateLabelV1.js';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      out[index] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

const binding = { entity: 'team_credential_resource', field: 'displayName', id: 'credential-1' } as const;
const fingerprint = `content-public-key-sha256:${'a'.repeat(64)}`;
const teamResourceReadPolicy = { kind: 'team-resource' } as const;

function recipient(accountId: string, keyByte: number) {
  const secretKey = new Uint8Array(32).fill(keyByte);
  const publicKey = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
  const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
    dataKey: new Uint8Array(32).fill(4),
    recipientPublicKey: publicKey,
    randomBytes: deterministicRandomBytesFactory(),
  });
  return {
    accountId,
    envelope: {
      encryptedDataKey: encodeBase64(encryptedDataKey, 'base64'),
      recipientContentPublicKeyFingerprint: fingerprint,
    },
  };
}

describe('privateLabelV1', () => {
  it('keeps plain labels keyless and projects no recipient material', () => {
    const stored = sealPrivateLabelV1({ mode: 'plain', binding, value: 'Billing credential' });

    expect(stored).toEqual({ content: { t: 'plain', v: 'Billing credential' }, recipients: [] });
    // Account-owned content follows the captured persisted Account mode, while
    // a Team resource follows its own strict stored arm rather than viewer mode.
    expect(openPrivateLabelV1({
      binding,
      label: stored,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' },
    })).toBeNull();
    expect(openPrivateLabelV1({
      binding,
      label: stored,
      readPolicy: { kind: 'team-resource' },
    })).toBe('Billing credential');
    expect(projectPrivateLabelForRecipientV1({ stored, recipientAccountId: 'member-1' }))
      .toEqual({ content: { t: 'plain', v: 'Billing credential' }, recipientEnvelope: null });
  });

  it('seals an E2EE label to a field identity and projects only the reader envelope', () => {
    const owner = recipient('owner-1', 9);
    const member = recipient('member-1', 10);
    const dataKey = new Uint8Array(32).fill(4);
    const stored = sealPrivateLabelV1({
      mode: 'e2ee',
      binding,
      value: 'Production deploy credential',
      dataKey,
      recipients: [owner, member],
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(stored.content.t).toBe('encrypted');
    expect(JSON.stringify(stored)).not.toContain('Production deploy credential');
    expect(openPrivateLabelV1({ binding, label: stored, readPolicy: teamResourceReadPolicy, dataKey })).toBe('Production deploy credential');
    expect(openPrivateLabelV1({
      binding,
      label: stored,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' },
      dataKey,
    })).toBe('Production deploy credential');
    expect(openPrivateLabelV1({ binding: { ...binding, field: 'subjectDisplayName' }, label: stored, readPolicy: teamResourceReadPolicy, dataKey })).toBeNull();
    expect(openPrivateLabelV1({ binding: { ...binding, id: 'credential-2' }, label: stored, readPolicy: teamResourceReadPolicy, dataKey })).toBeNull();
    expect(openPrivateLabelV1({ binding: { ...binding, entity: 'team_credential_activity' }, label: stored, readPolicy: teamResourceReadPolicy, dataKey })).toBeNull();

    const projected = projectPrivateLabelForRecipientV1({ stored, recipientAccountId: 'member-1' });
    expect(projected).toEqual({ content: stored.content, recipientEnvelope: member.envelope });
    expect(projected).not.toHaveProperty('recipients');
    expect(openPrivateLabelV1({ binding, label: projected, readPolicy: teamResourceReadPolicy, dataKey })).toBe('Production deploy credential');
    expect(projectPrivateLabelForRecipientV1({ stored, recipientAccountId: 'not-a-recipient' }))
      .toEqual({ content: stored.content, recipientEnvelope: null });
  });

  it('allows legacy raw plaintext only when a released storage owner explicitly opts in', () => {
    const plain = sealPrivateLabelV1({ mode: 'plain', binding, value: 'Legacy compatible' });

    expect(parsePrivateLabelStoredV1('Historic credential')).toEqual({ kind: 'invalid' });
    expect(parsePrivateLabelStoredV1('Historic credential', { allowLegacyPlaintext: true })).toEqual({
      kind: 'legacy_plain',
      stored: { content: { t: 'plain', v: 'Historic credential' }, recipients: [] },
    });
    expect(parsePrivateLabelStoredV1(serializePrivateLabelStoredV1(plain))).toEqual({
      kind: 'current',
      stored: plain,
    });
    expect(parsePrivateLabelStoredV1('{"content":{"t":"encrypted","c":"not-base64"},"recipients":[]}', {
      allowLegacyPlaintext: true,
    }))
      .toEqual({ kind: 'invalid' });
  });

  it('opens explicitly projected legacy plaintext in E2EE without admitting a current Plain envelope', () => {
    const legacy = { content: { t: 'plain' as const, v: 'Historic label' }, recipientEnvelope: null, legacyPlaintext: true as const };
    expect(openPrivateLabelV1({ binding, label: legacy,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBe('Historic label');
    expect(validatePrivateLabelStoredForModeV1({ mode: 'plain', stored: { ...legacy, recipients: [] } }))
      .toEqual({ kind: 'invalid_stored_content' });
    expect(openPrivateLabelV1({ binding, label: { ...legacy, legacyPlaintext: undefined },
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBeNull();
    for (const serialized of ['{"content":{"t":"encrypted"', '{"t":"encrypted","c":"broken"}',
      '{"content":{"t":"encrypted","c":"broken"},"recipients":[]}']) {
      expect(parsePrivateLabelStoredV1(serialized, { allowLegacyPlaintext: true })).toEqual({ kind: 'invalid' });
    }
  });

  it('admits labels only in their persisted owner mode before storage or disclosure', () => {
    const plain = sealPrivateLabelV1({ mode: 'plain', binding, value: 'Plain credential' });
    const encrypted = sealPrivateLabelV1({
      mode: 'e2ee',
      binding,
      value: 'Encrypted credential',
      dataKey: new Uint8Array(32).fill(4),
      recipients: [recipient('owner-1', 9)],
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(validatePrivateLabelStoredForModeV1({ mode: 'plain', stored: plain })).toEqual({
      kind: 'available', stored: plain,
    });
    expect(validatePrivateLabelStoredForModeV1({ mode: 'e2ee', stored: encrypted })).toEqual({
      kind: 'available', stored: encrypted,
    });
    expect(validatePrivateLabelStoredForModeV1({ mode: 'plain', stored: encrypted })).toEqual({
      kind: 'mode_mismatch',
    });
    expect(validatePrivateLabelStoredForModeV1({ mode: 'e2ee', stored: plain })).toEqual({
      kind: 'mode_mismatch',
    });
    expect(validatePrivateLabelStoredForModeV1({ mode: 'e2ee', stored: { content: { t: 'encrypted', c: 'bad' }, recipients: [] } }))
      .toEqual({ kind: 'invalid_stored_content' });
  });
});
