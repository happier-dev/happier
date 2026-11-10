import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";

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
            // Unsupported finite-operation consumers must fail at the HTTP boundary.
            const unsupported = await app.inject({
                method: "POST",
                url: `/v2/teams/${team.id}/credential-resources/${resource.id}/direct-material`,
                payload: { resourceId: resource.id,
                    consumer: { kind: "platform_operation", operationId: "deploy-1" },
                    slot: { kind: "provider_model" }, sourceMemberKey },
            });
            expect(unsupported.statusCode).toBe(400);
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
