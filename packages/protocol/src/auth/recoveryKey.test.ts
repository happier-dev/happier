import { describe, expect, it } from 'vitest';

import {
  formatRecoveryKey,
  isValidRecoveryKey,
  normalizeRecoveryKey,
  parseRecoveryKey,
} from './recoveryKey';

const sequentialBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const sequentialBase64Url = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const sequentialBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const sequentialDashedBase32 = 'AAAQE-AYEAU-DAOCA-JBIFQ-YDIOB-4IBCE-QTCQK-RMFYY-DENBW-HA5DY-PQ';
const patternedBytes = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 13) % 256);
const patternedDashedBase32 = 'BUKBW-IRJGA-3T4RK-MKNNG-C2DPO-Z6YJC-4STGQ-KPLVV-XTB4V-UOY37-TA';
const dashUnderscoreBase64Url = 'v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v78';

describe('recoveryKey format', () => {
  it('formats 32-byte keys as the canonical dashed Base32 display form', () => {
    expect(formatRecoveryKey(sequentialBytes)).toBe(sequentialDashedBase32);
    expect(formatRecoveryKey(patternedBytes)).toBe(patternedDashedBase32);
    expect(formatRecoveryKey(new Uint8Array(32).fill(255))).toBe(
      '77777-77777-77777-77777-77777-77777-77777-77777-77777-77777-7Q',
    );
  });

  it('rejects formatting for keys that are not exactly 32 bytes', () => {
    expect(() => formatRecoveryKey(new Uint8Array(16))).toThrow(/32/u);
    expect(() => formatRecoveryKey(new Uint8Array(64))).toThrow(/32/u);
  });
});

describe('recoveryKey parse', () => {
  it('round-trips the canonical dashed Base32 display form to the exact bytes', () => {
    expect(parseRecoveryKey(sequentialDashedBase32)).toEqual({ ok: true, bytes: sequentialBytes });
    expect(parseRecoveryKey(patternedDashedBase32)).toEqual({ ok: true, bytes: patternedBytes });
    expect(parseRecoveryKey('77777-77777-77777-77777-77777-77777-77777-77777-77777-77777-7Q')).toEqual({
      ok: true,
      bytes: new Uint8Array(32).fill(255),
    });
  });

  it('accepts the proven raw Base64url form, including keys containing - and _', () => {
    expect(parseRecoveryKey(sequentialBase64Url)).toEqual({ ok: true, bytes: sequentialBytes });
    expect(parseRecoveryKey(dashUnderscoreBase64Url)).toEqual({
      ok: true,
      bytes: new Uint8Array(32).fill(0xbf),
    });
  });

  it('accepts the proven padded Base64 form', () => {
    expect(parseRecoveryKey(sequentialBase64)).toEqual({ ok: true, bytes: sequentialBytes });
  });

  it('accepts lowercase and documented dash or whitespace separators', () => {
    const whitespaceSeparated = sequentialDashedBase32
      .replace(/-/gu, ' ')
      .replace(' ', '\n');
    expect(parseRecoveryKey(sequentialDashedBase32.toLowerCase())).toEqual({
      ok: true,
      bytes: sequentialBytes,
    });
    expect(parseRecoveryKey(whitespaceSeparated)).toEqual({ ok: true, bytes: sequentialBytes });
    const surroundedAndSpaced = ` \n\t${sequentialDashedBase32.toLowerCase().replace(/-/gu, ' - ')}\t\n `;
    expect(parseRecoveryKey(surroundedAndSpaced)).toEqual({ ok: true, bytes: sequentialBytes });
  });

  it('applies the released 0/1/8/9 confusion normalization without lossy guessing', () => {
    const confused = sequentialDashedBase32.replace(/O/gu, '0').replace(/I/gu, '1').replace(/B/gu, '8');
    expect(parseRecoveryKey(confused)).toEqual({ ok: true, bytes: sequentialBytes });
    const nines = patternedDashedBase32.replace(/G/gu, '9');
    expect(parseRecoveryKey(nines)).toEqual({ ok: true, bytes: patternedBytes });
  });

  it('rejects empty and character-free input with typed reasons', () => {
    expect(parseRecoveryKey('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseRecoveryKey('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseRecoveryKey('!!!')).toEqual({ ok: false, reason: 'unsupported_characters' });
  });

  it('rejects lossy cleanup, undocumented separators, and non-canonical Base32 tail bits', () => {
    expect(parseRecoveryKey(`${sequentialBase64Url.slice(0, 10)}!${sequentialBase64Url.slice(10)}`)).toEqual({
      ok: false,
      reason: 'invalid_encoding',
    });
    expect(parseRecoveryKey(`[${sequentialDashedBase32.replace(/-/g, '._/')}]`)).toEqual({
      ok: false,
      reason: 'unsupported_characters',
    });
    expect(parseRecoveryKey(`${sequentialBase64Url.slice(0, 12)}\t${sequentialBase64Url.slice(12)}`)).toEqual({
      ok: false,
      reason: 'invalid_encoding',
    });
    expect(parseRecoveryKey(`${sequentialDashedBase32.slice(0, -1)}R`)).toEqual({
      ok: false,
      reason: 'invalid_encoding',
    });
  });

  it('rejects wrong-size raw and display forms with the decoded byte length', () => {
    expect(parseRecoveryKey('AAAAAAAAAAAAAAAAAAAAAA')).toEqual({
      ok: false,
      reason: 'invalid_length',
      byteLength: 13,
    });
    expect(parseRecoveryKey('A'.repeat(86))).toEqual({
      ok: false,
      reason: 'invalid_length',
      byteLength: 53,
    });
    expect(parseRecoveryKey('AAAAA-BBBBB')).toEqual({
      ok: false,
      reason: 'invalid_length',
      byteLength: 6,
    });
  });
});

describe('recoveryKey normalize and validate', () => {
  it('normalizes proven forms to canonical Base64url', () => {
    expect(normalizeRecoveryKey(sequentialBase64Url)).toBe(sequentialBase64Url);
    expect(normalizeRecoveryKey(sequentialBase64)).toBe(sequentialBase64Url);
    expect(normalizeRecoveryKey(sequentialDashedBase32)).toBe(sequentialBase64Url);
    expect(normalizeRecoveryKey(dashUnderscoreBase64Url)).toBe(dashUnderscoreBase64Url);
  });

  it('throws for input that cannot normalize', () => {
    expect(() => normalizeRecoveryKey('!!!')).toThrow();
    expect(() => normalizeRecoveryKey('AAAAA-BBBBB')).toThrow(/Invalid key length/u);
  });

  it('validates proven forms and rejects invalid sizes', () => {
    expect(isValidRecoveryKey(sequentialBase64Url)).toBe(true);
    expect(isValidRecoveryKey(sequentialBase64)).toBe(true);
    expect(isValidRecoveryKey(dashUnderscoreBase64Url)).toBe(true);
    expect(isValidRecoveryKey(sequentialDashedBase32)).toBe(true);
    expect(isValidRecoveryKey('')).toBe(false);
    expect(isValidRecoveryKey('   ')).toBe(false);
    expect(isValidRecoveryKey('not-valid')).toBe(false);
    expect(isValidRecoveryKey('AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(isValidRecoveryKey('A'.repeat(86))).toBe(false);
  });
});
