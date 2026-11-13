import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { queryTeamCredentialUsage } from './resourceUsage';
import { removeTeamMemberForActorInTx } from '../memberships/memberAdministration';
import { recordTeamCredentialDirectDeliveryActivityInTx } from './resourceActivity';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { TeamCredentialUsageQueryInputV1Schema, TeamCredentialUsageQueryResultV1Schema } from '@happier-dev/protocol/teams';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { resolveEffectiveUsageCostUsd } from '@happier-dev/protocol/usage/usageCostFacts';

const TEST_AUTHENTICATION = {
  env: process.env,
  authenticationAuthority: 'present_user',
  authenticationEvidence: [],
} as const;

describe('Team credential resource usage query', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'team-resource-usage-' }); }, 120_000);
  afterAll(async () => { await harness?.close(); });

  it.each(['auto', 'reported', 'estimated', 'api_equivalent'] as const)(
    'publishes an empty recorded population as zero in %s mode without inventing observation coverage', async costMode => {
      const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
      const team = await db.team.create({ data: { name: randomUUID() } });
      await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
      const resource = await db.teamCredentialResource.create({ data: {
        teamId: team.id, custodianAccountId: manager.id, displayName: 'Empty usage',
        disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
        allMembersDeliveryMode: 'brokered',
      } });
      const result = await queryTeamCredentialUsage(manager.id, {
        resourceId: resource.id, startMs: 0, endMs: Date.now(), granularity: 'day', costMode, breakdown: 'model',
      }, TEST_AUTHENTICATION);
      if ('ok' in result) throw new Error(`Usage refused: ${result.error}`);
      const transported = TeamCredentialUsageQueryResultV1Schema.parse(JSON.parse(JSON.stringify(result)));
      expect(transported.totals).toMatchObject({ eventCount: 0, requestCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0, costSource: 'none' } });
      expect(resolveEffectiveUsageCostUsd(transported.totals.cost, costMode)).toBe(0);
      expect(transported.series).toEqual([]);
      expect(transported.breakdown).toEqual([]);
      expect(transported.coverage).toMatchObject({ requestAdmissionCount: 0, agentObservationCount: 0,
        externalTerminalObservationCount: 0, directRecordedUseOnly: false, requestCountCoverage: 'complete',
        tokenCoverage: 'unavailable', costCoverage: 'unavailable' });
    },
  );

  it('preserves nonempty missing measurements and known zero while summing recorded requests', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: randomUUID() } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      teamId: team.id, custodianAccountId: manager.id, displayName: 'Nullable usage',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
      allMembersDeliveryMode: 'brokered',
    } });
    const at = Date.now();
    const base = { accountId: manager.id, agentId: 'codex', source: 'codex_app_server', scope: 'turn_delta',
      teamCredentialResourceId: resource.id, teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered' };
    await db.usageEvent.create({ data: { ...base, observedAt: new Date(at), requestCount: 2 } });
    const query = { resourceId: resource.id, startMs: at, endMs: at, granularity: 'day', costMode: 'auto' } as const;
    const unknown = await queryTeamCredentialUsage(manager.id, query, TEST_AUTHENTICATION);
    if ('ok' in unknown) throw new Error(`Usage refused: ${unknown.error}`);
    expect(unknown.totals).toMatchObject({ eventCount: 1, requestCount: 2,
      tokens: { total: null, input: null, output: null }, cost: { reportedUsd: null, estimatedUsd: null } });
    expect(resolveEffectiveUsageCostUsd(unknown.totals.cost, 'auto')).toBeNull();
    await db.usageEvent.create({ data: { ...base, observedAt: new Date(at + 1), requestCount: 3,
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
      reportedCostUsd: 0, estimatedCostUsd: 0, invoiceCostUsd: 0, costSource: 'provider_reported' } });
    const known = await queryTeamCredentialUsage(manager.id, { ...query, startMs: at + 1, endMs: at + 1 }, TEST_AUTHENTICATION);
    if ('ok' in known) throw new Error(`Usage refused: ${known.error}`);
    expect(known.totals).toMatchObject({ eventCount: 1, requestCount: 3, tokens: { total: 0 }, cost: { reportedUsd: 0 } });
    const mixed = await queryTeamCredentialUsage(manager.id, { ...query, endMs: at + 1 }, TEST_AUTHENTICATION);
    if ('ok' in mixed) throw new Error(`Usage refused: ${mixed.error}`);
    expect(mixed.totals).toMatchObject({ eventCount: 2, requestCount: 5, tokens: { total: 0 }, cost: { reportedUsd: 0 } });
  });

  it('keeps incomplete finite publications unavailable to recipients while preserving owner and complete-share attribution', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: randomUUID() } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      teamId: team.id, custodianAccountId: manager.id, displayName: 'Finite publications',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
      allMembersDeliveryMode: 'brokered',
    } });
    const observedAt = new Date();
    const sessions = [];
    for (const [accountId, publicationId] of [[owner.id, '   '], [owner.id, 'complete-publication'], [manager.id, '   ']] as const) {
      const session = await db.session.create({ data: {
        accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        currentStorageState: 'snapshot_complete', seq: 1, materializationPublicationId: publicationId,
        materializedThroughSourceAt: BigInt(observedAt.getTime()), publishedThroughServerSeq: 1,
      } });
      sessions.push(session);
      if (accountId !== manager.id) await db.sessionGrant.create({ data: { principalKind: 'account',
        sessionId: session.id, createdByAccountId: owner.id, accountId: manager.id, accessLevel: 'view',
      } });
      await db.usageEvent.create({ data: {
        accountId: manager.id, sessionId: session.id, observedAt, agentId: 'codex', source: 'codex_app_server',
        scope: 'turn_delta', totalTokens: 1, teamCredentialResourceId: resource.id,
        teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered',
      } });
    }
    const result = await queryTeamCredentialUsage(manager.id, {
      resourceId: resource.id, startMs: observedAt.getTime(), endMs: observedAt.getTime(),
      granularity: 'day', costMode: 'auto', breakdown: 'session',
    }, TEST_AUTHENTICATION);
    if ('ok' in result) throw new Error(`Usage refused: ${result.error}`);
    expect(result.totals.tokens.total).toBe(3);
    expect(result.breakdown?.map(row => row.key).sort()).toEqual(['unavailable_session', sessions[1]!.id, sessions[2]!.id].sort());
  });

  it('uses the same real Home resource authority for export, including restricted-Team and outsider refusal', async () => {
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Export authority', authenticationPolicy: {
      v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
    } } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: { teamId: team.id,
      custodianAccountId: custodian.id, displayName: 'Shared model', disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered' } });
    const query = { resourceId: resource.id, startMs: 0, endMs: Date.now(), granularity: 'day', costMode: 'auto' } as const;
    const executorFor = (actorId: string) => createActionExecutor({ homeDomainAction: async ({ input }) => {
      // This adapts the genuine Home query/HTTP result boundary; authorization and database reads stay real.
      const value = await queryTeamCredentialUsage(actorId, TeamCredentialUsageQueryInputV1Schema.parse(input), TEST_AUTHENTICATION);
      return 'ok' in value ? { ok: false, errorCode: value.error, error: value.error } : value;
    } } as ActionExecutorDeps);
    const request = { query, resourceName: 'Shared model' };
    expect(await executorFor(custodian.id).execute('teams.credentials.usage.export', request, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'team_authentication_required' });
    await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: null } });
    const exported = await executorFor(custodian.id).execute('teams.credentials.usage.export', request, { surface: 'cli' });
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(UsageFileResultSchema.parse(exported.result).mediaType).toBe('text/csv');
    expect(await executorFor(outsider.id).execute('teams.credentials.usage.export', request, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'not_found_or_not_visible' });
  });

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
      tokens: { total: null },
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
    const actor = await db.account.create({ data: { encryptionMode: 'plain', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', username: 'ada' } });
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
  it('sums known monetary contributions while strict modes retain their known subtotals', async () => {
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
    expect(automatic.totals.cost.effectiveUsd).toBe(5);
    expect(automatic.series[0]?.totals.cost.effectiveUsd).toBe(5);
    expect(automatic.breakdown?.[0]?.totals.cost.effectiveUsd).toBe(5);

    const reportedOnly = await queryTeamCredentialUsage(manager.id, { ...input, costMode: 'reported' }, TEST_AUTHENTICATION);
    if ('ok' in reportedOnly) throw new Error('expected usage result');
    expect(reportedOnly.totals.cost.reportedUsd).toBe(2);
    expect(reportedOnly.totals.cost.effectiveUsd).toBe(2);
    const estimatedOnly = await queryTeamCredentialUsage(manager.id, { ...input, costMode: 'estimated' }, TEST_AUTHENTICATION);
    if ('ok' in estimatedOnly) throw new Error('expected usage result');
    expect(estimatedOnly.totals.cost.estimatedUsd).toBe(3);
    expect(estimatedOnly.totals.cost.effectiveUsd).toBe(3);

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
    expect(invoiceView.totals.cost.effectiveUsd).toBe(3);
  });

  it('resolves reported-total overlap only inside the selected contribution population', async () => {
    const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: randomUUID() } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
    const resource = await db.teamCredentialResource.create({ data: {
      teamId: team.id, custodianAccountId: manager.id, displayName: 'Scoped reported total',
      disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
      allMembersDeliveryMode: 'brokered',
    } });
    const session = await db.session.create({ data: {
      accountId: manager.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
    } });
    const at = Date.now();
    const base = { accountId: manager.id, sessionId: session.id, agentId: 'codex', source: 'codex_app_server',
      teamCredentialResourceId: resource.id, teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered' };
    await db.usageEvent.create({ data: { ...base, observedAt: new Date(at), scope: 'turn_delta',
      inputTokens: 10, totalTokens: 10, estimatedCostUsd: 3, costSource: 'pricing_estimate', machineId: 'estimated-worker' } });
    await db.usageEvent.create({ data: { ...base, observedAt: new Date(at + 1), scope: 'session_snapshot', isCumulative: true,
      inputTokens: 15, totalTokens: 15, reportedCostUsd: 2, costSource: 'provider_reported', machineId: 'report-worker' } });
    const input = { resourceId: resource.id, startMs: at, endMs: at + 1,
      granularity: 'day', costMode: 'auto', breakdown: 'worker_machine' } as const;
    const whole = await queryTeamCredentialUsage(manager.id, input, TEST_AUTHENTICATION);
    if ('ok' in whole) throw new Error(`Usage refused: ${whole.error}`);
    expect(whole.totals).toMatchObject({ eventCount: 2, tokens: { total: 15 }, cost: { reportedUsd: 2, estimatedUsd: 3 } });
    expect(resolveEffectiveUsageCostUsd(whole.totals.cost, 'auto')).toBe(2);
    expect(resolveEffectiveUsageCostUsd(whole.series[0]!.totals.cost, 'auto')).toBe(2);
    // A covered fallback is not a separately selected charge in a partial breakdown.
    expect(resolveEffectiveUsageCostUsd(whole.breakdown!.find(row => row.key === 'estimated-worker')!.totals.cost, 'auto')).toBeNull();
    expect(resolveEffectiveUsageCostUsd(whole.breakdown!.find(row => row.key === 'report-worker')!.totals.cost, 'auto')).toBeNull();
    const reportOnly = await queryTeamCredentialUsage(manager.id, { ...input, startMs: at + 1 }, TEST_AUTHENTICATION);
    if ('ok' in reportOnly) throw new Error(`Usage refused: ${reportOnly.error}`);
    expect(resolveEffectiveUsageCostUsd(reportOnly.totals.cost, 'auto')).toBeNull();
    const estimateOnly = await queryTeamCredentialUsage(manager.id, { ...input, endMs: at }, TEST_AUTHENTICATION);
    if ('ok' in estimateOnly) throw new Error(`Usage refused: ${estimateOnly.error}`);
    expect(resolveEffectiveUsageCostUsd(estimateOnly.totals.cost, 'auto')).toBe(3);
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
