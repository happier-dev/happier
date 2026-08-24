import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const { emitEphemeral } = vi.hoisted(() => ({ emitEphemeral: vi.fn() }));
vi.mock('@/app/events/eventRouter', async () => {
    const actual = await vi.importActual<typeof import('@/app/events/eventRouter')>('@/app/events/eventRouter');
    return { ...actual, eventRouter: { ...actual.eventRouter, emitEphemeral } };
});

import {
    listSessionDrafts,
    mutateSessionDraft,
    readSessionDraft,
    tombstoneSessionDraftForLifecycleInTx,
} from './sessionDraftService';
import { inTx } from '@/storage/inTx';
import { registerSessionDraftRoutes } from './registerSessionDraftRoutes';
import { registerAccountEncryptionMigrateRoutes } from '@/app/api/routes/account/registerAccountEncryptionMigrateRoutes';
import { kvBulkGet } from '@/app/kv/kvBulkGet';
import { kvGet } from '@/app/kv/kvGet';
import { kvList } from '@/app/kv/kvList';
import { kvMutate } from '@/app/kv/kvMutate';
import { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from '@/app/kv/reservedAccountScopedKvRow';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';

const mutationId = '00000000-0000-4000-8000-000000000001';

function plainContent(address: { kind: 'newSession'; draftId: string } | { kind: 'session'; sessionId: string }) {
    return {
        t: 'plain' as const,
        v: {
            v: 1 as const,
            address,
            document: {
                v: 1 as const,
                composer: {
                    text: { mutationId, value: 'draft' },
                    mentions: { mutationId, value: [] },
                    attachments: { mutationId, value: [] },
                },
                target: address.kind === 'newSession'
                    ? { kind: 'newSession' as const, authoring: {} }
                    : {
                        kind: 'session' as const,
                        routing: {
                            recipient: { mutationId, value: null },
                            agentContinuation: { mutationId, value: null },
                            executionRunDelivery: { mutationId, value: null },
                        },
                    },
                extensions: {},
            },
        },
    };
}

describe('sessionDraftService (SQLite integration)', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-drafts-' });
    }, 120_000);

    afterEach(async () => {
        emitEphemeral.mockClear();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => harness.close());

    it('owns create, conflict, tombstone, recreate, exact read and active-only paging over UserKVStore', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };

        const created = await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });
        expect(created).toMatchObject({ status: 'updated', record: { revision: 0, content: { t: 'plain' } } });

        const conflict = await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });
        expect(conflict).toMatchObject({ status: 'conflict', current: { revision: 0 } });

        const deleted = await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 0, content: null });
        expect(deleted).toMatchObject({ status: 'updated', record: { revision: 1, content: null } });
        expect(await readSessionDraft({ accountId: account.id, address })).toMatchObject({ status: 'deleted', record: { revision: 1 } });
        expect((await listSessionDrafts({ accountId: account.id, limit: 10 })).items).toEqual([]);

        const recreated = await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 1, content: plainContent(address) });
        expect(recreated).toMatchObject({ status: 'updated', record: { revision: 2 } });
        expect((await listSessionDrafts({ accountId: account.id, limit: 1 })).items).toHaveLength(1);

        expect(await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account' } })).toMatchObject({
            entityId: expect.stringContaining('session-draft:new-session/'),
            hint: expect.objectContaining({ sessionDraft: true, revision: 2, status: 'present' }),
        });
        expect(emitEphemeral).toHaveBeenCalledTimes(3);
    });

    it('keeps reserved draft rows unreachable through the generic Account KV API', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });
        const reservedKey = `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}new-session/${address.draftId}`;

        expect(await kvGet({ uid: account.id }, reservedKey)).toBeNull();
        expect(await kvBulkGet({ uid: account.id }, [reservedKey])).toEqual({ values: [] });
        expect(await kvList({ uid: account.id })).toEqual({ items: [] });
        expect(await kvMutate({ uid: account.id }, [{ key: reservedKey, value: null, version: 0 }])).toEqual({
            success: false,
            errors: [{ key: reservedKey, error: 'reserved-key', version: -1, value: null }],
        });
    });

    it('isolates Accounts and rejects inaccessible or wrong-mode Session content', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'e2ee' },
        });
        const address = { kind: 'session' as const, sessionId: session.id };

        expect(await mutateSessionDraft({ accountId: other.id, address, expectedRevision: 'absent', content: { t: 'encrypted', c: 'opaque' } }))
            .toEqual({ status: 'sessionUnavailable' });
        expect(await mutateSessionDraft({ accountId: owner.id, address, expectedRevision: 'absent', content: plainContent(address) }))
            .toEqual({ status: 'invalidContentMode' });

        const written = await mutateSessionDraft({
            accountId: owner.id,
            address,
            expectedRevision: 'absent',
            content: { t: 'encrypted', c: 'opaque' },
        });
        expect(written).toMatchObject({ status: 'updated' });
        expect(await readSessionDraft({ accountId: other.id, address })).toEqual({ status: 'absent' });
    });

    it('rejects a plain private payload whose bound address differs from the mutation address', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const differentAddress = { kind: 'newSession' as const, draftId: randomUUID() };

        expect(await mutateSessionDraft({
            accountId: account.id,
            address,
            expectedRevision: 'absent',
            content: plainContent(differentAddress),
        })).toEqual({ status: 'invalidAddressBinding' });
        expect(await readSessionDraft({ accountId: account.id, address })).toEqual({ status: 'absent' });
    });

    it('CAS-tombstones an existing-session draft inside its canonical delete/revocation transaction', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const address = { kind: 'session' as const, sessionId: session.id };
        await mutateSessionDraft({ accountId: owner.id, address, expectedRevision: 'absent', content: plainContent(address) });
        emitEphemeral.mockClear();

        expect(await inTx((tx) => tombstoneSessionDraftForLifecycleInTx(tx, {
            accountId: owner.id,
            sessionId: session.id,
        }))).toBe(true);
        expect(await readSessionDraft({ accountId: owner.id, address })).toMatchObject({
            status: 'deleted',
            record: { revision: 1, content: null },
        });
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it('treats a legacy Session id outside the draft persistence bound as having no possible draft row', async () => {
        expect(await inTx((tx) => tombstoneSessionDraftForLifecycleInTx(tx, {
            accountId: 'account-not-used',
            sessionId: 'ä'.repeat(25),
        }))).toBe(false);
    });

    it('registers the authenticated typed read/list/mutate API contract', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = account.id; });
        registerSessionDraftRoutes(typed);
        await app.ready();

        const mutate = await app.inject({
            method: 'POST',
            url: '/v1/account/session-drafts/mutate',
            payload: { address, expectedRevision: 'absent', content: plainContent(address) },
        });
        expect(mutate.statusCode).toBe(200);
        expect(mutate.json()).toMatchObject({ status: 'updated', record: { revision: 0 } });

        const read = await app.inject({ method: 'POST', url: '/v1/account/session-drafts/read', payload: { address } });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toMatchObject({ status: 'present', record: { address } });

        const list = await app.inject({ method: 'POST', url: '/v1/account/session-drafts/list', payload: { limit: 10 } });
        expect(list.statusCode).toBe(200);
        expect(list.json().items).toHaveLength(1);
        await app.close();
    });

    it('fails the typed routes closed when the server feature is explicitly disabled', async () => {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = 'account-not-used'; });
        registerSessionDraftRoutes(createServerFeatureGatedRouteApp(typed, 'sessions.drafts', {
            HAPPIER_FEATURE_SESSIONS_DRAFTS__ENABLED: '0',
        }));
        await app.ready();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/session-drafts/list',
            payload: { limit: 10 },
        });
        expect(response.statusCode).toBe(404);
        await app.close();
    });

    it('requires capable Account-mode migration coverage when live new-session drafts exist', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        });
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });

        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = account.id; });
        registerAccountEncryptionMigrateRoutes(typed);
        await app.ready();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/encryption/migrate',
            payload: {
                toMode: 'plain',
                expectedSettingsVersion: 0,
                settingsContent: null,
                connectedServices: { action: 'assert_empty' },
                automations: { action: 'assert_empty' },
            },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'session_drafts_require_upgrade' });
        await app.close();
    });

    it('atomically migrates complete new-session draft coverage with the Account mode request', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        });
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });
        const existingSession = await db.session.create({
            data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'e2ee' },
        });
        const existingSessionAddress = { kind: 'session' as const, sessionId: existingSession.id };
        await mutateSessionDraft({
            accountId: account.id,
            address: existingSessionAddress,
            expectedRevision: 'absent',
            content: { t: 'encrypted', c: 'opaque-existing-session-draft' },
        });
        const nextContent = plainContent(address);
        nextContent.v.document.composer.text.value = 'migrated';

        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = account.id; });
        registerAccountEncryptionMigrateRoutes(typed);
        await app.ready();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/encryption/migrate',
            payload: {
                toMode: 'plain',
                expectedSettingsVersion: 0,
                settingsContent: null,
                connectedServices: { action: 'assert_empty' },
                automations: { action: 'assert_empty' },
                sessionDrafts: { items: [{ address, expectedRevision: 0, content: nextContent }] },
            },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            sessionDrafts: { records: [{ address, revision: 1 }] },
        });
        expect(await readSessionDraft({ accountId: account.id, address })).toMatchObject({
            status: 'present',
            record: { revision: 1, content: { t: 'plain', v: { document: { composer: { text: { value: 'migrated' } } } } } },
        });
        expect(await readSessionDraft({ accountId: account.id, address: existingSessionAddress })).toMatchObject({
            status: 'present',
            record: { revision: 0, content: { t: 'encrypted', c: 'opaque-existing-session-draft' } },
        });
        await app.close();
    });

    it('rejects incomplete and stale draft migration coverage without changing Account or draft revisions', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        });
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const addressA = { kind: 'newSession' as const, draftId: randomUUID() };
        const addressB = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address: addressA, expectedRevision: 'absent', content: plainContent(addressA) });
        await mutateSessionDraft({ accountId: account.id, address: addressB, expectedRevision: 'absent', content: plainContent(addressB) });

        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = account.id; });
        registerAccountEncryptionMigrateRoutes(typed);
        await app.ready();
        const base = {
            toMode: 'plain',
            expectedSettingsVersion: 0,
            settingsContent: null,
            connectedServices: { action: 'assert_empty' },
            automations: { action: 'assert_empty' },
        };
        const incomplete = await app.inject({
            method: 'POST', url: '/v1/account/encryption/migrate',
            payload: { ...base, sessionDrafts: { items: [{ address: addressA, expectedRevision: 0, content: plainContent(addressA) }] } },
        });
        expect(incomplete.statusCode).toBe(400);
        expect(incomplete.json()).toEqual({ error: 'session_drafts_migration_incomplete' });

        const stale = await app.inject({
            method: 'POST', url: '/v1/account/encryption/migrate',
            payload: { ...base, sessionDrafts: { items: [
                { address: addressA, expectedRevision: 9, content: plainContent(addressA) },
                { address: addressB, expectedRevision: 0, content: plainContent(addressB) },
            ] } },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: 'session_drafts_version_mismatch', address: addressA, currentRevision: 0 });
        expect(await db.account.findUnique({ where: { id: account.id }, select: { settingsVersion: true } })).toEqual({ settingsVersion: 0 });
        expect(await readSessionDraft({ accountId: account.id, address: addressA })).toMatchObject({ record: { revision: 0 } });
        expect(await readSessionDraft({ accountId: account.id, address: addressB })).toMatchObject({ record: { revision: 0 } });
        await app.close();
    });

    it('rejects Account migration content bound to a different draft address without changing revisions', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        });
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const differentAddress = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });

        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = account.id; });
        registerAccountEncryptionMigrateRoutes(typed);
        await app.ready();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/encryption/migrate',
            payload: {
                toMode: 'plain',
                expectedSettingsVersion: 0,
                settingsContent: null,
                connectedServices: { action: 'assert_empty' },
                automations: { action: 'assert_empty' },
                sessionDrafts: { items: [{
                    address,
                    expectedRevision: 0,
                    content: plainContent(differentAddress),
                }] },
            },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'session_drafts_migration_incomplete' });
        expect(await db.account.findUnique({ where: { id: account.id }, select: { settingsVersion: true } })).toEqual({ settingsVersion: 0 });
        expect(await readSessionDraft({ accountId: account.id, address })).toMatchObject({ record: { revision: 0 } });
        await app.close();
    });
});
