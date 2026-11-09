import { describe, expect, it } from 'vitest';

import {
  QualifiedConnectedAccountCredentialPayloadV1Schema,
  openQualifiedConnectedAccountContentEnvelope,
  openQualifiedConnectedAccountContentEnvelopeResult,
  resolveQualifiedConnectedAccountCredentialValuesV1,
  sealQualifiedConnectedAccountContentEnvelope,
} from './qualifiedConnectedAccountContentEnvelope.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';

const material = {
  type: 'dataKey' as const,
  machineKey: new Uint8Array(32).fill(7),
};

describe('qualified Connected Account content-envelope codec', () => {
  it.each(['plain', 'e2ee'] as const)('distinguishes a decoded null %s draft from failed decoding', accountMode => {
    const envelope = sealQualifiedConnectedAccountContentEnvelope({ kind: 'attempt', accountMode,
      material, payload: null, randomBytes: length => new Uint8Array(length).fill(2) });
    expect(openQualifiedConnectedAccountContentEnvelopeResult({ kind: 'attempt', accountMode,
      material, envelope })).toEqual({ status: 'opened', value: null });
    expect(openQualifiedConnectedAccountContentEnvelopeResult({ kind: 'attempt',
      accountMode: accountMode === 'plain' ? 'e2ee' : 'plain', material, envelope }))
      .toEqual({ status: 'unavailable' });
    if (accountMode === 'e2ee') {
      expect(openQualifiedConnectedAccountContentEnvelopeResult({ kind: 'attempt', accountMode,
        material: { ...material, machineKey: new Uint8Array(32).fill(9) }, envelope }))
        .toEqual({ status: 'unavailable' });
    }
  });

  it('freezes a bounded generic plugin credential map without legacy provider fields', () => {
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
      v: 1,
      values: {
        apiKey: 'key',
        serviceAccountJson: '{"type":"service_account"}',
        setupToken: 'setup-token',
      },
    })).toEqual({
      v: 1,
      values: {
        apiKey: 'key',
        serviceAccountJson: '{"type":"service_account"}',
        setupToken: 'setup-token',
      },
    });
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1,
      values: { '': 'secret' },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1,
      values: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`key${index}`, 'value']),
      ),
    }).success).toBe(false);
    const inherited = Object.assign(
      Object.create({ inheritedCredential: 'must-not-read' }),
      { token: 'secret' },
    );
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1,
      values: inherited,
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1,
      values: JSON.parse('{"constructor":"secret"}'),
    }).success).toBe(false);
  });

  it('keeps plain payloads plain and rejects a mode mismatch', () => {
    const envelope = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: { token: 'plain-value' },
      randomBytes: (length) => new Uint8Array(length).fill(1),
    });
    expect(envelope).toEqual({
      t: 'plain',
      v: { token: 'plain-value' },
    });
    expect(openQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      envelope,
    })).toEqual({ token: 'plain-value' });
    expect(openQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'e2ee',
      envelope,
      material,
    })).toBeNull();
  });

  it('seals E2EE credential and configuration payloads under distinct kinds', () => {
    const randomBytes = (length: number) => new Uint8Array(length).fill(2);
    const credential = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'e2ee',
      material,
      payload: { token: 'secret' },
      randomBytes,
    });
    const configuration = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'configuration',
      accountMode: 'e2ee',
      material,
      payload: { region: 'eu' },
      randomBytes,
    });

    expect(credential.t).toBe('encrypted');
    expect(configuration.t).toBe('encrypted');
    expect(openQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'e2ee',
      material,
      envelope: credential,
    })).toEqual({ token: 'secret' });
    expect(openQualifiedConnectedAccountContentEnvelope({
      kind: 'configuration',
      accountMode: 'e2ee',
      material,
      envelope: configuration,
    })).toEqual({ region: 'eu' });
    expect(openQualifiedConnectedAccountContentEnvelope({
      kind: 'configuration',
      accountMode: 'e2ee',
      material,
      envelope: credential,
    })).toBeNull();
  });

  it('holds a declared secret as one Saved Secret reference and resolves its current value late', async () => {
    const ref = formatSharedSavedSecretRefV1('anthropic-key');
    const payload = QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
      v: 1, values: { identity: 'acct-1' }, secretRefs: { token: ref },
    });
    expect(JSON.stringify(payload)).not.toContain('sk-ant');
    // The single record owns the bytes; rotating it is what every reader sees next.
    const store = new Map([[ref, 'sk-ant-first']]);
    const read = async (reference: string) => store.get(reference) ?? null;
    expect(await resolveQualifiedConnectedAccountCredentialValuesV1(payload, read))
      .toEqual({ v: 1, values: { identity: 'acct-1', token: 'sk-ant-first' } });
    store.set(ref, 'sk-ant-rotated');
    expect(await resolveQualifiedConnectedAccountCredentialValuesV1(payload, read))
      .toEqual({ v: 1, values: { identity: 'acct-1', token: 'sk-ant-rotated' } });
    store.delete(ref);
    await expect(resolveQualifiedConnectedAccountCredentialValuesV1(payload, read))
      .rejects.toMatchObject({ code: 'connected_account_credential_secret_unavailable' });
    // A raw payload needs no reader at all.
    expect(await resolveQualifiedConnectedAccountCredentialValuesV1({ v: 1, values: { token: 'raw' } },
      async () => { throw new Error('raw payload must not read Saved Secrets'); })).toEqual({ v: 1, values: { token: 'raw' } });
  });

  it('refuses double custody and non-resource references in one credential', () => {
    const ref = formatSharedSavedSecretRefV1('anthropic-key');
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1, values: { token: 'sk-ant-raw' }, secretRefs: { token: ref },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1, values: {}, secretRefs: { token: 'personal-secret-id' },
    }).success).toBe(false);
    expect(QualifiedConnectedAccountCredentialPayloadV1Schema.safeParse({
      v: 1, values: {}, secretRefs: JSON.parse(`{"__proto__":"${ref}"}`),
    }).success).toBe(false);
  });
});
