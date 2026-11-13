import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeSessionOwnerMetadataEnvelopeV1,
    SessionSharedMetadataV1Schema,
    SessionManagerOptionsV1Schema,
} from '@happier-dev/protocol';

import { db } from '@/storage/db';
import * as storage from '@/storage/prisma';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { sessionRoutes } from './sessionRoutes';
import { registerPublicShareOwnerRoutes } from '../share/registerPublicShareOwnerRoutes';
import { setSessionManager } from '@/app/session/follow/sessionManagerService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';

describe('authenticated manager resource', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reports-route-', env: {
        HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
    } }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('admits 1,000 candidates once within the transaction budget and applies a new public destination on the next request', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const create = () => db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const child = await create();
        // Cross the access owner's existing conservative 999-bind SQLite
        // boundary as well as its Session batch, without limiting the request.
        const leads = Array.from({ length: 1_000 }, () => ({ id: randomUUID() }));
        await db.session.createMany({ data: leads.map(lead => ({
            id: lead.id, accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        })) });
        expect((await setSessionManager({ accountId: owner.id, sessionId: leads[1].id, managerSessionId: child.id,
            expectedManagerSessionId: null, authentication: createPresentUserSessionAccessAuthentication({ env: {} }) })).ok).toBe(true);
        const app = createAuthenticatedTestApp();
        sessionRoutes(app);
        await app.ready();
        const readSnapshot = storage.withSqliteReadSnapshot;
        const timeoutMs = readDatabaseTransactionConfigFromEnv({}, 'postgres').timeoutMs;
        let phases = 0;
        // Database latency is the system boundary. Every query still executes on
        // real SQLite, while each round trip consumes 100ms of the production
        // transaction budget without introducing wall-clock test flakiness.
        const snapshot = vi.spyOn(storage, 'withSqliteReadSnapshot').mockImplementation(async (read, options) => {
            let elapsedMs = 0;
            const result = await readSnapshot(tx => read(new Proxy(tx, {
                get(target, property, receiver) {
                    const delegate: unknown = Reflect.get(target, property, receiver);
                    if (!delegate || typeof delegate !== 'object') return delegate;
                    return new Proxy(delegate, {
                        get(model, operation) {
                            const query: unknown = Reflect.get(model, operation);
                            if (typeof query !== 'function') return query;
                            return (...args: unknown[]) => {
                                elapsedMs += 100;
                                if (elapsedMs > timeoutMs) throw Object.assign(new Error('Transaction expired during candidate scan'), { code: 'P2028' });
                                return Reflect.apply(query, model, args);
                            };
                        },
                    });
                },
            })), options);
            if (++phases === 1) await db.publicSessionShare.create({ data: {
                sessionId: leads[0].id, tokenHash: Buffer.from(randomUUID()), createdByUserId: owner.id,
            } });
            return result;
        });
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/sessions/${child.id}/manager/options`,
                headers: { 'x-test-user-id': owner.id }, payload: { candidateSessionIds: leads.map(lead => lead.id) } });
            expect(response.statusCode).toBe(200);
            expect(SessionManagerOptionsV1Schema.parse(response.json())).toEqual({
                sessionId: child.id, currentManagerSessionId: null,
                candidates: leads.map((lead, index) => index === 1 ? { sessionId: lead.id, allowed: false, reason: 'cycle' }
                    : { sessionId: lead.id, allowed: true }),
            });
            expect(phases).toBe(1);
            const next = await app.inject({ method: 'POST', url: `/v1/sessions/${child.id}/manager/options`,
                headers: { 'x-test-user-id': owner.id }, payload: { candidateSessionIds: leads.map(lead => lead.id) } });
            expect(next.statusCode).toBe(200);
            expect(SessionManagerOptionsV1Schema.parse(next.json()).candidates[0]).toEqual({
                sessionId: leads[0].id, allowed: false, reason: 'pairwise',
            });
            expect(phases).toBe(2);
            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: child.id } })).toBe(0);
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: leads[1].id } })).toMatchObject({ destinationSessionId: child.id, relation: 'manager' });
        } finally { snapshot.mockRestore(); await app.close(); }
    });

    it('projects current endpoint and pairwise eligibility without writing a relation or grants', async () => {
        const [owner, actor] = await Promise.all(Array.from({ length: 2 }, () => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: 'plain' },
        })));
        const create = () => db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: true } });
        const [child, lead, viewerLead] = await Promise.all([create(), create(), create()]);
        await db.sessionGrant.createMany({ data: ([child, lead, viewerLead].map((target) => ({
            sessionId: target.id, createdByAccountId: owner.id, accountId: actor.id,
            accessLevel: target.id === viewerLead.id ? 'view' as const : 'edit' as const,
        }))).map(data => ({ ...data, principalKind: 'account' })) });
        const app = createAuthenticatedTestApp();
        sessionRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': actor.id };
        const url = `/v1/sessions/${child.id}/manager/options`;
        try {
            const before = await db.sessionGrant.findMany({ where: { principalKind: 'account' } });
            const response = await app.inject({ method: 'POST', url, headers, payload: { candidateSessionIds: [lead.id, viewerLead.id, child.id] } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ sessionId: child.id, currentManagerSessionId: null, candidates: [
                { sessionId: lead.id, allowed: true },
                { sessionId: viewerLead.id, allowed: false, reason: 'input' },
                { sessionId: child.id, allowed: false, reason: 'cycle' },
            ] });
            await db.publicSessionShare.create({ data: { sessionId: lead.id, tokenHash: Buffer.from(randomUUID()), createdByUserId: owner.id } });
            const denied = await app.inject({ method: 'POST', url, headers, payload: { candidateSessionIds: [lead.id] } });
            expect(denied.json()).toMatchObject({ candidates: [{ sessionId: lead.id, allowed: false, reason: 'pairwise' }] });
            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: child.id } })).toBe(0);
            expect(await db.sessionGrant.findMany({ where: { principalKind: 'account' } })).toEqual(before);
            expect(await db.session.findMany({ where: { id: { in: [child.id, lead.id] } }, select: { active: true } })).toEqual([{ active: true }, { active: true }]);
        } finally { await app.close(); }
    });

    it('removes an unsafe child relation when its lead becomes publicly shared', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const create = () => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify(SessionSharedMetadataV1Schema.parse({ v: 1 })),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1({ t: 'plain', v: { v: 1 } }),
        } });
        const [child, lead] = await Promise.all([create(), create()]);
        const app = createAuthenticatedTestApp();
        sessionRoutes(app);
        registerPublicShareOwnerRoutes(app);
        await app.ready();
        const headers = {
            'x-test-user-id': owner.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        };
        try {
            const attach = await app.inject({ method: 'POST', url: `/v1/sessions/${child.id}/manager`, headers,
                payload: { managerSessionId: lead.id, expectedManagerSessionId: null } });
            expect(attach.statusCode).toBe(200);
            const share = await app.inject({ method: 'POST', url: `/v1/sessions/${lead.id}/public-share`, headers,
                payload: { lookupId: randomUUID(), keyDerivation: 'fragment_v1' } });
            expect(share.statusCode).toBe(200);
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
            expect(await db.publicSessionShare.findUnique({ where: { sessionId: child.id } })).toBeNull();
        } finally { await app.close(); }
    });

    it('attaches across owners with existing grants and returns typed cycle/CAS/authority refusals', async () => {
        const [workerOwner, leadOwner, outsider] = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: 'plain' },
        })));
        const create = (accountId: string) => db.session.create({ data: {
            accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        const child = await create(workerOwner.id);
        const lead = await create(leadOwner.id);
        await db.sessionGrant.createMany({ data: [
            { principalKind: 'account', sessionId: child.id, createdByAccountId: workerOwner.id, accountId: leadOwner.id, accessLevel: 'edit' },
            { principalKind: 'account', sessionId: lead.id, createdByAccountId: leadOwner.id, accountId: workerOwner.id, accessLevel: 'edit' },
        ] });
        let actorId = workerOwner.id;
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = actorId; });
        sessionRoutes(app);
        await app.ready();
        try {
            const url = `/v1/sessions/${child.id}/manager`;
            const attach = await app.inject({ method: 'POST', url, payload: { managerSessionId: lead.id, expectedManagerSessionId: null } });
            expect(attach.statusCode).toBe(200);
            expect(attach.json()).toMatchObject({ ok: true, sessionId: child.id, managerSessionId: lead.id });
            const conflict = await app.inject({ method: 'POST', url, payload: { managerSessionId: null, expectedManagerSessionId: null } });
            expect([conflict.statusCode, conflict.json()]).toEqual([409, { ok: false, error: 'manager_cas_conflict' }]);
            const cycle = await app.inject({ method: 'POST', url: `/v1/sessions/${lead.id}/manager`,
                payload: { managerSessionId: child.id, expectedManagerSessionId: null } });
            expect([cycle.statusCode, cycle.json()]).toEqual([400, { ok: false, error: 'manager_cycle' }]);
            actorId = outsider.id;
            const denied = await app.inject({ method: 'POST', url, payload: { managerSessionId: null, expectedManagerSessionId: lead.id } });
            expect([denied.statusCode, denied.json()]).toEqual([403, { ok: false, error: 'manager_forbidden', reason: 'read' }]);
            expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } })).destinationSessionId).toBe(lead.id);
        } finally {
            await app.close();
        }
    });
});
