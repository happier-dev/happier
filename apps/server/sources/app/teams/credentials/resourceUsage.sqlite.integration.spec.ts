import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { queryTeamCredentialUsage } from './resourceUsage';
import { removeTeamMemberForActorInTx } from '../memberships/memberAdministration';
import { recordTeamCredentialDirectDeliveryActivityInTx } from './resourceActivity';

const TEST_AUTHENTICATION = {
  env: process.env,
  authenticationAuthority: 'present_user',
  authenticationEvidence: [],
} as const;

describe('Team credential resource usage query', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'team-resource-usage-' }); }, 120_000);
  afterAll(async () => { await harness?.close(); });

  it('requires restricted-Team qualification from a current source custodian before usage disclosure', async () => {
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: {
      name: 'Restricted source usage',
      authenticationPolicy: {
        v: 1,
        mode: 'restricted',
        accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
      },
    } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'member' } });
    const resource = await db.teamCredentialResource.create({ data: {
      teamId: team.id,
      custodianAccountId: custodian.id,
      displayName: 'Restricted source',
      disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed',
      sourceBindingJson: '{}',
    } });

    await expect(queryTeamCredentialUsage(custodian.id, {
      resourceId: resource.id,
      startMs: Date.now() - 1_000,
      endMs: Date.now() + 1_000,
      granularity: 'day',
      costMode: 'auto',
    }, TEST_AUTHENTICATION)).resolves.toEqual({ ok: false, error: 'team_authentication_required' });
  });

  it('uses Account identities and immutable Group attribution for real current windows', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const other = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Usage team' } });
    const actorMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
    await db.teamMembership.createMany({ data: [
      { teamId: team.id, accountId: manager.id, role: 'admin' },
      { teamId: team.id, accountId: other.id, role: 'member' },
    ] });
    const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Builders', nameKey: 'builders' } });
    await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: actorMembership.id, nativeContribution: true } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const createdAt = new Date(Date.now() - 60_000);
    await db.teamCredentialUsageLimit.createMany({ data: [
      { resourceId: resource.id, subjectKind: 'team_member', subjectId: actor.id, period: 'day', metric: 'inference_requests', maximum: '5', createdAt },
      { resourceId: resource.id, subjectKind: 'team_group', subjectId: group.id, period: 'day', metric: 'inference_requests', maximum: '5', createdAt },
    ] });
    const actorSession = await db.session.create({ data: {
      accountId: actor.id, tag: 'usage-visible-worker-session', metadata: '{}', encryptionMode: 'plain',
    } });
    const actorEvent = await db.usageEvent.create({ data: {
      accountId: actor.id, sessionId: actorSession.id, observedAt: new Date(), agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
      requestCount: 2, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered', machineId: 'worker-one',
    } });
    await db.usageEventTeamCredentialGroupAttribution.create({ data: { usageEventId: actorEvent.id, teamGroupId: group.id } });
    await db.usageEvent.create({ data: {
      accountId: other.id, observedAt: new Date(), agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
      requestCount: 3, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: other.id, credentialDeliveryMode: 'brokered', machineId: 'worker-two',
    } });

    const result = await queryTeamCredentialUsage(actor.id, {
      resourceId: resource.id, startMs: createdAt.getTime(), endMs: Date.now() + 1000, granularity: 'day', costMode: 'auto', breakdown: 'worker_machine',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(actorMembership.id).not.toBe(actor.id);
    expect(result.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectKind: 'team_member', subjectId: actor.id, currentWindow: expect.objectContaining({ recorded: '2' }) }),
      expect.objectContaining({ subjectKind: 'team_group', subjectId: group.id, currentWindow: expect.objectContaining({ recorded: '2' }) }),
    ]));
    expect(result.breakdown).toEqual([expect.objectContaining({ key: 'worker-one' })]);
    expect(result.series[0]?.totals.requestCount).toBe(2);

    await db.teamGroupMembership.delete({
      where: { teamGroupId_teamMembershipId: { teamGroupId: group.id, teamMembershipId: actorMembership.id } },
    });
    const managerAfterRemoval = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id, startMs: createdAt.getTime(), endMs: Date.now() + 1000,
      granularity: 'day', costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in managerAfterRemoval) throw new Error('expected manager usage result');
    expect(managerAfterRemoval.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subjectKind: 'team_group',
        subjectId: group.id,
        currentWindow: expect.objectContaining({ recorded: '2' }),
      }),
    ]));
  });

  it('paginates ranked breakdowns with a stable query-bound cursor', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Paged usage team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-paged-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Paged provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const observedAt = new Date();
    await db.usageEvent.createMany({ data: Array.from({ length: 52 }, (_, index) => ({
      accountId: manager.id,
      observedAt,
      agentId: 'codex',
      source: 'codex_app_server',
      scope: 'turn_delta',
      totalTokens: 1,
      inputTokens: 1,
      teamCredentialResourceId: resource.id,
      teamCredentialActorAccountId: manager.id,
      credentialDeliveryMode: 'brokered',
      machineId: `worker-${String(index).padStart(2, '0')}`,
    })) });
    const input = {
      resourceId: resource.id,
      startMs: observedAt.getTime() - 1,
      endMs: observedAt.getTime() + 1,
      granularity: 'day' as const,
      costMode: 'auto' as const,
      breakdown: 'worker_machine' as const,
    };

    const first = await queryTeamCredentialUsage(manager.id, input, TEST_AUTHENTICATION);
    if ('ok' in first) throw new Error('expected first usage page');
    expect(first.breakdown).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await queryTeamCredentialUsage(manager.id, { ...input, cursor: first.nextCursor ?? undefined }, TEST_AUTHENTICATION);
    if ('ok' in second) throw new Error('expected second usage page');
    expect(second.breakdown).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set(
      [...(first.breakdown ?? []), ...(second.breakdown ?? [])].map((entry) => entry.key),
    ).size).toBe(52);
  });

  it('reports admitted external usage without a terminal observation as incomplete without fabricating usage', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Incomplete external usage team' } });
    const actorMembership = await db.teamMembership.create({
      data: { teamId: team.id, accountId: actor.id, role: 'member' },
    });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-incomplete-external-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Incomplete external provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const externalKey = await db.teamCredentialExternalApiKey.create({ data: {
      resourceId: resource.id, teamMembershipId: actorMembership.id, label: 'External caller',
      displayPrefix: 'hapek_v1_incomplete', secretDigest: 'incomplete-digest',
    } });
    const observedAt = new Date();
    await db.usageEvent.create({ data: {
      accountId: actor.id, observedAt, agentId: 'team_credential_broker',
      source: 'team_credential_admission', scope: 'turn_delta', requestCount: 1,
      externalKey: `external:${externalKey.id}:request-1`,
      teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
      teamCredentialExternalApiKeyId: externalKey.id, credentialDeliveryMode: 'external_api',
    } });

    const result = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id,
      startMs: observedAt.getTime() - 1,
      endMs: observedAt.getTime() + 1,
      granularity: 'day',
      costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(result.totals).toMatchObject({
      requestCount: 1,
      tokens: { total: 0 },
      cost: { costSource: 'none' },
    });
    expect(result.totals.cost.effectiveUsd).toBeUndefined();
    expect(result.coverage).toMatchObject({
      requestAdmissionCount: 1,
      agentObservationCount: 0,
      externalTerminalObservationCount: 0,
      requestCountCoverage: 'complete',
      tokenCoverage: 'unavailable',
      costCoverage: 'unavailable',
      unobservedExternalRequestCount: 1,
    });

    await db.usageEvent.create({ data: {
      accountId: actor.id, observedAt: new Date(observedAt.getTime() + 1), agentId: 'team_credential_broker',
      source: 'team_credential_external_terminal', scope: 'turn_delta', requestCount: 0,
      externalKey: `external:${externalKey.id}:request-1`,
      teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
      teamCredentialExternalApiKeyId: externalKey.id, credentialDeliveryMode: 'external_api',
    } });
    const observedResult = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id,
      startMs: observedAt.getTime() - 1,
      endMs: observedAt.getTime() + 2,
      granularity: 'day',
      costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in observedResult) throw new Error('expected usage result');
    expect(observedResult.coverage).toMatchObject({
      requestAdmissionCount: 1,
      agentObservationCount: 0,
      externalTerminalObservationCount: 1,
      requestCountCoverage: 'complete',
      tokenCoverage: 'unavailable',
      costCoverage: 'unavailable',
      unobservedExternalRequestCount: 0,
    });
  });

  it('counts public and Session admissions together while classifying terminal observations disjointly', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Disjoint coverage team' } });
    const membership = await db.teamMembership.create({
      data: { teamId: team.id, accountId: actor.id, role: 'member' },
    });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-disjoint-coverage-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Coverage provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const externalKey = await db.teamCredentialExternalApiKey.create({ data: {
      resourceId: resource.id, teamMembershipId: membership.id, label: 'Public client',
      displayPrefix: 'hapek_v1_coverage', secretDigest: 'coverage-digest',
    } });
    const session = await db.session.create({ data: {
      accountId: actor.id, tag: 'usage-disjoint-coverage-session', metadata: '{}', encryptionMode: 'plain',
    } });
    const observedAt = new Date();
    await db.usageEvent.createMany({ data: [
      {
        accountId: actor.id, sessionId: session.id, turnId: 'coverage-turn', observedAt,
        agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
        requestCount: 1, externalKey: 'session:coverage-request', teamCredentialResourceId: resource.id,
        teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered',
      },
      {
        accountId: actor.id, observedAt, agentId: 'team_credential_broker',
        source: 'team_credential_admission', scope: 'turn_delta', requestCount: 1,
        externalKey: `external:${externalKey.id}:coverage-request`, teamCredentialResourceId: resource.id,
        teamCredentialActorAccountId: actor.id, teamCredentialExternalApiKeyId: externalKey.id,
        credentialDeliveryMode: 'external_api',
      },
      {
        accountId: actor.id, sessionId: session.id, turnId: 'coverage-turn', observedAt,
        agentId: 'codex', source: 'codex_app_server', scope: 'turn_delta', totalTokens: 3,
        teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
        credentialDeliveryMode: 'brokered',
      },
      {
        accountId: actor.id, observedAt, agentId: 'team_credential_broker',
        source: 'team_credential_external_terminal', scope: 'turn_delta', requestCount: 0,
        externalKey: `external:${externalKey.id}:coverage-request`, totalTokens: 4,
        costSource: 'provider_reported', reportedCostUsd: 0.02,
        metadata: { v: 1, measurement: 'reported' },
        teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
        teamCredentialExternalApiKeyId: externalKey.id, credentialDeliveryMode: 'external_api',
      },
    ] });

    const result = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id, startMs: observedAt.getTime() - 1, endMs: observedAt.getTime() + 1,
      granularity: 'day', costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(result.coverage).toEqual({
      requestAdmissionCount: 2,
      agentObservationCount: 1,
      externalTerminalObservationCount: 1,
      directRecordedUseOnly: false,
      requestCountCoverage: 'complete',
      tokenCoverage: 'complete',
      costCoverage: 'partial',
      unobservedExternalRequestCount: 0,
    });
  });

  it('does not let an unrelated Agent observation cover another admitted request', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Correlated coverage team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-correlated-coverage-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Correlated provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const session = await db.session.create({ data: {
      accountId: manager.id, tag: 'usage-correlated-session', metadata: '{}', encryptionMode: 'plain',
    } });
    const observedAt = new Date();
    await db.usageEvent.createMany({ data: [
      {
        accountId: manager.id, sessionId: session.id, turnId: 'unobserved-turn', observedAt,
        agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
        requestCount: 1, teamCredentialResourceId: resource.id,
        teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered',
      },
      {
        accountId: manager.id, sessionId: session.id, turnId: 'different-turn', observedAt,
        agentId: 'codex', source: 'codex_app_server', scope: 'turn_delta', totalTokens: 5,
        teamCredentialResourceId: resource.id, teamCredentialActorAccountId: manager.id,
        credentialDeliveryMode: 'brokered',
      },
    ] });

    const result = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id, startMs: observedAt.getTime() - 1, endMs: observedAt.getTime() + 1,
      granularity: 'day', costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(result.coverage).toMatchObject({
      requestAdmissionCount: 1,
      agentObservationCount: 1,
      externalTerminalObservationCount: 0,
      tokenCoverage: 'partial',
      costCoverage: 'unavailable',
    });
  });

  it('reports direct observations as recorded-only with partial request and token coverage', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Direct coverage team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-direct-coverage-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Direct provider', disclosureCeiling: 'direct_allowed',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'direct',
    } });
    const observedAt = new Date();
    await db.usageEvent.create({ data: {
      accountId: manager.id, observedAt, agentId: 'codex', source: 'codex_app_server',
      scope: 'turn_delta', totalTokens: 5, teamCredentialResourceId: resource.id,
      teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'direct',
    } });

    const result = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id, startMs: observedAt.getTime() - 1, endMs: observedAt.getTime() + 1,
      granularity: 'day', costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(result.coverage).toEqual({
      requestAdmissionCount: 0,
      agentObservationCount: 1,
      externalTerminalObservationCount: 0,
      directRecordedUseOnly: true,
      requestCountCoverage: 'brokered_only',
      tokenCoverage: 'partial',
      costCoverage: 'unavailable',
      unobservedExternalRequestCount: 0,
    });
  });

  it('never reports a direct-deliverable or once-disclosed resource as completely counted from row absence', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const member = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Direct exposure coverage team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
    const directOnly = await db.teamCredentialResource.create({ data: {
      teamId: team.id, custodianAccountId: manager.id, displayName: 'Direct only',
      disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
      allMembersDeliveryMode: 'direct',
    } });
    const onceDisclosed = await db.teamCredentialResource.create({ data: {
      teamId: team.id, custodianAccountId: manager.id, displayName: 'Brokered after disclosure',
      disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
      allMembersDeliveryMode: 'brokered',
    } });
    const brokeredOnly = await db.teamCredentialResource.create({ data: {
      teamId: team.id, custodianAccountId: manager.id, displayName: 'Brokered only',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
      allMembersDeliveryMode: 'brokered',
    } });
    // The retained disclosure witness the recipient-material read writes on a
    // real first direct open — long before the queried range.
    await inTx((tx) => recordTeamCredentialDirectDeliveryActivityInTx(tx, {
      teamId: team.id, resourceId: onceDisclosed.id, recipientAccountId: member.id, subjectDisplayName: 'Member',
    }));
    const observedAt = new Date();
    await db.usageEvent.create({ data: {
      accountId: member.id, observedAt, agentId: 'team_credential_broker', source: 'team_credential_admission',
      scope: 'turn_delta', requestCount: 1, teamCredentialResourceId: onceDisclosed.id,
      teamCredentialActorAccountId: member.id, credentialDeliveryMode: 'brokered',
    } });
    const range = { startMs: observedAt.getTime() - 1_000, endMs: observedAt.getTime() + 1_000, granularity: 'day' as const, costMode: 'auto' as const };
    const coverageOf = async (accountId: string, resourceId: string) => {
      const result = await queryTeamCredentialUsage(accountId, { resourceId, ...range }, TEST_AUTHENTICATION);
      if ('ok' in result) throw new Error(`expected usage result, received ${result.error}`);
      return result.coverage;
    };

    // An empty window of a direct-only resource is not a complete zero.
    expect(await coverageOf(manager.id, directOnly.id)).toMatchObject({
      directRecordedUseOnly: true, requestCountCoverage: 'brokered_only',
    });
    expect(await coverageOf(member.id, directOnly.id)).toMatchObject({
      directRecordedUseOnly: true, requestCountCoverage: 'brokered_only',
    });
    // Material disclosed earlier stays usable outside Happier, so brokered
    // rows alone cannot make the resource's count complete.
    expect(await coverageOf(manager.id, onceDisclosed.id)).toMatchObject({
      directRecordedUseOnly: true, requestCountCoverage: 'brokered_only',
    });
    expect(await coverageOf(member.id, onceDisclosed.id)).toMatchObject({
      directRecordedUseOnly: true, requestCountCoverage: 'brokered_only',
    });
    // A resource that was never directly deliverable keeps its complete count,
    // including an empty window.
    expect(await coverageOf(manager.id, brokeredOnly.id)).toMatchObject({
      directRecordedUseOnly: false, requestCountCoverage: 'complete',
    });
  });

  it('returns typed cost-limit unavailability instead of throwing from the query', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Unavailable cost query team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-cost-unavailable-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Unpriced provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const createdAt = new Date(Date.now() - 1_000);
    await db.teamCredentialUsageLimit.create({ data: {
      resourceId: resource.id, subjectKind: 'resource', subjectId: '', period: 'day',
      metric: 'cost_usd', maximum: '10', createdAt,
    } });
    await db.usageEvent.create({ data: {
      accountId: manager.id, observedAt: new Date(), agentId: 'codex', source: 'codex_app_server',
      scope: 'turn_delta', totalTokens: 1, teamCredentialResourceId: resource.id,
      teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered',
    } });

    await expect(queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id, startMs: createdAt.getTime(), endMs: Date.now() + 1_000,
      granularity: 'day', costMode: 'auto',
    }, TEST_AUTHENTICATION)).resolves.toEqual({ ok: false, error: 'cost_limit_unavailable' });
  });

  it('subtracts the complete preceding cumulative baseline before resource and time filtering', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Baseline usage team' } });
    await db.teamMembership.createMany({ data: [
      { teamId: team.id, accountId: manager.id, role: 'admin' },
      { teamId: team.id, accountId: actor.id, role: 'member' },
    ] });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-baseline-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Current provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const priorResource = await db.teamCredentialResource.create({ data: {
      id: 'usage-baseline-prior-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Prior provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const session = await db.session.create({ data: {
      accountId: actor.id, tag: 'usage-baseline-session', metadata: '{}', encryptionMode: 'plain',
    } });
    const now = Date.now();
    const rangeStart = now - 30_000;
    await db.usageEvent.createMany({ data: [
      {
        accountId: actor.id, sessionId: session.id, observedAt: new Date(now - 60_000),
        agentId: 'codex', source: 'codex_app_server', scope: 'session_cumulative', isCumulative: true,
        inputTokens: 100, totalTokens: 100, teamCredentialResourceId: priorResource.id,
        teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered', machineId: 'worker-prior',
      },
      {
        accountId: actor.id, sessionId: session.id, observedAt: new Date(now - 10_000),
        agentId: 'codex', source: 'codex_app_server', scope: 'session_cumulative', isCumulative: true,
        inputTokens: 130, totalTokens: 130, teamCredentialResourceId: resource.id,
        teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered', machineId: 'worker-current',
      },
    ] });

    const result = await queryTeamCredentialUsage(actor.id, {
      resourceId: resource.id, startMs: rangeStart, endMs: now, granularity: 'day', costMode: 'auto', breakdown: 'worker_machine',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(result.totals.tokens.total).toBe(30);
    expect(result.series[0]?.totals.tokens.total).toBe(30);
    expect(result.breakdown).toEqual([
      expect.objectContaining({ key: 'worker-current', totals: expect.objectContaining({ tokens: expect.objectContaining({ total: 30 }) }) }),
    ]);
  });

  it('projects Group token windows through immutable admission attribution', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Group token usage team' } });
    const actorMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Builders', nameKey: 'builders' } });
    await db.teamGroupMembership.create({ data: {
      teamId: team.id, teamGroupId: group.id, teamMembershipId: actorMembership.id, nativeContribution: true,
    } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-group-token-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Group provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const session = await db.session.create({ data: {
      accountId: actor.id, tag: 'usage-group-token-session', metadata: '{}', encryptionMode: 'plain',
    } });
    const turnId = 'usage-group-token-turn';
    const nextTurnId = 'usage-group-token-next-turn';
    const observedAt = new Date();
    await db.sessionTurn.createMany({ data: [
      {
        sessionId: session.id, turnId, status: 'completed',
        startedAt: BigInt(observedAt.getTime() - 2_000), updatedAt: BigInt(observedAt.getTime() + 1),
        usageActorAccountId: actor.id, teamCredentialResourceId: resource.id, credentialDeliveryMode: 'brokered',
      },
      {
        sessionId: session.id, turnId: nextTurnId, status: 'completed',
        startedAt: BigInt(observedAt.getTime() + 2), updatedAt: BigInt(observedAt.getTime() + 4),
        usageActorAccountId: actor.id, teamCredentialResourceId: resource.id, credentialDeliveryMode: 'brokered',
      },
    ] });
    await db.teamCredentialUsageLimit.create({ data: {
      resourceId: resource.id, subjectKind: 'team_group', subjectId: group.id, period: 'day',
      metric: 'total_tokens', maximum: '100', createdAt: new Date(observedAt.getTime() - 1_000),
    } });
    const admission = await db.usageEvent.create({ data: {
      accountId: actor.id, sessionId: session.id, turnId, observedAt,
      agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
      requestCount: 1, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
      credentialDeliveryMode: 'brokered',
    } });
    await db.usageEventTeamCredentialGroupAttribution.create({ data: {
      usageEventId: admission.id, teamGroupId: group.id,
    } });
    await db.usageEvent.create({ data: {
      accountId: actor.id, sessionId: session.id, turnId, observedAt: new Date(observedAt.getTime() + 1),
      agentId: 'codex', source: 'codex_app_server', scope: 'turn_delta', inputTokens: 30, totalTokens: 30,
      teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered',
    } });
    const nextAdmission = await db.usageEvent.create({ data: {
      accountId: actor.id, sessionId: session.id, turnId: nextTurnId, observedAt: new Date(observedAt.getTime() + 3),
      agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
      requestCount: 1, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
      credentialDeliveryMode: 'brokered',
    } });
    await db.usageEventTeamCredentialGroupAttribution.create({ data: {
      usageEventId: nextAdmission.id, teamGroupId: group.id,
    } });
    await db.usageEvent.create({ data: {
      accountId: actor.id, sessionId: session.id, turnId: nextTurnId, observedAt: new Date(observedAt.getTime() + 4),
      agentId: 'codex', source: 'codex_app_server', scope: 'turn_delta', inputTokens: 20, totalTokens: 20,
      teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered',
    } });

    const result = await queryTeamCredentialUsage(actor.id, {
      resourceId: resource.id,
      startMs: observedAt.getTime() - 2_000,
      endMs: observedAt.getTime() + 2_000,
      granularity: 'day',
      costMode: 'auto',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error('expected usage result');
    expect(result.limits).toEqual([
      expect.objectContaining({
        subjectKind: 'team_group',
        subjectId: group.id,
        currentWindow: expect.objectContaining({ recorded: '20' }),
      }),
    ]);
  });

  it('labels member and external-key breakdowns for the viewer and keeps source members manager-only', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain', firstName: 'Ada', lastName: 'Lovelace', username: 'ada' } });
    const team = await db.team.create({ data: { name: 'Label usage team' } });
    const actorMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    expect(actorMembership.id).not.toBe(actor.id);
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-label-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Labeled provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const externalKey = await db.teamCredentialExternalApiKey.create({ data: {
      resourceId: resource.id, teamMembershipId: actorMembership.id, label: 'CI runner',
      displayPrefix: 'hapek_v1_abcd1234', secretDigest: 'digest',
    } });
    const observedAt = new Date();
    await db.usageEvent.createMany({ data: [
      {
        accountId: actor.id, observedAt, agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
        requestCount: 1, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
        credentialDeliveryMode: 'brokered', machineId: 'worker-a', brokerMachineId: 'broker-a',
        teamCredentialSourceCredentialId: 'pool-member-1',
      },
      {
        accountId: actor.id, observedAt, agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
        requestCount: 1, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id,
        credentialDeliveryMode: 'external_api', teamCredentialExternalApiKeyId: externalKey.id,
      },
    ] });
    const range = { startMs: observedAt.getTime() - 1_000, endMs: observedAt.getTime() + 1_000, granularity: 'day' as const, costMode: 'auto' as const };

    const memberView = await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range, breakdown: 'member' }, TEST_AUTHENTICATION);
    if ('ok' in memberView) throw new Error('expected member usage result');
    expect(memberView.breakdown).toEqual([
      expect.objectContaining({ key: actor.id, label: 'Ada Lovelace' }),
    ]);

    const keyView = await queryTeamCredentialUsage(manager.id, { resourceId: resource.id, ...range, breakdown: 'external_api_key' }, TEST_AUTHENTICATION);
    if ('ok' in keyView) throw new Error('expected manager usage result');
    expect(keyView.breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: externalKey.id, label: 'CI runner' }),
    ]));

    const managerSourceView = await queryTeamCredentialUsage(manager.id, { resourceId: resource.id, ...range, breakdown: 'source_member' }, TEST_AUTHENTICATION);
    if ('ok' in managerSourceView) throw new Error('expected manager usage result');
    expect(managerSourceView.breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'pool-member-1' }),
    ]));

    const memberSourceView = await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range, breakdown: 'source_member' }, TEST_AUTHENTICATION);
    if ('ok' in memberSourceView) throw new Error('expected member usage result');
    expect(memberSourceView.breakdown).toBeUndefined();

    const memberSessionView = await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range, breakdown: 'session' }, TEST_AUTHENTICATION);
    if ('ok' in memberSessionView) throw new Error('expected member usage result');
    expect(memberSessionView.breakdown).toEqual([
      expect.objectContaining({ key: 'unavailable_session', label: 'Unavailable session' }),
    ]);

    const memberWorkerView = await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range, breakdown: 'worker_machine' }, TEST_AUTHENTICATION);
    if ('ok' in memberWorkerView) throw new Error('expected member usage result');
    expect(memberWorkerView.breakdown).toEqual([
      expect.objectContaining({ key: 'unavailable_worker_machine', label: 'Unavailable machine' }),
    ]);

    const memberBrokerView = await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range, breakdown: 'broker_machine' }, TEST_AUTHENTICATION);
    if ('ok' in memberBrokerView) throw new Error('expected member usage result');
    expect(memberBrokerView.breakdown).toBeUndefined();
  });

  it('stops returning resource usage to a revoked member while managers keep the resource view', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Revoked usage team' } });
    const actorMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-revoked-resource', teamId: team.id, custodianAccountId: manager.id, displayName: 'Revoked provider',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const observedAt = new Date();
    await db.usageEvent.create({ data: {
      accountId: actor.id, observedAt, agentId: 'team_credential_broker', source: 'team_credential_admission', scope: 'turn_delta',
      requestCount: 1, teamCredentialResourceId: resource.id, teamCredentialActorAccountId: actor.id, credentialDeliveryMode: 'brokered',
    } });
    const range = { startMs: observedAt.getTime() - 1_000, endMs: observedAt.getTime() + 1_000, granularity: 'day' as const, costMode: 'auto' as const };
    const beforeRevocation = await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range }, TEST_AUTHENTICATION);
    expect('ok' in beforeRevocation).toBe(false);

    await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: team.id, actorAccountId: manager.id, membershipId: actorMembership.id }));

    expect(await queryTeamCredentialUsage(actor.id, { resourceId: resource.id, ...range }, TEST_AUTHENTICATION))
      .toEqual({ ok: false, error: 'not_found_or_not_visible' });
    const managerView = await queryTeamCredentialUsage(manager.id, { resourceId: resource.id, ...range }, TEST_AUTHENTICATION);
    expect('ok' in managerView).toBe(false);
  });
  it('retains monetary columns without blending kinds or pricing an incompletely priced population', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Mixed provenance team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: 'usage-mixed-provenance-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Mixed provenance provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const observedAt = new Date();
    const base = {
      accountId: manager.id,
      observedAt,
      agentId: 'codex',
      source: 'codex_app_server',
      scope: 'turn_delta',
      teamCredentialResourceId: resource.id,
      teamCredentialActorAccountId: manager.id,
      credentialDeliveryMode: 'brokered',
      machineId: 'mixed-provenance-worker',
    } as const;
    await db.usageEvent.createMany({ data: [
      { ...base, reportedCostUsd: 2, costSource: 'provider_reported' },
      { ...base, estimatedCostUsd: 3, costSource: 'pricing_estimate' },
    ] });
    const input = {
      resourceId: resource.id,
      startMs: observedAt.getTime() - 1,
      endMs: observedAt.getTime() + 1,
      granularity: 'day' as const,
      costMode: 'auto' as const,
      breakdown: 'worker_machine' as const,
    };

    const automatic = await queryTeamCredentialUsage(manager.id, input, TEST_AUTHENTICATION);
    if ('ok' in automatic) throw new Error('expected usage result');
    expect(automatic.totals.cost).toMatchObject({ reportedUsd: 2, estimatedUsd: 3, costSource: 'none' });
    expect(automatic.totals.cost.effectiveUsd).toBeUndefined();
    expect(automatic.series[0]?.totals.cost.effectiveUsd).toBeUndefined();
    expect(automatic.breakdown?.[0]?.totals.cost.effectiveUsd).toBeUndefined();

    const reportedOnly = await queryTeamCredentialUsage(manager.id, { ...input, costMode: 'reported' }, TEST_AUTHENTICATION);
    if ('ok' in reportedOnly) throw new Error('expected usage result');
    expect(reportedOnly.totals.cost.reportedUsd).toBe(2);
    expect(reportedOnly.totals.cost.effectiveUsd).toBeUndefined();
    const estimatedOnly = await queryTeamCredentialUsage(manager.id, { ...input, costMode: 'estimated' }, TEST_AUTHENTICATION);
    if ('ok' in estimatedOnly) throw new Error('expected usage result');
    expect(estimatedOnly.totals.cost.estimatedUsd).toBe(3);
    expect(estimatedOnly.totals.cost.effectiveUsd).toBeUndefined();

    const invoiceResource = await db.teamCredentialResource.create({ data: {
      id: 'usage-invoice-provenance-resource', teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Invoice provenance provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    await db.usageEvent.createMany({ data: [
      { ...base, teamCredentialResourceId: invoiceResource.id, invoiceCostUsd: 1, costSource: 'invoice' },
      { ...base, teamCredentialResourceId: invoiceResource.id, reportedCostUsd: 2, costSource: 'provider_reported' },
    ] });
    const invoiceView = await queryTeamCredentialUsage(manager.id, { ...input, resourceId: invoiceResource.id }, TEST_AUTHENTICATION);
    if ('ok' in invoiceView) throw new Error('expected usage result');
    expect(invoiceView.totals.cost).toMatchObject({ invoiceUsd: 1, reportedUsd: 2, costSource: 'none' });
    expect(invoiceView.totals.cost.effectiveUsd).toBeUndefined();
  });

  it.each([
    ['vendor-prefixed', 'anthropic/claude-sonnet-4-2025051'],
    ['maximum catalog width', 'm'.repeat(510)],
    ['multibyte catalog width', '模'.repeat(510)],
  ])('pages a breakdown with %s model keys without bounding the model identity', async (_label, modelPrefix) => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Wide cursor team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      id: randomUUID(), teamId: team.id, custodianAccountId: manager.id,
      displayName: 'Wide cursor provider', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered',
    } });
    const observedAt = new Date();
    await db.usageEvent.createMany({ data: Array.from({ length: 52 }, (_, index) => ({
      accountId: manager.id,
      observedAt,
      agentId: 'codex',
      source: 'codex_app_server',
      scope: 'turn_delta',
      totalTokens: 52 - index,
      inputTokens: 52 - index,
      teamCredentialResourceId: resource.id,
      teamCredentialActorAccountId: manager.id,
      credentialDeliveryMode: 'brokered',
      modelId: `${modelPrefix}${String(index).padStart(2, '0')}`,
    })) });
    const input = {
      resourceId: resource.id,
      startMs: observedAt.getTime() - 1,
      endMs: observedAt.getTime() + 1,
      granularity: 'day' as const,
      costMode: 'auto' as const,
      breakdown: 'model' as const,
    };

    const first = await queryTeamCredentialUsage(manager.id, input, TEST_AUTHENTICATION);
    if ('ok' in first) throw new Error('expected first usage page');
    expect(first.breakdown).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await queryTeamCredentialUsage(manager.id, { ...input, cursor: first.nextCursor ?? undefined }, TEST_AUTHENTICATION);
    if ('ok' in second) throw new Error('expected second usage page');
    expect(new Set(
      [...(first.breakdown ?? []), ...(second.breakdown ?? [])].map((entry) => entry.key),
    ).size).toBe(52);

    const foreignQuery = await queryTeamCredentialUsage(manager.id, {
      ...input, breakdown: 'worker_machine', cursor: first.nextCursor ?? undefined,
    }, TEST_AUTHENTICATION);
    expect(foreignQuery).toEqual({ ok: false, error: 'invalid_resource_input' });
  });
});
