import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1 } from "@happier-dev/protocol/teams";
import type { ProviderConnectionId } from "@happier-dev/protocol/providers/ids";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { initEncrypt } from "@/modules/encrypt";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { registerTeamMemberRoutes } from "../memberships/registerTeamMemberRoutes";
import { registerTeamCredentialResourceRoutes } from "./registerTeamCredentialResourceRoutes";
import { removeTeamMemberForActorInTx, setTeamMemberManagementForActorInTx, suspendTeamMemberForActorInTx } from "../memberships/memberAdministration";
import { upsertTeamCredentialRecipientMaterialInTx } from "./recipientMaterial";
import { setTeamCredentialAudienceInTx } from "./resourceAudience";
import { updateTeamCredentialResourceInTx } from "./resourceUpdate";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Team credential lifetime contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    const previousEnv = new Map<string, string | undefined>();
    let connected = false;
    let app: ReturnType<typeof createAuthenticatedTestApp>;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        for (const [key, value] of Object.entries({
            HANDY_MASTER_SECRET: "serialaudit-c5-disposable",
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            HAPPIER_DB_CONNECTION_LIMIT: "10",
        })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        connected = true;
        app = createAuthenticatedTestApp();
        registerTeamMemberRoutes(app);
        registerTeamCredentialResourceRoutes(app);
        await app.ready();
    });

    afterAll(async () => {
        if (app) await app.close();
        if (connected) {
            await db.teamProvisionedIdentity.deleteMany({ where: { teamId: { in: teamIds } } });
            await db.teamDirectorySource.deleteMany({ where: { teamId: { in: teamIds } } });
            await db.teamIdentityConnection.deleteMany({ where: { teamId: { in: teamIds } } });
            await db.identityProviderInstance.deleteMany({ where: { ownerTeamId: { in: teamIds } } });
            await db.teamCredentialResource.deleteMany({ where: { teamId: { in: teamIds } } });
            await db.team.deleteMany({ where: { id: { in: teamIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    async function account() {
        const row = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        accountIds.push(row.id);
        return row;
    }

    async function fixture() {
        const owner = await account();
        const recipient = await account();
        const team = await db.team.create({ data: { name: "Guarded credential lifetime" } });
        teamIds.push(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "admin" } });
        return { owner, recipient, team, membership };
    }

    // The held callback has completed the real mutation but has not committed.
    // Observe the real PostgreSQL boundary until the opponent either waits or
    // finishes, then let the winner commit. No internal authority logic is mocked.
    async function afterUncommittedMutation<T>(mutate: (tx: Tx) => Promise<unknown>, compete: (tx: Tx) => Promise<T>) {
        let release!: () => void;
        let ready!: () => void;
        let opponentReady!: (pid: number) => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { ready = resolve; });
        const opponentStarted = new Promise<number>(resolve => { opponentReady = resolve; });
        const holder = inTx(async tx => {
            await mutate(tx);
            ready();
            await held;
        }, { isolationLevel: "ReadCommitted" });
        const holderOutcome = Promise.allSettled([holder]);
        let opponent: Promise<ResolvedTransactionResult<T>> | undefined;
        try {
            await Promise.race([started, holder.then(() => { throw new Error("Mutation missed rendezvous"); })]);
            let finished = false;
            opponent = inTx(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                opponentReady(pid);
                return compete(tx);
            }, { isolationLevel: "ReadCommitted" }).finally(() => { finished = true; });
            const opponentOutcome = Promise.allSettled([opponent]);
            const pid = await opponentStarted;
            while (!finished) {
                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                `;
                if (blocked) break;
            }
            release();
            await holder;
            await opponentOutcome;
            return await opponent;
        } finally {
            release();
            await holderOutcome;
            await Promise.allSettled(opponent ? [opponent] : []);
        }
    }

    async function transferSource(teamId: string, accountId: string) {
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: teamId, kind: "workos_sso", displayName: "Transfer source", config: { v: 1 },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId, providerInstanceId: provider.id, externalReference: { v: 1 }, settings: { v: 1 },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId, kind: "workos_directory", displayName: "Transfer source", state: "active",
            externalSourceKey: randomUUID(), bindingConfig: { v: 1, kind: "workos_directory" }, teamIdentityConnectionId: connection.id,
        } });
        const identity = await db.teamProvisionedIdentity.create({ data: {
            teamId, directorySourceId: source.id, externalUserId: randomUUID(),
            state: "active", boundAccountId: accountId,
        } });
        return { source, identity };
    }

    it("denies a self-transfer after suspension wins the Team guard", async () => {
        const { owner, recipient, team, membership } = await fixture();
        const { source, identity } = await transferSource(team.id, recipient.id);
        const result = await afterUncommittedMutation(async tx => {
            expect(await suspendTeamMemberForActorInTx(tx, {
                teamId: team.id, actorAccountId: owner.id, membershipId: membership.id,
            })).toMatchObject({ ok: true });
        }, tx => setTeamMemberManagementForActorInTx(tx, {
            teamId: team.id, actorAccountId: recipient.id, membershipId: membership.id,
            management: { kind: "directory_source", directorySourceId: source.id },
        }));
        expect(result).toEqual({ ok: false, error: "team_not_found" });
        expect(await db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: identity.id } }))
            .toMatchObject({ teamMembershipId: null });
        expect(await db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } })).toMatchObject({ status: "suspended" });
    });

    async function materialFixture() {
        const base = await fixture();
        const sourceMember = { kind: "provider_credential_slot" as const, connectionId: "connection" as ProviderConnectionId, credentialSlotId: "apiKey" };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const sourceVersion = "provider-source-v1";
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: base.team.id, custodianAccountId: base.owner.id, displayName: "Already published source",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed", allMembersDeliveryMode: "direct",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection", connectionSecurityFingerprint: `connection-security:v1:${"a".repeat(43)}`, credentialSlotId: "apiKey" }),
            directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: sourceVersion }),
        } });
        const upload = {
            actorAccountId: base.owner.id, resourceId: resource.id, recipientAccountId: base.recipient.id,
            sourceMemberKey, sourceVersion, recipientMode: "plain" as const,
            recipientContentPublicKeyFingerprint: null, expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null, expectedPublishedSourceVersion: sourceVersion,
            stored: createTeamCredentialDirectMaterialStoredV1({ recipientMode: "plain", payload: {
                v: 1, domain: "happier.team-credential-direct-material", homeServerIdentityId: "home",
                teamId: base.team.id, resourceId: resource.id, resourceRevision: resource.revision,
                recipientAccountId: base.recipient.id, sourceMember, sourceVersion,
                material: { kind: "provider_api_key", value: "disposable-fixture", runtimeBinding: {
                    provider: { identity: { pluginId: "happier.provider.test", localId: "test" }, definitionRevision: 1 },
                    endpoint: { endpointTemplateId: "responses", normalizedUrl: "https://api.example.test/v1", protocol: "openai-responses", publicHeaders: {} },
                    credentialTransport: { id: "api-key", protocols: ["openai-responses"], uses: ["runtime"], destination: { kind: "httpHeader", name: "Authorization", format: "bearer" } },
                } },
            } }),
        };
        return { ...base, resource, upload };
    }

    it("accepts a new recipient tuple for an already published source", async () => {
        const input = await materialFixture();
        expect(await inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, input.upload), { isolationLevel: "ReadCommitted" }))
            .toMatchObject({ ok: true, changed: true });
        expect(await db.teamCredentialRecipientMaterial.count({ where: { resourceId: input.resource.id } })).toBe(1);
    });

    it.each(["membership", "leave", "audience", "resource"] as const)("rejects material captured before %s withdrawal commits", async kind => {
        const input = await materialFixture();
        const result = await afterUncommittedMutation(async tx => {
            const withdrawal = kind === "membership" || kind === "leave"
                ? await removeTeamMemberForActorInTx(tx, { teamId: input.team.id, actorAccountId: kind === "leave" ? input.recipient.id : input.owner.id,
                    ...(kind === "membership" ? { membershipId: input.membership.id } : {}) })
                : kind === "audience"
                    ? await setTeamCredentialAudienceInTx(tx, { actorAccountId: input.owner.id, authentication: { authenticationAuthority: "present_user" }, input: {
                        resourceId: input.resource.id, expectedRevision: input.resource.revision,
                        allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [],
                    } })
                    : await updateTeamCredentialResourceInTx(tx, { actorAccountId: input.owner.id, authentication: { authenticationAuthority: "present_user" }, patch: {
                        resourceId: input.resource.id, expectedRevision: input.resource.revision, enabled: false,
                    } });
            expect(withdrawal).toMatchObject({ ok: true });
        }, tx => upsertTeamCredentialRecipientMaterialInTx(tx, input.upload));
        expect(result).toMatchObject({ ok: false, reason: kind === "membership" || kind === "leave" ? "access_removed"
            : kind === "resource" ? "disabled" : "resource_changed" });
        expect(await db.teamCredentialRecipientMaterial.count({ where: { resourceId: input.resource.id } })).toBe(0);
    });

    it("keeps mixed-recipient HTTP batch results after a membership ends", async () => {
        const input = await materialFixture();
        const retained = await account();
        const outsider = await account();
        await db.teamMembership.create({ data: { teamId: input.team.id, accountId: retained.id, role: "member" } });
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, {
            teamId: input.team.id, actorAccountId: input.owner.id, membershipId: input.membership.id,
        }), { isolationLevel: "ReadCommitted" })).toMatchObject({ ok: true });
        const { actorAccountId: _actor, resourceId: _resource, ...item } = input.upload;
        if (item.stored.t !== "plain") throw new Error("The fixture supplies plain material");
        const payload = item.stored.v;
        const items = [input.recipient.id, retained.id, outsider.id].map(recipientAccountId => ({
            ...item, recipientAccountId,
            stored: createTeamCredentialDirectMaterialStoredV1({ recipientMode: "plain", payload: { ...payload, recipientAccountId } }),
        }));
        const response = await app.inject({
            method: "PUT", url: `/v2/teams/${input.team.id}/credential-resources/${input.resource.id}/direct-material`,
            headers: { "x-test-user-id": input.owner.id }, payload: { items },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ results: [
            { recipientAccountId: input.recipient.id, status: "unavailable", reason: "access_removed" },
            { recipientAccountId: retained.id, status: "stored" },
            { recipientAccountId: outsider.id, status: "unavailable", reason: "access_removed" },
        ] });
        expect(await db.teamCredentialRecipientMaterial.findMany({ where: { resourceId: input.resource.id }, select: { recipientAccountId: true } }))
            .toEqual([{ recipientAccountId: retained.id }]);
    });

    it.each(["suspend", "remove", "leave", "management", "material", "audience", "update"] as const)("HTTP %s progresses when the Account cursor advances after admission", async kind => {
        const input = await materialFixture();
        const management = kind === "management" ? await transferSource(input.team.id, input.recipient.id) : null;
        const { actorAccountId: _actor, resourceId: _resource, ...item } = input.upload;
        const actorAccountId = kind === "leave" || kind === "management" ? input.recipient.id : input.owner.id;
        const url = kind === "material" ? `/v2/teams/${input.team.id}/credential-resources/${input.resource.id}/direct-material`
            : kind === "audience" ? homeDomainActionPathForMethod("teams.credentials.audience.set", "POST")
            : kind === "update" ? homeDomainActionPathForMethod("teams.credentials.update", "POST")
            : kind === "management" ? homeDomainActionPathForMethod("teams.members.management.set", "POST")
            : homeDomainActionPathForMethod(`teams.members.${kind}`, "POST");
        const payload = kind === "material" ? { items: [item] }
            : kind === "audience" ? { resourceId: input.resource.id, expectedRevision: input.resource.revision, allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [] }
            : kind === "update" ? { resourceId: input.resource.id, expectedRevision: input.resource.revision, enabled: false }
            : { v: 1, teamId: input.team.id, ...(kind === "leave" ? {} : { membershipId: input.membership.id }),
                ...(management ? { management: { kind: "directory_source", directorySourceId: management.source.id } } : {}) };
        const original = db.$transaction;
        const peerScope = new AsyncLocalStorage<boolean>();
        let advances = 0;
        // Schedule at the Prisma transport boundary, retaining all route, owner,
        // admission, SQL-isolation and terminal-publication behavior.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function" || peerScope.getStore()) return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let scheduled = false;
                const team = new Proxy(tx.team, { get(owner, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof owner.findUnique>) => {
                        const found = await owner.findUnique(...values);
                        if (!scheduled) {
                            scheduled = true;
                            await peerScope.run(true, () => inTx(peer => markAccountChanged(peer, {
                                accountId: actorAccountId, kind: "account", entityId: "serialaudit-c5-hot-cursor",
                            })));
                            advances++;
                        }
                        return found;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    return property === "team" ? team : Reflect.get(owner, property, receiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const response = await app.inject({ method: kind === "material" ? "PUT" : "POST", url,
                headers: { "x-test-user-id": actorAccountId }, payload });
            expect(response.statusCode, response.body).toBe(200);
            expect(advances).toBe(1);
            if (kind === "material") expect(response.json()).toMatchObject({ results: [{ status: "stored" }] });
        } finally {
            db.$transaction = original;
        }
    });
});
