import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_DRAFT_ROUTE_LIST, SESSION_DRAFT_ROUTE_READ, SessionInputAdmissionReceiptV1Schema, SessionMessagesPageV1Schema, createSessionSubagentCustodyKeyV1 } from "@happier-dev/protocol";

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
import { registerSessionManagerRoutes } from "./registerSessionManagerRoutes";
import { registerSessionSubagentCustodyRoutes } from "./registerSessionSubagentCustodyRoutes";
import { registerSessionDataKeyEnvelopeRoutes } from "./registerSessionDataKeyEnvelopeRoutes";
import { registerSessionOrganizationRoutes } from "./registerSessionOrganizationRoutes";
import { registerSessionListingRoutes } from "./registerSessionListingRoutes";

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

    it("reads one exact message while retaining Session access, chain, role and publication restrictions", async () => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const outsider = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", seq: 200,
        } });
        const messageId = `exact-${session.id}-7`;
        await db.sessionMessage.createMany({ data: Array.from({ length: 200 }, (_, index) => ({
            id: `exact-${session.id}-${index + 1}`, sessionId: session.id, seq: index + 1, messageRole: "agent",
            content: { t: "plain", v: { text: `answer-${index + 1}` } },
        })) });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const headers = { "x-test-user-id": account.id };
            const url = `/v1/sessions/${session.id}/messages?messageId=${messageId}`;
            const response = await app.inject({ method: "GET", url, headers });
            expect(response.statusCode).toBe(200);
            const page = SessionMessagesPageV1Schema.parse(response.json());
            expect(page.messages.map(message => message.id)).toEqual([messageId]);
            expect(page).toMatchObject({ hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
            for (const query of ["&role=user", "&scope=sidechain&sidechainId=other-chain"]) {
                const filtered = await app.inject({ method: "GET", url: `${url}${query}`, headers });
                expect(filtered.statusCode).toBe(200);
                expect(SessionMessagesPageV1Schema.parse(filtered.json())).toMatchObject({
                    messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
                });
            }
            const missing = await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/messages?messageId=missing`, headers });
            expect(SessionMessagesPageV1Schema.parse(missing.json())).toMatchObject({ messages: [], hasMore: false });
            const denied = await app.inject({ method: "GET", url, headers: { "x-test-user-id": outsider.id } });
            expect(denied.statusCode).toBe(404);
            await db.session.update({ where: { id: session.id }, data: {
                currentStorageState: "server_partial", acceptedThroughServerSeq: 6,
            } });
            const unpublished = await app.inject({ method: "GET", url, headers });
            expect(unpublished.statusCode).toBe(200);
            expect(SessionMessagesPageV1Schema.parse(unpublished.json())).toMatchObject({
                messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
            });
        });
    });

    it('keeps waiting readable for released readers and preserves it for cumulative V4 readers', async () => {
        // cli-v0.2.16 / cli-v0.2.16-preview.1, b8d1c449c46ab4dfa8637db36b66f643d149e66d,
        // strictly parse the four-state status on Session reads and turn history.
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: '{}',
            encryptionMode: 'plain', active: true, seq: 9, latestTurnId: 'waiting-turn', latestTurnStatus: 'waiting',
            latestReadyEventSeq: 9, latestReadyEventAt: new Date(100) } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'waiting-turn', status: 'waiting',
            startedAt: 100n, updatedAt: 200n, terminalAt: 200n,
            transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [4], startSeqInclusive: 4, endSeqInclusive: 4 }),
            transcriptAnchorProjectionVersion: 1, transcriptAnchorMinSeq: 4, transcriptAnchorMaxSeq: 4 } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 4, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'question input' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } });
        await withAuthenticatedTestApp(app => { registerSessionListingRoutes(app); registerSessionLookupByTagsRoute(app);
            registerSessionTurnMutationRoute(app); registerSessionMessageRoutes(app); }, async app => {
            for (const version of [undefined, 2, 3, 4]) {
                const headers = { 'x-test-user-id': account.id,
                    ...(version === undefined ? {} : { 'x-happier-account-stored-content-protocol': String(version) }) };
                const current = version === 4;
                for (const request of [
                    { method: 'GET' as const, url: `/v2/sessions/${session.id}` },
                    { method: 'GET' as const, url: '/v2/sessions' },
                    { method: 'GET' as const, url: '/v2/sessions/active' },
                    { method: 'POST' as const, url: '/v2/sessions/lookup-by-tags', payload: { tags: [session.tag] } },
                ]) {
                    const response = await app.inject({ ...request, headers });
                    expect(response.statusCode, request.url).toBe(200);
                    const payload = response.json();
                    const row = payload.session ?? payload.sessions.find((row: { id: string }) => row.id === session.id);
                    expect(row, `${request.url} v${version}`).toMatchObject({ latestTurnStatus: current ? 'waiting' : null,
                        latestReadyEventSeq: current ? 9 : null });
                }
                const response = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/turns`, headers });
                expect(response.statusCode).toBe(200);
                expect(response.json().turns).toEqual(current ? [expect.objectContaining({ turnId: 'waiting-turn', status: 'waiting' })] : []);
                expect(response.json().latestTurnId).toBe(current ? 'waiting-turn' : undefined);
                const external = await app.inject({ method: 'GET',
                    url: `/v1/sessions/${session.id}/messages?afterSeq=0&projection=externalShareableV1`, headers });
                expect(external.statusCode).toBe(200);
                expect(external.json()).toMatchObject({ hasMore: true,
                    externalShareableSnapshot: { turnSettlementBlockedFromSeq: 4,
                        turns: current ? [expect.objectContaining({ turnId: 'waiting-turn', status: 'waiting' })] : [] } });
            }
        });
    });

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
        expect(await setSessionFollowSource({ policy: { preset: 'important' as const },
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
            registerSessionManagerRoutes(app);
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
                { method: "POST" as const, url: `/v1/sessions/${session.id}/manager/options`, payload: { candidateSessionIds: [source.id] } },
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
