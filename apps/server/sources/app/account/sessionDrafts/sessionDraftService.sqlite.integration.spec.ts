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

import { inTx } from '@/storage/inTx';
import { AccountScopedKvReservedKeyError } from '@/app/kv/accountScopedKv';
import { kvGet } from '@/app/kv/kvGet';
import { registerSessionDraftRoutes } from './registerSessionDraftRoutes';
import {
    listSessionDrafts,
    matchNewSessionDraftsAccountMigrationPostStateInTx,
    migrateNewSessionDraftsForAccountModeInTx,
    mutateSessionDraft,
    readSessionDraft,
    tombstoneSessionDraftForLifecycleInTx,
} from './sessionDraftService';
import { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from './sessionDraftPhysicalKey';

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

        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) }))
            .toMatchObject({ status: 'updated', record: { revision: 0 } });
        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) }))
            .toMatchObject({ status: 'conflict', current: { revision: 0 } });
        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 0, content: null }))
            .toMatchObject({ status: 'updated', record: { revision: 1, content: null } });
        expect(await readSessionDraft({ accountId: account.id, address }))
            .toMatchObject({ status: 'deleted', record: { revision: 1 } });
        expect((await listSessionDrafts({ accountId: account.id, limit: 10 })).items).toEqual([]);
        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 1, content: plainContent(address) }))
            .toMatchObject({ status: 'updated', record: { revision: 2 } });

        expect(await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'account' } })).toMatchObject({
            entityId: expect.stringContaining('session-draft:new-session/'),
            hint: expect.objectContaining({ sessionDraft: true, revision: 2, status: 'present' }),
        });
        expect(emitEphemeral).toHaveBeenCalledTimes(3);
    });

    it('keeps reserved rows unreachable through generic KV', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: plainContent(address) });
        await expect(kvGet({ uid: account.id }, `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}new-session/${address.draftId}`))
            .rejects.toBeInstanceOf(AccountScopedKvReservedKeyError);
    });

    it('rejects inaccessible Sessions, wrong modes, and substituted plain addresses', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const address = { kind: 'session' as const, sessionId: session.id };

        expect(await mutateSessionDraft({ accountId: other.id, address, expectedRevision: 'absent', content: plainContent(address) }))
            .toEqual({ status: 'sessionUnavailable' });
        expect(await mutateSessionDraft({
            accountId: owner.id,
            address,
            expectedRevision: 'absent',
            content: { t: 'encrypted', c: 'opaque' },
        })).toEqual({ status: 'invalidContentMode' });
        expect(await mutateSessionDraft({
            accountId: owner.id,
            address,
            expectedRevision: 'absent',
            content: plainContent({ kind: 'session', sessionId: `${session.id}-other` }),
        })).toEqual({ status: 'invalidAddressBinding' });
    });

    it('CAS-tombstones an existing Session draft in a lifecycle transaction', async () => {
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
        expect(await readSessionDraft({ accountId: owner.id, address }))
            .toMatchObject({ status: 'deleted', record: { revision: 1 } });
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it('atomically migrates complete new-session coverage and excludes Session-owned drafts', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' },
        });
        const newAddress = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({
            accountId: account.id,
            address: newAddress,
            expectedRevision: 'absent',
            content: plainContent(newAddress),
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const sessionAddress = { kind: 'session' as const, sessionId: session.id };
        await mutateSessionDraft({
            accountId: account.id,
            address: sessionAddress,
            expectedRevision: 'absent',
            content: plainContent(sessionAddress),
        });

        expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id,
            toMode: 'e2ee',
            directive: {
                items: [{
                    address: newAddress,
                    expectedRevision: 0,
                    content: { t: 'encrypted', c: 'migrated-new-session-draft' },
                }],
            },
        }))).toMatchObject({
            status: 'applied',
            records: [{ address: newAddress, revision: 1 }],
        });
        expect(await readSessionDraft({ accountId: account.id, address: newAddress }))
            .toMatchObject({ record: { revision: 1, content: { t: 'encrypted' } } });
        expect(await readSessionDraft({ accountId: account.id, address: sessionAddress }))
            .toMatchObject({ record: { revision: 0, content: { t: 'plain' } } });
        expect(await inTx((tx) => matchNewSessionDraftsAccountMigrationPostStateInTx(tx, {
            accountId: account.id,
            toMode: 'e2ee',
            directive: {
                items: [{
                    address: newAddress,
                    expectedRevision: 0,
                    content: { t: 'encrypted', c: 'migrated-new-session-draft' },
                }],
            },
        }))).toMatchObject({
            status: 'matched',
            records: [{ address: newAddress, revision: 1 }],
        });
        expect(await inTx((tx) => matchNewSessionDraftsAccountMigrationPostStateInTx(tx, {
            accountId: account.id,
            toMode: 'e2ee',
        }))).toEqual({ status: 'requires_upgrade' });
    });

    it('fails closed on omitted, incomplete, stale, or address-substituted Account migration coverage', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' },
        });
        const addressA = { kind: 'newSession' as const, draftId: randomUUID() };
        const addressB = { kind: 'newSession' as const, draftId: randomUUID() };
        await mutateSessionDraft({ accountId: account.id, address: addressA, expectedRevision: 'absent', content: plainContent(addressA) });
        await mutateSessionDraft({ accountId: account.id, address: addressB, expectedRevision: 'absent', content: plainContent(addressB) });

        expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id,
            toMode: 'plain',
        }))).toEqual({ status: 'requires_upgrade' });
        expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id,
            toMode: 'plain',
            directive: { items: [{ address: addressA, expectedRevision: 0, content: plainContent(addressA) }] },
        }))).toEqual({ status: 'migration_incomplete' });
        expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id,
            toMode: 'plain',
            directive: { items: [
                { address: addressA, expectedRevision: 9, content: plainContent(addressA) },
                { address: addressB, expectedRevision: 0, content: plainContent(addressB) },
            ] },
        }))).toEqual({ status: 'source_mismatch' });
        expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id,
            toMode: 'plain',
            directive: { items: [
                { address: addressA, expectedRevision: 0, content: plainContent(addressB) },
                { address: addressB, expectedRevision: 0, content: plainContent(addressB) },
            ] },
        }))).toEqual({ status: 'migration_incomplete' });
        expect(await readSessionDraft({ accountId: account.id, address: addressA }))
            .toMatchObject({ record: { revision: 0 } });
        expect(await readSessionDraft({ accountId: account.id, address: addressB }))
            .toMatchObject({ record: { revision: 0 } });
    });

    it('registers the authenticated typed route contract', async () => {
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
        expect((await app.inject({
            method: 'POST',
            url: '/v1/account/session-drafts/list',
            payload: { limit: 10 },
        })).json().items).toHaveLength(1);
        await app.close();
    });
});
