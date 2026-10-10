import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../../crypto/base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '../../server/http/requestBodyBoundsV1.js';
import {
  PatchSessionDataKeyEnvelopesResultV1Schema,
  PatchSessionDataKeyEnvelopesV1Schema,
  SESSION_DATA_KEY_ENVELOPE_BASE64_LENGTH_V1,
  SESSION_DATA_KEY_ENVELOPE_BYTES_V1,
  SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
  SESSION_DATA_KEY_ENVELOPE_RECIPIENT_ACCOUNT_ID_MAX_LENGTH_V1,
  SessionDataKeyEnvelopeErrorCodeV1Schema,
  SessionDataKeyEnvelopePageQueryV1Schema,
  SessionDataKeyEnvelopePageV1Schema,
  SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
  SessionRecipientEnvelopeInputV1Schema,
  classifySessionDataKeyEnvelopeItemV1,
  decodeSessionDataKeyEnvelopeCursorV1,
  encodeSessionDataKeyEnvelopeCursorV1,
} from './sessionDataKeyEnvelopes.js';

const signingKeyPair = tweetnacl.sign.keyPair();
const recipientBoxKeyPair = tweetnacl.box.keyPair();

const contentPublicKeyB64 = encodeBase64(recipientBoxKeyPair.publicKey);
const contentPublicKeySignatureB64 = encodeBase64(
  tweetnacl.sign.detached(recipientBoxKeyPair.publicKey, signingKeyPair.secretKey),
);
const accountSigningPublicKeyHex = Buffer.from(signingKeyPair.publicKey).toString('hex');

function sealedEnvelopeB64(): string {
  return encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: tweetnacl.randomBytes(32),
    recipientPublicKey: recipientBoxKeyPair.publicKey,
    randomBytes: (length) => tweetnacl.randomBytes(length),
  }));
}

const availableContentKey = {
  status: 'available',
  accountSigningPublicKey: accountSigningPublicKeyHex,
  contentPublicKey: contentPublicKeyB64,
  contentPublicKeySignature: contentPublicKeySignatureB64,
} as const;

describe('session data-key envelope collection contract', () => {
  it('admits the approved 500-recipient atomic fanout page', () => {
    expect(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1).toBe(500);
  });

  it('initializes from its direct entrypoint before the Action catalog', () => {
    // A fresh Node graph catches an initialization cycle that a previously
    // initialized root barrel hides.
    execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `const module = await import('./sessionDataKeyEnvelopes.ts');
       const parsed = module.SessionDataKeyEnvelopePageQueryV1Schema.parse({});
       if (parsed.state !== 'action_required') throw new Error('Query entrypoint did not initialize');`,
    ], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' });
  });

  it('binds the wire envelope size to the canonical fixed data-key codec', () => {
    expect(SESSION_DATA_KEY_ENVELOPE_BYTES_V1).toBe(105);
    expect(SESSION_DATA_KEY_ENVELOPE_BASE64_LENGTH_V1).toBe(140);
    expect(sealedEnvelopeB64()).toHaveLength(SESSION_DATA_KEY_ENVELOPE_BASE64_LENGTH_V1);
  });
});

describe('SessionDataKeyEnvelopePageQueryV1', () => {
  it('defaults to the action-required exception page and a full page limit', () => {
    expect(SessionDataKeyEnvelopePageQueryV1Schema.parse({})).toEqual({
      state: 'action_required',
      limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    });
  });

  it('accepts querystring numbers and the diagnostic all state', () => {
    expect(SessionDataKeyEnvelopePageQueryV1Schema.parse({ state: 'all', limit: '12' })).toEqual({
      state: 'all',
      limit: 12,
    });
  });

  it('rejects out-of-range, fractional, unknown, and non-page states', () => {
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({
      limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1,
    }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ state: 'pending' }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ teamId: 'team-1' }).success).toBe(false);
  });

  it('accepts only a cursor this service produced', () => {
    const cursor = encodeSessionDataKeyEnvelopeCursorV1('account-42');
    expect(SessionDataKeyEnvelopePageQueryV1Schema.parse({ cursor }).cursor).toBe(cursor);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ cursor: 'account-42' }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ cursor: 'cursor_v1_account-42' }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageQueryV1Schema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('session data-key envelope cursor', () => {
  it('round-trips an opaque Account ID keyset position', () => {
    const accountId = 'account/with+separators=and spaces';
    const cursor = encodeSessionDataKeyEnvelopeCursorV1(accountId);
    expect(cursor).not.toContain(accountId);
    expect(decodeSessionDataKeyEnvelopeCursorV1(cursor)).toBe(accountId);
  });

  it('rejects a foreign, empty, or tampered cursor', () => {
    expect(decodeSessionDataKeyEnvelopeCursorV1('cursor_v1_account-1')).toBeNull();
    expect(decodeSessionDataKeyEnvelopeCursorV1('')).toBeNull();
    expect(decodeSessionDataKeyEnvelopeCursorV1(encodeSessionDataKeyEnvelopeCursorV1('a') + '!!')).toBeNull();
    expect(decodeSessionDataKeyEnvelopeCursorV1(
      encodeSessionDataKeyEnvelopeCursorV1('a').replace(/[^_]+$/u, ''),
    )).toBeNull();
  });

  it('accepts a one-character Account ID like the canonical indexed identifiers', () => {
    const cursor = encodeSessionDataKeyEnvelopeCursorV1('a');
    expect(decodeSessionDataKeyEnvelopeCursorV1(cursor)).toBe('a');
    expect(SessionDataKeyEnvelopeRecipientAccountIdV1Schema.safeParse('a').success).toBe(true);
    expect(SessionDataKeyEnvelopeRecipientAccountIdV1Schema.safeParse(' a').success).toBe(false);
    expect(SessionDataKeyEnvelopeRecipientAccountIdV1Schema.safeParse('a ').success).toBe(false);
  });

  it('refuses to encode an out-of-contract Account ID', () => {
    expect(() => encodeSessionDataKeyEnvelopeCursorV1('')).toThrow();
    expect(() => encodeSessionDataKeyEnvelopeCursorV1(
      'a'.repeat(SESSION_DATA_KEY_ENVELOPE_RECIPIENT_ACCOUNT_ID_MAX_LENGTH_V1 + 1),
    )).toThrow();
  });
});

describe('SessionDataKeyEnvelopePageV1', () => {
  const requiredPage = {
    status: 'required',
    summary: { prepared: 15, pending: 2, invalid: 0, recipientKeyUnavailable: 1 },
    items: [
      { recipientAccountId: 'account-1', envelopeState: 'missing', contentKey: availableContentKey },
      {
        recipientAccountId: 'account-2',
        envelopeState: 'missing',
        contentKey: { status: 'unavailable', reason: 'plain_account' },
      },
    ],
    nextCursor: null,
  } as const;

  it('accepts a required page and a plain not-required page', () => {
    expect(SessionDataKeyEnvelopePageV1Schema.parse(requiredPage)).toEqual(requiredPage);
    expect(SessionDataKeyEnvelopePageV1Schema.parse({ ...requiredPage, summary: null }))
      .toEqual({ ...requiredPage, summary: null });
    expect(SessionDataKeyEnvelopePageV1Schema.parse({ status: 'not_required' }))
      .toEqual({ status: 'not_required' });
  });

  it('keeps the plain exit free of recipient key work', () => {
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      status: 'not_required',
      summary: requiredPage.summary,
    }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      status: 'not_required',
      items: [],
    }).success).toBe(false);
  });

  it('never carries roster, grant-source, or profile topology', () => {
    for (const extra of [
      { teamId: 'team-1' },
      { groupId: 'group-1' },
      { grantSource: 'team' },
      { displayName: 'Alice' },
      { avatar: 'https://example.invalid/a.png' },
      { role: 'admin' },
    ]) {
      expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
        ...requiredPage,
        items: [{ ...requiredPage.items[0], ...extra }],
      }).success).toBe(false);
    }
  });

  it('requires a complete summary, closed states, and closed unavailable reasons', () => {
    const { invalid: _invalid, ...partialSummary } = requiredPage.summary;
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      summary: partialSummary,
    }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      summary: { ...requiredPage.summary, prepared: -1 },
    }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      summary: { ...requiredPage.summary, recipientSetupRequired: 1 },
    }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      items: [{ ...requiredPage.items[0], envelopeState: 'pending' }],
    }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      items: [{
        recipientAccountId: 'account-2',
        envelopeState: 'missing',
        contentKey: { status: 'unavailable', reason: 'not_a_reason' },
      }],
    }).success).toBe(false);
  });

  it('accepts an available binding only at real signing and box key sizes', () => {
    const reject = (contentKey: unknown) => expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      items: [{ recipientAccountId: 'account-1', envelopeState: 'missing', contentKey }],
    }).success).toBe(false);

    reject({ ...availableContentKey, accountSigningPublicKey: accountSigningPublicKeyHex.slice(0, 62) });
    reject({ ...availableContentKey, accountSigningPublicKey: contentPublicKeyB64 });
    reject({ ...availableContentKey, contentPublicKey: encodeBase64(new Uint8Array(31)) });
    reject({ ...availableContentKey, contentPublicKeySignature: encodeBase64(new Uint8Array(63)) });
    reject({ ...availableContentKey, reason: 'plain_account' });
    reject({ status: 'unavailable', reason: 'plain_account', contentPublicKey: contentPublicKeyB64 });
  });

  it('bounds one page by the shared page maximum', () => {
    const item = requiredPage.items[0];
    const items = Array.from(
      { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1 },
      (_value, index) => ({ ...item, recipientAccountId: `account-${index}` }),
    );
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({ ...requiredPage, items }).success).toBe(false);
    expect(SessionDataKeyEnvelopePageV1Schema.safeParse({
      ...requiredPage,
      items: items.slice(0, SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1),
    }).success).toBe(true);
  });
});

describe('classifySessionDataKeyEnvelopeItemV1', () => {
  it('gives unavailable recipient readiness exclusive precedence over stored bytes', () => {
    for (const reason of ['plain_account', 'encryption_setup_required', 'encryption_inconsistent'] as const) {
      for (const envelopeState of ['prepared', 'missing', 'invalid'] as const) {
        expect(classifySessionDataKeyEnvelopeItemV1({
          recipientAccountId: 'account-1',
          envelopeState,
          contentKey: { status: 'unavailable', reason },
        })).toBe('recipientKeyUnavailable');
      }
    }
  });

  it('classifies an available recipient by its stored envelope bytes', () => {
    const classify = (envelopeState: 'prepared' | 'missing' | 'invalid') =>
      classifySessionDataKeyEnvelopeItemV1({
        recipientAccountId: 'account-1',
        envelopeState,
        contentKey: availableContentKey,
      });

    expect(classify('prepared')).toBe('prepared');
    expect(classify('missing')).toBe('pending');
    expect(classify('invalid')).toBe('invalid');
  });
});

describe('PatchSessionDataKeyEnvelopesV1', () => {
  const entry = (recipientAccountId: string) => ({
    recipientAccountId,
    encryptedDataKey: sealedEnvelopeB64(),
  });

  it('accepts a bounded page of real sealed envelopes', () => {
    const entries = Array.from(
      { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 },
      (_value, index) => entry(`account-${index}`),
    );
    expect(PatchSessionDataKeyEnvelopesV1Schema.parse({ entries }).entries).toHaveLength(entries.length);
  });

  it('requires at least one entry and rejects more than one atomic page', () => {
    expect(PatchSessionDataKeyEnvelopesV1Schema.safeParse({ entries: [] }).success).toBe(false);
    expect(PatchSessionDataKeyEnvelopesV1Schema.safeParse({
      entries: Array.from(
        { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1 },
        (_value, index) => entry(`account-${index}`),
      ),
    }).success).toBe(false);
  });

  it('rejects duplicate recipients in one request', () => {
    expect(PatchSessionDataKeyEnvelopesV1Schema.safeParse({
      entries: [entry('account-1'), entry('account-1')],
    }).success).toBe(false);
  });

  it('rejects any envelope that is not canonical base64 of the exact fixed size', () => {
    const sealed = sealedEnvelopeB64();
    const invalid = [
      sealed.slice(0, -4),
      `${sealed}AAAA`,
      `${sealed.slice(0, -2)}==`,
      `${sealed.slice(0, -1)}!`,
      encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1).fill(0xff), 'base64url'),
      ` ${sealed}`,
      encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1 - 1)),
      encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1 + 1)),
      '',
    ];
    for (const encryptedDataKey of invalid) {
      expect(PatchSessionDataKeyEnvelopesV1Schema.safeParse({
        entries: [{ recipientAccountId: 'account-1', encryptedDataKey }],
      }).success).toBe(false);
    }
  });

  it('rejects unknown request or entry fields', () => {
    expect(PatchSessionDataKeyEnvelopesV1Schema.safeParse({
      entries: [entry('account-1')],
      idempotencyKey: 'k1',
    }).success).toBe(false);
    expect(PatchSessionDataKeyEnvelopesV1Schema.safeParse({
      entries: [{ ...entry('account-1'), expectedRevision: 3 }],
    }).success).toBe(false);
  });

  it('fits a worst-case request inside the canonical server request-body boundary', () => {
    const worstCase = JSON.stringify({
      entries: Array.from({ length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 }, () => ({
        recipientAccountId: 'a'.repeat(SESSION_DATA_KEY_ENVELOPE_RECIPIENT_ACCOUNT_ID_MAX_LENGTH_V1),
        encryptedDataKey: 'A'.repeat(SESSION_DATA_KEY_ENVELOPE_BASE64_LENGTH_V1),
      })),
    });
    expect(new TextEncoder().encode(worstCase).byteLength)
      .toBeLessThan(SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1);
  });

  it('settles with a committed count and no per-entry receipt', () => {
    expect(PatchSessionDataKeyEnvelopesResultV1Schema.parse({ appliedCount: 0 }))
      .toEqual({ appliedCount: 0 });
    expect(PatchSessionDataKeyEnvelopesResultV1Schema.safeParse({ appliedCount: -1 }).success).toBe(false);
    expect(PatchSessionDataKeyEnvelopesResultV1Schema.safeParse({
      appliedCount: 1,
      results: [{ recipientAccountId: 'account-1', applied: true }],
    }).success).toBe(false);
  });
});

describe('SessionDataKeyEnvelopeErrorCodeV1', () => {
  it('is the closed transport-aligned code set', () => {
    expect(SessionDataKeyEnvelopeErrorCodeV1Schema.options).toEqual([
      'invalid_request',
      'invalid_cursor',
      'session_not_found',
      'forbidden',
      'session_access_authentication_required',
      'session_access_authentication_unavailable',
      'data_key_not_required',
      'recipient_envelope_required',
      'recipient_changed',
      'recipient_key_unavailable',
      'session_data_key_unavailable',
    ]);
    expect(SessionDataKeyEnvelopeErrorCodeV1Schema.safeParse('conflict').success).toBe(false);
    expect(SessionDataKeyEnvelopeErrorCodeV1Schema.safeParse('retryable').success).toBe(false);
  });
});

describe('SessionRecipientEnvelopeInputV1', () => {
  it('accepts exactly one versioned canonical envelope', () => {
    const encryptedDataKey = sealedEnvelopeB64();
    expect(SessionRecipientEnvelopeInputV1Schema.parse({
      v: 1,
      encryptedDataKey,
    })).toEqual({ v: 1, encryptedDataKey });
  });

  it('rejects an unversioned or wrongly versioned input', () => {
    const encryptedDataKey = sealedEnvelopeB64();
    expect(SessionRecipientEnvelopeInputV1Schema.safeParse({ encryptedDataKey }).success).toBe(false);
    expect(SessionRecipientEnvelopeInputV1Schema.safeParse({ v: 2, encryptedDataKey }).success).toBe(false);
    expect(SessionRecipientEnvelopeInputV1Schema.safeParse({ v: '1', encryptedDataKey }).success).toBe(false);
  });

  it('rejects envelope bytes the canonical codec could not have produced', () => {
    for (const encryptedDataKey of [
      encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1 - 1)),
      encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1 + 1)),
      encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1).fill(0xff), 'base64url'),
      '',
    ]) {
      expect(SessionRecipientEnvelopeInputV1Schema.safeParse({
        v: 1,
        encryptedDataKey,
      }).success).toBe(false);
    }
  });

  // The grant operation must be able to answer `invalid_request` for a Plain
  // Session that was handed recipient material, so unknown members cannot be
  // silently dropped into an ignored-field shape the way released v1 allows.
  it('rejects unknown members instead of stripping them', () => {
    expect(SessionRecipientEnvelopeInputV1Schema.safeParse({
      v: 1,
      encryptedDataKey: sealedEnvelopeB64(),
      recipientAccountId: 'account-1',
    }).success).toBe(false);
  });
});

describe('SessionDataKeyEnvelopeErrorCodeV1 grant composition', () => {
  it('names the omitted-envelope case distinctly from a malformed one', () => {
    expect(SessionDataKeyEnvelopeErrorCodeV1Schema.safeParse('recipient_envelope_required').success)
      .toBe(true);
  });
});
