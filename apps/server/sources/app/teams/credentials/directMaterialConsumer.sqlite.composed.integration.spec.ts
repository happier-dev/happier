import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import tweetnacl from "tweetnacl";
import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import { deriveBoxPublicKeyFromSeed } from "@happier-dev/protocol/crypto/boxBundle";
import { createConnectedAccountEstablishedRuntimeOwner, type QualifiedConnectedAccountMaterialSnapshot,
    type ConnectedAccountEstablishedRuntimeRegistry, type ConnectedAccountEstablishedReadScope } from "@happier-dev/cli-common/connectedAccounts";
import { PluginConnectedAccountDescriptorContributionV2Schema } from "@happier-dev/protocol/connect/plugin-connected-account-authentication-v2";
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from "@happier-dev/protocol/connect/qualified-connected-account-projections";
import { QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from "@happier-dev/protocol/connect/qualifiedConnectedAccountsV4";
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from "@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope";
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from "@/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4";
import {
    TeamCredentialDirectMaterialPreparationResponseV1Schema,
    TeamCredentialDirectMaterialUpsertResponseV1Schema,
    TeamCredentialDirectMaterialCensusOutputV1Schema,
    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
    type TeamCredentialSourceBindingV1,
    type TeamCredentialSourceMemberV1,
    type TeamCredentialDirectMaterialPreparationResponseV1,
    type TeamCredentialDirectMaterialUpsertRequestV1,
} from "@happier-dev/protocol/teams";
import { mutateQualifiedConnectedServiceCredential } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { createServiceAccountTokenIdentityFields } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";

import {
    computeTeamCredentialSourceMemberKeyV1,
    createTeamCredentialDirectMaterialStoredV1,
    encodeSessionTeamCredentialSlotKeyV1,
} from "@happier-dev/protocol/teams";
import type {
    TeamCredentialDirectMaterialOpenRequestV1,
    TeamCredentialDirectMaterialPayloadV1,
} from "@happier-dev/protocol/teams";
import type { ProviderConnectionId } from "@happier-dev/protocol/providers/ids";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";

import { registerTeamCredentialResourceRoutes } from "./registerTeamCredentialResourceRoutes";
import { upsertTeamCredentialRecipientMaterialInTx } from "./recipientMaterial";

type DirectMaterialOpen = (input: Readonly<{
    teamId?: string;
    signal?: AbortSignal;
}> & TeamCredentialDirectMaterialOpenRequestV1) => Promise<
    | Readonly<{ ok: true; payload: TeamCredentialDirectMaterialPayloadV1 }>
    | Readonly<{ ok: false; reason: string }>
>;

type DirectMaterialClient = Readonly<{ open: DirectMaterialOpen }>;

async function importTestModule<T>(specifier: string): Promise<T> {
    // This composed integration deliberately crosses workspace source roots at
    // runtime. Keep the server typecheck rooted locally while Vitest exercises
    // the real CLI consumer, matching the existing SDK integration harness.
    return import(specifier) as Promise<T>;
}

describe("Team credential direct material consumed boundary (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "team-credential-direct-consumer-",
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            },
        });
    }, 180_000);

    afterAll(async () => harness.close());

    it("keeps two E2EE recipients ready across runtime occurrences and opens rotated Connected Account material", async () => {
        const identities = [7, 9].map(value => {
            const seed = new Uint8Array(32).fill(value);
            const signing = tweetnacl.sign.keyPair();
            const contentPublicKey = deriveBoxPublicKeyFromSeed(seed);
            return { seed, signing, contentPublicKey, signature: signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey,
            }) };
        });
        const accounts = await Promise.all(identities.map(identity => db.account.create({ data: {
            encryptionMode: "e2ee", publicKey: Buffer.from(identity.signing.publicKey).toString("hex"),
            contentPublicKey: Buffer.from(identity.contentPublicKey), contentPublicKeySig: Buffer.from(identity.signature),
        } })));
        const custodian = accounts[0]!;
        const recipient = accounts[1]!;
        const team = await db.team.create({ data: { name: "Reconciled direct team" } });
        await Promise.all(accounts.map((account, index) => db.teamMembership.create({ data: {
            teamId: team.id, accountId: account.id, role: index === 0 ? "owner" : "member",
        } })));
        const account = { service: { pluginId: "example.accounts", localId: "service" }, accountId: "source" };
        let revision: string | null = null;
        const cryptoMaterial = { type: "legacy" as const, secret: identities[0]!.seed };
        async function writeSource(value: string) {
            const content = sealQualifiedConnectedAccountContentEnvelope({ kind: "credential", accountMode: "e2ee",
                material: cryptoMaterial, payload: { v: 1, values: { token: value } },
                randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
            const result = await mutateQualifiedConnectedServiceCredential({ accountId: custodian.id, ref: account,
                authenticationModeId: "api-key", content, metadata: { scopes: [], kind: "token" },
                expectedCredentialRevision: revision, ...(revision ? { expectedConfigurationRevision: null } : {}) });
            if (result.status !== "written") throw new Error(`Source fixture write failed: ${result.status}`);
            revision = result.credentialRevision;
        }
        await writeSource("initial");
        const credential = await db.serviceAccountToken.findFirstOrThrow({ where: {
            accountId: custodian.id, ...createServiceAccountTokenIdentityFields({ ref: account, authenticationModeId: "api-key" }),
        } });
        const source = { v: 1 as const, kind: "connected_account" as const,
            target: { kind: "account" as const, account }, credentialIncarnation: credential.id };
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "Reconciled Connected Account",
            disclosureCeiling: "direct_allowed", sessionUsePolicy: "team_visibility_required",
            allMembersDeliveryMode: "direct", sourceBindingJson: JSON.stringify(source),
        } });
        const sourceMember = { kind: "connected_account" as const, service: account.service, connectedAccountId: account.accountId };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        type Snapshot = Readonly<{ currentness: Readonly<{ sourceMember: TeamCredentialSourceMemberV1;
            sourceVersion: string; isCurrent(): Promise<boolean> }>; material: TeamCredentialDirectMaterialPayloadV1["material"] }>;
        const { createConnectedAccountTeamCredentialSourceSnapshot } = await importTestModule<{
            createConnectedAccountTeamCredentialSourceSnapshot(input: Readonly<{
                source: Extract<TeamCredentialSourceBindingV1, { kind: "connected_account" }>;
                material: QualifiedConnectedAccountMaterialSnapshot; authenticationKind: "manual";
                isPersistedSourceCurrent(): boolean;
            }>): Snapshot | null;
        }>("../../../../../cli/src/providers/broker/teamCredentialSourceSnapshot");
        const { reconcileTeamCredentialDirectMaterial } = await importTestModule<{
            reconcileTeamCredentialDirectMaterial(input: Readonly<{
                teamId: string; resourceId: string; sourceMemberKey: string;
                fetchPreparation(): Promise<TeamCredentialDirectMaterialPreparationResponseV1>;
                resolveSourceSnapshot(): Promise<Snapshot | null>;
                upsert(item: TeamCredentialDirectMaterialUpsertRequestV1["items"][number]): Promise<
                    Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>>;
                withdrawPublication(body: unknown): Promise<Readonly<{ ok: boolean }>>;
            }>): Promise<Readonly<{ ok: boolean; prepared: number; reason?: string }>>;
        }>("../../../../../cli/src/daemon/connectedServices/directMaterial/reconcileTeamCredentialDirectMaterial");
        const session = await db.session.create({ data: {
            accountId: recipient.id, tag: `reconciled-direct-${crypto.randomUUID()}`, metadata: "{}", encryptionMode: "e2ee",
            currentStorageState: "hosted", metadataLayoutVersion: 1, agentState: null, active: true,
        } });
        const purpose = { consumer: { pluginId: "example.agent", localId: "runtime" }, purpose: "model-request" };
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id, slotKind: "connected_service_purpose:direct",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "connected_service_purpose", purpose })),
            resourceId: resource.id, resourceRevision: resource.revision,
        } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "edit",
            canApprovePermissions: false, effectiveAt: new Date() } });
        const app = createAuthenticatedTestApp();
        app.addHook("onRequest", async (request: FastifyRequest) => {
            request.headers["x-test-user-id"] = request.headers.authorization === "Bearer custodian" ? custodian.id : recipient.id;
        });
        registerTeamCredentialResourceRoutes(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.listen({ host: "127.0.0.1", port: 0 });
        try {
            const address = app.server.address();
            if (!address || typeof address === "string") throw new Error("expected TCP test address");
            const serverUrl = `http://127.0.0.1:${address.port}`;
            const url = `${serverUrl}/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`;
            const headers = { Authorization: "Bearer custodian", "Content-Type": "application/json" };
            const { createHttpTeamCredentialDirectMaterialClient } = await importTestModule<{
                createHttpTeamCredentialDirectMaterialClient(input: Readonly<{ token: string; teamId: string; serverUrl: string;
                    readRecipientEncryptionMaterial(): Promise<Readonly<{ mode: "e2ee"; secretKeyOrSeed: Uint8Array }>> }>): DirectMaterialClient;
            }>("../../../../../cli/src/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient");
            const client = createHttpTeamCredentialDirectMaterialClient({ token: "recipient", teamId: team.id, serverUrl,
                readRecipientEncryptionMaterial: async () => ({ mode: "e2ee", secretKeyOrSeed: identities[1]!.seed }) });
            const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: account.service.localId, title: "Source",
                authentication: { defaultModeId: "api-key", modes: [{ id: "api-key", kind: "manual", fields: [],
                    outcomeReconciliation: "none", directExport: { contractVersion: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1 } }] } });
            type Registry = NonNullable<ConnectedAccountEstablishedRuntimeRegistry["connectedAccountContributions"]>;
            const { createConnectedAccountContributionRegistry } = await importTestModule<{
                createConnectedAccountContributionRegistry(input: Readonly<{
                    descriptors: readonly Readonly<{ pluginId: string; definition: typeof descriptor }>[];
                    activateOnDemand(): Promise<void>; readRegistrations(): readonly never[];
                    readPluginOccurrenceId(): string; readPluginSourceCustody(): Readonly<{ kind: "bundled_first_party";
                        packagedRuntime: Readonly<{ kind: "source_declaration"; packageName: string }> }>;
                    isPluginOccurrenceCurrent(pluginId: string, occurrenceId: string): boolean;
                }>): Registry;
            }>("../../../../../cli/src/plugins/runtime/connectedAccounts/contributionRegistry");
            const { createEstablishedAccountReadScope } = await importTestModule<{
                createEstablishedAccountReadScope(input: Readonly<Record<string, never>>): ConnectedAccountEstablishedReadScope;
            }>("../../../../../cli/src/daemon/connectedServices/establishedAccountRead");
            let occurrence = "source:1";
            const createRegistry = () => createConnectedAccountContributionRegistry({
                descriptors: [{ pluginId: account.service.pluginId, definition: descriptor }],
                activateOnDemand: async () => { throw new Error("Direct export does not activate a plugin runtime"); },
                readRegistrations: () => [], readPluginOccurrenceId: () => occurrence,
                readPluginSourceCustody: () => ({ kind: "bundled_first_party", packagedRuntime: { kind: "source_declaration", packageName: "example.accounts" } }),
                isPluginOccurrenceCurrent: (_pluginId, captured) => captured === occurrence,
            });
            let registry = { connectedAccountContributions: createRegistry() };
            const established = createConnectedAccountEstablishedRuntimeOwner({
                reloadController: { acquireRuntimeRegistry: async () => ({ registry, release: async () => {} }),
                    isRuntimeRegistryCurrent: captured => captured === registry },
                readScope: createEstablishedAccountReadScope({}), getAccountEncryptionMode: async () => "e2ee",
                readCredential: async () => {
                    const response = await fetch(`${serverUrl}/v4/connect/qualified/credential?ref=${encodeURIComponent(JSON.stringify(account))}`, { headers });
                    const body = await response.json();
                    expect(response.status, JSON.stringify(body)).toBe(200);
                    return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(body);
                },
                readConfiguration: async () => null,
                publishCredentialHealth: async ({ patch }) => {
                    const response = await fetch(`${serverUrl}/v4/connect/qualified/credential/health`, {
                        method: "PATCH", headers, body: JSON.stringify(patch),
                    });
                    expect(response.status).toBe(200);
                    return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(await response.json());
                },
                configuration: { read: async () => null, secrets: { admit: async () => {}, has: async () => false, read: async () => null } },
                openContent: ({ kind, envelope }) => openQualifiedConnectedAccountContentEnvelope({ kind, envelope, accountMode: "e2ee", material: cryptoMaterial }),
                sealCredentialContent: (_mode, payload) => sealQualifiedConnectedAccountContentEnvelope({ kind: "credential", accountMode: "e2ee",
                    material: cryptoMaterial, payload, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }),
            });
            for (const value of ["initial", "rotated"]) {
                if (value === "rotated") {
                    await writeSource(value);
                }
                const snapshot = createConnectedAccountTeamCredentialSourceSnapshot({ source, authenticationKind: "manual",
                    material: await established.readMaterialSnapshot({ account }), isPersistedSourceCurrent: () => true });
                const result = await reconcileTeamCredentialDirectMaterial({ teamId: team.id, resourceId: resource.id, sourceMemberKey,
                    fetchPreparation: async () => TeamCredentialDirectMaterialPreparationResponseV1Schema.parse(
                        await (await fetch(`${url}?view=preparation&sourceMemberKey=${sourceMemberKey}`, { headers })).json()),
                    resolveSourceSnapshot: async () => snapshot,
                    upsert: async item => {
                        const response = TeamCredentialDirectMaterialUpsertResponseV1Schema.parse(await (await fetch(url, {
                            method: "PUT", headers, body: JSON.stringify({ items: [item] }),
                        })).json()).results[0]!;
                        return response.status === "stored" ? { ok: true } : { ok: false, reason: response.reason };
                    },
                    withdrawPublication: async body => ({ ok: (await fetch(url, { method: "DELETE", headers,
                        body: JSON.stringify(body) })).ok }),
                });
                expect(result).toEqual({ ok: true, prepared: 2 });
                // A fresh process/reloaded registry has its own occurrence, but the persisted declaration contract is unchanged.
                occurrence += ":next";
                registry = { connectedAccountContributions: createRegistry() };
                await established.refreshExportProjection({ account });
                const census = TeamCredentialDirectMaterialCensusOutputV1Schema.parse(
                    await (await fetch(`${url}?view=census`, { headers })).json());
                expect(census.recipients.map(row => row.readiness)).toEqual(["ready", "ready"]);
                const opened = await client.open({ teamId: team.id, resourceId: resource.id,
                    consumer: { kind: "session", sessionId: session.id }, slot: { kind: "connected_service_purpose", purpose },
                    disclosedMember: account });
                expect(opened.ok, JSON.stringify(opened)).toBe(true);
                expect(opened).toMatchObject({ payload: { material: { credential: { values: { token: value } } } } });
            }
        } finally {
            await app.close();
        }
    });

    it("fetches recipient material over authenticated HTTP and feeds the real Provider credential consumer", async () => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
        const team = await db.team.create({ data: { name: "Direct consumer team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const recipientMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: "Direct Provider credential",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "team_visibility_required",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "connection",
                connectionSecurityFingerprint: "connection-security:v1:test",
                credentialSlotId: "apiKey",
            }),
            memberGrants: { create: { teamMembershipId: recipientMembership.id, deliveryMode: "direct" } },
        } });
        const sourceMember = {
            kind: "provider_credential_slot" as const,
            connectionId: "connection" as ProviderConnectionId,
            credentialSlotId: "apiKey",
        };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(sourceMember);
        const sourceVersion = "provider-source-v1";
        const homeServerIdentityId = await getOrCreateServerIdentityId(process.env);
        const stored = createTeamCredentialDirectMaterialStoredV1({
            recipientMode: "plain",
            payload: {
                v: 1,
                domain: "happier.team-credential-direct-material",
                homeServerIdentityId,
                teamId: team.id,
                resourceId: resource.id,
                resourceRevision: resource.revision,
                recipientAccountId: recipient.id,
                sourceMember,
                sourceVersion,
                material: {
                    kind: "provider_api_key",
                    value: "direct-provider-secret",
                    runtimeBinding: {
                        provider: { identity: { pluginId: "happier.provider.test", localId: "test" }, definitionRevision: 1 },
                        endpoint: {
                            endpointTemplateId: "responses", normalizedUrl: "https://api.example.test/v1",
                            protocol: "openai-responses", publicHeaders: {},
                        },
                        credentialTransport: {
                            id: "api-key", protocols: ["openai-responses"], uses: ["runtime"],
                            destination: { kind: "httpHeader", name: "Authorization", format: "bearer" },
                        },
                    },
                },
            },
        });
        await expect(inTx((tx) => upsertTeamCredentialRecipientMaterialInTx(tx, {
            actorAccountId: custodian.id,
            resourceId: resource.id,
            recipientAccountId: recipient.id,
            sourceMemberKey,
            sourceVersion,
            recipientMode: "plain",
            recipientContentPublicKeyFingerprint: null,
            stored,
            expectedResourceRevision: resource.revision,
            expectedStoredSourceVersion: null,
            expectedPublishedSourceVersion: null,
        }))).resolves.toMatchObject({ ok: true });
        const session = await db.session.create({ data: {
            accountId: recipient.id,
            tag: `direct-provider-${crypto.randomUUID()}`,
            metadata: "{}",
            encryptionMode: "plain",
            currentStorageState: "hosted",
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
            agentState: null,
            active: true,
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: "provider_model:direct",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            resourceId: resource.id,
            resourceRevision: resource.revision,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "edit",
            canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        // The worker's custodian owns its RPC registration; the recipient
        // remains the consumer principal on this shared worker.
        const worker = await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, metadata: "{}", active: true,
        } });

        const app = createAuthenticatedTestApp();
        app.decorate("forwardRpcForUser", async (request: Readonly<{
            userId: string;
            params: Readonly<{
                requestNonce: string;
                serverIdentityId: string;
                requestingAccountId: string;
                workerMachineId: string;
                executionRunId: string;
            }>;
        }>) => {
            expect(request.userId).toBe(custodian.id);
            expect(request.params.requestingAccountId).toBe(recipient.id);
            return {
                ok: true,
                result: {
                    status: "current",
                    requestNonce: request.params.requestNonce,
                    serverIdentityId: request.params.serverIdentityId,
                    requestingAccountId: request.params.requestingAccountId,
                    workerMachineId: request.params.workerMachineId,
                    executionRunId: request.params.executionRunId,
                    occurrenceId: `occurrence-${request.params.executionRunId}`,
                    parentSessionId: request.params.executionRunId === "attached-run" ? session.id : null,
                    intent: "agent",
                    runtimeState: "idle",
                    // The Run owner's own accepted selection: this resource, direct.
                    teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: "direct" },
                },
            };
        });
        app.addHook("onRequest", async (request: FastifyRequest) => {
            request.headers["x-test-user-id"] = recipient.id;
        });
        registerTeamCredentialResourceRoutes(app);
        await app.listen({ host: "127.0.0.1", port: 0 });

        try {
            const { createHttpTeamCredentialDirectMaterialClient } = await importTestModule<{
                createHttpTeamCredentialDirectMaterialClient(params: Readonly<{
                    token: string;
                    teamId: string;
                    serverUrl?: string;
                    readRecipientEncryptionMaterial(signal?: AbortSignal): Promise<Readonly<{ mode: "plain" }>>;
                }>): DirectMaterialClient;
            }>("../../../../../cli/src/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient");
            const { resolveProviderCredentialPlaintextAsync } = await importTestModule<{
                resolveProviderCredentialPlaintextAsync(input: Readonly<{
                    reference: Readonly<{
                        kind: "team_direct";
                        teamId: string;
                        resourceId: string;
                        expectedResourceRevision: number;
                        sourceMemberKey: string;
                        sourceVersion: string;
                    }>;
                    accountSettings: unknown;
                    settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>;
                    connectionId: ProviderConnectionId | string;
                    machineId: string;
                    openTeamDirect: DirectMaterialOpen;
                }>): Promise<
                    | Readonly<{ ok: true; credential: Readonly<{ kind: "apiKey"; value: string }> }>
                    | Readonly<{ ok: false; error: unknown }>
                >;
            }>("../../../../../cli/src/providers/spawn/credentials");
            const address = app.server.address();
            if (!address || typeof address === "string") throw new Error("expected TCP test address");
            const directClient = createHttpTeamCredentialDirectMaterialClient({
                token: "test-token",
                teamId: team.id,
                serverUrl: `http://127.0.0.1:${address.port}`,
                readRecipientEncryptionMaterial: async () => ({ mode: "plain" }),
            });
            const openedDirect = await directClient.open({
                teamId: team.id,
                resourceId: resource.id,
                consumer: { kind: "session", sessionId: session.id },
                slot: { kind: "provider_model" },
                sourceMemberKey,
            });
            expect(openedDirect.ok, JSON.stringify(openedDirect)).toBe(true);
            expect(openedDirect).toMatchObject({
                admittedResource: { displayName: resource.displayName, teamId: team.id },
            });
            const attachedRequest = {
                resourceId: resource.id,
                consumer: { kind: "execution_run" as const, executionRunId: "attached-run", workerMachineId: worker.id },
                slot: { kind: "provider_model" as const },
                sourceMemberKey,
            };
            const attached = await directClient.open({
                teamId: team.id,
                ...attachedRequest,
            });
            expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
            await expect(directClient.open({
                teamId: team.id,
                ...attachedRequest,
                consumer: { ...attachedRequest.consumer, workerMachineId: "missing-worker" },
            })).resolves.toEqual({ ok: false, reason: "access_removed" });
            await expect(directClient.open({
                teamId: team.id,
                resourceId: resource.id,
                consumer: { kind: "execution_run", executionRunId: "detached-run", workerMachineId: worker.id },
                slot: { kind: "provider_model" },
                sourceMemberKey,
            })).resolves.toEqual({ ok: false, reason: "access_removed" });
            // Finite platform work has no Session context; the same visibility policy still refuses it.
            const standalone = await app.inject({
                method: "POST",
                url: `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`,
                payload: { resourceId: resource.id,
                    consumer: { kind: "platform_operation", deploymentId: "receipt-1", environmentId: "environment-1", operationId: "deploy-1" },
                    slot: { kind: "provider_model" }, sourceMemberKey },
            });
            expect(standalone.statusCode).toBe(200);
            expect(standalone.json()).toEqual({ status: 'unavailable', reason: 'access_removed' });
            const resolved = await resolveProviderCredentialPlaintextAsync({
                reference: {
                    kind: "team_direct",
                    teamId: team.id,
                    resourceId: resource.id,
                    expectedResourceRevision: resource.revision,
                    sourceMemberKey,
                    sourceVersion,
                },
                accountSettings: {},
                settingsSecretsReadKeys: [],
                connectionId: "connection",
                machineId: "recipient-machine",
                openTeamDirect: (input) => {
                    if (!("sourceMemberKey" in input)) throw new Error("expected Provider-model direct material");
                    return directClient.open({
                        teamId: input.teamId,
                        resourceId: input.resourceId,
                        consumer: { kind: "session", sessionId: session.id },
                        slot: { kind: "provider_model" },
                        sourceMemberKey: input.sourceMemberKey,
                    });
                },
            });

            expect(resolved).toEqual({
                ok: true,
                credential: { kind: "apiKey", value: "direct-provider-secret" },
            });

            // Revocation must win over already-published material for both
            // consumers; regranting restores access through the same owners.
            await db.teamCredentialMemberGrant.deleteMany({ where: {
                resourceId: resource.id, teamMembershipId: recipientMembership.id,
            } });
            for (const consumer of [{ kind: "session" as const, sessionId: session.id }, attachedRequest.consumer]) {
                await expect(directClient.open({
                    teamId: team.id, ...attachedRequest, consumer,
                })).resolves.toEqual({ ok: false, reason: "access_removed" });
            }
            await db.teamCredentialMemberGrant.create({ data: {
                resourceId: resource.id, teamMembershipId: recipientMembership.id, deliveryMode: "direct",
            } });
            await expect(directClient.open({ teamId: team.id, ...attachedRequest }))
                .resolves.toMatchObject({ ok: true });
        } finally {
            await app.close();
        }
    });
});
