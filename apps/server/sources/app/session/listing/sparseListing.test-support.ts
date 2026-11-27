import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { expect, vi } from "vitest";
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    buildSessionAccessWhere,
    createApplicableAudienceWhere,
    resolveEffectiveSessionAccessWhere,
} from "@/app/session/access/sessionAccessWhere";
import {
    countSessionPersonalAttentionRowsInTx,
    createSessionPersonalAttentionQueryInTx,
    createSessionListScopeWhere,
} from "@/app/session/personal/queries";
import { listSessionsForAccount } from "./service";
import { findV2SessionListRows, V2_SESSION_LIST_ORDER_BY } from "./page";
import { conjoinSessionListWhereInputs, createSessionListStorageWhere, createSessionViewerTagWhere } from "./query";
import { createV2SessionListServerTiming, V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER } from "./timing";

/** Exclusions narrow the authorized corpus before each cursor page is selected. */
export async function verifySessionListExclusions(): Promise<void> {
    const [viewer, other] = await Promise.all([0, 1].map(() => db.account.create({
        data: { publicKey: randomUUID(), encryptionMode: 'plain' },
    })));
    const team = await db.team.create({ data: { name: randomUUID() } });
    const [includedTag, excludedTag, foreignTag] = await Promise.all([viewer, viewer, other].map(account =>
        db.sessionOrganizationTag.create({ data: { accountId: account.id, tagKey: randomUUID(), tagHash: randomUUID() } })));
    const ids = Array.from({ length: 6 }, () => randomUUID());
    try {
        await db.session.createMany({ data: ids.map((id, index) => ({
            id, accountId: index === 2 || index === 4 ? other.id : viewer.id, tag: id,
            metadata: '{"v":1}', metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
            encryptionMode: 'plain', meaningfulActivityAt: new Date(10_000 - index),
        })) });
        await db.sessionGrant.createMany({ data: [
            { principalKind: 'account', sessionId: ids[4]!, accountId: viewer.id, createdByAccountId: other.id, accessLevel: 'view' },
            { principalKind: 'team', sessionId: ids[1]!, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() },
            // A direct viewer does not gain an unrelated Team's applicable audience.
            { principalKind: 'team', sessionId: ids[4]!, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() },
        ] });
        await db.sessionTagAssignment.createMany({ data: [
            ...ids.map(sessionId => ({ sessionId, accountId: viewer.id, tagId: includedTag.id })),
            { sessionId: ids[0]!, accountId: viewer.id, tagId: excludedTag.id },
            { sessionId: ids[5]!, accountId: other.id, tagId: foreignTag.id },
        ] });
        const read = async (patch: Partial<Pick<SessionListQueryV1, 'tagIds' | 'audiences'>>) => {
            const result: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await listSessionsForAccount({ userId: viewer.id,
                    authentication: createPresentUserSessionAccessAuthentication(),
                    source: { kind: 'query', query: { v: 1, storage: 'active', includeInactive: true,
                        scope: 'all_accessible', attention: 'any', includeAttention: false, limit: 1,
                        audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] },
                        ...patch, ...(cursor ? { cursor } : {}) } }, rowRepresentabilityWhere: {},
                    timing: createV2SessionListServerTiming({ headers: {} }) });
                if (!page || !('hasNext' in page)) throw new Error('Expected a filtered Session page');
                result.push(...page.sessions.map(session => session.id));
                cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
            } while (cursor);
            return result;
        };
        expect(await read({})).toEqual([ids[0], ids[1], ids[3], ids[4], ids[5]]);
        expect(await read({ tagIds: { include: [], exclude: [excludedTag.id, foreignTag.id] } }))
            .toEqual([ids[1], ids[3], ids[4], ids[5]]);
        expect(await read({ audiences: { include: [], exclude: [{ kind: 'team', teamId: team.id }] } }))
            .toEqual([ids[0], ids[3], ids[4], ids[5]]);
        expect(await read({ tagIds: { include: [includedTag.id], exclude: [excludedTag.id] },
            audiences: { include: [], exclude: [{ kind: 'team', teamId: team.id }] } }))
            .toEqual([ids[3], ids[4], ids[5]]);
    } finally {
        await db.session.deleteMany({ where: { id: { in: ids } } });
        await db.sessionOrganizationTag.deleteMany({ where: { id: { in: [includedTag.id, excludedTag.id, foreignTag.id] } } });
        await db.team.delete({ where: { id: team.id } });
        await db.account.deleteMany({ where: { id: { in: [viewer.id, other.id] } } });
    }
}

/** Shared real-database contract for sparse audience/tag/attention paging. */
export async function verifySparseSessionListing(provider: "sqlite" | "postgres" | "mysql"): Promise<void> {
    const [viewer, owner] = await Promise.all([0, 1].map(() => db.account.create({
        data: { publicKey: randomUUID(), encryptionMode: "plain" },
    })));
    const tag = await db.sessionOrganizationTag.create({
        data: { accountId: viewer.id, tagKey: randomUUID(), tagHash: randomUUID() },
    });
    const team = await db.team.create({ data: { name: randomUUID() } });
    await db.teamMembership.create({
        data: { teamId: team.id, accountId: viewer.id, role: "member", sessionAccessStartsAt: null },
    });
    const ADDITIONAL_TEAM_SELECTOR_COUNT = 51;
    const GROUP_SELECTOR_COUNT = 50;
    const additionalTeams = Array.from({ length: ADDITIONAL_TEAM_SELECTOR_COUNT }, () => ({
        id: randomUUID(),
        name: randomUUID(),
    }));
    const groupOnlyTeams = Array.from({ length: GROUP_SELECTOR_COUNT }, () => ({
        id: randomUUID(),
        name: randomUUID(),
        membershipId: randomUUID(),
        groupId: randomUUID(),
    }));
    await db.team.createMany({
        data: [
            ...additionalTeams,
            ...groupOnlyTeams.map((groupTeam) => ({ id: groupTeam.id, name: groupTeam.name })),
        ],
    });
    await db.teamMembership.createMany({
        data: [
            ...additionalTeams.map((selectedTeam) => ({
                teamId: selectedTeam.id,
                accountId: viewer.id,
                role: "member" as const,
                sessionAccessStartsAt: null,
            })),
            ...groupOnlyTeams.map((groupTeam) => ({
                id: groupTeam.membershipId,
                teamId: groupTeam.id,
                accountId: viewer.id,
                role: "member" as const,
                sessionAccessStartsAt: null,
            })),
        ],
    });
    await db.teamGroup.createMany({
        data: groupOnlyTeams.map((groupTeam) => ({
            id: groupTeam.groupId,
            teamId: groupTeam.id,
            name: groupTeam.groupId,
        })),
    });
    await db.teamGroupMembership.createMany({
        data: groupOnlyTeams.map((groupTeam) => ({
            teamId: groupTeam.id,
            teamGroupId: groupTeam.groupId,
            teamMembershipId: groupTeam.membershipId,
        })),
    });

    const NONMATCH_COUNT = 205;
    const IN_BASE_FALSE_ATTENTION_COUNT = 205;
    const MATCH_COUNT = 3;
    const matchIds: string[] = [];
    for (let index = 0; index < MATCH_COUNT; index += 1) {
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                responsibleAccountId: viewer.id,
                tag: randomUUID(),
                metadata: '{"v":1}',
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                ownerMetadata: '{"t":"plain","v":{"v":1}}',
                meaningfulActivityAt: new Date(1_000 - index),
                seq: 5,
            },
        });
        matchIds.push(session.id);
        if (index === 0) {
            // Two independent access paths for the same Session: the page must
            // still emit it once.
            await db.sessionGrant.create({
                data: { principalKind: 'account',
                    sessionId: session.id,
                    createdByAccountId: owner.id,
                    accountId: viewer.id,
                    accessLevel: "view",
                },
            });
        }
        if (index < 2) {
            await db.sessionGrant.create({
                data: { principalKind: 'team',
                    sessionId: session.id,
                    teamId: team.id,
                    accessLevel: "view",
                    requiredByTeamPolicy: true,
                    effectiveAt: new Date(0),
                },
            });
        } else {
            await db.sessionGrant.create({
                data: { principalKind: 'group',
                    sessionId: session.id,
                    teamGroupId: groupOnlyTeams[0]!.groupId,
                    accessLevel: "view",
                    effectiveAt: new Date(0),
                },
            });
        }
        await db.sessionTagAssignment.create({
            data: { accountId: viewer.id, sessionId: session.id, tagId: tag.id },
        });
        await db.accountSessionFollow.create({
            data: {
                sessionId: session.id,
                accountId: viewer.id,
                following: true,
                followPolicy: JSON.stringify({ preset: "important" }),
            },
        });
        await db.accountSessionReadState.create({
            data: { sessionId: session.id, accountId: viewer.id, lastViewedSessionSeq: 2 },
        });
    }
    await db.session.createMany({
        data: Array.from({ length: NONMATCH_COUNT }, (_, index) => ({
            accountId: viewer.id,
            responsibleAccountId: viewer.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            meaningfulActivityAt: new Date(2_000 + index),
        })),
    });

    // These rows satisfy the complete access/audience/scope/tag relation and
    // the provider-side attention candidacy predicate, but not the canonical
    // personal decision: the failed marker has no valid primary-runtime issue.
    // Keeping more than one work batch ahead of the exact matches proves that
    // strict `needs_my_attention` fills its requested result page by advancing
    // through bounded candidate pages instead of turning 200 candidates into
    // a semantic result ceiling on any database provider.
    const inBaseFalseAttention = Array.from({ length: IN_BASE_FALSE_ATTENTION_COUNT }, (_, index) => ({
        id: randomUUID(),
        accountId: owner.id,
        responsibleAccountId: viewer.id,
        tag: randomUUID(),
        metadata: "{}",
        encryptionMode: "plain" as const,
        meaningfulActivityAt: new Date(20_000 + index),
        latestTurnStatus: "failed",
        lastRuntimeIssue: "not-a-canonical-primary-runtime-issue",
    }));
    await db.session.createMany({ data: inBaseFalseAttention });
    await Promise.all([
        db.sessionGrant.createMany({ data: (inBaseFalseAttention.map((session) => ({
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            requiredByTeamPolicy: true,
            effectiveAt: new Date(0),
        }))).map(data => ({ ...data, principalKind: 'team' })) }),
        db.sessionTagAssignment.createMany({ data: inBaseFalseAttention.map((session) => ({
            accountId: viewer.id,
            sessionId: session.id,
            tagId: tag.id,
        })) }),
        db.accountSessionFollow.createMany({ data: inBaseFalseAttention.map((session) => ({
            accountId: viewer.id,
            sessionId: session.id,
            following: true,
            followPolicy: JSON.stringify({ preset: "important" }),
        })) }),
    ]);

    // This Account owns a much larger attention corpus that the structural
    // query excludes. The strict listing owner must compose its database
    // predicate with the Team/tag base before reading a bounded candidate page;
    // it must not first bind this whole Account-wide corpus into `Session.id in`.
    const OFF_FILTER_ATTENTION_ROWS = 1_200;
    const offFilterAttention = Array.from({ length: OFF_FILTER_ATTENTION_ROWS }, (_, index) => ({
        id: randomUUID(),
        accountId: viewer.id,
        tag: randomUUID(),
        metadata: "{}",
        encryptionMode: "plain",
        seq: 5,
        meaningfulActivityAt: new Date(10_000 + index),
    }));
    await db.session.createMany({ data: offFilterAttention });
    await db.accountSessionReadState.createMany({
        data: offFilterAttention.map((session) => ({
            accountId: viewer.id,
            sessionId: session.id,
            lastViewedSessionSeq: 0,
        })),
    });

    const sessionCount = await db.session.count();
    const grantCount = await db.sessionGrant.count({ where: { principalKind: 'account' } })
        + await db.sessionGrant.count({ where: { principalKind: 'team' } })
        + await db.sessionGrant.count({ where: { principalKind: 'group' } });
    const audiences = [
        { kind: "team" as const, teamId: team.id },
        ...additionalTeams.map((selectedTeam) => ({
            kind: "team" as const,
            teamId: selectedTeam.id,
        })),
        ...groupOnlyTeams.map((groupTeam) => ({
            kind: "group" as const,
            teamId: groupTeam.id,
            groupId: groupTeam.groupId,
        })),
        { kind: "outside_teams" as const },
    ];
    expect(audiences.length).toBeGreaterThan(100);
    const query = SessionListQueryV1Schema.parse({
        v: 1,
        storage: "active",
        includeInactive: true,
        scope: "assigned_to_me",
        attention: "needs_my_attention",
        audiences: { include: audiences, exclude: [] },
        tagIds: { include: [tag.id], exclude: [] },
        limit: 2,
    });
    // This must remain a genuinely large canonical product query. In
    // particular, no exact Group selector may be normalized away because its
    // parent Team is also selected.
    expect(query.audiences.include).toHaveLength(audiences.length);
    expect(query.audiences.include.length).toBeGreaterThan(100);

    const measure = async (label: string, run: (timing: ReturnType<typeof createV2SessionListServerTiming>) => Promise<unknown>) => {
        const timing = createV2SessionListServerTiming({
            headers: { [V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER]: "1" },
        });
        const startedAt = performance.now();
        const result = await run(timing);
        const elapsedMs = performance.now() - startedAt;
        let serverTiming = "";
        timing.apply({ header: (_name, value) => { serverTiming = value; } });
        return { label, result, elapsedMs, serverTiming };
    };

    const first = await measure("query first page", (timing) => listSessionsForAccount({
        userId: viewer.id,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
        source: { kind: "query", query },
        rowRepresentabilityWhere: {},
        timing,
    }));
    const firstPage = SessionListQueryResponseV1Schema.parse(first.result);
    expect(firstPage.sessions).toEqual([]);
    expect(firstPage.hasNext).toBe(true);

    const collectedIds = firstPage.sessions.map(row => row.id);
    const cursors = new Set<string>();
    let candidateCursor = firstPage.nextCursor;
    let continued = first;
    while (candidateCursor) {
        expect(cursors.has(candidateCursor)).toBe(false);
        cursors.add(candidateCursor);
        continued = await measure("query continued page", (timing) => listSessionsForAccount({
        userId: viewer.id,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
        source: { kind: "query", query: { ...query, cursor: candidateCursor ?? undefined } },
        rowRepresentabilityWhere: {},
        timing,
    }));
        const continuedPage = SessionListQueryResponseV1Schema.parse(continued.result);
        collectedIds.push(...continuedPage.sessions.map(row => row.id));
        candidateCursor = continuedPage.hasNext ? continuedPage.nextCursor : null;
    }
    expect(collectedIds).toEqual(matchIds);

    const exactFilteredAttentionCount = await inTx(async (tx) => {
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: undefined };
        const access = await resolveEffectiveSessionAccessWhere({
            tx,
            accountId: viewer.id,
            capability: "readTranscript",
            mode: "effective_access_v1",
            authentication,
        });
        const audienceWhere = await createApplicableAudienceWhere({
            tx,
            accountId: viewer.id,
            audiences: query.audiences,
            authentication,
            collectiveAccessSnapshot: access.collectiveAccessSnapshot,
        });
        return await countSessionPersonalAttentionRowsInTx(tx, {
            accountId: viewer.id,
            where: conjoinSessionListWhereInputs(
                access.where,
                createSessionListStorageWhere(query.storage),
                await createSessionListScopeWhere({ tx, accountId: viewer.id, scope: query.scope }),
                audienceWhere,
                createSessionViewerTagWhere({ accountId: viewer.id, tagIds: query.tagIds }),
            ),
            qualifiedTeamIds: access.qualifiedTeamIds,
        });
    });
    expect(exactFilteredAttentionCount).toBe(MATCH_COUNT);

    const incumbentFirst = await measure("incumbent first page", (timing) => listSessionsForAccount({
        userId: viewer.id,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
        source: { kind: "legacy", storage: "active", limit: 2 },
        rowRepresentabilityWhere: {},
        timing,
    }));
    const incumbentFirstPage = incumbentFirst.result as { sessions: { id: string }[]; nextCursor: string | null };
    expect(incumbentFirstPage.sessions).toHaveLength(2);
    const incumbentContinued = await measure("incumbent continued page", (timing) => listSessionsForAccount({
        userId: viewer.id,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
        source: {
            kind: "legacy",
            storage: "active",
            limit: 2,
            cursor: incumbentFirstPage.nextCursor ?? undefined,
        },
        rowRepresentabilityWhere: {},
        timing,
    }));
    expect((incumbentContinued.result as { sessions: unknown[] }).sessions).toHaveLength(2);

    // Exercise 200 selectors through the real database; this is a successful
    // bind-count probe, not a measurement of the provider maximum.
    const BIND_PROBE_TAG_IDS = 200;
    const bindProbe = await measure("query first page with 200 tag selectors", (timing) => listSessionsForAccount({
        userId: viewer.id,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
        source: {
            kind: "query",
            query: {
                ...query,
                tagIds: { include: [tag.id, ...Array.from({ length: BIND_PROBE_TAG_IDS - 1 }, () => randomUUID())], exclude: [] },
            },
        },
        rowRepresentabilityWhere: {},
        timing,
    }));
    expect(SessionListQueryResponseV1Schema.parse(bindProbe.result)).toMatchObject({ sessions: [], hasNext: true });

    // Access-path shape for one page: how many statements the composed
    // conjunction issues through the canonical row reader.
    let sessionFindManyStatements = 0;
    const statementRows = await inTx(async (tx) => {
        const baseWhere = conjoinSessionListWhereInputs(
            await buildSessionAccessWhere({
                tx,
                accountId: viewer.id,
                capability: "readTranscript",
                mode: "effective_access_v1",
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: undefined },
            }),
            createSessionListStorageWhere("active"),
            await createSessionListScopeWhere({ tx, accountId: viewer.id, scope: "assigned_to_me" }),
            createSessionViewerTagWhere({ accountId: viewer.id, tagIds: { include: [tag.id], exclude: [] } }),
        );
        const attention = createSessionPersonalAttentionQueryInTx(tx, {
            accountId: viewer.id,
            qualifiedTeamIds: new Set([team.id, groupOnlyTeams[0]!.id]),
        });
        // Count statements at the real reader seam. `db`/`tx` are forwarding
        // proxies, so a spread copy would drop their delegates.
        const countingReader = new Proxy(tx, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== "session") return value;
                return new Proxy(value as object, {
                    get(delegate, delegateProperty, delegateReceiver) {
                        const member = Reflect.get(delegate, delegateProperty, delegateReceiver);
                        if (delegateProperty !== "findMany" || typeof member !== "function") return member;
                        return (...args: readonly unknown[]) => {
                            sessionFindManyStatements += 1;
                            return Reflect.apply(member, delegate, args);
                        };
                    },
                });
            },
        });
        return await findV2SessionListRows({
            userId: viewer.id,
            source: { kind: "effective", reader: countingReader, baseWhere, accessMode: "effective_access_v1" },
            where: attention.candidateWhere,
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: 3,
            rowAdmission: attention.admitRows,
        });
    });
    expect(statementRows.map((row) => row.id)).toEqual(matchIds);
    expect(sessionFindManyStatements).toBeGreaterThan(0);

    console.info([
        "Lane07 R18 listing measurement:",
        `provider ${provider} (disposable test database), platform ${process.platform}/${process.arch}, cpus ${cpus().length}`,
        `this fixture: ${MATCH_COUNT} matches below ${NONMATCH_COUNT} newer nonmatches; database totals ${sessionCount} Sessions, ${grantCount} grants`,
        `${OFF_FILTER_ATTENTION_ROWS} additional Account-attention rows excluded by the structural base`,
        "matches cover overlapping direct+Team access, Team-only access, and exact Group-only access, each with one viewer tag",
        `${audiences.length} mixed audience selectors (${ADDITIONAL_TEAM_SELECTOR_COUNT + 1} Team, ${GROUP_SELECTOR_COUNT} exact Group, outside Teams)`,
        `attention density: ${MATCH_COUNT} followed-unread rows for this viewer`,
        `page limit 2; ${sessionFindManyStatements} session.findMany statements for one 3-row read`,
        `query first ${first.elapsedMs.toFixed(1)} ms [${first.serverTiming}]`,
        `query continued ${continued.elapsedMs.toFixed(1)} ms [${continued.serverTiming}]`,
        `incumbent first ${incumbentFirst.elapsedMs.toFixed(1)} ms [${incumbentFirst.serverTiming}]`,
        `incumbent continued ${incumbentContinued.elapsedMs.toFixed(1)} ms [${incumbentContinued.serverTiming}]`,
        `${BIND_PROBE_TAG_IDS} tag selectors ${bindProbe.elapsedMs.toFixed(1)} ms [${bindProbe.serverTiming}]`,
    ].join("\n  "));
}
