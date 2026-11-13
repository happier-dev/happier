import { beforeEach, describe, expect, it } from "vitest";
import { V2SessionByIdResponseSchema } from "@happier-dev/protocol";
import { SessionCurrentProjectionRecordV1Schema } from "@happier-dev/protocol/sessions/listing/response";

import {
    accountFindUnique,
    FOLLOW_RULE_VIEWER_ACCOUNT_READS,
    createSessionAccessProjectionRelations,
    createSessionDataKeyEnvelopeFixture,
    configureMaterializedRunnerCurrentnessFixture,
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    txAccessKeyFindUnique,
    txAccountFindUnique,
    txEphemeralRunnerActivationFindFirst,
    txMachineFindFirst,
    txSessionFindFirst,
    txSessionFindUnique,
    txSessionMessageFindFirst,
    txSessionMessageFindMany,
    sessionShareFindMany,
    discussionFindMany,
    txSessionFindMany,
    txSessionShareFindMany,
    txDiscussionFindMany,
    sessionPendingMessageCount,
    sessionUpdate,
} from "./sessionRoutes.testkit";
import { DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT } from "@/app/session/listing/readLimits";

const OWNER_METADATA_ENVELOPE_V1 = {
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
} as const;
const STORED_OWNER_METADATA_ENVELOPE_V1 =
    JSON.stringify(OWNER_METADATA_ENVELOPE_V1);
const RUNNER_INSTALLATION_PUBLIC_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const PRIVATE_LIVE_SESSION_PROJECTION_FIELDS = [
    "pendingPermissionRequestCount",
    "pendingUserActionRequestCount",
    "pendingRequestObservedAt",
    "pendingCount",
    "pendingBlockedCount",
    "pendingVersion",
    "latestTurnId",
    "latestTurnStatus",
    "latestTurnStatusObservedAt",
    "lastRuntimeIssue",
    "thinking",
    "thinkingAt",
    "runtimeActivityState",
    "runtimeActivityActiveCount",
    "runtimeActivityObservedAt",
    "runtimeActivityRevision",
] as const;

type SessionByIdRowFixture = Readonly<Record<string, unknown> & {
    id: string;
    accountId: string;
    seq: number;
}>;

function sessionByIdRow(row: SessionByIdRowFixture) {
    const rawShares = Array.isArray(row.shares)
        ? row.shares.filter((share): share is Record<string, unknown> =>
            typeof share === "object" && share !== null)
        : [];
    const shares = rawShares.map((share, index) => ({
        ...share,
        id: typeof share.id === "string" ? share.id : `${row.id}-share-${index}`,
        sharedWithUserId: typeof share.sharedWithUserId === "string"
            ? share.sharedWithUserId
            : "u1",
        accessLevel: share.accessLevel === "edit" || share.accessLevel === "admin"
            ? share.accessLevel
            : "view",
        canApprovePermissions: share.canApprovePermissions === true,
    }));
    const rawEnvelope = row.dataEncryptionKey instanceof Uint8Array
        ? row.dataEncryptionKey
        : rawShares[0]?.encryptedDataKey instanceof Uint8Array
            ? rawShares[0].encryptedDataKey
            : null;
    const lastViewedSessionSeq = typeof row.lastViewedSessionSeq === "number"
        ? row.lastViewedSessionSeq
        : 0;

    return {
        ...createSessionAccessProjectionRelations(),
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
        archivedAt: null,
        responsibleAccountId: null,
        pendingBlockedCount: 0,
        pendingRequestObservedAt: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        accountReadStates: row.accountId === "u1"
            ? [{ accountId: "u1", lastViewedSessionSeq, unreadSince: null }]
            : [],
        accountFollows: [],
        sessionPins: [],
        sessionAttentionStandings: [],
        dataKeyEnvelopes: rawEnvelope === null
            ? []
            : [createSessionDataKeyEnvelopeFixture(rawEnvelope)],
        ...row,
        shares,
    };
}

function mockSessionByIdRow(row: SessionByIdRowFixture) {
    const fixture = sessionByIdRow(row);
    txSessionFindMany.mockResolvedValue([fixture]);
    return fixture;
}

describe("sessionRoutes v2 session by id", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        txSessionFindMany.mockReset();
    });

    it("preserves the server receipt on message lookup and reconnect catch-up", async () => {
        const inputAdmissionReceipt = { v: 1, issuer: "authenticatedAccount", actorAccountId: "u1", sessionRelationship: "owner" };
        const message = { id: "m1", seq: 1, localId: "l1", sidechainId: null, messageRole: "user",
            content: { t: "encrypted", c: "ciphertext" }, createdAt: new Date(1), updatedAt: new Date(1), inputAdmissionReceipt };
        txSessionMessageFindFirst.mockResolvedValue(message);
        txSessionMessageFindMany.mockResolvedValue([message]);
        txSessionFindUnique.mockResolvedValue({ ...createSessionAccessProjectionRelations(),
            id: "s1", accountId: "u1", seq: 1, currentStorageState: "hosted",
            acceptedThroughServerSeq: null, materializationPublicationId: null,
            materializedThroughSourceAt: null, publishedThroughServerSeq: null,
        });
        const lookup = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");
        expect((await lookup.invoke({ params: { sessionId: "s1", localId: "l1" } })).response)
            .toMatchObject({ message: { inputAdmissionReceipt } });
        const catchup = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        expect((await catchup.invoke({ params: { sessionId: "s1" }, query: { afterSeq: 0 } })).response)
            .toMatchObject({ messages: [{ inputAdmissionReceipt }] });
    });

    it.each([
        ["GET", "/v2/sessions/:sessionId", "session.transcript.get"],
        ["GET", "/v1/sessions/:sessionId/messages", "session.transcript.get"],
        ["GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId", "session.transcript.get"],
        ["GET", "/v1/sessions/:sessionId/turns", "session.transcript.get"],
        ["POST", "/v2/sessions/:sessionId/messages", "session.message.send"],
    ] as const)("declares token Action and exact Session binding for %s %s", async (method, path, actionId) => {
        const route = await createSessionRouteTestBuilder(method, path);
        expect(route.app.routes.get(`${method} ${path}`)?.opts.config).toMatchObject({
            apiTokenSessionAction: actionId,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        });
    });

    it.each([undefined, 1] as const)("projects view-only token capabilities on detail (projection %s)", async (accessProjectionVersion) => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "s1", accountId: "u1", seq: 1, encryptionMode: "e2ee",
            createdAt: now, updatedAt: now, metadata: "metadata", metadataVersion: 1,
            metadataLayoutVersion: 1, ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: null, agentStateVersion: 0, active: true, lastActiveAt: now,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
            pendingCount: 0, pendingVersion: 0, latestTurnId: null, latestTurnStatus: null,
            latestTurnStatusObservedAt: null, lastRuntimeIssue: null, turns: [],
            dataEncryptionKey: Buffer.from([1, 2, 3]), shares: [],
        });
        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response } = await route.invoke({
            authTokenKind: "api_token", authAuthority: "account_automation",
            apiTokenPrincipal: { grant: {
                v: 1, actions: { families: ["session_transcripts"], ids: [] },
                targets: { sessions: ["s1"], machines: [] }, approve: false,
                origins: [], models: null, permissionModes: null, create: null,
            } },
            params: { sessionId: "s1" },
            query: accessProjectionVersion === undefined ? {} : { accessProjectionVersion },
        });
        expect(response).toMatchObject({ session: { effectiveAccess: { capabilities: {
            readTranscript: true, submitAgentInput: false, approveRuntimePermissions: false,
            manageAccess: false,
        } } } });
    });

    it("admits Runner credentials only for their exact materialized Session", async () => {
        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const entry = route.app.routes.get("GET /v2/sessions/:sessionId");
        expect(entry?.opts.config)
            .toMatchObject({ restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } });
        expect(entry?.opts.config?.allowApiToken).toBeUndefined();
        expect(entry?.opts.preHandler).toBe(route.app.authenticate);
    });

    it("returns an operation-scoped update requirement for an unsupported explicit access projection", async () => {
        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response } = await route.invoke({
            params: { sessionId: "s1" },
            query: { accessProjectionVersion: 2 },
        });

        expect(reply.statusCode).toBe(426);
        expect(response).toEqual({
            kind: "update_required",
            operation: "session.detail",
            component: "client",
            reason: "access_projection_version_unsupported",
        });
    });

    it("conceals a Team-only row from bare detail and admits it only through the explicit current projection", async () => {
        const now = new Date(1_000);
        mockSessionByIdRow({
            id: "team-only",
            accountId: "owner",
            seq: 5,
            currentStorageState: "hosted",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            metadata: JSON.stringify({ v: 1 }),
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
            // The fresh readmission row carries the owning Account's current (plain) mode.
            account: { status: "active", encryptionMode: "plain", publicKey: null, contentPublicKey: null, contentPublicKeySig: null },
            agentState: null,
            agentStateVersion: 0,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            turns: [],
            pendingCount: 0,
            pendingBlockedCount: 1,
            pendingVersion: 0,
            active: false,
            lastActiveAt: now,
            shares: [],
            accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 1, unreadSince: now }],
            accountFollows: [{ accountId: "u1", following: true, followPolicy: JSON.stringify({ preset: "important" }) }],
            teamGrants: [{
                teamId: "team-1",
                effectiveAt: new Date(0),
                accessLevel: "edit",
                canApprovePermissions: false,
                requiredByTeamPolicy: false,
                team: {
                    authenticationPolicy: null,
                    memberships: [{ accountId: "u1", role: "member", sessionAccessStartsAt: null }],
                },
            }],
        });
        txAccountFindUnique.mockResolvedValue({
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        const bareRoute = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const bare = await bareRoute.invoke({ params: { sessionId: "team-only" } });
        expect(bare.reply.statusCode).toBe(404);
        expect(bare.response).toEqual({ error: "Session not found" });

        const currentRoute = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const current = await currentRoute.invoke({
            params: { sessionId: "team-only" },
            query: { accessProjectionVersion: 1 },
        });
        expect(current.reply.statusCode).toBe(200);
        // Exact two-stage reader used by the CLI; input comes from the real route/serializer.
        const currentDetail = V2SessionByIdResponseSchema.parse(JSON.parse(JSON.stringify(current.response)));
        expect(SessionCurrentProjectionRecordV1Schema.safeParse(currentDetail.session).success).toBe(true);
        expect(current.response).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "team-only",
                effectiveAccess: expect.objectContaining({
                    level: "edit",
                    sources: [expect.objectContaining({ kind: "team", teamId: "team-1" })],
                }),
                viewer: expect.objectContaining({
                    readState: { state: "tracking", lastViewedSessionSeq: 1, unreadSince: 1_000 },
                    follow: expect.objectContaining({ follows: true }),
                    attention: expect.objectContaining({
                        needsAttention: true,
                        reasons: expect.arrayContaining(["unread", "pending_blocked"]),
                    }),
                }),
            }),
        });
    });

    it.each([true, false])("projects only the viewer's read frontier while Follow is %s", async (following) => {
        const now = new Date(1_000);
        mockSessionByIdRow({
            id: "private-read", accountId: "u2", currentStorageState: "hosted", seq: 9,
            encryptionMode: "e2ee", createdAt: now, updatedAt: now, meaningfulActivityAt: now,
            archivedAt: null, metadata: "opaque", metadataVersion: 0, metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1, agentState: null, agentStateVersion: 0,
            lastViewedSessionSeq: 0,
            accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 3, unreadSince: now }],
            accountFollows: [{ accountId: "u1", following, followPolicy: JSON.stringify({ preset: "important" }) }],
            sessionPins: [], sessionAttentionStandings: [],
            responsibleAccountId: null, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
            latestTurnId: null, latestTurnStatus: null, latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null, latestReadyEventSeq: null,
            turns: [], pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0,
            dataEncryptionKey: null, active: false, lastActiveAt: now,
            shares: [{ id: "direct", accessLevel: "view", canApprovePermissions: false, encryptedDataKey: null }],
        });
        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response } = await route.invoke({ params: { sessionId: "private-read" } });
        // The read frontier is this viewer's own cursor, Follow or not: a cursor row
        // exists because they read the Session, and hiding it would replay what they
        // already saw. Attention stays owner-or-Follow, so a cursor alone never
        // produces a badge.
        expect(response).toMatchObject({ session: {
            lastViewedSessionSeq: 3,
            unreadSince: 1_000,
            viewer: {
                readState: { state: "tracking", lastViewedSessionSeq: 3, unreadSince: 1_000 },
                attention: { needsAttention: following, reasons: following ? ["unread"] : [] },
                relevance: { relevant: true, reasons: following
                    ? ["shared_directly_with_me", "followed_by_me"]
                    : ["shared_directly_with_me"] },
            },
        } });
    });

    it("reads every strict detail projection fact from the admission transaction", async () => {
        const now = new Date(1_000);
        const strictSnapshotRow = mockSessionByIdRow({
            id: "strict-snapshot", accountId: "u1", currentStorageState: "hosted", seq: 1,
            encryptionMode: "plain", createdAt: now, updatedAt: now, meaningfulActivityAt: now,
            archivedAt: null, metadata: "shared", metadataVersion: 0, metadataLayoutVersion: 0,
            ownerMetadata: null, agentState: null, agentStateVersion: 0,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
            latestTurnId: null, latestTurnStatus: null, latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null, latestReadyEventSeq: null, turns: [], pendingCount: 0,
            pendingBlockedCount: 0, pendingVersion: 0, dataEncryptionKey: null,
            active: false, lastActiveAt: now,
            shares: [{ id: "direct", sharedWithUserId: "u1", accessLevel: "view", canApprovePermissions: false }],
        });
        txSessionFindMany.mockResolvedValue([strictSnapshotRow]);
        txSessionShareFindMany.mockResolvedValue([{
            sessionId: "strict-snapshot",
            sharedWithUserId: "u2",
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response } = await route.invoke({
            params: { sessionId: "strict-snapshot" },
            query: { accessProjectionVersion: 1 },
        });

        expect(response).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "strict-snapshot",
                hasOtherNamedCollaborator: true,
            }),
        });
        expect(txSessionShareFindMany).toHaveBeenCalledOnce();
        const detail = V2SessionByIdResponseSchema.parse(JSON.parse(JSON.stringify(response)));
        expect(SessionCurrentProjectionRecordV1Schema.safeParse(detail.session).success).toBe(true);
        expect(txDiscussionFindMany).toHaveBeenCalled();
        expect(sessionShareFindMany).not.toHaveBeenCalled();
        expect(discussionFindMany).not.toHaveBeenCalled();
    });

    it("does not read Account currentness for an owned layout-zero row", async () => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "legacy-owned",
            seq: 1,
            accountId: "u1",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "legacy-owner-metadata",
            metadataVersion: 2,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-agent-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            turns: [],
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: false,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder(
            "GET",
            "/v2/sessions/:sessionId",
        );
        const { response } = await route.invoke({
            params: { sessionId: "legacy-owned" },
        });

        expect(response).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "legacy-owned",
                metadata: "legacy-owner-metadata",
                metadataLayoutVersion: 0,
                agentState: "legacy-owner-agent-state",
            }),
        });
        expect(accountFindUnique).toHaveBeenCalledTimes(FOLLOW_RULE_VIEWER_ACCOUNT_READS);
        expect(V2SessionByIdResponseSchema.safeParse(JSON.parse(JSON.stringify(response))).success).toBe(true);
    });

    it("returns owned session with raw session DEK and share=null", async () => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "s1",
            currentStorageState: "hosted",
            seq: 1,
            accountId: "u1",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "m1",
            metadataVersion: 2,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(1_234),
            lastRuntimeIssue: null,
            turns: [
                {
                    transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 4 }),
                    rollbackState: "eligible",
                },
            ],
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: Buffer.from([1, 2, 3]),
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(txSessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
            }),
        }));
        expect(res).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "s1",
                encryptionMode: "e2ee",
                metadata: "m1",
                ownerMetadata: OWNER_METADATA_ENVELOPE_V1,
                metadataLayoutVersion: 1,
                agentState: "full-owner-agent-state",
                agentStateVersion: 3,
                dataEncryptionKey: "AQID",
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_234,
                rollbackEligibleTurnStarts: [4],
                share: null,
                archivedAt: null,
            }),
        });
        expect(V2SessionByIdResponseSchema.safeParse(res).success).toBe(true);
    });

    it.each([undefined, 1] as const)(
        "projects a verified Runner as a shared recipient despite Account custody (access projection %s)",
        async (accessProjectionVersion) => {
            const now = new Date(1);
            configureMaterializedRunnerCurrentnessFixture();
            mockSessionByIdRow({
                id: "runner-session",
                currentStorageState: "hosted",
                seq: 1,
                accountId: "u1",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "shared-metadata",
                metadataVersion: 2,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                metadataLayoutVersion: 1,
                agentState: "full-owner-agent-state",
                agentStateVersion: 3,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastRuntimeIssue: null,
                turns: [],
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                active: true,
                lastActiveAt: now,
                accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 0, unreadSince: now }],
                accountFollows: [{ accountId: "u1", following: true, followPolicy: JSON.stringify({ preset: "important" }) }],
                sessionPins: [{ accountId: "u1" }],
                sessionAttentionStandings: [{ accountId: "u1", standing: true, remindAt: null }],
                messages: [{ id: "private-account-authorship" }],
                shares: [],
            });

            const route = await createSessionRouteTestBuilder(
                "GET",
                "/v2/sessions/:sessionId",
            );
            const { response } = await route.invoke({
                userId: "u1",
                authTokenKind: "ephemeral_session_runner",
                authAuthority: "account_automation",
                sessionRuntimePrincipal: {
                    kind: "ephemeral_session_runner",
                    authority: "session_runtime",
                    accountId: "u1",
                    activationId: "00000000-0000-4000-8000-000000000001",
                    sessionId: "runner-session",
                    machineId: "machine-1",
                    installationId: "installation-1",
                    installationPublicKey: RUNNER_INSTALLATION_PUBLIC_KEY,
                    creatorTokenEpoch: 1,
                },
                params: { sessionId: "runner-session" },
                query: accessProjectionVersion === undefined
                    ? undefined
                    : { accessProjectionVersion },
                headers: { "x-happier-account-stored-content-protocol": "2" },
            });

            expect(response).toEqual({
                session: expect.objectContaining({
                    id: "runner-session",
                    metadata: "shared-metadata",
                    metadataLayoutVersion: 1,
                    agentState: null,
                    agentStateVersion: 3,
                }),
            });
            if (!response || typeof response !== "object" || !("session" in response)) {
                throw new Error("Expected a session response");
            }
            expect(response.session).not.toHaveProperty("ownerMetadata");
            expect(response.session).not.toHaveProperty("viewer");
            expect(response.session).not.toHaveProperty("lastViewedSessionSeq");
            expect(response.session).not.toHaveProperty("unreadSince");
            expect(JSON.stringify(response.session)).not.toMatch(
                /full-owner-agent-state|oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0\+8\+YDECLScN6uQTItPyWVR7XbQA==/,
            );
            expect(txAccountFindUnique).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: "u1" },
            }));
            expect(txEphemeralRunnerActivationFindFirst).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({
                    id: "00000000-0000-4000-8000-000000000001",
                    sessionId: "runner-session",
                    machineId: "machine-1",
                    state: "materialized",
                }),
            }));
            expect(txSessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: "runner-session", accountId: "u1" },
            }));
            expect(txMachineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({
                    id: "machine-1",
                    installationId: "installation-1",
                    revokedAt: null,
                    replacedByMachineId: null,
                }),
            }));
            expect(txAccessKeyFindUnique).toHaveBeenCalledWith(expect.objectContaining({
                where: { accountId_machineId_sessionId: {
                    accountId: "u1",
                    machineId: "machine-1",
                    sessionId: "runner-session",
                } },
            }));
            expect(txDiscussionFindMany).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["revoked activation", { activation: null }],
        ["wrong Session", { session: null }],
        ["replaced Machine", { machine: null }],
        ["changed Machine public key", { installationPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
        ["missing AccessKey", { accessKey: null }],
        ["token-epoch mismatch", { tokenEpoch: 2 }],
    ] as const)("conceals Runner detail after %s", async (_name, currentness) => {
        const now = new Date(1);
        configureMaterializedRunnerCurrentnessFixture(currentness);
        mockSessionByIdRow({
            id: "runner-session",
            accountId: "u1",
            seq: 1,
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            metadata: "shared-metadata",
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            turns: [],
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response } = await route.invoke({
            userId: "u1",
            authTokenKind: "ephemeral_session_runner",
            authAuthority: "account_automation",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                accountId: "u1",
                activationId: "00000000-0000-4000-8000-000000000001",
                sessionId: "runner-session",
                machineId: "machine-1",
                installationId: "installation-1",
                installationPublicKey: RUNNER_INSTALLATION_PUBLIC_KEY,
                creatorTokenEpoch: 1,
            },
            params: { sessionId: "runner-session" },
            query: { accessProjectionVersion: 1 },
        });

        expect(reply.statusCode).toBe(404);
        expect(response).toEqual({ error: "Session not found" });
    });

    it("preserves the canonical operational facts from the list projection", async () => {
        const now = new Date(1_500);
        mockSessionByIdRow({
            id: "operational", accountId: "u1", seq: 8,
            currentStorageState: "hosted", encryptionMode: "e2ee",
            createdAt: now, updatedAt: now, meaningfulActivityAt: now, archivedAt: null,
            metadata: "encrypted", metadataVersion: 1, metadataLayoutVersion: 0,
            ownerMetadata: null, agentState: null, agentStateVersion: 0,
            lastViewedSessionSeq: 3, pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 2, pendingRequestObservedAt: now,
            latestTurnId: "turn", latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(1_500), lastRuntimeIssue: null,
            runtimeActivityState: "active", runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: BigInt(1_500), runtimeActivityRevision: BigInt(3),
            latestReadyEventSeq: 8, latestReadyEventAt: now,
            thinking: true, thinkingAt: new Date(1_000),
            pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1,
            dataEncryptionKey: null, active: true, lastActiveAt: now, shares: [], turns: [],
            responsibleAccountId: "u1",
            responsibleAccount: {
                id: "u1",
                firstName: null,
                lastName: null,
                username: null,
                avatar: null,
            },
        });
        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response } = await route.invoke({ params: { sessionId: "operational" } });
        expect(response).toEqual({ observationCursor: 0, session: expect.objectContaining({
            pendingRequestObservedAt: 1_500,
            runtimeActivityState: "active", runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 1_500, runtimeActivityRevision: 3,
            latestReadyEventSeq: 8, latestReadyEventAt: 1_500,
            thinking: false, thinkingAt: 1_500, responsibleAccountId: "u1",
        }) });
        expect(txSessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({ pendingRequestObservedAt: true,
                runtimeActivityState: true, latestReadyEventSeq: true, thinking: true }),
        }));
    });

    it("falls back when rollback turn columns are unavailable", async () => {
        const now = new Date(1);
        txSessionFindMany
            .mockRejectedValueOnce(Object.assign(new Error("Column SessionTurn.rollbackState does not exist"), { code: "P2022" }))
            .mockResolvedValue([sessionByIdRow({
                id: "s1",
                seq: 9,
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "u1",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                meaningfulActivityAt: now,
                archivedAt: null,
                metadata: "m1",
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 3,
                lastViewedSessionSeq: 9,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: BigInt(1_234),
                lastRuntimeIssue: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                pendingCount: 0,
                pendingVersion: 0,
                active: true,
                lastActiveAt: now,
                shares: [],
            })]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        // The released fallback preserves the storage projection while omitting unavailable turn columns.
        expect(txSessionFindMany.mock.calls[1]?.[0]?.select).not.toHaveProperty("turns");
        expect(txSessionFindMany.mock.calls[1]?.[0]?.select).toEqual(expect.objectContaining({
            currentStorageState: true,
            acceptedThroughServerSeq: true,
            materializationPublicationId: true,
            materializedThroughSourceAt: true,
            publishedThroughServerSeq: true,
        }));
        expect(res).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "s1",
                seq: 4,
                lastViewedSessionSeq: 4,
            }),
        });
        if (!res || typeof res !== "object" || !("session" in res)) {
            throw new Error("Expected a session response");
        }
        expect(res.session).toMatchObject({
            id: "s1",
            rollbackEligibleTurnStarts: [],
        });
        for (const field of PRIVATE_LIVE_SESSION_PROJECTION_FIELDS) {
            expect(res.session).not.toHaveProperty(field);
        }
    });

    it("does not apply the released projection fallback to explicit current detail", async () => {
        const now = new Date(1);
        const row = sessionByIdRow({
            id: "strict-no-fallback",
            seq: 1,
            accountId: "u1",
            currentStorageState: "hosted",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            metadata: "{}",
            metadataVersion: 0,
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            turns: [],
            pendingCount: 0,
            pendingVersion: 0,
            active: false,
            lastActiveAt: now,
            shares: [],
        });
        const missingColumn = Object.assign(
            new Error("Column SessionTurn.rollbackState does not exist"),
            { code: "P2022" },
        );
        txSessionFindMany.mockRejectedValueOnce(missingColumn).mockResolvedValueOnce([row]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        await expect(route.invoke({
            params: { sessionId: "strict-no-fallback" },
            query: { accessProjectionVersion: 1 },
        })).rejects.toBe(missingColumn);
    });

    it("returns shared session with share DEK and share info", async () => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "s2",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 1,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [
                {
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "edit",
                    canApprovePermissions: true,
                },
            ],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s2" } });

        expect(res).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "s2",
                encryptionMode: "e2ee",
                metadata: "m2",
                metadataLayoutVersion: 1,
                dataEncryptionKey: "BAU=",
                lastViewedSessionSeq: 2,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                share: { accessLevel: "edit", canApprovePermissions: true },
                archivedAt: null,
            }),
        });
        expect(V2SessionByIdResponseSchema.safeParse(res).success).toBe(true);
        if (!res || typeof res !== "object" || !("session" in res)) {
            throw new Error("Expected a session response");
        }
        expect(res.session).not.toHaveProperty("ownerMetadata");
        expect(res.session).toMatchObject({
            agentState: null,
            agentStateVersion: 7,
        });
        expect(JSON.stringify(res.session)).not.toMatch(
            /oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0\+8\+YDECLScN6uQTItPyWVR7XbQA==|full-owner-agent-state/,
        );
    });

    it("refuses shared detail disclosure when the owning plain Account has an encrypted owner envelope", async () => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "s2",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            account: {
                status: "active", encryptionMode: "plain", publicKey: null,
                contentPublicKey: null, contentPublicKeySig: null,
            },
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [{
                encryptedDataKey: Buffer.from([4, 5]),
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        });

        const route = await createSessionRouteTestBuilder(
            "GET",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s2" },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
    });

    it("refuses a released layout-zero shared by-id projection until owner migration", async () => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "legacy-shared",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "legacy-whole-bag",
            metadataVersion: 1,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [
                {
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            ],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "legacy-shared" } });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(txSessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                accountId: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            }),
        }));
    });

    it.each(["machine_only", "server_partial"] as const)(
        "returns not found to a shared viewer while transcript storage is %s",
        async (currentStorageState) => {
            const now = new Date(1);
            mockSessionByIdRow({
                id: "s2",
                seq: 2,
                currentStorageState,
                acceptedThroughServerSeq: currentStorageState === "server_partial" ? 1 : null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "owner",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m2",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: null,
                active: false,
                lastActiveAt: now,
                shares: [{
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "view",
                    canApprovePermissions: false,
                }],
            });

            const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
            const { reply } = await route.invoke({ params: { sessionId: "s2" } });

            expect(reply.code).toHaveBeenCalledWith(404);
            expect(reply.send).toHaveBeenCalledWith({ error: "Session not found" });
        },
    );

    it.each([
        {
            name: "hosted",
            publication: {
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 9,
            recency: 9_000,
            rollbackStarts: [4, 5],
            retainsLiveFacts: true,
        },
        {
            name: "machine-only",
            publication: {
                currentStorageState: "machine_only",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 0,
            recency: 1_000,
            rollbackStarts: [],
            retainsLiveFacts: false,
        },
        {
            name: "initial partial",
            publication: {
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 4,
            recency: 1_000,
            rollbackStarts: [4],
            retainsLiveFacts: false,
        },
        {
            name: "published snapshot with private post-publication activity",
            publication: {
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 9,
                materializationPublicationId: "publication-4",
                materializedThroughSourceAt: BigInt(4_000),
                publishedThroughServerSeq: 4,
            },
            ceiling: 4,
            recency: 4_000,
            rollbackStarts: [4],
            retainsLiveFacts: false,
        },
        {
            name: "legacy external unknown",
            publication: {
                currentStorageState: "legacy_external_unknown",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 0,
            recency: 1_000,
            rollbackStarts: [],
            retainsLiveFacts: false,
        },
    ] as const)(
        "GET /v2/sessions/:sessionId projects no private live fact while storage is $name",
        async ({ publication, ceiling, recency, rollbackStarts, retainsLiveFacts }) => {
            mockSessionByIdRow({
                id: "external-preview",
                seq: 9,
                accountId: "u1",
                encryptionMode: "plain",
                createdAt: new Date(1_000),
                updatedAt: new Date(9_000),
                meaningfulActivityAt: new Date(9_000),
                archivedAt: null,
                metadata: "owner-metadata",
                metadataVersion: 1,
                ownerMetadata: null,
                metadataLayoutVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 8,
                accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 8, unreadSince: null }],
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 3,
                pendingRequestObservedAt: new Date(9_000),
                pendingCount: 4,
                pendingBlockedCount: 5,
                pendingVersion: 6,
                latestTurnId: "turn-at-nine",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: BigInt(9_000),
                lastRuntimeIssue: JSON.stringify({
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "usage_limit",
                    source: "usage_limit",
                    occurredAt: 9_000,
                }),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(9_000),
                runtimeActivityRevision: BigInt(9),
                thinking: true,
                thinkingAt: new Date(9_000),
                active: true,
                lastActiveAt: new Date(9_000),
                dataEncryptionKey: null,
                turns: [
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 4 }),
                        rollbackState: "eligible",
                    },
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 5 }),
                        rollbackState: "eligible",
                    },
                ],
                shares: [],
                ...publication,
            });

            const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
            const { response } = await route.invoke({ params: { sessionId: "external-preview" } });
            if (!response || typeof response !== "object" || !("session" in response)) {
                throw new Error("Expected a session response");
            }
            const session = V2SessionByIdResponseSchema.parse(response).session;

            expect(session).toMatchObject({
                seq: ceiling,
                lastViewedSessionSeq: Math.min(8, ceiling),
                updatedAt: recency,
                meaningfulActivityAt: recency,
                activeAt: recency,
                rollbackEligibleTurnStarts: rollbackStarts,
                acceptedThroughServerSeq: publication.acceptedThroughServerSeq === null
                    ? null
                    : Math.min(publication.acceptedThroughServerSeq, ceiling),
            });

            if (retainsLiveFacts) {
                expect(session).toMatchObject({
                    active: true,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 3,
                    pendingRequestObservedAt: 9_000,
                    pendingCount: 4,
                    pendingBlockedCount: 5,
                    pendingVersion: 6,
                    latestTurnId: "turn-at-nine",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 9_000,
                    lastRuntimeIssue: expect.objectContaining({ code: "usage_limit" }),
                    thinking: true,
                    thinkingAt: 9_000,
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 9_000,
                    runtimeActivityRevision: 9,
                });
                return;
            }

            expect(session.active).toBe(false);
            for (const field of PRIVATE_LIVE_SESSION_PROJECTION_FIELDS) {
                expect(session).not.toHaveProperty(field);
            }
        },
    );

    it("returns stored pending state without reconciling pending rows", async () => {
        const now = new Date(1);
        mockSessionByIdRow({
            id: "s-drift",
            currentStorageState: "hosted",
            seq: 2,
            accountId: "u1",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            turns: [],
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 4,
            active: true,
            lastActiveAt: now,
            shares: [],
        });
        sessionPendingMessageCount.mockResolvedValue(2);
        sessionUpdate.mockResolvedValue({ pendingCount: 2, pendingVersion: 5 });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s-drift" } });

        expect(sessionPendingMessageCount).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(res).toEqual({
            observationCursor: 0,
            session: expect.objectContaining({
                id: "s-drift",
                pendingCount: 0,
                pendingVersion: 4,
            }),
        });
    });

    it("returns 404 when session is not accessible", async () => {
        txSessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "missing" } });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
    });
});
