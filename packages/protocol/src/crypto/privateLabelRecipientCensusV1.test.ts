import { describe, expect, it } from 'vitest';

import * as protocol from './privateLabelRecipientCensusV1.js';
import * as rootProtocol from '../index.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { encodeBase64 } from './base64.js';

const contentPublicKey = new Uint8Array(32).fill(7);

const recipient = {
  account: {
    kind: 'account' as const,
    accountId: 'account-1',
    name: 'Account One',
    firstName: null,
    lastName: null,
    username: null,
    avatarUrl: null,
  },
  readiness: {
    status: 'available' as const,
    contentPublicKey: encodeBase64(contentPublicKey, 'base64'),
    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey),
  },
  envelopeStatus: 'missing' as const,
};

describe('private-label recipient census contract', () => {
  it('admits only a concrete Account or Team owner and returns the server-selected mode and recipients', () => {
    const teamRequest = { owner: { kind: 'team' as const, teamId: 'team-1' } };
    const accountRequest = { owner: { kind: 'account' as const, accountId: 'account-1' } };
    const response = { contentEncryptionMode: 'e2ee' as const, recipients: [recipient] };

    expect(protocol.PrivateLabelRecipientCensusRequestV1Schema.parse(teamRequest)).toEqual(teamRequest);
    expect(protocol.PrivateLabelRecipientCensusRequestV1Schema.parse(accountRequest)).toEqual(accountRequest);
    expect(protocol.PrivateLabelRecipientCensusResponseV1Schema.parse(response)).toEqual(response);
    expect(protocol.PrivateLabelRecipientCensusRequestV1Schema.safeParse({ owner: { kind: 'team' } }).success).toBe(false);
    expect(protocol.PrivateLabelRecipientCensusResponseV1Schema.safeParse({ recipients: [recipient] }).success).toBe(false);
    expect(rootProtocol.PrivateLabelRecipientCensusResponseV1Schema)
      .toBe(protocol.PrivateLabelRecipientCensusResponseV1Schema);
  });
});
