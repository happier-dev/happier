import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";
import { createAuthenticatedFakeSocket } from "../../testkit/socketHarness";
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createSessionInputAttentionObserver } from '../../../../../../cli/src/session/services/sessionInputAttention';
import { deriveActivitySummaryFromAgentState } from '../../../../../../cli/src/api/session/deriveActivitySummaryFromAgentState';

const PLAIN_OWNER_METADATA = { t: "plain", v: { v: 1 } } as const;
const ENCRYPTED_OWNER_METADATA = {
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
} as const;
const LEGACY_METADATA = JSON.stringify({});
const LEGACY_AGENT_STATE = JSON.stringify({});
const SHARED_METADATA = JSON.stringify({ v: 1 });

describe("session owner metadata migration route (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-owner-migration-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
    });

    afterEach(async () => {
        eventRouter.clearIo();
        vi.restoreAllMocks();
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'account' } }),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('pushes native approval and decision counts from the HTTP tuple to the Session input observer', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: SHARED_METADATA,
            ownerMetadata: JSON.stringify(PLAIN_OWNER_METADATA),
        } });
        const attention: boolean[] = [];
        const observer = createSessionInputAttentionObserver({ token: 'unused', sessionId: session.id,
            onAttentionRequired: async required => { attention.push(required); } });
        const updates: unknown[] = [];
        const socket = createAuthenticatedFakeSocket({ id: 'workflow-input-observer', data: {
            userId: owner.id, clientType: 'session-scoped', sessionId: session.id,
            authAuthority: 'present_user',
        } });
        // Only Socket.IO delivery is replaced; HTTP admission, tuple CAS,
        // recipient projection and credential-qualified delivery remain real.
        eventRouter.setIo({
            in: () => ({ fetchSockets: async () => [socket] }),
            to: () => ({ emit: (event, value) => {
                if (event !== 'update') return;
                const update = UpdateContainerSchema.parse(value);
                if (update.body.t !== 'update-session') return;
                updates.push(update.body);
                observer.onSessionUpdate(update.body);
            }, disconnectSockets: () => {} }),
        });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async (app: FastifyInstance) => {
            const approval = { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'pwd' }, createdAt: 2 };
            for (const [version, pending] of [true, false].entries()) {
                const state = { requests: { 'exec-native': approval }, ...(pending ? {} : {
                    completedRequests: { 'exec-native': { ...approval, status: 'approved' as const, completedAt: 3 } },
                }) };
                const payload = { mode: 'owner', metadataLayoutVersion: 1,
                    expectedOwnerMetadata: PLAIN_OWNER_METADATA, ownerMetadata: PLAIN_OWNER_METADATA,
                    sharedMetadata: { ciphertext: SHARED_METADATA, expectedVersion: version },
                    agentState: { ciphertext: JSON.stringify(state), expectedVersion: version },
                    activitySummaryV1: deriveActivitySummaryFromAgentState(state) };
                const patch = () => app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`,
                    headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '2' }, payload });
                const response = await patch();
                expect(response.statusCode, response.body).toBe(200);
                await expect(db.session.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
                    pendingPermissionRequestCount: pending ? 1 : 0, pendingUserActionRequestCount: 0,
                });
                await vi.waitFor(() => expect(updates).toHaveLength(version + 1));
                expect(updates.at(-1)).toMatchObject({ pendingPermissionRequestCount: pending ? 1 : 0,
                    pendingUserActionRequestCount: 0, pendingRequestObservedAt: pending ? 2 : null });
                await observer.publish();
                expect(attention).toEqual(pending ? [true] : [true, false]);
                expect((await patch()).statusCode).toBe(200);
                expect(updates).toHaveLength(version + 1);
            }
        });
    });

    it('admits an HTTP owner patch once before its tuple receipt', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: 'shared-ciphertext',
            ownerMetadata: JSON.stringify(ENCRYPTED_OWNER_METADATA), metadataVersion: 0, agentStateVersion: 0 } });
        const target = { t: 'encrypted', c: 'oRoBAGMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==' } as const;
        const scan = vi.spyOn(String.prototype, 'charCodeAt');
        let scansAtReceipt: number | undefined;
        await withAuthenticatedTestApp(app => {
            app.addHook('onSend', async () => {
                scansAtReceipt = scan.mock.contexts.filter(value => value === target.c).length;
            });
            sessionRoutes(app);
        }, async (app: FastifyInstance) => {
            const response = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`,
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '2' },
                payload: { mode: 'owner', metadataLayoutVersion: 1,
                    expectedOwnerMetadata: ENCRYPTED_OWNER_METADATA, ownerMetadata: target,
                    sharedMetadata: { ciphertext: 'shared-ciphertext', expectedVersion: 0 },
                    agentState: { ciphertext: null, expectedVersion: 0 } } });
            expect(response.statusCode, response.body).toBe(200);
            expect(scansAtReceipt).toBe(target.c.length - 2);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ ownerMetadata: JSON.stringify(target) });
        });
    });

    it.each(["read_failure", "layout_migration"] as const)("acknowledges a committed legacy patch before postcommit publication %s", async failure => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: LEGACY_METADATA, metadataLayoutVersion: 0, metadataVersion: 4,
        } });
        let enterPublication!: () => void;
        let releasePublication!: () => void;
        let settlePublication!: () => void;
        const entered = new Promise<void>(resolve => { enterPublication = resolve; });
        const release = new Promise<void>(resolve => { releasePublication = resolve; });
        const settled = new Promise<void>(resolve => { settlePublication = resolve; });
        const delegate = db.session;
        const originalFindUnique = delegate.findUnique;
        const findUnique = originalFindUnique.bind(delegate);
        // Hold only the postcommit storage read; admission, CAS, cursor writes
        // and HTTP response serialization retain their production owners.
        // Prisma delegates are proxies: installing a method spy also registers
        // a later global restore that can erase the next case's real delegate.
        delegate.findUnique = new Proxy(originalFindUnique, {
            apply(_target, _thisArg, argumentsList) {
                const [args] = argumentsList as Parameters<typeof delegate.findUnique>;
                if (args.where.id === session.id && args.select?.accountId
                    && args.select.metadata && args.select.ownerMetadata && !args.select.active) {
                    enterPublication();
                    return release.then(async () => {
                        try {
                            if (failure === "read_failure") throw new Error("Publication database unavailable");
                            return await findUnique(args);
                        } finally {
                            settlePublication();
                        }
                    });
                }
                return findUnique(args);
            },
        });
        try {
            await withAuthenticatedTestApp(app => sessionRoutes(app), async (app: FastifyInstance) => {
                let status: number | undefined;
                const response = app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`,
                    headers: { "x-test-user-id": owner.id },
                    payload: { metadata: { ciphertext: JSON.stringify({ name: "committed" }), expectedVersion: 4 } },
                }).then((result: LightMyRequestResponse) => { status = result.statusCode; return result; });
                await entered;
                try {
                    await expect(findUnique({ where: { id: session.id } })).resolves.toMatchObject({
                        metadataVersion: 5, metadata: JSON.stringify({ name: "committed" }),
                    });
                    await expect.poll(() => status).toBe(200);
                    expect((await response).json()).toEqual({ success: true, metadata: { version: 5 } });
                    if (failure === "layout_migration") {
                        // A later real migration makes the legacy publication
                        // projection inadmissible; it cannot undo this receipt.
                        await db.session.update({ where: { id: session.id }, data: {
                            metadataLayoutVersion: 1, metadata: SHARED_METADATA,
                            ownerMetadata: JSON.stringify(PLAIN_OWNER_METADATA),
                        } });
                    }
                } finally {
                    releasePublication();
                    await settled;
                    await response;
                }
            });
        } finally {
            releasePublication();
            delegate.findUnique = originalFindUnique;
        }
    });

    it("sends the committed tuple receipt before entering the realtime network boundary", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadataLayoutVersion: 1, metadata: SHARED_METADATA,
            ownerMetadata: JSON.stringify(PLAIN_OWNER_METADATA),
        } });
        let receiptSent = false;
        let receiptSentAtPublication: boolean | undefined;
        // Only Socket.IO's network adapter is substituted. The real publisher
        // and credential-qualified event router still select the destination.
        eventRouter.setIo({
            to: () => ({ emit: () => {}, disconnectSockets: () => {} }),
            in: rooms => ({ fetchSockets: async () => {
                if (rooms.includes(`session:${session.id}:${owner.id}`)) {
                    receiptSentAtPublication = receiptSent;
                }
                return [];
            } }),
        });
        await withAuthenticatedTestApp(app => {
            app.addHook("onSend", async () => { receiptSent = true; });
            sessionRoutes(app);
        }, async (app: FastifyInstance) => {
            const response = await app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`,
                headers: { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" },
                payload: { mode: "owner", metadataLayoutVersion: 1,
                    expectedOwnerMetadata: PLAIN_OWNER_METADATA, ownerMetadata: PLAIN_OWNER_METADATA,
                    sharedMetadata: { ciphertext: SHARED_METADATA, expectedVersion: 0 },
                    agentState: { ciphertext: null, expectedVersion: 0 } },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: 1 }, agentState: { version: 0 } });
            expect(receiptSentAtPublication).toBe(true);
            await expect(db.session.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
                metadataVersion: 1, agentStateVersion: 0,
            });
        });
    });

    it.each([0, 1] as const)("does not acknowledge a layout-%s metadata write that rolls back", async layout => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadataLayoutVersion: layout, metadata: layout === 0 ? LEGACY_METADATA : SHARED_METADATA,
            ownerMetadata: layout === 0 ? null : JSON.stringify(PLAIN_OWNER_METADATA),
        } });
        const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const changesBefore = await db.accountChange.count({ where: { accountId: owner.id } });
        await db.$executeRawUnsafe(`CREATE TRIGGER reject_metadata_patch BEFORE UPDATE OF metadata ON Session
            BEGIN SELECT RAISE(ABORT, 'test metadata write failure'); END`);
        try {
            await withAuthenticatedTestApp(app => sessionRoutes(app), async (app: FastifyInstance) => {
                const response = await app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`,
                    headers: { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" },
                    payload: layout === 0
                        ? { metadata: { ciphertext: JSON.stringify({ name: "must roll back" }), expectedVersion: 0 } }
                        : { mode: "owner", metadataLayoutVersion: 1,
                            expectedOwnerMetadata: PLAIN_OWNER_METADATA, ownerMetadata: PLAIN_OWNER_METADATA,
                            sharedMetadata: { ciphertext: SHARED_METADATA, expectedVersion: 0 },
                            agentState: { ciphertext: null, expectedVersion: 0 } },
                });
                expect(response.statusCode, response.body).toBe(500);
            });
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER reject_metadata_patch");
        }
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id } })).resolves.toEqual(before);
        await expect(db.accountChange.count({ where: { accountId: owner.id } })).resolves.toBe(changesBefore);
    });

    it("atomically migrates the exact plain layout-zero tuple to canonical layout one", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-frozen-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 0,
                metadata: LEGACY_METADATA,
                metadataVersion: 4,
                ownerMetadata: null,
                agentState: LEGACY_AGENT_STATE,
                agentStateVersion: 7,
            },
            select: { id: true },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const payload = {
                    mode: "owner_migration",
                    expectedAccountEncryptionMode: "plain",
                    expectedAccountContentPublicKeyFingerprint: null,
                    source: {
                        metadataLayoutVersion: 0,
                        metadata: {
                            version: 4,
                            ciphertext: LEGACY_METADATA,
                        },
                        ownerMetadata: null,
                        agentState: {
                            version: 7,
                            ciphertext: LEGACY_AGENT_STATE,
                        },
                    },
                    target: {
                        metadataLayoutVersion: 1,
                        sharedMetadata: {
                            ciphertext: SHARED_METADATA,
                        },
                        ownerMetadata: PLAIN_OWNER_METADATA,
                        agentState: {
                            ciphertext: LEGACY_AGENT_STATE,
                        },
                    },
                } as const;
                const inject = (requestPayload: object) => app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: requestPayload,
                });

                const response = await inject(payload);
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual({
                    success: true,
                    metadataLayoutVersion: 1,
                    sharedMetadata: { version: 5 },
                    agentState: { version: 8 },
                });

                const afterFirstWrite =
                    await db.session.findUniqueOrThrow({
                        where: { id: session.id },
                    });
                const changesAfterFirst =
                    await db.accountChange.count({
                        where: { accountId: owner.id },
                    });
                expect(changesAfterFirst).toBeGreaterThan(
                    changesBefore,
                );

                const emitUpdate = vi.spyOn(
                    eventRouter,
                    "emitUpdate",
                );
                const replay = await inject(payload);
                expect(replay.statusCode, replay.body).toBe(200);
                expect(replay.json()).toEqual(response.json());
                await expect(db.session.findUniqueOrThrow({
                    where: { id: session.id },
                })).resolves.toEqual(afterFirstWrite);
                await expect(db.accountChange.count({
                    where: { accountId: owner.id },
                })).resolves.toBe(changesAfterFirst);
                expect(emitUpdate).not.toHaveBeenCalled();

                const conflict = await inject({
                    ...payload,
                    source: {
                        ...payload.source,
                        metadata: {
                            ...payload.source.metadata,
                            version:
                                payload.source.metadata.version + 1,
                        },
                    },
                });
                expect(conflict.statusCode, conflict.body).toBe(409);
                expect(conflict.json()).toMatchObject({
                    code: "session_metadata_version_conflict",
                });
                await expect(db.session.findUniqueOrThrow({
                    where: { id: session.id },
                })).resolves.toEqual(afterFirstWrite);
                await expect(db.accountChange.count({
                    where: { accountId: owner.id },
                })).resolves.toBe(changesAfterFirst);
                expect(emitUpdate).not.toHaveBeenCalled();
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataLayoutVersion: true,
                metadata: true,
                metadataVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual({
            metadataLayoutVersion: 1,
            metadata: SHARED_METADATA,
            metadataVersion: 5,
            ownerMetadata: JSON.stringify(PLAIN_OWNER_METADATA),
            agentState: LEGACY_AGENT_STATE,
            agentStateVersion: 8,
        });
    });

    it("normalizes the retained encrypted layout-one owner value and contracts it through the canonical tuple CAS", async () => {
        const owner = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-layout-one-owner-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: SHARED_METADATA,
                metadataVersion: 4,
                ownerMetadata: ENCRYPTED_OWNER_METADATA.c,
                agentState: LEGACY_AGENT_STATE,
                agentStateVersion: 7,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const headers = {
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                } as const;
                const listed = await app.inject({
                    method: "GET",
                    url: "/v2/sessions?limit=10",
                    headers,
                });
                expect(listed.statusCode, listed.body).toBe(200);
                expect(listed.json().sessions).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            id: session.id,
                            metadataLayoutVersion: 1,
                        }),
                    ]),
                );
                expect(listed.json().sessions.find((row: { id: string }) => row.id === session.id))
                    .not.toHaveProperty("ownerMetadata");
                const detail = await app.inject({
                    method: "GET",
                    url: `/v2/sessions/${session.id}`,
                    headers,
                });
                expect(detail.statusCode, detail.body).toBe(200);
                expect(detail.json().session).toMatchObject({
                    id: session.id,
                    metadataLayoutVersion: 1,
                    ownerMetadata: ENCRYPTED_OWNER_METADATA,
                });

                const updated = await app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        ...headers,
                        "content-type": "application/json",
                    },
                    payload: {
                        mode: "owner",
                        metadataLayoutVersion: 1,
                        expectedOwnerMetadata:
                            ENCRYPTED_OWNER_METADATA,
                        sharedMetadata: {
                            ciphertext: SHARED_METADATA,
                            expectedVersion: 4,
                        },
                        ownerMetadata: ENCRYPTED_OWNER_METADATA,
                        agentState: {
                            ciphertext: LEGACY_AGENT_STATE,
                            expectedVersion: 7,
                        },
                    },
                });
                expect(updated.statusCode, updated.body).toBe(200);
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataVersion: true,
                ownerMetadata: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual({
            metadataVersion: 5,
            ownerMetadata:
                JSON.stringify(ENCRYPTED_OWNER_METADATA),
            agentStateVersion: 7,
        });
    });


    it("returns the typed privacy refusal when Account currentness no longer matches", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `legacy-account-race-${Math.random()}`,
                encryptionMode: "plain",
                metadataLayoutVersion: 0,
                metadata: LEGACY_METADATA,
                metadataVersion: 4,
                ownerMetadata: null,
                agentState: LEGACY_AGENT_STATE,
                agentStateVersion: 7,
            },
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: owner.id },
        });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app: FastifyInstance) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: `/v2/sessions/${session.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: {
                        mode: "owner_migration",
                        expectedAccountEncryptionMode: "e2ee",
                        expectedAccountContentPublicKeyFingerprint:
                            `content-public-key-sha256:${"a".repeat(64)}`,
                        source: {
                            metadataLayoutVersion: 0,
                            metadata: {
                                version: 4,
                                ciphertext: LEGACY_METADATA,
                            },
                            ownerMetadata: null,
                            agentState: {
                                version: 7,
                                ciphertext: LEGACY_AGENT_STATE,
                            },
                        },
                        target: {
                            metadataLayoutVersion: 1,
                            sharedMetadata: {
                                ciphertext: "encrypted-shared",
                            },
                            ownerMetadata:
                                ENCRYPTED_OWNER_METADATA,
                            agentState: {
                                ciphertext: "encrypted-agent",
                            },
                        },
                    },
                });

                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({
                    error:
                        "Session metadata privacy upgrade required",
                    code: "metadata_privacy_upgrade_required",
                });
            },
        );

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
        })).resolves.toEqual(before);
        await expect(db.accountChange.count({
            where: { accountId: owner.id },
        })).resolves.toBe(changesBefore);
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
