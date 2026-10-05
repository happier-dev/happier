import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeSessionOwnerMetadataEnvelopeV1,
    SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { sessionRoutes } from './sessionRoutes';
import { registerPublicShareOwnerRoutes } from '../share/registerPublicShareOwnerRoutes';

describe('authenticated reports-to resource', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reports-route-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('projects current endpoint and pairwise eligibility without writing a relation or grants', async () => {
        const [owner, actor] = await Promise.all(Array.from({ length: 2 }, () => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: 'plain' },
        })));
        const create = () => db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: true } });
        const [child, lead, viewerLead] = await Promise.all([create(), create(), create()]);
        await db.sessionShare.createMany({ data: [child, lead, viewerLead].map((target) => ({
            sessionId: target.id, sharedByUserId: owner.id, sharedWithUserId: actor.id,
            accessLevel: target.id === viewerLead.id ? 'view' as const : 'edit' as const,
        })) });
        const app = createAuthenticatedTestApp();
        sessionRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': actor.id };
        const url = `/v1/sessions/${child.id}/reports-to/options`;
        try {
            const before = await db.sessionShare.findMany();
            const response = await app.inject({ method: 'POST', url, headers, payload: { candidateSessionIds: [lead.id, viewerLead.id, child.id] } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ sessionId: child.id, currentLeadSessionId: null, candidates: [
                { sessionId: lead.id, allowed: true },
                { sessionId: viewerLead.id, allowed: false, reason: 'input' },
                { sessionId: child.id, allowed: false, reason: 'cycle' },
            ] });
            await db.publicSessionShare.create({ data: { sessionId: lead.id, tokenHash: Buffer.from(randomUUID()), createdByUserId: owner.id } });
            const denied = await app.inject({ method: 'POST', url, headers, payload: { candidateSessionIds: [lead.id] } });
            expect(denied.json()).toMatchObject({ candidates: [{ sessionId: lead.id, allowed: false, reason: 'pairwise' }] });
            expect(await db.sessionReportsTo.count({ where: { sessionId: child.id } })).toBe(0);
            expect(await db.sessionShare.findMany()).toEqual(before);
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
            const attach = await app.inject({ method: 'POST', url: `/v1/sessions/${child.id}/reports-to`, headers,
                payload: { leadSessionId: lead.id, expectedLeadSessionId: null } });
            expect(attach.statusCode).toBe(200);
            const share = await app.inject({ method: 'POST', url: `/v1/sessions/${lead.id}/public-share`, headers,
                payload: { token: randomUUID() } });
            expect(share.statusCode).toBe(200);
            expect(await db.sessionReportsTo.findUnique({ where: { sessionId: child.id } })).toBeNull();
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
        await db.sessionShare.createMany({ data: [
            { sessionId: child.id, sharedByUserId: workerOwner.id, sharedWithUserId: leadOwner.id, accessLevel: 'edit' },
            { sessionId: lead.id, sharedByUserId: leadOwner.id, sharedWithUserId: workerOwner.id, accessLevel: 'edit' },
        ] });
        let actorId = workerOwner.id;
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = actorId; });
        sessionRoutes(app);
        await app.ready();
        try {
            const url = `/v1/sessions/${child.id}/reports-to`;
            const attach = await app.inject({ method: 'POST', url, payload: { leadSessionId: lead.id, expectedLeadSessionId: null } });
            expect(attach.statusCode).toBe(200);
            expect(attach.json()).toMatchObject({ ok: true, sessionId: child.id, leadSessionId: lead.id });
            const conflict = await app.inject({ method: 'POST', url, payload: { leadSessionId: null, expectedLeadSessionId: null } });
            expect([conflict.statusCode, conflict.json()]).toEqual([409, { ok: false, error: 'reports_to_cas_conflict' }]);
            const cycle = await app.inject({ method: 'POST', url: `/v1/sessions/${lead.id}/reports-to`,
                payload: { leadSessionId: child.id, expectedLeadSessionId: null } });
            expect([cycle.statusCode, cycle.json()]).toEqual([400, { ok: false, error: 'reports_to_cycle' }]);
            actorId = outsider.id;
            const denied = await app.inject({ method: 'POST', url, payload: { leadSessionId: null, expectedLeadSessionId: lead.id } });
            expect([denied.statusCode, denied.json()]).toEqual([403, { ok: false, error: 'reports_to_forbidden', reason: 'read' }]);
            expect((await db.sessionReportsTo.findUniqueOrThrow({ where: { sessionId: child.id } })).leadSessionId).toBe(lead.id);
        } finally {
            await app.close();
        }
    });
});
