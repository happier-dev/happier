import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeBase64 } from "privacy-kit";
import tweetnacl from "tweetnacl";
import {
    SESSION_DATA_KEY_ENVELOPE_BYTES_V1,
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
    type SessionInitialAccessMaterializedV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import {
    applyInitialSessionAccessInTx as applyInitialSessionAccessWithAuthenticationInTx,
    deleteSessionAccessGrantInTx as deleteSessionAccessGrantWithAuthenticationInTx,
    putSessionAccessGrantInTx as putSessionAccessGrantWithAuthenticationInTx,
    setSessionAccessContextInTx as setSessionAccessContextWithAuthenticationInTx,
} from "./sessionAccessGrantService";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "./sessionRecipients";
import { inspectSessionAccessGrants } from "./sessionAccessGrantInspection";
import { resolveSessionAccessForOperation } from "./sessionAccess";
import { setSessionFollowSource } from "@/app/session/follow/sessionFollowEdgeService";
import { resolveShareSubjectsInTx } from "@/app/teams/shareEligibility";

const TEST_AUTHENTICATION = {
    env: process.env,
    authority: "present_user",
    authenticationEvidence: [],
} as const;

type PutInput = Omit<Parameters<typeof putSessionAccessGrantWithAuthenticationInTx>[1], "authentication">
    & Partial<Pick<Parameters<typeof putSessionAccessGrantWithAuthenticationInTx>[1], "authentication">>;
type DeleteInput = Omit<Parameters<typeof deleteSessionAccessGrantWithAuthenticationInTx>[1], "authentication">
    & Partial<Pick<Parameters<typeof deleteSessionAccessGrantWithAuthenticationInTx>[1], "authentication">>;
type ContextInput = Omit<Parameters<typeof setSessionAccessContextWithAuthenticationInTx>[1], "authentication">
    & Partial<Pick<Parameters<typeof setSessionAccessContextWithAuthenticationInTx>[1], "authentication">>;

async function putSessionAccessGrantInTx(tx: Parameters<typeof putSessionAccessGrantWithAuthenticationInTx>[0], input: PutInput) {
    return await putSessionAccessGrantWithAuthenticationInTx(tx, { authentication: TEST_AUTHENTICATION, ...input });
}

async function deleteSessionAccessGrantInTx(tx: Parameters<typeof deleteSessionAccessGrantWithAuthenticationInTx>[0], input: DeleteInput) {
    return await deleteSessionAccessGrantWithAuthenticationInTx(tx, { authentication: TEST_AUTHENTICATION, ...input });
}

async function setSessionAccessContextInTx(tx: Parameters<typeof setSessionAccessContextWithAuthenticationInTx>[0], input: ContextInput) {
    return await setSessionAccessContextWithAuthenticationInTx(tx, { authentication: TEST_AUTHENTICATION, ...input });
}

async function applyInitialSessionAccessInTx(
    tx: Parameters<typeof applyInitialSessionAccessWithAuthenticationInTx>[0],
    input: Omit<Parameters<typeof applyInitialSessionAccessWithAuthenticationInTx>[1], "authentication">
        & Partial<Pick<Parameters<typeof applyInitialSessionAccessWithAuthenticationInTx>[1], "authentication">>,
) {
    return await applyInitialSessionAccessWithAuthenticationInTx(tx, {
        authentication: TEST_AUTHENTICATION,
        ...input,
    });
}

async function createAccount(
    prefix: string,
    options: Readonly<{ encryptionMode?: "plain" | "e2ee" }> = {},
): Promise<{ id: string }> {
    return await db.account.create({
        data: {
            publicKey: `${prefix}-${crypto.randomUUID()}`,
            encryptionMode: options.encryptionMode ?? "plain",
        },
        select: { id: true },
    });
}

describe("Session access grant service (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-access-grants-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 180_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.publicSessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'group' } }),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'team' } }),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'account' } }),
            () => db.teamGroupMembership.deleteMany(),
            () => db.teamGroup.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.userRelationship.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("resolves initial collective grant eligibility with one membership-set read for a Team and its 120 Groups", async () => {
        const actor = await createAccount("eligibility-cost");
        const team = await db.team.create({ data: { name: "Initial grant cost" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
        const groups = Array.from({ length: 120 }, (_, index) => ({
            id: crypto.randomUUID(), teamId: team.id, name: storedPlainPrivateLabel(`Group ${index}`),
        }));
        await db.teamGroup.createMany({ data: groups });
        await inTx(async tx => {
            const membershipReads = vi.fn(tx.teamMembership.findMany.bind(tx.teamMembership));
            const instrumentedTx = Object.assign(Object.create(tx), {
                teamMembership: Object.assign(Object.create(tx.teamMembership), { findMany: membershipReads }),
            });
            const result = await resolveShareSubjectsInTx(instrumentedTx, {
                actorAccountId: actor.id, resourceOwnerAccountId: actor.id, hasExistingGrant: false,
                subjects: [{ kind: "team", teamId: team.id }, ...groups.map(group => ({ kind: "group" as const, teamId: team.id, groupId: group.id }))],
            });
            expect(result).toHaveLength(121);
            expect(result.every(row => row.eligibility.ok)).toBe(true);
            expect(membershipReads).toHaveBeenCalledTimes(1);
        });
    });

    async function createFixture(options?: { collaboratorTeamRole?: "member" | "guest" }) {
        const owner = await createAccount("grant-owner");
        const collaborator = await createAccount("grant-collaborator");
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `grant-${crypto.randomUUID()}`,
                encryptionMode: "plain",
                metadata: JSON.stringify({}),
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
        const team = await db.team.create({
            data: { name: `Acme ${crypto.randomUUID()}` },
            select: { id: true },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
        });
        await db.teamMembership.create({
            data: {
                teamId: team.id,
                accountId: collaborator.id,
                role: options?.collaboratorTeamRole ?? "member",
            },
        });
        return { owner, collaborator, session, team };
    }

    it("requires the acting credential to qualify restricted Team-derived grant authority", async () => {
        const fixture = await createFixture();
        const manager = await createAccount("credential-manager", { encryptionMode: "e2ee" });
        await db.teamMembership.create({
            data: { teamId: fixture.team.id, accountId: manager.id, role: "member" },
        });
        await db.team.update({
            where: { id: fixture.team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'team',
                sessionId: fixture.session.id,
                teamId: fixture.team.id,
                accessLevel: "admin",
                effectiveAt: new Date(),
            },
        });
        const input = {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            ...input,
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user",
                authenticationEvidence: [],
            },
        }))).toEqual({ ok: false, error: "session_access_authentication_required" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            ...input,
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        }))).toMatchObject({ ok: true, changed: true });
    });

    it("keeps an admitted birth during a Team policy flip and applies the required floor to the next birth", async () => {
        const fixture = await createFixture();
        let admissions = 0;
        const create = async (flipPolicy: boolean) => inTx(async tx => {
            const session = await tx.session.create({ data: {
                accountId: fixture.owner.id, tag: crypto.randomUUID(), primaryTeamId: fixture.team.id,
                encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
            } });
            const result = await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id, sessionId: session.id, initialAccess: { grants: [] },
            });
            expect(result.ok).toBe(true);
            admissions++;
            if (flipPolicy && admissions === 1) {
                // The finite birth has already been admitted. A policy change
                // at this boundary belongs to the next birth, not a replay.
                await tx.team.update({ where: { id: fixture.team.id }, data: { sessionCreationPolicy: "team_required" } });
            }
            return session.id;
        });
        const admittedSessionId = await create(true);
        expect(admissions).toBe(1);
        expect(await db.sessionGrant.count({ where: { principalKind: 'team', sessionId: admittedSessionId } })).toBe(0);
        const nextSessionId = await create(false);
        expect(await db.sessionGrant.findUnique({ where: { principalKind: 'team', sessionId_teamId: {
            sessionId: nextSessionId, teamId: fixture.team.id,
        } }, select: { requiredByTeamPolicy: true, accessLevel: true } }))
            .toEqual({ requiredByTeamPolicy: true, accessLevel: "edit" });
    });

    it("initial access commits overlapping custom grants with one final recipient delta in the outer transaction", async () => {
        const fixture = await createFixture();
        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: fixture.team.id, accountId: fixture.collaborator.id } },
        });
        const group = await db.teamGroup.create({ data: { teamId: fixture.team.id, name: storedPlainPrivateLabel("Initial") } });
        await db.teamGroupMembership.create({ data: {
            teamId: fixture.team.id, teamGroupId: group.id, teamMembershipId: membership.id,
        } });
        const sessionId = crypto.randomUUID();
        const result = await inTx(async (tx) => {
            await tx.session.create({ data: {
                id: sessionId, accountId: fixture.owner.id, tag: sessionId,
                encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
            } });
            return await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id,
                sessionId,
                initialAccess: { grants: [
                    { subject: { kind: "account", accountId: fixture.collaborator.id }, accessLevel: "edit", canApprovePermissions: false },
                    { subject: { kind: "team", teamId: fixture.team.id }, accessLevel: "view", canApprovePermissions: false },
                    { subject: { kind: "group", teamId: fixture.team.id, groupId: group.id }, accessLevel: "admin", canApprovePermissions: true },
                ] },
            });
        });
        expect(result).toMatchObject({ ok: true, effects: {
            grantedAccountIds: [fixture.collaborator.id], changedAccountIds: [fixture.collaborator.id], revokedAccountIds: [],
        } });
        expect(await db.sessionGrant.findMany({ where: { principalKind: 'account', sessionId } })).toMatchObject([
            { accountId: fixture.collaborator.id, accessLevel: "edit", canApprovePermissions: false },
        ]);
        expect(await db.sessionGrant.findMany({ where: { principalKind: 'team', sessionId } })).toMatchObject([
            { teamId: fixture.team.id, accessLevel: "view", requiredByTeamPolicy: false },
        ]);
        expect(await db.sessionGrant.findMany({ where: { principalKind: 'group', sessionId } })).toMatchObject([
            { teamGroupId: group.id, accessLevel: "admin", canApprovePermissions: true },
        ]);
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId } })).toBe(0);
    });

    it.each(["account", "team", "group"] as const)(
        "materializes initial %s access without enrolling private Follow or read state",
        async (kind) => {
            const fixture = await createFixture();
            const group = kind === "group"
                ? await db.teamGroup.create({ data: { teamId: fixture.team.id, name: storedPlainPrivateLabel("Initial Follow") } })
                : null;
            if (group) {
                const membership = await db.teamMembership.findUniqueOrThrow({
                    where: { teamId_accountId: { teamId: fixture.team.id, accountId: fixture.collaborator.id } },
                });
                await db.teamGroupMembership.create({ data: {
                    teamId: fixture.team.id,
                    teamGroupId: group.id,
                    teamMembershipId: membership.id,
                } });
            }
            await db.account.update({
                where: { id: fixture.collaborator.id },
                data: {
                    sessionAutoFollowDirect: kind === "account",
                    sessionAutoFollowTeam: kind === "team",
                    sessionAutoFollowGroup: kind === "group",
                },
            });
            const sessionId = crypto.randomUUID();
            let grant: SessionInitialAccessMaterializedV1["grants"][number];
            if (kind === "account") {
                grant = {
                    subject: { kind: "account", accountId: fixture.collaborator.id },
                    accessLevel: "view",
                    canApprovePermissions: false,
                };
            } else if (kind === "team") {
                grant = {
                    subject: { kind: "team", teamId: fixture.team.id },
                    accessLevel: "view",
                    canApprovePermissions: false,
                };
            } else {
                if (!group) throw new Error("group fixture was not created");
                grant = {
                    subject: { kind: "group", teamId: fixture.team.id, groupId: group.id },
                    accessLevel: "view",
                    canApprovePermissions: false,
                };
            }
            await inTx(async (tx) => {
                await tx.session.create({ data: {
                    id: sessionId,
                    accountId: fixture.owner.id,
                    tag: sessionId,
                    encryptionMode: "plain",
                    metadata: "{}",
                    currentStorageState: "hosted",
                } });
                expect(await applyInitialSessionAccessInTx(tx, {
                    creatorAccountId: fixture.owner.id,
                    sessionId,
                    initialAccess: { grants: [grant] },
                })).toMatchObject({ ok: true });
            });
            const where = { accountId_sessionId: { accountId: fixture.collaborator.id, sessionId } };
            expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
            expect(await db.accountSessionReadState.findUnique({ where })).toBeNull();
        },
    );

    it("initial access validates the complete audience before writes and rolls back with fresh creation", async () => {
        const fixture = await createFixture();
        const stranger = await createAccount("initial-ineligible");
        const sessionId = crypto.randomUUID();
        const abort = new Error("reject initial access");
        await expect(inTx(async (tx) => {
            await tx.session.create({ data: {
                id: sessionId, accountId: fixture.owner.id, tag: sessionId,
                encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
            } });
            const result = await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id, sessionId,
                initialAccess: { grants: [
                    { subject: { kind: "account", accountId: fixture.collaborator.id }, accessLevel: "edit", canApprovePermissions: false },
                    { subject: { kind: "account", accountId: stranger.id }, accessLevel: "view", canApprovePermissions: false },
                ] },
            });
            expect(result).toEqual({ ok: false, error: "session_access_subject_ineligible" });
            expect(await tx.sessionGrant.count({ where: { principalKind: 'account', sessionId } })).toBe(0);
            expect(await tx.accountChange.count({ where: { entityId: sessionId } })).toBe(0);
            throw abort;
        })).rejects.toBe(abort);
        expect(await db.session.findUnique({ where: { id: sessionId } })).toBeNull();
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId } })).toBe(0);
        expect(await db.accountChange.count({ where: { entityId: sessionId } })).toBe(0);
    });

    it("initial access grants and change intents roll back when the outer materialization fails later", async () => {
        const fixture = await createFixture();
        const sessionId = crypto.randomUUID();
        const abort = new Error("later materialization failed");
        await expect(inTx(async (tx) => {
            await tx.session.create({ data: {
                id: sessionId, accountId: fixture.owner.id, tag: sessionId,
                encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
            } });
            expect(await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id, sessionId,
                initialAccess: { grants: [
                    { subject: { kind: "account", accountId: fixture.collaborator.id }, accessLevel: "edit", canApprovePermissions: false },
                ] },
            })).toMatchObject({ ok: true });
            expect(await tx.sessionGrant.count({ where: { principalKind: 'account', sessionId } })).toBe(1);
            throw abort;
        })).rejects.toBe(abort);
        expect(await db.session.findUnique({ where: { id: sessionId } })).toBeNull();
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId } })).toBe(0);
        expect(await db.accountChange.count({ where: { entityId: sessionId } })).toBe(0);
        expect(await db.accountSessionFollow.count({ where: { sessionId } })).toBe(0);
    });

    it.each([
        { policy: "private_default" as const, explicit: false, required: false, hasGrant: false },
        { policy: "team_default" as const, explicit: false, required: false, hasGrant: false },
        { policy: "team_default" as const, explicit: true, required: false, hasGrant: true },
        { policy: "team_required" as const, explicit: false, required: true, hasGrant: true },
        { policy: "team_required" as const, explicit: true, required: true, hasGrant: true },
    ])("initial access applies current $policy policy with explicit=$explicit without inferring audience from context", async ({ policy, explicit, required, hasGrant }) => {
        const fixture = await createFixture();
        const sessionId = crypto.randomUUID();
        await inTx(async (tx) => {
            // Read the policy changed in this transaction, not a preflight snapshot.
            await tx.team.update({ where: { id: fixture.team.id }, data: { sessionCreationPolicy: policy } });
            await tx.session.create({ data: {
                id: sessionId, accountId: fixture.owner.id, tag: sessionId,
                primaryTeamId: fixture.team.id,
                encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
            } });
            const result = await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id, sessionId,
                initialAccess: { grants: explicit ? [
                    { subject: { kind: "team", teamId: fixture.team.id }, accessLevel: "admin", canApprovePermissions: true },
                ] : [] },
            });
            expect(result).toMatchObject({ ok: true });
        });
        const grants = await db.sessionGrant.findMany({ where: { principalKind: 'team', sessionId } });
        if (!hasGrant) {
            expect(grants).toEqual([]);
        } else {
            expect(grants).toMatchObject([{ teamId: fixture.team.id, requiredByTeamPolicy: required }]);
            if (explicit) {
                expect(grants).toMatchObject([{ accessLevel: "admin", canApprovePermissions: true }]);
            } else if (policy === "team_required") {
                expect(grants).toMatchObject([{ accessLevel: "edit", canApprovePermissions: false }]);
            }
        }
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId } })).toBe(0);
    });

    it("raises an explicit primary-Team View draft to the required Edit minimum", async () => {
        const fixture = await createFixture();
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        const sessionId = crypto.randomUUID();
        await inTx(async (tx) => {
            await tx.session.create({ data: {
                id: sessionId,
                accountId: fixture.owner.id,
                tag: sessionId,
                primaryTeamId: fixture.team.id,
                encryptionMode: "plain",
                metadata: "{}",
                currentStorageState: "hosted",
            } });
            expect(await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id,
                sessionId,
                initialAccess: { grants: [{
                    subject: { kind: "team", teamId: fixture.team.id },
                    accessLevel: "view",
                    canApprovePermissions: false,
                }] },
            })).toMatchObject({ ok: true });
        });

        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId, teamId: fixture.team.id } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        })).resolves.toEqual({
            accessLevel: "edit",
            canApprovePermissions: false,
            requiredByTeamPolicy: true,
        });
    });

    it("initial access checks inserted Session creator even for a private draft", async () => {
        const fixture = await createFixture();
        expect(await inTx((tx) => applyInitialSessionAccessInTx(tx, {
            creatorAccountId: fixture.collaborator.id, sessionId: fixture.session.id, initialAccess: { grants: [] },
        }))).toEqual({ ok: false, error: "session_initial_access_creator_mismatch" });
        expect(await inTx((tx) => applyInitialSessionAccessInTx(tx, {
            creatorAccountId: fixture.owner.id, sessionId: fixture.session.id, initialAccess: { grants: [] },
        }))).toMatchObject({ ok: true, effects: { changedAccountIds: [], grantedAccountIds: [], revokedAccountIds: [] } });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.sessionGrant.count({ where: { principalKind: 'team', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { entityId: fixture.session.id } })).toBe(0);
    });

    it("rejects supplied current-operation recipient material for a Plain Session before granting access", async () => {
        const fixture = await createFixture();
        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
            accountEnvelopeInput: {
                v: 1 as const,
                encryptedDataKey: encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1)),
            },
        };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, input))).toEqual({
            ok: false,
            error: "data_key_not_required",
        });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: fixture.session.id } })).toBe(0);
    });

    it("Plain direct grants do not query recipient crypto fields or the envelope tuple", async () => {
        const fixture = await createFixture();
        const guardPlainCryptoReads = <T extends Parameters<typeof putSessionAccessGrantWithAuthenticationInTx>[0]>(tx: T): T => {
            const account = new Proxy(tx.account, {
                get(target, property, receiver) {
                    if (property === "findUniqueOrThrow") {
                        return async () => { throw new Error("Plain grant queried recipient crypto fields"); };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            const sessionDataKeyEnvelope = new Proxy(tx.sessionDataKeyEnvelope, {
                get(target, property, receiver) {
                    if (property === "findUnique") {
                        return async () => { throw new Error("Plain grant queried an envelope tuple"); };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            return new Proxy(tx, {
                get(target, property, receiver) {
                    if (property === "account") return account;
                    if (property === "sessionDataKeyEnvelope") return sessionDataKeyEnvelope;
                    return Reflect.get(target, property, receiver);
                },
            });
        };

        expect(await inTx((tx) => putSessionAccessGrantInTx(guardPlainCryptoReads(tx), {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toMatchObject({ ok: true, changed: true });
    });

    async function createEncryptedFixture() {
        const fixture = await createFixture();
        const recipientKeyPair = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipientKeyPair.publicKey);
        await db.account.update({ where: { id: fixture.collaborator.id }, data: {
            encryptionMode: "e2ee", publicKey: binding.publicKey,
            contentPublicKey: Buffer.from(binding.contentPublicKey),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig),
        } });
        await db.session.update({ where: { id: fixture.session.id }, data: { encryptionMode: "e2ee" } });
        const dataKey = tweetnacl.randomBytes(32);
        const envelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: binding.contentPublicKey,
            randomBytes: length => tweetnacl.randomBytes(length),
        });
        const input = {
            actorAccountId: fixture.owner.id, sessionId: fixture.session.id,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        return { ...fixture, recipientKeyPair, dataKey, envelope, input };
    }

    it("current envelope admission requires a ready recipient's tuple and atomically stores an openable key", async () => {
        const fixture = await createEncryptedFixture();
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, fixture.input))).toEqual({
            ok: false, error: "recipient_envelope_required",
        });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { entityId: fixture.session.id } })).toBe(0);

        const supplied = { ...fixture.input, accountEnvelopeInput: {
            v: 1 as const, encryptedDataKey: encodeBase64(new Uint8Array(fixture.envelope)),
        } };
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, supplied))).toMatchObject({ ok: true, changed: true });
        const tupleWhere = { sessionId_recipientAccountId: {
            sessionId: fixture.session.id, recipientAccountId: fixture.collaborator.id,
        } };
        const tuple = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere });
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(tuple.encryptedDataKey),
            recipientSecretKeyOrSeed: fixture.recipientKeyPair.secretKey,
        })).toEqual(fixture.dataKey);
        const cursor = await db.account.findUniqueOrThrow({ where: { id: fixture.collaborator.id }, select: { seq: true } });
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, supplied))).toMatchObject({ ok: true, changed: false });
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, fixture.input))).toMatchObject({ ok: true, changed: false });
        expect(await db.account.findUniqueOrThrow({ where: { id: fixture.collaborator.id }, select: { seq: true } })).toEqual(cursor);

        // An ordinary access edit consumes the existing canonical tuple, without
        // forcing another key transfer or changing its bytes.
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
            ...fixture.input, grant: { accessLevel: "edit", canApprovePermissions: false },
        }))).toMatchObject({ ok: true, changed: true });
        expect((await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere })).encryptedDataKey)
            .toEqual(tuple.encryptedDataKey);

        // Revocation makes the tuple inert rather than destroying it. A later
        // key-free regrant lets this transaction re-admit that exact retained
        // tuple without asking the host to transfer the Session DEK again.
        expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, fixture.input))).toMatchObject({
            ok: true, changed: true,
        });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect((await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere })).encryptedDataKey)
            .toEqual(tuple.encryptedDataKey);
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, fixture.input))).toMatchObject({
            ok: true, changed: true,
        });
        expect((await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere })).encryptedDataKey)
            .toEqual(tuple.encryptedDataKey);
    });

    it("initial access composes a supplied direct recipient envelope in the creation transaction", async () => {
        const fixture = await createEncryptedFixture();
        const result = await inTx((tx) => applyInitialSessionAccessInTx(tx, {
            creatorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            initialAccess: { grants: [{
                subject: { kind: "account", accountId: fixture.collaborator.id },
                accessLevel: "view",
                canApprovePermissions: false,
                accountEnvelopeInput: {
                    v: 1,
                    encryptedDataKey: encodeBase64(new Uint8Array(fixture.envelope)),
                },
            }] },
        }));
        expect(result).toMatchObject({ ok: true });
        const tuple = await db.sessionDataKeyEnvelope.findUniqueOrThrow({
            where: {
                sessionId_recipientAccountId: {
                    sessionId: fixture.session.id,
                    recipientAccountId: fixture.collaborator.id,
                },
            },
        });
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(tuple.encryptedDataKey),
            recipientSecretKeyOrSeed: fixture.recipientKeyPair.secretKey,
        })).toEqual(fixture.dataKey);
    });

    it("initial access rejects recipient envelope material for a Plain Session", async () => {
        const fixture = await createEncryptedFixture();
        await db.session.update({ where: { id: fixture.session.id }, data: { encryptionMode: "plain" } });

        const result = await inTx((tx) => applyInitialSessionAccessInTx(tx, {
            creatorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            initialAccess: { grants: [{
                subject: { kind: "account", accountId: fixture.collaborator.id },
                accessLevel: "view",
                canApprovePermissions: false,
                accountEnvelopeInput: {
                    v: 1,
                    encryptedDataKey: encodeBase64(new Uint8Array(fixture.envelope)),
                },
            }] },
        }));

        expect(result).toEqual({ ok: false, error: "data_key_not_required" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: fixture.session.id } })).toBe(0);
    });

    it("fails a direct grant closed when the persisted Session encryption mode is malformed", async () => {
        const fixture = await createEncryptedFixture();
        await db.session.update({
            where: { id: fixture.session.id },
            data: { encryptionMode: "unsupported" },
        });

        expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
            ...fixture.input,
            accountEnvelopeInput: {
                v: 1,
                encryptedDataKey: encodeBase64(new Uint8Array(fixture.envelope)),
            },
        }))).toEqual({ ok: false, error: "invalid_request" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: fixture.session.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { entityId: fixture.session.id } })).toBe(0);
    });

    it("current envelope admission rejects malformed material before changes and repairs an invalid stored tuple", async () => {
        const fixture = await createEncryptedFixture();
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: fixture.session.id, createdByAccountId: fixture.owner.id,
            accountId: fixture.collaborator.id, accessLevel: "view",
        } });
        const tupleWhere = { sessionId_recipientAccountId: {
            sessionId: fixture.session.id, recipientAccountId: fixture.collaborator.id,
        } };
        const malformed = new Uint8Array([7, 8, 9]);
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: fixture.session.id, recipientAccountId: fixture.collaborator.id,
            encryptedDataKey: Buffer.from(malformed),
        } });
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, fixture.input))).toEqual({
            ok: false, error: "recipient_envelope_required",
        });
        const invalid = { ...fixture.input, grant: { accessLevel: "admin" as const, canApprovePermissions: true },
            accountEnvelopeInput: { v: 1 as const, encryptedDataKey: encodeBase64(malformed) },
        };
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, invalid))).toEqual({ ok: false, error: "invalid_request" });
        expect(await db.sessionGrant.findMany({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toMatchObject([
            { accessLevel: "view", canApprovePermissions: false },
        ]);
        expect(await db.accountChange.count({ where: { entityId: fixture.session.id } })).toBe(0);
        expect((await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere })).encryptedDataKey)
            .toEqual(malformed);

        const supplied = { ...fixture.input, accountEnvelopeInput: { v: 1 as const, encryptedDataKey: encodeBase64(new Uint8Array(fixture.envelope)) } };
        const abort = new Error("abort envelope and grant transaction");
        await expect(inTx(async tx => {
            expect(await putSessionAccessGrantInTx(tx, supplied)).toMatchObject({ ok: true, changed: true });
            throw abort;
        })).rejects.toBe(abort);
        expect((await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere })).encryptedDataKey)
            .toEqual(malformed);
        expect(await db.accountChange.count({ where: { entityId: fixture.session.id } })).toBe(0);
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, supplied))).toMatchObject({
            ok: true, changed: true, effects: { changedAccountIds: [fixture.collaborator.id] },
        });
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array((await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: tupleWhere })).encryptedDataKey),
            recipientSecretKeyOrSeed: fixture.recipientKeyPair.secretKey,
        })).toEqual(fixture.dataKey);
    });

    it("current envelope admission rechecks recipient readiness in the grant transaction and allows keyless pending access", async () => {
        const fixture = await createEncryptedFixture();
        const supplied = { ...fixture.input, accountEnvelopeInput: { v: 1 as const, encryptedDataKey: encodeBase64(new Uint8Array(fixture.envelope)) } };
        expect(await inTx(async tx => {
            await tx.account.update({ where: { id: fixture.collaborator.id }, data: {
                contentPublicKey: null, contentPublicKeySig: null,
            } });
            return await putSessionAccessGrantInTx(tx, supplied);
        })).toEqual({ ok: false, error: "recipient_key_unavailable" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: fixture.session.id } })).toBe(0);
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: fixture.session.id } })).toBe(0);
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, fixture.input))).toMatchObject({ ok: true, changed: true });
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: fixture.session.id } })).toBe(0);
        await inTx(tx => deleteSessionAccessGrantInTx(tx, fixture.input));
        await db.account.update({ where: { id: fixture.collaborator.id }, data: { encryptionMode: "plain" } });
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, fixture.input))).toMatchObject({ ok: true, changed: true });
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, supplied))).toEqual({ ok: false, error: "recipient_key_unavailable" });
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: fixture.session.id } })).toBe(0);
    });

    it("rejects a new direct grant when friendship was removed in the deciding transaction", async () => {
        const fixture = await createFixture();
        const recipient = await createAccount("friend-recipient");
        await db.userRelationship.create({ data: {
            fromUserId: fixture.owner.id,
            toUserId: recipient.id,
            status: "friend",
        } });
        const result = await inTx(async (tx) => {
            await tx.userRelationship.deleteMany({ where: {
                fromUserId: fixture.owner.id,
                toUserId: recipient.id,
            } });
            return await putSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: recipient.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
            });
        });
        expect(result).toEqual({ ok: false, error: "session_access_subject_ineligible" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'account',
            sessionId: fixture.session.id,
            accountId: recipient.id,
        } })).toBe(0);
    });

    it("preserves a historical Follow across overlapping grants and removes it on final access loss", async () => {
        const fixture = await createFixture();
        await db.$executeRaw`UPDATE Account SET sessionAutoFollowTeam = true WHERE id = ${fixture.collaborator.id}`;
        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team" as const, teamId: fixture.team.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, input))).toMatchObject({ ok: true });
        const where = { accountId_sessionId: { accountId: fixture.collaborator.id, sessionId: fixture.session.id } };
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        await db.accountSessionFollow.create({ data: {
            accountId: fixture.collaborator.id, sessionId: fixture.session.id,
            following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        expect(await db.accountSessionFollow.count({ where: { accountId: fixture.owner.id } })).toBe(0);
        const direct = { ...input, subject: { kind: "account" as const, accountId: fixture.collaborator.id } };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, direct))).toMatchObject({ ok: true });
        await inTx((tx) => deleteSessionAccessGrantInTx(tx, input));
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({ following: true });
        await inTx((tx) => deleteSessionAccessGrantInTx(tx, direct));
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
    });

    it("retains Session Follow across overlapping grant loss and removes only invalid edges on final loss in the grant transaction", async () => {
        const fixture = await createFixture();
        const teamGrant = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team" as const, teamId: fixture.team.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        const directGrant = {
            ...teamGrant,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
        };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, teamGrant))).toMatchObject({ ok: true });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, directGrant))).toMatchObject({ ok: true });
        const destinations: { id: string }[] = [];
        for (const account of [fixture.owner, fixture.collaborator]) {
            const destination = await db.session.create({ data: {
                accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            expect(await setSessionFollowSource({
                accountId: account.id, sourceSessionId: fixture.session.id,
                destinationSessionId: destination.id,
                policy: { preset: 'quiet' },
                authentication: TEST_AUTHENTICATION,
            })).toMatchObject({ ok: true });
            destinations.push(destination);
        }
        const edgeWhere = { sourceSessionId: fixture.session.id };
        expect(await inTx((tx) => deleteSessionAccessGrantInTx(tx, directGrant))).toMatchObject({
            ok: true, effects: { revokedAccountIds: [] },
        });
        expect(await db.sessionFollowEdge.count({ where: edgeWhere })).toBe(2);

        // Observe deletion before commit, then prove an aborted grant mutation
        // cannot leave Follow state changed independently of access.
        const rollback = new Error("abort access transition");
        await expect(inTx(async (tx) => {
            expect(await deleteSessionAccessGrantInTx(tx, teamGrant)).toMatchObject({
                ok: true, effects: { revokedAccountIds: [fixture.collaborator.id] },
            });
            expect(await tx.sessionFollowEdge.findMany({ where: edgeWhere, select: { destinationSessionId: true } }))
                .toEqual([{ destinationSessionId: destinations[0].id }]);
            throw rollback;
        })).rejects.toBe(rollback);
        expect(await db.sessionFollowEdge.count({ where: edgeWhere })).toBe(2);

        expect(await inTx((tx) => deleteSessionAccessGrantInTx(tx, teamGrant))).toMatchObject({ ok: true });
        expect(await db.sessionFollowEdge.findMany({ where: edgeWhere, select: { destinationSessionId: true } }))
            .toEqual([{ destinationSessionId: destinations[0].id }]);
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, teamGrant))).toMatchObject({ ok: true });
        expect(await db.sessionFollowEdge.count({ where: edgeWhere })).toBe(1);
    });

    it("removes Follow when a non-runtime destination audience member loses source access", async () => {
        const fixture = await createFixture();
        const destination = await db.session.create({ data: {
            accountId: fixture.owner.id,
            tag: `follow-destination-${crypto.randomUUID()}`,
            metadata: "{}",
            encryptionMode: "plain",
        } });
        const sourceGrant = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team" as const, teamId: fixture.team.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        const destinationGrant = { ...sourceGrant, sessionId: destination.id };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, sourceGrant))).toMatchObject({ ok: true });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, destinationGrant))).toMatchObject({ ok: true });
        expect(await setSessionFollowSource({
            accountId: fixture.owner.id,
            sourceSessionId: fixture.session.id,
            destinationSessionId: destination.id,
            policy: { preset: 'quiet' },
            authentication: TEST_AUTHENTICATION,
        })).toMatchObject({ ok: true });

        await db.accountChange.deleteMany();

        expect(await inTx((tx) => deleteSessionAccessGrantInTx(tx, sourceGrant))).toMatchObject({
            ok: true,
            effects: { revokedAccountIds: [fixture.collaborator.id] },
        });
        expect(await db.sessionFollowEdge.findUnique({
            where: { destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: destination.id,
                sourceSessionId: fixture.session.id,
                relation: "follower",
            } },
        })).toBeNull();
        const destinationInvalidations = await db.accountChange.findMany({
            where: { kind: "session", entityId: destination.id },
            select: { accountId: true },
        });
        expect(new Set(destinationInvalidations.map(({ accountId }) => accountId))).toEqual(new Set([
            fixture.owner.id,
            fixture.collaborator.id,
        ]));
        expect(destinationInvalidations).toHaveLength(2);
    });

    it("keeps Group default-rule intent independent of access materialization", async () => {
        const fixture = await createFixture();
        const membership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: fixture.team.id, accountId: fixture.collaborator.id } } });
        const group = await db.teamGroup.create({ data: { teamId: fixture.team.id, name: storedPlainPrivateLabel("Group") } });
        await db.teamGroupMembership.create({ data: { teamId: fixture.team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        await db.account.update({ where: { id: fixture.collaborator.id }, data: { sessionAutoFollowGroup: true, sessionAutoFollowTeam: false } });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "group", teamId: fixture.team.id, groupId: group.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toMatchObject({ ok: true });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: fixture.collaborator.id, sessionId: fixture.session.id } } })).toBeNull();
    });

    it("does not follow historical grants on preference enable or erase explicit suppression on revocation", async () => {
        const fixture = await createFixture();
        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        await inTx((tx) => putSessionAccessGrantInTx(tx, input));
        await db.account.update({ where: { id: fixture.collaborator.id }, data: { sessionAutoFollowDirect: true } });
        await inTx((tx) => putSessionAccessGrantInTx(tx, { ...input, grant: { accessLevel: "edit", canApprovePermissions: false } }));
        const where = { accountId_sessionId: { accountId: fixture.collaborator.id, sessionId: fixture.session.id } };
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        await inTx((tx) => deleteSessionAccessGrantInTx(tx, input));
        await inTx((tx) => putSessionAccessGrantInTx(tx, input));
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        await db.accountSessionFollow.create({ data: {
            accountId: fixture.collaborator.id, sessionId: fixture.session.id,
            following: false, followPolicy: JSON.stringify({ preset: "custom", events: {} }),
        } });
        await inTx((tx) => deleteSessionAccessGrantInTx(tx, input));
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({ following: false });
        await inTx((tx) => putSessionAccessGrantInTx(tx, input));
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({ following: false });
    });

    it("grants direct access to overlapping and new readers without creating Follow choices", async () => {
        const fixture = await createFixture();
        // A friend outside the Team: the direct grant is their only read source.
        const newReader = await createAccount("grant-new-reader");
        await db.userRelationship.create({ data: { fromUserId: fixture.owner.id, toUserId: newReader.id, status: "friend" } });
        await db.account.update({ where: { id: fixture.collaborator.id }, data: { sessionAutoFollowDirect: true, sessionAutoFollowTeam: false } });
        await db.account.update({ where: { id: newReader.id }, data: { sessionAutoFollowDirect: true } });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toMatchObject({ ok: true });

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
            grant: { accessLevel: "edit", canApprovePermissions: false },
        }))).toMatchObject({ ok: true, changed: true });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: fixture.collaborator.id, sessionId: fixture.session.id } } })).toBeNull();

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: newReader.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toMatchObject({ ok: true, changed: true });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: newReader.id, sessionId: fixture.session.id } } })).toBeNull();
    });

    async function writeDraft(accountId: string, sessionId: string): Promise<string> {
        const key = sessionDraftPhysicalKey({ kind: "session", sessionId });
        if (!key) throw new Error("expected a session draft key");
        await db.userKVStore.create({
            data: { accountId, key, value: new Uint8Array([1, 2, 3]), version: 1 },
        });
        return key;
    }

    async function readDraftValue(accountId: string, key: string): Promise<Uint8Array | null> {
        const row = await db.userKVStore.findUnique({
            where: { accountId_key: { accountId, key } },
            select: { value: true },
        });
        return row?.value ?? null;
    }

    it("keeps an overlapping Team collaborator's access and draft when the direct grant is removed", async () => {
        const fixture = await createFixture();
        const draftKey = await writeDraft(fixture.collaborator.id, fixture.session.id);

        const seeded = await inTx(async (tx) => {
            const team = await putSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "team", teamId: fixture.team.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
            });
            const direct = await putSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: fixture.collaborator.id },
                grant: { accessLevel: "edit", canApprovePermissions: false },
            });
            return { team, direct };
        });
        expect(seeded.team.ok && seeded.team.changed).toBe(true);
        expect(seeded.direct.ok && seeded.direct.changed).toBe(true);

        const removal = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
        }));

        expect(removal.ok).toBe(true);
        if (!removal.ok) return;
        // Removing one of two sources is a downgrade, not a revocation.
        expect(removal.effects.revokedAccountIds).toEqual([]);
        expect(removal.effects.changedAccountIds).toEqual([fixture.collaborator.id]);
        expect(await readDraftValue(fixture.collaborator.id, draftKey)).not.toBeNull();
        expect(await inTx(async (tx) => await resolveCurrentSessionRecipientAccountIdsInTx(tx, {
            sessionId: fixture.session.id,
        }))).toEqual(expect.arrayContaining([fixture.owner.id, fixture.collaborator.id]));
    });

    it("invalidates the current projection when a weaker direct grant is removed under stronger Team access", async () => {
        const fixture = await createFixture();

        await inTx(async (tx) => {
            await putSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "team", teamId: fixture.team.id },
                grant: { accessLevel: "admin", canApprovePermissions: false },
            });
            await putSessionAccessGrantInTx(tx, {
                actorAccountId: fixture.owner.id,
                sessionId: fixture.session.id,
                subject: { kind: "account", accountId: fixture.collaborator.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
            });
        });

        const removal = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
        }));

        expect(removal.ok).toBe(true);
        if (!removal.ok) return;
        expect(removal.effects.revokedAccountIds).toEqual([]);
        expect(removal.effects.changedAccountIds).toEqual([fixture.collaborator.id]);
        expect(removal.effects.accountCursors.get(fixture.collaborator.id)?.resolveCursor()).toBeGreaterThan(0);
    });

    it("revokes and tombstones only when the final source is removed", async () => {
        const fixture = await createFixture();
        const draftKey = await writeDraft(fixture.collaborator.id, fixture.session.id);

        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }));

        const removal = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
        }));

        expect(removal.ok).toBe(true);
        if (!removal.ok) return;
        expect(removal.effects.revokedAccountIds).toEqual([fixture.collaborator.id]);
        expect(await readDraftValue(fixture.collaborator.id, draftKey)).toBeNull();
        expect(await inTx(async (tx) => await resolveCurrentSessionRecipientAccountIdsInTx(tx, {
            sessionId: fixture.session.id,
        }))).toEqual([fixture.owner.id]);
    });

    it("treats an identical desired state as a no-op that wakes nobody", async () => {
        const fixture = await createFixture();
        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
            grant: { accessLevel: "edit", canApprovePermissions: false },
        }));
        const changesAfterFirst = await db.accountChange.count();

        const repeat = await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
            grant: { accessLevel: "edit", canApprovePermissions: false },
        }));

        expect(repeat.ok).toBe(true);
        if (!repeat.ok) return;
        expect(repeat.changed).toBe(false);
        expect(repeat.transition).toBe("unchanged");
        expect(await db.accountChange.count()).toBe(changesAfterFirst);
    });

    it("enforces the complete effective permission-delegation transition matrix through the real writer", async () => {
        const fixture = await createFixture();
        const manager = await createAccount("grant-manager");
        await db.teamMembership.create({
            data: { teamId: fixture.team.id, accountId: manager.id, role: "member" },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: fixture.session.id,
                createdByAccountId: fixture.owner.id,
                accountId: manager.id,
                accessLevel: "admin",
                canApprovePermissions: false,
            },
        });
        const nextStates = [
            ["view", { accessLevel: "view", canApprovePermissions: false }],
            ["edit", { accessLevel: "edit", canApprovePermissions: false }],
            ["delegated edit", { accessLevel: "edit", canApprovePermissions: true }],
            ["admin", { accessLevel: "admin", canApprovePermissions: false }],
            ["delegated admin", { accessLevel: "admin", canApprovePermissions: true }],
        ] as const;
        const states = [["absent", null], ...nextStates] as const;
        const forbidden = new Set([
            "absent->delegated edit", "absent->delegated admin",
            "view->delegated edit", "view->delegated admin",
            "edit->delegated edit", "edit->delegated admin",
            "delegated edit->delegated admin",
            "admin->delegated edit", "admin->delegated admin",
        ]);
        const subject = { kind: "account" as const, accountId: fixture.collaborator.id };
        const identity = { sessionId: fixture.session.id, accountId: fixture.collaborator.id };

        for (const [previousName, previous] of states) {
            for (const [nextName, next] of nextStates) {
                await db.sessionGrant.deleteMany({ where: { principalKind: 'account', ...identity } });
                if (previous !== null) {
                    await db.sessionGrant.create({ data: { principalKind: 'account',
                        ...identity,
                        createdByAccountId: fixture.owner.id,
                        accessLevel: previous.accessLevel,
                        canApprovePermissions: previous.canApprovePermissions,
                    } });
                }
                const result = await inTx((tx) => putSessionAccessGrantInTx(tx, {
                    actorAccountId: manager.id,
                    sessionId: fixture.session.id,
                    subject,
                    grant: next,
                }));
                const transition = `${previousName}->${nextName}`;
                if (forbidden.has(transition)) {
                    expect(result, transition).toEqual({
                        ok: false,
                        error: "session_access_permission_delegation_forbidden",
                    });
                } else {
                    expect(result, transition).toMatchObject({
                        ok: true,
                        changed: previous === null
                            || previous.accessLevel !== next.accessLevel
                            || previous.canApprovePermissions !== next.canApprovePermissions,
                    });
                }
            }
        }

        await db.sessionGrant.update({
            where: { principalKind: 'account', sessionId_accountId: identity },
            data: { accessLevel: "admin", canApprovePermissions: true },
        });
        const removed = await inTx((tx) => deleteSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject,
        }));
        expect(removed).toMatchObject({ ok: true, changed: true });

        const invalidView = await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject,
            grant: { accessLevel: "view", canApprovePermissions: true },
        }));
        expect(invalidView).toEqual({
            ok: false,
            error: "session_access_permission_delegation_requires_edit",
        });
    });

    it("allows an owner and a delegating admin to perform delegation-bearing gains", async () => {
        const fixture = await createFixture();
        const manager = await createAccount("delegating-grant-manager");
        await db.teamMembership.create({
            data: { teamId: fixture.team.id, accountId: manager.id, role: "member" },
        });
        await db.sessionGrant.createMany({ data: [
            { principalKind: 'account',
                sessionId: fixture.session.id,
                createdByAccountId: fixture.owner.id,
                accountId: manager.id,
                accessLevel: "admin",
                canApprovePermissions: true,
            },
            { principalKind: 'account',
                sessionId: fixture.session.id,
                createdByAccountId: fixture.owner.id,
                accountId: fixture.collaborator.id,
                accessLevel: "edit",
                canApprovePermissions: false,
            },
        ] });
        const input = {
            sessionId: fixture.session.id,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
            grant: { accessLevel: "admin" as const, canApprovePermissions: true },
        };

        await expect(inTx((tx) => putSessionAccessGrantInTx(tx, {
            ...input,
            actorAccountId: manager.id,
        }))).resolves.toMatchObject({ ok: true, changed: true });
        await db.sessionGrant.update({
            where: { principalKind: 'account', sessionId_accountId: {
                sessionId: fixture.session.id,
                accountId: fixture.collaborator.id,
            } },
            data: { accessLevel: "edit", canApprovePermissions: false },
        });
        await expect(inTx((tx) => putSessionAccessGrantInTx(tx, {
            ...input,
            actorAccountId: fixture.owner.id,
        }))).resolves.toMatchObject({ ok: true, changed: true });
    });

    it("invalidates the roster for all current managers outside the changed grant subject", async () => {
        const fixture = await createFixture();
        const otherManager = await createAccount("other-roster-manager");
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: fixture.session.id, createdByAccountId: fixture.owner.id,
            accountId: otherManager.id, accessLevel: "admin", canApprovePermissions: false,
        } });
        const teamManager = await createAccount("team-roster-manager");
        const groupManager = await createAccount("group-roster-manager");
        const reader = await createAccount("roster-reader");
        const otherTeam = await db.team.create({ data: { name: "Roster managers" } });
        await db.teamMembership.create({ data: { teamId: otherTeam.id, accountId: teamManager.id, role: "member" } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: fixture.session.id, teamId: otherTeam.id, accessLevel: "admin", effectiveAt: new Date() } });
        const groupMembership = await db.teamMembership.create({ data: { teamId: fixture.team.id, accountId: groupManager.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: fixture.team.id, name: storedPlainPrivateLabel("Managers") } });
        await db.teamGroupMembership.create({ data: { teamId: fixture.team.id, teamGroupId: group.id, teamMembershipId: groupMembership.id } });
        await db.sessionGrant.create({ data: { principalKind: 'group', sessionId: fixture.session.id, teamGroupId: group.id, accessLevel: "admin", effectiveAt: new Date() } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: fixture.session.id, createdByAccountId: fixture.owner.id, accountId: reader.id, accessLevel: "view" } });
        const input = {
            actorAccountId: fixture.owner.id, sessionId: fixture.session.id,
            subject: { kind: "account" as const, accountId: fixture.collaborator.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        const expectedManagers = [fixture.owner.id, otherManager.id, teamManager.id, groupManager.id].sort();
        for (const mutate of [
            () => inTx((tx) => putSessionAccessGrantInTx(tx, input)),
            () => inTx((tx) => putSessionAccessGrantInTx(tx, { ...input, grant: { accessLevel: "edit", canApprovePermissions: false } })),
            () => inTx((tx) => deleteSessionAccessGrantInTx(tx, input)),
        ]) {
            await db.accountChange.deleteMany();
            const changed = await mutate();
            expect(changed).toMatchObject({ ok: true, changed: true });
            if (!changed.ok) throw new Error("Expected grant mutation to succeed");
            expect([...changed.effects.rosterManagerAccountIds].sort()).toEqual(expectedManagers);
            const rosterChanges = await db.accountChange.findMany({
                where: { kind: "share", entityId: fixture.session.id }, select: { accountId: true },
            });
            expect(rosterChanges.map(row => row.accountId).sort()).toEqual(expectedManagers);
        }
    });

    it("mints a collective grant's effectiveAt once and never rewrites it", async () => {
        const fixture = await createFixture();
        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }));
        const minted = await db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { effectiveAt: true },
        });

        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
            grant: { accessLevel: "admin", canApprovePermissions: false },
        }));

        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { effectiveAt: true, accessLevel: true },
        })).resolves.toEqual({ effectiveAt: minted.effectiveAt, accessLevel: "admin" });
    });

    it("fails closed at the membership horizon and admits a strictly later grant", async () => {
        const fixture = await createFixture();
        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }));
        const grant = await db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { effectiveAt: true },
        });

        // `from_membership` with a cutoff exactly equal to the grant must fail closed.
        await db.teamMembership.updateMany({
            where: { teamId: fixture.team.id, accountId: fixture.collaborator.id },
            data: { sessionAccessStartsAt: grant.effectiveAt },
        });
        expect(await inTx(async (tx) => await resolveCurrentSessionRecipientAccountIdsInTx(tx, {
            sessionId: fixture.session.id,
        }))).toEqual([fixture.owner.id]);

        await db.teamMembership.updateMany({
            where: { teamId: fixture.team.id, accountId: fixture.collaborator.id },
            data: { sessionAccessStartsAt: new Date(grant.effectiveAt.getTime() - 1) },
        });
        expect(await inTx(async (tx) => await resolveCurrentSessionRecipientAccountIdsInTx(tx, {
            sessionId: fixture.session.id,
        }))).toEqual(expect.arrayContaining([fixture.owner.id, fixture.collaborator.id]));
    });

    it("does not reach a restricted guest through a Team principal", async () => {
        const fixture = await createFixture({ collaboratorTeamRole: "guest" });
        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }));

        expect(await inTx(async (tx) => await resolveCurrentSessionRecipientAccountIdsInTx(tx, {
            sessionId: fixture.session.id,
        }))).toEqual([fixture.owner.id]);
    });

    it("is idempotent on removal and authorizes before revealing absence", async () => {
        const fixture = await createFixture();
        await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
            grant: { accessLevel: "edit", canApprovePermissions: false },
        }));

        const first = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
        }));
        const second = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
        }));
        const stranger = await createAccount("grant-stranger");
        const unauthorized = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: stranger.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
        }));

        expect(first.ok && first.changed).toBe(true);
        expect(second.ok && second.changed).toBe(false);
        expect(unauthorized).toEqual({ ok: false, error: "session_access_forbidden" });
    });

    it("rejects a Group removal whose claimed parent Team does not match the stored subject", async () => {
        const fixture = await createFixture();
        const group = await db.teamGroup.create({
            data: {
                teamId: fixture.team.id,
                name: storedPlainPrivateLabel("Grant removal group"),
            },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'group',
                sessionId: fixture.session.id,
                teamGroupId: group.id,
                accessLevel: "view",
                effectiveAt: new Date(),
            },
        });

        const result = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "group", teamId: crypto.randomUUID(), groupId: group.id },
        }));

        expect(result).toEqual({ ok: false, error: "session_access_subject_not_found" });
        expect(await db.sessionGrant.count({
            where: { principalKind: 'group', sessionId: fixture.session.id, teamGroupId: group.id },
        })).toBe(1);
    });

    it("removes an existing Group grant after its subject is no longer discoverable", async () => {
        const fixture = await createFixture();
        const group = await db.teamGroup.create({
            data: {
                teamId: fixture.team.id,
                name: storedPlainPrivateLabel("Archived grant removal group"),
                archivedAt: new Date(),
            },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'group',
                sessionId: fixture.session.id,
                teamGroupId: group.id,
                accessLevel: "view",
                effectiveAt: new Date(),
            },
        });

        const result = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "group", teamId: fixture.team.id, groupId: group.id },
        }));

        expect(result.ok && result.changed).toBe(true);
        expect(await db.sessionGrant.count({
            where: { principalKind: 'group', sessionId: fixture.session.id, teamGroupId: group.id },
        })).toBe(0);
    });

    it("accepts a shared-Team colleague and refuses an unrelated Account", async () => {
        const fixture = await createFixture();
        const stranger = await createAccount("grant-unrelated");

        const colleague = await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.collaborator.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }));
        const unrelated = await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: stranger.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }));

        expect(colleague.ok).toBe(true);
        expect(unrelated).toEqual({ ok: false, error: "session_access_subject_ineligible" });
    });

    it("rejects both the implicit owner and the acting collaborator as direct-grant subjects", async () => {
        const fixture = await createFixture();
        const manager = await createAccount("grant-self-manager");
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: fixture.session.id,
                createdByAccountId: fixture.owner.id,
                accountId: manager.id,
                accessLevel: "admin",
                canApprovePermissions: false,
            },
        });

        expect(await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: fixture.owner.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toEqual({ ok: false, error: "session_access_owner_grant_invalid" });
        expect(await inTx(async (tx) => await putSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: manager.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toEqual({ ok: false, error: "session_access_self_grant_invalid" });
        expect(await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: manager.id },
        }))).toEqual({ ok: false, error: "session_access_self_grant_invalid" });
        expect(await db.sessionGrant.count({
            where: { principalKind: 'account', sessionId: fixture.session.id, accountId: fixture.owner.id },
        })).toBe(0);
        expect(await db.sessionGrant.count({
            where: { principalKind: 'account', sessionId: fixture.session.id, accountId: manager.id },
        })).toBe(1);
    });

    it("refuses to weaken a Team grant while the Team session policy still requires it", async () => {
        const fixture = await createFixture();
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'team',
                sessionId: fixture.session.id,
                teamId: fixture.team.id,
                accessLevel: "edit",
                canApprovePermissions: false,
                requiredByTeamPolicy: true,
                effectiveAt: new Date(),
            },
        });

        const blocked = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
        }));
        expect(blocked).toEqual({ ok: false, error: "session_access_team_policy_required" });

        // Relaxing the policy makes the stale marker clearable by the ordinary
        // authorized mutation, with no bulk rewrite job.
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_default" },
        });
        const allowed = await inTx(async (tx) => await deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
        }));
        expect(allowed.ok && allowed.changed).toBe(true);
    });

    it("enforces the primary Team external-sharing policy only for access increases", async () => {
        const fixture = await createFixture();
        const externalTeam = await db.team.create({ data: { name: `External ${crypto.randomUUID()}` } });
        await db.teamMembership.create({
            data: { teamId: externalTeam.id, accountId: fixture.owner.id, role: "member" },
        });
        await db.session.update({ where: { id: fixture.session.id }, data: { primaryTeamId: fixture.team.id } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { externalSharingPolicy: "disabled" },
        });

        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team" as const, teamId: externalTeam.id },
            grant: { accessLevel: "view" as const, canApprovePermissions: false },
        };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, input))).toEqual({
            ok: false,
            error: "session_access_external_sharing_disabled",
        });

        await db.sessionGrant.create({
            data: { principalKind: 'team',
                sessionId: fixture.session.id,
                teamId: externalTeam.id,
                accessLevel: "edit",
                canApprovePermissions: false,
                effectiveAt: new Date(),
            },
        });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, input))).toMatchObject({ ok: true, changed: true });
        expect(await inTx((tx) => deleteSessionAccessGrantInTx(tx, input))).toMatchObject({ ok: true, changed: true });
    });

    it("treats a retained membership in an archived primary Team as external", async () => {
        const fixture = await createFixture();
        const member = await createAccount("archived-primary-member");
        await db.teamMembership.create({
            data: { teamId: fixture.team.id, accountId: member.id, role: "member" },
        });
        await db.session.update({
            where: { id: fixture.session.id },
            data: { primaryTeamId: fixture.team.id },
        });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { externalSharingPolicy: "disabled" },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: fixture.session.id,
                createdByAccountId: fixture.owner.id,
                accountId: member.id,
                accessLevel: "view",
            },
        });
        const increase = () => inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "account", accountId: member.id },
            grant: { accessLevel: "edit", canApprovePermissions: false },
        }));

        // The same active Team relationship is internal while the Team is live.
        expect(await increase()).toMatchObject({ ok: true, changed: true });
        await db.sessionGrant.update({
            where: { principalKind: 'account', sessionId_accountId: {
                sessionId: fixture.session.id,
                accountId: member.id,
            } },
            data: { accessLevel: "view" },
        });

        // Archive retains the membership row but removes its effective Team
        // relationship, so the same increase is governed as external sharing.
        await db.team.update({
            where: { id: fixture.team.id },
            data: { archivedAt: new Date() },
        });
        expect(await increase()).toEqual({
            ok: false,
            error: "session_access_external_sharing_disabled",
        });
    });

    it("rejects an external initial audience atomically under the primary Team policy", async () => {
        const fixture = await createFixture();
        const externalTeam = await db.team.create({ data: { name: `Initial external ${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: externalTeam.id, accountId: fixture.owner.id, role: "member" } });
        await db.team.update({ where: { id: fixture.team.id }, data: { externalSharingPolicy: "disabled" } });
        const sessionId = crypto.randomUUID();
        const result = await inTx(async (tx) => {
            await tx.session.create({ data: {
                id: sessionId,
                accountId: fixture.owner.id,
                tag: sessionId,
                primaryTeamId: fixture.team.id,
                encryptionMode: "plain",
                metadata: "{}",
                currentStorageState: "hosted",
            } });
            return await applyInitialSessionAccessInTx(tx, {
                creatorAccountId: fixture.owner.id,
                sessionId,
                initialAccess: { grants: [{
                    subject: { kind: "team", teamId: externalTeam.id },
                    accessLevel: "view",
                    canApprovePermissions: false,
                }] },
            });
        });
        expect(result).toEqual({ ok: false, error: "session_access_external_sharing_disabled" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'team', sessionId } })).toBe(0);
    });

    it("requires primary-Team managePolicy and a credential qualified for that Team for an external increase under team_admins_only", async () => {
        const fixture = await createFixture();
        const manager = await createAccount("external-policy-manager", { encryptionMode: "e2ee" });
        const externalTeam = await db.team.create({ data: { name: `External manager ${crypto.randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: fixture.team.id, accountId: manager.id, role: "admin" },
            { teamId: externalTeam.id, accountId: manager.id, role: "member" },
        ] });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: fixture.session.id,
            createdByAccountId: fixture.owner.id,
            accountId: manager.id,
            accessLevel: "admin",
            canApprovePermissions: false,
        } });
        await db.session.update({ where: { id: fixture.session.id }, data: { primaryTeamId: fixture.team.id } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: {
                externalSharingPolicy: "team_admins_only",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: externalTeam.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" },
                authority: "present_user",
                authenticationEvidence: [],
            },
        }))).toEqual({ ok: false, error: "session_access_authentication_unavailable" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'team', sessionId: fixture.session.id } })).toBe(0);

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: externalTeam.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user",
                authenticationEvidence: [],
            },
        }))).toEqual({ ok: false, error: "session_access_authentication_required" });
        expect(await db.sessionGrant.count({ where: { principalKind: 'team', sessionId: fixture.session.id } })).toBe(0);

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: manager.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: externalTeam.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        }))).toMatchObject({ ok: true, changed: true });
    });

    it("requires an active target-Team relationship for a new Team or Group grant", async () => {
        const fixture = await createFixture();
        const unrelatedTeam = await db.team.create({ data: { name: `Unrelated ${crypto.randomUUID()}` } });
        const unrelatedGroup = await db.teamGroup.create({
            data: { teamId: unrelatedTeam.id, name: storedPlainPrivateLabel("Unrelated group") },
        });

        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: unrelatedTeam.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toEqual({ ok: false, error: "session_access_subject_ineligible" });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "group", teamId: unrelatedTeam.id, groupId: unrelatedGroup.id },
            grant: { accessLevel: "view", canApprovePermissions: false },
        }))).toEqual({ ok: false, error: "session_access_subject_ineligible" });
    });

    it("rechecks external audiences when moving a Session into a primary Team", async () => {
        const fixture = await createFixture();
        const externalMember = await createAccount("existing-external-audience");
        const externalTeam = await db.team.create({ data: { name: `Existing audience ${crypto.randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: externalTeam.id, accountId: fixture.owner.id, role: "member" },
            { teamId: externalTeam.id, accountId: externalMember.id, role: "member" },
        ] });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: fixture.session.id,
            teamId: externalTeam.id,
            accessLevel: "view",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { externalSharingPolicy: "disabled" },
        });

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).toEqual({ ok: false, error: "session_access_external_sharing_disabled" });
    });

    it("treats another Team grant as external even when its current members also belong to the proposed primary Team", async () => {
        const fixture = await createFixture();
        const overlappingTeam = await db.team.create({ data: { name: `Overlapping audience ${crypto.randomUUID()}` } });
        await db.teamMembership.create({
            data: { teamId: overlappingTeam.id, accountId: fixture.owner.id, role: "member" },
        });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: fixture.session.id,
            teamId: overlappingTeam.id,
            accessLevel: "view",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { externalSharingPolicy: "disabled" },
        });

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).toEqual({ ok: false, error: "session_access_external_sharing_disabled" });
    });

    it.each(["absent", "view"] as const)("atomically applies the required Team Edit floor during a context move from %s", async existing => {
        const fixture = await createFixture();
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        if (existing === "view") {
            await db.sessionGrant.create({ data: { principalKind: 'team',
                sessionId: fixture.session.id,
                teamId: fixture.team.id,
                accessLevel: "view",
                canApprovePermissions: false,
                effectiveAt: new Date(),
            } });
        }

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).toEqual({ ok: true, changed: true, primaryTeamId: fixture.team.id });
        await expect(db.session.findUniqueOrThrow({
            where: { id: fixture.session.id },
            select: { primaryTeamId: true },
        })).resolves.toEqual({ primaryTeamId: fixture.team.id });
        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        })).resolves.toEqual({ accessLevel: "edit", canApprovePermissions: false, requiredByTeamPolicy: true });

        expect(await db.accountChange.findMany({
            where: { entityId: fixture.session.id },
            select: { accountId: true, kind: true },
            orderBy: [{ accountId: "asc" }, { kind: "asc" }],
        })).toEqual(expect.arrayContaining([
            { accountId: fixture.owner.id, kind: "session" },
            { accountId: fixture.owner.id, kind: "share" },
            { accountId: fixture.collaborator.id, kind: "session" },
        ]));

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).toEqual({ ok: true, changed: false, primaryTeamId: fixture.team.id });

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: null,
        }))).toEqual({ ok: false, error: "session_access_team_policy_required" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: fixture.session.id },
            select: { primaryTeamId: true },
        })).resolves.toEqual({ primaryTeamId: fixture.team.id });
        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        })).resolves.toEqual({ accessLevel: "edit", canApprovePermissions: false, requiredByTeamPolicy: true });
    });

    it("retains the required Team grant but unlocks explicit context clearing after policy relaxation", async () => {
        const fixture = await createFixture();
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).resolves.toMatchObject({ ok: true, changed: true });

        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_default" },
        });
        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: null,
        }))).resolves.toEqual({ ok: true, changed: true, primaryTeamId: null });
        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        })).resolves.toEqual({ accessLevel: "edit", canApprovePermissions: false, requiredByTeamPolicy: false });
    });

    it("blocks replacing a required Team context until the current Team is archived", async () => {
        const fixture = await createFixture();
        const replacement = await db.team.create({
            data: { name: `Replacement context ${crypto.randomUUID()}` },
        });
        await db.teamMembership.create({
            data: { teamId: replacement.id, accountId: fixture.owner.id, role: "member" },
        });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).resolves.toMatchObject({ ok: true, changed: true });

        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: replacement.id,
        }))).resolves.toEqual({ ok: false, error: "session_access_team_policy_required" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: fixture.session.id },
            select: { primaryTeamId: true },
        })).resolves.toEqual({ primaryTeamId: fixture.team.id });

        await db.team.update({ where: { id: fixture.team.id }, data: { archivedAt: new Date() } });
        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: replacement.id,
        }))).resolves.toEqual({ ok: true, changed: true, primaryTeamId: replacement.id });
        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        })).resolves.toEqual({ accessLevel: "edit", canApprovePermissions: false, requiredByTeamPolicy: false });
    });

    it("keeps Home recovery separate from Session access authority", async () => {
        const fixture = await createFixture();
        const homeOwner = await createAccount("home-owner-without-session-access");
        await db.account.update({ where: { id: homeOwner.id }, data: { homeRole: "owner" } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).resolves.toMatchObject({ ok: true, changed: true });

        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: homeOwner.id,
            sessionId: fixture.session.id,
            primaryTeamId: null,
        }))).resolves.toEqual({ ok: false, error: "session_access_forbidden" });

        // The Home/Team governance owner may relax the Team policy, but an
        // Account with Session manageAccess still performs the context edit.
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_default" },
        });
        await expect(inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: null,
        }))).resolves.toEqual({ ok: true, changed: true, primaryTeamId: null });
    });

    it("preserves an explicitly stronger Team grant while marking the required context", async () => {
        const fixture = await createFixture();
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: fixture.session.id,
            teamId: fixture.team.id,
            accessLevel: "admin",
            canApprovePermissions: true,
            effectiveAt: new Date(),
        } });

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).toMatchObject({ ok: true, changed: true });
        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: fixture.session.id, teamId: fixture.team.id } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        })).resolves.toEqual({ accessLevel: "admin", canApprovePermissions: true, requiredByTeamPolicy: true });
    });

    it("ignores expired publications and archived collective grants when checking a new Team context", async () => {
        const fixture = await createFixture();
        const externalTeam = await db.team.create({
            data: { name: `Inactive external ${crypto.randomUUID()}`, archivedAt: new Date() },
        });
        const externalGroup = await db.teamGroup.create({
            data: {
                teamId: externalTeam.id,
                name: storedPlainPrivateLabel("Inactive external group"),
                archivedAt: new Date(),
            },
        });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: fixture.session.id,
            teamId: externalTeam.id,
            accessLevel: "view",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        await db.sessionGrant.create({ data: { principalKind: 'group',
            sessionId: fixture.session.id,
            teamGroupId: externalGroup.id,
            accessLevel: "view",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        await db.publicSessionShare.create({ data: {
            sessionId: fixture.session.id,
            createdByUserId: fixture.owner.id,
            tokenHash: new Uint8Array(32),
            expiresAt: new Date(Date.now() - 60_000),
        } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { externalSharingPolicy: "disabled" },
        });

        expect(await inTx((tx) => setSessionAccessContextInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            primaryTeamId: fixture.team.id,
        }))).toEqual({ ok: true, changed: true, primaryTeamId: fixture.team.id });
    });

    it("admits and lists a grant before the transcript is publishable; disclosure alone gates the recipient", async () => {
        const fixture = await createFixture();
        await db.session.update({ where: { id: fixture.session.id }, data: { currentStorageState: "machine_only" } });
        const input = {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team" as const, teamId: fixture.team.id },
            grant: { accessLevel: "edit" as const, canApprovePermissions: false },
        };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, input))).toMatchObject({ ok: true, changed: true });

        const inspection = await inspectSessionAccessGrants({
            actorAccountId: fixture.owner.id, sessionId: fixture.session.id, authentication: TEST_AUTHENTICATION,
        });
        expect(inspection).toMatchObject({ ok: true, value: { visibility: "complete", grants: [
            expect.objectContaining({ allowedTransitions: {
                accessLevels: ["view", "edit", "admin"], canChangePermissionDelegation: true, canRemove: true,
            } }),
        ] } });
        // The pre-authorized collaborator holds the grant but no disclosure until publication.
        expect(await inTx((tx) => resolveSessionAccessForOperation(tx, {
            accountId: fixture.collaborator.id, sessionId: fixture.session.id, authentication: TEST_AUTHENTICATION,
        }))).toEqual({ status: "unavailable" });
    });

    it("closes only external increases in the inspected transitions under the primary-Team policy", async () => {
        const fixture = await createFixture();
        const externalTeam = await db.team.create({ data: { name: `External ${crypto.randomUUID()}` } });
        await db.teamMembership.create({
            data: { teamId: externalTeam.id, accountId: fixture.owner.id, role: "member" },
        });
        await db.session.update({ where: { id: fixture.session.id }, data: { primaryTeamId: fixture.team.id } });
        await db.sessionGrant.createMany({ data: [
            { principalKind: 'team', sessionId: fixture.session.id, teamId: externalTeam.id, accessLevel: "edit", canApprovePermissions: false, effectiveAt: new Date() },
            { principalKind: 'team', sessionId: fixture.session.id, teamId: fixture.team.id, accessLevel: "edit", canApprovePermissions: false, effectiveAt: new Date() },
        ] });
        await db.team.update({ where: { id: fixture.team.id }, data: { externalSharingPolicy: "disabled" } });

        const inspection = await inspectSessionAccessGrants({
            actorAccountId: fixture.owner.id, sessionId: fixture.session.id, authentication: TEST_AUTHENTICATION,
        });
        if (!inspection.ok || inspection.value.visibility !== "complete") throw new Error("Expected the complete roster");
        const transitionsByTeam = new Map(inspection.value.grants.map((row) => [
            row.grant.subject.kind === "team" ? row.grant.subject.teamId : "", row.allowedTransitions,
        ]));
        expect(transitionsByTeam.get(externalTeam.id)).toEqual({
            accessLevels: ["view", "edit"], canChangePermissionDelegation: false, canRemove: true,
            reason: "session_access_external_sharing_disabled",
        });
        expect(transitionsByTeam.get(fixture.team.id)).toEqual({
            accessLevels: ["view", "edit", "admin"], canChangePermissionDelegation: true, canRemove: true,
        });
        // The affordance matches the writer: the closed transition is refused, the open one admitted.
        const external = { actorAccountId: fixture.owner.id, sessionId: fixture.session.id, subject: { kind: "team" as const, teamId: externalTeam.id } };
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, { ...external, grant: { accessLevel: "admin", canApprovePermissions: false } })))
            .toEqual({ ok: false, error: "session_access_external_sharing_disabled" });
        expect(await inTx((tx) => putSessionAccessGrantInTx(tx, { ...external, grant: { accessLevel: "view", canApprovePermissions: false } })))
            .toMatchObject({ ok: true, changed: true });
    });

    it("offers removal of a retained grant whose subject is archived, and keeps the required-Team floor", async () => {
        const fixture = await createFixture();
        const archivedGroup = await db.teamGroup.create({
            data: {
                teamId: fixture.team.id,
                name: storedPlainPrivateLabel("Retired group"),
                archivedAt: new Date(),
            },
        });
        await db.sessionGrant.create({ data: { principalKind: 'group',
            sessionId: fixture.session.id,
            teamGroupId: archivedGroup.id,
            accessLevel: "edit",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: fixture.session.id,
            teamId: fixture.team.id,
            accessLevel: "edit",
            canApprovePermissions: false,
            requiredByTeamPolicy: true,
            effectiveAt: new Date(),
        } });
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: "team_required" },
        });

        const inspection = await inspectSessionAccessGrants({
            actorAccountId: fixture.owner.id, sessionId: fixture.session.id, authentication: TEST_AUTHENTICATION,
        });
        if (!inspection.ok || inspection.value.visibility !== "complete") throw new Error("Expected the complete roster");
        const groupRow = inspection.value.grants.find((row) => row.grant.subject.kind === "group");
        const teamRow = inspection.value.grants.find((row) => row.grant.subject.kind === "team");
        // The writer admits this removal, so the affordance must offer it while
        // still reporting why no other transition is available.
        expect(groupRow?.allowedTransitions).toEqual({
            accessLevels: [], canChangePermissionDelegation: false, canRemove: true,
            reason: "session_access_subject_ineligible",
        });
        expect(teamRow?.allowedTransitions).toMatchObject({
            canRemove: false, reason: "session_access_team_policy_required",
        });

        expect(await inTx((tx) => deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "group", teamId: fixture.team.id, groupId: archivedGroup.id },
        }))).toMatchObject({ ok: true, changed: true });
        expect(await db.sessionGrant.count({
            where: { principalKind: 'group', sessionId: fixture.session.id, teamGroupId: archivedGroup.id },
        })).toBe(0);
        expect(await inTx((tx) => deleteSessionAccessGrantInTx(tx, {
            actorAccountId: fixture.owner.id,
            sessionId: fixture.session.id,
            subject: { kind: "team", teamId: fixture.team.id },
        }))).toEqual({ ok: false, error: "session_access_team_policy_required" });
    });
});
