import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ManagedIdentityProvidersListResultV1Schema } from '@happier-dev/protocol/identity/providers';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { registerHomeManagedIdentityProviderRoutes } from '@/app/api/routes/home/homeManagedIdentityProviderRoutes';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { encryptIdentityProviderSecrets } from './managed/identityProviderSecretCipher';
import { listTeamIdentityConnectionsForActor } from '@/app/teams/identity/teamIdentityConnectionAdministration';

const config = {
    v: 1, kind: 'oidc', issuer: 'https://identity-cost.example.test', clientId: 'happier',
    clientAuthenticationMethod: 'client_secret_post', scopes: 'openid profile email', httpTimeoutSeconds: 30,
    claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
    fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: 'oidc' },
} as const;

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Identity administration acquisition cost (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
        vi.stubEnv('HANDY_MASTER_SECRET', 'identity-cost-disposable-contract');
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home-cost.example.test');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1');
        await initEncrypt();
    });
    afterAll(async () => {
        await client?.$disconnect();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    it('loads current runtime and health once per provider with constant SELECTs at 1 and 101 providers', async () => {
        const actor = await db.account.create({ data: { homeRole: 'owner', encryptionMode: 'plain' } });
        const originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            await withAuthenticatedTestApp(app => registerHomeManagedIdentityProviderRoutes(app), async app => {
                const measurements = [];
                for (const providers of [1, 101]) {
                    const count = providers === 1 ? 1 : 100;
                    const rows = Array.from({ length: count }, () => {
                        const id = crypto.randomUUID();
                        return {
                            id, kind: 'oidc' as const, displayName: id, enabled: true, firstEnabledAt: new Date(), config,
                            encryptedSecrets: encryptIdentityProviderSecrets({
                                id, kind: 'oidc', secrets: { v: 1, kind: 'oidc', clientSecret: 'disposable-secret' },
                            }),
                        };
                    });
                    await db.identityProviderInstance.createMany({ data: rows });
                    const request = {
                        method: 'POST' as const, url: homeDomainActionPathForMethod('identity.providers.list', 'POST'),
                        headers: { 'x-test-user-id': actor.id }, payload: { owner: { kind: 'home' } },
                    };
                    expect((await app.inject(request)).statusCode).toBe(200);
                    statements.length = 0;
                    const response = await app.inject(request);
                    expect(response.statusCode, response.body).toBe(200);
                    const body = ManagedIdentityProvidersListResultV1Schema.parse(response.json());
                    expect(body.items).toHaveLength(providers);
                    expect(body.items.every(item => item.kind === 'oidc' && item.secret.health === 'configured')).toBe(true);
                    expect(body.items.every(item => item.callbackUrl === `https://home-cost.example.test/v1/oauth/${item.id}/callback`)).toBe(true);
                    measurements.push({
                        providers,
                        selects: statements.filter(({ query }) => /^SELECT\b/.test(query)).length,
                        secretReads: statements.filter(({ query }) => /^SELECT\b/.test(query)
                            && query.includes('"IdentityProviderInstance"') && query.includes('"encryptedSecrets"')).length,
                        transactions: statements.filter(({ query }) => /^BEGIN\b/.test(query)).length,
                    });
                }
                const nonAdmin = await db.account.create({ data: { encryptionMode: 'plain' } });
                expect((await app.inject({
                    method: 'POST', url: homeDomainActionPathForMethod('identity.providers.list', 'POST'),
                    headers: { 'x-test-user-id': nonAdmin.id }, payload: { owner: { kind: 'home' } },
                })).statusCode).toBe(403);
                console.info('IDENTITY_ADMINISTRATION_SQL_COST', JSON.stringify(measurements));
                expect(measurements.map(row => row.secretReads)).toEqual([1, 1]);
                expect(measurements[1]!.selects).toBe(measurements[0]!.selects);
                expect(measurements.map(row => row.transactions)).toEqual([1, 1]);
            });
        } finally { db.$transaction = originalTransaction; }
    });

    it('shares current runtime with restricted Team connection projection and JIT admission without hiding an unreadable binding', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'e2ee', publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: 'Connection acquisition cost' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        const teamProviderPolicy = {
            v: 1, allowedTeamProviderKinds: ['oidc'], teamJitAllowed: true, approvedGitHubEnterpriseOrigins: [],
        };
        await db.homeGovernancePolicy.upsert({ where: { id: 'home' },
            create: { id: 'home', teamProviderPolicy }, update: { teamProviderPolicy } });
        const originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            const measurements = [];
            let repairProviderId = '';
            const list = () => listTeamIdentityConnectionsForActor({
                teamId: team.id, actorAccountId: actor.id, env: process.env, authenticationAuthority: 'present_user',
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            });
            for (const connections of [1, 101]) {
                const rows = Array.from({ length: connections === 1 ? 1 : 100 }, () => {
                    const id = crypto.randomUUID();
                    return { id, ownerTeamId: team.id, kind: 'oidc' as const, displayName: id, enabled: true,
                        firstEnabledAt: new Date(), config, encryptedSecrets: encryptIdentityProviderSecrets({
                            id, kind: 'oidc', secrets: { v: 1, kind: 'oidc', clientSecret: 'disposable-secret' },
                        }) };
                });
                repairProviderId ||= rows[0]!.id;
                await db.identityProviderInstance.createMany({ data: rows });
                await db.teamIdentityConnection.createMany({ data: rows.map(provider => ({
                    teamId: team.id, providerInstanceId: provider.id, enabled: true,
                    externalReference: { v: 1, kind: 'oidc' },
                    settings: { v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
                })) });
                const accepted = await db.teamIdentityConnection.findMany({ where: { teamId: team.id }, select: { id: true } });
                await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                    v: 1, mode: 'restricted', accepted: [
                        { kind: 'home_method', methodId: 'key_challenge' },
                        ...accepted.map(connection => ({ kind: 'team_connection', connectionId: connection.id })),
                    ],
                } } });
                await list();
                statements.length = 0;
                const result = await list();
                expect(result).toMatchObject({ ok: true });
                if (!result.ok) throw new Error(result.error);
                expect(result.value.items).toHaveLength(connections);
                expect(result.value.admissionModeApplicability.modes.jit).toEqual({ status: 'available' });
                measurements.push({ connections,
                    selects: statements.filter(({ query }) => /^SELECT\b/.test(query)).length,
                    secretReads: statements.filter(({ query }) => /^SELECT\b/.test(query)
                        && query.includes('"IdentityProviderInstance"') && query.includes('"encryptedSecrets"')).length,
                    transactions: statements.filter(({ query }) => /^BEGIN\b/.test(query)).length,
                });
            }
            await db.identityProviderInstance.update({ where: { id: repairProviderId }, data: { encryptedSecrets: new Uint8Array([1, 2, 3]) } });
            statements.length = 0;
            const repaired = await list();
            expect(repaired.ok).toBe(true);
            if (!repaired.ok) throw new Error(repaired.error);
            expect(repaired.value.items).toHaveLength(101);
            expect(repaired.value.items.find(item => item.provider.id === repairProviderId)?.state).toBe('unavailable');
            expect(repaired.value.eligibleProviders.some(provider => provider.providerId === repairProviderId)).toBe(false);
            expect(statements.filter(({ query }) => /^SELECT\b/.test(query)
                && query.includes('"IdentityProviderInstance"') && query.includes('"encryptedSecrets"'))).toHaveLength(1);
            console.info('IDENTITY_CONNECTION_SQL_COST', JSON.stringify(measurements));
            expect(measurements.map(row => row.secretReads)).toEqual([1, 1]);
            expect(measurements[1]!.selects).toBe(measurements[0]!.selects);
            expect(measurements[1]!.transactions).toBe(measurements[0]!.transactions);
        } finally { db.$transaction = originalTransaction; }
    });
});
