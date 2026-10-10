import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    db,
    initDbMysql,
    initDbPostgres,
    requireDbProviderFromEnv,
    shutdownDbClient,
} from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    buildSessionAccessWhere,
    resolveEffectiveSessionAccessWhere,
} from "./sessionAccessWhere";
import {
    buildSessionAccessProjectionSelect,
    projectEffectiveSessionAccess,
    resolveEffectiveSessionAccess,
    resolveSessionAccessForOperation,
} from "./sessionAccess";
import {
    applyInitialSessionAccessInTx,
    deleteSessionAccessGrantInTx,
    putSessionAccessGrantInTx,
} from "./sessionAccessGrantService";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "./sessionRecipients";
import { listSessionResponsibilityCandidates } from "./sessionResponsibilityService";

const presentUserAuthentication = {
    env: process.env,
    authority: "present_user" as const,
    authenticationEvidence: [] as const,
};

describe("Session access persistence provider contract", () => {
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("The disposable DB-contract DATABASE_URL is required");
        }
        const provider = requireDbProviderFromEnv(process.env, "postgres");
        if (provider === "mysql") await initDbMysql();
        else if (provider === "postgres") initDbPostgres();
        else throw new Error("This DB-contract lane requires postgres or mysql; SQLite has its own integration suite");
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await shutdownDbClient();
    });

    afterEach(() => vi.unstubAllEnvs());

    it("searches responsibility candidates case-insensitively without exposing matching non-readers", async () => {
        const suffix = randomUUID();
        const [owner, reader, outsider] = await Promise.all([
            db.account.create({ data: { publicKey: `search-owner-${suffix}`, encryptionMode: "plain" } }),
            db.account.create({ data: { publicKey: `search-reader-${suffix}`, encryptionMode: "plain", firstName: "Zenobia" } }),
            db.account.create({ data: { publicKey: `search-outsider-${suffix}`, encryptionMode: "plain", firstName: "Zenobia" } }),
        ]);
        let sessionId: string | undefined;
        try {
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: suffix, encryptionMode: "plain", metadata: "{}",
            } });
            sessionId = session.id;
            await db.sessionShare.create({ data: {
                sessionId, sharedByUserId: owner.id, sharedWithUserId: reader.id,
                accessLevel: "view", canApprovePermissions: false,
            } });
            const result = await listSessionResponsibilityCandidates({
                actorAccountId: owner.id, sessionId, purpose: "assignment", query: "zeno",
                authentication: presentUserAuthentication,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            expect(result.candidates.map(candidate => candidate.accountId)).toEqual([reader.id]);
            await db.account.update({ where: { id: reader.id }, data: { status: "suspended" } });
            await expect(listSessionResponsibilityCandidates({
                actorAccountId: owner.id, sessionId, purpose: "assignment", query: "zeno",
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ ok: true, candidates: [] });
        } finally {
            if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id, outsider.id] } } });
        }
    });

    it("enforces portable Team/Group grant identity and lifecycle relations", async () => {
        const suffix = randomUUID();
        const [owner, responsible] = await Promise.all([
            db.account.create({
                data: { publicKey: `access-owner-${suffix}`, encryptionMode: "plain" },
                select: { id: true },
            }),
            db.account.create({
                data: { publicKey: `access-responsible-${suffix}`, encryptionMode: "plain" },
                select: { id: true },
            }),
        ]);
        let sessionId: string | null = null;
        let teamId: string | null = null;
        try {
            const team = await db.team.create({ data: { name: `Access ${suffix}` }, select: { id: true } });
            teamId = team.id;
            const group = await db.teamGroup.create({
                data: { teamId: team.id, name: "Access", nameKey: `access-${suffix}` },
                select: { id: true },
            });
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `access-${suffix}`,
                    encryptionMode: "plain",
                    metadata: "{}",
                    currentStorageState: "hosted",
                    primaryTeamId: team.id,
                    responsibleAccountId: responsible.id,
                },
                select: { id: true },
            });
            sessionId = session.id;

            await db.sessionTeamGrant.create({
                data: { sessionId: session.id, teamId: team.id, effectiveAt: new Date(1) },
            });
            await db.sessionGroupGrant.create({
                data: { sessionId: session.id, teamGroupId: group.id, effectiveAt: new Date(2) },
            });

            await expect(db.sessionTeamGrant.findUniqueOrThrow({
                where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } },
                select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
            })).resolves.toEqual({
                accessLevel: "view",
                canApprovePermissions: false,
                requiredByTeamPolicy: false,
            });
            await expect(db.sessionGroupGrant.findUniqueOrThrow({
                where: { sessionId_teamGroupId: { sessionId: session.id, teamGroupId: group.id } },
                select: { accessLevel: true, canApprovePermissions: true },
            })).resolves.toEqual({ accessLevel: "view", canApprovePermissions: false });

            await db.account.delete({ where: { id: responsible.id } });
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { responsibleAccountId: true },
            })).resolves.toEqual({ responsibleAccountId: null });

            await db.teamGroup.delete({ where: { id: group.id } });
            await expect(db.sessionGroupGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);

            await db.team.delete({ where: { id: team.id } });
            teamId = null;
            await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { primaryTeamId: true },
            })).resolves.toEqual({ primaryTeamId: null });

            await db.session.delete({ where: { id: session.id } });
            sessionId = null;
        } finally {
            if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
            if (teamId) await db.team.deleteMany({ where: { id: teamId } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, responsible.id] } } });
        }
    });

    it("keeps the canonical grant writer, history horizons, and recipient expansion portable", async () => {
        const suffix = randomUUID();
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: { publicKey: `access-owner-${suffix}`, encryptionMode: "plain" },
                select: { id: true },
            }),
            db.account.create({
                data: { publicKey: `access-collaborator-${suffix}`, encryptionMode: "plain" },
                select: { id: true },
            }),
        ]);
        let sessionId: string | null = null;
        let teamId: string | null = null;
        try {
            const team = await db.team.create({ data: { name: `Portable access ${suffix}` }, select: { id: true } });
            teamId = team.id;
            const group = await db.teamGroup.create({
                data: { teamId: team.id, name: "Portable group", nameKey: `portable-${suffix}` },
                select: { id: true },
            });
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.id, role: "owner", sessionAccessStartsAt: null },
                { teamId: team.id, accountId: collaborator.id, role: "member", sessionAccessStartsAt: null },
            ] });
            const collaboratorMembership = await db.teamMembership.findUniqueOrThrow({
                where: { teamId_accountId: { teamId: team.id, accountId: collaborator.id } },
                select: { id: true },
            });
            await db.teamGroupMembership.create({ data: {
                teamId: team.id,
                teamGroupId: group.id,
                teamMembershipId: collaboratorMembership.id,
                sessionAccessStartsAt: null,
            } });
            const session = await db.session.create({ data: {
                accountId: owner.id,
                tag: `portable-${suffix}`,
                encryptionMode: "plain",
                metadata: "{}",
                currentStorageState: "hosted",
            }, select: { id: true } });
            sessionId = session.id;

            await db.sessionShare.create({ data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: collaborator.id,
                accessLevel: "view",
            } });
            const teamInsert = await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "team", teamId: team.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: presentUserAuthentication,
            }));
            expect(teamInsert).toMatchObject({ ok: true, transition: "inserted" });
            const teamEffectiveAt = await db.sessionTeamGrant.findUniqueOrThrow({
                where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } },
                select: { effectiveAt: true },
            });
            const teamReplace = await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "team", teamId: team.id },
                grant: { accessLevel: "edit", canApprovePermissions: false },
                authentication: presentUserAuthentication,
            }));
            expect(teamReplace).toMatchObject({ ok: true, transition: "replaced" });
            await expect(db.sessionTeamGrant.findUniqueOrThrow({
                where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } },
                select: { accessLevel: true, effectiveAt: true },
            })).resolves.toEqual({ accessLevel: "edit", effectiveAt: teamEffectiveAt.effectiveAt });

            const groupInsert = await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "group", teamId: team.id, groupId: group.id },
                grant: { accessLevel: "admin", canApprovePermissions: false },
                authentication: presentUserAuthentication,
            }));
            expect(groupInsert).toMatchObject({ ok: true, transition: "inserted" });
            const groupEffectiveAt = await db.sessionGroupGrant.findUniqueOrThrow({
                where: { sessionId_teamGroupId: { sessionId: session.id, teamGroupId: group.id } },
                select: { effectiveAt: true },
            });

            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ level: "admin" });
            await expect(inTx(async tx => tx.session.findFirst({ where: { AND: [
                { id: session.id },
                await buildSessionAccessWhere({
                    tx,
                    accountId: collaborator.id,
                    capability: "manageAccess",
                    mode: "effective_access_v1",
                    authentication: presentUserAuthentication,
                }),
            ] }, select: { id: true } }))).resolves.toEqual({ id: session.id });
            await expect(inTx(tx => resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: session.id })))
                .resolves.toEqual([owner.id, collaborator.id].sort());

            // Team and Group cutoffs are independent and equality fails closed.
            await db.teamMembership.update({
                where: { id: collaboratorMembership.id },
                data: { sessionAccessStartsAt: teamEffectiveAt.effectiveAt },
            });
            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ level: "admin" });
            await db.teamGroupMembership.update({
                where: { teamGroupId_teamMembershipId: {
                    teamGroupId: group.id,
                    teamMembershipId: collaboratorMembership.id,
                } },
                data: { sessionAccessStartsAt: groupEffectiveAt.effectiveAt },
            });
            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ level: "view" });

            const directRemoval = await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: collaborator.id },
                authentication: presentUserAuthentication,
            }));
            expect(directRemoval).toMatchObject({ ok: true, changed: true });
            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toBeNull();

            await db.teamMembership.update({
                where: { id: collaboratorMembership.id },
                data: { sessionAccessStartsAt: null },
            });
            await db.teamGroupMembership.update({
                where: { teamGroupId_teamMembershipId: {
                    teamGroupId: group.id,
                    teamMembershipId: collaboratorMembership.id,
                } },
                data: { sessionAccessStartsAt: null },
            });
            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ level: "admin" });

            const groupRemoval = await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "group", teamId: team.id, groupId: group.id },
                authentication: presentUserAuthentication,
            }));
            expect(groupRemoval).toMatchObject({ ok: true, changed: true });
            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ level: "edit" });
        } finally {
            if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
            if (teamId) await db.team.deleteMany({ where: { id: teamId } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, collaborator.id] } } });
        }
    });

    it("commits the required-Team floor and rolls back later grant effects atomically", async () => {
        const suffix = randomUUID();
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: { publicKey: `required-owner-${suffix}`, encryptionMode: "plain" },
                select: { id: true },
            }),
            db.account.create({
                data: { publicKey: `required-collaborator-${suffix}`, encryptionMode: "plain" },
                select: { id: true },
            }),
        ]);
        let sessionId: string | null = null;
        let teamId: string | null = null;
        try {
            const team = await db.team.create({
                data: {
                    name: `Required access ${suffix}`,
                    sessionCreationPolicy: "team_required",
                },
                select: { id: true },
            });
            teamId = team.id;
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.id, role: "owner", sessionAccessStartsAt: null },
                { teamId: team.id, accountId: collaborator.id, role: "member", sessionAccessStartsAt: null },
            ] });
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `required-${suffix}`,
                    encryptionMode: "plain",
                    metadata: "{}",
                    currentStorageState: "hosted",
                    primaryTeamId: team.id,
                },
                select: { id: true },
            });
            sessionId = session.id;

            await expect(inTx(tx => applyInitialSessionAccessInTx(tx, {
                creatorAccountId: owner.id,
                sessionId: session.id,
                initialAccess: { grants: [] },
                authentication: presentUserAuthentication,
            }))).resolves.toMatchObject({ ok: true });
            await expect(db.sessionTeamGrant.findUniqueOrThrow({
                where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } },
                select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
            })).resolves.toEqual({
                accessLevel: "edit",
                canApprovePermissions: false,
                requiredByTeamPolicy: true,
            });
            await expect(inTx(tx => resolveCurrentSessionRecipientAccountIdsInTx(tx, {
                sessionId: session.id,
            }))).resolves.toEqual([owner.id, collaborator.id].sort());

            const accountChangeCount = await db.accountChange.count({
                where: { entityId: session.id },
            });
            const abort = new Error("abort provider grant transaction");
            await expect(inTx(async tx => {
                const result = await putSessionAccessGrantInTx(tx, {
                    actorAccountId: owner.id,
                    sessionId: session.id,
                    subject: { kind: "account", accountId: collaborator.id },
                    grant: { accessLevel: "admin", canApprovePermissions: false },
                    authentication: presentUserAuthentication,
                });
                expect(result).toMatchObject({ ok: true, changed: true });
                throw abort;
            })).rejects.toBe(abort);
            await expect(db.sessionShare.count({
                where: { sessionId: session.id, sharedWithUserId: collaborator.id },
            })).resolves.toBe(0);
            await expect(db.accountChange.count({
                where: { entityId: session.id },
            })).resolves.toBe(accountChangeCount);
            await expect(resolveEffectiveSessionAccess(db, {
                accountId: collaborator.id,
                sessionId: session.id,
                authentication: presentUserAuthentication,
            })).resolves.toMatchObject({ level: "edit" });
        } finally {
            if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
            if (teamId) await db.team.deleteMany({ where: { id: teamId } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, collaborator.id] } } });
        }
    });

    it("keeps restricted-Team point and relational qualification fail-closed on every provider", async () => {
        const suffix = randomUUID();
        const [owner, collaborator] = await Promise.all([
            db.account.create({ data: { publicKey: `restricted-owner-${suffix}`, encryptionMode: "plain" } }),
            db.account.create({ data: { publicKey: `restricted-collaborator-${suffix}`, encryptionMode: "e2ee" } }),
        ]);
        const teamIds: string[] = [];
        let sessionId: string | null = null;
        try {
            const team = await db.team.create({ data: {
                name: `Restricted access ${suffix}`,
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            } });
            teamIds.push(team.id);
            const unqualifiedTeam = await db.team.create({ data: {
                name: `Other restricted access ${suffix}`,
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "email_password" }],
                },
            } });
            teamIds.push(unqualifiedTeam.id);
            await db.teamMembership.create({ data: {
                teamId: team.id,
                accountId: collaborator.id,
                role: "member",
                sessionAccessStartsAt: null,
            } });
            await db.teamMembership.create({ data: {
                teamId: unqualifiedTeam.id,
                accountId: collaborator.id,
                role: "member",
                sessionAccessStartsAt: null,
            } });
            const session = await db.session.create({ data: {
                accountId: owner.id,
                tag: `restricted-${suffix}`,
                encryptionMode: "plain",
                metadata: "{}",
                currentStorageState: "hosted",
                teamGrants: { create: {
                    teamId: team.id,
                    accessLevel: "admin",
                    effectiveAt: new Date(1),
                } },
            } });
            sessionId = session.id;
            await db.sessionTeamGrant.create({ data: {
                sessionId: session.id,
                teamId: unqualifiedTeam.id,
                accessLevel: "admin",
                canApprovePermissions: true,
                effectiveAt: new Date(2),
            } });
            const qualified = {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user" as const,
                authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
            };
            const required = { ...qualified, authenticationEvidence: [] };
            const unavailable = {
                ...required,
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" },
            };

            await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
                accountId: collaborator.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: qualified,
            }))).resolves.toMatchObject({ status: "allowed", access: { level: "admin" } });
            await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
                accountId: collaborator.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: required,
            }))).resolves.toEqual({ status: "authentication_required" });
            await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
                accountId: collaborator.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: unavailable,
            }))).resolves.toEqual({ status: "authentication_unavailable" });

            await inTx(async tx => {
                const qualifiedResolution = await resolveEffectiveSessionAccessWhere({
                    tx,
                    accountId: collaborator.id,
                    capability: "manageAccess",
                    mode: "effective_access_v1",
                    authentication: qualified,
                });
                expect([...qualifiedResolution.qualifiedTeamIds]).toEqual([team.id]);
                const qualifiedRow = await tx.session.findFirst({ where: { AND: [
                    { id: session.id },
                    qualifiedResolution.where,
                ] }, select: buildSessionAccessProjectionSelect(collaborator.id) });
                const requiredRow = await tx.session.findFirst({ where: { AND: [
                    { id: session.id },
                    await buildSessionAccessWhere({
                        tx,
                        accountId: collaborator.id,
                        capability: "manageAccess",
                        mode: "effective_access_v1",
                        authentication: required,
                    }),
                ] }, select: { id: true } });
                const unavailableRow = await tx.session.findFirst({ where: { AND: [
                    { id: session.id },
                    await buildSessionAccessWhere({
                        tx,
                        accountId: collaborator.id,
                        capability: "manageAccess",
                        mode: "effective_access_v1",
                        authentication: unavailable,
                    }),
                ] }, select: { id: true } });
                expect(qualifiedRow).not.toBeNull();
                expect(projectEffectiveSessionAccess(qualifiedRow!, collaborator.id, {
                    qualifiedTeamIds: qualifiedResolution.qualifiedTeamIds,
                })).toMatchObject({
                    level: "admin",
                    sources: [{ kind: "team", teamId: team.id, requiredByTeamPolicy: false }],
                    capabilities: { managePermissionDelegation: false },
                });
                expect(requiredRow).toBeNull();
                expect(unavailableRow).toBeNull();
            });

            await db.sessionTeamGrant.delete({
                where: { sessionId_teamId: { sessionId: session.id, teamId: unqualifiedTeam.id } },
            });
            await db.team.update({
                where: { id: team.id },
                data: { authenticationPolicy: { v: 1, mode: "restricted", accepted: [] } },
            });
            await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
                accountId: collaborator.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: qualified,
            }))).resolves.toEqual({ status: "authentication_unavailable" });
        } finally {
            if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
            if (teamIds.length > 0) await db.team.deleteMany({ where: { id: { in: teamIds } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, collaborator.id] } } });
        }
    });
});
