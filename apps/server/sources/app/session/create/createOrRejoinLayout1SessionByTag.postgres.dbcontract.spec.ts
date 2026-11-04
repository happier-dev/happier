import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from "@/app/changes/markAccountChanged";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createOrRejoinLayout1SessionByTag } from "./createOrRejoinLayout1SessionByTag";
import { createFreshBoundLayout1SessionInTx } from "./createFreshBoundLayout1Session";
import { prepareLayout1SessionCreate } from "./prepareLayout1SessionCreate";
import { deleteSessionOrganizationFolder, deleteSessionOrganizationTag } from "@/app/session/organization/organizationMutations";
import { setTeamMembershipStatusInTx } from "@/app/teams/memberships/membershipService";
import { publishTeamChangedInTx } from "@/app/teams/teamChanges";
import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { updateTeamCredentialResourceInTx } from "@/app/teams/credentials/resourceUpdate";
import { revokeMachineInTx } from "@/app/machines/machineMutations";
import { applyMachineReplacement } from "@/app/machines/applyMachineReplacement";
import { AutomationTriggerIdSchema, type SessionInitialTriggerAdmissionV1 } from "@happier-dev/protocol";
import { replaceAutomationAssignmentsTx } from "@/app/automations/automationAssignmentService";

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });

function initialTrigger(machineId: string): SessionInitialTriggerAdmissionV1 {
    const automationId = randomUUID();
    return { automationId, name: "Session birth preparation", enabled: true,
        assignments: [{ machineId, enabled: true, priority: 0 }],
        executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" },
                inlineDefinition: { version: 1, inputs: [], defaults: { agentTarget: {
                    kind: "agent", identity: { pluginId: "happier.agent.test", localId: "test" } } },
                    blocks: [{ kind: "step", id: "prepare", document: { text: "Prepare", references: [], attachments: [] },
                        input: [], result: { kind: "text" } }] } } } },
        triggers: [{ triggerId: AutomationTriggerIdSchema.parse(`${automationId}-start`),
            trigger: { kind: "sessionLifecycle", enabled: true, events: ["sessionStarted"], policy: { kind: "everyMatch" } } }],
    };
}

async function credentialFixture(accountId: string, teamId: string) {
    const service = { pluginId: "example.session-binding", localId: "source" };
    const groupId = randomUUID();
    const pool = await db.connectedServiceAuthGroup.create({ data: {
        accountId, groupId, servicePluginId: service.pluginId, serviceLocalId: service.localId,
        qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
        qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }), policyJson: "{}",
    } });
    const resource = await db.teamCredentialResource.create({ data: {
        teamId, custodianAccountId: accountId, displayName: "Session birth credential",
        disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed", allMembersDeliveryMode: "direct",
        sourceBindingJson: JSON.stringify({ v: 1, kind: "connected_pool", target: { kind: "group", service, groupId }, poolIncarnation: pool.id }),
    } });
    return { resource, binding: { v: 1 as const, slot: { kind: "provider_model" as const }, resourceId: resource.id,
        expectedResourceRevision: resource.revision, deliveryMode: "direct" as const, teamId } };
}

function prepared(accountId: string, managerSessionId: string, tag = randomUUID()) {
    const result = prepareLayout1SessionCreate({
        accountId, tag, metadata: JSON.stringify({ v: 1 }), ownerMetadata: { t: "plain", v: { v: 1 } },
        agentState: null, dataEncryptionKey: null, requestedEncryptionMode: "plain", requestedStorageState: undefined,
        organizationPlacement: undefined, accountEncryptionMode: "plain", storagePolicy: "optional", defaultAccountMode: "plain",
        originKind: "session", originSessionId: managerSessionId, manager: { sessionId: managerSessionId },
    });
    if (!result.ok) throw new Error("Invalid Session creation fixture");
    return result.prepared;
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("tag Session creation under PostgreSQL Account publication", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["grant", "primary-team", "credential-binding", "initial-trigger"] as const)("creates with %s admission while an independent publisher advances the Account cursor on every attempt", async admission => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Session birth cursor contention" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: account.id, role: "owner" },
            { teamId: team.id, accountId: recipient.id, role: "member" },
        ] });
        const credential = admission === "credential-binding" ? await credentialFixture(account.id, team.id) : undefined;
        const machine = admission === "initial-trigger" ? await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: "{}",
        } }) : undefined;
        if (credential) vi.stubEnv("HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED", "1");
        const input = {
            ...prepared(account.id, "unused"), originKind: "none" as const, originSessionId: undefined, manager: undefined,
            ...(admission === "grant" ? { initialAccess: { grants: [{ subject: { kind: "account" as const, accountId: recipient.id },
                accessLevel: "view" as const, canApprovePermissions: false }] } }
                : credential ? { teamCredentialBindings: [credential.binding] }
                    : machine ? { initialTriggers: [initialTrigger(machine.id)] } : { primaryTeamId: team.id }),
        };
        const transaction = db.$transaction;
        let peer = false;
        let publications = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (peer || typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let interleaved = false;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (!interleaved && query.includes('FROM "Account"') && query.includes("FOR ")) {
                            interleaved = true;
                            await inner.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                            peer = true;
                            try {
                                await inTx(peerTx => markAccountChanged(peerTx, { accountId: account.id, kind: "account", entityId: "peer" }));
                                publications++;
                            } finally { peer = false; }
                        }
                        return inner.$queryRawUnsafe(query, ...values);
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const result = await createOrRejoinLayout1SessionByTag(input, authentication);
            expect(publications).toBeGreaterThan(0);
            expect(result.kind).toBe("created");
            if (result.kind !== "created") throw new Error("Expected Session birth");
            expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
            if (admission === "grant") expect(await db.sessionShare.findUnique({ where: {
                sessionId_sharedWithUserId: { sessionId: result.session.id, sharedWithUserId: recipient.id },
            } })).toMatchObject({ accessLevel: "view" });
            else if (credential) expect(await db.sessionTeamCredentialBinding.findFirst({ where: { sessionId: result.session.id } }))
                .toMatchObject({ resourceId: credential.resource.id, resourceRevision: credential.resource.revision });
            else if (machine) {
                expect(await db.automation.count({ where: { accountId: account.id, scopeSessionId: result.session.id } })).toBe(1);
                expect(await db.automationRun.count({ where: { accountId: account.id, causeSourceSessionId: result.session.id } })).toBe(1);
            }
            else expect(result.session.primaryTeamId).toBe(team.id);
        } finally {
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            if (machine) {
                await db.automationRun.deleteMany({ where: { accountId: account.id } });
                await db.automation.deleteMany({ where: { accountId: account.id } });
                await db.machine.delete({ where: { id: machine.id } });
            }
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [account.id, recipient.id] } } });
        }
    });

    it("rejects initial trigger assignments when Machine revocation commits after assignment admission", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const trigger = { ...initialTrigger(machine.id), enabled: false };
        const input = { ...prepared(account.id, "unused"), originKind: "none" as const, originSessionId: undefined,
            manager: undefined, initialTriggers: [trigger] };
        const transaction = db.$transaction;
        let withdrawal: Promise<unknown> | undefined;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                const delegate = Reflect.get(client, property, clientReceiver);
                if (property !== "automationAssignment") return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== "deleteMany") return operation;
                    return async (...values: unknown[]) => {
                        if (!withdrawal) {
                            withdrawal = inTx(peer => revokeMachineInTx(peer, { accountId: account.id, machineId: machine.id }));
                            await expect(withdrawal).resolves.toMatchObject({ ok: true });
                        }
                        return Reflect.apply(operation, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await createOrRejoinLayout1SessionByTag(input, authentication)).toMatchObject({ kind: "rejected",
                rejection: { reason: "session-initial-trigger-invalid", code: "invalid_input" } });
            expect(withdrawal).toBeDefined();
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.automation.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.automationRun.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session" } })).toBe(0);
        } finally {
            db.$transaction = transaction;
            await withdrawal;
            await db.automationRun.deleteMany({ where: { accountId: account.id } });
            await db.automation.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["revocation", "replacement-new", "replacement-incumbent"] as const)("rechecks the canonical assignment owner against Machine %s before publication", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const automation = await db.automation.create({ data: { accountId: account.id, name: "Assignment admission",
            enabled: false, templateCiphertext: "{}" } });
        const replacement = operation.startsWith("replacement") ? await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, metadata: "{}",
        } }) : undefined;
        const incumbent = operation === "replacement-incumbent";
        if (incumbent) await db.automationAssignment.create({ data: { automationId: automation.id, machineId: machine.id, enabled: true, priority: 0 } });
        const transaction = db.$transaction;
        let withdrawal: Promise<unknown> | undefined;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                const delegate = Reflect.get(client, property, clientReceiver);
                if (property !== "automationAssignment") return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== "deleteMany") return operation;
                    return async (...values: unknown[]) => {
                        if (!withdrawal) {
                            withdrawal = inTx(async peer => {
                                if (replacement) {
                                    await applyMachineReplacement({ tx: peer, accountId: account.id, oldMachineId: machine.id,
                                        replacementMachineId: replacement.id, reason: "assignment admission", source: "manual", actorUserId: account.id,
                                        confirmActiveOldMachine: true });
                                    return { ok: true };
                                }
                                return revokeMachineInTx(peer, { accountId: account.id, machineId: machine.id });
                            });
                            await expect(withdrawal).resolves.toMatchObject({ ok: true });
                        }
                        return Reflect.apply(operation, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const write = inTx(async tx => {
                await acquireAccountChangePublicationLocksInTx(tx, [account.id], { includeSingleAccount: true });
                await replaceAutomationAssignmentsTx({ tx, accountId: account.id, automationId: automation.id, templateCiphertext: automation.templateCiphertext,
                    assignments: [{ machineId: machine.id, enabled: true, priority: 0 }] });
                await markAccountChanged(tx, { accountId: account.id, kind: "automation", entityId: automation.id });
            }, { isolationLevel: "ReadCommitted" });
            if (incumbent) await expect(write).resolves.toBeUndefined();
            else await expect(write).rejects.toMatchObject({ name: "AutomationValidationError" });
            expect(withdrawal).toBeDefined();
            expect(await db.automationAssignment.count({ where: { automationId: automation.id } })).toBe(incumbent ? 1 : 0);
            expect(await db.accountChange.count({ where: { accountId: account.id, kind: "automation", entityId: automation.id } })).toBe(incumbent ? 1 : 0);
        } finally {
            db.$transaction = transaction;
            await withdrawal;
            await db.automation.delete({ where: { id: automation.id } });
            await db.machine.delete({ where: { id: machine.id } });
            if (replacement) await db.machine.delete({ where: { id: replacement.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("replays Machine withdrawal when a new assignment commits before withdrawal publication", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const automation = await db.automation.create({ data: { accountId: account.id, name: "Assignment withdrawal order",
            enabled: false, templateCiphertext: "{}" } });
        const transaction = db.$transaction;
        let withdrawal: Promise<unknown> | undefined;
        let launchingWithdrawal = false;
        let paused = false;
        let signalReady!: () => void;
        const ready = new Promise<void>(resolve => { signalReady = resolve; });
        let releasePeer!: () => void;
        const release = new Promise<void>(resolve => { releasePeer = resolve; });
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            const peer = launchingWithdrawal;
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                const delegate = Reflect.get(client, property, clientReceiver);
                if (peer && property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                    if (!paused && query.includes('FROM "Account"') && query.includes("FOR NO KEY UPDATE")) {
                        paused = true;
                        signalReady();
                        await release;
                    }
                    return client.$queryRawUnsafe(query, ...values);
                };
                if (peer || property !== "automationAssignment") return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== "deleteMany") return operation;
                    return async (...values: unknown[]) => {
                        if (!withdrawal) {
                            launchingWithdrawal = true;
                            withdrawal = inTx(peerTx => revokeMachineInTx(peerTx, { accountId: account.id, machineId: machine.id }))
                                .finally(() => { launchingWithdrawal = false; signalReady(); });
                            await ready;
                        }
                        return Reflect.apply(operation, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            await inTx(async tx => {
                await acquireAccountChangePublicationLocksInTx(tx, [account.id], { includeSingleAccount: true });
                await replaceAutomationAssignmentsTx({ tx, accountId: account.id, automationId: automation.id, templateCiphertext: automation.templateCiphertext,
                    assignments: [{ machineId: machine.id, enabled: true, priority: 0 }] });
                await markAccountChanged(tx, { accountId: account.id, kind: "automation", entityId: automation.id });
            }, { isolationLevel: "ReadCommitted" });
            expect(paused).toBe(true);
            releasePeer();
            await expect(withdrawal).resolves.toMatchObject({ ok: true });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({ revokedAt: expect.any(Date) });
            expect(await db.automationAssignment.count({ where: { automationId: automation.id, machineId: machine.id } })).toBe(0);
        } finally {
            releasePeer();
            await withdrawal;
            db.$transaction = transaction;
            await db.automation.delete({ where: { id: automation.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("rejects a credential binding if its source authority changes after admission", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Session birth credential currentness" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: "owner" } });
        const credential = await credentialFixture(account.id, team.id);
        const input = { ...prepared(account.id, "unused"), originKind: "none" as const, originSessionId: undefined,
            manager: undefined, teamCredentialBindings: [credential.binding] };
        const transaction = db.$transaction;
        let withdrawal: Promise<unknown> | undefined;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                const delegate = Reflect.get(client, property, clientReceiver);
                if (property !== "sessionTeamCredentialBinding") return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== "upsert") return operation;
                    return async (...values: unknown[]) => {
                        if (!withdrawal) {
                            withdrawal = inTx(peer => updateTeamCredentialResourceInTx(peer, { actorAccountId: account.id,
                                authentication: { authenticationAuthority: "present_user", env: {} },
                                patch: { resourceId: credential.resource.id, expectedRevision: credential.resource.revision, enabled: false } }));
                            await expect(withdrawal).resolves.toMatchObject({ ok: true });
                        }
                        return Reflect.apply(operation, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        vi.stubEnv("HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED", "1");
        try {
            expect(await createOrRejoinLayout1SessionByTag(input, authentication)).toMatchObject({ kind: "rejected",
                rejection: { reason: "team-credential-binding-invalid", code: "resource_changed" } });
            expect(withdrawal).toBeDefined();
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.sessionTeamCredentialBinding.count({ where: { resourceId: credential.resource.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session" } })).toBe(0);
        } finally {
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await withdrawal;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["grant", "primary-team"] as const)("rejects %s birth atomically when its admitted membership is withdrawn before publication", async admission => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Session birth membership currentness",
            ...(admission === "primary-team" ? { sessionCreationPolicy: "team_required" as const } : {}) } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: recipient.id, role: "member" },
        ] });
        const withdrawnAccountId = admission === "grant" ? recipient.id : owner.id;
        const membership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: withdrawnAccountId } } });
        const input = {
            ...prepared(owner.id, "unused"), originKind: "none" as const, originSessionId: undefined, manager: undefined,
            ...(admission === "grant" ? { initialAccess: { grants: [{ subject: { kind: "account" as const, accountId: recipient.id },
                accessLevel: "view" as const, canApprovePermissions: false }] } } : { primaryTeamId: team.id }),
        };
        const transaction = db.$transaction;
        let withdrawal: Promise<void> | undefined;
        let peer = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (peer || typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                const delegate = Reflect.get(inner, property, innerReceiver);
                // The Session row exists, and grant admission has finished. Pause
                // at the native persistence boundary before a grant is visible.
                const boundary = admission === "grant" ? "sessionShare" : "sessionTeamGrant";
                if (property !== boundary) return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== "create") return operation;
                    return async (...values: unknown[]) => {
                        if (!withdrawal) {
                            peer = true;
                            withdrawal = inTx(async peerTx => {
                                await setTeamMembershipStatusInTx(peerTx, { teamId: team.id, membershipId: membership.id,
                                    accountId: withdrawnAccountId, status: "suspended" });
                                await publishTeamChangedInTx(peerTx, { teamId: team.id });
                            }).finally(() => { peer = false; });
                            await withdrawal;
                        }
                        return Reflect.apply(operation, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await createOrRejoinLayout1SessionByTag(input, authentication);
            expect(withdrawal).toBeDefined();
            expect(result).toMatchObject({ kind: "rejected", rejection: { reason: "session-initial-access-invalid", code: "session_access_subject_ineligible" } });
            expect(await db.session.count({ where: { accountId: owner.id, tag: input.tag } })).toBe(0);
            expect(await db.sessionShare.count({ where: { sharedByUserId: owner.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: owner.id, kind: "session" } })).toBe(0);
        } finally {
            db.$transaction = transaction;
            await withdrawal;
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it.each(["tag", "reserved"] as const)("creates a grandchild beside an existing sibling through %s admission", async entry => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        try {
            const lead = await db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: true,
            } });
            const manager = await createOrRejoinLayout1SessionByTag(prepared(account.id, lead.id), authentication);
            const sibling = await createOrRejoinLayout1SessionByTag(prepared(account.id, lead.id), authentication);
            if (manager.kind !== "created" || sibling.kind !== "created") throw new Error("Expected reporting Session fixtures");
            const input = prepared(account.id, manager.session.id);
            const reservedSessionId = randomUUID();
            const created = entry === "tag"
                ? await createOrRejoinLayout1SessionByTag(input, authentication)
                : await inTx(tx => createFreshBoundLayout1SessionInTx(tx, { prepared: input, sessionId: reservedSessionId, authentication }));
            expect(created.kind).toBe("created");
            if (created.kind !== "created") throw new Error("Expected grandchild birth");
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: created.session.id } }))
                .toMatchObject({ sourceSessionId: created.session.id, destinationSessionId: manager.session.id, relation: "manager" });
            await expect(createOrRejoinLayout1SessionByTag(input, authentication))
                .resolves.toMatchObject({ kind: "rejoined", session: { id: created.session.id } });
            expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["create", "create-placement", "create-placement-private", "rejoin", "rejoin-global", "rejoin-empty-access", "rejoin-empty-triggers", "rejoin-empty-team-bindings", "disabled", "mode-change"] as const)("settles %s after a concurrent Account publisher commits", async operation => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: true,
        } });
        const input = {
            ...prepared(account.id, manager.id),
            ...(operation === "rejoin-global" || operation === "create-placement-private"
                ? { originKind: "none" as const, originSessionId: undefined, manager: undefined }
                : {}),
        };
        const folder = operation.startsWith("create-placement") ? await db.sessionOrganizationFolder.create({ data: {
            accountId: account.id, folderKey: "intake", folderHash: "intake",
        } }) : undefined;
        const tag = operation.startsWith("create-placement") ? await db.sessionOrganizationTag.create({ data: {
            accountId: account.id, tagKey: "incoming", tagHash: "incoming",
        } }) : undefined;
        let existingId: string | undefined;
        if (operation.startsWith("rejoin")) {
            const existing = await createOrRejoinLayout1SessionByTag(input, authentication);
            if (existing.kind !== "created") throw new Error("Expected fresh Session fixture");
            existingId = existing.session.id;
            await db.session.update({ where: { id: existingId }, data: { active: false, archivedAt: new Date(123) } });
        }
        // Empty authoring fields introduce no cross-Account admission. Exercise
        // the real archived tag-rejoin lifecycle rather than an isolation stub.
        const request = {
            ...input,
            ...(folder && tag ? { organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } } : {}),
            ...(operation === "rejoin-empty-access" ? { initialAccess: { grants: [] } } : {}),
            ...(operation === "rejoin-empty-triggers" ? { initialTriggers: [] } : {}),
            ...(operation === "rejoin-empty-team-bindings" ? { teamCredentialBindings: [] } : {}),
        };
        await db.accountChange.deleteMany({ where: { accountId: account.id } });
        const transaction = db.$transaction;
        let publications = 0;
        const failures: unknown[] = [];
        // Schedule only the real Prisma transport. Each attempt establishes its
        // Account read before a real managed publication commits. KEY SHARE is
        // compatible with the publisher's NO KEY UPDATE; SSI must not certify
        // this unrelated cursor write as part of placement admission.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let interleaved = false;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                    return (query: string, ...values: unknown[]) => {
                        const native = inner.$queryRawUnsafe(query, ...values);
                        const admission = !interleaved && query.includes('FROM "Account"') && query.includes("FOR KEY SHARE");
                        if (!admission) return native;
                        interleaved = true;
                        let scheduled: Promise<unknown> | undefined;
                        // Preserve Prisma's lazy boundary: inTx must apply its
                        // statement budget before the native query starts.
                        const run = () => scheduled ??= (async () => {
                            try {
                                // Content-key replacement must win before our
                                // incompatible Account content admission.
                                const admitted = operation === "mode-change" ? undefined : await native;
                                await inTx(async peerTx => {
                                    await markAccountChanged(peerTx, { accountId: account.id, kind: "account", entityId: "publication-peer" });
                                    if (operation === "disabled") await peerTx.account.update({ where: { id: account.id }, data: { status: "disabled" } });
                                    if (operation === "mode-change") await peerTx.account.update({ where: { id: account.id },
                                        data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
                                });
                                publications++;
                                return operation === "mode-change" ? await native : admitted;
                            } catch (error) { failures.push(error); throw error; }
                        })();
                        return new Proxy(native, { get(target, method, queryReceiver) {
                            if (method !== "then" && method !== "catch" && method !== "finally") {
                                return Reflect.get(target, method, queryReceiver);
                            }
                            return (...args: unknown[]) => {
                                const promise = run();
                                return Reflect.apply(Reflect.get(promise, method, promise), promise, args);
                            };
                        } });
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const result = await createOrRejoinLayout1SessionByTag(request, authentication);
            console.info("DF124_PUBLICATION", { operation, publications, failedStatements: failures.length, outcome: result.kind });
            expect(publications).toBeGreaterThan(0);
            if (operation === "disabled" || operation === "mode-change") {
                expect(result).toEqual({ kind: "rejected", rejection: { reason: operation === "disabled" ? "account-disabled" : "invalid-params" } });
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(0);
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session" } })).toBe(0);
            } else {
                expect(result.kind).toBe(operation.startsWith("create") ? "created" : "rejoined");
                if (result.kind === "rejected") throw new Error("Unexpected Session refusal");
                if (existingId) expect(result.session.id).toBe(existingId);
                expect(result.session).toMatchObject({ accountId: account.id, archivedAt: null, originSessionId: input.originSessionId ?? null });
                const relation = await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: result.session.id } });
                if (input.manager) {
                    expect(relation).toMatchObject({ sourceSessionId: result.session.id, destinationSessionId: manager.id, relation: "manager" });
                } else {
                    expect(relation).toBeNull();
                }
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
                if (folder && tag) {
                    expect(result.organizationPlacement).toEqual({ folderId: folder.id, tagIds: [tag.id] });
                    const rejoined = await createOrRejoinLayout1SessionByTag(request, authentication);
                    expect(rejoined).toMatchObject({ kind: "rejoined", session: { id: result.session.id } });
                    expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
                }
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session", entityId: result.session.id } })).toBeGreaterThan(0);
            }
            expect(failures).toEqual([]);
        } finally {
            db.$transaction = transaction;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(["folder", "tag"] as const)("does not leave a birth assignment behind a concurrent %s deletion", async resource => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const folder = await db.sessionOrganizationFolder.create({ data: { accountId: account.id, folderKey: "intake", folderHash: "intake" } });
        const tag = await db.sessionOrganizationTag.create({ data: { accountId: account.id, tagKey: "incoming", tagHash: "incoming" } });
        const input = { ...prepared(account.id, manager.id), organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } };
        const transaction = db.$transaction;
        let deletion: Promise<unknown> | undefined;
        let deletionSettled = false;
        // Hold the real insertion open while the real organization owner starts
        // deleting its resource. No domain result or SQL failure is injected.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                const delegate = Reflect.get(inner, property, innerReceiver);
                if (property !== (resource === "folder" ? "sessionFolderAssignment" : "sessionTagAssignment")) return delegate;
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== (resource === "folder" ? "create" : "createMany")) return operation;
                    return async (...values: unknown[]) => {
                        const result = await Reflect.apply(operation, model, values);
                        if (!deletion) {
                            deletion = resource === "folder"
                                ? deleteSessionOrganizationFolder({ accountId: account.id, request: { folderId: folder.id, assignmentBehavior: "moveAssignmentsToParent" } })
                                : deleteSessionOrganizationTag({ accountId: account.id, request: { tagId: tag.id, assignmentBehavior: "removeAssignments" } });
                            void deletion.then(() => { deletionSettled = true; }, () => { deletionSettled = true; });
                            while (!deletionSettled) {
                                const [{ blocked }] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
                                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                        AND wait_event_type = 'Lock'
                                        AND (query LIKE '%SessionOrganization%' OR query LIKE '%"Account"%')) AS blocked`);
                                if (blocked) break;
                            }
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const created = await createOrRejoinLayout1SessionByTag(input, authentication);
            expect(deletion).toBeDefined();
            await deletion;
            const count = resource === "folder"
                ? await db.sessionFolderAssignment.count({ where: { accountId: account.id, folderId: folder.id } })
                : await db.sessionTagAssignment.count({ where: { accountId: account.id, tagId: tag.id } });
            expect(count).toBe(0);
            if (created.kind === "rejected") {
                expect(created.rejection.reason).toBe("invalid-organization-placement");
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(0);
            } else {
                expect(await createOrRejoinLayout1SessionByTag(input, authentication))
                    .toMatchObject({ kind: "rejoined", session: { id: created.session.id } });
                expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
            }
        } finally {
            db.$transaction = transaction;
            await deletion;
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each([false, true])("concurrent identical tags create one child and rejoin the winner without rewriting metadata (placement=%s)", async placement => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const folder = placement ? await db.sessionOrganizationFolder.create({ data: {
            accountId: account.id, folderKey: "intake", folderHash: "intake",
        } }) : undefined;
        const tag = placement ? await db.sessionOrganizationTag.create({ data: {
            accountId: account.id, tagKey: "incoming", tagHash: "incoming",
        } }) : undefined;
        const input = { ...prepared(account.id, manager.id),
            ...(folder && tag ? { organizationPlacement: { folderId: folder.id, tagIds: [tag.id] } } : {}) };
        try {
            const results = await Promise.all([1, 2].map(() => createOrRejoinLayout1SessionByTag(input, authentication)));
            expect(results.map(result => result.kind).sort()).toEqual(["created", "rejoined"]);
            const child = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: account.id, tag: input.tag } } });
            expect(results.every(result => result.kind !== "rejected" && result.session.id === child.id)).toBe(true);
            expect(await db.session.count({ where: { accountId: account.id, tag: input.tag } })).toBe(1);
            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: child.id } })).toBe(1);
            if (folder && tag) {
                expect(await db.sessionFolderAssignment.findUnique({ where: {
                    accountId_sessionId: { accountId: account.id, sessionId: child.id },
                } })).toMatchObject({ folderId: folder.id });
                expect(await db.sessionTagAssignment.findMany({ where: { accountId: account.id, sessionId: child.id },
                    select: { tagId: true } })).toEqual([{ tagId: tag.id }]);
            }
            const rejoined = await createOrRejoinLayout1SessionByTag({ ...input, metadata: "{\"v\": 1}" }, authentication);
            expect(rejoined.kind).toBe("rejoined");
            expect((await db.session.findUniqueOrThrow({ where: { id: child.id } })).metadata).toBe(input.metadata);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("rolls back child and publication when the requested manager belongs to an inaccessible Account", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const stranger = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const manager = await db.session.create({ data: { accountId: stranger.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const input = { ...prepared(owner.id, manager.id), originSessionId: undefined };
        try {
            expect(await createOrRejoinLayout1SessionByTag(input, authentication))
                .toMatchObject({ kind: "rejected", rejection: { reason: "session-manager-invalid" } });
            expect(await db.session.count({ where: { accountId: owner.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: { in: [owner.id, stranger.id] } } })).toBe(0);
        } finally {
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, stranger.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
        }
    });
});
