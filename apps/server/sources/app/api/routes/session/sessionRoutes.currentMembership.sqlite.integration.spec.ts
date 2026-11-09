import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

import { db } from "@/storage/db";
import { withSqliteReadSnapshot } from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { inspectSessionAccessGrants } from "@/app/session/access/sessionAccessGrantInspection";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { V2SessionListResponseSchema, V2SessionRecordSchema, projectSessionDisplayV1,
    sealSessionSharedDisplayEnvelopeV1Sync, sealSessionOwnerDisplayEnvelopeV1 } from '@happier-dev/protocol';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

type Deferred = Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}>;

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function expectBarrierEnteredBeforeResponse(
    barrier: Readonly<{ reached: Promise<void> }>,
    response: Promise<unknown>,
): Promise<void> {
    await expect(Promise.race([
        barrier.reached.then(() => "barrier-entered" as const),
        response.then(() => "response-completed" as const),
    ])).resolves.toBe("barrier-entered");
}

async function installPauseBeforeReadTransaction(): Promise<Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}>> {
    const reached = deferred();
    const release = deferred();
    const originalTransaction = db.$transaction;
    // Capture the real storage-owned client, without replacing the snapshot
    // owner or any access logic. BEGIN is the same boundary as $transaction.
    const snapshotReader = await withSqliteReadSnapshot(async reader => reader);
    const originalSnapshotExecute = snapshotReader.$executeRawUnsafe.bind(snapshotReader);
    let paused = false;
    let restored = false;

    db.$transaction = (async (...args: unknown[]) => {
        if (!paused && typeof args[0] === "function") {
            paused = true;
            reached.resolve();
            await release.promise;
        }
        return await Reflect.apply(originalTransaction, undefined, args);
    }) as typeof db.$transaction;
    Object.defineProperty(snapshotReader, "$executeRawUnsafe", {
        configurable: true,
        writable: true,
        value: async (query: string, ...values: unknown[]) => {
            if (!paused && query === "BEGIN DEFERRED;") {
                paused = true;
                reached.resolve();
                await release.promise;
            }
            return await Reflect.apply(originalSnapshotExecute, snapshotReader, [query, ...values]);
        },
    });

    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            db.$transaction = originalTransaction;
            Object.defineProperty(snapshotReader, "$executeRawUnsafe", {
                configurable: true,
                writable: true,
                value: originalSnapshotExecute,
            });
        },
    };
}

async function installPauseBeforeModelRead(input: Readonly<{
    model: "sessionTurn";
    method: "findMany";
} | {
    model: "sessionMessage";
    method: "findFirst" | "findMany";
}> & Readonly<{ after?: true }>): Promise<Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}>> {
    const reached = deferred();
    const release = deferred();
    const directDelegate = db[input.model];
    // Prisma delegates are the real database boundary; preserve their receiver.
    const originalDirectRead = (Reflect.get(directDelegate, input.method) as Function).bind(directDelegate);
    const snapshotReader = await withSqliteReadSnapshot(async reader => reader);
    const snapshotDelegate = snapshotReader[input.model];
    const originalSnapshotRead = (Reflect.get(snapshotDelegate, input.method) as Function).bind(snapshotDelegate);
    const originalTransaction = db.$transaction;
    let paused = false;
    let restored = false;

    const pause = async (): Promise<void> => {
        if (paused) return;
        paused = true;
        reached.resolve();
        await release.promise;
    };

    Object.defineProperty(directDelegate, input.method, {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => {
            if (!input.after) await pause();
            const result = await Reflect.apply(originalDirectRead, directDelegate, args);
            if (input.after) await pause();
            return result;
        },
    });
    Object.defineProperty(snapshotDelegate, input.method, {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => {
            if (!input.after) await pause();
            const result = await Reflect.apply(originalSnapshotRead, snapshotDelegate, args);
            if (input.after) await pause();
            return result;
        },
    });
    db.$transaction = (async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") {
            return await Reflect.apply(originalTransaction, undefined, args);
        }

        return await Reflect.apply(originalTransaction, undefined, [
            async (tx: object) => {
                const transactionDelegate = Reflect.get(tx, input.model) as object;
                const originalRead = Reflect.get(transactionDelegate, input.method) as Function;
                const wrappedDelegate = new Proxy(transactionDelegate, {
                    get(target, property, receiver) {
                        if (property !== input.method) return Reflect.get(target, property, receiver);
                        return async (...readArgs: unknown[]) => {
                            if (!input.after) await pause();
                            const result = await Reflect.apply(originalRead, target, readArgs);
                            if (input.after) await pause();
                            return result;
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === input.model) return wrappedDelegate;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            ...args.slice(1),
        ]);
    }) as typeof db.$transaction;

    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            Object.defineProperty(directDelegate, input.method, {
                configurable: true,
                writable: true,
                value: originalDirectRead,
            });
            Object.defineProperty(snapshotDelegate, input.method, {
                configurable: true,
                writable: true,
                value: originalSnapshotRead,
            });
            db.$transaction = originalTransaction;
        },
    };
}

async function createSharedSessionFixture(encryptionMode: 'plain' | 'e2ee' = 'plain'): Promise<Readonly<{
    ownerId: string;
    collaboratorId: string;
    sessionId: string;
    messageId: string;
    localId: string;
    observedRevision: string;
}>> {
    const owner = await db.account.create({
        data: encryptionMode === 'e2ee' ? { ...createSignedAccountContentBinding(), encryptionMode }
            : { publicKey: `pk-current-member-owner-${crypto.randomUUID()}`, encryptionMode },
        select: { id: true },
    });
    const collaborator = await db.account.create({
        data: encryptionMode === 'e2ee' ? { ...createSignedAccountContentBinding(), encryptionMode }
            : { publicKey: `pk-current-member-collaborator-${crypto.randomUUID()}`, encryptionMode },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            tag: `current-member-${crypto.randomUUID()}`,
            accountId: owner.id,
            encryptionMode,
            metadata: encryptionMode === 'plain' ? JSON.stringify({ t: "plain", v: {} }) : 'encrypted-metadata',
            agentState: null,
        },
        select: { id: true },
    });
    await db.sessionShare.create({
        data: {
            sessionId: session.id,
            sharedByUserId: owner.id,
            sharedWithUserId: collaborator.id,
            accessLevel: "view",
        },
    });
    const message = await db.sessionMessage.create({
        data: {
            sessionId: session.id,
            localId: "input-1",
            seq: 1,
            messageRole: "user",
            content: encryptionMode === 'e2ee' ? { t: 'encrypted', c: 'encrypted-transcript-original' } : {
                t: "plain",
                v: {
                    role: "user",
                    content: { type: "text", text: "private transcript content" },
                },
            },
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: collaborator.id,
                sessionRelationship: "sharedEditor",
            },
        },
        select: { id: true, updatedAt: true },
    });
    await db.sessionTurn.create({
        data: {
            sessionId: session.id,
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 2n,
        },
    });

    return {
        ownerId: owner.id,
        collaboratorId: collaborator.id,
        sessionId: session.id,
        messageId: message.id,
        localId: "input-1",
        observedRevision: `message-updated-at:${message.updatedAt.getTime()}`,
    };
}

async function revokeShare(params: Readonly<{ sessionId: string; collaboratorId: string }>): Promise<void> {
    await db.sessionShare.delete({
        where: {
            sessionId_sharedWithUserId: {
                sessionId: params.sessionId,
                sharedWithUserId: params.collaboratorId,
            },
        },
    });
}

describe("sessionRoutes current shared-participant reads (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-current-participant-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('retains an admitted manager roster and observes capability downgrade on the next inspection', async () => {
        const fixture = await createSharedSessionFixture();
        const share = { sessionId_sharedWithUserId: { sessionId: fixture.sessionId, sharedWithUserId: fixture.collaboratorId } };
        await db.sessionShare.update({ where: share, data: { accessLevel: 'admin' } });
        const params = { actorAccountId: fixture.collaboratorId, sessionId: fixture.sessionId,
            authentication: createPresentUserSessionAccessAuthentication() };
        expect(await inspectSessionAccessGrants(params)).toMatchObject({ ok: true, value: { visibility: 'complete' } });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findUniqueOrThrow.bind(delegate);
        const reached = deferred();
        const release = deferred();
        let paused = false;
        Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused && args[0]?.select?.shares) { paused = true; reached.resolve(); await release.promise; }
                return await original(...args);
            } });
        const response = inspectSessionAccessGrants(params);
        try {
            await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
            await db.sessionShare.update({ where: share, data: { accessLevel: 'view' } });
            release.resolve();
            const result = await response;
            expect(await inspectSessionAccessGrants(params)).toMatchObject({ ok: true, value: { visibility: 'self', grants: [] } });
            expect(result).toMatchObject({ ok: true, value: { visibility: 'complete' } });
        } finally {
            release.resolve(); await response;
            Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true, value: original });
        }
    });

    it.each(['downgraded', 'revoked'] as const)('retains admitted recipient access until the next inspection after its grant is %s', async (scenario) => {
        const fixture = await createSharedSessionFixture();
        const share = { sessionId_sharedWithUserId: { sessionId: fixture.sessionId, sharedWithUserId: fixture.collaboratorId } };
        await db.sessionShare.update({ where: share, data: { accessLevel: 'edit' } });
        const params = { actorAccountId: fixture.ownerId, sessionId: fixture.sessionId,
            recipientAccountId: fixture.collaboratorId, authentication: createPresentUserSessionAccessAuthentication() };
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findUniqueOrThrow.bind(delegate);
        const reached = deferred();
        const release = deferred();
        let paused = false;
        Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused && args[0]?.select?.shares) { paused = true; reached.resolve(); await release.promise; }
                return await original(...args);
            } });
        const response = inspectSessionAccessGrants(params);
        try {
            await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
            if (scenario === 'revoked') await revokeShare(fixture);
            else await db.sessionShare.update({ where: share, data: { accessLevel: 'view' } });
            release.resolve();
            expect(await response).toMatchObject({ ok: true, value: { visibility: 'complete', recipientAccess: {
                accountId: fixture.collaboratorId,
                effectiveAccess: { level: 'edit', capabilities: { readTranscript: true, submitAgentInput: true } },
            } } });
            expect(await inspectSessionAccessGrants(params)).toMatchObject({ ok: true, value: { visibility: 'complete', recipientAccess: {
                accountId: fixture.collaboratorId,
                effectiveAccess: scenario === 'revoked' ? null : { level: 'view', capabilities: { readTranscript: true, submitAgentInput: false } },
            } } });
        } finally {
            release.resolve(); await response;
            Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true, value: original });
        }
    });

    it.each(['owner', 'mode mismatch', 'revoked'] as const)('applies initial detail admission through the route (%s)', async (scenario) => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        if (scenario !== 'owner') await db.account.update({ where: { id: fixture.ownerId }, data: { encryptionMode: 'e2ee' } });
        if (scenario === 'revoked') await revokeShare(fixture);
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const response = await app.inject({ method: 'GET',
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': scenario === 'revoked' ? fixture.collaboratorId : fixture.ownerId,
                    'x-happier-account-stored-content-protocol': '4' } });
            expect(response.statusCode, response.body).toBe(scenario === 'owner' ? 200 : scenario === 'mode mismatch' ? 409 : 404);
        });
    });

    it.each(['plain', 'e2ee'] as const)('captures %s owner session detail once with no later admission and one ciphertext scan', async (accountMode) => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: accountMode,
        } });
        const ciphertext = 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==';
        const ownerMetadata = accountMode === 'plain'
            ? { t: 'plain', v: { v: 1 } } : { t: 'encrypted', c: ciphertext };
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify(ownerMetadata),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const execute = reader.$executeRawUnsafe.bind(reader);
            const findUnique = reader.session.findUnique.bind(reader.session);
            const findMany = reader.session.findMany.bind(reader.session);
            const findAccount = reader.account.findUnique.bind(reader.account);
            const findAccounts = reader.account.findMany.bind(reader.account);
            let phase = -1;
            const confirmationReads: string[] = [];
            // Observe real persistent-database calls, without replacing admission
            // or content projection. Any second BEGIN would be a re-admission.
            Object.defineProperty(reader, '$executeRawUnsafe', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof execute>) => {
                    if (args[0] === 'BEGIN DEFERRED;') phase++;
                    return await execute(...args);
                } });
            Object.defineProperty(reader.session, 'findUnique', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findUnique>) => {
                    if (phase === 1) confirmationReads.push('findUnique');
                    return await findUnique(...args);
                } });
            Object.defineProperty(reader.session, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findMany>) => {
                    if (phase === 1) confirmationReads.push('findMany');
                    return await findMany(...args);
                } });
            Object.defineProperty(reader.account, 'findUnique', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findAccount>) => {
                    if (phase === 1) confirmationReads.push('account.findUnique');
                    return await findAccount(...args);
                } });
            Object.defineProperty(reader.account, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findAccounts>) => {
                    if (phase === 1) confirmationReads.push('account.findMany');
                    return await findAccounts(...args);
                } });
            const scan = vi.spyOn(String.prototype, 'charCodeAt');
            try {
                const result = await app.inject({ method: 'GET',
                    url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                    headers: { 'x-test-user-id': fixture.ownerId, 'x-happier-account-stored-content-protocol': '4' } });
                expect(result.statusCode).toBe(200);
                expect(result.json().session).toMatchObject({ id: fixture.sessionId,
                    effectiveAccess: { level: 'owner' }, ownerMetadata });
                expect(confirmationReads).toHaveLength(0);
                expect(phase).toBe(0);
                expect(scan.mock.contexts.filter(value => value === ciphertext).length)
                    .toBe(accountMode === 'e2ee' ? ciphertext.length - 2 : 0);
            } finally {
                scan.mockRestore();
                Object.defineProperty(reader, '$executeRawUnsafe', { configurable: true, writable: true, value: execute });
                Object.defineProperty(reader.session, 'findUnique', { configurable: true, writable: true, value: findUnique });
                Object.defineProperty(reader.session, 'findMany', { configurable: true, writable: true, value: findMany });
                Object.defineProperty(reader.account, 'findUnique', { configurable: true, writable: true, value: findAccount });
                Object.defineProperty(reader.account, 'findMany', { configurable: true, writable: true, value: findAccounts });
            }
        });
    });

    it.each([
        { methodId: 'key_challenge', statusCode: 403, error: 'team_authentication_required' },
        { methodId: 'missing-method', statusCode: 503, error: 'team_authentication_unavailable' },
    ])('retains admitted Team detail and applies authentication denial ($statusCode) on the next request', async ({ methodId, statusCode, error }) => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' });
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.account.update({ where: { id: fixture.collaboratorId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'e2ee',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        await revokeShare(fixture);
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: fixture.collaboratorId, role: 'member', sessionAccessStartsAt: null,
        } });
        const grant = await db.sessionTeamGrant.create({ data: {
            sessionId: fixture.sessionId, teamId: team.id, accessLevel: 'view', effectiveAt: new Date(),
        } });
        try {
            await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
                const reader = await withSqliteReadSnapshot(async tx => tx);
                const original = reader.session.findMany.bind(reader.session);
                const reached = deferred();
                const release = deferred();
                let paused = false;
                Object.defineProperty(reader.session, 'findMany', { configurable: true, writable: true,
                    value: async (...args: Parameters<typeof original>) => {
                        const row = await original(...args);
                        if (!paused && args[0]?.select?.metadata === true) {
                            paused = true; reached.resolve(); await release.promise;
                        }
                        return row;
                    } });
                const request = { method: 'GET' as const,
                    url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                    headers: { 'x-test-user-id': fixture.collaboratorId,
                        'x-happier-account-stored-content-protocol': '4' } };
                const response = app.inject(request);
                try {
                    await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
                    await db.team.update({ where: { id: team.id }, data: {
                        authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId }] },
                    } });
                    release.resolve();
                    const result = await response;
                    expect(result.statusCode, result.body).toBe(200);
                    const current = await app.inject(request);
                    expect(current.statusCode, current.body).toBe(statusCode);
                    expect(current.json()).toEqual({ error });
                } finally {
                    release.resolve(); await response;
                    Object.defineProperty(reader.session, 'findMany', { configurable: true, writable: true, value: original });
                }
            });
        } finally {
            await db.sessionTeamGrant.delete({ where: { sessionId_teamId: { sessionId: grant.sessionId, teamId: grant.teamId } } });
            await db.teamMembership.delete({ where: { id: membership.id } });
            await db.team.delete({ where: { id: team.id } });
        }
    });

    it('finishes admitted metadata disclosure and refuses the next request after share revocation', async () => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.session;
            const original = delegate.findMany.bind(delegate);
            const reached = deferred();
            const release = deferred();
            let paused = false;
            // Keep the real admission query and pause only once its snapshot is pinned.
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const result = await original(...args);
                    if (!paused && args[0]?.select?.metadata === true) {
                        paused = true; reached.resolve(); await release.promise;
                    }
                    return result;
                } });
            const request = { method: 'GET' as const,
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': fixture.collaboratorId, 'x-happier-account-stored-content-protocol': '4' } };
            const response = app.inject(request);
            try {
                await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
                await revokeShare(fixture);
                release.resolve();
                const result = await response;
                expect((await app.inject(request)).statusCode).toBe(404);
                expect(result.statusCode).toBe(200);
                expect(result.json()).toMatchObject({ session: { id: fixture.sessionId } });
            } finally {
                release.resolve(); await response;
                Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('retains admitted owner metadata and refuses mismatched Account mode on the next request', async () => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const request = { method: 'GET' as const,
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': fixture.ownerId, 'x-happier-account-stored-content-protocol': '4' } };
            expect((await app.inject(request)).statusCode).toBe(200);
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.session;
            const original = delegate.findMany.bind(delegate);
            const reached = deferred();
            const release = deferred();
            let paused = false;
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const result = await original(...args);
                    if (!paused && args[0]?.select?.metadata === true) {
                        paused = true; reached.resolve(); await release.promise;
                    }
                    return result;
                } });
            const response = app.inject(request);
            try {
                await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
                await db.account.update({ where: { id: fixture.ownerId }, data: { encryptionMode: 'e2ee' } });
                release.resolve();
                const result = await response;
                expect((await app.inject(request)).statusCode).toBe(409);
                expect(result.statusCode).toBe(200);
                expect(result.json()).toMatchObject({ session: { id: fixture.sessionId } });
            } finally {
                release.resolve(); await response;
                Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
            }
        });
    });

    it.each([['plain', 'e2ee'], ['e2ee', 'plain']] as const)(
        'uses current %s to %s Account mode on the next display request', async (fromMode, toMode) => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: fromMode,
        } });
        const ownerMetadata = { v: 1 as const, workspace: { name: 'Mode-bound private display' } };
        const sharedMetadata = { v: 1 as const, summary: { text: 'Mode-neutral shared display', updatedAt: 0 } };
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
        const randomBytes = (length: number) => new Uint8Array(length).fill(4);
        const encryptedOwner = sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material, randomBytes });
        const plainOwner = { t: 'plain' as const, v: ownerMetadata };
        const semantic = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        const shared = sealSessionSharedDisplayEnvelopeV1Sync({
            sessionMode: 'plain', display: semantic.shared });
        const owner = sealSessionOwnerDisplayEnvelopeV1({
            accountMode: fromMode, display: semantic.owner!, material, randomBytes });
        if (!shared.ok || !owner.ok) throw new Error('Canonical mode-bound display producer failed');
        const displayProjectionV1 = { v: 1 as const, sourceMetadataVersion: 0, metadataLayoutVersion: 1 as const,
            shared: shared.envelope, owner: owner.envelope };
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify(sharedMetadata),
            ownerMetadata: JSON.stringify(fromMode === 'plain' ? plainOwner : encryptedOwner),
            displayProjectionV1: JSON.stringify(displayProjectionV1),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const headers = { 'x-test-user-id': fixture.ownerId, 'x-happier-account-stored-content-protocol': '4' };
            const list = await app.inject({ method: 'GET', url: '/v2/sessions?limit=50', headers });
            expect(list.statusCode, list.body).toBe(200);
            const captured = V2SessionListResponseSchema.parse(list.json()).sessions.find(row => row.id === fixture.sessionId);
            if (!captured) throw new Error('Expected captured compact owner row');
            expect(captured.displayProjectionV1).toEqual(displayProjectionV1);
            const detail = await app.inject({ method: 'GET', url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`, headers });
            expect(detail.statusCode, detail.body).toBe(200);
            V2SessionRecordSchema.parse(detail.json().session);
            // Persist the valid atomic post-transition state at the database
            // boundary; the next route request must consume the new projection.
            const { owner: _owner, ...sharedOnly } = displayProjectionV1;
            await db.$transaction([
                db.account.update({ where: { id: fixture.ownerId }, data: { encryptionMode: toMode } }),
                db.session.update({ where: { id: fixture.sessionId }, data: {
                    ownerMetadata: JSON.stringify(toMode === 'plain' ? plainOwner : encryptedOwner),
                    displayProjectionV1: JSON.stringify(sharedOnly),
                } }),
            ]);
            const current = await app.inject({ method: 'GET', url: '/v2/sessions?limit=50', headers });
            expect(current.statusCode, current.body).toBe(200);
            const row = V2SessionListResponseSchema.parse(current.json()).sessions.find(row => row.id === fixture.sessionId);
            expect(row?.displayProjectionV1).toEqual(sharedOnly);
            expect(JSON.stringify(row)).not.toContain('Mode-bound private display');
        });
    });

    it("returns only the server-derived coarse actor for an eligible external-shareable page", async () => {
        const fixture = await createSharedSessionFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/messages?projection=externalShareableV1&afterSeq=0`,
                    headers: { "x-test-user-id": fixture.collaboratorId },
                });

                expect(response.statusCode).toBe(200);
                const message = response.json().messages[0];
                expect(message).toMatchObject({
                    id: fixture.messageId,
                    externalShareableActor: "collaborator",
                });
                expect(message).not.toHaveProperty("inputAdmissionReceipt");
                expect(JSON.stringify(response.json())).not.toContain(fixture.collaboratorId);
                expect(JSON.stringify(response.json())).not.toContain("sharedEditor");
            },
        );
    });

    it("keeps authenticated Account authorship when a public caller supplies the retired transcript-only hint", async () => {
        const fixture = await createSharedSessionFixture();
        await db.sessionShare.update({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: fixture.sessionId,
                    sharedWithUserId: fixture.collaboratorId,
                },
            },
            data: { accessLevel: "edit" },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${fixture.sessionId}/messages`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": fixture.collaboratorId,
                    },
                    payload: {
                        content: {
                            t: "plain",
                            v: { role: "user", content: { type: "text", text: "voice transcript" } },
                        },
                        localId: "voice-transcript-1",
                        messageRole: "user",
                        transcriptOnly: true,
                    },
                });

                expect(response.statusCode, response.body).toBe(200);
            },
        );

        expect(await db.sessionMessage.findUniqueOrThrow({
            where: {
                sessionId_localId: {
                    sessionId: fixture.sessionId,
                    localId: "voice-transcript-1",
                },
            },
            select: { authorAccountId: true, inputAdmissionReceipt: true },
        })).toEqual({
            authorAccountId: fixture.collaboratorId,
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: fixture.collaboratorId,
                sessionRelationship: "sharedEditor",
            },
        });
    });

    it("does not page messages after a collaborator share is revoked before the deciding transaction", async () => {
        const fixture = await createSharedSessionFixture();
        const reached = deferred();
        const release = deferred();
        const barrier = { reached: reached.promise, release: release.resolve };

        try {
            await withAuthenticatedTestApp(
                (app) => {
                    // Pause the real authentication boundary before the route opens its
                    // read snapshot. The database and access decisions remain real.
                    const authenticate = app.authenticate;
                    app.authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
                        await authenticate(request, reply);
                        reached.resolve();
                        await release.promise;
                    };
                    sessionRoutes(app);
                },
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v1/sessions/${fixture.sessionId}/messages?projection=externalShareableV1&afterSeq=0`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.release();
        }
    });

    it("does not resolve a local message after a collaborator share is revoked before the deciding transaction", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v2/sessions/${fixture.sessionId}/messages/by-local-id/${fixture.localId}`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("returns unavailable rather than deleted or available after a share is revoked before action-reference lookup", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "POST",
                        url: `/v1/sessions/${fixture.sessionId}/messages/action-reference/resolve`,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": fixture.collaboratorId,
                        },
                        payload: {
                            v: 1,
                            sessionId: fixture.sessionId,
                            messageId: fixture.messageId,
                            observedRevision: fixture.observedRevision,
                        },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(200);
                    expect(response.json()).toEqual({ status: "unavailable" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("does not project turns after a collaborator share is revoked before the deciding turn query", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeModelRead({ model: "sessionTurn", method: "findMany" });

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v1/sessions/${fixture.sessionId}/turns`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it.each([
        ["local message", "findFirst", "GET", "local", 'plain'],
        ["action reference", "findFirst", "POST", "reference", 'plain'],
        ["message page", "findMany", "GET", "page", 'plain'],
        ["local message", "findFirst", "GET", "local", 'e2ee'],
        ["action reference", "findFirst", "POST", "reference", 'e2ee'],
        ["message page", "findMany", "GET", "page", 'e2ee'],
    ] as const)("finishes a captured %s after revocation and refuses the next request (%s %s %s %s)", async (_name, method, httpMethod, route, encryptionMode) => {
        const fixture = await createSharedSessionFixture(encryptionMode);
        const barrier = await installPauseBeforeModelRead({ model: "sessionMessage", method, after: true });
        const url = route === "local"
            ? `/v2/sessions/${fixture.sessionId}/messages/by-local-id/${fixture.localId}`
            : route === "reference"
                ? `/v1/sessions/${fixture.sessionId}/messages/action-reference/resolve`
                : `/v1/sessions/${fixture.sessionId}/messages?afterSeq=0`;
        try {
            await withAuthenticatedTestApp(
                app => sessionRoutes(app),
                async app => {
                    const request = {
                        method: httpMethod,
                        url,
                        headers: { "x-test-user-id": fixture.collaboratorId, 'x-happier-account-stored-content-protocol': '4' },
                        ...(route === "reference" ? { payload: {
                            v: 1,
                            sessionId: fixture.sessionId,
                            messageId: fixture.messageId,
                            observedRevision: fixture.observedRevision,
                        } } : {}),
                    };
                    const responsePromise = app.inject(request);
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();
                    const response = await responsePromise;
                    expect(response.statusCode).toBe(200);
                    expect(response.json()).toMatchObject(route === 'reference' ? { status: 'available' }
                        : route === 'local' ? { message: { id: fixture.messageId } }
                            : { messages: [{ id: fixture.messageId }] });
                    const next = await app.inject(request);
                    expect(next.statusCode).toBe(route === 'reference' ? 200 : 404);
                    expect(next.json()).toEqual(route === 'reference'
                        ? { status: 'unavailable' } : { error: 'Session not found' });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it.each([
        ["owner", (fixture: Awaited<ReturnType<typeof createSharedSessionFixture>>) => fixture.ownerId],
        ["shared recipient", (fixture: Awaited<ReturnType<typeof createSharedSessionFixture>>) => fixture.collaboratorId],
    ])("keeps the %s turns projection at the server publication ceiling without a client projection query", async (_recipient, resolveUserId) => {
        const fixture = await createSharedSessionFixture();
        const publicationObservedAt = 1_700_000_000_000;
        const privateUpdatedAt = new Date(publicationObservedAt + 60_000);
        await db.sessionTurn.update({
            where: {
                sessionId_turnId: {
                    sessionId: fixture.sessionId,
                    turnId: "turn-1",
                },
            },
            data: {
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 1,
                    userMessageSeqs: [1],
                    startSeqInclusive: 1,
                    endSeqInclusive: 1,
                    finalAssistantMessageSeq: 1,
                }),
            },
        });
        await db.sessionTurn.create({
            data: {
                sessionId: fixture.sessionId,
                turnId: "turn-private-tail",
                status: "completed",
                startedAt: 2n,
                updatedAt: 3n,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 2,
                    userMessageSeqs: [2],
                    startSeqInclusive: 2,
                    endSeqInclusive: 2,
                    finalAssistantMessageSeq: 2,
                }),
            },
        });
        await db.session.update({
            where: { id: fixture.sessionId },
            data: {
                seq: 2,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 2,
                materializationPublicationId: "publication-current-membership",
                materializedThroughSourceAt: BigInt(publicationObservedAt),
                publishedThroughServerSeq: 1,
                latestTurnId: "turn-private-tail",
                updatedAt: privateUpdatedAt,
            },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/turns`,
                    headers: { "x-test-user-id": resolveUserId(fixture) },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({
                    v: 1,
                    sessionId: fixture.sessionId,
                    updatedAt: publicationObservedAt,
                    turns: [expect.objectContaining({ turnId: "turn-1" })],
                });
            },
        );
    });

    it("rejects the retired external-shareable turns projection", async () => {
        const fixture = await createSharedSessionFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/turns?projection=externalShareableV1`,
                    headers: { "x-test-user-id": fixture.collaboratorId },
                });

                expect(response.statusCode).toBe(400);
            },
        );
    });
});
