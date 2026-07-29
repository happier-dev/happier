import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { setSessionTagAssignments } from "./organizationMutations";

describe("session organization mutations on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-organization-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("persists tag assignments through the real SQLite Prisma client", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const [firstTag, secondTag] = await Promise.all([
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
            db.sessionOrganizationTag.create({
                data: {
                    accountId: account.id,
                    tagKey: `tag-${randomUUID()}`,
                    tagHash: `tag-hash-${randomUUID()}`,
                },
                select: { id: true },
            }),
        ]);

        const result = await setSessionTagAssignments({
            accountId: account.id,
            sessionId: session.id,
            request: { tagIds: [firstTag.id, secondTag.id] },
        });

        expect(result).toEqual({
            sessionId: session.id,
            tagIds: [firstTag.id, secondTag.id].sort(),
        });
        await expect(
            db.sessionTagAssignment.findMany({
                where: { accountId: account.id, sessionId: session.id },
                orderBy: { tagId: "asc" },
                select: { tagId: true },
            }),
        ).resolves.toEqual([
            { tagId: firstTag.id },
            { tagId: secondTag.id },
        ].sort((left, right) => left.tagId.localeCompare(right.tagId)));
        await expect(
            db.sessionOrganizationCheckpoint.findUnique({
                where: { accountId: account.id },
                select: { version: true },
            }),
        ).resolves.toEqual({ version: 1 });
    });
});
