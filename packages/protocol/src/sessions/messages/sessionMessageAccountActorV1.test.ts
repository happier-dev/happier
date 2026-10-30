import { describe, expect, it } from 'vitest';

import {
  SessionMessageAccountActorV1Schema,
  deriveSessionMessageAuthorAccountIdV1,
} from './sessionMessageAccountActorV1.js';

const ACCOUNT_RECEIPT = {
  v: 1,
  issuer: 'authenticatedAccount',
  actorAccountId: 'acc_alice',
  sessionRelationship: 'sharedEditor',
} as const;

describe('SessionMessageAccountActorV1Schema', () => {
  it('accepts a resolved actor with its neutral display profile', () => {
    expect(SessionMessageAccountActorV1Schema.parse({
      v: 1,
      accountId: 'acc_alice',
      profile: { firstName: 'Alice', lastName: null, username: null, avatarUrl: null },
    })).toEqual({
      v: 1,
      accountId: 'acc_alice',
      profile: { name: 'Alice', firstName: 'Alice', lastName: null, username: null, avatarUrl: null },
    });
  });

  it('accepts a retained actor identity whose Account no longer exists', () => {
    expect(SessionMessageAccountActorV1Schema.parse({
      v: 1,
      accountId: 'acc_alice',
      profile: null,
    }).profile).toBeNull();
  });

  it('accepts an explicit current/former presentation relationship without treating it as access', () => {
    expect(SessionMessageAccountActorV1Schema.parse({
      v: 1,
      accountId: 'acc_alice',
      profile: { firstName: 'Alice', lastName: null, username: null, avatarUrl: null },
      accessibility: 'former',
    }).accessibility).toBe('former');
    expect(SessionMessageAccountActorV1Schema.safeParse({
      v: 1,
      accountId: 'acc_alice',
      profile: null,
      accessibility: 'owner',
    }).success).toBe(false);
  });

  it('rejects admission relationship, receipt, and access disclosure', () => {
    for (const forbidden of [
      { sessionRelationship: 'owner' },
      { inputAdmissionReceipt: ACCOUNT_RECEIPT },
      { accessLevel: 'editor' },
      { teamId: 'team_1' },
      { email: 'a@example.test' },
    ]) {
      expect(SessionMessageAccountActorV1Schema.safeParse({
        v: 1,
        accountId: 'acc_alice',
        profile: null,
        ...forbidden,
      }).success).toBe(false);
    }
  });

  it('rejects a missing or unknown version and a blank Account id', () => {
    expect(SessionMessageAccountActorV1Schema.safeParse({ accountId: 'acc_alice', profile: null }).success).toBe(false);
    expect(SessionMessageAccountActorV1Schema.safeParse({ v: 2, accountId: 'acc_alice', profile: null }).success).toBe(false);
    expect(SessionMessageAccountActorV1Schema.safeParse({ v: 1, accountId: '   ', profile: null }).success).toBe(false);
  });
});

describe('deriveSessionMessageAuthorAccountIdV1', () => {
  it('derives the exact admitted Account id for a role-user row', () => {
    expect(deriveSessionMessageAuthorAccountIdV1({
      messageRole: 'user',
      inputAdmissionReceipt: ACCOUNT_RECEIPT,
    })).toBe('acc_alice');
  });

  it('derives the same id for every Account relationship, including Team/Group-derived editors', () => {
    for (const sessionRelationship of ['owner', 'sharedEditor', 'sharedAdmin'] as const) {
      expect(deriveSessionMessageAuthorAccountIdV1({
        messageRole: 'user',
        inputAdmissionReceipt: { ...ACCOUNT_RECEIPT, sessionRelationship },
      })).toBe('acc_alice');
    }
  });

  it('returns null for machine admission', () => {
    expect(deriveSessionMessageAuthorAccountIdV1({
      messageRole: 'user',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    })).toBeNull();
  });

  it('returns null for a non-user role even with a valid Account receipt', () => {
    expect(deriveSessionMessageAuthorAccountIdV1({
      messageRole: 'agent',
      inputAdmissionReceipt: ACCOUNT_RECEIPT,
    })).toBeNull();
    expect(deriveSessionMessageAuthorAccountIdV1({
      messageRole: null,
      inputAdmissionReceipt: ACCOUNT_RECEIPT,
    })).toBeNull();
  });

  it('returns null for legacy, malformed, and unknown-version receipts', () => {
    for (const receipt of [
      null,
      undefined,
      {},
      { v: 2, issuer: 'authenticatedAccount', actorAccountId: 'acc_alice', sessionRelationship: 'owner' },
      { v: 1, issuer: 'authenticatedAccount', sessionRelationship: 'owner' },
      { v: 1, issuer: 'authenticatedAccount', actorAccountId: '  ', sessionRelationship: 'owner' },
      { v: 1, issuer: 'somethingElse', actorAccountId: 'acc_alice' },
    ]) {
      expect(deriveSessionMessageAuthorAccountIdV1({
        messageRole: 'user',
        inputAdmissionReceipt: receipt,
      })).toBeNull();
    }
  });

  it('never accepts a caller-supplied author id in place of the receipt', () => {
    expect(deriveSessionMessageAuthorAccountIdV1({
      messageRole: 'user',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', actorAccountId: 'acc_mallory' },
    })).toBeNull();
  });
});
