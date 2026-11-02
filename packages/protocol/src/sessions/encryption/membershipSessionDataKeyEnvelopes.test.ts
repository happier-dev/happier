import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../../crypto/base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { encodeV2SessionListCursorV1 } from '../listing/cursor.js';
import {
  SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
  encodeSessionDataKeyEnvelopeCursorV1,
} from './sessionDataKeyEnvelopes.js';
import {
  MembershipSessionDataKeyEnvelopePageQueryV1Schema,
  MembershipSessionDataKeyEnvelopePageV1Schema,
  MembershipSessionDataKeyEnvelopeErrorV1Schema,
  PatchMembershipSessionDataKeyEnvelopesResultV1Schema,
  PatchMembershipSessionDataKeyEnvelopesV1Schema,
  decodeMembershipSessionDataKeyEnvelopeCursorV1,
  encodeMembershipSessionDataKeyEnvelopeCursorV1,
} from './membershipSessionDataKeyEnvelopes.js';

function sealedEnvelopeBase64(fill: number): string {
  return encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: new Uint8Array(32).fill(fill),
    recipientPublicKey: new Uint8Array(32).fill(9),
    randomBytes: (length) => new Uint8Array(length).fill(fill),
  }));
}

const envelope = sealedEnvelopeBase64(7);
const otherEnvelope = sealedEnvelopeBase64(11);

// Encodings come from the per-Session collection owner: the Account signing key
// is hex because that is what `Account.publicKey` stores and compares.
const availableContentKey = {
  status: 'available',
  accountSigningPublicKey: Buffer.from(new Uint8Array(32).fill(0xab)).toString('hex'),
  contentPublicKey: encodeBase64(new Uint8Array(32).fill(2)),
  contentPublicKeySignature: encodeBase64(new Uint8Array(64).fill(3)),
} as const;

const readyPage = {
  status: 'ready',
  recipientAccountId: 'acc_target',
  contentKey: availableContentKey,
  items: [
    { sessionId: 'ses_1', callerDataKeyEnvelope: envelope },
    { sessionId: 'ses_2', callerDataKeyEnvelope: otherEnvelope },
  ],
  exceptions: {
    callerVisibleNonTransferableSessionCount: 1,
    callerEnvelopeRepairRequiredCount: 0,
  },
  nextCursor: null,
} as const;

const patchBody = {
  recipientAccountId: 'acc_target',
  entries: [
    { sessionId: 'ses_1', encryptedDataKey: envelope },
    { sessionId: 'ses_2', encryptedDataKey: otherEnvelope },
  ],
} as const;

describe('membership session data-key envelope contract', () => {
  it('initializes from its direct entrypoint before the Action catalog', () => {
    // This module is re-exported from the Session barrel, so a fresh Node graph
    // catches an initialization cycle a previously initialized root barrel hides.
    execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `const module = await import('./membershipSessionDataKeyEnvelopes.ts');
       const parsed = module.MembershipSessionDataKeyEnvelopePageQueryV1Schema.parse({});
       if (parsed.state !== 'action_required') throw new Error('Query entrypoint did not initialize');`,
    ], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' });
  });
});

describe('membership session data-key envelope cursor', () => {
  it('round-trips a Session position and refuses every foreign cursor family', () => {
    const cursor = encodeMembershipSessionDataKeyEnvelopeCursorV1('ses_1');
    expect(cursor).not.toContain('ses_1');
    expect(decodeMembershipSessionDataKeyEnvelopeCursorV1(cursor)).toBe('ses_1');
    for (const sessionId of ['session-3', 'é/漢字']) {
      const encoded = encodeMembershipSessionDataKeyEnvelopeCursorV1(sessionId);
      expect(encoded).not.toContain(sessionId);
      expect(decodeMembershipSessionDataKeyEnvelopeCursorV1(encoded)).toBe(sessionId);
    }
    // This page walks Sessions for one membership. The activity-ordered list
    // cursor and the per-Session recipient cursor address different sequences.
    expect(decodeMembershipSessionDataKeyEnvelopeCursorV1(encodeV2SessionListCursorV1('ses_1'))).toBeNull();
    expect(decodeMembershipSessionDataKeyEnvelopeCursorV1(encodeSessionDataKeyEnvelopeCursorV1('ses_1'))).toBeNull();
    for (const invalid of [
      '',
      'ses_1',
      'msdke_cursor_v1_',
      'msdke_cursor_v1_ ses_1',
      'msdke_cursor_v1_c2VzXzE=',
      'msdke_cursor_v1_c2VzXzE$',
      'msdke_cursor_v1_c2VzXz',
      'cursor_v1_ses_1',
    ]) {
      expect(decodeMembershipSessionDataKeyEnvelopeCursorV1(invalid)).toBeNull();
    }
  });

  it('refuses to encode an out-of-contract Session position', () => {
    expect(() => encodeMembershipSessionDataKeyEnvelopeCursorV1('')).toThrow();
    expect(() => encodeMembershipSessionDataKeyEnvelopeCursorV1(' ses_1 ')).toThrow();
  });
});

describe('MembershipSessionDataKeyEnvelopePageQueryV1', () => {
  it('defaults to one full actionable page and coerces querystring numbers', () => {
    expect(MembershipSessionDataKeyEnvelopePageQueryV1Schema.parse({})).toEqual({
      state: 'action_required',
      limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    });
    expect(MembershipSessionDataKeyEnvelopePageQueryV1Schema.parse({ limit: '12' }).limit).toBe(12);
    for (const limit of [0, -1, 1.5, SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1, 'many']) {
      expect(MembershipSessionDataKeyEnvelopePageQueryV1Schema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('exposes only actionable work, its own cursor family, and no other selector', () => {
    const cursor = encodeMembershipSessionDataKeyEnvelopeCursorV1('ses_1');
    expect(MembershipSessionDataKeyEnvelopePageQueryV1Schema.parse({ cursor }).cursor).toBe(cursor);
    for (const invalid of [
      { state: 'all' },
      { state: 'prepared' },
      { cursor: encodeV2SessionListCursorV1('ses_1') },
      { cursor: encodeSessionDataKeyEnvelopeCursorV1('ses_1') },
      { cursor: '' },
      { sessionId: 'ses_1' },
      { recipientAccountId: 'acc_target' },
      { includeInaccessible: true },
    ]) {
      expect(MembershipSessionDataKeyEnvelopePageQueryV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('MembershipSessionDataKeyEnvelopeErrorV1', () => {
  it('keeps nested Team concealment and precise envelope failures in one strict wire parser', () => {
    expect(MembershipSessionDataKeyEnvelopeErrorV1Schema.parse({ error: 'membership_not_found' }))
      .toEqual({ error: 'membership_not_found' });
    expect(MembershipSessionDataKeyEnvelopeErrorV1Schema.parse({ error: 'recipient_changed' }))
      .toEqual({ error: 'recipient_changed' });
    expect(MembershipSessionDataKeyEnvelopeErrorV1Schema.safeParse({ error: 'conflict' }).success).toBe(false);
    expect(MembershipSessionDataKeyEnvelopeErrorV1Schema.safeParse({
      error: 'recipient_changed', leaked: true,
    }).success).toBe(false);
  });
});

describe('MembershipSessionDataKeyEnvelopePageV1', () => {
  it('carries the target binding once per page with a caller envelope for every actionable Session', () => {
    const parsed = MembershipSessionDataKeyEnvelopePageV1Schema.parse(readyPage);
    if (parsed.status !== 'ready') throw new Error('expected a ready page');
    expect(parsed.contentKey).toEqual(availableContentKey);
    expect(parsed.items.map((item) => item.sessionId)).toEqual(['ses_1', 'ses_2']);

    const { contentKey: _contentKey, ...withoutBinding } = readyPage;
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse(withoutBinding).success).toBe(false);
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      items: [{ sessionId: 'ses_1' }],
    }).success).toBe(false);
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      items: [{ sessionId: 'ses_1', callerDataKeyEnvelope: envelope.slice(0, -4) }],
    }).success).toBe(false);
  });

  it('carries each Session\'s stored metadata for the binding proof, and still reads an older Home without it', () => {
    const withMetadata = MembershipSessionDataKeyEnvelopePageV1Schema.parse({
      ...readyPage,
      items: [{ sessionId: 'ses_1', callerDataKeyEnvelope: envelope, metadata: 'c2VhbGVk', metadataLayoutVersion: 1 }],
    });
    if (withMetadata.status !== 'ready') throw new Error('expected a ready page');
    expect(withMetadata.items[0]).toMatchObject({ metadata: 'c2VhbGVk', metadataLayoutVersion: 1 });
    // Mixed versions: an older Home omits both; the client then reseals nothing for that item.
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      items: [{ sessionId: 'ses_1', callerDataKeyEnvelope: envelope }],
    }).success).toBe(true);
  });

  it('never pairs a page status with a contradictory recipient readiness', () => {
    // Work without a usable binding, or an unavailable page carrying one, would
    // let a client seal to a recipient the Account owner says cannot receive it.
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      contentKey: { status: 'unavailable', reason: 'encryption_setup_required' },
    }).success).toBe(false);
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      status: 'recipient_unavailable',
      recipientAccountId: 'acc_target',
      contentKey: availableContentKey,
    }).success).toBe(false);
  });

  it('refuses duplicate Sessions and pages beyond the shared bound', () => {
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      items: [
        { sessionId: 'ses_1', callerDataKeyEnvelope: envelope },
        { sessionId: 'ses_1', callerDataKeyEnvelope: otherEnvelope },
      ],
    }).success).toBe(false);
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      items: Array.from(
        { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1 },
        (_unused, index) => ({ sessionId: `ses_${index}`, callerDataKeyEnvelope: envelope }),
      ),
    }).success).toBe(false);
  });

  it('keeps recipient_unavailable free of Session identity, work, or key material', () => {
    for (const reason of ['plain_account', 'encryption_setup_required', 'encryption_inconsistent']) {
      const page = {
        status: 'recipient_unavailable',
        recipientAccountId: 'acc_target',
        contentKey: { status: 'unavailable', reason },
      };
      expect(MembershipSessionDataKeyEnvelopePageV1Schema.parse(page)).toEqual(page);
    }
    for (const invalid of [
      { contentKey: { status: 'unavailable', reason: 'not_ready' } },
      { contentKey: { status: 'unavailable' } },
      { items: [] },
      { nextCursor: null },
      { exceptions: readyPage.exceptions },
    ]) {
      expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
        status: 'recipient_unavailable',
        recipientAccountId: 'acc_target',
        contentKey: { status: 'unavailable', reason: 'plain_account' },
        ...invalid,
      }).success).toBe(false);
    }
  });

  it('never discloses inaccessible Sessions, totals, or envelope generations', () => {
    for (const leak of [
      { title: 'Quarterly planning' },
      { hiddenSessionIds: ['ses_hidden'] },
      { totalSessionCount: 42 },
      { estimatedCompletionAt: 1 },
      { hasNext: true },
      { targetEnvelopeFingerprint: 'abc' },
      { teamId: 'team-1' },
      { groupId: 'group-1' },
    ]) {
      expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({ ...readyPage, ...leak }).success).toBe(false);
    }
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      items: [{ sessionId: 'ses_1', callerDataKeyEnvelope: envelope, title: 'Quarterly planning' }],
    }).success).toBe(false);
    expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({
      ...readyPage,
      exceptions: { ...readyPage.exceptions, hiddenSessionIds: ['ses_hidden'] },
    }).success).toBe(false);
    for (const exceptions of [
      { callerVisibleNonTransferableSessionCount: -1, callerEnvelopeRepairRequiredCount: 0 },
      { callerVisibleNonTransferableSessionCount: 1.5, callerEnvelopeRepairRequiredCount: 0 },
      { callerVisibleNonTransferableSessionCount: 0 },
    ]) {
      expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({ ...readyPage, exceptions }).success).toBe(false);
    }
  });

  it('continues only through its own cursor family or an explicit end of work', () => {
    const cursor = encodeMembershipSessionDataKeyEnvelopeCursorV1('ses_2');
    const parsed = MembershipSessionDataKeyEnvelopePageV1Schema.parse({
      ...readyPage,
      exceptions: null,
      nextCursor: cursor,
    });
    expect(parsed.status === 'ready' && parsed.nextCursor).toBe(cursor);
    expect(parsed.status === 'ready' && parsed.exceptions).toBeNull();
    for (const nextCursor of [encodeV2SessionListCursorV1('ses_2'), '', 'ses_2', undefined]) {
      expect(MembershipSessionDataKeyEnvelopePageV1Schema.safeParse({ ...readyPage, nextCursor }).success).toBe(false);
    }
  });
});

describe('PatchMembershipSessionDataKeyEnvelopesV1', () => {
  it('echoes the discovery target once and commits a bounded non-empty page', () => {
    expect(PatchMembershipSessionDataKeyEnvelopesV1Schema.parse(patchBody)).toEqual(patchBody);
    for (const invalid of [
      { ...patchBody, entries: [] },
      { entries: patchBody.entries },
      { ...patchBody, recipientAccountId: '   ' },
      {
        ...patchBody,
        entries: Array.from(
          { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1 },
          (_unused, index) => ({ sessionId: `ses_${index}`, encryptedDataKey: envelope }),
        ),
      },
    ]) {
      expect(PatchMembershipSessionDataKeyEnvelopesV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects duplicate Sessions, per-entry recipients, and structurally invalid ciphertext', () => {
    for (const entries of [
      [{ sessionId: 'ses_1', encryptedDataKey: envelope }, { sessionId: 'ses_1', encryptedDataKey: otherEnvelope }],
      [{ sessionId: 'ses_1', encryptedDataKey: envelope, recipientAccountId: 'acc_other' }],
      [{ sessionId: 'ses_1', encryptedDataKey: envelope.slice(0, -4) }],
      [{ sessionId: 'ses_1', encryptedDataKey: `-${envelope.slice(1)}` }],
      [{ sessionId: '  ', encryptedDataKey: envelope }],
      [{ sessionId: 'ses_1' }],
    ]) {
      expect(PatchMembershipSessionDataKeyEnvelopesV1Schema.safeParse({ ...patchBody, entries }).success).toBe(false);
    }
  });

  it('returns an applied count without receipts, digests, or idempotency state', () => {
    expect(PatchMembershipSessionDataKeyEnvelopesResultV1Schema.parse({ appliedCount: 0 }))
      .toEqual({ appliedCount: 0 });
    for (const invalid of [
      { appliedCount: -1 },
      { appliedCount: 1.5 },
      {},
      { appliedCount: 1, receipts: [] },
      { appliedCount: 1, idempotencyKey: 'k' },
    ]) {
      expect(PatchMembershipSessionDataKeyEnvelopesResultV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
});
