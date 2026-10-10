import { verifySparseSessionListing } from "./sparseListing.test-support";
import { verifyFolderSessionListing } from "./folderListing.test-support";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import {
    createSessionListScopeWhere,
    createSessionPersonalAttentionQueryInTx,
} from "@/app/session/personal/queries";
import { loadSessionViewerProjection } from "@/app/session/personal/projection";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import {
    createV2SessionListRowPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    readSessionListOtherNamedCollaboratorFacts,
    readSessionListViewerDiscussionFacts,
    resolveV2SessionListCursorForVisibleRows,
    V2_SESSION_LIST_ORDER_BY,
} from "@/app/session/listing/page";
import {
    decodeV2SessionListCursorV2,
    encodeV2SessionListCursorV1,
    SessionListQueryResponseV1Schema,
} from "@happier-dev/protocol";
import { createV2SessionAttentionPage, createV2SessionListInitialPage } from "./initialPage";
import { readSessionMetadataOwnerAccountModes } from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { computeAccountActivityBadgeCounts } from "@/app/activity/accountActivityBadge";
import { loadSessionDiscussionAttentionForAccounts } from "@/app/session/discussions/attentionFacts";
import { listSessionsForAccount, readSessionListOwnerAccountModes } from "./service";
import {
    conjoinSessionListWhereInputs,
    createSessionListStorageWhere,
    createSessionViewerTagWhere,
} from "./query";
import { createV2SessionListServerTiming } from "./timing";

const authentication = createPresentUserSessionAccessAuthentication();

describe("Session listing predicate composition (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-list-composition-",
            initAuth: false,
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1" },
        });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => vi.unstubAllEnvs());

    it("filters exact folder ANY and tag ANY together before stable cursor paging", async () => {
        await verifyFolderSessionListing();
    });

    async function fixture() {
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const create = (tag: string) => db.session.create({ data: {
            accountId: owner.id, tag, metadata: '{"v":1}', encryptionMode: "plain",
            metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
            meaningfulActivityAt: new Date(2_000),
        } });
        const shared = await create(randomUUID());
        const foreign = await create(randomUUID());
        await db.sessionShare.create({ data: {
            sessionId: shared.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: "view",
        } });
        return { viewer, owner, shared, foreign };
    }

    it("bounds supplemental attention scans and advances continuation over rejected candidates", async () => {
        const { viewer, owner, shared } = await fixture();
        await db.session.update({ where: { id: shared.id }, data: { pendingBlockedCount: 1 } });
        await db.session.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            meaningfulActivityAt: new Date(3_000 + index), latestTurnStatus: "failed",
            lastRuntimeIssue: "not a canonical primary failure",
        })) });
        const startedAt = performance.now();
        const ownerPage = await createV2SessionAttentionPage({ authentication,
            userId: owner.id, where: { accountId: owner.id }, candidateLimit: 200,
        });
        expect(ownerPage.rows).toEqual([]);
        expect(ownerPage.attentionHasNext).toBe(true);
        const examinedCursor = decodeV2SessionListCursorV2(ownerPage.attentionNextCursor ?? "");
        expect(examinedCursor).not.toBeNull();
        const ownerContinuation = await createV2SessionAttentionPage({ authentication,
            userId: owner.id,
            where: { accountId: owner.id },
            cursor: examinedCursor ?? undefined,
            candidateLimit: 200,
        });
        expect(ownerContinuation.rows.map((row) => row.id)).toEqual([shared.id]);
        expect(ownerContinuation.attentionHasNext).toBe(false);
        console.info(`Personal attention query: 301 owned candidates, one sparse result over two bounded scans, ${(performance.now() - startedAt).toFixed(1)} ms`);
        const viewerPage = await createV2SessionAttentionPage({ authentication,
            userId: viewer.id, where: { id: shared.id }, candidateLimit: 1,
        });
        expect(viewerPage.rows).toEqual([]);
        expect(viewerPage.attentionHasNext).toBe(false);
    });

    it("does not treat direct access as Following before pagination", async () => {
        const { viewer, shared } = await fixture();
        const rows = await inTx(async (tx) => findV2SessionListRows({
            userId: viewer.id, where: { id: shared.id },
            source: { kind: "effective", reader: tx, accessMode: "effective_access_v1", allowProjectionFallback: false, baseWhere: { AND: [
                await buildSessionAccessWhere({
                    tx,
                    accountId: viewer.id,
                    capability: "readTranscript",
                    mode: "effective_access_v1",
                    authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
                }),
                createSessionListScopeWhere({ accountId: viewer.id, scope: "following" }),
            ] } },
            orderBy: V2_SESSION_LIST_ORDER_BY, take: 1,
        }));
        expect(rows).toEqual([]);
    });

    it("uses effective Team access when the V2 list has no precompiled source", async () => {
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `listing-team-${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
            meaningfulActivityAt: new Date(2_000),
        } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });

        const rows = await findV2SessionListRows({
            userId: viewer.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            where: { id: session.id },
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 1,
        });
        expect(rows.map((row) => row.id)).toEqual([session.id]);
    });

    it("applies effective access and structural scope before a filtered page", async () => {
        const { viewer, shared, foreign } = await fixture();
        await db.session.updateMany({
            where: { id: { in: [shared.id, foreign.id] } },
            data: { responsibleAccountId: viewer.id },
        });

        const page = await listSessionsForAccount({
            userId: viewer.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            source: {
                kind: "query",
                query: {
                    v: 1,
                    storage: "active",
                    includeInactive: true,
                    scope: "assigned_to_me",
                    attention: "any",
                    audiences: [],
                    tagIds: [],
                    limit: 1,
                },
            },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        });

        expect(page).toMatchObject({
            sessions: [{
                id: shared.id,
                responsibleAccountId: viewer.id,
                responsibleAccount: { kind: "account", accountId: viewer.id },
            }],
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: null,
            attentionHasNext: false,
        });
    });

    it("preserves the requested limit on a strict-query attention continuation", async () => {
        const owner = await db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        });
        const sessions = await Promise.all([3_000, 2_000, 1_000].map((meaningfulActivityAt) =>
            db.session.create({
                data: {
                    accountId: owner.id,
                    tag: randomUUID(),
                    metadata: '{"v":1}',
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    ownerMetadata: '{"t":"plain","v":{"v":1}}',
                    meaningfulActivityAt: new Date(meaningfulActivityAt),
                    pendingBlockedCount: 1,
                },
            }),
        ));

        const page = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
            userId: owner.id,
            authentication,
            source: {
                kind: "query",
                query: {
                    v: 1,
                    storage: "active",
                    includeInactive: true,
                    scope: "my_work",
                    attention: "any",
                    audiences: [],
                    tagIds: [],
                    attentionCursor: encodeV2SessionListCursorV1(sessions[0].id),
                    limit: 1,
                },
            },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        }));

        expect(page.sessions).toHaveLength(1);
        expect(page.sessions[0]?.id).toBe(sessions[1].id);
        expect(page).toMatchObject({
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: expect.any(String),
            attentionHasNext: true,
        });

        const finalPage = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
            userId: owner.id,
            authentication,
            source: {
                kind: "query",
                query: {
                    v: 1,
                    storage: "active",
                    includeInactive: true,
                    scope: "my_work",
                    attention: "any",
                    audiences: [],
                    tagIds: [],
                    attentionCursor: page.attentionNextCursor ?? undefined,
                    limit: 1,
                },
            },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        }));
        expect(finalPage.sessions.map((session) => session.id)).toEqual([sessions[2].id]);
        expect(finalPage).toMatchObject({
            attentionNextCursor: null,
            attentionHasNext: false,
        });
    });

    it("keeps every strict-query dependent read on the listing transaction reader", async () => {
        const { viewer, shared } = await fixture();
        const team = await db.team.create({ data: { name: `snapshot-team-${randomUUID()}` } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: viewer.id, role: "member" },
        });
        await db.sessionTeamGrant.create({
            data: {
                sessionId: shared.id,
                teamId: team.id,
                accessLevel: "view",
                effectiveAt: new Date(0),
            },
        });
        const tag = await db.sessionOrganizationTag.create({
            data: { accountId: viewer.id, tagKey: randomUUID(), tagHash: randomUUID() },
        });
        await db.sessionTagAssignment.create({
            data: { accountId: viewer.id, sessionId: shared.id, tagId: tag.id },
        });
        await db.accountSessionFollow.create({
            data: {
                accountId: viewer.id,
                sessionId: shared.id,
                following: true,
                notificationLevel: "important",
            },
        });
        await db.accountSessionReadState.create({
            data: { accountId: viewer.id, sessionId: shared.id, lastViewedSessionSeq: 1 },
        });
        await db.session.update({
            where: { id: shared.id },
            data: { responsibleAccountId: viewer.id, seq: 5 },
        });

        const readMethods = new Set([
            "aggregate",
            "count",
            "findFirst",
            "findFirstOrThrow",
            "findMany",
            "findUnique",
            "findUniqueOrThrow",
            "groupBy",
        ]);
        const modelNames = [
            "account",
            "accountSessionFollow",
            "accountSessionReadState",
            "session",
            "sessionAttentionStanding",
            "sessionDiscussion",
            "sessionDiscussionMessage",
            "sessionGroupGrant",
            "sessionMessage",
            "sessionPin",
            "sessionShare",
            "sessionTagAssignment",
            "sessionTeamGrant",
            "teamGroupMembership",
            "teamMembership",
        ] as const;
        const transactionReads = new Set<string>();
        let snapshotClient: unknown;
        const restoreObserver = observeSqliteRequests({
            before: (request) => {
                if (request.action === "executeRaw" && request.args && typeof request.args === "object"
                    && "query" in request.args && request.args.query === "BEGIN DEFERRED;") {
                    snapshotClient = request.client;
                }
                const model = request.model && request.model[0]!.toLowerCase() + request.model.slice(1);
                if (model && modelNames.some(name => name === model) && readMethods.has(request.action)) {
                    if (request.client !== snapshotClient) {
                        throw new Error(`Strict Session listing escaped its read snapshot through ${model}.${request.action}`);
                    }
                    transactionReads.add(`${model}.${request.action}`);
                }
            },
        });

        try {
            const page = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
                userId: viewer.id,
                authentication,
                source: {
                    kind: "query",
                    query: {
                        v: 1,
                        storage: "active",
                        includeInactive: true,
                        scope: "assigned_to_me",
                        attention: "needs_my_attention",
                        audiences: [{ kind: "team", teamId: team.id }],
                        tagIds: [tag.id],
                        limit: 1,
                    },
                },
                rowRepresentabilityWhere: {},
                timing: createV2SessionListServerTiming({}),
            }));

            expect(page.sessions.map((session) => session.id)).toEqual([shared.id]);
            expect([...transactionReads]).toEqual(expect.arrayContaining([
                "account.findUnique",
                "session.findMany",
                "sessionDiscussion.findMany",
                "sessionShare.findMany",
                "teamMembership.findMany",
            ]));
        } finally {
            restoreObserver();
        }
    });

    it("projects one safe other-collaborator signal per listed Session for both viewer roles", async () => {
        const { viewer, owner, shared, foreign } = await fixture();
        const query = {
            v: 1 as const,
            storage: "active" as const,
            includeInactive: true,
            scope: "all_accessible" as const,
            attention: "any" as const,
            audiences: [],
            tagIds: [],
            limit: 50,
        };
        const ownerPage = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
            userId: owner.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            source: { kind: "query", query },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        }));
        const ownerRows = new Map(ownerPage.sessions.map((row) => [row.id, row.hasOtherNamedCollaborator]));
        // A shared Session reports its other current audience member without
        // exposing identities, presence, or the grant roster.
        expect(ownerRows.get(shared.id)).toBe(true);
        // A solo owned Session is evaluated and reported quiet, not omitted.
        expect(ownerRows.get(foreign.id)).toBe(false);

        const viewerPage = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
            userId: viewer.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            source: { kind: "query", query },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        }));
        expect(viewerPage.sessions.map((row) => row.id)).toEqual([shared.id]);
        expect(viewerPage.sessions.map((row) => row.hasOtherNamedCollaborator)).toEqual([true]);
    });

    it("finds a tagged assigned row below 205 newer nonmatches and continues once across overlapping grants", async () => {
        const { viewer, owner } = await fixture();
        const tag = await db.sessionOrganizationTag.create({
            data: {
                accountId: viewer.id,
                tagKey: randomUUID(),
                tagHash: randomUUID(),
            },
        });
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({
            data: {
                teamId: team.id,
                accountId: viewer.id,
                role: "member",
                sessionAccessStartsAt: null,
            },
        });
        const createMatch = async (meaningfulActivityAt: Date) => {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    responsibleAccountId: viewer.id,
                    tag: randomUUID(),
                    metadata: '{"v":1}',
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    ownerMetadata: '{"t":"plain","v":{"v":1}}',
                    meaningfulActivityAt,
                },
            });
            await db.sessionShare.create({
                data: {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: viewer.id,
                    accessLevel: "view",
                },
            });
            await db.sessionTeamGrant.create({
                data: {
                    sessionId: session.id,
                    teamId: team.id,
                    accessLevel: "view",
                    requiredByTeamPolicy: true,
                    effectiveAt: new Date(0),
                },
            });
            await db.sessionTagAssignment.create({
                data: {
                    accountId: viewer.id,
                    sessionId: session.id,
                    tagId: tag.id,
                },
            });
            return session;
        };
        const sparseMatch = await createMatch(new Date(1_000));
        const continuationMatch = await createMatch(new Date(500));
        const outsideAudience = await createMatch(new Date(1_500));
        await db.sessionTeamGrant.deleteMany({ where: { sessionId: outsideAudience.id } });
        await db.session.createMany({
            data: Array.from({ length: 205 }, (_, index) => ({
                accountId: viewer.id,
                responsibleAccountId: viewer.id,
                tag: randomUUID(),
                metadata: "{}",
                encryptionMode: "plain",
                meaningfulActivityAt: new Date(2_000 + index),
            })),
        });

        const query = {
            v: 1 as const,
            storage: "active" as const,
            includeInactive: true,
            scope: "assigned_to_me" as const,
            attention: "any" as const,
            audiences: [{ kind: "team" as const, teamId: team.id }],
            tagIds: [tag.id],
            limit: 1,
        };
        const first = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
            userId: viewer.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            source: { kind: "query", query },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        }));

        expect(first.sessions).toHaveLength(1);
        expect(first.sessions[0]).toMatchObject({
            id: sparseMatch.id,
            share: { accessLevel: "view", canApprovePermissions: false },
            effectiveAccess: {
                v: 1,
                sources: expect.arrayContaining([
                    expect.objectContaining({ kind: "direct" }),
                    expect.objectContaining({ kind: "team", teamId: team.id }),
                ]),
            },
        });
        expect(first.hasNext).toBe(true);
        expect(first.nextCursor).toEqual(expect.any(String));

        const second = SessionListQueryResponseV1Schema.parse(await listSessionsForAccount({
            userId: viewer.id,
            authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            source: {
                kind: "query",
                query: { ...query, cursor: first.nextCursor ?? undefined },
            },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        }));
        expect(second.sessions.map((row) => row.id)).toEqual([continuationMatch.id]);
        expect(second).toMatchObject({ hasNext: false, nextCursor: null });
    });

    /**
     * Lane 07 R18 / 07.2 §11 measurement on the extracted listing owner. It
     * records the fixture shape, the access-path statement count, a successful
     * 200-selector bind probe, and
     * first/continued page cost for the new query against the incumbent route
     * on the same fixture. No latency threshold or corpus ceiling is asserted:
     * the recorded costs are the input to the index/cache/SQL decision.
     */
    it("measures sparse-match query and continuation cost against the incumbent route on one fixture", async () => {
        await verifySparseSessionListing("sqlite");
    }, 180_000);

    it("counts the private viewer frontier instead of the retired shared cursor", async () => {
        const { owner, shared } = await fixture();
        await db.session.update({ where: { id: shared.id }, data: { seq: 9 } });
        await db.accountSessionReadState.create({ data: { accountId: owner.id, sessionId: shared.id, lastViewedSessionSeq: 9 } });
        expect((await computeAccountActivityBadgeCounts([owner.id])).get(owner.id)).toBe(0);
    });

    it("counts requested Accounts together without turning broad Team access into a badge", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const teamReader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `badge-team-${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: teamReader.id, role: "member" } });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            seq: 4,
            pendingBlockedCount: 1,
        } });
        await db.accountSessionReadState.create({ data: {
            accountId: owner.id,
            sessionId: session.id,
            lastViewedSessionSeq: 4,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(0),
        } });

        expect(await computeAccountActivityBadgeCounts([owner.id, teamReader.id])).toEqual(new Map([
            [owner.id, 1],
            [teamReader.id, 0],
        ]));
    });

    it("composes archived storage with personal attention instead of suppressing the archived corpus", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const create = (archivedAt: Date | null) => db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            archivedAt,
            seq: 5,
            meaningfulActivityAt: new Date(2_000),
        } });
        const archived = await create(new Date(3_000));
        const active = await create(null);
        await db.accountSessionReadState.createMany({ data: [archived, active].map(session => ({
            accountId: owner.id,
            sessionId: session.id,
            lastViewedSessionSeq: 1,
        })) });

        const page = await listSessionsForAccount({
            userId: owner.id,
            authentication,
            source: { kind: "query", query: {
                v: 1,
                storage: "archived",
                includeInactive: true,
                scope: "all_accessible",
                attention: "needs_my_attention",
                audiences: [],
                tagIds: [],
                limit: 50,
            } },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        });

        if (!page) {
            throw new Error("Expected an archived Session listing page");
        }
        expect(page.sessions.map(session => session.id)).toEqual([archived.id]);
        expect(page.sessions[0]?.viewer?.attention).toMatchObject({
            needsAttention: true,
            reasons: ["unread"],
        });
    });

    it("keeps an inactive row that needs attention and drops a quiet inactive row for includeInactive:false", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const create = (active: boolean, activityAt: number) => db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            active,
            seq: 5,
            meaningfulActivityAt: new Date(activityAt),
        } });
        const activeRow = await create(true, 3_000);
        const inactiveUnread = await create(false, 2_000);
        const inactiveRead = await create(false, 1_000);
        await db.accountSessionReadState.createMany({ data: [
            { accountId: owner.id, sessionId: activeRow.id, lastViewedSessionSeq: 5 },
            { accountId: owner.id, sessionId: inactiveUnread.id, lastViewedSessionSeq: 1 },
            { accountId: owner.id, sessionId: inactiveRead.id, lastViewedSessionSeq: 5 },
        ] });

        const page = await listSessionsForAccount({
            userId: owner.id,
            authentication,
            source: { kind: "query", query: {
                v: 1,
                storage: "active",
                includeInactive: false,
                scope: "all_accessible",
                attention: "any",
                audiences: [],
                tagIds: [],
                limit: 50,
            } },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        });

        if (!page) {
            throw new Error("Expected an active Session listing page");
        }
        // The corpus predicate is `active OR needs attention`: this is the server proof
        // the client relies on when it stops re-filtering strict-query rows locally.
        expect(page.sessions.map(session => session.id)).toEqual([activeRow.id, inactiveUnread.id]);
        expect(page.sessions[1]?.viewer?.attention).toMatchObject({
            needsAttention: true,
            reasons: ["unread"],
        });
        expect(page.sessions.some(session => session.id === inactiveRead.id)).toBe(false);
    });

    it("treats a stored-active row whose transcript is not hosted as inactive for includeInactive:false", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const create = (currentStorageState: string, activityAt: number) => db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            active: true,
            seq: 5,
            currentStorageState,
            meaningfulActivityAt: new Date(activityAt),
        } });
        const hosted = await create("hosted", 3_000);
        const machineOnly = await create("machine_only", 2_000);
        await db.accountSessionReadState.createMany({ data: [
            { accountId: owner.id, sessionId: hosted.id, lastViewedSessionSeq: 5 },
            { accountId: owner.id, sessionId: machineOnly.id, lastViewedSessionSeq: 5 },
        ] });

        const page = await listSessionsForAccount({
            userId: owner.id,
            authentication,
            source: { kind: "query", query: {
                v: 1,
                storage: "active",
                includeInactive: false,
                scope: "all_accessible",
                attention: "any",
                audiences: [],
                tagIds: [],
                limit: 50,
            } },
            rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}),
        });

        if (!page) {
            throw new Error("Expected an active Session listing page");
        }
        // Selection and projection must state one liveness: a row this page would
        // render `active: false` must not be admitted by "Hide inactive".
        expect(page.sessions.map(session => session.id)).toEqual([hosted.id]);
    });

    it("admits tracked discussion unread and mentions to attention and badge, and stays quiet otherwise", async () => {
        const { viewer, owner, shared, foreign } = await fixture();
        await db.sessionShare.create({ data: {
            sessionId: foreign.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: "view",
        } });
        // Tracking is Follow, not access: only `shared` may ever be loud.
        await db.accountSessionFollow.create({ data: {
            sessionId: shared.id, accountId: viewer.id, following: true, notificationLevel: "important",
        } });
        await db.accountSessionReadState.create({ data: {
            sessionId: shared.id, accountId: viewer.id, lastViewedSessionSeq: 0,
        } });

        const conversation = async (sessionId: string) => await db.sessionDiscussion.create({ data: {
            sessionId, creationLocalId: randomUUID(), creationEqualityEvidenceV1: { kind: "plainDigest", digest: "d" },
            createdByAccountId: owner.id, titleContent: { t: "plain", v: { v: 1, title: "Rollout" } },
            messageSeq: 1, lastMessageAt: new Date(4_000),
        } });
        const post = async (discussion: { id: string; sessionId: string }) => {
            const message = await db.sessionDiscussionMessage.create({ data: {
                sessionId: discussion.sessionId, discussionId: discussion.id, localId: randomUUID(),
                requestEqualityEvidenceV1: { kind: "plainDigest", digest: "d" }, seq: 1,
                authorAccountId: owner.id,
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "look" }] } },
            } });
            await db.sessionDiscussionMessageMention.create({ data: { messageId: message.id, accountId: viewer.id } });
        };

        const tracked = await conversation(shared.id);
        await post(tracked);
        await db.sessionDiscussionReadState.create({ data: {
            discussionId: tracked.id, accountId: viewer.id, lastReadSeq: 0,
        } });
        // Same unread shape on a Session the viewer only browses.
        const browsed = await conversation(foreign.id);
        await post(browsed);
        await db.sessionDiscussionReadState.create({ data: {
            discussionId: browsed.id, accountId: viewer.id, lastReadSeq: 0,
        } });

        const where = { id: { in: [shared.id, foreign.id] } };
        const page = await createV2SessionAttentionPage({ authentication,  userId: viewer.id, where, candidateLimit: 50 });
        expect(page.rows.map((row) => row.id)).toEqual([shared.id]);
        expect((await computeAccountActivityBadgeCounts([viewer.id])).get(viewer.id)).toBe(1);
        const projection = await loadSessionViewerProjection({ authentication,  accountId: viewer.id, sessionId: shared.id });
        expect(projection?.attention.reasons).toEqual(["mentioned", "unread_discussion"]);
        expect(projection?.relevance.reasons).toEqual(
            ["shared_directly_with_me", "mentioned_in_discussion", "followed_by_me"],
        );

        // Losing access ends the pressure while the Follow and both private
        // cursors survive: revocation must be a query-time exclusion, never a
        // deletion of personal state that a later re-share could not restore.
        await db.sessionShare.deleteMany({ where: { sessionId: shared.id, sharedWithUserId: viewer.id } });
        expect((await createV2SessionAttentionPage({ authentication,  userId: viewer.id, where, candidateLimit: 50 })).rows).toEqual([]);
        expect((await computeAccountActivityBadgeCounts([viewer.id])).get(viewer.id)).toBe(0);
        expect(await loadSessionViewerProjection({ authentication,  accountId: viewer.id, sessionId: shared.id })).toBeNull();
        expect((await loadSessionDiscussionAttentionForAccounts({
            accountIds: [viewer.id], sessionIds: [shared.id],
        })).get(viewer.id)).toBeUndefined();
        expect(await db.sessionDiscussionReadState.count({
            where: { accountId: viewer.id, discussionId: tracked.id },
        })).toBe(1);
        await db.sessionShare.create({ data: {
            sessionId: shared.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: "edit",
        } });
        expect((await computeAccountActivityBadgeCounts([viewer.id])).get(viewer.id)).toBe(1);

        // Archiving the conversation removes the pressure without touching the
        // cursor, and the badge agrees with the list in the same breath.
        await db.sessionDiscussion.update({ where: { id: tracked.id }, data: { archivedAt: new Date() } });
        expect((await createV2SessionAttentionPage({ authentication,  userId: viewer.id, where, candidateLimit: 50 })).rows).toEqual([]);
        expect((await computeAccountActivityBadgeCounts([viewer.id])).get(viewer.id)).toBe(0);
    });

    it("agrees on viewer attention for Follow, capabilities, manual standing and finite publication", async () => {
        const { viewer, owner } = await fixture();
        const cases = [
            { name: "unread", seq: 5, cursor: 2, expected: true },
            { name: "caught-up", seq: 5, cursor: 5, expected: false },
            { name: "unfollowed", seq: 5, cursor: 2, follows: false, expected: false },
            { name: "view-only-action", pendingBlockedCount: 1, expected: false },
            { name: "responsible-action", pendingBlockedCount: 1, responsibleAccountId: viewer.id, expected: true },
            { name: "manual", standing: true, expected: true },
            { name: "manual-unfollowed", standing: true, follows: false, expected: false },
            { name: "archived", seq: 5, cursor: 2, archivedAt: new Date(), expected: true, expectedBadge: false },
            { name: "finite-hidden", seq: 9, cursor: 4, snapshot: true, expected: false },
        ];
        const expected = [];
        const expectedBadge = [];
        const sessionIds = [];
        for (const value of cases) {
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: '{"v":1}', encryptionMode: "plain",
                metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
                seq: value.seq ?? 0, pendingBlockedCount: value.pendingBlockedCount ?? 0,
                responsibleAccountId: value.responsibleAccountId ?? null,
                archivedAt: value.archivedAt ?? null,
                ...(value.snapshot ? { currentStorageState: "snapshot_complete", materializationPublicationId: "snapshot", materializedThroughSourceAt: 1n, publishedThroughServerSeq: 4 } : {}),
            } });
            sessionIds.push(session.id);
            if (value.expected) expected.push(session.id);
            if (value.expectedBadge ?? value.expected) expectedBadge.push(session.id);
            await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: "view" } });
            await db.accountSessionFollow.create({ data: { sessionId: session.id, accountId: viewer.id, following: value.follows !== false, notificationLevel: value.follows === false ? "none" : "important" } });
            await db.accountSessionReadState.create({ data: { sessionId: session.id, accountId: viewer.id, lastViewedSessionSeq: value.cursor ?? 0 } });
            if (value.standing) await db.sessionAttentionStanding.create({ data: { sessionId: session.id, accountId: viewer.id, standing: true } });
        }
        const page = await createV2SessionAttentionPage({ authentication,  userId: viewer.id, where: { id: { in: sessionIds } }, candidateLimit: 50 });
        expect(page.rows.map(row => row.id).sort()).toEqual(expected.sort());
        expect((await computeAccountActivityBadgeCounts([viewer.id])).get(viewer.id)).toBe(expectedBadge.length);
    });

    it.each([V2_SESSION_LIST_ORDER_BY, [{ id: "desc" as const }]].map((orderBy) => ({ orderBy })))(
        "conjoins an OR selector with visibility under ordering %j",
        async ({ orderBy }) => {
            const { viewer, shared, foreign } = await fixture();
            const rows = await findV2SessionListRows({ authentication,
                userId: viewer.id,
                where: { OR: [{ id: shared.id }, { id: foreign.id }] },
                orderBy,
                take: 50,
            });
            expect(rows.map((row) => row.id)).toEqual([shared.id]);
        },
    );

    it("never resolves a foreign legacy cursor when the base contains OR", async () => {
        const { viewer, shared, foreign } = await fixture();
        const cursor = await resolveV2SessionListCursorForVisibleRows({ authentication,
            userId: viewer.id,
            cursor: encodeV2SessionListCursorV1(foreign.id),
            cursorRowWhere: { OR: [{ id: shared.id }, { id: foreign.id }] },
        });
        expect(cursor).toBeNull();
    });

    /**
     * Counts every statement the composed page assembly issues, keyed by
     * `<model>.<method>`. `db`/`tx` are forwarding proxies, so wrap the live
     * delegates instead of copying them.
     */
    function createStatementCountingReader(reader: Tx, counts: Map<string, number>): Tx {
        return new Proxy(reader, {
            get(target, property, receiver) {
                const delegate = Reflect.get(target, property, receiver);
                if (typeof property !== "string" || property.startsWith("$")) return delegate;
                if (typeof delegate !== "object" || delegate === null) return delegate;
                return new Proxy(delegate, {
                    get(model, method, modelReceiver) {
                        const member = Reflect.get(model, method, modelReceiver);
                        if (typeof method !== "string" || typeof member !== "function") return member;
                        return (...args: readonly unknown[]) => {
                            const key = `${property}.${method}`;
                            counts.set(key, (counts.get(key) ?? 0) + 1);
                            return Reflect.apply(member, model, args);
                        };
                    },
                });
            },
        }) as Tx;
    }

    it("reuses bounded admission discussion facts when projecting a sparse attention result", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const rejected = Array.from({ length: 205 }, (_, index) => ({
            id: randomUUID(),
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain" as const,
            meaningfulActivityAt: new Date(10_000 + index),
            latestTurnStatus: "failed",
            lastRuntimeIssue: "not-a-canonical-runtime-issue",
        }));
        await db.session.createMany({ data: rejected });
        const match = await db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            meaningfulActivityAt: new Date(1_000),
            pendingBlockedCount: 1,
        } });

        const counts = new Map<string, number>();
        const projected = await inTx(async (tx) => {
            const reader = createStatementCountingReader(tx, counts);
            const attention = createSessionPersonalAttentionQueryInTx(reader, {
                accountId: owner.id,
                captureObservedDiscussionFacts: true,
            });
            const rows = await findV2SessionListRows({
                userId: owner.id,
                source: {
                    kind: "effective",
                    reader,
                    baseWhere: { accountId: owner.id },
                    accessMode: "effective_access_v1",
                    allowProjectionFallback: false,
                    discussionReader: reader,
                },
                where: attention.candidateWhere,
                orderBy: V2_SESSION_LIST_ORDER_BY,
                take: 1,
                rowAdmission: attention.admitRows,
            });
            const discussionFacts = await readSessionListViewerDiscussionFacts(
                rows,
                owner.id,
                reader,
                attention.observedDiscussionFacts,
            );
            expect(attention.observedDiscussionFacts?.size).toBe(1);
            return mapV2SessionListRows({ rows, userId: owner.id, discussionFacts }).sessions;
        });

        expect(projected.map((session) => session.id)).toEqual([match.id]);
        // Two 200-row candidate/admission batches each read discussion
        // candidacy once. Final projection consumes those exact observed facts
        // instead of issuing a third, duplicate read for the admitted row.
        expect(counts.get("sessionDiscussion.findMany")).toBe(2);
    });

    it("projects 50- and 200-row viewer pages without per-row relation queries or transcript reads", async () => {
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const collectiveCollaborator = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        // Several distinct owners, so a per-row owner-Account read would be
        // visible as growth rather than hidden behind one cached lookup.
        const owners = await Promise.all(Array.from({ length: 4 }, () =>
            db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const team = await db.team.create({ data: { name: randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: collectiveCollaborator.id,
            role: "member",
        } });
        const groupName = randomUUID();
        const group = await db.teamGroup.create({ data: {
            teamId: team.id,
            name: groupName,
            nameKey: groupName,
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: membership.id,
        } });
        const PAGE_CORPUS_ROWS = 200;
        const sessionIds: string[] = [];
        for (let index = 0; index < PAGE_CORPUS_ROWS; index += 1) {
            const owner = owners[index % owners.length]!;
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: '{"v":1}', encryptionMode: "plain",
                metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
                meaningfulActivityAt: new Date(10_000 + index),
            } });
            await db.sessionShare.create({ data: {
                sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: "view",
            } });
            sessionIds.push(session.id);
        }
        const effectiveAt = new Date("2026-09-01T12:00:00.000Z");
        await db.sessionTeamGrant.createMany({ data: sessionIds
            .filter((_, index) => index % 2 === 0)
            .map((sessionId) => ({ sessionId, teamId: team.id, accessLevel: "view", effectiveAt })) });
        await db.sessionGroupGrant.createMany({ data: sessionIds
            .filter((_, index) => index % 2 === 1)
            .map((sessionId) => ({ sessionId, teamGroupId: group.id, accessLevel: "view", effectiveAt })) });

        const measurePage = async (limit: number) => {
            const counts = new Map<string, number>();
            const startedAt = performance.now();
            const sessions = await inTx(async (tx) => {
                const reader = createStatementCountingReader(tx, counts);
                const baseWhere = conjoinSessionListWhereInputs(
                    await buildSessionAccessWhere({
                        tx, accountId: viewer.id, capability: "readTranscript", mode: "effective_access_v1",
                        authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
                    }),
                    createSessionListStorageWhere("active"),
                );
                const rows = await findV2SessionListRows({
                    userId: viewer.id,
                    source: { kind: "effective", reader, baseWhere, accessMode: "effective_access_v1", allowProjectionFallback: false },
                    orderBy: V2_SESSION_LIST_ORDER_BY,
                    take: limit,
                });
                return mapV2SessionListRows({
                    rows,
                    userId: viewer.id,
                    ownerAccountModes: await readSessionListOwnerAccountModes(rows, reader),
                    discussionFacts: await readSessionListViewerDiscussionFacts(rows, viewer.id, reader),
                    otherNamedCollaboratorFacts: await readSessionListOtherNamedCollaboratorFacts(rows, viewer.id, reader),
                }).sessions;
            });
            return { limit, sessions, counts, elapsedMs: performance.now() - startedAt };
        };

        const fifty = await measurePage(50);
        const twoHundred = await measurePage(PAGE_CORPUS_ROWS);
        expect(fifty.sessions).toHaveLength(50);
        expect(twoHundred.sessions).toHaveLength(PAGE_CORPUS_ROWS);
        // Every row is a non-owner projection, so the privacy path really ran.
        expect(twoHundred.sessions.every((session) => session.share?.accessLevel === "view")).toBe(true);
        // Every row also has a current collective collaborator. This forces
        // both Team and Group branches through the same one-page batch owner.
        expect(twoHundred.sessions.every((session) => session.hasOtherNamedCollaborator === true)).toBe(true);

        // The falsifier for AWR-02/§9: page-size growth may require more
        // canonical row/refill batches, but must not turn bounded projection
        // reads into one query per Session (or even one per distinct owner).
        expect(twoHundred.counts.get("account.findMany") ?? 0).toBeLessThan(owners.length);
        expect(twoHundred.counts.get("sessionDiscussionMessage.findMany") ?? 0).toBeLessThan(owners.length);
        expect(twoHundred.counts.get("sessionShare.findMany")).toBe(1);
        expect(twoHundred.counts.get("sessionTeamGrant.findMany")).toBe(1);
        expect(twoHundred.counts.get("sessionGroupGrant.findMany")).toBe(1);
        // Awareness is transcript-free: no preview read and no message decrypt.
        expect([...twoHundred.counts.keys()].filter((key) => key.startsWith("sessionMessage."))).toEqual([]);

        const census = (counts: Map<string, number>) =>
            [...counts.entries()].sort().map(([key, value]) => `${key}=${value}`).join(" ");
        console.info([
            "Lane09A AWR-02 server page measurement:",
            `provider sqlite (ephemeral light harness), platform ${process.platform}/${process.arch}, cpus ${cpus().length}`,
            `corpus ${PAGE_CORPUS_ROWS} shared Sessions across ${owners.length} owner Accounts, layout v1`,
            `50-row page ${fifty.elapsedMs.toFixed(1)} ms [${census(fifty.counts)}]`,
            `${PAGE_CORPUS_ROWS}-row page ${twoHundred.elapsedMs.toFixed(1)} ms [${census(twoHundred.counts)}]`,
        ].join("\n  "));
    });

    it("applies the same base before ordinary, pin and attention limits", async () => {
        const { viewer, owner, shared, foreign } = await fixture();
        // Both rows are readable; only one belongs to this base selection.
        await db.sessionShare.create({ data: {
            sessionId: foreign.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: "view",
        } });
        await db.session.updateMany({ where: { id: { in: [shared.id, foreign.id] } }, data: {
            pendingPermissionRequestCount: 1,
        } });
        await db.session.createMany({ data: Array.from({ length: 205 }, (_, i) => ({
            accountId: viewer.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            meaningfulActivityAt: new Date(3_000 + i), pendingPermissionRequestCount: 1,
        })) });
        const where = { AND: [{ OR: [{ id: shared.id }, { id: foreign.id }] }, { id: { not: foreign.id } }] };
        const pageRows = await findV2SessionListRows({ authentication,  userId: viewer.id, where, orderBy: V2_SESSION_LIST_ORDER_BY, take: 2 });
        expect(createV2SessionListRowPage({ rows: pageRows, limit: 1 })).toMatchObject({
            rows: [{ id: shared.id }], hasNext: false, nextCursor: null,
        });
        const page = await createV2SessionListInitialPage({ authentication,
            userId: viewer.id, where, pageRows, limit: 1,
            pinnedSessionIds: [foreign.id, shared.id], includeAttentionRows: true, attentionRowsLimit: 1,
            readOwnerAccountModes: (ids) => readSessionMetadataOwnerAccountModes(db, ids),
            readViewerDiscussionFacts: (rows) => readSessionListViewerDiscussionFacts(rows, viewer.id),
        });
        expect(page?.sessions.map((row) => row.id)).toEqual([shared.id]);
        expect(page).toMatchObject({ hasNext: false, attentionHasNext: false });
        const attention = await createV2SessionAttentionPage({ authentication,  userId: viewer.id, where, candidateLimit: 1 });
        expect(attention.rows).toEqual([]);
        expect(attention.attentionHasNext).toBe(false);
    });
});
