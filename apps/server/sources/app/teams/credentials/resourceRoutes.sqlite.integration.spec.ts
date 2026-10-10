import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
    computeTeamCredentialSourceMemberKeyV1,
    createTeamCredentialDirectMaterialStoredV1,
    encodeSessionTeamCredentialSlotKeyV1,
    TeamCredentialResourceErrorV1Schema,
} from "@happier-dev/protocol/teams";
import {
    encodePasswordCredentialFieldV1,
    type AccountPasswordCredentialV1,
} from "@happier-dev/protocol";
import type { ProviderConnectionId } from "@happier-dev/protocol/providers/ids";

import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountIdentityDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { peerMediationGrantSigningEnv } from "@/testkit/env";

import { registerTeamCredentialResourceRoutes } from "./registerTeamCredentialResourceRoutes";
import { projectTeamCredentialResourceSummaryInTx } from "./resourceRead";
import { resolveTeamCredentialDirectSourceCurrentnessInTx } from "./resourceSourceResolver";
import { inTx } from "@/storage/inTx";
import { recordConnectedServiceAccountProfileChange } from "@/app/api/routes/connect/connectedServicesAccountProfileChange";
import { TEAM_CHANGE_ENTITY_ID } from "../teamChanges";
import { recordTeamCredentialDirectDeliveryActivityInTx } from "./resourceActivity";

describe("Team credential resource routes (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "team-credential-resource-routes-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
                // The external Provider API is deployment-ready only when the
                // broker relay can mint route grants (`teamsFeature.ts`), so a
                // ready Home carries the same signing substrate production needs.
                ...peerMediationGrantSigningEnv(),
            },
        });
        app = createAuthenticatedTestApp();
        registerTeamCredentialResourceRoutes(app);
        await app.ready();
    }, 180_000);

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    async function post(url: string, actorAccountId: string, payload: unknown, authenticationEvidence?: unknown) {
        return await app.inject({
            method: "POST",
            url,
            headers: {
                "x-test-user-id": actorAccountId,
                ...(authenticationEvidence === undefined
                    ? {}
                    : { "x-test-authentication-evidence": JSON.stringify(authenticationEvidence) }),
            },
            payload,
        });
    }

    async function get(url: string, actorAccountId: string, authenticationEvidence?: unknown) {
        return await app.inject({
            method: "GET",
            url,
            headers: {
                "x-test-user-id": actorAccountId,
                ...(authenticationEvidence === undefined
                    ? {}
                    : { "x-test-authentication-evidence": JSON.stringify(authenticationEvidence) }),
            },
        });
    }

    async function createAccount() {
        return await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
    }

    it("keeps valid catalog siblings when one resource source binding is malformed", async () => {
        const owner = await createAccount();
        const recipient = await createAccount();
        const team = await db.team.create({ data: { name: "Catalog row corruption" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
        const source = {
            v: 1,
            kind: "provider_connection",
            connectionId: "catalog-row-source",
            connectionSecurityFingerprint: "connection-security:v1:catalog-row",
            credentialSlotId: "apiKey",
        } as const;
        const valid = await db.teamCredentialResource.create({ data: {
            id: "catalog-valid-sibling",
            teamId: team.id,
            custodianAccountId: owner.id,
            displayName: "Valid sibling",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        await db.teamCredentialResource.create({ data: {
            id: "catalog-malformed-source",
            teamId: team.id,
            custodianAccountId: owner.id,
            displayName: "Malformed source sibling",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: "not-json",
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });

        const response = await post("/v1/teams/credential-resources/entitled/list", recipient.id, { teamId: team.id });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().resources).toContainEqual(expect.objectContaining({
            id: valid.id,
        }));
        expect(response.json().resources).toContainEqual(expect.objectContaining({
            id: "catalog-malformed-source",
            readiness: { kind: "resource_corrupt" },
            recoveryAction: "source_owner_action",
        }));
    });

    it("authorizes only the assigned external key through the authenticated route without accepting caller proof", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "e2ee" } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "e2ee" } });
        const team = await db.team.create({ data: { name: "External route qualification", authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        } } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: manager.id, displayName: "External authorization",
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "route-qualification",
                connectionSecurityFingerprint: "connection-security:v1:route", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        const evidence = [{ kind: "home_method", methodId: "key_challenge" }];
        const created = await post("/v1/teams/credential-resources/external-keys/create", manager.id, {
            resourceId: resource.id, teamMembershipId: membership.id, label: "Member's tool", expiresAt: null,
        }, evidence);
        expect({ status: created.statusCode, error: created.json().error }).toEqual({ status: 200, error: undefined });
        const payload = { resourceId: resource.id, keyId: created.json().key.keyId };
        const url = "/v1/teams/credential-resources/external-keys/authorize";
        expect((await post(url, manager.id, payload, evidence)).statusCode).toBe(403);
        expect((await post(url, member.id, { ...payload, authenticationEvidence: evidence })).statusCode).toBe(400);
        const pending = await post("/v1/teams/credential-resources/external-keys/list", member.id, { resourceId: resource.id });
        expect(pending.statusCode).toBe(200);
        expect(pending.json().keys).toMatchObject([{ authenticationStatus: "authentication_required", canAuthorize: true }]);
        const authorized = await post(url, member.id, payload, evidence);
        expect(authorized.statusCode).toBe(200);
        expect(authorized.json()).toMatchObject({ key: { keyId: payload.keyId, authenticationStatus: "satisfied" } });
        expect(authorized.json()).not.toHaveProperty("token");
        expect(authorized.body).not.toContain(created.json().token);
    });

    it("withdraws only the source owner's captured direct publication and rejects a delayed withdrawal", async () => {
        const owner = await createAccount();
        const outsider = await createAccount();
        const team = await db.team.create({ data: { name: "Direct source withdrawal" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1({
            kind: "provider_credential_slot", connectionId: "direct-withdrawal-source" as ProviderConnectionId, credentialSlotId: "apiKey",
        });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: owner.id,
            displayName: "Direct publication",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "direct-withdrawal-source", connectionSecurityFingerprint: "connection-security:v1:test", credentialSlotId: "apiKey" }),
            directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: "version-2", unrelated: "other-version" }),
        } });
        const withdraw = (accountId: string, expectedPublishedSourceVersion: string) => app.inject({
            method: "DELETE",
            url: `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`,
            headers: { "x-test-user-id": accountId },
            payload: { sourceMemberKey, expectedResourceRevision: resource.revision, expectedPublishedSourceVersion },
        });
        const refused = await withdraw(outsider.id, "version-2");
        expect(refused.statusCode, refused.body).toBe(400);
        expect(refused.json()).toEqual({ error: "source_owner_required" });
        const stale = await withdraw(owner.id, "version-1");
        expect(stale.statusCode, stale.body).toBe(400);
        expect(stale.json()).toEqual({ error: "source_replaced_or_missing" });
        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).directSourceVersionsJson)
            .toBe(JSON.stringify({ [sourceMemberKey]: "version-2", unrelated: "other-version" }));
        expect((await withdraw(owner.id, "version-2")).statusCode).toBe(200);
        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).directSourceVersionsJson)
            .toBe(JSON.stringify({ unrelated: "other-version" }));
        expect((await withdraw(owner.id, "version-2")).statusCode).toBe(200);
    });

    it("discovers value-free request-policy support for every authorized exact source without caller-authored application authority", async () => {
        const owner = await createAccount();
        const manager = await createAccount();
        const outsider = await createAccount();
        const team = await db.team.create({ data: { name: "Request policy support" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: manager.id, role: "admin" },
        ] });
        const broker = await db.machine.create({ data: {
            id: `request-policy-broker-${owner.id}`,
            accountId: owner.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const application = {
            agentTargetKey: "agent:happier.agent.codex/codex",
            implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
            endpointTemplateId: "responses",
            protocol: "openai-responses",
        } as const;
        const providerSource = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "request-policy-connection" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"r".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const connectedService = { pluginId: "happier.connected.example", localId: "accounts" };
        const connectedAccount = { service: connectedService, accountId: "request-policy-account" };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: owner.id,
            servicePluginId: connectedService.pluginId,
            serviceLocalId: connectedService.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(connectedService),
            connectedAccountId: connectedAccount.accountId,
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(connectedAccount),
            authenticationModeId: "api-key",
            token: Buffer.from("request-policy-private-credential"),
            metadata: { credentialRevision: "csr_request_policy_account" },
        } });
        const connectedGroupId = "request-policy-pool";
        const connectedGroup = await db.connectedServiceAuthGroup.create({ data: {
            accountId: owner.id,
            servicePluginId: connectedService.pluginId,
            serviceLocalId: connectedService.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(connectedService),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service: connectedService, groupId: connectedGroupId }),
            groupId: connectedGroupId,
            displayName: "Request policy pool",
            policyJson: "{}",
        } });
        const connectedAccountSource = {
            v: 1 as const,
            kind: "connected_account" as const,
            target: { kind: "account" as const, account: connectedAccount },
            credentialIncarnation: credential.id,
        };
        const connectedPoolSource = {
            v: 1 as const,
            kind: "connected_pool" as const,
            target: { kind: "group" as const, service: connectedService, groupId: connectedGroupId },
            poolIncarnation: connectedGroup.id,
        };
        app.machineDaemonPresence = {
            in: () => ({
                fetchSockets: async () => [{
                    data: { clientType: "machine-scoped", userId: owner.id, machineId: broker.id },
                }],
            }),
        };
        const rpc = vi.fn(async (_input: unknown): Promise<{ ok: true; result: unknown }> => ({ ok: true as const, result: {
            status: "success" as const,
            models: [{
                descriptor: { id: "gpt-5", name: "GPT-5", aliases: ["gpt-latest"] },
                application,
                sourceRevision: "request-policy-source-revision",
                protocolKind: "openai_responses" as const,
                model: { canonicalId: "gpt-5", aliases: ["gpt-latest"] },
                reasoningEffort: { supported: false as const },
            }],
        } }));
        app.forwardRpcForUser = rpc;

        for (const source of [providerSource, connectedAccountSource, connectedPoolSource]) {
            const response = await post(
                "/v1/teams/credential-resources/request-policy-support/get",
                owner.id,
                {
                    scope: "source_draft",
                    teamId: team.id,
                    source,
                    brokerPlacement: { kind: "machine", machineId: broker.id },
                },
            );
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({
                status: "available",
                models: [{
                    descriptor: { id: "gpt-5", name: "GPT-5", aliases: ["gpt-latest"] },
                    application,
                    sourceRevision: "request-policy-source-revision",
                    allowedProtocolKinds: ["openai_responses"],
                    reasoningEffort: null,
                }],
            });
            expect(response.body).not.toContain(broker.id);
            expect(response.body).not.toContain(source.kind);
        }
        expect(rpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
            userId: owner.id,
            method: `${broker.id}:daemon.providers.teamCredentialRequestPolicy.support`,
            params: {
                machineId: broker.id,
                source: providerSource,
            },
        }));
        expect(rpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
            params: { machineId: broker.id, source: connectedAccountSource },
        }));
        expect(rpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
            params: { machineId: broker.id, source: connectedPoolSource },
        }));

        const createDraft = {
            teamId: team.id,
            displayName: "Created with policy",
            source: providerSource,
            disclosureCeiling: "brokered_only" as const,
            sessionUsePolicy: "personal_allowed" as const,
            brokerPlacement: { kind: "machine" as const, machineId: broker.id },
            requestPolicy: {
                allowedProtocolKinds: ["openai_responses" as const],
                allowedModelIds: ["missing-model"],
                reasoningEffort: null,
            },
            allMembersDeliveryMode: null,
            groupGrants: [],
            memberGrants: [],
            usageLimits: [],
        };
        const unsupportedCreate = await post(
            "/v1/teams/credential-resources/create",
            owner.id,
            { ...createDraft, resourceId: `unsupported-policy-${owner.id}` },
        );
        expect(unsupportedCreate.statusCode, unsupportedCreate.body).toBe(400);
        expect(unsupportedCreate.json()).toEqual({ error: "update_required" });
        expect(await db.teamCredentialResource.count({ where: { id: `unsupported-policy-${owner.id}` } })).toBe(0);
        expect(await db.teamCredentialActivityEvent.count({ where: { resourceId: `unsupported-policy-${owner.id}` } })).toBe(0);
        expect(await db.teamCredentialGroupGrant.count({ where: { resourceId: `unsupported-policy-${owner.id}` } })).toBe(0);
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: `unsupported-policy-${owner.id}` } })).toBe(0);
        expect(await db.teamCredentialUsageLimit.count({ where: { resourceId: `unsupported-policy-${owner.id}` } })).toBe(0);
        expect(await db.teamCredentialRecipientMaterial.count({ where: { resourceId: `unsupported-policy-${owner.id}` } })).toBe(0);

        const canonicalResourceId = `canonical-policy-${owner.id}`;
        const canonicalCreate = await post(
            "/v1/teams/credential-resources/create",
            owner.id,
            {
                ...createDraft,
                resourceId: canonicalResourceId,
                requestPolicy: { ...createDraft.requestPolicy, allowedModelIds: ["gpt-5"] },
            },
        );
        expect(canonicalCreate.statusCode, canonicalCreate.body).toBe(200);
        expect(canonicalCreate.json()).toMatchObject({
            id: canonicalResourceId,
            requestPolicy: { allowedModelIds: ["gpt-5"] },
        });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: canonicalResourceId } }))
            .resolves.toMatchObject({
                requestPolicyJson: JSON.stringify({ ...createDraft.requestPolicy, allowedModelIds: ["gpt-5"] }),
            });
        for (const [kind, source] of [["connected-account", connectedAccountSource], ["pool", connectedPoolSource]] as const) {
            const resourceId = `${kind}-canonical-policy-${owner.id}`;
            const created = await post(
                "/v1/teams/credential-resources/create",
                owner.id,
                {
                    ...createDraft,
                    resourceId,
                    source,
                    requestPolicy: { ...createDraft.requestPolicy, allowedModelIds: ["gpt-5"] },
                },
            );
            expect(created.statusCode, created.body).toBe(200);
            await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resourceId } }))
                .resolves.toMatchObject({
                    requestPolicyJson: JSON.stringify({ ...createDraft.requestPolicy, allowedModelIds: ["gpt-5"] }),
                });
        }

        const aliasResourceId = `alias-policy-${owner.id}`;
        const aliasCreate = await post(
            "/v1/teams/credential-resources/create",
            owner.id,
            {
                ...createDraft,
                resourceId: aliasResourceId,
                requestPolicy: { ...createDraft.requestPolicy, allowedModelIds: ["gpt-latest"] },
            },
        );
        expect(aliasCreate.statusCode, aliasCreate.body).toBe(400);
        expect(aliasCreate.json()).toEqual({ error: "update_required" });
        expect(await db.teamCredentialResource.count({ where: { id: aliasResourceId } })).toBe(0);

        rpc.mockResolvedValueOnce({ ok: true as const, result: {
            status: "success" as const,
            models: [
                {
                    descriptor: { id: "gpt-5", name: "GPT-5", aliases: ["latest"] },
                    application,
                    sourceRevision: "request-policy-source-revision",
                    protocolKind: "openai_responses" as const,
                    model: { canonicalId: "gpt-5", aliases: ["latest"] },
                    reasoningEffort: { supported: false as const },
                },
                {
                    descriptor: { id: "gpt-6", name: "GPT-6", aliases: ["latest"] },
                    application,
                    sourceRevision: "request-policy-source-revision",
                    protocolKind: "openai_responses" as const,
                    model: { canonicalId: "gpt-6", aliases: ["latest"] },
                    reasoningEffort: { supported: false as const },
                },
            ],
        } });
        const ambiguousResourceId = `ambiguous-policy-${owner.id}`;
        const ambiguousCreate = await post(
            "/v1/teams/credential-resources/create",
            owner.id,
            {
                ...createDraft,
                resourceId: ambiguousResourceId,
                requestPolicy: { ...createDraft.requestPolicy, allowedModelIds: ["latest"] },
            },
        );
        expect(ambiguousCreate.statusCode, ambiguousCreate.body).toBe(400);
        expect(ambiguousCreate.json()).toEqual({ error: "update_required" });
        expect(await db.teamCredentialResource.count({ where: { id: ambiguousResourceId } })).toBe(0);

        rpc.mockClear();
        rpc.mockImplementation(async (input: unknown) => {
            if (typeof input === "object" && input !== null && "method" in input
                && String(input.method).endsWith("daemon.providers.teamCredentialRequestPolicy.support")) {
                throw new Error("request-policy support unavailable after lost response");
            }
            return { ok: true as const, result: { status: "unavailable", reason: "source_unavailable" } };
        });
        const replay = await post(
            "/v1/teams/credential-resources/create",
            owner.id,
            {
                ...createDraft,
                resourceId: canonicalResourceId,
                requestPolicy: { ...createDraft.requestPolicy, allowedModelIds: ["gpt-5"] },
            },
        );
        expect(replay.statusCode, replay.body).toBe(200);
        expect(rpc).not.toHaveBeenCalledWith(expect.objectContaining({
            method: expect.stringContaining("daemon.providers.teamCredentialRequestPolicy.support"),
        }));
        rpc.mockReset();
        rpc.mockResolvedValue({ ok: true as const, result: {
            status: "success" as const,
            models: [{
                descriptor: { id: "gpt-5", name: "GPT-5", aliases: ["gpt-latest"] },
                application,
                sourceRevision: "request-policy-source-revision",
                protocolKind: "openai_responses" as const,
                model: { canonicalId: "gpt-5", aliases: ["gpt-latest"] },
                reasoningEffort: { supported: false as const },
            }],
        } });

        const managedResource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: owner.id,
            displayName: "Managed request policy",
            sourceBindingJson: JSON.stringify(providerSource),
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            brokerMachineId: broker.id,
        } });
        const managed = await post(
            "/v1/teams/credential-resources/request-policy-support/get",
            manager.id,
            { scope: "resource", resourceId: managedResource.id },
        );
        expect(managed.statusCode, managed.body).toBe(200);
        expect(managed.json()).toMatchObject({ status: "available" });
        expect(managed.body).not.toContain(owner.id);
        expect(managed.body).not.toContain(providerSource.connectionId);
        expect(managed.body).not.toContain(broker.id);
        expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({ userId: owner.id }));

        const replacement = {
            enabled: true,
            displayName: "Updated policy",
            sessionUsePolicy: "personal_allowed" as const,
            requestPolicy: {
                allowedProtocolKinds: ["openai_responses" as const],
                allowedModelIds: ["missing-model"],
                reasoningEffort: null,
            },
            allMembersDeliveryMode: null,
            groupGrants: [],
            memberGrants: [],
            usageLimitDelta: { upserts: [], deleteIds: [] },
        };
        const unsupported = await post(
            "/v1/teams/credential-resources/update",
            manager.id,
            { resourceId: managedResource.id, expectedRevision: 0, replacement },
        );
        expect(unsupported.statusCode, unsupported.body).toBe(400);
        expect(unsupported.json()).toEqual({ error: "update_required" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: managedResource.id } })).resolves.toMatchObject({
            revision: 0,
            displayName: "Managed request policy",
            requestPolicyJson: null,
        });

        const supported = await post(
            "/v1/teams/credential-resources/update",
            manager.id,
            {
                resourceId: managedResource.id,
                expectedRevision: 0,
                replacement: {
                    ...replacement,
                    requestPolicy: { ...replacement.requestPolicy, allowedModelIds: ["gpt-5"] },
                },
            },
        );
        expect(supported.statusCode, supported.body).toBe(200);
        expect(supported.json()).toEqual({ resourceId: managedResource.id, revision: 1 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: managedResource.id } })).resolves.toMatchObject({
            revision: 1,
            displayName: "Updated policy",
        });

        const aliasUpdate = await post(
            "/v1/teams/credential-resources/update",
            manager.id,
            {
                resourceId: managedResource.id,
                expectedRevision: 1,
                replacement: {
                    ...replacement,
                    requestPolicy: { ...replacement.requestPolicy, allowedModelIds: ["gpt-latest"] },
                },
            },
        );
        expect(aliasUpdate.statusCode, aliasUpdate.body).toBe(400);
        expect(aliasUpdate.json()).toEqual({ error: "update_required" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: managedResource.id } }))
            .resolves.toMatchObject({ revision: 1 });

        rpc.mockImplementationOnce(async () => {
            await db.serviceAccountToken.update({
                where: { id: credential.id },
                data: {
                    configurationRevision: "configuration-rotated-after-support",
                    configurationContent: new Uint8Array([1]),
                },
            });
            return { ok: true as const, result: {
                status: "success" as const,
                models: [{
                    descriptor: { id: "gpt-5", name: "GPT-5", aliases: ["gpt-latest"] },
                    application,
                    sourceRevision: "stale-source-revision",
                    protocolKind: "openai_responses" as const,
                    model: { canonicalId: "gpt-5", aliases: ["gpt-latest"] },
                    reasoningEffort: { supported: false as const },
                }],
            } };
        });
        const rotatedDuringUpdate = await post(
            "/v1/teams/credential-resources/update",
            owner.id,
            {
                resourceId: managedResource.id,
                expectedRevision: 1,
                replacement: {
                    ...replacement,
                    requestPolicy: {
                        ...replacement.requestPolicy,
                        allowedProtocolKinds: null,
                        allowedModelIds: ["gpt-5"],
                    },
                    custodian: {
                        source: connectedAccountSource,
                        disclosureCeiling: "brokered_only",
                        brokerPlacement: { kind: "machine", machineId: broker.id },
                    },
                },
            },
        );
        expect(rotatedDuringUpdate.statusCode, rotatedDuringUpdate.body).toBe(400);
        expect(rotatedDuringUpdate.json()).toEqual({ error: "update_required" });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: managedResource.id } }))
            .resolves.toMatchObject({ revision: 1, sourceBindingJson: JSON.stringify(providerSource) });

        const replacedSource = await post(
            "/v1/teams/credential-resources/update",
            owner.id,
            {
                resourceId: managedResource.id,
                expectedRevision: 1,
                replacement: {
                    ...replacement,
                    requestPolicy: {
                        ...replacement.requestPolicy,
                        allowedProtocolKinds: null,
                        allowedModelIds: ["gpt-5"],
                    },
                    custodian: {
                        source: connectedAccountSource,
                        disclosureCeiling: "brokered_only",
                        brokerPlacement: { kind: "machine", machineId: broker.id },
                    },
                },
            },
        );
        expect(replacedSource.statusCode, replacedSource.body).toBe(200);
        expect(replacedSource.json()).toEqual({ resourceId: managedResource.id, revision: 2 });
        expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({
            userId: owner.id,
            params: { machineId: broker.id, source: connectedAccountSource },
        }));
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: managedResource.id } })).resolves.toMatchObject({
            revision: 2,
            sourceBindingJson: JSON.stringify(connectedAccountSource),
            requestPolicyJson: JSON.stringify({
                ...replacement.requestPolicy,
                allowedProtocolKinds: null,
                allowedModelIds: ["gpt-5"],
            }),
        });

        rpc.mockClear();
        const denied = await post(
            "/v1/teams/credential-resources/request-policy-support/get",
            outsider.id,
            {
                scope: "source_draft",
                teamId: team.id,
                source: providerSource,
                brokerPlacement: { kind: "machine", machineId: broker.id },
            },
        );
        expect(denied.statusCode, denied.body).toBe(403);
        expect(denied.json()).toEqual({ error: "resource_forbidden" });
        expect(rpc).not.toHaveBeenCalled();
    });

    async function enrollEmailPassword(accountId: string) {
        const credential = {
            v: 1,
            kind: "plain_password_hash",
            hash: {
                v: 1,
                algorithm: "scrypt",
                parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(4)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(8)),
            },
        } satisfies AccountPasswordCredentialV1;
        await db.accountPasswordCredential.create({
            data: { accountId, revision: 1, credential },
        });
        await db.accountIdentity.create({
            data: {
                accountId,
                provider: "email",
                providerUserId: `${accountId}@restricted-team.test`,
                profile: {},
            },
        });
    }

    it("lists a qualified non-manager's own resources without granting Team administration fields", async () => {
        const custodian = await createAccount();
        const manager = await createAccount();
        const team = await db.team.create({ data: { name: "Source-owner list" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "admin" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "My offered source",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "team_visibility_required",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "source-owner-list",
                connectionSecurityFingerprint: `connection-security:v1:${"s".repeat(43)}`,
                credentialSlotId: "apiKey",
            }),
        } });

        const own = await post("/v1/teams/credential-resources/list", custodian.id, { teamId: team.id });
        expect(own.statusCode, own.body).toBe(200);
        expect(own.json().resources).toEqual([expect.objectContaining({
            id: resource.id,
            source: expect.objectContaining({ connectionId: "source-owner-list" }),
            capabilities: expect.objectContaining({ disable: true, delete: true, managePolicy: false }),
        })]);
        expect(own.json().viewer).toEqual({ manageCredentials: false, offerOwnCredential: true });

        const managed = await post("/v1/teams/credential-resources/list", manager.id, { teamId: team.id });
        expect(managed.statusCode, managed.body).toBe(200);
        expect(managed.json().resources).toEqual([expect.objectContaining({
            id: resource.id,
            source: null,
            brokerPlacement: null,
        })]);
        expect(managed.body).not.toContain("source-owner-list");
    });

    it("uses a query-bound stable keyset for equal names and non-sort updates", async () => {
        const owner = await createAccount();
        const team = await db.team.create({ data: { name: "Credential pagination" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "pagination-source" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"p".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        for (const row of [
            { id: `page-a-${owner.id}`, displayName: "Alpha" },
            { id: `page-same-a-${owner.id}`, displayName: "Same" },
            { id: `page-same-b-${owner.id}`, displayName: "Same" },
            { id: `page-same-c-${owner.id}`, displayName: "Same" },
            { id: `page-same-d-${owner.id}`, displayName: "Same" },
            { id: `page-z-${owner.id}`, displayName: "Zulu" },
        ]) {
            await db.teamCredentialResource.create({ data: {
                ...row,
                teamId: team.id,
                custodianAccountId: owner.id,
                disclosureCeiling: "direct_allowed",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify(source),
            } });
        }

        const first = await post("/v1/teams/credential-resources/list", owner.id, { teamId: team.id, limit: 2 });
        expect(first.statusCode, first.body).toBe(200);
        expect(first.json().resources.map((row: { id: string }) => row.id)).toEqual([
            `page-a-${owner.id}`,
            `page-same-a-${owner.id}`,
        ]);
        expect(first.json().nextCursor).toEqual(expect.any(String));
        await db.teamCredentialResource.update({
            where: { id: `page-a-${owner.id}` },
            data: { enabled: false, revision: { increment: 1 } },
        });
        const second = await post("/v1/teams/credential-resources/list", owner.id, {
            teamId: team.id,
            limit: 2,
            cursor: first.json().nextCursor,
        });
        expect(second.statusCode, second.body).toBe(200);
        expect(second.json().resources.map((row: { id: string }) => row.id)).toEqual([
            `page-same-b-${owner.id}`,
            `page-same-c-${owner.id}`,
        ]);
        expect(second.json().nextCursor).toEqual(expect.any(String));
        const third = await post("/v1/teams/credential-resources/list", owner.id, {
            teamId: team.id,
            limit: 2,
            cursor: second.json().nextCursor,
        });
        expect(third.statusCode, third.body).toBe(200);
        expect(third.json().resources.map((row: { id: string }) => row.id)).toEqual([
            `page-same-d-${owner.id}`,
            `page-z-${owner.id}`,
        ]);
        expect(third.json().nextCursor).toBeNull();
        const allIds = [...first.json().resources, ...second.json().resources, ...third.json().resources]
            .map((row: { id: string }) => row.id);
        expect(new Set(allIds).size).toBe(6);

        const mismatched = await post("/v1/teams/credential-resources/list", owner.id, {
            teamId: team.id,
            limit: 2,
            search: "Same",
            cursor: first.json().nextCursor,
        });
        expect({ status: mismatched.statusCode, body: mismatched.json() }).toEqual({
            status: 400,
            body: { error: "invalid_resource_input" },
        });
        const malformed = await post("/v1/teams/credential-resources/list", owner.id, {
            teamId: team.id,
            cursor: "not-a-valid-cursor",
        });
        expect({ status: malformed.statusCode, body: malformed.json() }).toEqual({
            status: 400,
            body: { error: "invalid_resource_input" },
        });
    });

    it("filters administration rows by effective delivery grants and only current external keys", async () => {
        const owner = await createAccount();
        const recipient = await createAccount();
        const team = await db.team.create({ data: { name: "Credential list filters" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
        });
        const recipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "filter-source" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"f".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const createResource = async (input: Readonly<{
            id: string;
            ceiling?: "brokered_only" | "direct_allowed";
            mode?: "brokered" | "direct" | "both";
            enabled?: boolean;
        }>) => await db.teamCredentialResource.create({ data: {
            id: `${input.id}-${owner.id}`,
            teamId: team.id,
            custodianAccountId: owner.id,
            displayName: input.id,
            enabled: input.enabled ?? true,
            disclosureCeiling: input.ceiling ?? "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            allMembersDeliveryMode: input.mode ?? null,
        } });
        const brokered = await createResource({ id: "Brokered grant", mode: "brokered" });
        const direct = await createResource({ id: "Direct grant", mode: "direct" });
        const both = await createResource({ id: "Both grant", mode: "both" });
        const ceilingOnly = await createResource({ id: "Ceiling only", ceiling: "brokered_only" });
        const currentExternal = await createResource({ id: "Current external", mode: "brokered" });
        const expiredExternal = await createResource({ id: "Expired external", mode: "brokered" });
        const disabledExternal = await createResource({ id: "Disabled external", mode: "brokered", enabled: false });
        // Six withdrawn rows sort ahead of the one current row, so a page of
        // one only fills after advancing through more candidate windows than
        // any fixed local budget would allow.
        const withdrawnExternalRows = await Promise.all(
            [1, 2, 3, 4, 5, 6].map((index) => createResource({ id: `A withdrawn external ${index}` })),
        );
        await db.teamCredentialMemberGrant.createMany({ data: withdrawnExternalRows.map((resource) => ({
            resourceId: resource.id,
            teamMembershipId: recipientMembership.id,
            deliveryMode: "brokered",
        })) });
        const future = new Date(Date.now() + 60_000);
        const past = new Date(Date.now() - 60_000);
        for (const [index, row] of [currentExternal, expiredExternal, disabledExternal].entries()) {
            await db.teamCredentialExternalApiKey.create({ data: {
                id: `filter-key-${index}-${owner.id}`,
                resourceId: row.id,
                teamMembershipId: membership.id,
                label: `Key ${index}`,
                displayPrefix: `hpk_${index}`,
                secretDigest: `filter-digest-${index}-${owner.id}`,
                expiresAt: row.id === expiredExternal.id ? past : future,
            } });
        }
        for (const [index, resource] of withdrawnExternalRows.entries()) {
            await db.teamCredentialExternalApiKey.create({ data: {
                id: `filter-key-withdrawn-${index}-${owner.id}`,
                resourceId: resource.id,
                teamMembershipId: recipientMembership.id,
                label: `Withdrawn audience key ${index}`,
                displayPrefix: `hpk_withdrawn_${index}`,
                secretDigest: `filter-digest-withdrawn-${index}-${owner.id}`,
                expiresAt: future,
            } });
        }
        await db.teamCredentialMemberGrant.deleteMany({ where: {
            resourceId: { in: withdrawnExternalRows.map((resource) => resource.id) },
            teamMembershipId: recipientMembership.id,
        } });

        const listIds = async (filter: "brokered" | "direct" | "external_api") => {
            const response = await post("/v1/teams/credential-resources/list", owner.id, { teamId: team.id, filter });
            expect(response.statusCode, response.body).toBe(200);
            return response.json().resources.map((row: { id: string }) => row.id) as string[];
        };

        const brokeredIds = await listIds("brokered");
        expect(brokeredIds).toEqual(expect.arrayContaining([
            brokered.id,
            both.id,
            currentExternal.id,
            expiredExternal.id,
            disabledExternal.id,
        ]));
        expect(brokeredIds).not.toContain(ceilingOnly.id);
        const directIds = await listIds("direct");
        expect(directIds).toEqual(expect.arrayContaining([direct.id, both.id]));
        expect(directIds).not.toContain(brokered.id);
        const externalResponse = await post("/v1/teams/credential-resources/list", owner.id, {
            teamId: team.id,
            filter: "external_api",
            limit: 1,
        });
        expect(externalResponse.statusCode, externalResponse.body).toBe(200);
        expect(externalResponse.json()).toMatchObject({
            resources: [{ id: currentExternal.id }],
            nextCursor: null,
        });
    });

    it("continues needs-attention filtering until it fills from later keyset rows", async () => {
        const owner = await createAccount();
        const team = await db.team.create({ data: { name: "Credential attention continuation" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const service = { pluginId: "attention.source", localId: "primary" };
        const account = { service, accountId: "attention-account" };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: owner.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            connectedAccountId: account.accountId,
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(account),
            authenticationModeId: "api-key",
            token: Buffer.from("attention-source-material"),
            metadata: { credentialRevision: "csr_attention_source_revision" },
        } });
        const source = {
            v: 1 as const,
            kind: "connected_account" as const,
            target: { kind: "account" as const, account },
            credentialIncarnation: credential.id,
        };
        for (const displayName of ["Alpha", "Bravo", "Charlie", "Delta", "Zulu"]) {
            await db.teamCredentialResource.create({ data: {
                id: `attention-${displayName}-${owner.id}`,
                teamId: team.id,
                custodianAccountId: owner.id,
                displayName,
                enabled: displayName !== "Zulu",
                disclosureCeiling: "direct_allowed",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify(source),
            } });
        }
        const resources: Array<{ id: string; readiness: { kind: string } }> = [];
        let cursor: string | null = null;
        do {
            const response = await post("/v1/teams/credential-resources/list", owner.id, {
                teamId: team.id, filter: "needs_attention", limit: 2, ...(cursor ? { cursor } : {}),
            });
            expect(response.statusCode, response.body).toBe(200);
            resources.push(...response.json().resources);
            cursor = response.json().nextCursor;
        } while (cursor);
        expect(resources).toEqual([
            expect.objectContaining({ id: `attention-Zulu-${owner.id}`, readiness: { kind: "resource_unavailable" } }),
        ]);
    });

    it("deduplicates list readiness work by exact Pool and Provider source target", async () => {
        const owner = await createAccount();
        const team = await db.team.create({ data: { name: "Batched credential readiness" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const machine = async (suffix: string) => await db.machine.create({ data: {
            id: `batched-readiness-${suffix}-${owner.id}`,
            accountId: owner.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const machineA = await machine("a");
        const machineB = await machine("b");
        const pool = await db.machinePool.create({ data: {
            id: `batched-readiness-pool-${owner.id}`,
            accountId: owner.id,
            name: "Ready Pool",
            members: { create: [
                { machineId: machineA.id, priorityTier: 0, enabled: true },
                { machineId: machineB.id, priorityTier: 1, enabled: true },
            ] },
        } });
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "batched-readiness-source" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"b".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        for (const [suffix, placement] of [
            ["machine-a-1", { brokerMachineId: machineA.id }],
            ["machine-a-2", { brokerMachineId: machineA.id }],
            ["machine-b", { brokerMachineId: machineB.id }],
            ["pool", { brokerPoolId: pool.id }],
        ] as const) {
            await db.teamCredentialResource.create({ data: {
                id: `batched-readiness-resource-${suffix}-${owner.id}`,
                teamId: team.id,
                custodianAccountId: owner.id,
                displayName: `Ready ${suffix}`,
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify(source),
                ...placement,
            } });
        }
        const fetchSockets = vi.fn(async () => [machineA, machineB].map(row => ({
            data: { clientType: "machine-scoped", userId: owner.id, machineId: row.id },
        })));
        app.machineDaemonPresence = { in: () => ({ fetchSockets }) };
        const providerDescription = {
            connectionId: source.connectionId,
            contributionKey: "happier.provider.openai/openai",
            displayName: "OpenAI",
            providerName: "OpenAI",
            icon: null,
            role: "default" as const,
            displayNameMode: "automatic" as const,
            sourceStatus: "available" as const,
            probeCapability: "catalog" as const,
            manualModelPolicy: "allowed" as const,
            compatibility: [],
            grants: { accountEnabled: true, enabledMachineIds: [] },
            credential: { required: true, accountBound: true, boundMachineIds: [] },
            teamCredentialSourceOffer: {
                connectionId: source.connectionId,
                connectionSecurityFingerprint: source.connectionSecurityFingerprint,
                credentialSlotId: source.credentialSlotId,
                label: "OpenAI",
            },
            deployment: { kind: "external" as const },
            managedLocalOption: null,
            endpoints: [],
            scope: "account" as const,
            authorized: true,
            authorizationError: null,
            revision: 1,
            runtime: { health: "available" as const, modelCount: 1, checkedAt: 1 },
        };
        const rpc = vi.fn(async (input: Readonly<{ method: string }>) => input.method.endsWith("daemon.providers.connections.describe")
            ? { ok: true as const, result: {
                status: "success" as const,
                connections: [providerDescription],
                available: [], discoveryCandidates: [], localInstallations: [], diagnostics: [],
                diagnosticsTruncated: false, availableTruncated: false,
            } }
            : { ok: true as const, result: { status: "eligible" as const } });
        app.forwardRpcForUser = rpc;
        const response = await post("/v1/teams/credential-resources/list", owner.id, { teamId: team.id });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().resources).toHaveLength(4);
        expect(response.json().resources.every((row: { readiness: { kind: string } }) => (
            row.readiness.kind === "available"
        ))).toBe(true);
        expect(fetchSockets).toHaveBeenCalledTimes(1);
        expect(response.json().resources.find((row: { id: string }) => row.id.includes("resource-pool"))).toMatchObject({
            readiness: { kind: "available" },
            brokerPresentation: {
                selectedPool: { poolId: pool.id, availability: "available", availableMachineCount: 2 },
            },
        });
        const eligibilityCalls = rpc.mock.calls.filter(([input]) => input.method.endsWith("teamCredentialBroker.eligibility"));
        const descriptionCalls = rpc.mock.calls.filter(([input]) => input.method.endsWith("providers.connections.describe"));
        expect(eligibilityCalls).toHaveLength(2);
        expect(descriptionCalls).toHaveLength(2);
    });

    it("source-lists exact owned Account, Pool, and Provider rows after Team departure without Team administration data", async () => {
        const custodian = await createAccount();
        const unrelated = await createAccount();
        const team = await db.team.create({ data: { name: "Private source administration" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: unrelated.id, role: "admin" } });
        const service = { pluginId: "route.source-admin", localId: "primary" };
        const sources = {
            account: {
                v: 1 as const,
                kind: "connected_account" as const,
                target: { kind: "account" as const, account: { service, accountId: "account-1" } },
                credentialIncarnation: "credential-incarnation-1",
            },
            pool: {
                v: 1 as const,
                kind: "connected_pool" as const,
                target: { kind: "group" as const, service, groupId: "pool-1" },
                poolIncarnation: "pool-incarnation-1",
            },
            provider: {
                v: 1 as const,
                kind: "provider_connection" as const,
                connectionId: "provider-connection-1",
                connectionSecurityFingerprint: "connection-security:v1:route-source-admin",
                credentialSlotId: "apiKey",
            },
            otherProvider: {
                v: 1 as const,
                kind: "provider_connection" as const,
                connectionId: "provider-connection-2",
                connectionSecurityFingerprint: "connection-security:v1:route-other-source",
                credentialSlotId: "apiKey",
            },
        };
        for (const [id, source] of Object.entries(sources)) {
            await db.teamCredentialResource.create({ data: {
                id: `route-source-admin-${id}`,
                teamId: team.id,
                custodianAccountId: custodian.id,
                displayName: `${id} source`,
                disclosureCeiling: "direct_allowed",
                sessionUsePolicy: "personal_allowed",
                requestPolicyJson: JSON.stringify({
                    allowedProtocolKinds: null,
                    allowedModelIds: null,
                    reasoningEffort: null,
                }),
                sourceBindingJson: JSON.stringify(source),
            } });
        }
        await db.teamCredentialResource.create({ data: {
            id: "route-source-admin-provider-2", teamId: team.id,
            custodianAccountId: custodian.id, displayName: "provider source",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(sources.provider),
        } });
        for (const suffix of ["a", "b"]) {
            await db.teamCredentialResource.create({ data: {
                id: `route-source-admin-account-false-${suffix}`, teamId: team.id,
                custodianAccountId: custodian.id, displayName: `0 false account ${suffix}`,
                disclosureCeiling: "direct_allowed", sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    ...sources.account,
                    target: {
                        ...sources.account.target,
                        account: {
                            ...sources.account.target.account,
                            service: { pluginId: "route.source-admin.other", localId: suffix },
                        },
                    },
                }),
            } });
        }

        const currentMemberTeamList = await post(
            "/v1/teams/credential-resources/list",
            custodian.id,
            { teamId: team.id },
        );
        expect(currentMemberTeamList.statusCode, currentMemberTeamList.body).toBe(200);
        expect(currentMemberTeamList.json().resources).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "route-source-admin-provider",
                capabilities: expect.objectContaining({
                    managePolicy: false,
                    updateBrokerPlacement: true,
                    narrowDisclosure: true,
                    disable: true,
                    delete: true,
                }),
            }),
        ]));
        const currentMemberDetail = await post(
            "/v1/teams/credential-resources/get",
            custodian.id,
            { resourceId: "route-source-admin-provider" },
        );
        expect(currentMemberDetail.statusCode, currentMemberDetail.body).toBe(200);
        expect(currentMemberDetail.json()).toMatchObject({
            id: "route-source-admin-provider",
            requestPolicy: null,
            groupGrants: [],
            memberGrants: [],
            capabilities: {
                manageAudience: false,
                managePolicy: false,
                manageLimits: false,
                updateBrokerPlacement: true,
                narrowDisclosure: true,
                refreshDirectMaterial: true,
                disable: true,
                enable: false,
                delete: true,
            },
        });

        const managerTeamList = await post(
            "/v1/teams/credential-resources/list",
            unrelated.id,
            { teamId: team.id },
        );
        expect(managerTeamList.statusCode, managerTeamList.body).toBe(200);
        expect(managerTeamList.json().resources.find(
            (row: { id: string }) => row.id === "route-source-admin-provider",
        )).toMatchObject({
            capabilities: {
                manageAudience: true,
                managePolicy: true,
                manageLimits: true,
                updateBrokerPlacement: false,
                narrowDisclosure: false,
                refreshDirectMaterial: false,
                disable: true,
                enable: false,
                delete: true,
            },
        });

        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: custodian.id } });

        const list = async (source: unknown, actorAccountId = custodian.id) => await post(
            "/v1/teams/credential-resources/source-resources/list",
            actorAccountId,
            { source },
        );
        const accountResources: unknown[] = [];
        let accountCursor: string | null = null;
        do {
            const page = await post("/v1/teams/credential-resources/source-resources/list", custodian.id, {
                source: { v: 1, kind: "connected_account", target: sources.account.target }, limit: 1,
                ...(accountCursor ? { cursor: accountCursor } : {}),
            });
            expect(page.statusCode, page.body).toBe(200);
            accountResources.push(...page.json().resources);
            accountCursor = page.json().nextCursor;
        } while (accountCursor);
        const pool = await list({ v: 1, kind: "connected_pool", target: sources.pool.target });
        const providerFirst = await post("/v1/teams/credential-resources/source-resources/list", custodian.id, {
            source: { v: 1, kind: "provider_connection", connectionId: sources.provider.connectionId }, limit: 1,
        });
        const provider = await post("/v1/teams/credential-resources/source-resources/list", custodian.id, {
            source: { v: 1, kind: "provider_connection", connectionId: sources.provider.connectionId },
            cursor: providerFirst.json().nextCursor, limit: 1,
        });
        expect(pool.statusCode, pool.body).toBe(200);
        expect(providerFirst.statusCode, providerFirst.body).toBe(200);
        expect(provider.statusCode, provider.body).toBe(200);
        const wrongScope = await post("/v1/teams/credential-resources/source-resources/list", custodian.id, {
            source: { v: 1, kind: "provider_connection", connectionId: sources.otherProvider.connectionId },
            cursor: providerFirst.json().nextCursor, limit: 1,
        });
        expect(wrongScope.statusCode, wrongScope.body).toBe(400);
        expect(accountResources).toMatchObject([{ id: "route-source-admin-account" }]);
        expect(pool.json().resources.map((row: { id: string }) => row.id)).toEqual(["route-source-admin-pool"]);
        expect([...providerFirst.json().resources, ...provider.json().resources]).toMatchObject([{
            id: "route-source-admin-provider",
            capabilities: {
                manageAudience: false,
                managePolicy: false,
                manageLimits: false,
                updateBrokerPlacement: true,
                narrowDisclosure: true,
                refreshDirectMaterial: false,
                disable: true,
                enable: false,
                delete: true,
            },
        }, { id: "route-source-admin-provider-2" }]);
        const guessed = await list({
            v: 1,
            kind: "provider_connection",
            connectionId: sources.provider.connectionId,
        }, unrelated.id);
        expect(guessed.statusCode, guessed.body).toBe(200);
        expect(guessed.json()).toEqual({ resources: [], nextCursor: null });
        for (const forbidden of [
            team.id,
            "custodianAccountId",
            "sourceBindingJson",
            "groupGrants",
            "memberGrants",
            "requestPolicy",
            "usageLimits",
            sources.provider.connectionSecurityFingerprint,
            sources.provider.credentialSlotId,
        ]) {
            expect(provider.body).not.toContain(forbidden);
        }
        const providerRevision = provider.json().resources[0].revision as number;

        const narrowed = await post(
            "/v1/teams/credential-resources/update",
            custodian.id,
            {
                resourceId: "route-source-admin-provider",
                expectedRevision: providerRevision,
                disclosureCeiling: "brokered_only",
            },
        );
        expect(narrowed.statusCode, narrowed.body).toBe(200);
        expect(narrowed.json()).toEqual({
            resourceId: "route-source-admin-provider",
            revision: providerRevision + 1,
        });
        expect(narrowed.body).not.toContain(team.id);
        expect(narrowed.body).not.toContain('"source":');
        expect(narrowed.body).not.toContain("requestPolicy");

        const audienceNarrowed = await post(
            "/v1/teams/credential-resources/audience/set",
            custodian.id,
            {
                resourceId: "route-source-admin-provider",
                expectedRevision: providerRevision + 1,
                allMembersDeliveryMode: null,
                groupGrants: [],
                memberGrants: [],
            },
        );
        expect(audienceNarrowed.statusCode, audienceNarrowed.body).toBe(200);
        expect(audienceNarrowed.json()).toEqual({
            resourceId: "route-source-admin-provider",
            revision: providerRevision + 2,
        });
        expect(audienceNarrowed.body).not.toContain(team.id);
        expect(audienceNarrowed.body).not.toContain('"source":');
        expect(audienceNarrowed.body).not.toContain("groupGrants");

        const teamList = await post("/v1/teams/credential-resources/list", custodian.id, { teamId: team.id });
        expect(teamList.statusCode).toBe(404);
        const detail = await post("/v1/teams/credential-resources/get", custodian.id, {
            resourceId: "route-source-admin-provider",
        });
        expect(detail.statusCode).toBe(404);
    });

    it("projects exact persistent broker presence and current Provider Connection readiness", async () => {
        const custodian = await createAccount();
        const manager = await createAccount();
        const team = await db.team.create({ data: { name: "Exact broker readiness" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "admin" } });
        const createMachine = async (suffix: string, data: Record<string, unknown> = {}) => await db.machine.create({ data: {
            id: `exact-readiness-${suffix}-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
            ...data,
        } });
        const online = await createMachine("online");
        const offline = await createMachine("offline");
        const unsupported = await createMachine("unsupported", {
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [2] } },
        });
        const updateRequired = await createMachine("unversioned", {
            operationProtocolCapabilitiesRevision: null,
        });
        const ephemeral = await createMachine("ephemeral", { kind: "ephemeral_session_runner" });
        const fingerprint = `connection-security:v1:${"c".repeat(43)}`;
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "exact-readiness-connection" as ProviderConnectionId,
            connectionSecurityFingerprint: fingerprint,
            credentialSlotId: "apiKey",
        };
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Exact Provider",
            enabled: true,
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            brokerMachineId: online.id,
        } });
        app.machineDaemonPresence = {
            in: () => ({
                fetchSockets: async () => [online, unsupported, updateRequired, ephemeral].map(machine => ({
                    data: { clientType: "machine-scoped", userId: custodian.id, machineId: machine.id },
                })),
            }),
        };
        const providerConnection = {
            connectionId: source.connectionId,
            contributionKey: "happier.provider.openai/openai",
            displayName: "OpenAI",
            providerName: "OpenAI",
            icon: null,
            role: "default" as const,
            displayNameMode: "automatic" as const,
            sourceStatus: "available" as const,
            probeCapability: "catalog" as const,
            manualModelPolicy: "allowed" as const,
            compatibility: [],
            grants: { accountEnabled: true, enabledMachineIds: [] },
            credential: { required: true, accountBound: true, boundMachineIds: [] },
            teamCredentialSourceOffer: {
                connectionId: source.connectionId,
                connectionSecurityFingerprint: fingerprint,
                credentialSlotId: source.credentialSlotId,
                label: "OpenAI",
            },
            deployment: { kind: "external" as const },
            managedLocalOption: null,
            endpoints: [],
            scope: "account" as const,
            authorized: true,
            authorizationError: null,
            revision: 1,
            runtime: { health: "available" as const, modelCount: 1, checkedAt: 1 },
        };
        let describedConnections = [providerConnection];
        app.forwardRpcForUser = vi.fn(async (input: Readonly<{ method: string }>) => {
            if (input.method.endsWith("daemon.providers.connections.describe")) {
                return { ok: true as const, result: {
                    status: "success" as const,
                    connections: describedConnections,
                    available: [],
                    discoveryCandidates: [],
                    localInstallations: [],
                    diagnosticsTruncated: false,
                    diagnostics: [],
                    availableTruncated: false,
                } };
            }
            return { ok: true as const, result: { status: "eligible" as const } };
        });

        const listed = await post("/v1/teams/credential-resources/list", custodian.id, { teamId: team.id });
        expect(listed.statusCode, listed.body).toBe(200);
        const projected = listed.json().resources.find((candidate: { id: string }) => candidate.id === resource.id);
        expect(projected).toMatchObject({
            readiness: { kind: "available" },
            recoveryAction: null,
            sourcePresentation: {
                kind: "provider",
                provider: {
                    identity: { pluginId: "happier.provider.openai", localId: "openai" },
                    definitionRevision: 1,
                },
            },
            brokerPresentation: {
                selectedTarget: { machineId: online.id, availability: "available" },
                eligibleTargets: expect.arrayContaining([
                    { machineId: online.id, availability: "available", displayName: null },
                    { machineId: offline.id, availability: "offline", displayName: null },
                    { machineId: unsupported.id, availability: "update_required", displayName: null },
                    { machineId: updateRequired.id, availability: "update_required", displayName: null },
                ]),
            },
        });
        expect(projected.brokerPresentation.eligibleTargets).toHaveLength(4);
        expect(projected.brokerPresentation.eligibleTargets).not.toContainEqual(expect.objectContaining({ machineId: ephemeral.id }));

        const managerList = await post("/v1/teams/credential-resources/list", manager.id, { teamId: team.id });
        expect(managerList.statusCode, managerList.body).toBe(200);
        expect(managerList.json().resources.find((candidate: { id: string }) => candidate.id === resource.id)).toMatchObject({
            source: null,
            brokerPlacement: null,
            readiness: { kind: "available" },
            recoveryAction: null,
            sourcePresentation: {
                kind: "provider",
                provider: { identity: { pluginId: "happier.provider.openai", localId: "openai" } },
            },
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [],
                selectedPool: null,
                eligiblePools: [],
            },
        });
        expect(managerList.body).not.toContain(online.id);
        expect(managerList.body).not.toContain(source.connectionId);
        expect(managerList.body).not.toContain(source.connectionSecurityFingerprint);

        const got = await post("/v1/teams/credential-resources/get", custodian.id, { resourceId: resource.id });
        expect(got.statusCode, got.body).toBe(200);
        expect(got.json()).toMatchObject({
            readiness: { kind: "available" },
            brokerPresentation: { selectedTarget: { machineId: online.id, availability: "available" } },
        });

        const changed = await post("/v1/teams/credential-resources/update", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            displayName: "Exact Provider updated",
        });
        expect(changed.statusCode, changed.body).toBe(200);
        // A display-name edit carries no authority: the revision every durable
        // Session binding and signed broker open compares must not move, so a
        // rename never invalidates a colleague's live selection.
        expect(changed.json()).toEqual({ resourceId: resource.id, revision: resource.revision });
        const changedDetail = await post("/v1/teams/credential-resources/get", custodian.id, { resourceId: resource.id });
        expect(changedDetail.statusCode, changedDetail.body).toBe(200);
        expect(changedDetail.json()).toMatchObject({
            displayName: "Exact Provider updated",
            readiness: { kind: "available" },
            brokerPresentation: { selectedTarget: { machineId: online.id, availability: "available" } },
        });

        for (const driftedConnections of [
            [{ ...providerConnection, teamCredentialSourceOffer: {
                ...providerConnection.teamCredentialSourceOffer,
                connectionSecurityFingerprint: `connection-security:v1:${"d".repeat(43)}`,
            } }],
            [{ ...providerConnection, teamCredentialSourceOffer: {
                ...providerConnection.teamCredentialSourceOffer,
                credentialSlotId: "otherSlot",
            } }],
            [],
        ]) {
            describedConnections = driftedConnections;
            const drifted = await post("/v1/teams/credential-resources/get", custodian.id, { resourceId: resource.id });
            expect(drifted.statusCode, drifted.body).toBe(200);
            expect(drifted.json()).toMatchObject({
                readiness: { kind: "source_unavailable" },
                recoveryAction: "source_owner_action",
                sourcePresentation: null,
            });
        }
        const managerRecovery = await post("/v1/teams/credential-resources/get", manager.id, { resourceId: resource.id });
        expect(managerRecovery.statusCode, managerRecovery.body).toBe(200);
        expect(managerRecovery.json()).toMatchObject({
            source: null,
            brokerPlacement: null,
            readiness: { kind: "source_unavailable" },
            recoveryAction: "source_owner_action",
            sourcePresentation: null,
        });
        expect(managerRecovery.body).not.toContain(online.id);
        expect(managerRecovery.body).not.toContain(source.connectionId);
        expect(managerRecovery.body).not.toContain(source.connectionSecurityFingerprint);
        describedConnections = [providerConnection];

        const movedOffline = await post("/v1/teams/credential-resources/update", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            brokerPlacement: { kind: "machine", machineId: offline.id },
        });
        expect(movedOffline.statusCode, movedOffline.body).toBe(200);
        // Moving the broker location IS an authority change, so this one advances.
        expect(movedOffline.json()).toEqual({ resourceId: resource.id, revision: resource.revision + 1 });
        const movedOfflineDetail = await post("/v1/teams/credential-resources/get", custodian.id, { resourceId: resource.id });
        expect(movedOfflineDetail.statusCode, movedOfflineDetail.body).toBe(200);
        expect(movedOfflineDetail.json()).toMatchObject({
            readiness: { kind: "broker_unavailable" },
            recoveryAction: "retry",
            brokerPresentation: { selectedTarget: { machineId: offline.id, availability: "offline" } },
        });
        const unsupportedSave = await post("/v1/teams/credential-resources/update", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision + 1,
            brokerPlacement: { kind: "machine", machineId: unsupported.id },
        });
        expect(unsupportedSave.statusCode, unsupportedSave.body).toBe(400);
        expect(unsupportedSave.json()).toEqual({ error: "update_required" });
        const ephemeralSave = await post("/v1/teams/credential-resources/update", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision + 1,
            brokerPlacement: { kind: "machine", machineId: ephemeral.id },
        });
        expect(ephemeralSave.statusCode, ephemeralSave.body).toBe(400);
        expect(ephemeralSave.json()).toEqual({ error: "broker_unavailable" });
    });

    it("atomically switches broker placement between an exact Machine and an owned Machine Pool", async () => {
        const custodian = await createAccount();
        const team = await db.team.create({ data: { name: "Pool placement" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "admin" } });
        const machine = await db.machine.create({ data: {
            id: `pool-placement-machine-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const pool = await db.machinePool.create({ data: {
            id: `pool-placement-${custodian.id}`,
            accountId: custodian.id,
            name: "Broker pool",
            members: { create: { machineId: machine.id, priorityTier: 0, enabled: true } },
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            id: `pool-placement-resource-${custodian.id}`,
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Pool source",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1, kind: "provider_connection", connectionId: "connection-1",
                connectionSecurityFingerprint: "connection-security:v1:test", credentialSlotId: "api-key",
            }),
            brokerMachineId: machine.id,
        } });

        const toPool = await post("/v1/teams/credential-resources/update", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            brokerPlacement: { kind: "machine_pool", poolId: pool.id },
        });
        expect(toPool.statusCode, toPool.body).toBe(200);
        expect(toPool.json()).toEqual({ resourceId: resource.id, revision: resource.revision + 1 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id }, select: {
            brokerMachineId: true, brokerPoolId: true,
        } })).resolves.toEqual({ brokerMachineId: null, brokerPoolId: pool.id });

        const toMachine = await post("/v1/teams/credential-resources/update", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision + 1,
            brokerPlacement: { kind: "machine", machineId: machine.id },
        });
        expect(toMachine.statusCode, toMachine.body).toBe(200);
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id }, select: {
            brokerMachineId: true, brokerPoolId: true,
        } })).resolves.toEqual({ brokerMachineId: machine.id, brokerPoolId: null });
    });

    it("projects current direct-only provider models without treating broker placement as universal", async () => {
        const custodian = await createAccount();
        const recipient = await createAccount();
        const team = await db.team.create({ data: { name: "Direct-only catalog" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const recipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const application = {
            agentTargetKey: "agent:happier.agent.codex/codex",
            implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
            endpointTemplateId: "responses",
            protocol: "openai-responses",
        } as const;
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "direct-only-connection" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"a".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const sourceMember = {
            kind: "provider_credential_slot" as const,
            connectionId: source.connectionId,
            credentialSlotId: source.credentialSlotId,
        };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const sourceVersion = "direct-source-v1";
        const directResource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Direct provider",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: sourceVersion }),
            memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: "direct" } },
        } });
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: directResource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            storedMaterial: Buffer.from(JSON.stringify(createTeamCredentialDirectMaterialStoredV1({
                recipientMode: "plain",
                payload: {
                    v: 1,
                    domain: "happier.team-credential-direct-material",
                    homeServerIdentityId: "home",
                    teamId: team.id,
                    resourceId: directResource.id,
                    resourceRevision: directResource.revision,
                    recipientAccountId: recipient.id,
                    sourceMember,
                    sourceVersion,
                    material: {
                        kind: "provider_api_key",
                        value: "direct-secret",
                        runtimeBinding: {
                            provider: { identity: application.implementationIdentity, definitionRevision: 1 },
                            endpoint: {
                                endpointTemplateId: "responses",
                                normalizedUrl: "https://api.example.test/v1",
                                protocol: "openai-responses",
                                publicHeaders: {},
                            },
                            credentialTransport: {
                                id: "api-key",
                                protocols: ["openai-responses"],
                                uses: ["runtime"],
                                destination: { kind: "httpHeader", name: "Authorization", format: "bearer" },
                            },
                        },
                    },
                },
            }))),
        } });
        const broker = await db.machine.create({ data: {
            id: `combined-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const combinedResource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Combined provider",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: sourceVersion }),
            brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: "both" } },
        } });
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: combinedResource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            storedMaterial: Buffer.from(JSON.stringify(createTeamCredentialDirectMaterialStoredV1({
                recipientMode: "plain",
                payload: {
                    v: 1,
                    domain: "happier.team-credential-direct-material",
                    homeServerIdentityId: "home",
                    teamId: team.id,
                    resourceId: combinedResource.id,
                    resourceRevision: combinedResource.revision,
                    recipientAccountId: recipient.id,
                    sourceMember,
                    sourceVersion,
                    material: {
                        kind: "provider_api_key",
                        value: "combined-secret",
                        runtimeBinding: {
                            provider: { identity: application.implementationIdentity, definitionRevision: 1 },
                            endpoint: {
                                endpointTemplateId: "responses",
                                normalizedUrl: "https://api.example.test/v1",
                                protocol: "openai-responses",
                                publicHeaders: {},
                            },
                            credentialTransport: {
                                id: "api-key",
                                protocols: ["openai-responses"],
                                uses: ["runtime"],
                                destination: { kind: "httpHeader", name: "Authorization", format: "bearer" },
                            },
                        },
                    },
                },
            }))),
        } });
        const brokerlessResource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Broken broker-only provider",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ ...source, connectionId: "broker-only-connection" }),
            memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: "brokered" } },
        } });

        const sourceProjectionMachineId = `source-projection-${custodian.id}`;
        const rpc = vi.fn(async (_input: Parameters<typeof app.forwardRpcForUser>[0]) => ({
            ok: true as const,
            result: {
                status: "success" as const,
                agentTargetKey: application.agentTargetKey,
                groups: [{
                    connectionId: source.connectionId,
                    providerName: "OpenAI",
                    connectionName: "Work",
                    connectionRole: "named" as const,
                    connectionDisplayNameMode: "custom" as const,
                    connectionRevision: 1,
                    sourceAuthority: {
                        provider: { identity: application.implementationIdentity, definitionRevision: 1 },
                        connectionSecurityFingerprint: source.connectionSecurityFingerprint,
                    },
                    sourceRevision: sourceVersion,
                    modelLoadAction: "available" as const,
                    modelLoadPreflightPolicy: null,
                    authorization: { authorized: true as const },
                    manualModelPolicy: "allowed" as const,
                    supportsFreeformModelIds: false,
                    suppressedConnectedServiceIds: [],
                    rows: [{
                        ref: {
                            agentTargetKey: application.agentTargetKey,
                            providerConnectionId: source.connectionId,
                            modelId: "gpt-5",
                        },
                        descriptor: { id: "gpt-5", name: "GPT-5" },
                        application,
                        directMaterialization: {
                            endpoint: {
                                endpointTemplateId: "responses",
                                normalizedUrl: "https://api.example.test/v1",
                                protocol: "openai-responses" as const,
                                publicHeaders: {},
                            },
                            credentialTransport: {
                                id: "api-key",
                                protocols: ["openai-responses" as const],
                                uses: ["runtime" as const],
                                destination: { kind: "httpHeader" as const, name: "Authorization", format: "bearer" as const },
                            },
                        },
                        sources: { manual: false, static: true, probe: false },
                        confidence: "verified_static" as const,
                        compatibility: {
                            result: {
                                status: "verified" as const,
                                selectedProtocol: "openai-responses" as const,
                                evidence: { sourceUrls: ["https://docs.example.test/openai"], verifiedAt: "2026-09-11" },
                            },
                            compatibilityFingerprint: "compatibility:v1:current",
                            confirmed: false,
                        },
                        endpointHealth: "not_checked" as const,
                        catalog: { stale: false },
                        loadState: "unknown" as const,
                        visibility: "visible" as const,
                    }],
                }],
            },
        }));
        app.forwardRpcForUser = rpc;
        app.machineDaemonPresence = {
            in: (room: string) => ({
                fetchSockets: async () => room === `user:${custodian.id}`
                    ? [{ data: { clientType: "machine-scoped", userId: custodian.id, machineId: sourceProjectionMachineId } }]
                    : [],
            }),
        };

        const response = await post("/v1/teams/credential-resources/entitled/list", recipient.id, {
            teamId: team.id,
            application,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().resources.find((resource: { id: string }) => resource.id === directResource.id)).toMatchObject({
            readiness: { kind: "available" },
            mayBroker: false,
            mayReceiveDirect: true,
            directMaterialState: "current",
            providerModels: [{
                selection: { kind: "team_credential_provider_model", modelId: "gpt-5", deliveryMode: "direct" },
                availability: "available",
                direct: { sourceMemberKey, sourceVersion },
            }],
        });
        expect(response.json().resources.find((resource: { id: string }) => resource.id === brokerlessResource.id)).toMatchObject({
            readiness: { kind: "source_unavailable" },
            mayBroker: true,
            providerModels: [],
        });
        expect(response.json().resources.find((resource: { id: string }) => resource.id === combinedResource.id)).toMatchObject({
            readiness: { kind: "available" },
            mayBroker: true,
            mayReceiveDirect: true,
            providerModels: expect.arrayContaining([
                expect.objectContaining({
                    selection: expect.objectContaining({ deliveryMode: "brokered", modelId: "gpt-5" }),
                    availability: "available",
                }),
                expect.objectContaining({
                    selection: expect.objectContaining({ deliveryMode: "direct", modelId: "gpt-5" }),
                    availability: "available",
                    direct: { sourceMemberKey, sourceVersion },
                }),
            ]),
        });
        expect(response.json().resources.find((resource: { id: string }) => resource.id === combinedResource.id).providerModels)
            .toHaveLength(2);
        // The source daemon needs these fields to prepare recipient-private
        // material, but the recipient catalog is only a selection surface.
        expect(response.body).not.toContain('"normalizedUrl"');
        expect(response.body).not.toContain('"publicHeaders"');
        expect(response.body).not.toContain('"credentialTransport"');
        expect(response.body).not.toContain("https://api.example.test/v1");
        expect(response.body).not.toContain("Authorization");
        expect(rpc.mock.calls.filter(([input]) => (
            typeof input === "object"
            && input !== null
            && "method" in input
            && input.method === `${sourceProjectionMachineId}:daemon.providers.model.projection`
        // The two rows share the exact source/application/material request, so
        // page projection asks the source daemon once and reuses that result.
        ))).toHaveLength(1);
        expect(rpc.mock.calls.filter(([input]) => (
            typeof input === "object"
            && input !== null
            && "method" in input
            && input.method === `${broker.id}:daemon.providers.model.projection`
        ))).toHaveLength(1);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            userId: custodian.id,
            method: `${sourceProjectionMachineId}:daemon.providers.model.projection`,
            params: expect.objectContaining({
                machineId: sourceProjectionMachineId,
                includeDirectMaterialization: true,
            }),
        }));
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            userId: custodian.id,
            method: `${broker.id}:daemon.providers.model.projection`,
            params: expect.objectContaining({ machineId: broker.id }),
        }));
    });

    it("does not read source-custodian presence before resource Test authorization", async () => {
        const custodian = await createAccount();
        const outsider = await createAccount();
        const team = await db.team.create({ data: { name: "Private resource Test" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const broker = await db.machine.create({ data: {
            id: `private-resource-test-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Private Provider",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "private-resource-test",
                connectionSecurityFingerprint: `connection-security:v1:${"p".repeat(43)}`,
                credentialSlotId: "apiKey",
            }),
            brokerMachineId: broker.id,
        } });
        const fetchSockets = vi.fn(async () => []);
        const readPresenceRoom = vi.fn(() => ({ fetchSockets }));
        app.machineDaemonPresence = { in: readPresenceRoom };

        const missing = await post("/v1/teams/credential-resources/test", outsider.id, {
            teamId: team.id,
            resourceId: `missing-${resource.id}`,
        });
        const privateResource = await post("/v1/teams/credential-resources/test", outsider.id, {
            teamId: team.id,
            resourceId: resource.id,
        });

        expect({ status: privateResource.statusCode, body: privateResource.json() }).toEqual({
            status: missing.statusCode,
            body: missing.json(),
        });
        expect(privateResource.json()).toEqual({ error: "not_found_or_not_visible" });
        expect(readPresenceRoom).not.toHaveBeenCalled();
        expect(fetchSockets).not.toHaveBeenCalled();
    });

    it("rejects resource Test source, placement, and revision changes observed while resolving presence", async () => {
        const custodian = await createAccount();
        const team = await db.team.create({ data: { name: "Resource Test currentness" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const [brokerA, brokerB] = await Promise.all(["a", "b"].map(async suffix => await db.machine.create({ data: {
            id: `resource-test-currentness-${suffix}-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: suffix.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } })));
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "resource-test-currentness" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"c".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const application = {
            agentTargetKey: "agent:happier.agent.codex/codex",
            implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
            endpointTemplateId: "responses",
            protocol: "openai-responses",
        } as const;
        app.forwardRpcForUser = vi.fn(async (input: Readonly<{ params: unknown }>) => ({
            ok: true as const,
            result: {
                status: "success" as const,
                application,
                request: {
                    v: 1 as const,
                    kind: "resource_test" as const,
                    requestId: "resource-test-currentness",
                    teamId: team.id,
                    resourceId: (input.params as { resourceId: string }).resourceId,
                    route: "responses" as const,
                    method: "POST" as const,
                    pathAndQuery: "/v1/responses",
                    bodyBase64: "e30=",
                },
            },
        }));
        const dispatch = vi.fn(async () => ({
            ok: true as const,
            statusCode: 200,
            headers: {},
            body: (async function* () { yield new Uint8Array(); })(),
        }));
        app.forwardTeamCredentialBrokerResourceTest = dispatch;

        for (const [name, mutation] of [
            ["source", { sourceBindingJson: JSON.stringify({ ...source, credentialSlotId: "replacement" }) }],
            ["placement", { brokerMachineId: brokerB.id }],
            ["revision", { revision: { increment: 1 } }],
        ] as const) {
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id,
                custodianAccountId: custodian.id,
                displayName: `Resource Test ${name}`,
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify(source),
                brokerMachineId: brokerA.id,
            } });
            let mutated = false;
            app.machineDaemonPresence = {
                in: () => ({
                    fetchSockets: async () => {
                        if (!mutated) {
                            mutated = true;
                            await db.teamCredentialResource.update({ where: { id: resource.id }, data: mutation });
                        }
                        return [brokerA, brokerB].map(machine => ({
                            data: { clientType: "machine-scoped", userId: custodian.id, machineId: machine.id },
                        }));
                    },
                }),
            };

            const response = await post("/v1/teams/credential-resources/test", custodian.id, {
                teamId: team.id,
                resourceId: resource.id,
            });

            expect({ name, status: response.statusCode, body: response.json() }).toEqual({
                name,
                status: 409,
                body: { error: "resource_changed" },
            });
        }
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("uses current-only Pool projections for one roster-free model row and canonically pins resource Test", async () => {
        const custodian = await createAccount();
        const recipient = await createAccount();
        const manager = await createAccount();
        const team = await db.team.create({ data: { name: "Pool model catalog and Test" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "admin" } });
        const recipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const [machineA, machineB] = await Promise.all(["a", "b"].map(async suffix => await db.machine.create({ data: {
            id: `pool-catalog-${suffix}-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } })));
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: custodian.id,
            name: "Catalog Pool",
            members: { create: [
                { machineId: machineA.id, priorityTier: 0, enabled: true },
                { machineId: machineB.id, priorityTier: 1, enabled: true },
            ] },
        } });
        const unavailablePool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: custodian.id,
            name: "Unavailable Pool",
            members: { create: { machineId: machineA.id, priorityTier: 0, enabled: true } },
        } });
        const application = {
            agentTargetKey: "agent:happier.agent.codex/codex",
            implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
            endpointTemplateId: "responses",
            protocol: "openai-responses",
        } as const;
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "pool-catalog-connection" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"b".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Pool provider",
            enabled: true,
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            brokerPoolId: pool.id,
            memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: "brokered" } },
        } });
        app.machineDaemonPresence = {
            in: (room: string) => ({
                fetchSockets: async () => room === `user:${custodian.id}`
                    ? [machineA, machineB].map(machine => ({
                        data: { clientType: "machine-scoped", userId: custodian.id, machineId: machine.id },
                    }))
                    : [],
            }),
        };
        const forwardRpcForUser = vi.fn(async (input: Readonly<{ method: string; params: unknown }>) => {
            const machineId = input.method.split(":", 1)[0]!;
            if (input.method.endsWith("daemon.providers.teamCredentialResourceTest.candidate")) {
                return machineId === machineB.id
                    ? { ok: true as const, result: {
                        status: "success" as const,
                        application,
                        request: {
                            v: 1 as const,
                            kind: "resource_test" as const,
                            requestId: "pool-resource-test",
                            teamId: team.id,
                            resourceId: resource.id,
                            route: "responses" as const,
                            method: "POST" as const,
                            pathAndQuery: "/v1/responses",
                            bodyBase64: "e30=",
                        },
                    } }
                    : { ok: true as const, result: { status: "unavailable" as const, reason: "model_unavailable" as const } };
            }
            if (input.method.endsWith("daemon.providers.teamCredentialBroker.eligibility")) {
                return machineId === machineB.id
                    ? { ok: true as const, result: { status: "eligible" as const } }
                    : { ok: true as const, result: { status: "unavailable" as const, reason: "model_unavailable" as const } };
            }
            return { ok: true as const, result: {
                status: "success" as const,
                agentTargetKey: application.agentTargetKey,
                groups: [{
                    connectionId: source.connectionId,
                    providerName: "OpenAI",
                    connectionName: "Pool",
                    connectionRole: "named" as const,
                    connectionDisplayNameMode: "custom" as const,
                    connectionRevision: 1,
                    sourceAuthority: {
                        provider: { identity: application.implementationIdentity, definitionRevision: 1 as const },
                        connectionSecurityFingerprint: source.connectionSecurityFingerprint,
                    },
                    sourceRevision: machineId === machineA.id ? "pool-source-revision-a" : "pool-source-revision-b",
                    modelLoadAction: "available" as const,
                    modelLoadPreflightPolicy: null,
                    authorization: { authorized: true as const },
                    manualModelPolicy: "allowed" as const,
                    supportsFreeformModelIds: false,
                    suppressedConnectedServiceIds: [],
                    rows: [{
                        ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: source.connectionId, modelId: "gpt-5" },
                        descriptor: { id: "gpt-5", name: machineId === machineA.id ? "GPT-5 A" : "GPT-5 B" },
                        application,
                        sources: { manual: false, static: true, probe: false },
                        confidence: "verified_static" as const,
                        compatibility: {
                            result: {
                                status: "verified" as const,
                                selectedProtocol: "openai-responses" as const,
                                evidence: { sourceUrls: ["https://docs.example.test/openai"], verifiedAt: "2026-09-11" },
                            },
                            compatibilityFingerprint: "compatibility:v1:pool-current",
                            confirmed: false,
                        },
                        endpointHealth: "not_checked" as const,
                        catalog: { stale: false },
                        loadState: "unknown" as const,
                        visibility: "visible" as const,
                    }],
                }],
            } };
        });
        app.forwardRpcForUser = forwardRpcForUser;
        const dispatch = vi.fn(async () => ({
            ok: true as const,
            statusCode: 200,
            headers: {},
            body: (async function* () { yield new Uint8Array(); })(),
        }));
        app.forwardTeamCredentialBrokerResourceTest = dispatch;

        const ownerResources = await post("/v1/teams/credential-resources/list", custodian.id, { teamId: team.id });
        expect(ownerResources.statusCode, ownerResources.body).toBe(200);
        expect(ownerResources.json().resources.find((candidate: { id: string }) => candidate.id === resource.id)).toMatchObject({
            brokerPlacement: { kind: "machine_pool", poolId: pool.id },
            brokerPresentation: {
                selectedPool: {
                    poolId: pool.id,
                    availability: "available",
                    availableMachineCount: 1,
                },
                eligiblePools: expect.arrayContaining([{
                    poolId: pool.id,
                    displayName: "Catalog Pool",
                    availability: "available",
                    availableMachineCount: 1,
                }, {
                    poolId: unavailablePool.id,
                    displayName: "Unavailable Pool",
                    availability: "unavailable",
                    availableMachineCount: 0,
                }]),
            },
        });
        const managerResources = await post("/v1/teams/credential-resources/list", manager.id, { teamId: team.id });
        expect(managerResources.statusCode, managerResources.body).toBe(200);
        expect(managerResources.json().resources.find((candidate: { id: string }) => candidate.id === resource.id)).toMatchObject({
            source: null,
            brokerPlacement: null,
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [],
                selectedPool: null,
                eligiblePools: [],
            },
        });
        expect(managerResources.body).not.toContain(pool.id);
        expect(managerResources.body).not.toContain(unavailablePool.id);
        expect(managerResources.body).not.toContain(machineA.id);
        expect(managerResources.body).not.toContain(machineB.id);
        const availabilityCalls = forwardRpcForUser.mock.calls.filter(([input]) => (
            input.method.endsWith("daemon.providers.teamCredentialBroker.eligibility")
        ));
        // Each administration request asks each exact Machine once for this
        // immutable source, even though both Pools contain machine A and the
        // selected Pool is inspected again while projecting readiness. The
        // second pair is the manager request above, not resource×Pool work.
        expect(availabilityCalls).toHaveLength(4);
        expect(availabilityCalls.map(([input]) => {
            const params = input.params as Record<string, unknown>;
            return params.machineId;
        }).sort()).toEqual([
            machineA.id,
            machineA.id,
            machineB.id,
            machineB.id,
        ].sort());
        expect(availabilityCalls.every(([input]) => {
            const params = input.params as Record<string, unknown>;
            return params.scope === "source_any"
                && !("application" in params)
                && !("modelId" in params)
                && !("sourceRevision" in params);
        })).toBe(true);
        forwardRpcForUser.mockClear();

        const catalog = await post("/v1/teams/credential-resources/entitled/list", recipient.id, {
            teamId: team.id,
            application,
        });
        expect(catalog.statusCode, catalog.body).toBe(200);
        const projected = catalog.json().resources.find((candidate: { id: string }) => candidate.id === resource.id);
        expect(projected.providerModels).toHaveLength(1);
        expect(projected.providerModels[0]).toMatchObject({
            selection: { modelId: "gpt-5" },
            sourceRevision: "pool-source-revision-a",
            descriptor: { name: "GPT-5 A" },
        });
        expect(catalog.body).not.toContain(pool.id);
        expect(catalog.body).not.toContain(machineA.id);
        expect(catalog.body).not.toContain(machineB.id);
        const projectionCalls = forwardRpcForUser.mock.calls.filter(([input]) => (
            input.method.endsWith("daemon.providers.model.projection")
        ));
        expect(projectionCalls).toHaveLength(2);
        expect(projectionCalls.every(([input]) => (
            (input.params as { refreshPolicy?: string }).refreshPolicy === "current_only"
        ))).toBe(true);

        const test = await post("/v1/teams/credential-resources/test", custodian.id, {
            teamId: team.id,
            resourceId: resource.id,
        });
        expect(test.statusCode, test.body).toBe(200);
        expect(test.json()).toMatchObject({ result: "available", readiness: { kind: "available" } });
        const candidateCalls = forwardRpcForUser.mock.calls.filter(([input]) => (
            input.method.endsWith("daemon.providers.teamCredentialResourceTest.candidate")
        ));
        expect(candidateCalls).toHaveLength(2);
        expect(candidateCalls.every(([input]) => (
            (input.params as { refreshPolicy?: string }).refreshPolicy === "current_only"
        ))).toBe(true);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ brokerMachineId: machineB.id }));
    });

    it("qualifies restricted-Team activity reads and limit mutations before effects", async () => {
        const manager = await createAccount();
        const custodian = await createAccount();
        await enrollEmailPassword(manager.id);
        const team = await db.team.create({ data: {
            name: "Restricted credential operations",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            },
        } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: manager.id, role: "admin" },
            { teamId: team.id, accountId: custodian.id, role: "member" },
        ] });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Restricted source",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: "{}",
            allMembersDeliveryMode: "brokered",
        } });

        const activity = await post("/v1/teams/credential-resources/activity/list", manager.id, {
            resourceId: resource.id,
        });
        expect({ status: activity.statusCode, body: activity.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const upsert = await post("/v1/teams/credential-resources/limits/upsert", manager.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            limit: {
                subjectKind: "resource",
                subjectId: "",
                period: "day",
                metric: "inference_requests",
                maximum: "1",
                enabled: true,
            },
        });
        expect({ status: upsert.statusCode, body: upsert.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        expect(await db.teamCredentialUsageLimit.count({ where: { resourceId: resource.id } })).toBe(0);
        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).revision).toBe(0);
        const evidence = [{ kind: "home_method", methodId: "email_password" }] as const;
        const qualifiedActivity = await post(
            "/v1/teams/credential-resources/activity/list",
            manager.id,
            { resourceId: resource.id },
            evidence,
        );
        expect(qualifiedActivity.statusCode, qualifiedActivity.body).toBe(200);
        const qualifiedUpsert = await post(
            "/v1/teams/credential-resources/limits/upsert",
            manager.id,
            {
                resourceId: resource.id,
                expectedRevision: resource.revision,
                limit: {
                    subjectKind: "resource",
                    subjectId: "",
                    period: "day",
                    metric: "inference_requests",
                    maximum: "1",
                    enabled: true,
                },
            },
            evidence,
        );
        expect(qualifiedUpsert.statusCode, qualifiedUpsert.body).toBe(200);
        expect(await db.teamCredentialUsageLimit.count({ where: { resourceId: resource.id } })).toBe(1);
        expect((await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).revision).toBe(1);

        const broker = await db.machine.create({ data: {
            id: `restricted-resource-test-${custodian.id}`,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            active: true,
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: "e".repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const source = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "restricted-resource-test" as ProviderConnectionId,
            connectionSecurityFingerprint: `connection-security:v1:${"e".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const application = {
            agentTargetKey: "agent:happier.agent.codex/codex",
            implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
            endpointTemplateId: "responses",
            protocol: "openai-responses",
        } as const;
        const currentResource = await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { sourceBindingJson: JSON.stringify(source), brokerMachineId: broker.id },
        });
        app.machineDaemonPresence = { in: () => ({ fetchSockets: async () => [{
            data: { clientType: "machine-scoped", userId: custodian.id, machineId: broker.id },
        }] }) };
        app.forwardRpcForUser = vi.fn(async () => ({ ok: true as const, result: {
            status: "success" as const,
            application,
            request: {
                v: 1 as const,
                kind: "resource_test" as const,
                requestId: "restricted-resource-test-request",
                teamId: team.id,
                resourceId: resource.id,
                route: "responses" as const,
                method: "POST" as const,
                pathAndQuery: "/v1/responses",
                bodyBase64: "e30=",
            },
        } }));
        const dispatch = vi.fn(async () => ({
            ok: true as const,
            statusCode: 200,
            headers: {},
            body: (async function* () { yield new Uint8Array(); })(),
        }));
        app.forwardTeamCredentialBrokerResourceTest = dispatch;

        const unqualifiedTest = await post("/v1/teams/credential-resources/test", manager.id, {
            teamId: team.id,
            resourceId: resource.id,
        });
        expect({ status: unqualifiedTest.statusCode, body: unqualifiedTest.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        expect(dispatch).not.toHaveBeenCalled();
        const qualifiedTest = await post(
            "/v1/teams/credential-resources/test",
            manager.id,
            { teamId: team.id, resourceId: resource.id },
            evidence,
        );
        expect(qualifiedTest.statusCode, qualifiedTest.body).toBe(200);
        expect(qualifiedTest.json()).toMatchObject({ result: "available", readiness: { kind: "available" } });
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            actorAccountId: manager.id,
            resourceId: resource.id,
            expectedResourceRevision: currentResource.revision,
            brokerMachineId: broker.id,
            application,
            source,
            verifiedCredentialEvidence: evidence,
        }));
        await db.teamMembership.delete({ where: {
            teamId_accountId: { teamId: team.id, accountId: custodian.id },
        } });
        const departedSourceOwnerTest = await post(
            "/v1/teams/credential-resources/test",
            custodian.id,
            { teamId: team.id, resourceId: resource.id },
        );
        expect(departedSourceOwnerTest.statusCode, departedSourceOwnerTest.body).toBe(200);
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
            actorAccountId: custodian.id,
            verifiedCredentialEvidence: undefined,
        }));
        const unrelated = await createAccount();
        const unrelatedTest = await post(
            "/v1/teams/credential-resources/test",
            unrelated.id,
            { teamId: team.id, resourceId: resource.id },
        );
        expect(unrelatedTest.statusCode, unrelatedTest.body).toBe(404);
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it("qualifies every restricted-Team resource administration route before reads or effects", async () => {
        const manager = await createAccount();
        const custodian = await createAccount();
        const recipient = await createAccount();
        const unrelatedMember = await createAccount();
        await enrollEmailPassword(recipient.id);
        const team = await db.team.create({ data: {
            name: "Restricted credential route census",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            },
        } });
        const [, recipientMembership] = await Promise.all([
            db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "admin" } }),
            db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } }),
            db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "member" } }),
            db.teamMembership.create({ data: { teamId: team.id, accountId: unrelatedMember.id, role: "member" } }),
        ]);
        const service = { pluginId: "route.qualification", localId: "source" };
        const groupId = "qualification-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: custodian.id,
            groupId,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            policyJson: "{}",
        } });
        const source = {
            v: 1,
            kind: "connected_pool",
            target: { kind: "group", service, groupId },
            poolIncarnation: pool.id,
        } as const;
        const privateBrokerMachineId = `private-broker-${custodian.id}`;
        await db.machine.create({ data: {
            id: privateBrokerMachineId,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Protected resource",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            brokerMachineId: privateBrokerMachineId,
            memberGrants: { create: {
                teamMembershipId: recipientMembership.id,
                deliveryMode: "both",
            } },
        } });
        const limit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: resource.id,
            subjectKind: "resource",
            subjectId: "",
            period: "day",
            metric: "inference_requests",
            maximum: "10",
            enabled: true,
        } });
        const externalKey = await db.teamCredentialExternalApiKey.create({ data: {
            resourceId: resource.id,
            teamMembershipId: recipientMembership.id,
            label: "Existing key",
            displayPrefix: "hapek_v1_existing",
            secretDigest: "sha256:existing",
        } });
        const directPurpose = {
            consumer: { pluginId: "example.agent", localId: "runtime" },
            purpose: "model-request",
        } as const;
        const directSession = await db.session.create({ data: {
            accountId: recipient.id,
            tag: `restricted-direct-${crypto.randomUUID()}`,
            metadata: "{}",
            encryptionMode: "plain",
            currentStorageState: "hosted",
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
            agentState: null,
            active: true,
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: directSession.id,
            slotKind: "connected_service_purpose:direct",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({
                kind: "connected_service_purpose", purpose: directPurpose,
            })),
            resourceId: resource.id,
            resourceRevision: resource.revision,
        } });
        const directMaterialRequest = {
            resourceId: resource.id,
            consumer: { kind: "session" as const, sessionId: directSession.id },
            slot: { kind: "connected_service_purpose" as const, purpose: directPurpose },
            disclosedMember: { service, accountId: "missing-material" },
        };

        const deniedOperations = [
            ["/v1/teams/credential-resources/list", { teamId: team.id }],
            ["/v1/teams/credential-resources/sources/list", { teamId: team.id }],
            ["/v1/teams/credential-resources/get", { resourceId: resource.id }],
            ["/v1/teams/credential-resources/test", { teamId: team.id, resourceId: resource.id }],
            ["/v1/teams/credential-resources/entitled/list", { teamId: team.id }],
            ["/v1/teams/credential-resources/activity/list", { resourceId: resource.id }],
            ["/v1/teams/credential-resources/limits/list", { resourceId: resource.id }],
            ["/v1/teams/credential-resources/limits/upsert", {
                resourceId: resource.id,
                expectedRevision: resource.revision,
                limit: { id: limit.id, subjectKind: "resource", subjectId: "", period: "day", metric: "inference_requests", maximum: "20", enabled: true },
            }],
            ["/v1/teams/credential-resources/limits/delete", { resourceId: resource.id, expectedRevision: resource.revision, limitId: limit.id }],
            ["/v1/teams/credential-resources/usage/query", { resourceId: resource.id, startMs: 0, endMs: Date.now(), granularity: "day", costMode: "auto" }],
            ["/v1/teams/credential-resources/external-keys/list", { resourceId: resource.id }],
            ["/v1/teams/credential-resources/external-keys/revoke", { resourceId: resource.id, keyId: externalKey.id }],
            ["/v1/teams/credential-resources/external-keys/revoke-all", { resourceId: resource.id }],
            ["/v1/teams/credential-resources/create", {
                teamId: team.id,
                resourceId: "denied-create",
                displayName: "Denied create",
                source,
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                brokerPlacement: { kind: "machine", machineId: privateBrokerMachineId },
                requestPolicy: null,
                allMembersDeliveryMode: null,
                groupGrants: [],
                memberGrants: [],
                usageLimits: [],
            }],
            ["/v1/teams/credential-resources/audience/set", { resourceId: resource.id, expectedRevision: resource.revision, allMembersDeliveryMode: null, groupGrants: [], memberGrants: [] }],
            ["/v1/teams/credential-resources/update", { resourceId: resource.id, expectedRevision: resource.revision, displayName: "Denied update" }],
            ["/v1/teams/credential-resources/delete", { resourceId: resource.id, expectedRevision: resource.revision }],
        ] as const;
        for (const [url, payload] of deniedOperations) {
            const response = await post(url, manager.id, payload);
            expect({ url, status: response.statusCode, body: response.json() }).toEqual({
                url,
                status: 403,
                body: { error: "team_authentication_required" },
            });
        }
        // The manager must qualify before issuing any assigned key.
        const deniedExternalKeyCreate = await post(
            "/v1/teams/credential-resources/external-keys/create",
            manager.id,
            { resourceId: resource.id, teamMembershipId: recipientMembership.id, label: "Denied key", expiresAt: null },
        );
        expect({ status: deniedExternalKeyCreate.statusCode, body: deniedExternalKeyCreate.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const deniedDirectMaterial = await post(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`,
            recipient.id,
            directMaterialRequest,
        );
        expect({ status: deniedDirectMaterial.statusCode, body: deniedDirectMaterial.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const qualifiedDirectMaterial = await post(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`,
            recipient.id,
            directMaterialRequest,
            [{ kind: "home_method", methodId: "email_password" }],
        );
        expect({ status: qualifiedDirectMaterial.statusCode, body: qualifiedDirectMaterial.json() }).toEqual({
            status: 200,
            body: { status: "unavailable", reason: "source_changed" },
        });

        expect(await db.teamCredentialResource.count({ where: { teamId: team.id } })).toBe(1);
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } })).toMatchObject({
            revision: resource.revision,
            displayName: resource.displayName,
            allMembersDeliveryMode: resource.allMembersDeliveryMode,
        });
        expect(await db.teamCredentialUsageLimit.findUniqueOrThrow({ where: { id: limit.id } })).toMatchObject({ maximum: "10" });
        expect(await db.teamCredentialExternalApiKey.findUnique({ where: { id: externalKey.id } })).not.toBeNull();

        for (const [url, payload] of [
            ["/v1/teams/credential-resources/limits/list", { resourceId: resource.id }],
            ["/v1/teams/credential-resources/usage/query", { resourceId: resource.id, startMs: 0, endMs: Date.now(), granularity: "day", costMode: "auto" }],
        ] as const) {
            const response = await post(url, unrelatedMember.id, payload);
            expect({ url, status: response.statusCode, body: response.json() }).toEqual({
                url,
                status: 404,
                body: { error: "not_found_or_not_visible" },
            });
        }
    });

    it("returns typed operation-scoped unavailability before looking up a resource", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "0" });
        try {
            const response = await post("/v1/teams/credential-resources/get", "missing-actor", {
                resourceId: "missing-resource",
            });
            expect({ status: response.statusCode, body: response.json() }).toEqual({
                status: 503,
                body: { error: "feature_disabled" },
            });
        } finally {
            harness.resetEnv({ HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1" });
        }
    });

    it("answers a disabled external-API gate with the same typed credential refusal its routes declare", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "0" });
        try {
            const response = await post("/v1/teams/credential-resources/external-keys/list", "missing-actor", {
                resourceId: "missing-resource",
            });
            // The external-key routes declare the strict Team credential error
            // envelope at every failure status, so the gate's disabled answer must
            // be a member of that same vocabulary — the generic `{ error:
            // "not_found" }` default is not a TeamCredentialErrorCodeV1 and a
            // client decoding the refusal would meet a body its schema rejects.
            expect({ status: response.statusCode, body: response.json() }).toEqual({
                status: 503,
                body: { error: "feature_disabled" },
            });
            expect(TeamCredentialResourceErrorV1Schema.safeParse(response.json()).success).toBe(true);
        } finally {
            harness.resetEnv({ HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1" });
        }
    });

    it("refuses external-key administration when the child bit is on without public HTTPS readiness", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
            HAPPIER_PUBLIC_SERVER_URL: "http://home.example.test",
        });
        try {
            const response = await post("/v1/teams/credential-resources/external-keys/list", "missing-actor", {
                resourceId: "missing-resource",
            });
            expect({ status: response.statusCode, body: response.json() }).toEqual({
                status: 503,
                body: { error: "feature_disabled" },
            });
        } finally {
            harness.resetEnv({ HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" });
        }
    });

    it("returns administration and recipient-safe catalog projections from the same current authority", async () => {
        const custodian = await createAccount();
        const manager = await createAccount();
        const recipient = await createAccount();
        const unrelated = await createAccount();
        const exactGuest = await createAccount();
        await enrollEmailPassword(recipient.id);
        const team = await db.team.create({ data: { name: "Credential route authority" } });
        const custodianMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: custodian.id, role: "member" },
        });
        const managerMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: manager.id, role: "admin" },
        });
        const recipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const exactGuestMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: exactGuest.id, role: "guest" },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: unrelated.id, role: "member" },
        });
        const groupRecipient = await createAccount();
        const groupRecipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: groupRecipient.id, role: "member" },
        });
        const directGroup = await db.teamGroup.create({ data: {
            teamId: team.id, name: "Direct group", nameKey: "direct-group",
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id,
            teamGroupId: directGroup.id,
            teamMembershipId: groupRecipientMembership.id,
            nativeContribution: true,
        } });
        const service = { pluginId: "route.catalog", localId: "source" };
        const groupId = "catalog-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: custodian.id,
            groupId,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            policyJson: "{}",
        } });
        const source = {
            v: 1,
            kind: "connected_pool",
            target: { kind: "group", service, groupId },
            poolIncarnation: pool.id,
        } as const;
        const privateBrokerMachineId = `private-broker-${custodian.id}`;
        await db.machine.create({ data: {
            id: privateBrokerMachineId,
            accountId: custodian.id,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            id: "catalog-current-resource",
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Current shared source",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            directSourceVersionsJson: "{}",
            brokerMachineId: privateBrokerMachineId,
            groupGrants: { create: { teamGroupId: directGroup.id, deliveryMode: "direct" } },
            memberGrants: { create: [
                { teamMembershipId: custodianMembership.id, deliveryMode: "direct" },
                { teamMembershipId: managerMembership.id, deliveryMode: "direct" },
                { teamMembershipId: recipientMembership.id, deliveryMode: "direct" },
                { teamMembershipId: exactGuestMembership.id, deliveryMode: "direct" },
            ] },
        } });
        await db.teamCredentialResource.create({ data: {
            id: "catalog-corrupt-resource",
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Corrupt sibling",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            memberGrants: { create: {
                teamMembershipId: recipientMembership.id,
                deliveryMode: "not-a-delivery-mode",
            } },
        } });

        const projected = await inTx(tx => projectTeamCredentialResourceSummaryInTx(tx, resource.id, custodian.id));
        if (!projected.ok) throw new Error(JSON.stringify(projected));
        const managerPage = await post("/v1/teams/credential-resources/list", manager.id, { teamId: team.id });
        expect(managerPage.statusCode, managerPage.body).toBe(200);
        expect(managerPage.json().resources.map((item: { id: string }) => item.id)).toContain(resource.id);
        expect(managerPage.json().resources).toContainEqual(expect.objectContaining({
            id: "catalog-corrupt-resource",
            readiness: { kind: "resource_corrupt" },
        }));
        expect(managerPage.json().resources.find((item: { id: string }) => item.id === resource.id)).toMatchObject({
            source: null,
            brokerPlacement: null,
            brokerPresentation: { selectedTarget: null, eligibleTargets: [] },
            sourcePresentation: { kind: "connected_service", service },
            groupGrants: [{ teamGroupId: directGroup.id, deliveryMode: "direct" }],
            memberGrants: expect.arrayContaining([
                { teamMembershipId: custodianMembership.id, deliveryMode: "direct" },
                { teamMembershipId: recipientMembership.id, deliveryMode: "direct" },
                { teamMembershipId: exactGuestMembership.id, deliveryMode: "direct" },
            ]),
        });
        expect(managerPage.body).not.toContain(groupId);
        expect(managerPage.body).not.toContain(pool.id);
        expect(managerPage.body).not.toContain(privateBrokerMachineId);
        const managerCatalog = await post("/v1/teams/credential-resources/entitled/list", manager.id, { teamId: team.id });
        expect(managerCatalog.statusCode, managerCatalog.body).toBe(200);
        expect(managerCatalog.json().resources).toContainEqual(expect.objectContaining({
            id: resource.id,
            readiness: { kind: "available" },
            mayReceiveDirect: true,
        }));

        const custodianPage = await post("/v1/teams/credential-resources/list", custodian.id, { teamId: team.id });
        expect(custodianPage.statusCode, custodianPage.body).toBe(200);
        expect(custodianPage.json().resources.map((item: { id: string }) => item.id)).toContain(resource.id);
        expect(custodianPage.json().resources.find((item: { id: string }) => item.id === resource.id)).toMatchObject({
            source,
            brokerPlacement: { kind: "machine", machineId: privateBrokerMachineId },
            brokerPresentation: {
                selectedTarget: { machineId: privateBrokerMachineId },
            },
            sourcePresentation: { kind: "connected_service", service },
        });
        const custodianCatalog = await post("/v1/teams/credential-resources/entitled/list", custodian.id, { teamId: team.id });
        expect(custodianCatalog.statusCode, custodianCatalog.body).toBe(200);
        expect(custodianCatalog.json().resources).toContainEqual(expect.objectContaining({
            id: resource.id,
            readiness: { kind: "available" },
        }));

        const disclosedAccount = { service, accountId: "direct-member" };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: custodian.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            connectedAccountId: disclosedAccount.accountId,
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(disclosedAccount),
            authenticationModeId: "api-key",
            token: Buffer.from("source-secret-material-must-not-leak"),
            metadata: {
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision: "csr_aaaaaaaaaaaaaaaaaaaaaaaa",
                directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
                contributionContractVersion: "resource-routes-fixture-v1",
                values: { scopes: [] },
            },
        } });
        await db.connectedServiceAuthGroupMember.create({ data: {
            groupDbId: pool.id,
            accountId: custodian.id,
            credentialId: credential.id,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(disclosedAccount),
            enabled: true,
        } });
        const brokeredPoolResource = await db.teamCredentialResource.create({ data: {
            id: "catalog-brokered-pool-resource",
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Brokered pool",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source),
            brokerMachineId: privateBrokerMachineId,
            memberGrants: { create: {
                teamMembershipId: recipientMembership.id,
                deliveryMode: "brokered",
            } },
        } });
        const brokeredAccountResource = await db.teamCredentialResource.create({ data: {
            id: "catalog-brokered-account-resource",
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Brokered account",
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "connected_account",
                target: { kind: "account", account: disclosedAccount },
                credentialIncarnation: credential.id,
            }),
            brokerMachineId: privateBrokerMachineId,
            memberGrants: { create: {
                teamMembershipId: recipientMembership.id,
                deliveryMode: "brokered",
            } },
        } });
        const sourceMember = { kind: "connected_account" as const, service, connectedAccountId: disclosedAccount.accountId };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const currentSource = await inTx((tx) => resolveTeamCredentialDirectSourceCurrentnessInTx(tx, {
            custodianAccountId: custodian.id,
            source,
            sourceMemberKey,
        }));
        if (currentSource.status !== "current" || currentSource.sourceVersion === null) {
            throw new Error(`expected current direct source, received ${JSON.stringify(currentSource)}`);
        }
        const sourceVersion = currentSource.sourceVersion;
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            storedMaterial: Buffer.from("recipient-secret-material-must-not-leak"),
        } });
        // Nothing is published for direct delivery yet, so an entitled
        // recipient with no envelope is genuinely "never delivered". The same
        // recipient becomes "preparing" the moment the custodian publishes the
        // source versions below — that publication, not the envelope, is what
        // makes the material owed.
        const unpublishedGroupRecipientCatalog = await post(
            "/v1/teams/credential-resources/entitled/list",
            groupRecipient.id,
            { teamId: team.id },
        );
        expect(unpublishedGroupRecipientCatalog.statusCode, unpublishedGroupRecipientCatalog.body).toBe(200);
        expect(unpublishedGroupRecipientCatalog.json().resources).toContainEqual(expect.objectContaining({
            id: resource.id,
            mayReceiveDirect: true,
            directMaterialState: "never_delivered",
        }));

        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: sourceVersion }) },
        });

        const pagedRecipientIds: string[] = [];
        let recipientCursor: string | null = null;
        do {
            const page = await post("/v1/teams/credential-resources/entitled/list", recipient.id, {
                teamId: team.id, limit: 1, ...(recipientCursor ? { cursor: recipientCursor } : {}),
            });
            expect(page.statusCode, page.body).toBe(200);
            pagedRecipientIds.push(...page.json().resources.map((item: { id: string }) => item.id));
            recipientCursor = page.json().nextCursor;
        } while (recipientCursor);
        expect(new Set(pagedRecipientIds).size).toBe(pagedRecipientIds.length);
        const recipientPage = await post("/v1/teams/credential-resources/entitled/list", recipient.id, { teamId: team.id });
        expect(recipientPage.statusCode, recipientPage.body).toBe(200);
        for (const brokeredResource of [brokeredAccountResource, brokeredPoolResource]) {
            const projectedBrokeredResource = recipientPage.json().resources.find((item: { id: string }) => (
                item.id === brokeredResource.id
            ));
            expect(projectedBrokeredResource).toMatchObject({
                id: brokeredResource.id,
                readiness: { kind: "available" },
                connectedServiceSelections: [{
                    source: "team_resource",
                    resourceId: brokeredResource.id,
                    deliveryMode: "brokered",
                }],
            });
            expect(projectedBrokeredResource.connectedServiceSelections).toHaveLength(1);
        }
        expect(recipientPage.json().resources).toContainEqual({
            id: resource.id,
            teamId: team.id,
            displayName: "Current shared source",
            resourceRevision: resource.revision,
            readiness: { kind: "available" },
            recoveryAction: null,
            mayBroker: false,
            mayReceiveDirect: true,
            directMaterialState: "current",
            sessionUsePolicy: "personal_allowed",
            usageCapabilities: {
                costUsd: "unavailable",
                inferenceRequests: "unavailable",
                totalTokens: "unavailable",
                limitCoverage: "unavailable",
            },
            providerModels: [],
            connectedServiceSelections: [{
                source: "team_resource",
                resourceId: resource.id,
                deliveryMode: "direct",
                disclosedMember: disclosedAccount,
            }],
            sourcePresentation: { kind: "connected_service", service },
        });
        expect(recipientPage.json().resources).toContainEqual(expect.objectContaining({
            id: "catalog-corrupt-resource",
            readiness: { kind: "resource_corrupt" },
        }));
        // The recipient catalog bytes never carry the source lifetime, broker
        // placement, or audience internals those projections decide from.
        expect(recipientPage.body).not.toContain(groupId);
        expect(recipientPage.body).not.toContain(pool.id);
        expect(recipientPage.body).not.toContain(privateBrokerMachineId);
        expect(recipientPage.body).not.toContain(custodian.id);
        expect(recipientPage.body).not.toContain(custodianMembership.id);
        expect(recipientPage.body).not.toContain(managerMembership.id);
        expect(recipientPage.body).not.toContain("source-secret-material-must-not-leak");
        expect(recipientPage.body).not.toContain("recipient-secret-material-must-not-leak");
        const custodianPageWithMaterial = await post(
            "/v1/teams/credential-resources/list",
            custodian.id,
            { teamId: team.id },
        );
        expect(custodianPageWithMaterial.statusCode, custodianPageWithMaterial.body).toBe(200);
        expect(custodianPageWithMaterial.body).not.toContain("source-secret-material-must-not-leak");
        expect(custodianPageWithMaterial.body).not.toContain("recipient-secret-material-must-not-leak");
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: custodian.id }));
        await expect(db.accountChange.findFirst({
            where: { accountId: recipient.id, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID },
        })).resolves.not.toBeNull();


        const groupRecipientCatalog = await post("/v1/teams/credential-resources/entitled/list", groupRecipient.id, { teamId: team.id });
        expect(groupRecipientCatalog.statusCode, groupRecipientCatalog.body).toBe(200);
        expect(groupRecipientCatalog.json().resources).toContainEqual({
            id: resource.id,
            teamId: team.id,
            displayName: "Current shared source",
            resourceRevision: resource.revision,
            readiness: { kind: "available" },
            recoveryAction: null,
            mayBroker: false,
            mayReceiveDirect: true,
            // The custodian has already published this resource's direct source
            // versions, so envelopes for a newly entitled recipient are owed and
            // on the way. That is "preparing"; "never delivered" is reserved for
            // a resource whose direct route was never published at all (the
            // unpublished resource below).
            directMaterialState: "preparing",
            sessionUsePolicy: "personal_allowed",
            usageCapabilities: {
                costUsd: "unavailable",
                inferenceRequests: "unavailable",
                totalTokens: "unavailable",
                limitCoverage: "unavailable",
            },
            providerModels: [],
            connectedServiceSelections: [],
            sourcePresentation: { kind: "connected_service", service },
        });
        expect(groupRecipientCatalog.body).not.toContain(groupId);
        expect(groupRecipientCatalog.body).not.toContain(pool.id);
        expect(groupRecipientCatalog.body).not.toContain(privateBrokerMachineId);
        expect(groupRecipientCatalog.body).not.toContain(custodian.id);
        expect(groupRecipientCatalog.body).not.toContain(directGroup.id);
        await inTx(tx => recordTeamCredentialDirectDeliveryActivityInTx(tx, {
            teamId: team.id,
            resourceId: resource.id,
            recipientAccountId: groupRecipient.id,
            subjectDisplayName: resource.displayName,
        }));
        const previouslyDeliveredCatalog = await post(
            "/v1/teams/credential-resources/entitled/list",
            groupRecipient.id,
            { teamId: team.id },
        );
        expect(previouslyDeliveredCatalog.statusCode, previouslyDeliveredCatalog.body).toBe(200);
        expect(previouslyDeliveredCatalog.json().resources).toContainEqual(expect.objectContaining({
            id: resource.id,
            mayReceiveDirect: true,
            directMaterialState: "stale",
            // Readiness and retained delivery history are separate facts: this
            // is what lets a selection skip a disclosure already given.
            directDeliveryRecorded: true,
        }));
        const groupRecipientAdminPage = await post("/v1/teams/credential-resources/list", groupRecipient.id, { teamId: team.id });
        expect(groupRecipientAdminPage.statusCode, groupRecipientAdminPage.body).toBe(200);
        expect(groupRecipientAdminPage.json()).toEqual({
            resources: [],
            nextCursor: null,
            viewer: { manageCredentials: false, offerOwnCredential: true },
        });

        const exactGuestCatalog = await post(
            "/v1/teams/credential-resources/entitled/list",
            exactGuest.id,
            { teamId: team.id },
        );
        expect(exactGuestCatalog.statusCode, exactGuestCatalog.body).toBe(200);
        expect(exactGuestCatalog.json().resources).toContainEqual(expect.objectContaining({
            id: resource.id,
            mayBroker: false,
            mayReceiveDirect: true,
            // Published for direct, no envelope for this exact-grant recipient yet.
            directMaterialState: "preparing",
        }));
        expect(exactGuestCatalog.body).not.toContain(custodian.id);
        expect(exactGuestCatalog.body).not.toContain(directGroup.id);
        expect(exactGuestCatalog.body).not.toContain(privateBrokerMachineId);
        const exactGuestAdminPage = await post(
            "/v1/teams/credential-resources/list",
            exactGuest.id,
            { teamId: team.id },
        );
        expect(exactGuestAdminPage.statusCode, exactGuestAdminPage.body).toBe(200);
        expect(exactGuestAdminPage.json()).toEqual({
            resources: [],
            nextCursor: null,
            viewer: { manageCredentials: false, offerOwnCredential: false },
        });

        const unrelatedPage = await post("/v1/teams/credential-resources/entitled/list", unrelated.id, { teamId: team.id });
        expect(unrelatedPage.statusCode, unrelatedPage.body).toBe(200);
        expect(unrelatedPage.json()).toEqual({ resources: [], nextCursor: null });

        const census = await get(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material?view=census`, custodian.id,
        );
        expect(census.statusCode, census.body).toBe(200);
        const rows = census.json().recipients as ReadonlyArray<{ readiness: string }>;
        const ready = rows.filter(row => row.readiness === 'ready').length;
        const pending = rows.length - ready;
        expect(pending).toBeGreaterThan(0);
        const readiness = await get(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material?view=readiness`, custodian.id,
        );
        expect(readiness.statusCode, readiness.body).toBe(200);
        expect(readiness.json()).toEqual({ status: 'not_ready', reason: 'preparation_pending', counts: { ready, pending } });

        // Cross the existing census page boundary: the observation must count
        // every entitled recipient, not just the first transport page.
        for (let index = 0; index < 101; index += 1) {
            const account = await createAccount();
            const membership = await db.teamMembership.create({ data: {
                id: `zz-parity-page-${index.toString().padStart(3, '0')}`,
                teamId: team.id, accountId: account.id, role: 'member',
            } });
            await db.teamCredentialMemberGrant.create({ data: {
                resourceId: resource.id, teamMembershipId: membership.id, deliveryMode: 'direct',
            } });
        }
        const pagedReadiness = await get(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material?view=readiness`, custodian.id,
        );
        expect(pagedReadiness.statusCode, pagedReadiness.body).toBe(200);
        expect(pagedReadiness.json()).toEqual({
            status: 'not_ready', reason: 'preparation_pending', counts: { ready, pending: pending + 101 },
        });
        const emptyAudience = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: 'No direct recipients',
            disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify(source), directSourceVersionsJson: JSON.stringify({ [sourceMemberKey]: sourceVersion }),
        } });
        const emptyReadiness = await get(
            `/v2/teams/${team.id}/credential-resources/${emptyAudience.id}/direct-material?view=readiness`, custodian.id,
        );
        expect(emptyReadiness.statusCode, emptyReadiness.body).toBe(200);
        expect(emptyReadiness.json()).toEqual({ status: 'ready', reason: null, counts: { ready: 0, pending: 0 } });

        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            } },
        });
        const unqualifiedPreparation = await get(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material?view=census`,
            custodian.id,
        );
        expect({ status: unqualifiedPreparation.statusCode, body: unqualifiedPreparation.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const unqualifiedReadiness = await get(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material?view=readiness`, custodian.id,
        );
        expect({ status: unqualifiedReadiness.statusCode, body: unqualifiedReadiness.json() }).toEqual({
            status: 403, body: { error: 'team_authentication_required' },
        });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: null } });

        await db.teamMembership.delete({ where: { id: custodianMembership.id } });
        await db.accountChange.deleteMany({
            where: { accountId: custodian.id, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID },
        });
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: custodian.id }));
        await expect(db.accountChange.findFirst({
            where: { accountId: custodian.id, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID },
        })).resolves.not.toBeNull();
        const departedCustodianPage = await post(
            "/v1/teams/credential-resources/list",
            custodian.id,
            { teamId: team.id },
        );
        expect({ status: departedCustodianPage.statusCode, body: departedCustodianPage.json() }).toEqual({
            status: 404,
            body: { error: "not_found_or_not_visible" },
        });
        const departedSourcePage = await post(
            "/v1/teams/credential-resources/source-resources/list",
            custodian.id,
            { source: { v: 1, kind: "connected_pool", target: source.target } },
        );
        expect(departedSourcePage.statusCode, departedSourcePage.body).toBe(200);
        expect(departedSourcePage.json().resources.find((item: { id: string }) => item.id === resource.id)).toMatchObject({
            id: resource.id,
            capabilities: {
                manageAudience: false,
                managePolicy: false,
                manageLimits: false,
                updateBrokerPlacement: true,
                narrowDisclosure: true,
                refreshDirectMaterial: false,
                disable: true,
                enable: false,
                delete: true,
            },
        });
        expect(departedSourcePage.body).not.toContain(team.id);
        expect(departedSourcePage.body).not.toContain(source.poolIncarnation);
        const departedPreparation = await get(
            `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material?view=census`,
            custodian.id,
        );
        expect({ status: departedPreparation.statusCode, body: departedPreparation.json() }).toEqual({
            status: 400,
            body: { error: "source_owner_required" },
        });
        const unavailableAfterCustodianDeparture = await post(
            "/v1/teams/credential-resources/entitled/list",
            recipient.id,
            { teamId: team.id },
        );
        expect(unavailableAfterCustodianDeparture.statusCode, unavailableAfterCustodianDeparture.body).toBe(200);
        expect(unavailableAfterCustodianDeparture.json().resources).toContainEqual(expect.objectContaining({
            id: resource.id,
            readiness: { kind: "source_unavailable" },
        }));
        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            } },
        });
        const evidence = [{ kind: "home_method", methodId: "email_password" }] as const;
        const deniedList = await post("/v1/teams/credential-resources/list", manager.id, { teamId: team.id });
        expect({ status: deniedList.statusCode, body: deniedList.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const qualifiedCatalog = await post(
            "/v1/teams/credential-resources/entitled/list",
            recipient.id,
            { teamId: team.id },
            evidence,
        );
        expect(qualifiedCatalog.statusCode, qualifiedCatalog.body).toBe(200);
        expect(qualifiedCatalog.json().resources).toContainEqual(expect.objectContaining({ id: resource.id }));

        // Revoking this one resource removes exactly that row. Independent
        // brokered grants and the still-granted corrupt sibling remain visible;
        // one resource's audience mutation cannot revoke sibling resources.
        await db.teamCredentialMemberGrant.delete({
            where: { resourceId_teamMembershipId: { resourceId: resource.id, teamMembershipId: recipientMembership.id } },
        });
        const revokedCatalog = await post(
            "/v1/teams/credential-resources/entitled/list",
            recipient.id,
            { teamId: team.id },
            evidence,
        );
        expect(revokedCatalog.statusCode, revokedCatalog.body).toBe(200);
        const revokedResourceIds = revokedCatalog.json().resources.map((item: { id: string }) => item.id);
        expect(revokedResourceIds).toHaveLength(3);
        expect(revokedResourceIds).toEqual(expect.arrayContaining([
            "catalog-brokered-account-resource",
            "catalog-brokered-pool-resource",
            "catalog-corrupt-resource",
        ]));

        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 99 } } });
        const unavailable = await post("/v1/teams/credential-resources/list", manager.id, { teamId: team.id }, evidence);
        expect({ status: unavailable.statusCode, body: unavailable.json() }).toEqual({
            status: 503,
            body: { error: "team_authentication_policy_unavailable" },
        });
        const unavailableMutation = await post("/v1/teams/credential-resources/update", manager.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            displayName: "Must remain unchanged while policy is unavailable",
        }, evidence);
        expect({ status: unavailableMutation.statusCode, body: unavailableMutation.json() }).toEqual({
            status: 503,
            body: { error: "team_authentication_policy_unavailable" },
        });
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
            .toMatchObject({ displayName: "Current shared source", revision: resource.revision });

        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            } },
        });
        const detail = await post("/v1/teams/credential-resources/get", custodian.id, { resourceId: resource.id }, evidence);
        expect({ status: detail.statusCode, body: detail.json() }).toEqual({
            status: 404, body: { error: "not_found_or_not_visible" },
        });
        const seqBeforeWithdrawal = (await db.account.findUniqueOrThrow({ where: { id: custodian.id } })).seq;
        const deniedUpdate = await post("/v1/teams/credential-resources/update", manager.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            displayName: "Must not change",
        });
        expect({ status: deniedUpdate.statusCode, body: deniedUpdate.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const deniedActivity = await post("/v1/teams/credential-resources/activity/list", manager.id, {
            resourceId: resource.id,
        });
        expect({ status: deniedActivity.statusCode, body: deniedActivity.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const deniedLimitUpsert = await post("/v1/teams/credential-resources/limits/upsert", manager.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
            limit: {
                subjectKind: "resource",
                subjectId: "",
                period: "day",
                metric: "inference_requests",
                maximum: "1",
                enabled: true,
            },
        });
        expect({ status: deniedLimitUpsert.statusCode, body: deniedLimitUpsert.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        expect(await db.teamCredentialUsageLimit.count({ where: { resourceId: resource.id } })).toBe(0);
        expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
            .toMatchObject({ displayName: "Current shared source", revision: resource.revision });
        const withdrawn = await post("/v1/teams/credential-resources/delete", custodian.id, {
            resourceId: resource.id,
            expectedRevision: resource.revision,
        });
        expect({ status: withdrawn.statusCode, body: withdrawn.json() }).toEqual({
            status: 200,
            body: { resourceId: resource.id, revision: resource.revision },
        });
        expect((await db.account.findUniqueOrThrow({ where: { id: custodian.id } })).seq)
            .toBeGreaterThan(seqBeforeWithdrawal);
    });

    // Child 06 L10D-R13 and row invariants (:94, :372): preparation is a
    // missing/stale census and an upsert of the same logical tuple is
    // idempotent. A re-upload of an unchanged tuple must not wake the Team:
    // that wake re-hydrates the source daemon's catalog, whose snapshot starts
    // the next reconciliation, so publishing it made the cycle renew itself.
    it("reports current direct tuples to preparation and publishes a Team change only for a logical tuple change", async () => {
        const custodian = await createAccount();
        const recipient = await createAccount();
        const team = await db.team.create({ data: { name: "Direct publication" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const recipientMembership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: recipient.id, role: "member",
        } });
        const service = { pluginId: "example.accounts", localId: "direct-publication" };
        const sourceAccount = { service, accountId: "direct-publication-source" };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: custodian.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            connectedAccountId: sourceAccount.accountId,
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(sourceAccount),
            authenticationModeId: "api-key",
            token: Buffer.from("direct-publication-source-secret"),
            metadata: {
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision: "csr_bbbbbbbbbbbbbbbbbbbbbbbb",
                directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
                contributionContractVersion: "resource-routes-fixture-v1",
                values: { scopes: [] },
            },
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Direct publication",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "connected_account",
                target: { kind: "account", account: sourceAccount },
                credentialIncarnation: credential.id,
            }),
            memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: "direct" } },
        } });
        const sourceMember = { kind: "connected_account" as const, service, connectedAccountId: sourceAccount.accountId };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const currentness = await inTx(tx => resolveTeamCredentialDirectSourceCurrentnessInTx(tx, {
            custodianAccountId: custodian.id,
            source: JSON.parse((resource.sourceBindingJson)),
            sourceMemberKey,
        }));
        if (currentness.status !== "current" || currentness.sourceVersion === null) {
            throw new Error(`expected a current direct source, received ${JSON.stringify(currentness)}`);
        }
        const sourceVersion = currentness.sourceVersion;
        const directMaterialPath = `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`;
        const preparation = async () => {
            const response = await get(
                `${directMaterialPath}?view=preparation&sourceMemberKey=${encodeURIComponent(sourceMemberKey)}`,
                custodian.id,
            );
            expect(response.statusCode, response.body).toBe(200);
            return response.json() as { recipients: Array<Record<string, unknown>> };
        };
        const upload = async (token: string, expectedStoredSourceVersion: string | null) => {
            const stored = createTeamCredentialDirectMaterialStoredV1({
                recipientMode: "plain",
                payload: {
                    v: 1,
                    domain: "happier.team-credential-direct-material",
                    homeServerIdentityId: "home",
                    teamId: team.id,
                    resourceId: resource.id,
                    resourceRevision: resource.revision,
                    recipientAccountId: recipient.id,
                    sourceMember,
                    sourceVersion,
                    material: {
                        kind: "qualified_connected_account",
                        credential: { v: 1, values: { token } },
                        configuration: null,
                        authenticationModeId: "api-key",
                    },
                },
            });
            return await app.inject({
                method: "PUT",
                url: directMaterialPath,
                headers: { "x-test-user-id": custodian.id },
                payload: { items: [{
                    recipientAccountId: recipient.id,
                    sourceMemberKey,
                    sourceVersion,
                    expectedPublishedSourceVersion: expectedStoredSourceVersion,
                    recipientMode: "plain",
                    recipientContentPublicKeyFingerprint: null,
                    stored,
                    expectedResourceRevision: resource.revision,
                    expectedStoredSourceVersion,
                }] },
            });
        };
        const teamWake = () => db.accountChange.findFirst({
            where: { accountId: recipient.id, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID },
        });

        expect((await preparation()).recipients).toEqual([expect.objectContaining({
            recipientAccountId: recipient.id,
            expectedStoredSourceVersion: null,
            storedTupleCurrent: false,
        })]);
        await db.accountChange.deleteMany({ where: { entityId: TEAM_CHANGE_ENTITY_ID } });
        const first = await upload("first-token", null);
        expect(first.statusCode, first.body).toBe(200);
        expect(first.json().results).toEqual([expect.objectContaining({ status: "stored", sourceVersion })]);
        await expect(teamWake()).resolves.not.toBeNull();
        const storedAfterFirst = await db.teamCredentialRecipientMaterial.findFirstOrThrow({
            where: { resourceId: resource.id, recipientAccountId: recipient.id },
        });
        expect((await preparation()).recipients).toEqual([expect.objectContaining({
            recipientAccountId: recipient.id,
            expectedStoredSourceVersion: sourceVersion,
            storedTupleCurrent: true,
        })]);

        await db.accountChange.deleteMany({ where: { entityId: TEAM_CHANGE_ENTITY_ID } });
        const repeated = await upload("repeated-token", sourceVersion);
        expect(repeated.statusCode, repeated.body).toBe(200);
        expect(repeated.json().results).toEqual([expect.objectContaining({ status: "stored", sourceVersion })]);
        await expect(teamWake()).resolves.toBeNull();
        const storedAfterRepeat = await db.teamCredentialRecipientMaterial.findFirstOrThrow({
            where: { resourceId: resource.id, recipientAccountId: recipient.id },
        });
        expect(Buffer.from(storedAfterRepeat.storedMaterial).equals(Buffer.from(storedAfterFirst.storedMaterial))).toBe(true);
    });
});
