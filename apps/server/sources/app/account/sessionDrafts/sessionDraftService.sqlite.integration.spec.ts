import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import {
    SESSION_DRAFT_V2_SOCKET_EVENT,
    SessionDraftChangeHintV1Schema,
    SessionDraftPrivatePayloadV2Schema,
} from '@happier-dev/protocol';

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
    listSessionDrafts as listSessionDraftsWithAuthentication,
    decodeSessionDraftContentFromKv,
    matchNewSessionDraftsAccountMigrationPostStateInTx,
    migrateNewSessionDraftsForAccountModeInTx,
    mutateSessionDraft as mutateSessionDraftWithAuthentication,
    readSessionDraft as readSessionDraftWithAuthentication,
    tombstoneSessionDraftForLifecycleInTx,
} from './sessionDraftService';
import { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from './sessionDraftPhysicalKey';

const mutationId = '00000000-0000-4000-8000-000000000001';
const defaultAuthentication = {
    env: process.env,
    authority: 'present_user' as const,
    authenticationEvidence: undefined,
};

type MutateSessionDraftParams = Parameters<typeof mutateSessionDraftWithAuthentication>[0];
function mutateSessionDraft(params: Omit<MutateSessionDraftParams, 'authentication'> & Partial<Pick<MutateSessionDraftParams, 'authentication'>>) {
    return mutateSessionDraftWithAuthentication({ ...params, authentication: params.authentication ?? defaultAuthentication });
}

type ReadSessionDraftParams = Parameters<typeof readSessionDraftWithAuthentication>[0];
function readSessionDraft(params: Omit<ReadSessionDraftParams, 'authentication'> & Partial<Pick<ReadSessionDraftParams, 'authentication'>>) {
    return readSessionDraftWithAuthentication({ ...params, authentication: params.authentication ?? defaultAuthentication });
}

type ListSessionDraftsParams = Parameters<typeof listSessionDraftsWithAuthentication>[0];
function listSessionDrafts(params: Omit<ListSessionDraftsParams, 'authentication'> & Partial<Pick<ListSessionDraftsParams, 'authentication'>>) {
    return listSessionDraftsWithAuthentication({ ...params, authentication: params.authentication ?? defaultAuthentication });
}

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

type SessionDraftAddressV2Fixture =
    | { kind: 'newSession'; draftId: string }
    | { kind: 'session'; sessionId: string }
    | { kind: 'run'; sessionId: string; runId: string }
    | { kind: 'discussion'; sessionId: string; discussionId: string }
    | { kind: 'newDiscussion'; sessionId: string };

function plainContentV2(address: SessionDraftAddressV2Fixture) {
    if (address.kind === 'newSession' || address.kind === 'session') return plainContent(address);
    if (address.kind === 'run') {
        return {
            t: 'plain' as const,
            v: {
                v: 2 as const,
                address,
                document: {
                    v: 1 as const,
                    composer: {
                        text: { mutationId, value: 'run draft' },
                        mentions: { mutationId, value: [] },
                        attachments: { mutationId, value: [] },
                    },
                    target: {
                        kind: 'session' as const,
                        routing: {
                            recipient: {
                                mutationId,
                                value: {
                                    mode: 'manual' as const,
                                    recipient: { kind: 'execution_run' as const, runId: address.runId },
                                },
                            },
                            agentContinuation: { mutationId, value: null },
                            executionRunDelivery: { mutationId, value: null },
                        },
                    },
                    extensions: {},
                },
            },
        };
    }
    return {
        t: 'plain' as const,
        v: {
            v: 2 as const,
            address,
            document: {
                v: 2 as const,
                target: { kind: address.kind },
                composer: {
                    text: { mutationId, value: 'human draft' },
                    mentions: { mutationId, value: [] },
                    attachments: { mutationId, value: [] },
                },
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
        harness.resetEnv();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => harness.close());

    it('keeps Project Open drafts Account-owned across CAS, V1 filtering, Session deletion and mode conversion', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const address = { kind: 'projectOpen' as const, draftId: randomUUID() };
        const document = {
            v: 2, target: { kind: 'projectOpen' },
            selection: { mutationId, value: null }, uncertainInputs: { mutationId, value: [] },
            result: { mutationId, value: null }, retiredAttempt: { mutationId, value: null },
        };
        const content = { t: 'plain' as const, v: SessionDraftPrivatePayloadV2Schema.parse({ v: 2, address, document }) };
        const storedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
        expect(decodeSessionDraftContentFromKv(storedBytes({
            ...content, futureEnvelope: true, v: { ...content.v, futurePayload: true, document: { ...document, futureDocument: true } },
        }))).toEqual(content);
        expect(() => decodeSessionDraftContentFromKv(storedBytes({
            ...content, v: { ...content.v, document: { ...document, uncertainInputs: { mutationId, value: 'invalid' } } },
        }))).toThrow();
        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content, epoch: 'v2' }))
            .toMatchObject({ status: 'updated', record: { revision: 0, content } });
        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content, epoch: 'v2' }))
            .toMatchObject({ status: 'conflict', current: { revision: 0 } });
        expect(await mutateSessionDraft({
            accountId: account.id, address, expectedRevision: 0,
            content: { t: 'encrypted', v: 2, c: 'wrong-Account-mode' }, epoch: 'v2',
        })).toEqual({ status: 'invalidContentMode' });
        expect(await readSessionDraft({ accountId: other.id, address, epoch: 'v2' })).toEqual({ status: 'absent' });
        expect(await listSessionDrafts({ accountId: account.id, epoch: 'v1' })).toEqual({ items: [] });
        expect(await listSessionDrafts({ accountId: account.id, epoch: 'v2', addressKinds: ['projectOpen'] }))
            .toMatchObject({ items: [{ address, content }] });
        expect(await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 0, content: null, epoch: 'v1' }))
            .toEqual({ status: 'epochUnavailable' });
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({ recipientFilter: { type: 'user-scoped-only' } }));
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await inTx(tx => tombstoneSessionDraftForLifecycleInTx(tx, { accountId: account.id, sessionId: session.id }));
        expect(await readSessionDraft({ accountId: account.id, address, epoch: 'v2' })).toMatchObject({ status: 'present' });
        expect(await inTx(tx => migrateNewSessionDraftsForAccountModeInTx(tx, { accountId: account.id, toMode: 'e2ee' })))
            .toEqual({ status: 'requires_upgrade' });
        const directive = { v: 2 as const, items: [{ address, expectedRevision: 0, content: { t: 'encrypted' as const, v: 2 as const, c: 'project-open-ciphertext' } }] };
        expect(await inTx(tx => migrateNewSessionDraftsForAccountModeInTx(tx, { accountId: account.id, toMode: 'e2ee', directive })))
            .toMatchObject({ status: 'applied', records: [{ address, revision: 1 }] });
        expect(await inTx(tx => matchNewSessionDraftsAccountMigrationPostStateInTx(tx, { accountId: account.id, toMode: 'e2ee', directive })))
            .toMatchObject({ status: 'matched', records: [{ address, revision: 1 }] });
        expect(await inTx(tx => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id, toMode: 'plain', directive: { v: 2, items: [{ address, expectedRevision: 1, content }] },
        }))).toMatchObject({ status: 'applied', records: [{ address, revision: 2, content }] });
    });

    it.each(['plain', 'e2ee'] as const)('isolates V2 exact-Machine newSession content from V1 reads, writes, conflicts and hints (%s)', async (encryptionMode) => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const siblingAddress = { kind: 'newSession' as const, draftId: randomUUID() };
        const legacyContent = encryptionMode === 'plain'
            ? plainContent(address)
            : { t: 'encrypted' as const, c: 'legacy-ciphertext' };
        const successorContent = encryptionMode === 'plain'
            ? {
                t: 'plain' as const,
                v: {
                    v: 2,
                    address,
                    document: {
                        ...plainContent(address).v.document,
                        v: 2,
                        target: {
                            kind: 'newSession',
                            authoring: {
                                executionTarget: { mutationId, value: {
                                    kind: 'machine', target: {
                                        serverId: 'home-a', machineId: 'machine-a',
                                    },
                                } },
                            },
                        },
                    },
                },
            }
            : { t: 'encrypted' as const, v: 2, c: 'successor-ciphertext' };
        await mutateSessionDraft({
            accountId: account.id, address: siblingAddress, expectedRevision: 'absent',
            content: encryptionMode === 'plain' ? plainContent(siblingAddress) : legacyContent,
        });
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Fastify authentication is the transport boundary; the real route/service/DB path remains intact.
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Parameters<typeof registerSessionDraftRoutes>[0];
        typed.decorate('authenticate', async (request: { userId: string; authAuthority: 'present_user' }) => {
            request.userId = account.id;
            request.authAuthority = 'present_user';
        });
        registerSessionDraftRoutes(typed);
        await app.ready();
        try {
            const created = await app.inject({
                method: 'POST', url: '/v2/account/session-drafts/mutate',
                payload: { address, expectedRevision: 'absent', content: successorContent },
            });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toMatchObject({ status: 'updated', record: { revision: 0 } });
            const change = await db.accountChange.findFirst({
                where: { accountId: account.id, entityId: `session-draft:new-session/${address.draftId}` },
            });
            expect(change?.hint).toMatchObject({ v: 2, sessionDraftV2: true, address });
            expect(SessionDraftChangeHintV1Schema.safeParse(change?.hint).success).toBe(false);
            expect(emitEphemeral.mock.calls.at(-1)?.[0].payload.type).toBe(SESSION_DRAFT_V2_SOCKET_EVENT);

            const read = await app.inject({ method: 'POST', url: '/v1/account/session-drafts/read', payload: { address } });
            expect(read.statusCode).toBe(409);
            expect(read.json()).toEqual({ error: 'session_draft_epoch_unavailable' });
            const list = await app.inject({ method: 'POST', url: '/v1/account/session-drafts/list', payload: { limit: 1 } });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toMatchObject({ items: [{ address: siblingAddress }] });
            expect(list.json().nextAfter).toBeUndefined();
            for (const expectedRevision of ['absent', 0] as const) {
                const rewrite = await app.inject({
                    method: 'POST', url: '/v1/account/session-drafts/mutate',
                    payload: { address, expectedRevision, content: legacyContent },
                });
                expect(rewrite.statusCode).toBe(409);
                expect(rewrite.json()).toEqual({ error: 'session_draft_epoch_unavailable' });
            }
            const staleDelete = await app.inject({
                method: 'POST', url: '/v1/account/session-drafts/mutate',
                payload: { address, expectedRevision: 'absent', content: null },
            });
            expect(staleDelete.statusCode).toBe(409);
            expect(staleDelete.json()).toEqual({ error: 'session_draft_epoch_unavailable' });
            expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
                accountId: account.id, toMode: 'e2ee', directive: { items: [
                    { address, expectedRevision: 0, content: { t: 'encrypted', c: 'lossy-legacy-migration' } },
                    { address: siblingAddress, expectedRevision: 0, content: { t: 'encrypted', c: 'sibling' } },
                ] },
            }))).toEqual({ status: 'requires_upgrade' });
            const current = await app.inject({ method: 'POST', url: '/v2/account/session-drafts/read', payload: { address } });
            expect(current.json()).toMatchObject({ status: 'present', record: { revision: 0, content: successorContent } });
            const removed = await app.inject({
                method: 'POST', url: '/v1/account/session-drafts/mutate',
                payload: { address, expectedRevision: 0, content: null },
            });
            expect(removed.statusCode).toBe(200);
            expect(removed.json()).toMatchObject({ status: 'updated', record: { content: null, revision: 1 } });
        } finally {
            await app.close();
        }
    });

    it.each(['plain', 'e2ee'] as const)('migrates successor newSession drafts through the capable directive and exact replay (%s)', async (toMode) => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: toMode === 'plain' ? 'e2ee' : 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const plain = {
            t: 'plain' as const,
            v: { v: 2 as const, address, document: {
                ...plainContent(address).v.document, v: 2 as const,
                target: { kind: 'newSession' as const, authoring: {
                    executionTarget: { mutationId, value: {
                        kind: 'temporary_computer', serverId: 'home-a', artifactTarget: 'linux-x64', workspace: { kind: 'endpoint_home' },
                    } },
                } },
            } },
        };
        const encrypted = { t: 'encrypted' as const, v: 2 as const, c: 'successor-ciphertext' };
        const source = toMode === 'plain' ? encrypted : plain;
        const content = toMode === 'plain' ? plain : encrypted;
        await mutateSessionDraft({ accountId: account.id, address, expectedRevision: 'absent', content: source });
        const directive = { v: 2 as const, items: [{ address, expectedRevision: 0, content }] };
        const result = await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, { accountId: account.id, toMode, directive }));
        expect(result).toMatchObject({ status: 'applied', records: [{ address, revision: 1, content }] });
        const replay = await inTx((tx) => matchNewSessionDraftsAccountMigrationPostStateInTx(tx, { accountId: account.id, toMode, directive }));
        expect(replay).toMatchObject({ status: 'matched', records: [{ address, revision: 1, content }] });
        expect(await inTx((tx) => matchNewSessionDraftsAccountMigrationPostStateInTx(tx, {
            accountId: account.id, toMode, directive: { ...directive, items: [{ ...directive.items[0]!, expectedRevision: 1 }] },
        }))).toEqual({ status: 'mismatch' });
    });

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

    it('hides a private draft and refuses writes when its shared Session loses publication or access', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' } });
        const share = await db.sessionShare.create({ data: { sessionId: session.id, sharedWithUserId: recipient.id, sharedByUserId: owner.id, accessLevel: 'view' } });
        const address = { kind: 'session' as const, sessionId: session.id };
        expect(await mutateSessionDraft({ accountId: recipient.id, address, expectedRevision: 'absent', content: plainContent(address) })).toMatchObject({ status: 'updated' });
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: 'legacy_external_unknown' } });
        expect((await listSessionDrafts({ accountId: recipient.id, limit: 10 })).items).toEqual([]);
        expect(await readSessionDraft({ accountId: recipient.id, address })).toEqual({ status: 'absent' });
        expect(await mutateSessionDraft({ accountId: recipient.id, address, expectedRevision: 0, content: null })).toEqual({ status: 'sessionUnavailable' });
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: 'hosted' } });
        await db.sessionShare.delete({ where: { id: share.id } });
        expect((await listSessionDrafts({ accountId: recipient.id, limit: 10 })).items).toEqual([]);
        expect(await readSessionDraft({ accountId: recipient.id, address })).toEqual({ status: 'absent' });
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
        const sessionAddresses = [
            { kind: 'session', sessionId: session.id },
            { kind: 'run', sessionId: session.id, runId: 'run-a' },
            { kind: 'discussion', sessionId: session.id, discussionId: 'discussion-a' },
            { kind: 'newDiscussion', sessionId: session.id },
        ] as const;
        for (const address of sessionAddresses) {
            expect(await mutateSessionDraft({
                accountId: account.id, address, expectedRevision: 'absent', content: plainContentV2(address),
            })).toMatchObject({ status: 'updated' });
        }

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
        for (const address of sessionAddresses) {
            expect(await readSessionDraft({ accountId: account.id, address }))
                .toMatchObject({ record: { revision: 0, content: plainContentV2(address) } });
        }
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
        }))).toMatchObject({ status: 'source_mismatch' });
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
        typed.decorate('authenticate', async (request: any) => {
            request.userId = account.id;
            request.authAuthority = 'present_user';
        });
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

    it('serves run, discussion and new-discussion drafts from the same rows while V1 readers stay isolated', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const sessionAddress = { kind: 'session' as const, sessionId: session.id };
        const runAddress = { kind: 'run' as const, sessionId: session.id, runId: `run-${randomUUID()}` };
        const discussionAddress = { kind: 'discussion' as const, sessionId: session.id, discussionId: `d-${randomUUID()}` };
        const newDiscussionAddress = { kind: 'newDiscussion' as const, sessionId: session.id };

        for (const address of [sessionAddress, runAddress, discussionAddress, newDiscussionAddress]) {
            expect(await mutateSessionDraft({
                accountId: owner.id,
                address,
                expectedRevision: 'absent',
                content: plainContentV2(address),
            })).toMatchObject({ status: 'updated', record: { revision: 0 } });
        }

        expect(await readSessionDraft({ accountId: owner.id, address: runAddress }))
            .toMatchObject({ status: 'present', record: { address: runAddress } });

        const v1List = await listSessionDrafts({ accountId: owner.id, limit: 10 });
        expect(v1List.items.map((item) => item.address)).toEqual([sessionAddress]);
        expect(v1List.nextAfter).toBeUndefined();

        const v2List = await listSessionDrafts({ accountId: owner.id, limit: 10, epoch: 'v2' });
        expect(v2List.items.map((item) => item.address)).toEqual(expect.arrayContaining([
            sessionAddress,
            runAddress,
            discussionAddress,
            newDiscussionAddress,
        ]));
        expect(v2List.items).toHaveLength(4);

        const selected = await listSessionDrafts({
            accountId: owner.id,
            limit: 10,
            epoch: 'v2',
            addressKinds: ['run', 'newDiscussion'],
        });
        expect(selected.items.map((item) => item.address)).toEqual(expect.arrayContaining([
            runAddress,
            newDiscussionAddress,
        ]));
        expect(selected.items).toHaveLength(2);
    });

    it('keeps V1 paging cursors on V1 addresses when V2 rows sort between them', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const sessions = [];
        for (let index = 0; index < 3; index += 1) {
            sessions.push(await db.session.create({
                data: { accountId: owner.id, tag: `s-${index}-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
            }));
        }
        for (const session of sessions) {
            const sessionAddress = { kind: 'session' as const, sessionId: session.id };
            const runAddress = { kind: 'run' as const, sessionId: session.id, runId: 'r1' };
            await mutateSessionDraft({ accountId: owner.id, address: sessionAddress, expectedRevision: 'absent', content: plainContentV2(sessionAddress) });
            await mutateSessionDraft({ accountId: owner.id, address: runAddress, expectedRevision: 'absent', content: plainContentV2(runAddress) });
        }

        const first = await listSessionDrafts({ accountId: owner.id, limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.items.every((item) => item.address.kind === 'session')).toBe(true);
        expect(first.nextAfter).toMatch(/^session\/[^/]+$/);
        const second = await listSessionDrafts({ accountId: owner.id, limit: 2, after: first.nextAfter });
        expect(second.items).toHaveLength(1);
        expect(second.items[0]!.address.kind).toBe('session');
        expect(second.nextAfter).toBeUndefined();
    });

    it('publishes V2-only hints and events that no released V1 reader can parse', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const runAddress = { kind: 'run' as const, sessionId: session.id, runId: 'r1' };
        emitEphemeral.mockClear();
        await mutateSessionDraft({
            accountId: owner.id,
            address: runAddress,
            expectedRevision: 'absent',
            content: plainContentV2(runAddress),
        });

        const change = await db.accountChange.findFirst({ where: { accountId: owner.id, kind: 'account' } });
        expect(change).toMatchObject({
            entityId: `session-draft:session/${session.id}/run/r1`,
            hint: expect.objectContaining({ v: 2, sessionDraftV2: true, revision: 0, status: 'present' }),
        });
        expect(SessionDraftChangeHintV1Schema.safeParse(change!.hint).success).toBe(false);
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(emitEphemeral.mock.calls[0]![0].payload).toMatchObject({
            type: SESSION_DRAFT_V2_SOCKET_EVENT,
            sessionDraftV2: true,
        });
        expect(emitEphemeral.mock.calls[0]![0].recipientFilter).toEqual({
            type: 'all-interested-in-session',
            sessionId: session.id,
        });
    });

    it.each(['team', 'group'] as const)('uses current %s access for private V2 drafts and rejects revoked membership', async (grantKind) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        });
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        const team = await db.team.create({ data: { name: 'Draft access' } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: actor.id, role: grantKind === 'group' ? 'guest' : 'member',
        } });
        if (grantKind === 'team') {
            await db.sessionTeamGrant.create({ data: { teamId: team.id, sessionId: session.id, effectiveAt: new Date() } });
        } else {
            const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Authors', nameKey: 'authors' } });
            await db.teamGroupMembership.create({ data: {
                teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
            } });
            await db.sessionGroupGrant.create({ data: { teamGroupId: group.id, sessionId: session.id, effectiveAt: new Date() } });
        }
        const address = { kind: 'run' as const, sessionId: session.id, runId: 'run-a' };
        expect(await mutateSessionDraft({
            accountId: actor.id, address, expectedRevision: 'absent', content: plainContentV2(address),
        })).toMatchObject({ status: 'updated', record: { revision: 0 } });
        expect(await readSessionDraft({ accountId: actor.id, address })).toMatchObject({ status: 'present' });
        expect((await listSessionDrafts({ accountId: actor.id, epoch: 'v2' })).items.map(item => item.address))
            .toContainEqual(address);
        expect(await readSessionDraft({ accountId: owner.id, address })).toEqual({ status: 'absent' });
        await db.teamMembership.delete({ where: { id: membership.id } });
        expect(await readSessionDraft({ accountId: actor.id, address })).toEqual({ status: 'absent' });
        expect(await mutateSessionDraft({
            accountId: actor.id, address, expectedRevision: 0, content: null,
        })).toEqual({ status: 'sessionUnavailable' });
    });

    it('qualifies restricted Team draft read, list, and mutation with the exact credential', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        });
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        // `key_challenge` is a keyed factor, so only an e2ee Account can hold it
        // (`effectiveAccountLoginMethods` matches the Account's own mode). A plain
        // actor could never satisfy this Team, which is not what is under test.
        const actor = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const team = await db.team.create({ data: {
            name: 'Restricted drafts',
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }] },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
        await db.sessionTeamGrant.create({ data: { teamId: team.id, sessionId: session.id, effectiveAt: new Date() } });
        const address = { kind: 'run' as const, sessionId: session.id, runId: 'qualified-run' };
        const authentication = {
            env: process.env,
            authority: 'present_user' as const,
            authenticationEvidence: [{ kind: 'home_method' as const, methodId: 'key_challenge' }],
        };
        expect(await mutateSessionDraft({
            accountId: actor.id,
            address,
            expectedRevision: 'absent',
            content: plainContentV2(address),
            authentication: { ...authentication, authenticationEvidence: [] },
        })).toEqual({ status: 'sessionUnavailable' });
        expect(await mutateSessionDraft({
            accountId: actor.id,
            address,
            expectedRevision: 'absent',
            content: plainContentV2(address),
            authentication,
        })).toMatchObject({ status: 'updated' });
        expect(await readSessionDraft({ accountId: actor.id, address, authentication })).toMatchObject({ status: 'present' });
        expect((await listSessionDrafts({ accountId: actor.id, epoch: 'v2', authentication })).items.map(item => item.address))
            .toContainEqual(address);
        expect(await readSessionDraft({
            accountId: actor.id,
            address,
            authentication: { ...authentication, authenticationEvidence: [] },
        })).toEqual({ status: 'absent' });
    });

    it('qualifies each granting Team separately so one satisfied credential cannot list another restricted Team draft', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        });
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        // `key_challenge` is a keyed factor, so only an e2ee Account can hold it
        // (`effectiveAccountLoginMethods` matches the Account's own mode). A plain
        // actor could never satisfy this Team, which is not what is under test.
        const actor = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'e2ee' } });
        const createGrantedSession = async (team: { id: string }) => {
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
            await db.sessionTeamGrant.create({ data: { teamId: team.id, sessionId: session.id, effectiveAt: new Date() } });
            return session;
        };
        const openTeam = await db.team.create({ data: { name: 'Open drafts' } });
        const restrictedTeam = await db.team.create({ data: {
            name: 'Restricted drafts',
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }] },
        } });
        const openSession = await createGrantedSession(openTeam);
        const restrictedSession = await createGrantedSession(restrictedTeam);
        const openAddress = { kind: 'run' as const, sessionId: openSession.id, runId: 'open-run' };
        const restrictedAddress = { kind: 'run' as const, sessionId: restrictedSession.id, runId: 'restricted-run' };
        const qualified = {
            env: process.env,
            authority: 'present_user' as const,
            authenticationEvidence: [{ kind: 'home_method' as const, methodId: 'key_challenge' }],
        };
        const unqualified = { ...qualified, authenticationEvidence: [] };

        for (const address of [openAddress, restrictedAddress]) {
            expect(await mutateSessionDraft({
                accountId: actor.id, address, expectedRevision: 'absent',
                content: plainContentV2(address), authentication: qualified,
            })).toMatchObject({ status: 'updated' });
        }
        // The open Team stays satisfied without the restricted credential, so a
        // per-Team decision must still withhold the restricted Team's draft
        // rather than admitting every Team once any one of them qualifies.
        expect((await listSessionDrafts({ accountId: actor.id, epoch: 'v2', authentication: unqualified })).items
            .map(item => item.address)).toEqual([openAddress]);
        expect(await readSessionDraft({ accountId: actor.id, address: restrictedAddress, authentication: unqualified }))
            .toEqual({ status: 'absent' });
        expect(await mutateSessionDraft({
            accountId: actor.id, address: restrictedAddress, expectedRevision: 0,
            content: null, authentication: unqualified,
        })).toEqual({ status: 'sessionUnavailable' });

        expect((await listSessionDrafts({ accountId: actor.id, epoch: 'v2', authentication: qualified })).items
            .map(item => item.address)).toEqual(expect.arrayContaining([openAddress, restrictedAddress]));
    });

    it('binds a run draft payload to its own run and refuses inaccessible V2 Sessions', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const runAddress = { kind: 'run' as const, sessionId: session.id, runId: 'r1' };

        expect(await mutateSessionDraft({
            accountId: owner.id,
            address: runAddress,
            expectedRevision: 'absent',
            content: plainContentV2({ kind: 'run', sessionId: session.id, runId: 'r2' }),
        })).toEqual({ status: 'invalidAddressBinding' });
        expect(await mutateSessionDraft({
            accountId: owner.id,
            address: runAddress,
            expectedRevision: 'absent',
            content: { t: 'encrypted', c: 'opaque' },
        })).toEqual({ status: 'invalidContentMode' });
        expect(await mutateSessionDraft({
            accountId: other.id,
            address: runAddress,
            expectedRevision: 'absent',
            content: plainContentV2(runAddress),
        })).toEqual({ status: 'sessionUnavailable' });
        expect(await readSessionDraft({ accountId: other.id, address: runAddress })).toEqual({ status: 'absent' });
    });

    it('refuses an unrepresentable V2 address instead of truncating it into another row', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const runAddress = { kind: 'run' as const, sessionId: session.id, runId: 'r'.repeat(191) };
        expect(await mutateSessionDraft({
            accountId: owner.id,
            address: runAddress,
            expectedRevision: 'absent',
            content: plainContentV2(runAddress),
        })).toEqual({ status: 'sessionUnavailable' });
        expect(await readSessionDraft({ accountId: owner.id, address: runAddress })).toEqual({ status: 'absent' });
    });

    it('tombstones every V2 address of the deleted Session without touching a sibling Session prefix', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const sibling = await db.session.create({
            data: { accountId: owner.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const addresses = [
            { kind: 'session' as const, sessionId: session.id },
            { kind: 'run' as const, sessionId: session.id, runId: 'r1' },
            { kind: 'discussion' as const, sessionId: session.id, discussionId: 'd1' },
            { kind: 'newDiscussion' as const, sessionId: session.id },
        ];
        const siblingAddress = { kind: 'run' as const, sessionId: sibling.id, runId: 'r1' };
        for (const address of [...addresses, siblingAddress]) {
            await mutateSessionDraft({ accountId: owner.id, address, expectedRevision: 'absent', content: plainContentV2(address) });
        }

        expect(await inTx((tx) => tombstoneSessionDraftForLifecycleInTx(tx, {
            accountId: owner.id,
            sessionId: session.id,
        }))).toBe(true);
        for (const address of addresses) {
            expect(await readSessionDraft({ accountId: owner.id, address }))
                .toMatchObject({ status: 'deleted', record: { revision: 1 } });
        }
        expect(await readSessionDraft({ accountId: owner.id, address: siblingAddress }))
            .toMatchObject({ status: 'present', record: { revision: 0 } });
    });

    it('excludes V2 Session-bound rows from the Account encryption-mode transition', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const newAddress = { kind: 'newSession' as const, draftId: randomUUID() };
        const runAddress = { kind: 'run' as const, sessionId: session.id, runId: 'r1' };
        await mutateSessionDraft({ accountId: account.id, address: newAddress, expectedRevision: 'absent', content: plainContent(newAddress) });
        await mutateSessionDraft({ accountId: account.id, address: runAddress, expectedRevision: 'absent', content: plainContentV2(runAddress) });

        expect(await inTx((tx) => migrateNewSessionDraftsForAccountModeInTx(tx, {
            accountId: account.id,
            toMode: 'e2ee',
            directive: {
                items: [{ address: newAddress, expectedRevision: 0, content: { t: 'encrypted', c: 'migrated' } }],
            },
        }))).toMatchObject({ status: 'applied', records: [{ address: newAddress, revision: 1 }] });
        expect(await readSessionDraft({ accountId: account.id, address: runAddress }))
            .toMatchObject({ record: { revision: 0, content: { t: 'plain' } } });
    });

    it('registers the V2 route epoch and keeps V2 addresses unrepresentable on V1 routes', async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain' },
        });
        const runAddress = { kind: 'run' as const, sessionId: session.id, runId: 'r1' };
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => {
            request.userId = account.id;
            request.authAuthority = 'present_user';
        });
        registerSessionDraftRoutes(typed);
        await app.ready();

        const v1Mutate = await app.inject({
            method: 'POST',
            url: '/v1/account/session-drafts/mutate',
            payload: { address: runAddress, expectedRevision: 'absent', content: plainContentV2(runAddress) },
        });
        expect(v1Mutate.statusCode).not.toBe(200);
        expect(await readSessionDraft({ accountId: account.id, address: runAddress }))
            .toEqual({ status: 'absent' });

        const v2Mutate = await app.inject({
            method: 'POST',
            url: '/v2/account/session-drafts/mutate',
            payload: { address: runAddress, expectedRevision: 'absent', content: plainContentV2(runAddress) },
        });
        expect(v2Mutate.statusCode).toBe(200);
        expect(v2Mutate.json()).toMatchObject({ status: 'updated', record: { revision: 0 } });
        expect((await app.inject({
            method: 'POST',
            url: '/v2/account/session-drafts/read',
            payload: { address: runAddress },
        })).json()).toMatchObject({ status: 'present' });
        expect((await app.inject({
            method: 'POST',
            url: '/v2/account/session-drafts/list',
            payload: { limit: 10, addressKinds: ['run'] },
        })).json().items).toHaveLength(1);
        expect((await app.inject({
            method: 'POST',
            url: '/v1/account/session-drafts/list',
            payload: { limit: 10 },
        })).json().items).toEqual([]);
        await app.close();
    });
});
