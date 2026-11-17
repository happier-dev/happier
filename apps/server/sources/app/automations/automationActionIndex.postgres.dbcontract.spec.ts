import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { db, initDbPostgres } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationActionIndexRoutes } from '@/app/api/routes/automations/registerAutomationActionIndexRoutes';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { inTx } from '@/storage/inTx';
import { markAutomationChangedTx } from './automationCrudService';
import { eventRouter, type ClientConnection, type UpdatePayload } from '@/app/events/eventRouter';
import type { Socket } from 'socket.io';
import { updateArtifact } from '@/app/artifacts/artifactWriteService';
import { applyArtifactRecipientKeyEnvelopesInTx, removeArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { automationActionIndexSelect, projectAutomationActionIndexRows } from './automationActionIndex';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Action index seed (PostgreSQL)', () => {
    let ownerId: string;
    let actorId: string;
    const accounts: string[] = [];
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'action-index-disposable-contract');
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        ownerId = (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
        actorId = (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
        accounts.push(ownerId, actorId);
    });
    afterAll(async () => {
        await db.artifact.deleteMany({ where: { accountId: { in: accounts } } });
        await db.account.deleteMany({ where: { id: { in: accounts } } });
        await db.$disconnect();
        vi.unstubAllEnvs();
    });

    it('seeds structural own rows, reference-only consents and eligible direct-person shared links without opening private definitions', async () => {
        const workflowId = randomUUID();
        await db.artifact.create({ data: { id: workflowId, accountId: ownerId, bodyVersion: 9,
            header: Buffer.from(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }), 'base64'),
            body: Buffer.from(encodePlainArtifactStoredContent({}), 'base64'),
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: workflowId,
            accountId: actorId, accessLevel: 'view', createdByAccountId: ownerId } });
        const subject = { kind: 'machine' as const, serverId: randomUUID(), machineId: randomUUID() };
        const sharedTriggerId = randomUUID();
        const sharedAutomationId = randomUUID();
        const actionIdsJson = JSON.stringify(['session.stop', 'session.archive']);
        const sharedColumns = { kind: 'action' as const, actionIdsJson, phase: 'before', mode: 'wait', onFailure: 'ask',
            definitionEnvelope: 'private-trigger-definition',
            subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject), reachesOthers: true };
        await db.automation.create({ data: { id: sharedAutomationId, accountId: ownerId, workflowDefinitionId: workflowId,
            name: 'private name', templateVersion: 71, templateCiphertext: 'not-readable-private-definition',
            triggers: { create: [
                { ...sharedColumns, id: sharedTriggerId },
                { ...sharedColumns, id: randomUUID(), reachesOthers: false },
                { ...sharedColumns, id: randomUUID(), subjectKind: 'plugin' },
                { ...sharedColumns, id: randomUUID(), subjectKind: null, subjectKey: null },
            ] } } });
        const ownId = randomUUID();
        const ownTriggerId = randomUUID();
        await db.automation.create({ data: { id: ownId, accountId: actorId,
            name: 'own', templateCiphertext: 'not-readable-private-definition',
            triggers: { create: { id: ownTriggerId, kind: 'action', actionIdsJson, phase: 'after',
                definitionEnvelope: 'private-trigger-definition' } } } });
        const consentId = randomUUID();
        await db.automation.create({ data: { id: consentId, accountId: actorId, workflowDefinitionId: workflowId,
            name: 'consent', templateCiphertext: 'not-readable-private-definition',
            triggers: { create: { id: randomUUID(), kind: 'action', consentForAutomationId: sharedAutomationId,
                consentForTriggerId: sharedTriggerId, consentedWorkflowRevision: 9 } } } });
        const app = createAuthenticatedTestApp();
        registerAutomationActionIndexRoutes(app);
        changesRoutes(app);
        try {
            const response = await app.inject({ method: 'GET', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': actorId } });
            expect(response.statusCode).toBe(200);
            expect(response.headers['cache-control']).toBe('no-store');
            const seed = response.json();
            expect(seed.rows).toHaveLength(3);
            expect(seed.rows).toEqual(expect.arrayContaining([
                expect.objectContaining({ automationId: ownId, triggerId: ownTriggerId,
                    actionIds: ['session.stop', 'session.archive'], phase: 'after' }),
                expect.objectContaining({ automationId: sharedAutomationId, triggerId: sharedTriggerId,
                    workflowRevision: 9, subjectKey: automationSubjectKeyV1(subject, workflowId), reachesOthers: true }),
                expect.objectContaining({ automationId: consentId,
                    consentFor: { automationId: sharedAutomationId, triggerId: sharedTriggerId }, consentedWorkflowRevision: 9 }),
            ]));
            expect(seed.rows.find((row: { automationId: string }) => row.automationId === consentId)).not.toHaveProperty('actionIds');
            expect(response.body).not.toContain('not-readable-private-definition');
            expect(response.body).not.toContain('private name');
            expect(response.body).not.toContain(subject.machineId);

            // Reconnect recovery uses retained changed ids, without a second full seed.
            const selected = await app.inject({ method: 'POST', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': actorId }, payload: { automationIds: [ownId], workflowDefinitionIds: [] } });
            expect(selected.statusCode).toBe(200);
            expect(selected.json().rows).toEqual([expect.objectContaining({ automationId: ownId })]);
            const noScopes = await app.inject({ method: 'POST', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': actorId }, payload: { automationIds: [], workflowDefinitionIds: [] } });
            expect(noScopes.statusCode).toBe(200);
            expect(noScopes.json()).toEqual({ v: 1, rows: [] });
            const startingCursor = (await app.inject({ method: 'GET', url: '/v2/cursor',
                headers: { 'x-test-user-id': actorId } })).json<{ cursor: number }>().cursor;

            // Socket.IO is the boundary: retain the real publication and grant owners.
            const pushed: UpdatePayload[] = [];
            const observer: ClientConnection = { connectionType: 'user-scoped', userId: actorId,
                socket: { emit(event: string, payload: UpdatePayload) {
                    if (event === 'update' && payload.body.t === 'automation-upsert') pushed.push(payload);
                } } as unknown as Socket };
            eventRouter.addConnection(actorId, observer);
            try {
                // Use the already-loaded snapshots that the CRUD owner publishes.
                const publicationSnapshot = () => db.automation.findUniqueOrThrow({ where: { id: sharedAutomationId },
                    include: { triggers: true } });
                const initial = await publicationSnapshot();
                await inTx(tx => markAutomationChangedTx(tx, { accountId: ownerId, automationId: sharedAutomationId,
                    publication: { previous: null, current: initial } }));
                expect(pushed).toHaveLength(1);
                expect(pushed[0]?.body).toMatchObject({ t: 'automation-upsert', actionIndex: {
                    automationId: sharedAutomationId,
                    rows: [{ triggerId: sharedTriggerId, workflowRevision: 9,
                        subjectKey: automationSubjectKeyV1(subject, workflowId) }],
                } });
                pushed.length = 0;
                const renamed = await db.automation.update({ where: { id: sharedAutomationId }, data: { name: 'renamed' },
                    include: { triggers: true } });
                await inTx(tx => markAutomationChangedTx(tx, { accountId: ownerId, automationId: sharedAutomationId,
                    publication: { previous: initial, current: renamed } }));
                expect(pushed).toHaveLength(0);
                expect(await updateArtifact({ actorUserId: ownerId, artifactId: workflowId,
                    body: { expectedVersion: 9, bytes: Buffer.from(encodePlainArtifactStoredContent({ changed: true }), 'base64') },
                })).toMatchObject({ ok: true });
                expect(pushed).toHaveLength(1);
                expect(pushed[0]?.body).toMatchObject({ t: 'automation-upsert', actionIndex: {
                    rows: [{ triggerId: sharedTriggerId, workflowRevision: 10 }],
                } });
                pushed.length = 0;
                await inTx(async tx => {
                    const previous = await publicationSnapshot();
                    const current = await tx.automation.update({ where: { id: sharedAutomationId }, data: { enabled: false },
                        include: { triggers: true } });
                    await markAutomationChangedTx(tx, { accountId: ownerId, automationId: sharedAutomationId,
                        publication: { previous, current } });
                });
                expect(pushed).toHaveLength(1);
                expect(pushed[0]?.body).toMatchObject({ t: 'automation-upsert', actionIndex: {
                    automationId: sharedAutomationId, rows: [],
                } });
                await inTx(async tx => {
                    const previous = await publicationSnapshot();
                    const current = await tx.automation.update({ where: { id: sharedAutomationId }, data: { enabled: true },
                        include: { triggers: true } });
                    await markAutomationChangedTx(tx, { accountId: ownerId, automationId: sharedAutomationId,
                        publication: { previous, current } });
                });
                pushed.length = 0;
                expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, { actorAccountId: ownerId,
                    artifactId: workflowId, principal: { kind: 'account', accountId: actorId } }))).toMatchObject({ ok: true });
                expect(pushed).toHaveLength(1);
                expect(pushed[0]?.body).toMatchObject({ t: 'automation-upsert', actionIndex: {
                    automationId: sharedAutomationId, rows: [],
                } });
                await inTx(async tx => {
                    const previous = await tx.automation.findUniqueOrThrow({ where: { id: ownId }, include: { triggers: true } });
                    await tx.automation.update({ where: { id: ownId }, data: { enabled: false, deletedAt: new Date() } });
                    await markAutomationChangedTx(tx, { accountId: actorId, automationId: ownId,
                        publication: { previous, current: null } });
                    // A later ordinary mark coalesces away any old structural hint.
                    await markAccountChanged(tx, { accountId: actorId, kind: 'artifact', entityId: workflowId });
                    await markAccountChanged(tx, { accountId: actorId, kind: 'automation', entityId: ownId });
                });
                const missed = await app.inject({ method: 'GET', url: `/v2/changes?after=${startingCursor}`,
                    headers: { 'x-test-user-id': actorId } });
                expect(missed.statusCode).toBe(200);
                const changes = missed.json<{ changes: { kind: string; entityId: string }[] }>().changes;
                expect(changes).toEqual(expect.arrayContaining([
                    expect.objectContaining({ kind: 'artifact', entityId: workflowId }),
                    expect.objectContaining({ kind: 'automation', entityId: ownId }),
                ]));
                const recovered = await app.inject({ method: 'POST', url: '/v1/automations/actions/index',
                    headers: { 'x-test-user-id': actorId }, payload: {
                        automationIds: changes.filter(change => change.kind === 'automation').map(change => change.entityId),
                        workflowDefinitionIds: changes.filter(change => change.kind === 'artifact').map(change => change.entityId),
                    } });
                expect(recovered.statusCode).toBe(200);
                expect(recovered.json().rows).toEqual([expect.objectContaining({ automationId: consentId })]);
            } finally { eventRouter.removeConnection(actorId, observer); }
        } finally { await app.close(); }
    });

    it('publishes newly readable custody once and leaves matching facts unchanged on repeated wraps', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const recipient = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        accounts.push(owner.id, recipient.id);
        const key = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
            recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes }));
        const workflow = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode('opaque header'), body: new TextEncoder().encode('opaque body'),
            dataEncryptionKey: wrap(owner.contentPublicKey!) } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: workflow.id,
            accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const automation = await db.automation.create({ data: { accountId: owner.id, name: 'private',
            workflowDefinitionId: workflow.id, templateCiphertext: 'opaque definition', triggers: { create: {
                kind: 'action', actionIdsJson: JSON.stringify(['session.stop']), phase: 'after',
                definitionEnvelope: 'opaque trigger', subjectKind: 'machine', reachesOthers: true,
                subjectKey: automationSubjectKeyV1({ kind: 'machine', serverId: randomUUID(), machineId: randomUUID() }),
            } } } });
        const updates: UpdatePayload[] = [];
        const observer: ClientConnection = { connectionType: 'user-scoped', userId: recipient.id,
            socket: { emit(event: string, payload: UpdatePayload) {
                if (event === 'update' && payload.body.t === 'automation-upsert') updates.push(payload);
            } } as unknown as Socket };
        eventRouter.addConnection(recipient.id, observer);
        const entry = { recipientAccountId: recipient.id, encryptedDataKey: privacyKit.encodeBase64(wrap(recipient.contentPublicKey!)),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.contentPublicKey!) };
        const apply = (envelope = entry) => inTx(tx => applyArtifactRecipientKeyEnvelopesInTx(tx, {
            artifactId: workflow.id, recipientKeyEnvelopes: [envelope],
        }));
        try {
            expect(await apply()).toMatchObject({ appliedRecipientAccountIds: [recipient.id] });
            expect(updates).toHaveLength(1);
            expect(updates[0]?.body).toMatchObject({ actionIndex: { automationId: automation.id } });
            updates.length = 0;
            await apply();
            await apply({ ...entry, encryptedDataKey: privacyKit.encodeBase64(wrap(recipient.contentPublicKey!)) });
            expect(updates).toEqual([]);
        } finally { eventRouter.removeConnection(recipient.id, observer); }
    });

    it('keeps inline managed Action tuples own-only without a shared Workflow audience or cursor', async () => {
        const accountId = (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
        accounts.push(accountId);
        const subject = { kind: 'machine' as const, serverId: randomUUID(), machineId: randomUUID() };
        const definition = await db.automation.create({ data: { id: randomUUID(), accountId,
            name: 'inline managed Action', templateVersion: 4, templateCiphertext: 'private inline Workflow',
            triggers: { create: { id: randomUUID(), kind: 'action', actionIdsJson: JSON.stringify(['session.stop']),
                phase: 'after', definitionEnvelope: 'private inline definition', reachesOthers: true,
                subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject) } },
        }, select: automationActionIndexSelect });
        expect(definition.workflowDefinitionId).toBeNull();
        const artifactCursorsBefore = await db.accountChange.count({ where: { kind: 'artifact' } });
        const updates: UpdatePayload[] = [];
        const observer: ClientConnection = { connectionType: 'machine-scoped', userId: accountId,
            machineId: subject.machineId, socket: { emit(event: string, payload: UpdatePayload) {
                if (event === 'update') updates.push(payload);
            } } as unknown as Socket };
        eventRouter.addConnection(accountId, observer);
        const app = createAuthenticatedTestApp();
        registerAutomationActionIndexRoutes(app);
        try {
            await inTx(tx => markAutomationChangedTx(tx, { accountId, automationId: definition.id,
                publication: { previous: null, current: definition } }));
            expect(updates.map(update => update.body)).toEqual([expect.objectContaining({ t: 'automation-upsert',
                actionIndex: { automationId: definition.id, rows: [expect.objectContaining({
                    automationId: definition.id, workflowId: definition.id, workflowRevision: 4, reachesOthers: true,
                })] },
            })]);
            expect(projectAutomationActionIndexRows(definition, new Map(), true)).toEqual([]);
            expect(await db.accountChange.count({ where: { kind: 'artifact' } })).toBe(artifactCursorsBefore);
            const seed = await app.inject({ method: 'GET', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': accountId } });
            expect(seed.statusCode).toBe(200);
            expect(seed.json().rows).toEqual([expect.objectContaining({ automationId: definition.id,
                workflowId: definition.id, workflowRevision: 4, reachesOthers: true })]);
            const foreignSeed = await app.inject({ method: 'GET', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': actorId } });
            expect(foreignSeed.statusCode).toBe(200);
            expect(foreignSeed.json().rows).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ automationId: definition.id }),
            ]));
        } finally {
            eventRouter.removeConnection(accountId, observer);
            await app.close();
        }
    });

    it('selects changed scopes through indexed public facts among unrelated private definitions', async () => {
        const bystander = (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
        accounts.push(bystander);
        const unrelatedIds = Array.from({ length: 2_500 }, () => randomUUID());
        await db.automation.createMany({ data: unrelatedIds.map(id => ({
            id, accountId: bystander, name: 'private unrelated name',
            templateCiphertext: 'private unrelated Workflow body',
        })) });
        await db.automationTrigger.createMany({ data: unrelatedIds.map(automationId => ({
            id: randomUUID(), automationId, kind: 'schedule', scheduleKind: 'interval', everyMs: 60_000,
        })) });
        const consent = await db.automation.findFirstOrThrow({ where: { accountId: actorId,
            triggers: { some: { consentForAutomationId: { not: null } } } }, select: { id: true } });
        const statements: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        let resolveBarrier: (() => void) | undefined;
        client.$on('query', event => {
            if (event.query.includes('action_index_cost_barrier')) resolveBarrier?.();
            else statements.push(event);
        });
        await client.$connect();
        const originalTransaction = db.$transaction;
        // Observe the genuine database boundary; projection and admission remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const app = createAuthenticatedTestApp();
        registerAutomationActionIndexRoutes(app);
        try {
            const seed = await app.inject({ method: 'GET', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': actorId } });
            expect(seed.statusCode).toBe(200);
            expect(seed.json().rows).toEqual([expect.objectContaining({ automationId: consent.id })]);
            const response = await app.inject({ method: 'POST', url: '/v1/automations/actions/index',
                headers: { 'x-test-user-id': actorId }, payload: { automationIds: [consent.id], workflowDefinitionIds: [] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().rows).toEqual([expect.objectContaining({ automationId: consent.id })]);
            await Promise.all([client.$queryRaw`SELECT 1 AS "action_index_cost_barrier"`,
                new Promise<void>(resolve => { resolveBarrier = resolve; })]);
            const reads = statements.filter(statement => statement.query.startsWith('SELECT')
                && /"Automation(?:Trigger)?"/.test(statement.query));
            expect(reads.length).toBeGreaterThan(0);
            for (const statement of reads) {
                expect(statement.query).not.toMatch(/"(?:templateCiphertext|definitionEnvelope|name)"/);
                const plan = await client.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
                    ...JSON.parse(statement.params));
                console.info('[action-index-plan]', JSON.stringify({ query: statement.query, params: statement.params,
                    accountId: actorId, automationIds: [consent.id], plan }));
            }
        } finally {
            db.$transaction = originalTransaction;
            await app.close();
            await client.$disconnect();
        }
    });
});
