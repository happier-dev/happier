import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { countScopedTeamSessionsInTx } from '@/app/session/listing/service';
import { countSavedSecretResourcesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { countDiscussionsInTx } from '@/app/discussions/queries';
import { readTeamSharedResourcesSummaryInTx } from '@/app/teams/sharedResources';
import { countScopedTeamMachinesInTx } from './machineAccess';
import { countScopedTeamMachinePoolsInTx } from './pools/machinePoolService';
import { countScopedTeamMachinePresetsInTx } from './managed/machinePresetService';

interface QueryPlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Actual Rows': number;
    'Actual Loops': number;
    'Rows Removed by Filter'?: number;
    Plans?: QueryPlanNode[];
}

function scannedResourceRows(plan: QueryPlanNode): Readonly<Record<string, number>> {
    const rows: Record<string, number> = {};
    const visit = (node: QueryPlanNode) => {
        const relation = node['Relation Name'];
        if (relation === 'Session' || relation === 'Machine') rows[relation] = (rows[relation] ?? 0)
            + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'];
        node.Plans?.forEach(visit);
    };
    visit(plan);
    return rows;
}

/** Explain the actual Prisma query and bound values on the same disposable database. */
function explainSql(event: Prisma.QueryEvent): string {
    let sql = event.query;
    const params = JSON.parse(event.params) as unknown[];
    for (let index = params.length; index > 0; index--) {
        const value = params[index - 1];
        const literal = value === null ? 'NULL' : typeof value === 'number' || typeof value === 'boolean'
            ? String(value) : `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
        sql = sql.replaceAll(`$${index}`, literal);
    }
    return `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`;
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team resource aggregate query cost (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); await shutdownDbClient(); });

    it('counts each selected resource relation without opening content as unrelated inventory grows', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain', publicKey: randomUUID() } });
        const team = await db.team.create({ data: { name: 'Selected query-cost Team' } });
        await db.teamMembership.createMany({ data: [owner, viewer].map(account => ({
            teamId: team.id, accountId: account.id, role: 'member',
        })) });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.machineGrant.create({ data: { machineId: machine.id, principalKind: 'team', teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machinePool.create({ data: { id: randomUUID(), accountId: owner.id, teamId: team.id,
            name: storedPlainPrivateLabel('Selected pool') } });
        await db.managedMachinePreset.create({ data: { homeId: await getOrCreateServerIdentityId(), teamId: team.id, name: 'Selected preset' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        await db.sessionGrant.create({ data: { sessionId: session.id, principalKind: 'team', teamId: team.id,
            createdByAccountId: owner.id, effectiveAt: new Date(), accessLevel: 'view' } });
        const secret = await db.savedSecretResource.create({ data: { ownerAccountId: owner.id,
            displayName: 'Private secret label', kind: 'string', encryptionMode: 'plain', storedContent: '{}' } });
        await db.savedSecretTeamGrant.create({ data: { resourceId: secret.id, teamId: team.id, createdByAccountId: owner.id } });
        const discussion = await db.discussion.create({ data: { ownerAccountId: owner.id, encryptionMode: 'plain',
            dataEncryptionKey: new Uint8Array(32), creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
            titleContent: { t: 'plain', v: 'Private discussion title' }, lastMessageAt: new Date() } });
        await db.discussionGrant.create({ data: { discussionId: discussion.id, principalKind: 'team', teamId: team.id,
            createdByAccountId: owner.id, accessLevel: 'view' } });

        const original = db.$transaction;
        db.$transaction = new Proxy(original, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            statements.length = 0;
            const summary = await inTx(tx => readTeamSharedResourcesSummaryInTx(tx, {
                actorAccountId: viewer.id, teamId: team.id,
                authentication: { authenticationAuthority: 'present_user', authenticationEvidence: [] },
                sessionAuthentication: createPresentUserSessionAccessAuthentication({ authenticationEvidence: [] }),
            }));
            expect(summary.ok).toBe(true);
            const summaryReads = statements.filter(event => /^SELECT\b/i.test(event.query));
            const primaryTable = (event: Prisma.QueryEvent) => /\bFROM "(?:public"\.")?([^".]+)"/u.exec(event.query)?.[1];
            const teamReads = summaryReads.filter(event => primaryTable(event) === 'Team');
            const membershipReads = summaryReads.filter(event => primaryTable(event) === 'TeamMembership');
            console.info('TEAM_SUMMARY_AUTHORITY_SQL', JSON.stringify({ teamReads: teamReads.length,
                membershipReads: membershipReads.length, ownerCounts: membershipReads.filter(event => /COUNT\(/u.test(event.query)).length,
                totalReads: summaryReads.length }));
            expect(teamReads).toHaveLength(1);
            expect(membershipReads.filter(event => /COUNT\(/u.test(event.query))).toHaveLength(1);
            if (summary.ok) for (const kind of ['sessions', 'machines', 'machinePools', 'machinePresets', 'discussions', 'savedSecrets']) {
                expect(summary.summary.kinds.find(row => row.kind === kind)).toMatchObject({ status: 'available', count: 1 });
            }
            const measure = async () => {
                statements.length = 0;
                const scope = { actorAccountId: viewer.id, sharedWithTeamId: team.id };
                const authentication = { authenticationAuthority: 'present_user' as const, authenticationEvidence: [] };
                const results = await inTx(async tx => ({
                    machines: await countScopedTeamMachinesInTx(tx, scope),
                    pools: await countScopedTeamMachinePoolsInTx(tx, { ...scope, authentication }),
                    presets: await countScopedTeamMachinePresetsInTx(tx, { ...scope, authentication }),
                    sessions: await countScopedTeamSessionsInTx(tx, { ...scope,
                        authentication: createPresentUserSessionAccessAuthentication({ authenticationEvidence: [] }) }),
                    secrets: await countSavedSecretResourcesInTx(tx, { ...scope, authentication }),
                    discussions: await countDiscussionsInTx(tx, { ...scope,
                        authentication: createPresentUserSessionAccessAuthentication({ authenticationEvidence: [] }) }),
                }));
                for (const result of Object.values(results)) expect(result).toEqual({ ok: true, count: 1 });
                const reads = statements.filter(event => /^SELECT\b/i.test(event.query));
                // Team admission may read its public description; resource counts must not hydrate opaque bodies.
                const resourceReads = reads.filter(event => /\bFROM "(?:public"\.")?(?:Machine|Session|MachinePool|ManagedMachinePreset|SavedSecretResource|Discussion)"/u.test(event.query));
                expect(resourceReads.filter(event => /\.(?:"metadata"|"daemonState"|"launch"|"setup"|"description"|"storedContent"|"titleContent")/u.test(event.query))).toEqual([]);
                expect(resourceReads.filter(event => /COUNT\(/u.test(event.query))).toHaveLength(5);
                return reads.map(event => event.query);
            };
            const small = await measure();
            await db.machine.createMany({ data: Array.from({ length: 100 }, () => ({
                id: randomUUID(), accountId: viewer.id, metadata: '{}',
            })) });
            await db.session.createMany({ data: Array.from({ length: 1_000 }, () => ({
                accountId: viewer.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            })) });
            const large = await measure();
            expect(large).toEqual(small);
            const counts = statements.filter(event => /COUNT\(/u.test(event.query));
            const plans = [];
            for (const count of counts) {
                const result = await client.$queryRawUnsafe<readonly Readonly<{ 'QUERY PLAN': readonly Readonly<{ Plan: QueryPlanNode }>[] }>[]>(explainSql(count));
                plans.push(scannedResourceRows(result[0]!['QUERY PLAN'][0]!.Plan));
            }
            // The selected Session id set must keep the count off the unrelated corpus.
            expect(plans.reduce((total, plan) => total + (plan.Session ?? 0), 0)).toBeLessThan(1_000);
            console.info('TEAM_RESOURCE_COUNT_SQL', JSON.stringify({ queries: large.length,
                countQueries: large.filter(query => /COUNT\(/u.test(query)).length,
                unrelatedSessions: 1_000, unrelatedMachines: 100, plans }));

            // Reusing structural Team facts must not qualify a credential for any native reader.
            // Key Challenge is a keyed Account method; the earlier aggregate checks use plain Accounts.
            await db.account.update({ where: { id: viewer.id }, data: { encryptionMode: 'e2ee' } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
            } } });
            const readRestricted = (qualified: boolean) => inTx(tx => readTeamSharedResourcesSummaryInTx(tx, {
                actorAccountId: viewer.id, teamId: team.id,
                authentication: { env: { ...process.env, HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
                    authenticationAuthority: 'present_user', authenticationEvidence: qualified
                    ? [{ kind: 'home_method', methodId: 'key_challenge' }] : [] },
                sessionAuthentication: createPresentUserSessionAccessAuthentication({
                    env: { ...process.env, HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' }, authenticationEvidence: qualified
                    ? [{ kind: 'home_method', methodId: 'key_challenge' }] : [] }),
            }));
            const qualified = await readRestricted(true);
            expect(qualified.ok).toBe(true);
            if (qualified.ok) for (const kind of ['sessions', 'machinePools', 'machinePresets', 'discussions', 'savedSecrets']) {
                expect(qualified.summary.kinds.find(row => row.kind === kind), kind).toMatchObject({ status: 'available', count: 1 });
            }
            if (qualified.ok) expect(qualified.summary.kinds.find(row => row.kind === 'credentials'))
                .toMatchObject({ status: 'available', count: 0 });
            const unqualified = await readRestricted(false);
            expect(unqualified.ok).toBe(true);
            if (unqualified.ok) {
                for (const kind of ['sessions', 'machinePools', 'machinePresets']) {
                    expect(unqualified.summary.kinds.find(row => row.kind === kind)).toMatchObject({ status: 'available', count: 0 });
                }
                for (const kind of ['discussions', 'savedSecrets', 'projectSources', 'credentials']) {
                    expect(unqualified.summary.kinds.find(row => row.kind === kind)).toMatchObject({ status: 'unavailable', count: null });
                }
            }
        } finally {
            db.$transaction = original;
        }
    });
});
