import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { db } from "@/storage/db";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { listSessionsForAccount } from "./service";
import { createV2SessionListServerTiming } from "./timing";

/** Exact viewer-owned folder ANY and tag ANY predicates compose before pagination on every provider. */
export async function verifyFolderSessionListing(): Promise<void> {
    const [viewer, other] = await Promise.all([0, 1].map(() => db.account.create({
        data: { publicKey: randomUUID(), encryptionMode: "plain" },
    })));
    const parent = await db.sessionOrganizationFolder.create({ data: {
        accountId: viewer.id, folderKey: randomUUID(), folderHash: randomUUID(),
    } });
    const second = await db.sessionOrganizationFolder.create({ data: {
        accountId: viewer.id, folderKey: randomUUID(), folderHash: randomUUID(),
    } });
    const child = await db.sessionOrganizationFolder.create({ data: {
        accountId: viewer.id, folderKey: randomUUID(), folderHash: randomUUID(),
        parentKey: parent.folderKey, parentHash: parent.folderHash,
    } });
    const tags = await Promise.all([0, 1].map(() => db.sessionOrganizationTag.create({ data: {
        accountId: viewer.id, tagKey: randomUUID(), tagHash: randomUUID(),
    } })));
    const sessions = await Promise.all(Array.from({ length: 6 }, (_, index) => db.session.create({ data: {
        accountId: viewer.id, tag: randomUUID(), metadata: '{"v":1}', encryptionMode: "plain",
        metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
        meaningfulActivityAt: new Date(index < 3 ? 1_000 : 2_000),
    } })));
    await db.sessionFolderAssignment.createMany({ data: sessions.map((session, index) => ({
        accountId: index === 5 ? other.id : viewer.id,
        sessionId: session.id,
        folderId: index === 1 ? second.id : index === 3 ? child.id : parent.id,
    })) });
    await db.sessionTagAssignment.createMany({ data: sessions.filter((_, index) => index !== 4).map((session, index) => ({
        accountId: viewer.id, sessionId: session.id, tagId: tags[index % 2]!.id,
    })) });
    const list = async (folderIds: readonly string[], tagIds: readonly string[], cursor?: string) => (
        await listSessionsForAccount({
            userId: viewer.id,
            authentication: createPresentUserSessionAccessAuthentication(),
            source: { kind: "query", query: SessionListQueryV1Schema.parse({
                v: 1, storage: "active", includeInactive: true, scope: "my_work", attention: "any",
                audiences: { include: [], exclude: [] }, folderIds, tagIds: { include: tagIds, exclude: [] }, limit: 1, ...(cursor === undefined ? {} : { cursor }),
            }) },
            rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
        })
    );
    const expected = sessions.slice(0, 3).map((session) => session.id).sort().reverse();
    const received: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < expected.length; index += 1) {
        const page = await list([parent.id, second.id], tags.map((tag) => tag.id), cursor);
        expect(page).not.toBeNull();
        expect(page!.sessions).toHaveLength(1);
        received.push(page!.sessions[0]!.id);
        expect(page!.hasNext).toBe(index < expected.length - 1);
        cursor = page!.nextCursor ?? undefined;
    }
    expect(received).toEqual(expected);
    expect((await list([randomUUID()], []))!.sessions).toEqual([]);
    expect((await list([], []))!.sessions).toHaveLength(1);
}
