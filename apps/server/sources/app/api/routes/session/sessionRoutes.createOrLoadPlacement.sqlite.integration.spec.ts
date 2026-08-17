import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

const plainOwnerMetadata = { t: "plain", v: { v: 1 } } as const;

describe("session create-or-load placement (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-create-placement-",
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
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionTagAssignment.deleteMany(),
            () => db.sessionFolderAssignment.deleteMany(),
            () => db.sessionOrganizationTag.deleteMany(),
            () => db.sessionOrganizationFolder.deleteMany(),
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

    it("creates a layout-v1 session with its requested folder and tag assignments", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-create-placement", encryptionMode: "plain" },
            select: { id: true },
        });
        const folder = await db.sessionOrganizationFolder.create({
            data: {
                accountId: account.id,
                folderKey: "folder-create-placement",
                folderHash: "folder-create-placement-hash",
            },
            select: { id: true },
        });
        const tag = await db.sessionOrganizationTag.create({
            data: {
                accountId: account.id,
                tagKey: "tag-create-placement",
                tagHash: "tag-create-placement-hash",
            },
            select: { id: true },
        });

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    tag: "create-placement-session",
                    metadataLayoutVersion: 1,
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
                    ownerMetadata: plainOwnerMetadata,
                    agentState: JSON.stringify({}),
                    dataEncryptionKey: null,
                    encryptionMode: "plain",
                    organizationPlacement: {
                        folderId: folder.id,
                        tagIds: [tag.id],
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                created: true,
                organizationPlacement: {
                    folderId: folder.id,
                    tagIds: [tag.id],
                },
            });

            const session = await db.session.findUniqueOrThrow({
                where: { accountId_tag: { accountId: account.id, tag: "create-placement-session" } },
                select: { id: true },
            });
            await expect(db.sessionFolderAssignment.findUniqueOrThrow({
                where: { accountId_sessionId: { accountId: account.id, sessionId: session.id } },
                select: { folderId: true },
            })).resolves.toEqual({ folderId: folder.id });
            await expect(db.sessionTagAssignment.findMany({
                where: { accountId: account.id, sessionId: session.id },
                select: { tagId: true },
                orderBy: { tagId: "asc" },
            })).resolves.toEqual([{ tagId: tag.id }]);
        });
    });

    it("rejoins by creation tag without overwriting the original placement", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-create-placement-rejoin", encryptionMode: "plain" },
            select: { id: true },
        });
        const [originalFolder, laterFolder] = await Promise.all([
            db.sessionOrganizationFolder.create({
                data: {
                    accountId: account.id,
                    folderKey: "folder-create-placement-original",
                    folderHash: "folder-create-placement-original-hash",
                },
                select: { id: true },
            }),
            db.sessionOrganizationFolder.create({
                data: {
                    accountId: account.id,
                    folderKey: "folder-create-placement-later",
                    folderHash: "folder-create-placement-later-hash",
                },
                select: { id: true },
            }),
        ]);

        await withApp(async (app) => {
            const create = async (folderId: string) => await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    tag: "create-placement-rejoin-session",
                    metadataLayoutVersion: 1,
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
                    ownerMetadata: plainOwnerMetadata,
                    agentState: JSON.stringify({}),
                    dataEncryptionKey: null,
                    encryptionMode: "plain",
                    organizationPlacement: { folderId, tagIds: [] },
                },
            });

            const first = await create(originalFolder.id);
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({
                created: true,
                organizationPlacement: { folderId: originalFolder.id, tagIds: [] },
            });

            const rejoined = await create(laterFolder.id);
            expect(rejoined.statusCode, rejoined.body).toBe(200);
            expect(rejoined.json()).toMatchObject({
                created: false,
                organizationPlacement: { folderId: originalFolder.id, tagIds: [] },
            });
        });
    });

    it("settles concurrent layout-v1 placement creates as one create and one rejoin", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-create-placement-race", encryptionMode: "plain" },
            select: { id: true },
        });
        const [firstFolder, secondFolder] = await Promise.all([
            db.sessionOrganizationFolder.create({
                data: {
                    accountId: account.id,
                    folderKey: "folder-create-placement-race-first",
                    folderHash: "folder-create-placement-race-first-hash",
                },
                select: { id: true },
            }),
            db.sessionOrganizationFolder.create({
                data: {
                    accountId: account.id,
                    folderKey: "folder-create-placement-race-second",
                    folderHash: "folder-create-placement-race-second-hash",
                },
                select: { id: true },
            }),
        ]);

        await withApp(async (app) => {
            const create = async (folderId: string) => await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    tag: "create-placement-race-session",
                    metadataLayoutVersion: 1,
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
                    ownerMetadata: plainOwnerMetadata,
                    agentState: JSON.stringify({}),
                    dataEncryptionKey: null,
                    encryptionMode: "plain",
                    organizationPlacement: { folderId, tagIds: [] },
                },
            });

            const [first, second] = await Promise.all([
                create(firstFolder.id),
                create(secondFolder.id),
            ]);
            expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

            const firstBody = first.json();
            const secondBody = second.json();
            expect(firstBody.session.id).toBe(secondBody.session.id);
            expect([firstBody.created, secondBody.created].sort()).toEqual([false, true]);
            expect(firstBody.organizationPlacement).toEqual(secondBody.organizationPlacement);

            const sessions = await db.session.findMany({
                where: { accountId: account.id, tag: "create-placement-race-session" },
                select: { id: true },
            });
            expect(sessions).toHaveLength(1);
            const assignment = await db.sessionFolderAssignment.findUniqueOrThrow({
                where: {
                    accountId_sessionId: {
                        accountId: account.id,
                        sessionId: sessions[0]!.id,
                    },
                },
                select: { folderId: true },
            });
            expect(firstBody.organizationPlacement).toEqual({
                folderId: assignment.folderId,
                tagIds: [],
            });
        });
    });

    it("rejects an invalid placement without creating a partial session", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-create-placement-invalid", encryptionMode: "plain" },
            select: { id: true },
        });

        await withApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: {
                    tag: "create-placement-invalid-session",
                    metadataLayoutVersion: 1,
                    sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
                    ownerMetadata: plainOwnerMetadata,
                    agentState: JSON.stringify({}),
                    dataEncryptionKey: null,
                    encryptionMode: "plain",
                    organizationPlacement: {
                        folderId: "missing-folder",
                        tagIds: [],
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toMatchObject({
                error: "invalid-params",
                code: "invalid-session-organization-placement",
            });
            await expect(db.session.count({
                where: { accountId: account.id, tag: "create-placement-invalid-session" },
            })).resolves.toBe(0);
        });
    });

    it("rejects foreign and archived folder or tag placement without creating a partial session", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-create-placement-account", encryptionMode: "plain" },
            select: { id: true },
        });
        const foreignAccount = await db.account.create({
            data: { publicKey: "pk-create-placement-foreign", encryptionMode: "plain" },
            select: { id: true },
        });
        const [foreignFolder, archivedFolder, foreignTag, archivedTag] = await Promise.all([
            db.sessionOrganizationFolder.create({
                data: {
                    accountId: foreignAccount.id,
                    folderKey: "folder-create-placement-foreign",
                    folderHash: "folder-create-placement-foreign-hash",
                },
                select: { id: true },
            }),
            db.sessionOrganizationFolder.create({
                data: {
                    accountId: account.id,
                    folderKey: "folder-create-placement-archived",
                    folderHash: "folder-create-placement-archived-hash",
                    archivedAt: new Date(),
                },
                select: { id: true },
            }),
            db.sessionOrganizationTag.create({
                data: {
                    accountId: foreignAccount.id,
                    tagKey: "tag-create-placement-foreign",
                    tagHash: "tag-create-placement-foreign-hash",
                },
                select: { id: true },
            }),
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: "tag-create-placement-archived",
                    tagHash: "tag-create-placement-archived-hash",
                    archivedAt: new Date(),
                },
                select: { id: true },
            }),
        ]);

        const invalidPlacements = [
            {
                label: "foreign-folder",
                organizationPlacement: { folderId: foreignFolder.id, tagIds: [] },
            },
            {
                label: "archived-folder",
                organizationPlacement: { folderId: archivedFolder.id, tagIds: [] },
            },
            {
                label: "foreign-tag",
                organizationPlacement: { folderId: null, tagIds: [foreignTag.id] },
            },
            {
                label: "archived-tag",
                organizationPlacement: { folderId: null, tagIds: [archivedTag.id] },
            },
        ] as const;

        await withApp(async (app) => {
            for (const invalid of invalidPlacements) {
                const tag = `create-placement-${invalid.label}`;
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                    payload: {
                        tag,
                        metadataLayoutVersion: 1,
                        sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
                        ownerMetadata: plainOwnerMetadata,
                        agentState: JSON.stringify({}),
                        dataEncryptionKey: null,
                        encryptionMode: "plain",
                        organizationPlacement: invalid.organizationPlacement,
                    },
                });

                expect(response.statusCode, `${invalid.label}: ${response.body}`).toBe(400);
                expect(response.json()).toMatchObject({
                    error: "invalid-params",
                    code: "invalid-session-organization-placement",
                });
                await expect(db.session.count({
                    where: { accountId: account.id, tag },
                })).resolves.toBe(0);
            }
        });
    });
});
