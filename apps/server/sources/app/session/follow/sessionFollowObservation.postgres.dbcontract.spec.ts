import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { observePendingSessionFollowForDestinationInTx, observePendingSessionFollowForInactiveDestinationInTx } from './sessionFollowEdgeService';
import { sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { readPendingFollowReceiversInTx } from './pendingFollowReceivers';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Follow observation SQL demand (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        client.$on('query', event => queries.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); await shutdownDbClient(); });

    it('discovers only pending receivers with set reads as the inactive inventory grows', async () => {
        const accountId = `follow-receivers-${randomUUID()}`;
        const sourceSessionId = `${accountId}-source`;
        const receiverIds = Array.from({ length: 1_000 }, (_, index) => `${accountId}-${index}`);
        const machineId = randomUUID();
        const installationId = randomUUID();
        await client.account.create({ data: { id: accountId, encryptionMode: 'plain' } });
        try {
            await client.machine.create({ data: { id: machineId, accountId, installationId, active: true,
                metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
            const homeId = await getOrCreateServerIdentityId();
            await client.session.createMany({ data: [sourceSessionId, ...receiverIds].map(id => ({
                id, accountId, tag: id, metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted', seq: 1,
                ...(id === sourceSessionId ? {} : { runtimeMachineTarget: { homeId, accountId, sessionId: id, machineId, installationId } }),
            })) });
            await client.accessKey.createMany({ data: receiverIds.map(sessionId => ({ accountId, machineId, sessionId, data: MACHINE_PLAIN_DATA_KEY_MARKER })) });
            const measure = async (count: number, pending: boolean) => {
                await client.sessionFollowEdge.deleteMany({ where: { destinationSession: { accountId } } });
                await client.sessionFollowEdge.createMany({ data: receiverIds.slice(0, count).map((destinationSessionId, index) => ({
                    destinationSessionId, sourceSessionId,
                    sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sourceSessionId }),
                    policyJson: '{"preset":"important"}', deliveredTranscriptSeq: pending && index === 0 ? 0 : 1,
                })) });
                queries.length = 0;
                const start = performance.now();
                const result = await client.$transaction(tx => readPendingFollowReceiversInTx(tx, {
                    accountId, machineId, installationId, authentication,
                }), { isolationLevel: 'RepeatableRead', timeout: 60_000 });
                expect(result).toEqual({ ok: true, v: 1, sessionIds: pending ? [receiverIds[0]] : [] });
                const selects = queries.filter(query => /^SELECT\b/.test(query.query)).length;
                console.info('FOLLOW_RECEIVER_SQL', JSON.stringify({ count, pending, selects, elapsedMs: performance.now() - start }));
                return selects;
            };
            const one = await measure(1, true);
            expect(await measure(49, true)).toBe(one);
            expect(await measure(1_000, true)).toBe(one);
            const settled = await measure(1, false);
            expect(await measure(1_000, false)).toBe(settled);
        } finally {
            await client.sessionFollowEdge.deleteMany({ where: { destinationSession: { accountId } } });
            await client.accessKey.deleteMany({ where: { accountId } });
            await client.session.deleteMany({ where: { accountId } });
            await client.machine.deleteMany({ where: { accountId } });
            await client.account.delete({ where: { id: accountId } });
        }
    });

    it.each([false, true])('reads inactive and running sources in sets, including bind boundaries (restricted Team: %s)', async restrictedTeam => {
        const accountId = `follow-observe-${randomUUID()}`;
        const destinationSessionId = `${accountId}-destination`;
        const sourceIds = Array.from({ length: 1_000 }, (_, index) => `${accountId}-${index}`);
        const machineId = randomUUID();
        const installationId = randomUUID();
        const sourceAccountId = restrictedTeam ? `${accountId}-source-owner` : accountId;
        const teamId = `${accountId}-team`;
        await client.account.create({ data: { id: accountId, encryptionMode: 'plain' } });
        try {
            if (restrictedTeam) await client.account.create({ data: { id: sourceAccountId, encryptionMode: 'plain' } });
            await client.machine.create({ data: { id: machineId, accountId, installationId, active: true,
                metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
            await client.session.createMany({ data: [destinationSessionId, ...sourceIds].map(id => ({
                id, accountId: id === destinationSessionId ? accountId : sourceAccountId,
                tag: id, metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted', seq: 1,
            })) });
            if (restrictedTeam) {
                await client.team.create({ data: { id: teamId, name: teamId,
                    authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }] } } });
                await client.teamMembership.create({ data: { teamId, accountId, role: 'member', sessionAccessStartsAt: null } });
                await client.sessionGrant.createMany({ data: (sourceIds.map(sessionId => ({ sessionId, teamId, effectiveAt: new Date(1) }))).map(data => ({ ...data, principalKind: 'team' })) });
                // Direct read remains an independent admitted arm even without Team evidence.
                await client.sessionGrant.createMany({ data: (sourceIds.map(sessionId => ({ sessionId,
                    createdByAccountId: sourceAccountId, accountId: accountId, accessLevel: 'view' }))).map(data => ({ ...data, principalKind: 'account' })) });
            }
            await client.accessKey.create({ data: { accountId, machineId, sessionId: destinationSessionId, data: MACHINE_PLAIN_DATA_KEY_MARKER } });
            await client.session.update({ where: { id: destinationSessionId }, data: { runtimeMachineTarget: {
                homeId: await getOrCreateServerIdentityId(), accountId, sessionId: destinationSessionId, machineId, installationId,
            } } });
            const measure = async (count: number, inactive: boolean) => {
                await client.sessionFollowEdge.deleteMany({ where: { destinationSessionId } });
                await client.sessionFollowEdge.createMany({ data: sourceIds.slice(0, count).map(sourceSessionId => ({
                    destinationSessionId, sourceSessionId, sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sourceSessionId }),
                    policyJson: '{"preset":"important"}',
                })) });
                queries.length = 0;
                const start = performance.now();
                const observation = await client.$transaction(async tx => {
                    if (!inactive) return observePendingSessionFollowForDestinationInTx(tx, { destinationSessionId, includeManager: true,
                        principal: { kind: 'destination_runtime', destinationRuntimeAccountId: accountId, authentication } });
                    const result = await observePendingSessionFollowForInactiveDestinationInTx(tx, {
                        accountId, destinationSessionId, machineId, installationId, authentication,
                    });
                    if (!result.ok) throw new Error(result.error);
                    return result;
                }, { isolationLevel: 'RepeatableRead', timeout: 60_000 });
                expect(observation).toHaveProperty('currentSourceSessionIds');
                expect(observation.currentSourceSessionIds).toHaveLength(count);
                expect(observation.observations).toHaveLength(count);
                const selects = queries.filter(query => /^SELECT\b/.test(query.query));
                expect(selects.every(query => JSON.parse(query.params).length <= 999)).toBe(true);
                const result = { count, inactive, restrictedTeam, selects: selects.length, elapsedMs: performance.now() - start };
                console.info('FOLLOW_OBSERVATION_SQL', JSON.stringify(result));
                return result;
            };
            for (const inactive of [true, false]) {
                const one = await measure(1, inactive);
                const many = await measure(32, inactive);
                expect(many.selects).toBe(one.selects);
                const chunked = await measure(1_000, inactive);
                // Existing access batches are 200 Sessions; provider chunks may add
                // set reads but must never restore a query per source edge.
                expect(chunked.selects).toBeLessThan(one.selects * 10);
            }
        } finally {
            await client.sessionFollowEdge.deleteMany({ where: { destinationSessionId } });
            await client.accessKey.deleteMany({ where: { accountId } });
            await client.session.deleteMany({ where: { accountId: { in: [accountId, sourceAccountId] } } });
            await client.machine.deleteMany({ where: { accountId } });
            if (restrictedTeam) {
                await client.team.delete({ where: { id: teamId } });
                await client.account.delete({ where: { id: sourceAccountId } });
            }
            await client.account.delete({ where: { id: accountId } });
        }
    });
});
