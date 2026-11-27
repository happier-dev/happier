import { describe, expect, it, vi } from 'vitest';

import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams';

import { prepareTeamCredentialDirectMaterial } from './teamCredentialDirectMaterialProducer';

const sourceAccount = Object.freeze({
  service: Object.freeze({ pluginId: 'plugin.acme', localId: 'service' }),
  accountId: 'source-account',
});
const sourceMember = Object.freeze({
  kind: 'connected_account' as const,
  service: sourceAccount.service,
  connectedAccountId: sourceAccount.accountId,
});
const snapshot = Object.freeze({
  currentness: Object.freeze({
    sourceMember,
    sourceVersion: 'canonical-source-version',
    isCurrent: vi.fn(async () => true),
  }),
  material: Object.freeze({
    kind: 'qualified_connected_account' as const,
    credential: Object.freeze({ v: 1 as const, values: Object.freeze({ token: 'source-token' }) }),
    configuration: Object.freeze({
      values: Object.freeze({ endpoint: 'https://example.test' }),
      secretValues: Object.freeze({ clientSecret: 'resolved-secret' }),
    }),
    authenticationModeId: 'token',
  }),
});
function current(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    sourceAccount,
    sourceMember,
    sourceCredentialIncarnation: 'credential-incarnation-1',
    publishedSourceVersion: null,
    expectedResourceRevision: 7,
    expectedStoredSourceVersion: null,
    recipientMode: 'plain' as const,
    recipientContentPublicKeyFingerprint: null,
    ...overrides,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  const expected = current();
  return {
    sourceSnapshot: snapshot,
    expected,
    homeServerIdentityId: 'home-1',
    teamId: 'team-1',
    resourceId: 'resource-1',
    recipientAccountId: 'recipient-1',
    ...overrides,
  };
}

describe('prepareTeamCredentialDirectMaterial', () => {
  it('uses the canonical source snapshot version and forwards exact CAS/binding inputs', async () => {
    const params = input();
    const result = await prepareTeamCredentialDirectMaterial(params);
    const expectedVersion = snapshot.currentness.sourceVersion;
    expect(result).toMatchObject({ ok: true, item: {
      recipientAccountId: 'recipient-1',
      sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(sourceMember),
      sourceVersion: expectedVersion,
      expectedResourceRevision: 7,
      expectedStoredSourceVersion: null,
      expectedPublishedSourceVersion: null,
      recipientMode: 'plain',
      recipientContentPublicKeyFingerprint: null,
    } });
  });

  it('returns a typed cancellation before sealing', () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const params = input({ signal: controller.signal });
    expect(prepareTeamCredentialDirectMaterial(params)).toEqual({
      ok: false,
      reason: 'cancelled',
    });
  });
});
