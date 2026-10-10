import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_DRAFT_ROUTE_LIST, SESSION_DRAFT_ROUTE_READ, SessionInputAdmissionReceiptV1Schema, createSessionSubagentCustodyKeyV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { holdSqliteWriteLock } from "@/testkit/sqliteWriteLock";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionDraftRoutes } from "@/app/account/sessionDrafts/registerSessionDraftRoutes";
import { mutateSessionDraft } from "@/app/account/sessionDrafts/sessionDraftService";
import { setSessionFollowSource } from "@/app/session/follow/sessionFollowEdgeService";
import { issueSessionMessageActionReference } from "@/app/session/sessionMessageActionLookup";
import { registerSessionLookupByTagsRoute } from "./registerSessionLookupByTagsRoute";
import { registerSessionAccessGrantRoutes } from "./registerSessionAccessGrantRoutes";
import { registerSessionFollowSourceRoutes } from "./registerSessionFollowSourceRoutes";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import { registerSessionTurnMutationRoute } from "./registerSessionTurnMutationRoute";
import { registerSessionFollowRoutes } from "./registerSessionFollowRoutes";
import { registerSessionReportsToRoutes } from "./registerSessionReportsToRoutes";
import { registerSessionSubagentCustodyRoutes } from "./registerSessionSubagentCustodyRoutes";
import { registerSessionDataKeyEnvelopeRoutes } from "./registerSessionDataKeyEnvelopeRoutes";
import { registerSessionOrganizationRoutes } from "./registerSessionOrganizationRoutes";

describe("authenticated Session pure reads (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-pure-reads-",
            sqliteConnectionLimit: 1,
            env: {
                HAPPIER_DB_TX_MAX_RETRIES: "0",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_SHARING_SESSION__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it("returns committed lookup, access, Follow and draft facts while a primary write is pending", async () => {
        const account = await db.account.create({ data: { publicKey: "session-read-owner", encryptionMode: "plain", seq: 1 } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: "session-read-tag", encryptionMode: "plain",
            metadata: JSON.stringify({ v: 1 }), metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
        } });
        const source = await db.session.create({ data: {
            accountId: account.id, tag: "session-read-source", encryptionMode: "plain", metadata: "{}",
        } });
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: undefined };
        expect(await setSessionFollowSource({
            accountId: account.id, destinationSessionId: session.id, sourceSessionId: source.id, authentication,
        })).toMatchObject({ ok: true });
        const message = await db.sessionMessage.create({ data: {
            sessionId: session.id, localId: "committed-message", seq: 1, messageRole: "user",
            content: { t: "plain", v: { text: "committed message" } },
            authorAccountId: account.id,
            inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse({
                v: 1, issuer: "authenticatedAccount", actorAccountId: account.id, sessionRelationship: "owner",
            }),
        } });
        const reference = issueSessionMessageActionReference({ sessionId: session.id, messageId: message.id, updatedAt: message.updatedAt });
        expect(reference).not.toBeNull();
        const custodyScope = {
            pluginId: "acme.agent", contributionId: "assistant",
            sourceCustody: { kind: "managed" as const, immutableGenerationId: "committed-generation", installSource: "npm" as const },
        };
        const custodyKey = createSessionSubagentCustodyKeyV1({ ...custodyScope, sessionId: session.id });
        const custodyQuery = new URLSearchParams({
            pluginId: custodyScope.pluginId, contributionId: custodyScope.contributionId,
            sourceCustody: JSON.stringify(custodyScope.sourceCustody), custodyKey,
        }).toString();
        const address = { kind: "session" as const, sessionId: session.id };
        const mutationId = "00000000-0000-4000-8000-000000000001";
        const draft = await mutateSessionDraft({
            accountId: account.id, address, expectedRevision: "absent",
            authentication,
            content: { t: "plain", v: { v: 1, address, document: {
                v: 1,
                composer: {
                    text: { mutationId, value: "committed draft" },
                    mentions: { mutationId, value: [] },
                    attachments: { mutationId, value: [] },
                },
                target: { kind: "session", routing: {
                    recipient: { mutationId, value: null },
                    agentContinuation: { mutationId, value: null },
                    executionRunDelivery: { mutationId, value: null },
                } }, extensions: {},
            } } },
        });
        expect(draft.status).toBe("updated");
        await withAuthenticatedTestApp(app => {
            registerSessionLookupByTagsRoute(app);
            registerSessionAccessGrantRoutes(app);
            registerSessionFollowSourceRoutes(app);
            registerSessionDraftRoutes(app);
            registerSessionMessageRoutes(app);
            registerSessionTurnMutationRoute(app);
            registerSessionFollowRoutes(app);
            registerSessionReportsToRoutes(app);
            registerSessionSubagentCustodyRoutes(app);
            registerSessionDataKeyEnvelopeRoutes(app);
            registerSessionOrganizationRoutes(app);
        }, async app => {
            const headers = { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" };
            const requests = [
                { method: "POST" as const, url: "/v2/sessions/lookup-by-tags", payload: { tags: [session.tag] } },
                { method: "POST" as const, url: "/v1/session-access/principals/resolve", payload: { v: 1, subjects: [{ kind: "account", accountId: account.id }] } },
                { method: "POST" as const, url: "/v2/sessions/access-grants/list", payload: { sessionId: session.id } },
                { method: "GET" as const, url: `/v2/sessions/${session.id}/follows/sessions` },
                { method: "POST" as const, url: SESSION_DRAFT_ROUTE_READ, payload: { address } },
                { method: "POST" as const, url: SESSION_DRAFT_ROUTE_LIST, payload: {} },
                { method: "GET" as const, url: `/v2/sessions/${session.id}/messages/by-local-id/${message.localId}` },
                { method: "POST" as const, url: `/v1/sessions/${session.id}/messages/action-reference/resolve`, payload: reference },
                { method: "GET" as const, url: `/v1/sessions/${session.id}/turns` },
                { method: "GET" as const, url: `/v2/sessions/${session.id}/follow` },
                { method: "GET" as const, url: "/v2/account/session-follow-preferences" },
                { method: "POST" as const, url: `/v1/sessions/${session.id}/reports-to/options`, payload: { candidateSessionIds: [source.id] } },
                { method: "GET" as const, url: `/v2/sessions/${session.id}/subagents/custody/capability` },
                { method: "GET" as const, url: `/v2/sessions/${session.id}/subagents/custody?${custodyQuery}` },
                { method: "GET" as const, url: `/v2/sessions/${session.id}/data-key/envelopes` },
                { method: "GET" as const, url: "/v2/session-organization" },
            ];
            const expected: unknown[] = [];
            for (const request of requests) {
                const response = await app.inject({ ...request, headers });
                expect(response.statusCode, request.url).toBe(200);
                expected.push(response.json());
            }
            expect(expected[0]).toMatchObject({ sessions: [{ id: session.id }] });
            expect(expected[4]).toMatchObject({ status: "present", record: { address } });
            expect(expected[5]).toMatchObject({ items: [{ address }] });
            expect(expected[6]).toMatchObject({ message: { id: message.id, accountActor: { accountId: account.id } } });
            expect(expected[7]).toMatchObject({ status: "available" });

            // Initialize the canonical snapshot connection before occupying
            // the single primary connection with a real blocked write.
            await inTx(tx => tx.account.findUniqueOrThrow({ where: { id: account.id } }), { readOnly: true });
            const writer = await holdSqliteWriteLock();
            let writeSettled = false;
            const blockedWrite = inTx(tx => tx.account.update({ where: { id: account.id }, data: { seq: 2 } }))
                .then(() => null, (error: unknown) => error)
                .finally(() => { writeSettled = true; });
            const completed = new Map<string, unknown>();
            const reads = requests.map(async request => {
                const response = await app.inject({ ...request, headers });
                expect(response.statusCode, request.url).toBe(200);
                completed.set(request.url, response.json());
            });
            try {
                await vi.waitFor(() => {
                    expect([...completed.keys()].sort()).toEqual(requests.map(request => request.url).sort());
                }, { timeout: 1000 });
                expect(writeSettled).toBe(false);
                expect(requests.map(request => completed.get(request.url))).toEqual(expected);
            } finally {
                await writer.release();
                await blockedWrite;
                await Promise.all(reads);
            }
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 2 });
    });
});
