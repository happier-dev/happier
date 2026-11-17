import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1, HomeAccountListResultV1Schema } from '@happier-dev/protocol/home/governance';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { homeGovernanceRoutes } from '@/app/api/routes/home/homeGovernanceRoutes';
import { registerHomeSettingsRoutes } from '@/app/api/routes/home/homeSettingsRoutes';
import { registerHomeReachabilityRoutes } from '@/app/api/routes/home/homeReachabilityRoutes';
import { createPerSendAuthEmailDelivery } from '@/app/auth/email/resolveAuthEmailDelivery';
import { auth } from '@/app/auth/auth';
import { resolveEffectiveHomeAuthMethodsInTx } from '@/app/auth/methods/effectiveHomeAuthMethods';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { readHomeGovernanceProjectionInTx } from './homeGovernanceService';
import { createDbMaintenanceClient, type PrismaClientType } from '@/storage/prisma';
import { recordDriverStatements, type DriverStatementEvent } from '@/testkit/driverStatements';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Home administration read SQL cost (PostgreSQL)', () => {
    const statements: DriverStatementEvent[] = [];
    let client: PrismaClientType | undefined;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { onDriverStatement: recordDriverStatements(event => statements.push(event)) });
        await client.$connect();
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home-cost.example.test');
        vi.stubEnv('HANDY_MASTER_SECRET', 'home-read-cost-disposable-contract');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        await auth.init();
    });

    afterAll(async () => {
        await client?.$disconnect();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    it('keeps page-open reads constant as the Home grows from one Account to 201', async () => {
        const owner = await db.account.create({ data: { homeRole: 'owner', encryptionMode: 'plain', name: 'Owner' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const headers = { authorization: `Bearer ${token}` };
        const originalTransaction = db.$transaction;
        const tracedClient = client!;
        // Observe the actual database transport. Route validation, Home policy,
        // authentication projections and governance decisions remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(tracedClient.$transaction, tracedClient, args);
        } });
        const accountIds = [owner.id];
        try {
            await withAuthenticatedTestApp(app => {
                homeGovernanceRoutes(app);
                registerHomeSettingsRoutes(app, {
                    authEmailDelivery: createPerSendAuthEmailDelivery({
                        readEnv: async () => ({}),
                        createSmtpTransport: () => ({ async send() {} }),
                    }),
                });
                registerHomeReachabilityRoutes(app);
            }, async app => {
                const reads = [
                    { url: homeDomainActionPathForMethod('home.governance.get', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.governance.eligibility.get', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.accounts.list', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.accounts.get', 'POST'), payload: { accountId: owner.id } },
                    { url: homeDomainActionPathForMethod('home.accounts.search', 'POST'), payload: { query: owner.id, scope: { kind: 'home' } } },
                    { url: homeDomainActionPathForMethod('home.settings.get', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.mailDelivery.get', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.reachability.get', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.audit.list', 'POST'), payload: {} },
                    { url: homeDomainActionPathForMethod('home.emptiness.get', 'POST'), payload: {} },
                ];
                const measurements: Array<Readonly<{ accounts: number; routes: readonly Readonly<{
                    url: string; statements: number; selects: number; transactions: number; budgetStatements: number;
                }>[] }>> = [];
                for (const accounts of [1, 201]) {
                    if (accounts > 1) {
                        const newcomers = Array.from({ length: accounts - 1 }, (_, index) => ({
                            id: crypto.randomUUID(), name: `Person ${index}`, encryptionMode: 'plain',
                        }));
                        accountIds.push(...newcomers.map(row => row.id));
                        await db.account.createMany({ data: newcomers });
                    }
                    // Keep the audit page nonempty at both scales, including
                    // its bounded set read of referenced Account profiles.
                    await db.homeAdministrationEvent.create({ data: {
                        actorKind: 'account', actorAccountId: owner.id, action: 'account.role.set',
                        targetKind: 'account', targetId: owner.id, summary: { from: 'member', to: 'admin' },
                    } });
                    const measured = [];
                    for (const read of reads) {
                        // Exclude first-use connection/module initialization;
                        // measure the same loaded route at both scales.
                        const warm = await app.inject({ method: 'POST', ...read, headers });
                        expect(warm.statusCode, `${read.url}: ${warm.body}`).toBe(200);
                        statements.length = 0;
                        const response = await app.inject({ method: 'POST', ...read, headers });
                        expect(response.statusCode, `${read.url}: ${response.body}`).toBe(200);
                        if (read.url === homeDomainActionPathForMethod('home.accounts.list', 'POST')) {
                            const body = HomeAccountListResultV1Schema.parse(response.json());
                            expect(body.total).toBe(accounts);
                            expect(body.items).toHaveLength(Math.min(accounts, HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1));
                            expect(body.nextCursor !== null).toBe(accounts > HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1);
                        }
                        measured.push({
                            url: read.url,
                            statements: statements.length,
                            selects: statements.filter(({ query }) => /^\s*SELECT\b/.test(query)).length,
                            transactions: statements.filter(({ query }) => /^BEGIN\b/.test(query)).length,
                            budgetStatements: statements.filter(({ query }) => /^SET LOCAL statement_timeout\b/.test(query)).length,
                        });
                    }
                    measurements.push({ accounts, routes: measured });
                }
                console.info('HOME_ADMINISTRATION_SQL_COST', JSON.stringify(measurements));
                // Physical query counts include real signed-bearer verification,
                // current lifecycle/epoch reads and each route's transaction
                // boundaries and request-scoped Home environment capture.
                // The transaction owner refreshes statement_timeout when the
                // remaining millisecond budget changes. Record those SETs,
                // but gate the SELECT and transaction work the request demands.
                const work = (measurement: (typeof measurements)[number]) => measurement.routes.map(({ url, selects, transactions }) => ({ url, selects, transactions }));
                expect(work(measurements[1]!)).toEqual(work(measurements[0]!));
                expect(measurements[0]!.routes.every(route => route.selects > 0)).toBe(true);
            }, { authentication: 'real' });
        } finally {
            db.$transaction = originalTransaction;
            await db.homeAdministrationEvent.deleteMany({ where: { actorAccountId: owner.id } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        }
    });

    it('retains the policy acquired by the effective-method owner for its catalog', async () => {
        const resolve = async (unreadable: boolean) => {
            statements.length = 0;
            const result = await client!.$transaction(tx => resolveEffectiveHomeAuthMethodsInTx(tx, {
                env: process.env,
                ...(unreadable ? { homeAuthenticationPolicyOverride: { status: 'unreadable' as const } } : {}),
            }), { isolationLevel: 'RepeatableRead' });
            const policies = statements.filter(({ query }) => /^\s*SELECT\b/.test(query)
                && /FROM "public"\."HomeGovernancePolicy"(?:\s|$)/.test(query)).length;
            return { result, policies };
        };
        const admitted = await resolve(false);
        expect(admitted.result.status).toBe('ready');
        console.info('HOME_EFFECTIVE_METHOD_POLICY_SQL_COST', { policies: admitted.policies });
        expect(admitted.policies).toBe(1);
        expect(await resolve(true)).toEqual({ result: { status: 'unavailable' }, policies: 0 });
    });

    it('reuses the same-transaction actor and policy while preserving current administrator refusals', async () => {
        const owner = await db.account.create({ data: { homeRole: 'owner', encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { homeRole: 'admin', encryptionMode: 'plain' } });
        const tracedClient = client!;
        const project = async (viewerAccountId: string) => {
            statements.length = 0;
            const result = await tracedClient.$transaction(tx => readHomeGovernanceProjectionInTx(tx, {
                viewerAccountId, teamsEnabled: true, emailDeliveryReady: false,
                env: { HAPPIER_PUBLIC_SERVER_URL: 'https://home-cost.example.test', HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
            }), { isolationLevel: 'RepeatableRead' });
            const reads = statements.filter(({ query }) => /^\s*SELECT\b/.test(query));
            return { result, accountRows: reads.filter(({ query }) => /FROM "public"\."Account"(?:\s|$)/.test(query) && !/COUNT\(/i.test(query)).length,
                policies: reads.filter(({ query }) => /FROM "public"\."HomeGovernancePolicy"(?:\s|$)/.test(query)).length,
                selects: reads.length };
        };
        try {
            const admitted = await project(actor.id);
            expect(admitted.result).toMatchObject({ status: 'ok', result: {
                viewer: { accountId: actor.id, homeRole: 'admin', status: 'active' },
                capabilities: { viewAdministration: true, manageAuthentication: false },
            } });
            console.info('HOME_GOVERNANCE_ADMISSION_SQL_COST', { accountRows: admitted.accountRows, policies: admitted.policies, selects: admitted.selects });
            expect(admitted.accountRows).toBe(1);
            // The projection, options, and both policy-composed catalog
            // decisions consume the same already-admitted policy row.
            expect(admitted.policies).toBe(1);
            await db.account.update({ where: { id: actor.id }, data: { status: 'suspended' } });
            expect((await project(actor.id)).result).toEqual({ status: 'rejected', code: 'home_governance_forbidden' });
            await db.account.update({ where: { id: actor.id }, data: { status: 'active', homeRole: 'member' } });
            expect((await project(actor.id)).result).toEqual({ status: 'rejected', code: 'home_governance_forbidden' });
            await db.account.delete({ where: { id: actor.id } });
            expect((await project(actor.id)).result).toEqual({ status: 'rejected', code: 'home_governance_forbidden' });
            expect((await project(crypto.randomUUID())).result).toEqual({ status: 'rejected', code: 'home_governance_forbidden' });
        } finally {
            await db.account.deleteMany({ where: { id: { in: [owner.id, actor.id] } } });
        }
    });
});
