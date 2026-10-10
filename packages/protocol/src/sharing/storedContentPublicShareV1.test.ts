import { describe, expect, it } from 'vitest';
import { buildStoredContentPublicShareUrlV1, generateStoredContentPublicShareMaterialV1,
  readStoredContentPublicShareSecretV1, StoredContentPublicShareCreateRequestV1Schema,
  StoredContentPublicShareReadResponseV1Schema } from './storedContentPublicShareV1.js';

describe('stored-content fragment capabilities', () => {
  it('preserves the explicitly confirmed network-off publication policy and opens predecessor reads with the original policy', () => {
    const request = { subject: { kind: 'session', id: 's' }, lookupId: 'lookup', keyDerivation: 'fragment_v1', networkOff: true };
    expect(StoredContentPublicShareCreateRequestV1Schema.parse(request)).toMatchObject({ networkOff: true });
    const value = { subject: { kind: 'session', id: 's' }, encryptionMode: 'plain', encryptedDataKey: null,
      keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: true,
      content: { kind: 'session', metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        messages: [], hasMore: false, nextBeforeSeq: null } };
    expect(StoredContentPublicShareReadResponseV1Schema.parse(value).networkOff).toBe(true);
    const { networkOff: _networkOff, ...predecessor } = value;
    expect(StoredContentPublicShareReadResponseV1Schema.parse(predecessor).networkOff).toBe(false);
    expect(StoredContentPublicShareReadResponseV1Schema.safeParse({ ...value, networkOff: 'off' }).success).toBe(false);
  });
  it('keeps independent capabilities in the path and fragment and rejects fragment corruption', () => {
    let value = 1;
    const material = generateStoredContentPublicShareMaterialV1(length => new Uint8Array(length).fill(value++));
    const url = new URL(buildStoredContentPublicShareUrlV1({ origin: 'https://public.example', ...material }));
    expect(url.pathname).toBe(`/s/${material.lookupId}`);
    expect(url.pathname).not.toContain(material.secret);
    expect(readStoredContentPublicShareSecretV1(url.hash)).toBe(material.secret);
    expect(readStoredContentPublicShareSecretV1('')).toBeNull();
    expect(readStoredContentPublicShareSecretV1(`#k=corrupt`)).toBeNull();
    expect(readStoredContentPublicShareSecretV1(`${url.hash}&k=${material.secret}`)).toBeNull();
    expect(StoredContentPublicShareCreateRequestV1Schema.safeParse({ subject: {kind:'artifact',id:'a'},
      lookupId:material.lookupId,keyDerivation:'fragment_v1',secret:material.secret }).success).toBe(false);
  });
  it('rejects subject substitution and mode/key disagreements in public content', () => {
    const value = { subject:{kind:'artifact',id:'a'},encryptionMode:'plain',encryptedDataKey:null,
      keyDerivation:'fragment_v1',isConsentRequired:false,
      content:{kind:'artifact',header:'header',body:'body',headerVersion:1,bodyVersion:1} };
    expect(StoredContentPublicShareReadResponseV1Schema.safeParse(value).success).toBe(true);
    expect(StoredContentPublicShareReadResponseV1Schema.safeParse({...value,subject:{kind:'session',id:'s'}}).success).toBe(false);
    expect(StoredContentPublicShareReadResponseV1Schema.safeParse({...value,encryptionMode:'e2ee'}).success).toBe(false);
  });
});
