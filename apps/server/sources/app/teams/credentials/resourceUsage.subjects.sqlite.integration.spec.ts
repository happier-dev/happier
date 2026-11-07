import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { TeamCredentialUsageQueryResultV1Schema } from '@happier-dev/protocol/teams';
import { registerTeamCredentialResourceRoutes } from './registerTeamCredentialResourceRoutes';

describe('Team and Home subjects through the credential usage HTTP query', () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-subjects-', initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        app = createAuthenticatedTestApp();
        registerTeamCredentialResourceRoutes(app);
        await app.ready();
    }, 180_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });

    async function fixture() {
        const admin = await db.account.create({ data: { encryptionMode: 'plain', homeRole: 'admin' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const teams = await Promise.all([0, 1].map(() => db.team.create({ data: { name: randomUUID() } })));
        await db.teamMembership.createMany({ data: teams.flatMap(team => [
            { teamId: team.id, accountId: member.id, role: 'admin' },
            { teamId: team.id, accountId: admin.id, role: 'member' },
        ]) });
        const resources = [];
        const startMs = Date.now();
        for (const [index, team] of [teams[0]!, teams[0]!, teams[1]!].entries()) {
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: member.id, displayName: randomUUID(),
                disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
                allMembersDeliveryMode: 'brokered',
            } });
            resources.push(resource);
            await db.usageEvent.create({ data: { accountId: member.id, agentId: 'codex',
                observedAt: new Date(startMs), source: 'codex_app_server', scope: 'turn_delta',
                totalTokens: index + 1, teamCredentialResourceId: resource.id,
                teamCredentialActorAccountId: member.id, credentialDeliveryMode: 'brokered' } });
        }
        // Personal usage must never enter Team-credential aggregates.
        await db.usageEvent.create({ data: { accountId: member.id, agentId: 'codex', observedAt: new Date(startMs),
            source: 'codex_app_server', scope: 'turn_delta', totalTokens: 100 } });
        return { admin, member, outsider, teams, resources, startMs, endMs: startMs };
    }

    async function query(accountId: string, payload: object) {
        return await app.inject({ method: 'POST', url: '/v1/teams/credential-resources/usage/query',
            headers: { 'x-test-user-id': accountId }, payload });
    }

    it('aggregates exactly the selected Team while preserving the existing resource query', async () => {
        const f = await fixture();
        const range = { startMs: f.startMs, endMs: f.endMs };
        const response = await query(f.member.id, { subject: { kind: 'team', teamId: f.teams[0]!.id }, ...range });
        expect(response.statusCode).toBe(200);
        const result = TeamCredentialUsageQueryResultV1Schema.parse(response.json());
        expect(result.totals.tokens.total).toBe(3);
        expect(result.limits).toEqual([]);
        const resource = await query(f.member.id, { resourceId: f.resources[0]!.id, ...range });
        expect(resource.statusCode).toBe(200);
        expect(TeamCredentialUsageQueryResultV1Schema.parse(resource.json()).totals.tokens.total).toBe(1);
        expect((await query(f.outsider.id, { subject: { kind: 'team', teamId: f.teams[0]!.id }, ...range })).statusCode).toBe(404);
        // Home administration does not confer the Team's credential-management capability.
        expect((await query(f.admin.id, { subject: { kind: 'team', teamId: f.teams[0]!.id }, ...range })).statusCode).toBe(404);
    });

    it('admits Home administrators, forbids visible Home members, and hides Home usage from inactive or absent Accounts', async () => {
        const f = await fixture();
        const payload = { subject: { kind: 'home' }, startMs: f.startMs, endMs: f.endMs };
        const response = await query(f.admin.id, payload);
        expect(response.statusCode).toBe(200);
        // Include every Home credential row at this instant, even if fixtures share a timestamp.
        const total = await db.usageEvent.aggregate({ where: { teamCredentialResourceId: { not: null },
            observedAt: new Date(f.startMs) }, _sum: { totalTokens: true } });
        expect(TeamCredentialUsageQueryResultV1Schema.parse(response.json()).totals.tokens.total).toBe(total._sum.totalTokens);
        const denied = await query(f.member.id, payload);
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toEqual({ error: 'forbidden' });
        await db.account.update({ where: { id: f.admin.id }, data: { status: 'suspended' } });
        for (const accountId of [f.admin.id, randomUUID()]) {
            const hidden = await query(accountId, payload);
            expect(hidden.statusCode).toBe(404);
            expect(hidden.json()).toEqual({ error: 'not_found_or_not_visible' });
        }
    });

    it('qualifies a restricted Team once before disclosing its aggregate', async () => {
        const f = await fixture();
        await db.team.update({ where: { id: f.teams[0]!.id }, data: { authenticationPolicy: {
            v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        const result = await query(f.member.id, { subject: { kind: 'team', teamId: f.teams[0]!.id },
            startMs: f.startMs, endMs: f.endMs });
        expect(result.statusCode).toBe(403);
        expect(result.json()).toMatchObject({ error: 'team_authentication_required' });
    });

    it('retains the Team attribution of recorded use after a credential is deleted', async () => {
        const f = await fixture();
        const resource = f.resources[0]!;
        await db.teamCredentialActivityEvent.create({ data: { subjectKind: 'team_credential',
            teamId: resource.teamId, resourceId: resource.id, kind: 'resource_deleted',
            actorAccountId: f.member.id, subjectDisplayName: resource.displayName } });
        await db.teamCredentialResource.delete({ where: { id: resource.id } });
        const response = await query(f.member.id, { subject: { kind: 'team', teamId: resource.teamId },
            startMs: f.startMs, endMs: f.endMs });
        expect(response.statusCode).toBe(200);
        expect(TeamCredentialUsageQueryResultV1Schema.parse(response.json()).totals.tokens.total).toBe(3);
    });

    it('rejects ambiguous subjects instead of widening a resource query', async () => {
        const f = await fixture();
        expect((await query(f.admin.id, { resourceId: f.resources[0]!.id, subject: { kind: 'home' },
            startMs: f.startMs, endMs: f.endMs })).statusCode).toBe(400);
    });

    it('binds a breakdown cursor to its aggregate subject', async () => {
        const f = await fixture();
        await db.usageEvent.createMany({ data: Array.from({ length: 51 }, (_, index) => ({
            accountId: f.member.id, agentId: 'codex', modelId: `subject-model-${index}`,
            observedAt: new Date(f.startMs), source: 'codex_app_server', scope: 'turn_delta',
            totalTokens: 1, teamCredentialResourceId: f.resources[0]!.id,
            teamCredentialActorAccountId: f.member.id, credentialDeliveryMode: 'brokered',
        })) });
        const range = { startMs: f.startMs, endMs: f.endMs, breakdown: 'model' };
        const first = await query(f.member.id, { subject: { kind: 'team', teamId: f.teams[0]!.id }, ...range });
        expect(first.statusCode).toBe(200);
        const { nextCursor } = TeamCredentialUsageQueryResultV1Schema.parse(first.json());
        expect(nextCursor).not.toBeNull();
        const replay = await query(f.admin.id, { subject: { kind: 'home' }, cursor: nextCursor, ...range });
        expect(replay.statusCode).toBe(400);
        expect(replay.json()).toMatchObject({ error: 'invalid_resource_input' });
    });
});
