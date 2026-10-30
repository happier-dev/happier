import { describe, expect, it } from 'vitest';

import {
  TeamCredentialSourceLocatorV1Schema,
  TeamCredentialSourceResourceAdministrationV1Schema,
  TeamCredentialSourceResourceListInputV1Schema,
  TeamCredentialSourceResourceListOutputV1Schema,
  TeamCredentialSourceCandidateListOutputV1Schema,
  TeamCredentialSourceCandidateV1Schema,
  teamCredentialSourceCandidateIdV1,
} from './sourceCandidatesV1.js';

it('bounds source-resource continuation inputs and outputs', () => {
  const source = { v: 1 as const, kind: 'provider_connection' as const, connectionId: 'connection-1' };
  expect(TeamCredentialSourceResourceListInputV1Schema.parse({ source })).toMatchObject({ limit: 50 });
  expect(TeamCredentialSourceResourceListInputV1Schema.safeParse({ source, limit: 101 }).success).toBe(false);
  expect(TeamCredentialSourceResourceListOutputV1Schema.parse({ resources: [] })).toEqual({ resources: [], nextCursor: null });
});

// A real contribution identity: the binding carries the canonical qualified
// service, so a fixture that invented an id would prove the schema accepts a
// shape no Home can produce.
const SERVICE = { pluginId: 'happier.connected-account.test', localId: 'subscription' } as const;

function poolSource(poolIncarnation: string) {
  return {
    v: 1 as const,
    kind: 'connected_pool' as const,
    target: { kind: 'group' as const, service: SERVICE, groupId: 'pool-1' },
    poolIncarnation,
  };
}

describe('team credential source candidates', () => {
  it('uses a strict stable source locator without treating source revisions as identity', () => {
    expect(TeamCredentialSourceResourceListInputV1Schema.parse({
      source: {
        v: 1,
        kind: 'connected_pool',
        target: { kind: 'group', service: SERVICE, groupId: 'pool-1' },
      },
    })).toEqual({
      limit: 50,
      source: {
        v: 1,
        kind: 'connected_pool',
        target: { kind: 'group', service: SERVICE, groupId: 'pool-1' },
      },
    });
    expect(TeamCredentialSourceLocatorV1Schema.safeParse({
      v: 1,
      kind: 'connected_pool',
      target: { kind: 'group', service: SERVICE, groupId: 'pool-1' },
      poolIncarnation: 'must-not-be-required-or-accepted',
    }).success).toBe(false);
  });

  it('keeps source-owned administration rows closed and free of Team audience details', () => {
    const row = {
      id: 'resource-1',
      displayName: 'Shared source',
      enabled: true,
      revision: 2,
      deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
      brokerPlacement: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      readiness: { kind: 'available' },
      recoveryAction: null,
      capabilities: {
        manageAudience: false,
        managePolicy: false,
        manageLimits: false,
        updateBrokerPlacement: true,
        updateDeliveryPolicy: true,
        narrowDisclosure: true,
        widenDisclosure: false,
        refreshDirectMaterial: false,
        disable: true,
        enable: false,
        delete: true,
      },
      createdAt: '2026-09-14T12:00:00.000Z',
      updatedAt: '2026-09-14T12:00:00.000Z',
    } as const;
    expect(TeamCredentialSourceResourceAdministrationV1Schema.parse(row)).toEqual(row);
    expect(TeamCredentialSourceResourceAdministrationV1Schema.safeParse({
      ...row,
      teamId: 'team-private',
      groupGrants: [{ teamGroupId: 'group-private', deliveryMode: 'direct' }],
      requestPolicy: null,
    }).success).toBe(false);
  });

  it('keeps a deleted-and-recreated Pool separately selectable from the one it replaced', () => {
    // The logical id survives deletion, so an identity built from it would let a
    // chooser offer the replacement under the identity of the Pool the resource
    // was pinned to. The pinned lifetime is the only thing that distinguishes
    // them, which is exactly why it is part of the identity.
    expect(teamCredentialSourceCandidateIdV1(poolSource('incarnation-a')))
      .not.toBe(teamCredentialSourceCandidateIdV1(poolSource('incarnation-b')));
  });

  it('accepts a chooser row carrying the pin, a name and nothing else', () => {
    const source = poolSource('incarnation-a');
    const parsed = TeamCredentialSourceCandidateV1Schema.parse({
      source,
      candidateId: teamCredentialSourceCandidateIdV1(source),
      label: 'Claude Enterprise',
      memberCount: 3,
      offeredByResourceId: null,
    });

    // The pin is the whole reason this projection exists: a client cannot see
    // it, so it must survive the round trip byte for byte to be sent back.
    expect(parsed.source).toEqual(source);
    expect(parsed.directExportSupport).toBe('unsupported');
  });

  it('refuses a candidate carrying anything beyond the chooser projection', () => {
    const parsed = TeamCredentialSourceCandidateV1Schema.safeParse({
      source: poolSource('incarnation-a'),
      candidateId: teamCredentialSourceCandidateIdV1(poolSource('incarnation-a')),
      label: 'Claude Enterprise',
      memberCount: 3,
      offeredByResourceId: null,
      // A credential fact has no business on a chooser row; strictness is what
      // keeps a later producer from quietly widening this seam.
      token: 'sk-secret',
    });

    expect(parsed.success).toBe(false);
  });

  it('reports an unsupported source family as unsupported rather than as an empty list', () => {
    const page = TeamCredentialSourceCandidateListOutputV1Schema.parse({
      candidates: [],
      supportedKinds: ['connected_pool'],
    });

    // "You own no Pools" and "this Home cannot pin Provider connections yet" are
    // different answers with different next actions, so the page carries both.
    expect(page.supportedKinds).toEqual(['connected_pool']);
  });
});
