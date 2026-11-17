import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';

import { qualifyTeamAuthenticationInTx } from './qualifyTeamAuthentication';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team qualification acquisition cost (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClientType;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(client, event => statements.push(event));
        await client.$connect();
    });

    afterAll(async () => {
        await client?.$disconnect();
        await shutdownDbClient();
    });

    it('reads one Home provider inventory for each fresh Team qualification at catalog scale', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const config = {
            v: 1, kind: 'oidc', issuer: 'https://identity-cost.example.test', clientId: 'happier',
            clientAuthenticationMethod: 'client_secret_post', scopes: 'openid profile email', httpTimeoutSeconds: 30,
            claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: 'oidc' },
        } as const;
        const rows = Array.from({ length: 1_001 }, () => {
            const id = crypto.randomUUID();
            return { id, kind: config.kind, displayName: id, enabled: true, firstEnabledAt: new Date(), config };
        });
        await db.identityProviderInstance.createMany({ data: rows });
        const team = { id: crypto.randomUUID(), authenticationPolicy: {
            v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } };
        const measurements = [];
        // Both reads qualify afresh. Operation-local fact reuse must not become
        // a cache that skips the next request's policy or provider currentness.
        for (let request = 0; request < 2; request += 1) {
            statements.length = 0;
            const result = await client.$transaction(tx => qualifyTeamAuthenticationInTx(tx, {
                env: { HAPPIER_PUBLIC_SERVER_URL: 'https://home-cost.example.test' },
                team, accountId: actor.id, verifiedCredentialEvidence: [],
                operationContext: { kind: 'present_user' },
            }));
            expect(result).toEqual({ status: 'authentication_required',
                accepted: [{ kind: 'home_method', methodId: 'key_challenge' }] });
            const inventoryReads = statements.filter(({ query }) => /^SELECT\b/.test(query)
                && query.includes('"IdentityProviderInstance"') && query.includes('"ownerTeamId" IS NULL'));
            measurements.push(inventoryReads.length);
        }
        console.info('TEAM_QUALIFICATION_PROVIDER_INVENTORY_READS', JSON.stringify(measurements));
        expect(measurements).toEqual([1, 1]);
    });
});
