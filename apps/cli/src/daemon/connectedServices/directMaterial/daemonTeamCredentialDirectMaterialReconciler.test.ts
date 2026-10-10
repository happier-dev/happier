import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps } from '@happier-dev/protocol';
import {
  NO_TEAM_CAPABILITIES_V1,
  TeamCredentialResourcePageV1Schema,
  TeamCredentialResourceSummaryV1Schema,
  TeamsPageV1Schema,
  type TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';
import type { TeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';

vi.mock('./teamCredentialDirectMaterialHttp', () => ({
  fetchTeamCredentialDirectMaterialCensus: vi.fn(async () => ({ recipients: [], nextCursor: null })),
  fetchTeamCredentialDirectMaterialPreparation: vi.fn(),
  upsertTeamCredentialDirectMaterial: vi.fn(),
}));

import { createDaemonTeamCredentialDirectMaterialReconciler } from './daemonTeamCredentialDirectMaterialReconciler';
import {
  fetchTeamCredentialDirectMaterialPreparation,
} from './teamCredentialDirectMaterialHttp';

const ACCOUNT_ID = 'custodian';

// Both page shapes are built through their own released schemas, so a fixture
// the reconciler's parser would reject fails here instead of silently
// producing an empty resource list.
const teamsPage = TeamsPageV1Schema.parse({
  items: [{
    id: 'team',
    name: 'Team',
    description: null,
    logo: null,
    archivedAt: null,
    recovery: null,
    policy: {
      v: 1,
      sessionCreationPolicy: 'private_default',
      externalSharingPolicy: 'allowed',
      defaultSessionHistoryAccess: 'from_membership',
      admissionMode: 'invite_only',
      authenticationPolicy: null,
      authenticationPolicyStatus: 'available',
    },
    viewerRole: 'member',
    capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
    admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
    counts: null,
  }],
  nextCursor: null,
});

function summary(input: Readonly<{ id: string; custodianAccountId?: string }>): TeamCredentialResourceSummaryV1 {
  return TeamCredentialResourceSummaryV1Schema.parse({
    id: input.id,
    teamId: 'team',
    custodianAccountId: input.custodianAccountId ?? ACCOUNT_ID,
    sourceOwnerDisplayName: null,
    displayName: input.id,
    enabled: true,
    revision: 1,
    disclosureCeiling: 'direct_allowed',
    sessionUsePolicy: 'personal_allowed',
    source: {
      v: 1,
      kind: 'provider_connection',
      connectionId: 'pc_source',
      connectionSecurityFingerprint: 'connection-security:v1:test',
      credentialSlotId: 'apiKey',
    },
    sourcePresentation: {
      kind: 'provider',
      provider: { identity: { pluginId: 'provider.test', localId: 'test' }, definitionRevision: 1 },
    },
    directExportSupport: 'supported',
    activeUsageLimitCount: 0,
    requestPolicy: null,
    brokerPlacement: null,
    allMembersDeliveryMode: 'direct',
    groupGrants: [],
    memberGrants: [],
    readiness: { kind: 'available' },
    recoveryAction: null,
    brokerPresentation: {
      selectedTarget: null,
      eligibleTargets: [],
      selectedPool: null,
      eligiblePools: [],
    },
    capabilities: {
      manageAudience: false,
      managePolicy: false,
      manageLimits: false,
      updateBrokerPlacement: false,
      narrowDisclosure: false,
      widenDisclosure: false,
      refreshDirectMaterial: false,
      disable: false,
      enable: false,
      delete: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

const sourceSnapshot = {
  currentness: {
    sourceMember: { kind: 'provider_credential_slot', connectionId: 'pc_source', credentialSlotId: 'apiKey' },
    sourceVersion: 'source-v1',
    isCurrent: async () => true,
  },
  material: {
    kind: 'provider_api_key',
    value: 'source-secret',
    runtimeBinding: {
      provider: { identity: { pluginId: 'provider.test', localId: 'test' }, definitionRevision: 1 },
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://api.example.test/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      credentialTransport: {
        id: 'api-key', protocols: ['openai-responses'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      },
    },
  },
} as unknown as TeamCredentialSourceSnapshot;

function reconciler(homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>) {
  return createDaemonTeamCredentialDirectMaterialReconciler({
    token: 'token',
    accountId: ACCOUNT_ID,
    homeDomainAction,
    establishedRuntimeOwner: { readMaterialSnapshot: vi.fn() },
    listAccounts: vi.fn(async () => ({ accounts: [] })),
    readGroup: vi.fn(async () => null),
    resolveProviderSource: vi.fn(async () => sourceSnapshot),
  });
}

describe('daemon Team credential direct-material reconciler', () => {
  beforeEach(() => { vi.mocked(fetchTeamCredentialDirectMaterialPreparation).mockReset(); });

  // The administration list is paginated, so an owned direct resource beyond
  // the first page must still be reconciled instead of silently reported clean.
  it('drains every credential-resource page of a Team', async () => {
    const owned = summary({ id: 'owned-on-page-two' });
    const foreign = summary({ id: 'other-team-member-source', custodianAccountId: 'someone-else' });
    const homeDomainAction = vi.fn(async (request: Readonly<{ actionId: string; input?: unknown }>) => {
      if (request.actionId === 'teams.list') return teamsPage;
      const input = request.input as Readonly<{ cursor?: string | null }>;
      return TeamCredentialResourcePageV1Schema.parse(input?.cursor === 'page-two'
        ? {
          resources: [owned],
          viewer: { manageCredentials: false, offerOwnCredential: true },
          nextCursor: null,
        }
        : {
          resources: [foreign],
          viewer: { manageCredentials: false, offerOwnCredential: true },
          nextCursor: 'page-two',
        });
    }) as unknown as NonNullable<ActionExecutorDeps['homeDomainAction']>;
    vi.mocked(fetchTeamCredentialDirectMaterialPreparation).mockResolvedValue({
      homeServerIdentityId: 'home',
      teamId: 'team',
      resourceId: owned.id,
      resourceRevision: 1,
      source: owned.source!,
      sourceMember: { kind: 'provider_credential_slot', connectionId: 'pc_source', credentialSlotId: 'apiKey' },
      sourceCredentialIncarnation: null,
      publishedSourceVersion: null,
      recipients: [],
      nextCursor: null,
    } as never);

    await expect(reconciler(homeDomainAction).reconcile(
      { teamId: 'team', resourceId: owned.id },
    )).resolves.toMatchObject({ prepared: 0, failures: [] });

    expect(fetchTeamCredentialDirectMaterialPreparation).toHaveBeenCalledTimes(1);
    expect(fetchTeamCredentialDirectMaterialPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: owned.id }),
    );
  });
});
