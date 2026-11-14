import { plainPrivateLabel, prepareE2eePrivateLabelForAccount, storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeTeamCredentialSourceMemberKeyV1 } from "@happier-dev/protocol/teams";
import { ProviderConnectionIdSchema } from "@happier-dev/protocol/providers";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    authorizeTeamCredentialExternalApiKeyInTx,
    createTeamCredentialExternalApiKeyInTx,
    listTeamCredentialExternalApiKeysInTx,
    revokeAllTeamCredentialExternalApiKeysInTx,
    revokeTeamCredentialExternalApiKeyInTx,
    verifyTeamCredentialExternalApiKeyInTx,
} from "./externalApiKey";
import { readTeamCredentialActivityInTx } from "./resourceActivity";
import {
    admitTeamCredentialExternalProviderRequestInTx,
    authorizeTeamCredentialExternalProviderModelCatalogInTx,
    recordTeamCredentialExternalProviderTerminalUsageInTx,
} from "./externalProviderBrokerAdmission";
import { removeTeamMemberForActorInTx } from "../memberships/memberAdministration";
import { qualifyTeamAuthenticationInTx } from "@/app/auth/entry/qualifyTeamAuthentication";
import { resolveTeamCredentialBrokerPlacementFingerprint } from "./brokerPlacementResolver";

const TEST_AUTHENTICATION = {
    env: process.env,
    authenticationAuthority: "present_user",
    authenticationEvidence: [],
} as const;

describe("Team credential external API key owner", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "team-credential-external-key-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it("stores an E2EE external-key label and its audit snapshot without server-readable text", async () => {
        const manager = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding(),
        } });
        const team = await db.team.create({ data: { name: "Encrypted external key team" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: manager.id, displayName: storedPlainPrivateLabel("Provider"),
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "encrypted-external-key", connectionSecurityFingerprint: "connection-security:v1:encrypted-external-key", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        const keyId = crypto.randomUUID();
        const label = await prepareE2eePrivateLabelForAccount(manager.id, {
            entity: "team_credential_external_api_key", field: "label", id: keyId,
        }, "E2EE automation key");

        const created = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
            keyId, label, expiresAt: null,
        }));
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;

        const stored = await db.teamCredentialExternalApiKey.findUniqueOrThrow({
            where: { id: keyId }, select: { label: true },
        });
        expect(stored.label).not.toContain("E2EE automation key");
        expect(JSON.parse(stored.label)).toMatchObject({ content: { t: "encrypted" } });

        const storedActivity = await db.teamCredentialActivityEvent.findFirstOrThrow({
            where: { resourceId: resource.id, kind: "external_key_created" },
            select: { subjectDisplayName: true },
        });
        expect(storedActivity.subjectDisplayName).not.toContain("E2EE automation key");
        expect(JSON.parse(storedActivity.subjectDisplayName)).toMatchObject({
            v: 1,
            kind: "team_credential_external_api_key_label_snapshot",
            externalApiKeyId: keyId,
            label: { content: { t: "encrypted" } },
        });

        const activity = await inTx(tx => readTeamCredentialActivityInTx(tx, {
            actorAccountId: manager.id, resourceId: resource.id, authentication: TEST_AUTHENTICATION,
        }));
        expect(activity).toMatchObject({
            ok: true,
            page: { items: [{
                kind: "external_key_created",
                externalApiKeyId: keyId,
                subjectDisplayName: { content: { t: "encrypted" } },
            }] },
        });
        expect(JSON.stringify(activity)).not.toContain("E2EE automation key");
    });

    it("creates one-time resource-scoped material, lists only safe metadata, and verifies by digest", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "External key team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
        expect(membership.id).not.toBe(recipient.id);
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("API clients") } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: manager.id, displayName: storedPlainPrivateLabel("Shared provider"),
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection-1", connectionSecurityFingerprint: "connection-security:v1:1", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        const created = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("CI runner"), expiresAt: null,
        }));
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.token).toMatch(/^hapek_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);
        expect(created.key).toMatchObject({
            resourceId: resource.id,
            teamMembershipId: membership.id,
            label: { content: { t: "plain", v: "CI runner" }, recipientEnvelope: null },
            lastUsedAt: null,
            expiresAt: null,
        });
        const stored = await db.teamCredentialExternalApiKey.findUnique({ where: { id: created.key.keyId } });
        expect(stored?.secretDigest).not.toContain(created.token);
        expect(stored?.secretDigest).not.toContain(created.token.slice(-43));
        expect(await inTx(tx => listTeamCredentialExternalApiKeysInTx(tx, { actorAccountId: manager.id, resourceId: resource.id, authentication: TEST_AUTHENTICATION }))).toMatchObject({ ok: true, keys: [created.key] });
        expect(await inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token }))).toMatchObject({
            ok: true,
            keyId: created.key.keyId,
            resourceId: resource.id,
            teamId: team.id,
            assignedAccountId: recipient.id,
            assignedTeamMembershipId: membership.id,
            custodianAccountId: manager.id,
            brokerMachineId: null,
        });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { enabled: false } });
        await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
            .resolves.toEqual({ ok: false, reason: "invalid_token" });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { enabled: true } });
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).lastUsedAt).toBeNull();
        const broker = await db.machine.create({ data: {
            id: `external-broker-${manager.id}`,
            accountId: manager.id,
            metadata: "{}",
            kind: "persistent",
            active: true,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { brokerMachineId: broker.id } });
        const modelAuthorization = {
            v: 1 as const,
            binding: {
                v: 1 as const,
                kind: "external_api_key" as const,
                teamId: team.id,
                resourceId: resource.id,
                requestId: "models-1",
                externalApiKeyId: created.key.keyId,
                assignedAccountId: recipient.id,
                assignedTeamMembershipId: membership.id,
                operationId: null,
                brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint({ ...resource, brokerMachineId: broker.id }),
            },
            brokerMachineId: broker.id,
            expectedResourceRevision: resource.revision,
            application: {
                agentTargetKey: "agent:happier.agent.codex/codex",
                implementationIdentity: { pluginId: "happier.provider.cliproxyapi", localId: "cliproxyapi" },
                endpointTemplateId: "cliproxyapi-openai-responses",
                protocol: "openai-responses" as const,
            },
        };
        await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: modelAuthorization,
            observedAt: new Date("2026-09-07T12:30:00.000Z"),
        }))).resolves.toEqual({ ok: true });
        await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: modelAuthorization,
            observedAt: new Date("2026-09-07T12:30:00.000Z"),
        }))).resolves.toEqual({ ok: true });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).lastUsedAt)
            .toEqual(new Date("2026-09-07T12:30:00.000Z"));
        const admittedAt = new Date("2026-09-07T12:34:56.000Z");
        const expectedSourceMemberKey = computeTeamCredentialSourceMemberKeyV1({
            kind: "provider_credential_slot",
            connectionId: ProviderConnectionIdSchema.parse("connection-1"),
            credentialSlotId: "apiKey",
        });
        await db.teamCredentialUsageLimit.createMany({ data: [
            { resourceId: resource.id, subjectKind: "each_member", subjectId: "", period: "day", metric: "inference_requests", maximum: "3", createdAt: new Date(admittedAt.getTime() - 1) },
            { resourceId: resource.id, subjectKind: "team_group", subjectId: group.id, period: "day", metric: "inference_requests", maximum: "2", createdAt: new Date(admittedAt.getTime() - 1) },
        ] });
        const operationId = crypto.randomUUID();
        await db.teamCredentialExternalApiKey.update({ where: { id: created.key.keyId }, data: {
            currentBrokerOperationJson: JSON.stringify({
                v: 1, operationId, brokerMachineId: broker.id,
                brokerPlacementFingerprint: modelAuthorization.binding.brokerPlacementFingerprint,
                sourceBindingJson: resource.sourceBindingJson,
            }),
        } });
        // A catalog authorization minted before the inference acquired custody
        // must not survive that race with its null operation identity.
        await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
            authenticatedBrokerAccountId: manager.id, request: modelAuthorization, observedAt: admittedAt,
        }))).resolves.toEqual({ ok: false, reasonCode: "operation_not_current" });
        const verification = await inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token }));
        expect(verification).not.toHaveProperty("currentBrokerOperationJson");
        const listed = await inTx(tx => listTeamCredentialExternalApiKeysInTx(tx, {
            actorAccountId: manager.id, resourceId: resource.id, authentication: TEST_AUTHENTICATION,
        }));
        expect(JSON.stringify(listed)).not.toContain(operationId);
        const admissionRequest = (requestId: string) => ({
            v: 1 as const,
            binding: { ...modelAuthorization.binding, requestId, operationId },
            brokerMachineId: broker.id,
            expectedResourceRevision: resource.revision,
            application: modelAuthorization.application,
            requestFacts: {
                generation: true,
                routeKind: "openai_responses" as const,
                modelId: "model-1",
                reasoningEffort: null,
            },
        });
        const countTokensAt = new Date(admittedAt.getTime());
        const countTokensAdmission = await inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: {
                ...admissionRequest("count-tokens-1"),
                application: { ...modelAuthorization.application, endpointTemplateId: "cliproxyapi-anthropic", protocol: "anthropic" as const },
                requestFacts: {
                    generation: false,
                    routeKind: "anthropic_messages" as const,
                    modelId: "model-1",
                    reasoningEffort: null,
                },
            },
            observedAt: countTokensAt,
        }));
        expect(countTokensAdmission).toMatchObject({
            ok: true,
            usageEventId: expect.any(String),
            terminalRequestId: null,
        });
        if (!countTokensAdmission.ok || countTokensAdmission.usageEventId === null) {
            throw new Error("expected a metered count-tokens admission");
        }
        await expect(db.usageEvent.findUniqueOrThrow({
            where: { id: countTokensAdmission.usageEventId },
            select: { teamCredentialSourceCredentialId: true },
        })).resolves.toEqual({ teamCredentialSourceCredentialId: expectedSourceMemberKey });
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).lastUsedAt)
            .toEqual(countTokensAt);
        const admission = await inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: admissionRequest("request-1"),
            observedAt: admittedAt,
        }));
        expect(admission).toMatchObject({
            ok: true,
            resourceId: resource.id,
            brokerMachineId: broker.id,
            operation: {
                kind: "external_api_key",
                externalApiKeyId: created.key.keyId,
                assignedAccountId: recipient.id,
                assignedTeamMembershipId: membership.id,
            },
            usageEventId: expect.any(String),
            terminalRequestId: `external:${created.key.keyId}:request-1`,
        });
        if (!admission.ok || !admission.usageEventId || !admission.terminalRequestId) {
            throw new Error("expected generation admission correlation");
        }
        const terminalRequest = {
            v: 1 as const,
            admissionUsageEventId: admission.usageEventId,
            requestId: admission.terminalRequestId,
            brokerMachineId: broker.id,
            completedAtMs: admittedAt.getTime() + 250,
            outcome: "succeeded" as const,
            measurement: "unavailable" as const,
            actualModelId: null,
            tokens: null,
        };
        const terminal = await inTx(tx => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: terminalRequest,
        }));
        expect(terminal).toMatchObject({ ok: true, created: true, usageEventId: expect.any(String) });
        await expect(db.usageEvent.findMany({
            where: { id: { in: [admission.usageEventId, terminal.ok ? terminal.usageEventId : ""] } },
            select: { teamCredentialSourceCredentialId: true },
        })).resolves.toEqual([
            { teamCredentialSourceCredentialId: expectedSourceMemberKey },
            { teamCredentialSourceCredentialId: expectedSourceMemberKey },
        ]);
        await expect(inTx(tx => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: terminalRequest,
        }))).resolves.toMatchObject({ ok: true, created: false, usageEventId: terminal.ok ? terminal.usageEventId : "" });
        expect(await db.usageEvent.count({ where: {
            source: "team_credential_external_terminal",
            externalKey: admission.terminalRequestId,
        } })).toBe(1);
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).lastUsedAt).toEqual(admittedAt);
        await expect(inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: {
                ...admissionRequest("wrong-resource"),
                binding: { ...modelAuthorization.binding, resourceId: "another-resource", requestId: "wrong-resource" },
            },
            observedAt: new Date(admittedAt.getTime() + 100),
        }))).resolves.toEqual({ ok: false, reasonCode: "operation_not_current" });
        await db.teamCredentialMemberGrant.delete({
            where: { resourceId_teamMembershipId: { resourceId: resource.id, teamMembershipId: membership.id } },
        });
        await expect(inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: admissionRequest("grant-revoked"),
            observedAt: new Date(admittedAt.getTime() + 200),
        }))).resolves.toEqual({ ok: false, reasonCode: "resource_forbidden" });
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).lastUsedAt).toEqual(admittedAt);
        await db.teamCredentialMemberGrant.create({
            data: { resourceId: resource.id, teamMembershipId: membership.id, deliveryMode: "brokered" },
        });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
            v: 1,
            mode: "restricted",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        } } });
        await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: modelAuthorization,
            observedAt: new Date(admittedAt.getTime() + 500),
        }))).resolves.toEqual({ ok: false, reasonCode: "resource_forbidden" });
        await expect(inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: admissionRequest("request-restricted"),
            observedAt: new Date(admittedAt.getTime() + 500),
        }))).resolves.toEqual({ ok: false, reasonCode: "resource_forbidden" });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: null } });
        const deniedAt = new Date(admittedAt.getTime() + 1_000);
        await expect(inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: manager.id,
            request: admissionRequest("request-2"),
            observedAt: deniedAt,
        }))).resolves.toMatchObject({ ok: false, reasonCode: "team_credential_usage_limit" });
        expect(await db.usageEvent.count({ where: {
            teamCredentialResourceId: resource.id,
            source: "team_credential_admission",
        } })).toBe(2);
        expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).lastUsedAt).toEqual(admittedAt);
        expect(await inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: `${created.token.slice(0, -1)}B` }))).toEqual({ ok: false, reason: "invalid_token" });
        expect(await db.teamCredentialActivityEvent.count({ where: { resourceId: resource.id, kind: "external_key_created" } })).toBe(1);
    });

    it("mints an external key for a restricted Team when its issuer and assignee share current verified authentication", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "true",
        });
        try {
            const account = await db.account.create({ data: {
                publicKey: crypto.randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding(),
            } });
            const team = await db.team.create({ data: {
                name: "Qualified external key issuer",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            } });
            const membership = await db.teamMembership.create({ data: {
                teamId: team.id, accountId: account.id, role: "owner",
            } });
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id,
                custodianAccountId: account.id,
                displayName: storedPlainPrivateLabel("Qualified provider"),
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1, kind: "provider_connection", connectionId: "qualified-connection",
                    connectionSecurityFingerprint: "connection-security:v1:qualified", credentialSlotId: "apiKey",
                }),
                memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
            } });

            // A self-assigned bearer retains only this Account's current proof.
            const authentication = {
                env: process.env,
                authenticationAuthority: "present_user" as const,
                authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
            };
            await expect(inTx(tx => qualifyTeamAuthenticationInTx(tx, {
                env: process.env,
                team,
                accountId: account.id,
                verifiedCredentialEvidence: authentication.authenticationEvidence,
                operationContext: { kind: "present_user" },
            }))).resolves.toMatchObject({ status: "satisfied" });
            const keyId = crypto.randomUUID();
            const label = await prepareE2eePrivateLabelForAccount(account.id, {
                entity: "team_credential_external_api_key", field: "label", id: keyId,
            }, "Qualified unattended client");
            const created = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
                actorAccountId: account.id,
                authentication,
                resourceId: resource.id,
                teamMembershipId: membership.id,
                keyId, label,
                expiresAt: null,
            }));
            expect(created).toMatchObject({
                ok: true,
                key: { resourceId: resource.id, teamMembershipId: membership.id, authenticationStatus: "satisfied", canAuthorize: true },
            });
            if (!created.ok) throw new Error("expected qualified external key");
            await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
                .resolves.toMatchObject({ ok: true, assignedAccountId: account.id });
            const broker = await db.machine.create({ data: {
                id: `qualified-broker-${account.id}`, accountId: account.id, metadata: "{}",
                kind: "persistent", active: true,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            await db.teamCredentialResource.update({ where: { id: resource.id }, data: { brokerMachineId: broker.id } });
            const catalogRequest = {
                v: 1,
                binding: { v: 1, kind: "external_api_key", teamId: team.id, resourceId: resource.id,
                    requestId: "qualified-models", externalApiKeyId: created.key.keyId,
                    assignedAccountId: account.id, assignedTeamMembershipId: membership.id,
                    operationId: null,
                    brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint({ ...resource, brokerMachineId: broker.id }) },
                brokerMachineId: broker.id, expectedResourceRevision: resource.revision,
                application: { agentTargetKey: "agent:happier.agent.codex/codex",
                    implementationIdentity: { pluginId: "happier.provider.cliproxyapi", localId: "cliproxyapi" },
                    endpointTemplateId: "cliproxyapi-openai-responses", protocol: "openai-responses" },
            };
            await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
                authenticatedBrokerAccountId: account.id, request: catalogRequest, observedAt: new Date(),
            }))).resolves.toEqual({ ok: true });
            await db.account.update({ where: { id: account.id }, data: { publicKey: null } });
            await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
                .resolves.toEqual({ ok: false, reason: "invalid_token" });
            await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
                authenticatedBrokerAccountId: account.id, request: catalogRequest, observedAt: new Date(),
            }))).resolves.toMatchObject({ ok: false });
        } finally {
            harness.restoreEnv();
        }
    });

    it("requires the exact assigned member to authorize a manager-created key without redisclosing its bearer", async () => {
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: "", HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "true" });
        try {
            const manager = await db.account.create({ data: {
                publicKey: crypto.randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding(),
            } });
            const member = await db.account.create({ data: {
                publicKey: crypto.randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding(),
            } });
            const team = await db.team.create({ data: { name: "Assigned qualification", authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
            const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: manager.id, displayName: storedPlainPrivateLabel("Assigned provider"),
                disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "assigned-connection",
                    connectionSecurityFingerprint: "connection-security:v1:assigned", credentialSlotId: "apiKey" }),
                memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
            } });
            const authentication = { ...TEST_AUTHENTICATION,
                authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }] };
            const keyId = crypto.randomUUID();
            const label = await prepareE2eePrivateLabelForAccount(manager.id, {
                entity: "team_credential_external_api_key", field: "label", id: keyId,
            }, "Member tool", { teamIds: [team.id] });
            const created = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
                actorAccountId: manager.id, authentication, resourceId: resource.id,
                teamMembershipId: membership.id, keyId, label, expiresAt: null,
            }));
            expect(created).toMatchObject({ ok: true, key: { authenticationStatus: "authentication_required", canAuthorize: false } });
            if (!created.ok) throw new Error("expected pending assigned key");
            const storedBefore = await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } });
            expect(storedBefore.authenticationEvidence).toBeNull();
            await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
                .resolves.toEqual({ ok: false, reason: "invalid_token" });
            const input = { resourceId: resource.id, keyId: created.key.keyId };
            await expect(inTx(tx => authorizeTeamCredentialExternalApiKeyInTx(tx, {
                ...input, actorAccountId: manager.id, authentication,
            }))).resolves.toMatchObject({ ok: false, error: "resource_forbidden" });
            await expect(inTx(tx => authorizeTeamCredentialExternalApiKeyInTx(tx, {
                ...input, actorAccountId: member.id, authentication: TEST_AUTHENTICATION,
            }))).resolves.toMatchObject({ ok: false, error: "team_authentication_required" });
            await expect(inTx(tx => listTeamCredentialExternalApiKeysInTx(tx, {
                resourceId: resource.id, actorAccountId: member.id, authentication,
            }))).resolves.toMatchObject({ ok: true, keys: [{ keyId: created.key.keyId, canAuthorize: true }] });
            const authorized = await inTx(tx => authorizeTeamCredentialExternalApiKeyInTx(tx, {
                ...input, actorAccountId: member.id, authentication,
            }));
            expect(authorized).toMatchObject({ ok: true, key: { authenticationStatus: "satisfied" } });
            expect(authorized).not.toHaveProperty("token");
            expect(JSON.stringify(authorized)).not.toContain(created.token);
            expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: created.key.keyId } })).secretDigest)
                .toBe(storedBefore.secretDigest);
            await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
                .resolves.toMatchObject({ ok: true, assignedAccountId: member.id });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
                .resolves.toEqual({ ok: false, reason: "invalid_token" });
        } finally { harness.restoreEnv(); }
    });

    it("refuses to mint an external key when its manager credential does not qualify", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: {
            name: "Restricted external key team",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: manager.id,
            displayName: storedPlainPrivateLabel("Restricted provider"),
            disclosureCeiling: "brokered_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "restricted-connection",
                connectionSecurityFingerprint: "connection-security:v1:restricted",
                credentialSlotId: "apiKey",
            }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });

        await expect(inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            actorAccountId: manager.id,
            authentication: TEST_AUTHENTICATION,
            resourceId: resource.id,
            teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("Unusable automation key"),
            expiresAt: null,
        }))).resolves.toEqual({ ok: false, error: "team_authentication_required" });
        expect(await db.teamCredentialExternalApiKey.count({ where: { resourceId: resource.id } })).toBe(0);
        expect(await db.teamCredentialActivityEvent.count({
            where: { resourceId: resource.id, kind: "external_key_created" },
        })).toBe(0);
    });

    it("revokes assigned keys with safe activity before hard membership removal", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Membership key revocation" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: manager.id, displayName: storedPlainPrivateLabel("Removal provider"),
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection-removal", connectionSecurityFingerprint: "connection-security:v1:removal", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        const created = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("Removed runner"), expiresAt: null,
        }));
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey: "provider:connection-removal",
            sourceVersion: "source-version-before-removal",
            recipientMode: "plain",
            storedMaterial: new Uint8Array([1, 2, 3]),
        } });

        const rollbackMarker = new Error("rollback membership removal");
        await expect(inTx(async (tx) => {
            const result = await removeTeamMemberForActorInTx(tx, {
                teamId: team.id, actorAccountId: manager.id, membershipId: membership.id,
            });
            expect(result).toMatchObject({ ok: true, value: { status: "removed", membershipId: membership.id } });
            throw rollbackMarker;
        })).rejects.toBe(rollbackMarker);
        expect(await db.teamMembership.count({ where: { id: membership.id } })).toBe(1);
        expect(await db.teamCredentialExternalApiKey.count({ where: { id: created.key.keyId } })).toBe(1);
        expect(await db.teamCredentialMemberGrant.count({
            where: { resourceId: resource.id, teamMembershipId: membership.id },
        })).toBe(1);
        expect(await db.teamCredentialRecipientMaterial.count({
            where: { resourceId: resource.id, recipientAccountId: recipient.id },
        })).toBe(1);
        expect(await db.teamCredentialActivityEvent.count({
            where: { resourceId: resource.id, kind: { in: ["external_key_revoked", "audience_changed"] } },
        })).toBe(0);

        await expect(inTx(tx => removeTeamMemberForActorInTx(tx, {
            teamId: team.id, actorAccountId: manager.id, membershipId: membership.id,
        }))).resolves.toMatchObject({ ok: true, value: { status: "removed", membershipId: membership.id } });
        expect(await db.teamCredentialExternalApiKey.findUnique({ where: { id: created.key.keyId } })).toBeNull();
        expect(await db.teamCredentialMemberGrant.count({
            where: { resourceId: resource.id, teamMembershipId: membership.id },
        })).toBe(0);
        expect(await db.teamCredentialRecipientMaterial.count({
            where: { resourceId: resource.id, recipientAccountId: recipient.id },
        })).toBe(0);
        expect(await db.teamCredentialActivityEvent.findMany({
            where: { resourceId: resource.id, kind: "external_key_revoked" },
            select: { actorAccountId: true, subjectDisplayName: true },
        })).toEqual([expect.objectContaining({ actorAccountId: manager.id })]);
        const [externalKeyActivity] = await db.teamCredentialActivityEvent.findMany({
            where: { resourceId: resource.id, kind: "external_key_revoked" },
            select: { subjectDisplayName: true },
        });
        expect(externalKeyActivity && JSON.parse(externalKeyActivity.subjectDisplayName)).toMatchObject({
            v: 1,
            kind: "team_credential_external_api_key_label_snapshot",
            externalApiKeyId: created.key.keyId,
            label: { content: { t: "plain", v: "Removed runner" } },
        });
        expect(await db.teamCredentialActivityEvent.findMany({
            where: { resourceId: resource.id, kind: "audience_changed" },
            select: { actorAccountId: true, subjectDisplayName: true },
        })).toEqual([{ actorAccountId: manager.id, subjectDisplayName: resource.displayName }]);
        await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: created.token })))
            .resolves.toEqual({ ok: false, reason: "invalid_token" });
    });

    it("requires current resource access and external-compatible Session policy", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "External policy team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: manager.id, displayName: storedPlainPrivateLabel("Session-only provider"),
            disclosureCeiling: "brokered_only", sessionUsePolicy: "team_context_required",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection-2", connectionSecurityFingerprint: "connection-security:v1:2", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        await expect(inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("Should fail"), expiresAt: null,
        }))).resolves.toMatchObject({ ok: false, error: "session_policy_incompatible" });
        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { sessionUsePolicy: "personal_allowed" } });
        await expect(inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("Should fail"), expiresAt: null,
        }))).resolves.toMatchObject({ ok: true });
    });

    it("revokes one key idempotently and revokes all remaining keys without a second enabled flag", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Revoke key team" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: manager.id, displayName: storedPlainPrivateLabel("Revocable provider"),
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "connection-3", connectionSecurityFingerprint: "connection-security:v1:3", credentialSlotId: "apiKey" }),
            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
        } });
        const create = (label: string) => inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel(label), expiresAt: null,
        }));
        const first = await create("first");
        const second = await create("second");
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        await expect(inTx(tx => revokeTeamCredentialExternalApiKeyInTx(tx, { actorAccountId: manager.id, resourceId: resource.id, keyId: first.key.keyId, authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: true, keyId: first.key.keyId, revoked: true });
        await expect(inTx(tx => verifyTeamCredentialExternalApiKeyInTx(tx, { token: first.token }))).resolves.toEqual({ ok: false, reason: "invalid_token" });
        await expect(inTx(tx => revokeTeamCredentialExternalApiKeyInTx(tx, { actorAccountId: manager.id, resourceId: resource.id, keyId: first.key.keyId, authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: true, keyId: first.key.keyId, revoked: false });
        await expect(inTx(tx => revokeAllTeamCredentialExternalApiKeysInTx(tx, { actorAccountId: manager.id, resourceId: resource.id, authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: true, resourceId: resource.id, revokedCount: 1 });
        await expect(inTx(tx => listTeamCredentialExternalApiKeysInTx(tx, { actorAccountId: manager.id, resourceId: resource.id, authentication: TEST_AUTHENTICATION })))
            .resolves.toMatchObject({ ok: true, keys: [] });
        expect(await db.teamCredentialResource.findUnique({ where: { id: resource.id }, select: { enabled: true } })).toEqual({ enabled: true });
    });
});
