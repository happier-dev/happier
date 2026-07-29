import { describe, expect, it } from 'vitest';

import {
  QualifiedConnectedAccountCredentialPayloadV1Schema,
  openQualifiedConnectedAccountContentEnvelope,
  sealQualifiedConnectedAccountContentEnvelope,
} from './qualifiedConnectedAccountContentEnvelope.js';

const material = {
  type: 'dataKey' as const,
  machineKey: new Uint8Array(32).fill(7),
};

describe('qualified Connected Account content-envelope codec', () => {
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
});
