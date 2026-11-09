import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol';

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { inTx } from "@/storage/inTx";
import { readSessionObservationCursorInTx } from "@/app/session/access/readObservation";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const PLAIN_OWNER_METADATA = JSON.stringify({ t: "plain", v: { v: 1 } });
const SHARED_METADATA = JSON.stringify({ v: 1 });

describe("v2 session list publication privacy (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-v2-list-publication-privacy-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function withApp(run: (app: FastifyInstance) => Promise<void>) {
        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            run,
        );
    }

    it('orders list and exact Session observations by the committed Account cursor', async () => {
        const owner = await db.account.create({ data: {
            publicKey: `snapshot-order-${crypto.randomUUID()}`, encryptionMode: 'plain', seq: 10,
        } });
        await withApp(async app => {
            const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
            let observationReads = 0;
            let observingReads = true;
            const stop = observeSqliteRequests({ before: request => {
                if (observingReads && request.model === 'Account' && JSON.stringify(request.args).includes('"select":{"seq":true}')) {
                    observationReads += 1;
                }
            } });
            try {
            const before = await app.inject({ method: 'GET', url: '/v2/sessions?limit=10', headers });
            expect(before.statusCode).toBe(200);
            expect(before.json()).toMatchObject({ sessions: [], observationCursor: 10 });
            observingReads = false;
            const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: {
                tag: `snapshot-created-${crypto.randomUUID()}`, encryptionMode: 'plain', metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: SHARED_METADATA }, ownerMetadata: { t: 'plain', v: { v: 1 } },
            } });
            expect(created.statusCode, created.body).toBe(200);
            const { session } = V2SessionByIdResponseSchema.parse(created.json());
            observingReads = true;
            const exact = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}`, headers });
            expect(exact.statusCode).toBe(200);
            expect(exact.json()).toMatchObject({ session: { id: session.id }, observationCursor: 11 });
            const after = await app.inject({ method: 'GET', url: '/v2/sessions?limit=10', headers });
            expect(after.statusCode).toBe(200);
            expect(after.json()).toMatchObject({ sessions: [{ id: session.id }], observationCursor: 11 });
            // One scalar capture read per request, never one per returned row or late admission.
            expect(observationReads).toBe(3);
            } finally { stop(); }
        });
    });

    it.each(['runtime', 'automation'] as const)('does not disclose an Account observation cursor to %s credentials', async kind => {
        const owner = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), encryptionMode: 'plain', seq: 42,
        } });
        const authentication = createPresentUserSessionAccessAuthentication();
        await expect(inTx(tx => readSessionObservationCursorInTx(tx, owner.id, authentication))).resolves.toBe(42);
        await expect(inTx(tx => readSessionObservationCursorInTx(tx, owner.id, {
            ...authentication, authority: 'account_automation',
            ...(kind === 'runtime' ? { sessionRuntimePrincipal: {
                kind: 'ephemeral_session_runner', authority: 'session_runtime', accountId: owner.id,
                activationId: crypto.randomUUID(), sessionId: 'restricted-session', machineId: 'restricted-machine',
                installationId: 'restricted-installation', installationPublicKey: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
                creatorTokenEpoch: 0,
            } } : {}),
        }))).resolves.toBeUndefined();
    });

    it("keeps a collaborator's order, cursor pagination, and active membership at the snapshot publication ceiling", async () => {
        const now = Date.now();
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: { publicKey: `pk-v2-publication-owner-${crypto.randomUUID()}`, encryptionMode: "plain" },
                select: { id: true },
            }),
            db.account.create({
                data: { publicKey: `pk-v2-publication-collaborator-${crypto.randomUUID()}`, encryptionMode: "plain" },
                select: { id: true },
            }),
        ]);
        const [hosted, snapshot] = await Promise.all([
            db.session.create({
                data: {
                    tag: `v2-publication-hosted-${crypto.randomUUID()}`,
                    accountId: owner.id,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    metadata: SHARED_METADATA,
                    ownerMetadata: PLAIN_OWNER_METADATA,
                    agentState: null,
                    active: true,
                    meaningfulActivityAt: new Date(now - 1_000),
                    lastActiveAt: new Date(now - 1_000),
                },
                select: { id: true },
            }),
            db.session.create({
                data: {
                    tag: `v2-publication-snapshot-${crypto.randomUUID()}`,
                    accountId: owner.id,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    metadata: SHARED_METADATA,
                    ownerMetadata: PLAIN_OWNER_METADATA,
                    agentState: null,
                    seq: 1,
                    currentStorageState: "snapshot_complete",
                    acceptedThroughServerSeq: 1,
                    materializationPublicationId: "publication-v1",
                    materializedThroughSourceAt: BigInt(now - 4_000),
                    publishedThroughServerSeq: 1,
                    active: false,
                    meaningfulActivityAt: new Date(now - 5_000),
                    lastActiveAt: new Date(now - 5_000),
                },
                select: { id: true },
            }),
        ]);
        await db.sessionShare.createMany({
            data: [
                {
                    sessionId: hosted.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: collaborator.id,
                    accessLevel: "view",
                },
                {
                    sessionId: snapshot.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: collaborator.id,
                    accessLevel: "view",
                },
            ],
        });

        await withApp(async (app) => {
            const headers = {
                "x-test-user-id": collaborator.id,
                "x-happier-account-stored-content-protocol": "2",
            } as const;
            const first = await app.inject({
                method: "GET",
                url: "/v2/sessions?limit=1",
                headers,
            });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({
                sessions: [{ id: hosted.id }],
                hasNext: true,
            });
            const firstCursor = first.json().nextCursor as string;
            expect(firstCursor).toEqual(expect.any(String));

            const initialActive = await app.inject({
                method: "GET",
                url: "/v2/sessions/active?limit=10",
                headers,
            });
            expect(initialActive.statusCode, initialActive.body).toBe(200);
            expect(initialActive.json().sessions.map((session: { id: string }) => session.id)).toEqual([hosted.id]);

            await db.session.update({
                where: { id: snapshot.id },
                data: {
                    active: true,
                    meaningfulActivityAt: new Date(now + 1_000),
                    lastActiveAt: new Date(now + 1_000),
                },
            });

            const afterPrivateActivity = await app.inject({
                method: "GET",
                url: "/v2/sessions?limit=1",
                headers,
            });
            expect(afterPrivateActivity.statusCode, afterPrivateActivity.body).toBe(200);
            expect(afterPrivateActivity.json()).toMatchObject({
                sessions: [{ id: hosted.id }],
                nextCursor: firstCursor,
                hasNext: true,
            });

            const secondPage = await app.inject({
                method: "GET",
                url: `/v2/sessions?limit=1&cursor=${encodeURIComponent(firstCursor)}`,
                headers,
            });
            expect(secondPage.statusCode, secondPage.body).toBe(200);
            expect(secondPage.json()).toMatchObject({
                sessions: [{ id: snapshot.id }],
                nextCursor: null,
                hasNext: false,
            });

            const activeAfterPrivateActivity = await app.inject({
                method: "GET",
                url: "/v2/sessions/active?limit=10",
                headers,
            });
            expect(activeAfterPrivateActivity.statusCode, activeAfterPrivateActivity.body).toBe(200);
            expect(activeAfterPrivateActivity.json().sessions.map((session: { id: string }) => session.id)).toEqual([hosted.id]);

            for (const viewerId of [owner.id, collaborator.id]) {
                const viewerHeaders = { ...headers, "x-test-user-id": viewerId };
                const list = await app.inject({ method: "GET", url: "/v2/sessions?limit=10", headers: viewerHeaders });
                expect(list.statusCode, list.body).toBe(200);
                for (const listed of list.json().sessions) {
                    const detail = await app.inject({ method: "GET", url: `/v2/sessions/${listed.id}`, headers: viewerHeaders });
                    expect(detail.statusCode, detail.body).toBe(200);
                    // Lists are compact since 26aeda2577; every fact a row carries must match the exact read.
                    const { documents: _documents, agentStateDocument: _agentStateDocument, metadataAudience: _metadataAudience, ...compactFacts } = listed;
                    expect(detail.json().session).toMatchObject(compactFacts);
                }
            }
        });
    });

    it("orders every finite publication state by its ceiling-safe recency while retaining hosted activity", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-v2-five-states-${crypto.randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const createSession = async (params: Readonly<{
            tag: string;
            createdAt: number;
            meaningfulActivityAt: number;
            currentStorageState: "hosted" | "machine_only" | "server_partial" | "snapshot_complete" | "legacy_external_unknown";
            acceptedThroughServerSeq?: number | null;
            materializationPublicationId?: string | null;
            materializedThroughSourceAt?: bigint | null;
            publishedThroughServerSeq?: number | null;
            seq?: number;
        }>) => await db.session.create({
            data: {
                tag: params.tag,
                accountId: owner.id,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: SHARED_METADATA,
                ownerMetadata: PLAIN_OWNER_METADATA,
                agentState: null,
                createdAt: new Date(params.createdAt),
                meaningfulActivityAt: new Date(params.meaningfulActivityAt),
                lastActiveAt: new Date(params.meaningfulActivityAt),
                seq: params.seq ?? 0,
                currentStorageState: params.currentStorageState,
                acceptedThroughServerSeq: params.acceptedThroughServerSeq ?? null,
                materializationPublicationId: params.materializationPublicationId ?? null,
                materializedThroughSourceAt: params.materializedThroughSourceAt ?? null,
                publishedThroughServerSeq: params.publishedThroughServerSeq ?? null,
            },
            select: { id: true },
        });

        const [hosted, snapshot, machineOnly, serverPartial, legacyUnknown] = await Promise.all([
            createSession({
                tag: `v2-five-hosted-${crypto.randomUUID()}`,
                createdAt: 5_000,
                meaningfulActivityAt: 9_000,
                currentStorageState: "hosted",
            }),
            createSession({
                tag: `v2-five-snapshot-${crypto.randomUUID()}`,
                createdAt: 4_500,
                meaningfulActivityAt: 12_000,
                currentStorageState: "snapshot_complete",
                seq: 9,
                acceptedThroughServerSeq: 9,
                materializationPublicationId: "publication-five-state",
                materializedThroughSourceAt: 4_000n,
                publishedThroughServerSeq: 4,
            }),
            createSession({
                tag: `v2-five-machine-${crypto.randomUUID()}`,
                createdAt: 3_000,
                meaningfulActivityAt: 11_000,
                currentStorageState: "machine_only",
            }),
            createSession({
                tag: `v2-five-partial-${crypto.randomUUID()}`,
                createdAt: 2_000,
                meaningfulActivityAt: 10_000,
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 2,
            }),
            createSession({
                tag: `v2-five-unknown-${crypto.randomUUID()}`,
                createdAt: 1_000,
                meaningfulActivityAt: 13_000,
                currentStorageState: "legacy_external_unknown",
            }),
        ]);

        await withApp(async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/v2/sessions?limit=10",
                headers: {
                    "x-test-user-id": owner.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().sessions.map((session: { id: string }) => session.id)).toEqual([
                hosted.id,
                snapshot.id,
                machineOnly.id,
                serverPartial.id,
                legacyUnknown.id,
            ]);
        });
    });

    it("does not let an above-ceiling private updatedAt change the retained owned 150", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: `pk-v2-owned-publication-ceiling-${crypto.randomUUID()}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const base = 1_700_000_000_000;
        const sessionIds = Array.from(
            { length: 151 },
            (_, index) => `v2-owned-publication-${crypto.randomUUID()}-${index}`,
        );
        const publishedRecencyAt = (index: number) => base - (index * 1_000);
        await db.session.createMany({
            data: sessionIds.map((id, index) => ({
                id,
                tag: `v2-owned-publication-tag-${index}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: "{}",
                agentState: null,
                currentStorageState: "machine_only",
                createdAt: new Date(publishedRecencyAt(index)),
                updatedAt: new Date(publishedRecencyAt(index)),
            })),
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as never),
            async (app) => {
                const readIds = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: "/v2/sessions?limit=150",
                        headers: { "x-test-user-id": owner.id },
                    });
                    expect(response.statusCode, response.body).toBe(200);
                    return (response.json().sessions as Array<{ id: string }>).map((session) => session.id);
                };

                const beforePrivateCatchup = await readIds();
                expect(beforePrivateCatchup).toEqual(sessionIds.slice(0, 150));

                await db.session.update({
                    where: { id: sessionIds[150]! },
                    data: { updatedAt: new Date(base + 10_000) },
                });

                expect(await readIds()).toEqual(beforePrivateCatchup);
            },
        );
    });
});
