import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionListQueryResponseV1Schema } from "@happier-dev/protocol/sessions/listing/response";
import type { SessionListQueryV1 } from "@happier-dev/protocol/sessions/listing/query";
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilityHttpHeadersV1 } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";

/** The Home list's default personal query: the one the cold load reads. */
const QUERY: SessionListQueryV1 = {
    v: 1, storage: "active", includeInactive: true, scope: "my_work",
    attention: "any", audiences: [], tagIds: [], includeAttention: true, limit: 50,
};

describe("Session list query carrying the ordinary first page (SQLite, routes)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-list-ordinary-page-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const [viewer, other] = await Promise.all([0, 1].map(() => db.account.create({ data: {
            publicKey: randomUUID(), encryptionMode: "plain",
        } })));
        const team = await db.team.create({ data: { name: "Ordinary page Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
        const create = (accountId: string, activity: number, extra: Record<string, unknown> = {}) => db.session.create({ data: {
            accountId, tag: randomUUID(), encryptionMode: "plain", metadataLayoutVersion: 1,
            metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}',
            meaningfulActivityAt: new Date(activity), ...extra,
        } });
        // More owned rows than one page, so page one truncates both memberships.
        const owned = [];
        for (let index = 0; index < 55; index++) owned.push(await create(viewer.id, 100_000 - index));
        await db.sessionPin.create({ data: { accountId: viewer.id, sessionId: owned[54]!.id } });
        await create(viewer.id, 300_000, { archivedAt: new Date(300_000) });
        // Team-shared rows newer than every owned row: they occupy the query page only.
        const teamPinned = await create(other.id, 200_000);
        await db.sessionGrant.create({ data: { principalKind: "team", sessionId: teamPinned.id, teamId: team.id, effectiveAt: new Date(1),
            createdByAccountId: other.id, accessLevel: "view" } });
        await db.sessionPin.create({ data: { accountId: viewer.id, sessionId: teamPinned.id } });
        const teamResponsible = await create(other.id, 199_000, { responsibleAccountId: viewer.id });
        await db.sessionGrant.create({ data: { principalKind: "team", sessionId: teamResponsible.id, teamId: team.id, effectiveAt: new Date(1),
            createdByAccountId: other.id, accessLevel: "edit" } });
        // Directly shared and Team-shared at a higher level: both readers admit it, with their own access facts.
        const both = await create(other.id, 198_000, { responsibleAccountId: viewer.id });
        await db.sessionGrant.create({ data: { principalKind: "account", sessionId: both.id, accountId: viewer.id,
            createdByAccountId: other.id, accessLevel: "view" } });
        await db.sessionGrant.create({ data: { principalKind: "team", sessionId: both.id, teamId: team.id, effectiveAt: new Date(1),
            createdByAccountId: other.id, accessLevel: "edit" } });
        const direct = await create(other.id, 197_000);
        await db.sessionGrant.create({ data: { principalKind: "account", sessionId: direct.id, accountId: viewer.id,
            createdByAccountId: other.id, accessLevel: "view" } });
        return { viewer, owned, teamPinned, teamResponsible, both, direct };
    }

    it("returns the exact GET page one beside an unchanged query page, sending identical rows once", async () => {
        const f = await fixture();
        // The listing registrar owns both `GET /v2/sessions` and `POST /v2/sessions/query`.
        await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
            const headers = { "x-test-user-id": f.viewer.id,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
            const ordinary = await app.inject({ method: "GET", url: "/v2/sessions?includeAttention=true&limit=50", headers });
            expect(ordinary.statusCode, ordinary.body).toBe(200);
            const query = await app.inject({ method: "POST", url: "/v2/sessions/query", headers, payload: QUERY });
            expect(query.statusCode, query.body).toBe(200);
            const combined = await app.inject({ method: "POST", url: "/v2/sessions/query", headers,
                payload: { ...QUERY, ordinaryPage: { limit: 50, includeAttention: true } } });
            expect(combined.statusCode, combined.body).toBe(200);

            const { ordinary: carried, ...queryPage } = SessionListQueryResponseV1Schema.parse(combined.json());
            expect(queryPage).toEqual(query.json());
            expect(carried).toBeDefined();
            const { sessionIds, sessions: differing, ...ordinaryMembers } = carried!;
            const rowsById = new Map<string, unknown>([
                ...(combined.json().sessions as { id: string }[]).map(row => [row.id, row] as const),
                ...(combined.json().ordinary.sessions as { id: string }[]).map(row => [row.id, row] as const),
            ]);
            // Every ordinary consumer reads exactly the GET page: rows, access facts, cursors, observation.
            expect({ ...ordinaryMembers, sessions: sessionIds.map(id => rowsById.get(id)) }).toEqual(ordinary.json());

            const ordinaryIds = (ordinary.json().sessions as { id: string }[]).map(row => row.id);
            const queryIds = (query.json().sessions as { id: string }[]).map(row => row.id);
            // Team-shared rows displace owned rows from the query's first page only (list.md 2.1).
            expect(ordinaryIds).toEqual(expect.arrayContaining([f.owned[47]!.id, f.owned[54]!.id, f.both.id, f.direct.id]));
            expect(ordinaryIds).not.toContain(f.teamPinned.id);
            expect(queryIds).toEqual(expect.arrayContaining([f.teamPinned.id, f.teamResponsible.id, f.both.id, f.owned[54]!.id]));
            expect(queryIds).not.toContain(f.owned[47]!.id);
            // Identical rows travel once. The doubly shared row keeps its own ordinary access facts,
            // and the displaced owned rows travel in full.
            expect(new Set(differing.map(row => row.id))).toEqual(new Set([f.both.id, f.owned[46]!.id, f.owned[47]!.id]));
            expect(differing.find(row => row.id === f.both.id)).toEqual(
                (ordinary.json().sessions as { id: string }[]).find(row => row.id === f.both.id));
            expect(differing.find(row => row.id === f.both.id))
                .not.toEqual((query.json().sessions as { id: string }[]).find(row => row.id === f.both.id));
            expect(combined.body.length).toBeLessThan(ordinary.body.length + query.body.length);
        });
    });
});
