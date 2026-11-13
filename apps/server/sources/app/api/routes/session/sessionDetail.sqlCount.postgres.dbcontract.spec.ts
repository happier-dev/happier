import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { buildSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { observePostgresSessionRows } from './sessionDetailSql.postgres.testkit';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session detail physical SQL work (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let barrier: (() => void) | undefined;
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;
    let physicalSql: Awaited<ReturnType<typeof observePostgresSessionRows>> | undefined;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        physicalSql = await observePostgresSessionRows(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL);
        client = new PrismaClient({ datasources: { db: { url: physicalSql.databaseUrl } }, log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => {
            statements.push(event);
            if (event.query === 'SELECT 1 /* detail-count-barrier */') barrier?.();
        });
        await client.$connect();
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_01234567890123456789012345678901');
    });
    afterAll(async () => {
        await client?.$disconnect();
        await physicalSql?.close();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });
    const drain = async () => {
        const observed = new Promise<void>(resolve => { barrier = resolve; });
        await client!.$queryRawUnsafe('SELECT 1 /* detail-count-barrier */');
        await observed;
        barrier = undefined;
    };

    it('loads detail and manager fact families per chunk for 1/33/201 Sessions and observes a subsequent metadata change', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, installationId: crypto.randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
        const sessions = Array.from({ length: 201 }, () => ({ id: crypto.randomUUID() }));
        const requestedAt = new Date();
        await db.session.createMany({ data: sessions.map(({ id }) => ({ id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain',
            pendingActivationRequestId: id, pendingActivationRequestedAt: requestedAt, pendingActivationStatus: 'waiting', pendingCount: 1, pendingVersion: 1 })) });
        const targetFor = (sessionId: string) => ({ homeId: 'srv_01234567890123456789012345678901', accountId: owner.id,
            sessionId, machineId: machine.id, installationId: machine.installationId! });
        await db.accessKey.createMany({ data: sessions.map(({ id }) => ({ accountId: owner.id, sessionId: id, machineId: machine.id, data: 'opaque-key' })) });
        await db.sessionPendingMessage.createMany({ data: sessions.map(({ id }) => ({ sessionId: id, localId: id, position: 0,
            messageRole: 'user', authorAccountId: owner.id, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'queued input' } } },
            requestedAction: { v: 1, kind: 'send_now' }, inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine', admittedTarget: targetFor(id) }) })) });
        const manager = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionFollowEdge.createMany({ data: sessions.map(session => ({ sourceSessionId: session.id, destinationSessionId: manager.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }), relation: 'manager',
            managerSourceSessionId: session.id, policyJson: JSON.stringify({ preset: 'important' }) })) });
        const originalTransaction = db.$transaction;
        const tracedClient = client!;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(tracedClient.$transaction, tracedClient, args);
        } });
        try {
            await withAuthenticatedTestApp(app => registerSessionReadBatchRoute(app), async app => {
                const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
                const read = (ids: string[]) => app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                    payload: { sessionIds: ids, accessProjectionVersion: 1, includeTurns: false } });
                const ids = sessions.map(session => session.id);
                expect((await read(ids)).statusCode).toBe(200);
                await drain();
                const counts: number[] = [];
                for (const size of [1, 33, 201]) {
                    statements.length = 0;
                    const response = await read(ids.slice(0, size));
                    await drain();
                    expect(response.statusCode, response.body).toBe(200);
                    const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                    expect(results.map(result => result.detail?.status)).toEqual(Array(size).fill(200));
                    expect(results.map(result => result.sessionId)).toEqual(ids.slice(0, size));
                    for (const result of results) expect(result.detail).toMatchObject({ status: 200, body: { session: {
                        manager: { sessionId: manager.id }, pendingActivationAuthorization: { status: 'waiting', admittedTarget: targetFor(result.sessionId) },
                    } } });
                    counts.push(statements.filter(event => event.query !== 'SELECT 1 /* detail-count-barrier */').length);
                }
                console.info('SESSION_DETAIL_BATCH_SQL_COUNTS', JSON.stringify({ sizes: [1, 33, 201], counts }));
                expect(counts[1]).toBe(counts[0]);
                expect(counts[2]).toBeLessThanOrEqual(2 * counts[0]!);
                await db.session.update({ where: { id: ids[0] }, data: { metadata: '{"changed":true}', metadataVersion: { increment: 1 } } });
                const changed = SessionReadBatchResponseV1Schema.parse((await read(ids)).json()).results[0]?.detail;
                expect(changed).toMatchObject({ status: 200, body: { session: { metadata: '{"changed":true}', metadataVersion: 1 } } });
                await db.machine.update({ where: { id: machine.id }, data: { installationId: crypto.randomUUID() } });
                const replaced = SessionReadBatchResponseV1Schema.parse((await read(ids)).json()).results;
                for (const result of replaced) {
                    expect(result.detail).toMatchObject({ status: 200, body: { session: { pendingActivationAuthorization: { status: 'waiting' } } } });
                    if (result.detail?.status === 200) expect(result.detail.body.session.pendingActivationAuthorization).not.toHaveProperty('admittedTarget');
                }
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.accessKey.deleteMany({ where: { accountId: owner.id, machineId: machine.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each([false, true])('admits the loaded detail row once with manager relation=%s', async hasManager => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        const manager = hasManager ? await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } }) : null;
        if (manager) await db.sessionFollowEdge.create({ data: {
            sourceSessionId: session.id, destinationSessionId: manager.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
            relation: 'manager', managerSourceSessionId: session.id, policyJson: JSON.stringify({ preset: 'important' }),
        } });
        const originalTransaction = db.$transaction;
        const tracedClient = client!;
        // Rebind only the database transport to observe engine-emitted SQL.
        // The real transaction, admission and projection owners still run.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(tracedClient.$transaction, tracedClient, args);
        } });
        try {
            await withAuthenticatedTestApp(app => {
                registerSessionListingRoutes(app);
                registerSessionReadBatchRoute(app);
            }, async app => {
                const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
                const reads = [
                    { method: 'GET' as const, url: `/v2/sessions/${session.id}` },
                    { method: 'GET' as const, url: `/v2/sessions/${session.id}?accessProjectionVersion=1` },
                    { method: 'POST' as const, url: '/v2/sessions/read-batch', payload: {
                        sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false,
                    } },
                ];
                const measurements: Array<{ statements: number; sessionReads: number; sessionRows: number }> = [];
                // Exclude one-time connection initialization from request work.
                for (const request of reads) {
                    expect((await app.inject({ ...request, headers })).statusCode).toBe(200);
                    await drain();
                }
                for (const request of reads) {
                    statements.length = 0;
                    physicalSql!.reads.length = 0;
                    const response = await app.inject({ ...request, headers });
                    await drain();
                    expect(response.statusCode, response.body).toBe(200);
                    const expected = { session: { id: session.id, ...(manager ? { manager: { sessionId: manager.id } } : {}) } };
                    if (request.method === 'POST') {
                        expect(SessionReadBatchResponseV1Schema.parse(response.json()).results[0]?.detail)
                            .toMatchObject({ status: 200, body: expected });
                    } else expect(response.json()).toMatchObject(expected);
                    const captured = statements.filter(event => event.query !== 'SELECT 1 /* detail-count-barrier */');
                    const sessionReads = captured.filter(({ query }) => /^SELECT\b/.test(query)
                        && /FROM "public"\."Session"(?:\s|$)/.test(query));
                    // Count the original DB result's DataRows, including ORM
                    // relation SELECTs, without replay or display-string parsing.
                    physicalSql!.assertHealthy();
                    expect(physicalSql!.reads.map(read => read.query)).toEqual(sessionReads.map(event => event.query));
                    const sessionRows = physicalSql!.reads.reduce((total, read) => total + read.rows, 0);
                    measurements.push({ statements: captured.length, sessionReads: sessionReads.length, sessionRows });
                }
                console.info('SESSION_DETAIL_SQL_WORK', JSON.stringify({ hasManager, measurements }));
                expect(measurements[0]!.sessionRows).toBeGreaterThan(0);
                // Current detail needs no extra capture-phase access read: its row
                // already carries the same canonical access projection as legacy.
                expect(measurements[1]!.sessionRows).toBe(measurements[0]!.sessionRows);
                expect(measurements[1]!.sessionReads).toBe(measurements[0]!.sessionReads);
                // With no related endpoints there is no collective-access
                // demand. Real relations retain their qualified current reads.
                if (!hasManager) expect(measurements[1]!.statements).toBe(measurements[0]!.statements);
                expect(measurements[2]!.sessionReads).toBe(measurements[1]!.sessionReads);
                expect(measurements[2]!.sessionRows).toBe(measurements[1]!.sessionRows);
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each(['deleted', 'mode', 'layout', 'owner_privacy', 'withdrawn'] as const)(
        'retains each admitted batch row through %s and applies the change on the next request', async mutation => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}',
        } });
        const healthy = await db.session.create({ data: {
            accountId: viewer.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view',
        } });
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const read = () => app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4' },
                    payload: { sessionIds: [session.id, healthy.id], accessProjectionVersion: 1, includeTurns: false } });
                expect(SessionReadBatchResponseV1Schema.parse((await read()).json()).results.map(row => row.detail?.status)).toEqual([200, 200]);
                let changed = false;
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!changed) {
                        changed = true;
                        if (mutation === 'deleted') await db.session.delete({ where: { id: session.id } });
                        else if (mutation === 'owner_privacy') await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
                        else await db.session.update({ where: { id: session.id }, data: mutation === 'mode' ? { encryptionMode: 'e2ee' }
                            : mutation === 'layout' ? { metadataLayoutVersion: 0 } : { currentStorageState: 'legacy_external_unknown' } });
                    }
                    return result;
                } });
                const response = await read();
                expect(response.statusCode, response.body).toBe(200);
                const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                expect(results[0]?.detail).toMatchObject({ status: 200, body: { session: { id: session.id } } });
                expect(results[1]?.detail).toMatchObject({ status: 200, body: { session: { id: healthy.id } } });
                expect(changed).toBe(true);
                const current = SessionReadBatchResponseV1Schema.parse((await read()).json()).results;
                if (mutation === 'mode') {
                    // E2EE metadata stays opaque. The persisted split layout and
                    // owning Account envelope remain valid at this admission.
                    expect(current[0]?.detail).toMatchObject({ status: 200, body: { session: {
                        id: session.id, encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: '{"v":1}',
                    } } });
                } else if (mutation === 'layout' || mutation === 'owner_privacy') {
                    expect(current[0]?.detail).toMatchObject({ status: 409, body: { code: 'metadata_privacy_upgrade_required' } });
                } else {
                    expect(current[0]?.detail).toEqual({ status: 404, body: { error: 'Session not found' } });
                }
                expect(current[1]?.detail).toMatchObject({ status: 200, body: { session: { id: healthy.id } } });
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, viewer.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });

    it.each(['team_grant', 'team_membership', 'team_horizon', 'team_archived', 'group_grant', 'group_membership', 'group_horizon', 'group_archived', 'membership_suspended', 'viewer_suspended'] as const)(
        'retains admitted collective access through %s and observes withdrawal on the next request', async mutation => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Detail batch access' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Readers', nameKey: 'readers' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}' } });
        const effectiveAt = new Date();
        const grant = async () => {
            if (mutation.startsWith('team')) await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, effectiveAt } });
            else await db.sessionGrant.create({ data: { principalKind: 'group', sessionId: session.id, teamGroupId: group.id, effectiveAt } });
        };
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const read = async () => SessionReadBatchResponseV1Schema.parse((await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4' },
                    payload: { sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false } })).json()).results[0]?.detail;
                expect(await read()).toMatchObject({ status: 404 });
                await grant();
                expect(await read()).toMatchObject({ status: 200 });
                let changed = false;
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!changed) {
                        changed = true;
                        if (mutation === 'team_grant') await db.sessionGrant.deleteMany({ where: { principalKind: 'team', sessionId: session.id } });
                        if (mutation === 'group_grant') await db.sessionGrant.deleteMany({ where: { principalKind: 'group', sessionId: session.id } });
                        if (mutation === 'team_membership') await db.teamMembership.delete({ where: { id: membership.id } });
                        if (mutation === 'group_membership') await db.teamGroupMembership.deleteMany({ where: { teamMembershipId: membership.id } });
                        if (mutation === 'team_horizon') await db.teamMembership.update({ where: { id: membership.id }, data: { sessionAccessStartsAt: effectiveAt } });
                        if (mutation === 'group_horizon') await db.teamGroupMembership.updateMany({ where: { teamMembershipId: membership.id }, data: { sessionAccessStartsAt: effectiveAt } });
                        if (mutation === 'team_archived') await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
                        if (mutation === 'group_archived') await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
                        if (mutation === 'membership_suspended') await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
                        if (mutation === 'viewer_suspended') await db.account.update({ where: { id: viewer.id }, data: { status: 'suspended' } });
                    }
                    return result;
                } });
                expect(await read()).toMatchObject({ status: 200 });
                expect(changed).toBe(true);
                expect(await read()).toMatchObject({ status: 404 });
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.delete({ where: { id: session.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });

    it('retains Team authentication continuation and unavailability at each request admission', async () => {
        const feature = 'HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED';
        const previous = process.env[feature];
        vi.stubEnv(feature, '1');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const team = await db.team.create({ data: { name: 'Qualified batch', authenticationPolicy: {
            v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}' } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, effectiveAt: new Date() } });
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const read = async (qualified = false) => SessionReadBatchResponseV1Schema.parse((await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4',
                        ...(qualified ? { 'x-test-authentication-evidence': JSON.stringify([{ kind: 'home_method', methodId: 'key_challenge' }]) } : {}) },
                    payload: { sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false } })).json()).results[0]?.detail;
                expect(await read()).toEqual({ status: 403, body: { error: 'team_authentication_required' } });
                expect(await read(true)).toMatchObject({ status: 200 });
                vi.stubEnv(feature, '0');
                expect(await read(true)).toEqual({ status: 503, body: { error: 'team_authentication_unavailable' } });
                vi.stubEnv(feature, '1');
                let changed = false;
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!changed) {
                        changed = true;
                        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 1, mode: 'restricted', accepted: [] } } });
                    }
                    return result;
                } });
                expect(await read(true)).toMatchObject({ status: 200 });
                expect(changed).toBe(true);
                expect(await read(true)).toEqual({ status: 503, body: { error: 'team_authentication_unavailable' } });
            });
        } finally {
            db.$transaction = originalTransaction;
            vi.stubEnv(feature, previous);
            await db.session.delete({ where: { id: session.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });

    it('retains its admitted encrypted viewer key and sees a replacement on the next request', async () => {
        const content = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(content.publicKey) } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: 'encrypted', encryptionMode: 'e2ee', metadataLayoutVersion: 1,
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'dataKey', machineKey: content.secretKey },
                randomBytes, ownerMetadata: { v: 1 },
            })),
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view',
        } });
        const key = { sessionId: session.id, recipientAccountId: viewer.id };
        await db.sessionDataKeyEnvelope.create({ data: { ...key, encryptedDataKey: Buffer.from('first-key') } });
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const read = async () => SessionReadBatchResponseV1Schema.parse((await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4' },
                    payload: { sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false } })).json()).results[0]?.detail;
                expect(await read()).toMatchObject({ status: 200, body: { session: { dataEncryptionKey: encodeBase64(Buffer.from('first-key')) } } });
                let changed = false;
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!changed) {
                        changed = true;
                        await db.sessionDataKeyEnvelope.update({ where: { sessionId_recipientAccountId: key }, data: { encryptedDataKey: Buffer.from('second-key') } });
                    }
                    return result;
                } });
                expect(await read()).toMatchObject({ status: 200, body: { session: { dataEncryptionKey: encodeBase64(Buffer.from('first-key')) } } });
                db.$transaction = originalTransaction;
                expect(await read()).toMatchObject({ status: 200, body: { session: { dataEncryptionKey: encodeBase64(Buffer.from('second-key')) } } });
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });

    it('retains the admitted manager and removes it from the next batch after revocation', async () => {
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessions = Array.from({ length: 2 }, () => ({ id: crypto.randomUUID() }));
        await db.session.createMany({ data: sessions.map(({ id }) => ({ id, accountId: viewer.id, tag: id, encryptionMode: 'plain', metadata: '{}' })) });
        const manager = await db.session.create({ data: { accountId: foreign.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: manager.id, createdByAccountId: foreign.id, accountId: viewer.id, accessLevel: 'view' } });
        await db.sessionFollowEdge.create({ data: { sourceSessionId: sessions[0]!.id, destinationSessionId: manager.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sessions[0]!.id }), relation: 'manager',
            managerSourceSessionId: sessions[0]!.id, policyJson: JSON.stringify({ preset: 'important' }) } });
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const read = async () => SessionReadBatchResponseV1Schema.parse((await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4' },
                    payload: { sessionIds: sessions.map(row => row.id), accessProjectionVersion: 1, includeTurns: false } })).json()).results;
                expect((await read())[0]?.detail).toMatchObject({ status: 200, body: { session: { manager: { sessionId: manager.id } } } });
                let revoked = false;
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!revoked) {
                        revoked = true;
                        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: manager.id } });
                    }
                    return result;
                } });
                const results = await read();
                expect(results.map(row => row.detail?.status)).toEqual([200, 200]);
                expect(results[0]?.detail).toMatchObject({ status: 200, body: { session: { manager: { sessionId: manager.id } } } });
                const current = await read();
                expect(current.map(row => row.detail?.status)).toEqual([200, 200]);
                for (const row of current) if (row.detail?.status === 200) expect(row.detail.body.session).not.toHaveProperty('manager');
                expect(revoked).toBe(true);
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.deleteMany({ where: { accountId: { in: [viewer.id, foreign.id] } } });
            await db.account.deleteMany({ where: { id: { in: [viewer.id, foreign.id] } } });
        }
    });

    it('keeps a capture privacy refusal local and preserves duplicate ids and an empty corpus', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const malformed = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: 'not-shared-json', ownerMetadata: '{"t":"plain","v":{"v":1}}' } });
        const healthy = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        try {
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const read = async (sessionIds: string[]) => {
                    const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                        headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                        payload: { sessionIds, accessProjectionVersion: 1, includeTurns: false } });
                    expect(response.statusCode, response.body).toBe(200);
                    return SessionReadBatchResponseV1Schema.parse(response.json()).results;
                };
                const ids = [malformed.id, healthy.id, healthy.id, 'missing'];
                const results = await read(ids);
                expect(results.map(row => row.sessionId)).toEqual(ids);
                expect(results.map(row => row.detail?.status)).toEqual([409, 200, 200, 404]);
                expect(results[1]?.detail).toEqual(results[2]?.detail);
                expect(await read([])).toEqual([]);
            });
        } finally {
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each(['GET', 'POST'] as const)('finishes admitted %s detail and refuses the next request after direct revocation', async method => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }), currentStorageState: 'hosted',
        } });
        const share = await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view',
        } });
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(app => {
                registerSessionListingRoutes(app);
                registerSessionReadBatchRoute(app);
            }, async app => {
                const request = {
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4' },
                    ...(method === 'GET'
                        ? { method, url: `/v2/sessions/${session.id}?accessProjectionVersion=1` }
                        : { method, url: '/v2/sessions/read-batch', payload: {
                            sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false,
                        } }),
                };
                const detail = (response: Readonly<{ statusCode: number; json(): unknown }>) => method === 'GET'
                    ? { status: response.statusCode, body: response.json() }
                    : SessionReadBatchResponseV1Schema.parse(response.json()).results[0]?.detail;
                expect(detail(await app.inject(request))).toMatchObject({ status: 200, body: { session: { id: session.id } } });
                let revoked = false;
                // Commit real concurrent revocation after the admission snapshot
                // closes, without mocking any access decision.
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!revoked) {
                        revoked = true;
                        await db.sessionGrant.delete({ where: { principalKind: 'account', id: share.id } });
                    }
                    return result;
                } });
                expect(detail(await app.inject(request))).toMatchObject({ status: 200, body: { session: { id: session.id } } });
                expect(revoked).toBe(true);
                expect(detail(await app.inject(request))).toEqual({ status: 404, body: { error: 'Session not found' } });
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });
});
