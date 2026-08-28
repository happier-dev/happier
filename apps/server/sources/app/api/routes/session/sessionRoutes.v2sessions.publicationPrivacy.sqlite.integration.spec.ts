import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
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
});
