import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import Fastify, { type RouteOptions } from "fastify";
import * as privacyKit from "privacy-kit";

import { storedPlainPrivateLabel, plainPrivateLabel } from '@/testkit/privateLabelFixture';
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSha256SecretDigest } from "@/app/auth/secretDigest";
import {
    createTeamCredentialExternalApiKeyInTx,
    authorizeTeamCredentialExternalApiKeyInTx,
    revokeTeamCredentialExternalApiKeyInTx,
    verifyTeamCredentialExternalApiKeyInTx,
} from "@/app/teams/credentials/externalApiKey";
import {
    admitTeamCredentialExternalProviderRequestInTx,
    recordTeamCredentialExternalProviderTerminalUsageInTx,
} from "@/app/teams/credentials/externalProviderBrokerAdmission";
import { removeTeamMemberForActorInTx } from "@/app/teams/memberships/memberAdministration";
import {
    registerExternalProviderApiRoutes,
    type ExternalProviderBrokerDispatch,
} from "./registerExternalProviderApiRoutes";
import { formatTeamCredentialExternalApiKeyV1, createTeamCredentialExternalApiKeyDisplayPrefixV1 } from "@happier-dev/protocol/teams";
import { resolveTeamCredentialExternalBrokerPlacement } from "@/app/teams/credentials/externalBrokerPlacement";
import { updateMachinePool } from "@/app/machines/pools/machinePoolService";
import { readExternalBrokerOperation, retireExternalBrokerOperationInTx } from "@/app/teams/credentials/externalBrokerOperation";
import { resolveTeamCredentialBrokerPlacementFingerprint } from "@/app/teams/credentials/brokerPlacementResolver";
import { updateTeamCredentialResourceInTx } from "@/app/teams/credentials/resourceUpdate";
import { mapProviderBrokerApplicationFailure } from './externalProviderBrokerDispatcher';
import { writeProviderBrokerApplicationFailure } from '../../../../../../cli/src/providers/broker/providerBrokerApplicationServer';
import { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { enableApiCompression } from '@/app/api/utils/enableApiCompression';
import { createServiceAccountTokenIdentityFields } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';

/**
 * A Home that can actually serve this API also has the route-grant signing
 * material the broker dispatcher mints direct route grants with
 * (`externalProviderBrokerDispatcher.ts` → `resolvePeerMediationGrantSigningConfig`),
 * which is why `teamsFeature.ts` reports `deployment_readiness_unavailable`
 * without it and the route then answers 404. These cases are about what a ready
 * Home serves, so they configure it; the readiness decision itself is owned by
 * `apps/server/sources/app/features/teamsFeature.spec.ts`.
 */
const DEPLOYED_ROUTE_GRANT_SIGNING_ENV = {
    HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: "route-grant-key",
    HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: privacyKit
        .encodeBase64(new Uint8Array(32).fill(9), "base64url")
        .replace(/=+$/u, ""),
} as const;

const TEST_AUTHENTICATION = {
    env: process.env,
    authenticationAuthority: "present_user",
    authenticationEvidence: [],
} as const;

function digestForTest(secret: string): string {
    return privacyKit.encodeBase64(new Uint8Array(createSha256SecretDigest(secret)), "base64url").replace(/=+$/u, "");
}

describe("external Provider broker ingress network vertical (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "team-credential-external-ingress-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            },
        });
    }, 180_000);

    afterAll(async () => {
        await harness?.close();
    });

    it('preserves reconnect-required source health through external ingress and admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'External source health', memberships: { create: { accountId: owner.id, role: 'owner' } } } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
        const account = { service: { pluginId: 'example.connected-accounts', localId: 'service' }, accountId: 'external-health-source' };
        const metadata = { v: 4, storage: 'stored_envelope_v1', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', values: {} };
        const credential = await db.serviceAccountToken.create({ data: { accountId: owner.id,
            ...createServiceAccountTokenIdentityFields({ ref: account, authenticationModeId: 'api-key' }),
            token: Buffer.from('constructed-test-token'), metadata } });
        const broker = await db.machine.create({ data: { id: `external-health-broker-${owner.id}`, accountId: owner.id,
            metadata: '{}', kind: 'persistent', operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const resource = await db.teamCredentialResource.create({ data: { teamId: team.id, custodianAccountId: owner.id,
            displayName: storedPlainPrivateLabel('External source'), disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', brokerMachineId: broker.id,
            sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account', target: { kind: 'account', account }, credentialIncarnation: credential.id }),
            memberGrants: { create: { teamMembershipId: member.id, deliveryMode: 'brokered' } } } });
        const key = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, { authentication: TEST_AUTHENTICATION,
            actorAccountId: owner.id, resourceId: resource.id, teamMembershipId: member.id, keyId: crypto.randomUUID(), label: plainPrivateLabel('Source health'), expiresAt: null }));
        if (!key.ok) throw new Error(key.error);
        const dispatch = vi.fn(async (_input: Parameters<ExternalProviderBrokerDispatch>[0]) => ({ ok: true as const,
            statusCode: 200, headers: {}, body: (async function* () { yield Buffer.from('{}'); })() }));
        const app = Fastify();
        registerExternalProviderApiRoutes(app as never, { env: { ...process.env, ...DEPLOYED_ROUTE_GRANT_SIGNING_ENV,
            HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: '1', HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test' },
            dispatch, readCurrentBrokerPresence: async () => ({ state: 'known', machineIds: new Set([broker.id]) }),
            readPoolSourceEligibility: async () => ({ eligibleMachineIds: new Set([broker.id]) }) });
        await app.ready();
        const send = () => app.inject({ method: 'POST', url: '/api/provider-broker/v1/chat/completions',
            headers: { authorization: `Bearer ${key.token}` }, payload: { model: 'model-1', messages: [] } });
        try {
            expect((await send()).statusCode).toBe(200);
            const opened = dispatch.mock.calls[0]![0];
            await db.serviceAccountToken.update({ where: { id: credential.id }, data: { metadata: { ...metadata,
                health: { v: 1, status: 'needs_reauth', reconnectRequired: true } } } });
            dispatch.mockClear();
            const refused = await send();
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toMatchObject({ error: { code: 'connected_service_credential_reconnect_required' } });
            expect(dispatch).not.toHaveBeenCalled();
            const admission = await inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
                authenticatedBrokerAccountId: owner.id, observedAt: new Date(), request: { v: 1,
                    binding: { v: 1, kind: 'external_api_key', teamId: team.id, resourceId: resource.id,
                        externalApiKeyId: key.key.keyId, assignedAccountId: recipient.id, assignedTeamMembershipId: member.id,
                        requestId: opened.request.requestId, operationId: opened.target.operationId,
                        brokerPlacementFingerprint: opened.target.brokerPlacementFingerprint },
                    brokerMachineId: broker.id, expectedResourceRevision: resource.revision,
                    application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'chat', protocol: 'openai-chat' },
                    requestFacts: { generation: true, routeKind: 'openai_chat_completions', modelId: 'model-1', reasoningEffort: null } },
            }));
            expect(admission).toEqual({ ok: false, reasonCode: 'connected_service_credential_reconnect_required' });
            expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);
            await db.serviceAccountToken.update({ where: { id: credential.id }, data: { metadata } });
            expect((await send()).statusCode).toBe(200);
        } finally { await app.close(); }
    });

    it("keeps a Pool-backed key's operation on the one Machine that established it; Pool tier changes affect only future opens", async () => {
        const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Pool-backed external ingress" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const broker = await db.machine.create({
            data: {
                id: `external-pool-broker-${manager.id}`,
                accountId: manager.id,
                metadata: "{}",
                kind: "persistent",
                active: true,
                operationProtocolCapabilities: {
                    providerBrokerIngress: { protocolVersions: [1] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: "a".repeat(64) },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const fallbackBroker = await db.machine.create({
            data: {
                id: `external-pool-fallback-${manager.id}`,
                accountId: manager.id,
                metadata: "{}",
                kind: "persistent",
                active: true,
                operationProtocolCapabilities: {
                    providerBrokerIngress: { protocolVersions: [1] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: "b".repeat(64) },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const pool = await db.machinePool.create({
            data: {
                id: `external-broker-pool-${manager.id}`,
                accountId: manager.id,
                name: "External broker Pool",
                members: { create: [
                    { machineId: broker.id, priorityTier: 0, enabled: true },
                    { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
                ] },
            },
        });
        const resource = await db.teamCredentialResource.create({
            data: {
                teamId: team.id,
                custodianAccountId: manager.id,
                displayName: storedPlainPrivateLabel("Pool ingress provider"),
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "provider_connection",
                    connectionId: "pool-ingress-connection",
                    connectionSecurityFingerprint: "connection-security:v1:pool-ingress",
                    credentialSlotId: "apiKey",
                }),
                brokerPoolId: pool.id,
                memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
            },
        });
        const created = await inTx((tx) => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id,
            resourceId: resource.id,
            teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("Pool-backed client"),
            expiresAt: null,
        }));
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const laterKey = await inTx((tx) => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: manager.id,
            resourceId: resource.id,
            teamMembershipId: membership.id,
            keyId: crypto.randomUUID(), label: plainPrivateLabel("Later Pool-backed client"),
            expiresAt: null,
        }));
        expect(laterKey.ok).toBe(true);
        if (!laterKey.ok) return;

        // True system boundaries only: daemon socket presence, the per-Machine
        // eligibility RPC and the Home→broker relay. Placement, the Pool rows,
        // the key owner and the admission owner (which commits the UsageEvent)
        // are the real ones.
        let presentMachineIds = new Set([broker.id, fallbackBroker.id]);
        let sourceEligibleMachineIds = new Set([broker.id, fallbackBroker.id]);
        let sourceEligibilityUnavailable = false;
        const dispatch = vi.fn(async (_input: Parameters<ExternalProviderBrokerDispatch>[0]) => ({
            ok: true as const,
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: (async function* () { yield Buffer.from('{"ok":true}'); })(),
        }));
        const app = Fastify();
        registerExternalProviderApiRoutes(app as never, {
            env: {
                ...process.env,
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
                ...DEPLOYED_ROUTE_GRANT_SIGNING_ENV,
            },
            dispatch,
            readCurrentBrokerPresence: async () => ({ state: "known", machineIds: new Set(presentMachineIds) }),
            readPoolSourceEligibility: async ({ machineIds }) => {
                if (sourceEligibilityUnavailable) throw new Error("eligibility transport unavailable");
                return {
                    eligibleMachineIds: new Set(machineIds.filter((machineId) => sourceEligibleMachineIds.has(machineId))),
                };
            },
        });
        await app.ready();
        const application = {
            implementationIdentity: { pluginId: "happier.provider.cliproxyapi", localId: "cliproxyapi" },
            endpointTemplateId: "cliproxyapi-openai-chat",
            protocol: "openai-chat",
        } as const;
        /** One public inference through the real route; the Machine it was dispatched to. */
        const send = async (token: string) => {
            dispatch.mockClear();
            const response = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${token}` },
                payload: { model: "model-1", messages: [] },
            });
            const dispatched = dispatch.mock.calls[0]?.[0];
            return response.statusCode === 200 && dispatched
                ? { brokerMachineId: dispatched.target.brokerMachineId, requestId: dispatched.request.requestId,
                    operationId: dispatched.target.operationId, brokerPlacementFingerprint: dispatched.target.brokerPlacementFingerprint }
                : { status: response.statusCode };
        };
        /** The dispatched broker's admission of that exact request, by the real Home owner. */
        const admitOn = (keyId: string, brokerMachineId: string, requestId: string, operationId: string | null, brokerPlacementFingerprint: string, expectedResourceRevision = resource.revision) => inTx((tx) => (
            admitTeamCredentialExternalProviderRequestInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                observedAt: new Date(),
                request: {
                    v: 1,
                    binding: {
                        v: 1,
                        kind: "external_api_key",
                        teamId: team.id,
                        resourceId: resource.id,
                        requestId,
                        externalApiKeyId: keyId,
                        operationId,
                        brokerPlacementFingerprint,
                        assignedAccountId: recipient.id,
                        assignedTeamMembershipId: membership.id,
                    },
                    brokerMachineId,
                    expectedResourceRevision,
                    application,
                    requestFacts: {
                        generation: true,
                        routeKind: "openai_chat_completions",
                        modelId: "model-1",
                        reasoningEffort: null,
                    },
                },
            })
        ));
        /** Public request → exact dispatch → broker admission; the Machine that served it. */
        const serve = async (key: Readonly<{ token: string; keyId: string }>) => {
            const dispatched = await send(key.token);
            if (!("brokerMachineId" in dispatched) || typeof dispatched.requestId !== "string") return dispatched;
            const admitted = await admitOn(key.keyId, dispatched.brokerMachineId, dispatched.requestId, dispatched.operationId, dispatched.brokerPlacementFingerprint);
            expect(admitted, `admission on ${dispatched.brokerMachineId}`).toMatchObject({
                ok: true,
                brokerMachineId: dispatched.brokerMachineId,
                resourceId: resource.id,
            });
            return dispatched.brokerMachineId;
        };
        // Pool edits go through the real Pool owner, as the Machine Pools editor does.
        const noDaemonSockets = { in: () => ({ fetchSockets: async () => [] }) };
        let poolRevision = pool.revision;
        const setPoolMembers = async (members: Array<{ machineId: string; priorityTier: number; enabled: boolean }>) => {
            const updated = await updateMachinePool({
                accountId: manager.id,
                input: { poolId: pool.id, expectedRevision: poolRevision, name: pool.name, members },
                io: noDaemonSockets,
            });
            if (!updated.ok) throw new Error(`Pool update refused: ${JSON.stringify(updated.error)}`);
            poolRevision = updated.value.pool.revision;
        };
        const firstKey = { token: created.token, keyId: created.key.keyId };
        const secondKey = { token: laterKey.token, keyId: laterKey.key.keyId };
        try {
            // A fresh selection still refuses rather than rotating when its
            // chosen member changes between ranking and the final recheck.
            let presenceReadCount = 0;
            await expect(resolveTeamCredentialExternalBrokerPlacement({
                externalApiKeyId: created.key.keyId,
                observedAt: new Date(),
                signal: new AbortController().signal,
                readCurrentPresence: async () => {
                    presenceReadCount += 1;
                    if (presenceReadCount === 2) {
                        await setPoolMembers([
                            { machineId: broker.id, priorityTier: 0, enabled: false },
                            { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
                        ]);
                    }
                    return { state: "known", machineIds: new Set([broker.id, fallbackBroker.id]) };
                },
                readPoolSourceEligibility: async () => ({ eligibleMachineIds: new Set([broker.id, fallbackBroker.id]) }),
            })).resolves.toEqual({ ok: false, error: "broker_unavailable" });
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 0, enabled: true },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
            ]);

            // Dispatch must already own the target, before a daemon admission
            // or UsageEvent exists. A second request cannot establish B while
            // the first request to A is still in flight or ambiguous.
            const catalog = await app.inject({
                method: "GET", url: "/api/provider-broker/v1/models",
                headers: { authorization: `Bearer ${firstKey.token}` },
            });
            expect(catalog.statusCode).toBe(200);
            expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({
                where: { id: firstKey.keyId },
            })).currentBrokerOperationJson).toBeNull();
            const beforeAdmission = await send(firstKey.token);
            expect(beforeAdmission).toMatchObject({ brokerMachineId: broker.id });
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 5, enabled: true },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
            ]);
            expect(await send(firstKey.token)).toMatchObject({ brokerMachineId: broker.id });

            // The first admitted inference consumes that retained operation.
            await expect(serve(firstKey)).resolves.toBe(broker.id);

            // Tier reordering, disabling and removing members affect future
            // opens only (L11/03:147 step 7): the key's later requests never
            // rerank onto another member while its operation holds.
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 5, enabled: true },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
            ]);
            await expect(serve(firstKey)).resolves.toBe(broker.id);
            // A genuinely new operation (another key) follows the current tiers.
            const concurrentOpens = await Promise.all([0, 1].map(() => resolveTeamCredentialExternalBrokerPlacement({
                externalApiKeyId: secondKey.keyId,
                observedAt: new Date(), signal: new AbortController().signal,
                readCurrentPresence: async () => ({ state: "known", machineIds: new Set(presentMachineIds) }),
                readPoolSourceEligibility: async () => ({ eligibleMachineIds: sourceEligibleMachineIds }),
            })));
            expect(concurrentOpens[0]).toMatchObject({ ok: true, brokerMachineId: fallbackBroker.id, operationId: expect.any(String) });
            expect(concurrentOpens[1]).toEqual(concurrentOpens[0]);
            await expect(serve(secondKey)).resolves.toBe(fallbackBroker.id);
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 5, enabled: false },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
            ]);
            await expect(serve(firstKey)).resolves.toBe(broker.id);
            await setPoolMembers([{ machineId: fallbackBroker.id, priorityTier: 1, enabled: true }]);
            await expect(serve(firstKey)).resolves.toBe(broker.id);

            // Failed readiness is not a retirement witness. A may retain its
            // operation, so neither ineligibility nor transport failure may
            // silently establish another operation on B.
            sourceEligibleMachineIds = new Set([fallbackBroker.id]);
            await expect(send(firstKey.token)).resolves.toEqual({ status: 503 });
            expect(dispatch).not.toHaveBeenCalled();
            sourceEligibleMachineIds = new Set([broker.id, fallbackBroker.id]);
            sourceEligibilityUnavailable = true;
            await expect(send(firstKey.token)).resolves.toEqual({ status: 503 });
            expect(dispatch).not.toHaveBeenCalled();
            sourceEligibilityUnavailable = false;
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 0, enabled: true },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
            ]);
            await expect(serve(firstKey)).resolves.toBe(broker.id);

            // Missing presence cannot distinguish a disconnected retained
            // operation from shutdown. The original exact target remains the
            // only target when it reconnects.
            presentMachineIds = new Set([fallbackBroker.id]);
            await expect(send(firstKey.token)).resolves.toEqual({ status: 503 });
            expect(dispatch).not.toHaveBeenCalled();
            presentMachineIds = new Set([broker.id, fallbackBroker.id]);
            await expect(serve(firstKey)).resolves.toBe(broker.id);

            // Only the retained exact custodian can retire it. A new operation
            // then follows current tiers, and a delayed old acknowledgement
            // cannot clear that new operation.
            if (!("operationId" in beforeAdmission) || !beforeAdmission.operationId) throw new Error("expected operation");
            const retire = (machineId: string, operationId: string) => inTx((tx) => retireExternalBrokerOperationInTx(tx, {
                authenticatedAccountId: manager.id, authenticatedMachineId: machineId,
                externalApiKeyId: firstKey.keyId, operationId,
            }));
            await expect(retire(fallbackBroker.id, beforeAdmission.operationId)).resolves.toEqual({ ok: false, reasonCode: "resource_forbidden" });
            await expect(retire(broker.id, beforeAdmission.operationId)).resolves.toEqual({ ok: true, retired: true });
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 5, enabled: true },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: true },
            ]);
            const reopened = await send(firstKey.token);
            expect(reopened).toMatchObject({ brokerMachineId: fallbackBroker.id });
            await expect(retire(broker.id, beforeAdmission.operationId)).resolves.toEqual({ ok: true, retired: false });
            expect(await send(firstKey.token)).toEqual(expect.objectContaining({
                brokerMachineId: fallbackBroker.id,
                operationId: "operationId" in reopened ? reopened.operationId : null,
            }));

            // With no established operation and no enabled member there is no
            // target; nothing is dispatched.
            await setPoolMembers([
                { machineId: broker.id, priorityTier: 0, enabled: false },
                { machineId: fallbackBroker.id, priorityTier: 1, enabled: false },
            ]);
            const unplacedKey = await inTx((tx) => createTeamCredentialExternalApiKeyInTx(tx, {
                authentication: TEST_AUTHENTICATION,
                actorAccountId: manager.id,
                resourceId: resource.id,
                teamMembershipId: membership.id,
                keyId: crypto.randomUUID(), label: plainPrivateLabel("Unplaced Pool-backed client"),
                expiresAt: null,
            }));
            if (!unplacedKey.ok) throw new Error("expected a third key");
            await expect(send(unplacedKey.token)).resolves.toEqual({ status: 503 });
            expect(dispatch).not.toHaveBeenCalled();

            // A Home claim can commit before the first dispatch reaches the
            // daemon. Moving the resource must not silently clear that claim;
            // the existing explicit key replacement is the recovery path.
            await setPoolMembers([{ machineId: broker.id, priorityTier: 0, enabled: true }]);
            const stranded = await resolveTeamCredentialExternalBrokerPlacement({
                externalApiKeyId: unplacedKey.key.keyId,
                observedAt: new Date(), signal: new AbortController().signal,
                readCurrentPresence: async () => ({ state: "known", machineIds: presentMachineIds }),
                readPoolSourceEligibility: async () => ({ eligibleMachineIds: sourceEligibleMachineIds }),
            });
            expect(stranded).toMatchObject({ ok: true, brokerMachineId: broker.id, operationId: expect.any(String) });
            expect(dispatch).not.toHaveBeenCalled();
            expect(await db.usageEvent.count({ where: { teamCredentialExternalApiKeyId: unplacedKey.key.keyId } })).toBe(0);
            const replacementPool = await db.machinePool.create({ data: {
                id: crypto.randomUUID(), accountId: manager.id, name: "Replacement broker pool",
                members: { create: { machineId: fallbackBroker.id, priorityTier: 0, enabled: true } },
            } });
            const relocated = await inTx(tx => updateTeamCredentialResourceInTx(tx, {
                actorAccountId: manager.id, authentication: TEST_AUTHENTICATION,
                patch: { resourceId: resource.id, expectedRevision: resource.revision,
                    brokerPlacement: { kind: "machine_pool", poolId: replacementPool.id } },
            }));
            expect(relocated).toMatchObject({ ok: true });
            if (!relocated.ok || !stranded.ok) throw new Error("expected relocation and retained operation");
            await expect(send(unplacedKey.token)).resolves.toEqual({ status: 503 });
            expect(dispatch).not.toHaveBeenCalled();
            const retained = await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: unplacedKey.key.keyId } });
            if (retained.currentBrokerOperationJson === null) throw new Error("expected stranded binding to remain");
            expect(readExternalBrokerOperation(retained.currentBrokerOperationJson)).toMatchObject({ operationId: stranded.operationId });
            await expect(inTx(tx => revokeTeamCredentialExternalApiKeyInTx(tx, {
                actorAccountId: manager.id, resourceId: resource.id, keyId: unplacedKey.key.keyId,
                authentication: TEST_AUTHENTICATION,
            }))).resolves.toMatchObject({ ok: true, revoked: true });
            const replacementKey = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
                actorAccountId: manager.id, resourceId: resource.id, teamMembershipId: membership.id,
                keyId: crypto.randomUUID(), label: plainPrivateLabel("Unplaced Pool-backed client"), expiresAt: null, authentication: TEST_AUTHENTICATION,
            }));
            if (!replacementKey.ok) throw new Error("expected replacement key");
            expect(replacementKey.key.keyId).not.toBe(unplacedKey.key.keyId);
            await expect(send(unplacedKey.token)).resolves.toEqual({ status: 401 });
            const fresh = await send(replacementKey.token);
            expect(fresh).toMatchObject({ brokerMachineId: fallbackBroker.id });
            if (!("brokerMachineId" in fresh) || typeof fresh.brokerMachineId !== "string") {
                throw new Error("expected replacement dispatch");
            }
            await expect(admitOn(replacementKey.key.keyId, fresh.brokerMachineId, fresh.requestId,
                fresh.operationId, fresh.brokerPlacementFingerprint, relocated.revision))
                .resolves.toMatchObject({ ok: true, brokerMachineId: fallbackBroker.id });
        } finally {
            await app.close();
        }
    }, 180_000);

    it("reaches the real authenticated HTTP handler with a generated underscore key, records admission/terminal/lastUsedAt, then denies after revoke/member removal without leaking", async () => {
        const enabledEnv: NodeJS.ProcessEnv = {
            ...process.env,
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            ...DEPLOYED_ROUTE_GRANT_SIGNING_ENV,
        };
        const dispatch = vi.fn(async (_input: Parameters<ExternalProviderBrokerDispatch>[0]) => ({
            ok: true as const,
            statusCode: 200,
            headers: { "content-type": "application/json", authorization: "must-not-forward" },
            body: (async function* () {
                yield Buffer.from(JSON.stringify({ ok: true, data: "provider-result" }));
            })(),
        }));

        const app = Fastify();
        // The custodian's broker Machine must be currently connected before the
        // Home forwards anything to it; this stands in for the Socket.IO room
        // the route reads through `getMachineDaemonPresenceInventory`.
        const connectedBrokerMachineIds = new Set<string>();
        registerExternalProviderApiRoutes(app as never, {
            env: enabledEnv,
            dispatch: dispatch as never,
            readCurrentBrokerPresence: async () => ({ state: "known", machineIds: connectedBrokerMachineIds }),
            // The source-eligibility RPC is a separate daemon boundary from presence.
            readPoolSourceEligibility: async ({ machineIds }) => ({ eligibleMachineIds: new Set(machineIds) }),
        });
        await app.ready();
        try {
            const manager = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
            const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
            const team = await db.team.create({ data: { name: "External ingress network" } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "owner" } });
            const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: "member" } });
            expect(membership.id).not.toBe(recipient.id);
            const broker = await db.machine.create({
                data: {
                    id: `external-ingress-broker-${manager.id}`,
                    accountId: manager.id,
                    metadata: "{}",
                    kind: "persistent",
                    active: true,
                    operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
                    operationProtocolCapabilitiesRevision: 1,
                },
            });
            connectedBrokerMachineIds.add(broker.id);
            const resource = await db.teamCredentialResource.create({
                data: {
                    teamId: team.id,
                    custodianAccountId: manager.id,
                    displayName: storedPlainPrivateLabel("Ingress provider"),
                    disclosureCeiling: "brokered_only",
                    sessionUsePolicy: "personal_allowed",
                    sourceBindingJson: JSON.stringify({
                        v: 1,
                        kind: "provider_connection",
                        connectionId: "ingress-connection-1",
                        connectionSecurityFingerprint: "connection-security:v1:ingress",
                        credentialSlotId: "apiKey",
                    }),
                    brokerMachineId: broker.id,
                    memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
                },
            });

            // Generated key through the real owner (random secret) plus a deterministic
            // underscore-containing key through the identical digest path. Both must parse.
            const generated = await inTx((tx) => createTeamCredentialExternalApiKeyInTx(tx, {
                authentication: TEST_AUTHENTICATION,
                actorAccountId: manager.id,
                resourceId: resource.id,
                teamMembershipId: membership.id,
                keyId: crypto.randomUUID(), label: plainPrivateLabel("Generated runner"),
                expiresAt: null,
            }));
            expect(generated.ok).toBe(true);
            if (!generated.ok) return;
            expect(generated.token).toMatch(/^hapek_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);

            const underscoreKeyId = "550e8400-e29b-41d4-a716-446655440001";
            const underscoreSecret = "_-A".repeat(14) + "_";
            expect(underscoreSecret).toHaveLength(43);
            const underscoreToken = formatTeamCredentialExternalApiKeyV1({ keyId: underscoreKeyId, secret: underscoreSecret });
            await db.teamCredentialExternalApiKey.create({
                data: {
                    id: underscoreKeyId,
                    resourceId: resource.id,
                    teamMembershipId: membership.id,
                    label: storedPlainPrivateLabel("Underscore runner"),
                    displayPrefix: createTeamCredentialExternalApiKeyDisplayPrefixV1(underscoreKeyId),
                    secretDigest: digestForTest(underscoreSecret),
                    createdAt: new Date(),
                    expiresAt: null,
                },
            });

            // Verification probes never count as use.
            expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: underscoreKeyId } })).lastUsedAt).toBeNull();
            await expect(inTx((tx) => verifyTeamCredentialExternalApiKeyInTx(tx, { token: underscoreToken }))).resolves.toMatchObject({
                ok: true,
                keyId: underscoreKeyId,
                resourceId: resource.id,
                assignedAccountId: recipient.id,
            });
            expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: underscoreKeyId } })).lastUsedAt).toBeNull();

            // Feature-off rejects before key lookup or broker dispatch.
            const disabledApp = Fastify();
            const disabledDispatch = vi.fn();
            registerExternalProviderApiRoutes(disabledApp as never, { env: {}, dispatch: disabledDispatch as never });
            await disabledApp.ready();
            try {
                const off = await disabledApp.inject({
                    method: "POST",
                    url: "/api/provider-broker/v1/chat/completions",
                    headers: { authorization: `Bearer ${underscoreToken}` },
                    payload: { model: "model-1", messages: [] },
                });
                expect(off.statusCode).toBe(404);
                expect(off.json()).toEqual({ error: "not_found" });
                expect(disabledDispatch).not.toHaveBeenCalled();
            } finally {
                await disabledApp.close();
            }

            // Master-off with child-on still fails closed through the canonical dependency.
            const masterOffApp = Fastify();
            const masterOffDispatch = vi.fn();
            registerExternalProviderApiRoutes(masterOffApp as never, {
                env: {
                    ...process.env,
                    HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                    HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "0",
                    HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
                },
                dispatch: masterOffDispatch as never,
            });
            await masterOffApp.ready();
            try {
                const masterOff = await masterOffApp.inject({
                    method: "POST",
                    url: "/api/provider-broker/v1/chat/completions",
                    headers: { authorization: `Bearer ${underscoreToken}` },
                    payload: { model: "model-1", messages: [] },
                });
                expect(masterOff.statusCode).toBe(404);
                expect(masterOffDispatch).not.toHaveBeenCalled();
            } finally {
                await masterOffApp.close();
            }

            // Malformed, Account PAT, unknown, and tampered bearers share one opaque 401
            // and never reach the mocked upstream carrier.
            const malformedBodies: string[] = [];
            for (const bad of [
                "not-a-key",
                `hap_v1_${underscoreKeyId}_${underscoreSecret}`,
                `hapek_v1_${underscoreKeyId}_!`.padEnd(60, "!"),
                `hapek_v1_00000000-0000-4000-8000-000000000000_${underscoreSecret}`,
                `${underscoreToken.slice(0, -1)}B`,
            ]) {
                const response = await app.inject({
                    method: "POST",
                    url: "/api/provider-broker/v1/chat/completions",
                    headers: { authorization: `Bearer ${bad}` },
                    payload: { model: "model-1", messages: [] },
                });
                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({
                    error: { type: "happier_provider_broker_error", code: "invalid_api_key", message: "Invalid API key." },
                });
                malformedBodies.push(response.body);
            }
            expect(dispatch).not.toHaveBeenCalled();
            for (const body of malformedBodies) {
                expect(body).not.toContain(underscoreSecret);
                expect(body).not.toContain(underscoreKeyId);
                expect(body).not.toContain(resource.id);
            }
            // Conflicting duplicate credentials fail closed as unauthorized.
            const conflict = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${underscoreToken}`, "x-api-key": generated.token },
                payload: { model: "model-1", messages: [] },
            });
            expect(conflict.statusCode).toBe(401);
            expect(dispatch).not.toHaveBeenCalled();

            // Valid underscore key reaches the mocked upstream with the strict DTO only.
            const valid = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${underscoreToken}`, "content-type": "application/json" },
                payload: { model: "model-1", messages: [{ role: "user", content: "hello" }] },
            });
            expect(valid.statusCode).toBe(200);
            expect(valid.headers["cache-control"]).toBe("no-store");
            expect(valid.headers.authorization).toBeUndefined();
            expect(valid.json()).toEqual({ ok: true, data: "provider-result" });
            expect(dispatch).toHaveBeenCalledTimes(1);
            const call = dispatch.mock.calls[0]?.[0] as unknown as Readonly<{
                target: Readonly<{ custodianAccountId: string; brokerMachineId: string }>;
                request: Readonly<Record<string, unknown>>;
            }>;
            const retainedOperation = (await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: underscoreKeyId } })).currentBrokerOperationJson;
            const operation = retainedOperation === null ? null : readExternalBrokerOperation(retainedOperation);
            if (!operation) throw new Error("expected the dispatched operation to be retained");
            expect(call.target).toEqual({
                custodianAccountId: manager.id,
                brokerMachineId: broker.id,
                operationId: operation.operationId,
                brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource),
            });
            expect(call.request).toMatchObject({
                resourceId: resource.id,
                teamId: team.id,
                caller: {
                    kind: "external_api_key",
                    keyId: underscoreKeyId,
                    assignedAccountId: recipient.id,
                    assignedTeamMembershipId: membership.id,
                },
                route: "chat_completions",
                method: "POST",
                pathAndQuery: "/v1/chat/completions",
            });
            expect(call.request).not.toHaveProperty("machineId");
            expect(call.request).not.toHaveProperty("host");
            expect(call.request).not.toHaveProperty("bearer");
            expect(call.request).not.toHaveProperty("secret");
            expect(JSON.stringify(call.request)).not.toContain(underscoreSecret);
            expect(call.request.headers).toMatchObject({ "content-type": "application/json" });
            expect(call.request.headers).not.toHaveProperty("authorization");
            expect(call.request.headers).not.toHaveProperty("cookie");
            expect(call.request.headers).not.toHaveProperty("x-api-key");

            // The actual public boundary rechecks the assigned member's proof.
            await db.account.update({ where: { id: recipient.id }, data: { encryptionMode: "e2ee" } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } } });
            const restrictedRequest = () => app.inject({
                method: "POST", url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${underscoreToken}` }, payload: { model: "model-1", messages: [] },
            });
            dispatch.mockClear();
            expect((await restrictedRequest()).statusCode).toBe(401);
            expect(dispatch).not.toHaveBeenCalled();
            await expect(inTx(tx => authorizeTeamCredentialExternalApiKeyInTx(tx, {
                actorAccountId: recipient.id, resourceId: resource.id, keyId: underscoreKeyId,
                authentication: { ...TEST_AUTHENTICATION,
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }] },
            }))).resolves.toMatchObject({ ok: true });
            expect((await restrictedRequest()).statusCode).toBe(200);
            dispatch.mockClear();
            await db.account.update({ where: { id: recipient.id }, data: { publicKey: null } });
            expect((await restrictedRequest()).statusCode).toBe(401);
            expect(dispatch).not.toHaveBeenCalled();
            await db.account.update({ where: { id: recipient.id }, data: { publicKey: recipient.publicKey, encryptionMode: "plain" } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 1, mode: "inherit" } } });

            // Anthropic-compatible header agrees with the same key.
            dispatch.mockClear();
            const anthropic = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/messages",
                headers: { "x-api-key": underscoreToken, "content-type": "application/json" },
                payload: { model: "model-1", messages: [] },
            });
            expect(anthropic.statusCode).toBe(200);
            expect(dispatch).toHaveBeenCalledTimes(1);

            // Edge verification alone still does not count as admitted use.
            expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: underscoreKeyId } })).lastUsedAt).toBeNull();

            // Exact resource currentness + request-count admission before any upstream forward.
            const admittedAt = new Date("2026-09-07T12:34:56.000Z");
            const application = {
                agentTargetKey: "agent:happier.agent.codex/codex",
                implementationIdentity: { pluginId: "happier.provider.cliproxyapi", localId: "cliproxyapi" },
                endpointTemplateId: "cliproxyapi-openai-responses",
                protocol: "openai-responses" as const,
            };
            const admittedTarget = dispatch.mock.calls[0]![0].target;
            const admissionRequest = (requestId: string) => ({
                v: 1 as const,
                binding: {
                    v: 1 as const,
                    kind: "external_api_key" as const,
                    teamId: team.id,
                    resourceId: resource.id,
                    requestId,
                    externalApiKeyId: underscoreKeyId,
                    operationId: admittedTarget.operationId,
                    brokerPlacementFingerprint: admittedTarget.brokerPlacementFingerprint,
                    assignedAccountId: recipient.id,
                    assignedTeamMembershipId: membership.id,
                },
                brokerMachineId: broker.id,
                expectedResourceRevision: resource.revision,
                application,
                requestFacts: { generation: true, routeKind: "openai_responses" as const, modelId: "model-1", reasoningEffort: null },
            });
            const admission = await inTx((tx) => admitTeamCredentialExternalProviderRequestInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: admissionRequest("ingress-request-1"),
                observedAt: admittedAt,
            }));
            expect(admission).toMatchObject({
                ok: true,
                resourceId: resource.id,
                operation: { kind: "external_api_key", externalApiKeyId: underscoreKeyId },
                usageEventId: expect.any(String),
                terminalRequestId: `external:${underscoreKeyId}:ingress-request-1`,
            });
            if (!admission.ok || !admission.usageEventId || !admission.terminalRequestId) throw new Error("expected admitted ingress request");
            expect((await db.teamCredentialExternalApiKey.findUniqueOrThrow({ where: { id: underscoreKeyId } })).lastUsedAt).toEqual(admittedAt);
            expect(await db.usageEvent.count({
                where: { teamCredentialResourceId: resource.id, source: "team_credential_admission", requestCount: 1 },
            })).toBe(1);

            // Stale revision and detached broker identity never admit.
            await expect(inTx((tx) => admitTeamCredentialExternalProviderRequestInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: { ...admissionRequest("stale-revision"), expectedResourceRevision: resource.revision + 99 },
                observedAt: new Date(admittedAt.getTime() + 10),
            }))).resolves.toEqual({ ok: false, reasonCode: "resource_changed" });
            await expect(inTx((tx) => admitTeamCredentialExternalProviderRequestInTx(tx, {
                authenticatedBrokerAccountId: "someone-else",
                request: admissionRequest("wrong-broker-owner"),
                observedAt: new Date(admittedAt.getTime() + 20),
            }))).resolves.toEqual({ ok: false, reasonCode: "resource_forbidden" });

            // Terminal success, failure, and cancellation each record one immutable fact.
            // The terminal writer correlates on the admission request identity, so each
            // distinct outcome needs its own admitted request to keep the fixture honest.
            const extraAdmissions: Array<{ requestId: string; usageEventId: string; terminalRequestId: string }> = [];
            for (const suffix of ["failed", "cancelled"]) {
                const extra = await inTx((tx) => admitTeamCredentialExternalProviderRequestInTx(tx, {
                    authenticatedBrokerAccountId: manager.id,
                    request: admissionRequest(`ingress-request-${suffix}`),
                    observedAt: new Date(admittedAt.getTime() + 30),
                }));
                expect(extra.ok).toBe(true);
                if (!extra.ok || !extra.usageEventId || !extra.terminalRequestId) throw new Error("expected extra admission");
                extraAdmissions.push({ requestId: `ingress-request-${suffix}`, usageEventId: extra.usageEventId, terminalRequestId: extra.terminalRequestId });
            }
            // A public external call has no Session turn and no Agent publisher, so the
            // broker's own observation of the admitted response is its only token fact.
            const reportedTerminalUsage = {
                v: 1 as const,
                admissionUsageEventId: admission.usageEventId as string,
                requestId: admission.terminalRequestId as string,
                brokerMachineId: broker.id,
                completedAtMs: admittedAt.getTime() + 250,
                outcome: "succeeded" as const,
                measurement: "reported" as const,
                actualModelId: "model-1-2026-01",
                tokens: { input: 120, output: 45, reasoning: 30, cacheRead: 80, cacheWrite: 0, total: 165 },
            };
            const succeeded = await inTx((tx) => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: reportedTerminalUsage,
            }));
            expect(succeeded).toMatchObject({ ok: true, created: true });
            if (!succeeded.ok) throw new Error(`Expected terminal usage admission, received ${succeeded.reasonCode}`);
            expect(await db.usageEvent.findUniqueOrThrow({ where: { id: succeeded.usageEventId } }))
                .toMatchObject({
                    source: "team_credential_external_terminal",
                    requestCount: 0,
                    modelId: "model-1-2026-01",
                    inputTokens: 120,
                    outputTokens: 45,
                    reasoningTokens: 30,
                    cacheReadTokens: 80,
                    cacheWriteTokens: 0,
                    totalTokens: 165,
                    // Cost stays unknown: no canonical price covers these routes,
                    // and an unknown cost is never recorded as a zero-cost request.
                    costSource: null,
                    reportedCostUsd: null,
                    estimatedCostUsd: null,
                    invoiceCostUsd: null,
                });
            const failedAdmission = extraAdmissions[0];
            if (!failedAdmission) throw new Error("expected failed admission");
            const failed = await inTx((tx) => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: {
                    v: 1,
                    admissionUsageEventId: failedAdmission.usageEventId,
                    requestId: failedAdmission.terminalRequestId,
                    brokerMachineId: broker.id,
                    completedAtMs: admittedAt.getTime() + 350,
                    outcome: "failed",
                    measurement: "unavailable",
                    actualModelId: null,
                    tokens: null,
                },
            }));
            expect(failed).toMatchObject({ ok: true, created: true });
            const cancelledAdmission = extraAdmissions[1];
            if (!cancelledAdmission) throw new Error("expected cancelled admission");
            const cancelled = await inTx((tx) => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: {
                    v: 1,
                    admissionUsageEventId: cancelledAdmission.usageEventId,
                    requestId: cancelledAdmission.terminalRequestId,
                    brokerMachineId: broker.id,
                    completedAtMs: admittedAt.getTime() + 450,
                    outcome: "cancelled",
                    measurement: "unavailable",
                    actualModelId: null,
                    tokens: null,
                },
            }));
            expect(cancelled).toMatchObject({ ok: true, created: true });
            // Duplicate terminal report is idempotent, not a second fact.
            await expect(inTx((tx) => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: reportedTerminalUsage,
            }))).resolves.toMatchObject({ ok: true, created: false });
            // A second, disagreeing token fact for the same request fails closed
            // rather than overwriting the observation already recorded.
            await expect(inTx((tx) => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
                authenticatedBrokerAccountId: manager.id,
                request: {
                    ...reportedTerminalUsage,
                    tokens: { ...reportedTerminalUsage.tokens, output: 46, total: 166 },
                },
            }))).resolves.toEqual({ ok: false, reasonCode: "terminal_usage_mismatch" });

            // Disabled resource is currentness-denied at the edge with the same opaque 401.
            dispatch.mockClear();
            await db.teamCredentialResource.update({ where: { id: resource.id }, data: { enabled: false } });
            const disabled = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${underscoreToken}` },
                payload: { model: "model-1", messages: [] },
            });
            expect(disabled.statusCode).toBe(401);
            expect(disabled.json()).toEqual({
                error: { type: "happier_provider_broker_error", code: "invalid_api_key", message: "Invalid API key." },
            });
            expect(dispatch).not.toHaveBeenCalled();
            await db.teamCredentialResource.update({ where: { id: resource.id }, data: { enabled: true } });

            // Revoke denies the next request indistinguishably and preserves safe activity.
            await expect(inTx((tx) => revokeTeamCredentialExternalApiKeyInTx(tx, {
                actorAccountId: manager.id,
                resourceId: resource.id,
                keyId: underscoreKeyId,
                authentication: TEST_AUTHENTICATION,
            }))).resolves.toEqual({ ok: true, keyId: underscoreKeyId, revoked: true });
            const afterRevoke = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${underscoreToken}` },
                payload: { model: "model-1", messages: [] },
            });
            expect(afterRevoke.statusCode).toBe(401);
            expect(afterRevoke.json()).toEqual({
                error: { type: "happier_provider_broker_error", code: "invalid_api_key", message: "Invalid API key." },
            });
            expect(afterRevoke.body).not.toContain(underscoreSecret);
            expect(dispatch).not.toHaveBeenCalled();
            await expect(inTx((tx) => verifyTeamCredentialExternalApiKeyInTx(tx, { token: underscoreToken }))).resolves.toEqual({
                ok: false,
                reason: "invalid_token",
            });

            // Member removal atomically revokes the generated key and denies it privacy-safely.
            const removal = await inTx((tx) => removeTeamMemberForActorInTx(tx, {
                teamId: team.id,
                actorAccountId: manager.id,
                membershipId: membership.id,
            }));
            expect(removal).toMatchObject({ ok: true, value: { status: "removed" } });
            expect(await db.teamCredentialExternalApiKey.findUnique({ where: { id: generated.key.keyId } })).toBeNull();
            dispatch.mockClear();
            const afterRemoval = await app.inject({
                method: "POST",
                url: "/api/provider-broker/v1/chat/completions",
                headers: { authorization: `Bearer ${generated.token}` },
                payload: { model: "model-1", messages: [] },
            });
            expect(afterRemoval.statusCode).toBe(401);
            expect(afterRemoval.json()).toEqual({
                error: { type: "happier_provider_broker_error", code: "invalid_api_key", message: "Invalid API key." },
            });
            expect(afterRemoval.body).not.toContain(generated.token.slice(-8));
            expect(dispatch).not.toHaveBeenCalled();
            expect(await db.teamCredentialActivityEvent.count({
                where: { resourceId: resource.id, kind: "external_key_revoked" },
            })).toBeGreaterThanOrEqual(1);
        } finally {
            await app.close();
        }
    }, 180_000);

    /**
     * Route-shape cases that used to live in `registerExternalProviderApiRoutes.spec.ts`
     * with a fabricated `verify` result. The route now always resolves the real
     * broker placement before dispatch, so a key that names no stored resource
     * or Machine fails before the boundary these cases are about. They belong
     * here, where the key, resource and broker Machine exist: only the broker
     * transport and the daemon presence room stay substituted, and the request
     * is driven at the handler so client disconnect and late-response
     * publication are observable.
     */
    async function createDirectBrokerIngressFixture(label: string): Promise<Readonly<{
        custodianAccountId: string;
        brokerMachineId: string;
        resourceId: string;
        token: string;
        register: (dependencies: Readonly<Record<string, unknown>>) => Record<string, unknown>[];
    }>> {
        const custodian = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Route shape ${label}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: recipient.id, role: "member" },
        });
        const broker = await db.machine.create({
            data: {
                id: `route-shape-broker-${label}-${custodian.id}`,
                accountId: custodian.id,
                metadata: "{}",
                kind: "persistent",
                active: true,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const resource = await db.teamCredentialResource.create({
            data: {
                teamId: team.id,
                custodianAccountId: custodian.id,
                displayName: `Route shape provider ${label}`,
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "provider_connection",
                    connectionId: `route-shape-connection-${label}`,
                    connectionSecurityFingerprint: `connection-security:v1:route-shape-${label}`,
                    credentialSlotId: "apiKey",
                }),
                brokerMachineId: broker.id,
                memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
            },
        });
        const created = await inTx((tx) => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: TEST_AUTHENTICATION,
            actorAccountId: custodian.id,
            resourceId: resource.id,
            teamMembershipId: membership.id,
            label: `Route shape ${label}`,
            expiresAt: null,
        }));
        if (!created.ok) throw new Error("route-shape fixture requires a real external API key");
        return {
            custodianAccountId: custodian.id,
            brokerMachineId: broker.id,
            resourceId: resource.id,
            token: created.token,
            register: (dependencies) => {
                const routes: Record<string, unknown>[] = [];
                registerExternalProviderApiRoutes(
                    { route: (route: Record<string, unknown>) => routes.push(route) } as never,
                    {
                        env: {
                            ...process.env,
                            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
                            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: "1",
                            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
                            ...DEPLOYED_ROUTE_GRANT_SIGNING_ENV,
                        },
                        readCurrentBrokerPresence: async () => ({ state: "known", machineIds: new Set([broker.id]) }),
                        // Only the daemon's source-eligibility transport is substituted.
                        readPoolSourceEligibility: async ({ machineIds }: { machineIds: readonly string[] }) => ({
                            eligibleMachineIds: new Set(machineIds),
                        }),
                        ...dependencies,
                    } as never,
                );
                return routes;
            },
        };
    }

    it.each(['broker_unavailable', 'update_required'] as const)("preserves the real broker %s response at the public API edge", async reasonCode => {
        const fixture = await createDirectBrokerIngressFixture(`application-${reasonCode}`);
        const broker = Fastify();
        broker.get('/v1/models', (_request, reply) => writeProviderBrokerApplicationFailure(reply, { ok: false, reasonCode }));
        const dispatch: ExternalProviderBrokerDispatch = async () => {
            // Substitute only the remote HTTP transport. The CLI's actual
            // response writer, Home classifier and public ingress stay real.
            const response = await broker.inject({ method: 'GET', url: '/v1/models' });
            const headers = { [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]:
                String(response.headers[PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]) };
            return { ok: false, ...mapProviderBrokerApplicationFailure(response.statusCode, headers) };
        };
        const app = Fastify();
        // The fixture captures the production route registrations for its
        // disconnect probes; install those same options on real Fastify here.
        for (const route of fixture.register({ dispatch })) app.route(route as unknown as RouteOptions);
        try {
            const response = await app.inject({ method: 'GET', url: '/api/provider-broker/v1/models',
                headers: { authorization: `Bearer ${fixture.token}` } });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toMatchObject({ error: { type: 'happier_provider_broker_error', code: 'broker_unavailable' } });
        } finally {
            await app.close();
            await broker.close();
        }
    }, 180_000);

    it("authenticates at the edge and dispatches a strict target-free application DTO", async () => {
        const fixture = await createDirectBrokerIngressFixture("dto");
        const dispatch = vi.fn(async (_input: Parameters<ExternalProviderBrokerDispatch>[0]) => ({
            ok: true as const,
            statusCode: 200,
            headers: { "content-type": "text/event-stream", authorization: "never-forward" },
            body: (async function* () { yield Buffer.from("data: done\n\n"); })(),
        }));
        const routes = fixture.register({ dispatch });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/chat/completions");
        const responseHeaders: Record<string, string> = {};
        const reply = {
            raw: new EventEmitter(),
            header(name: string, value: string) { responseHeaders[name] = value; return this; },
            code: vi.fn(() => reply),
            send: vi.fn((body: unknown) => body),
        };
        await (selected?.handler as (request: unknown, reply: unknown) => Promise<unknown>)({
            // The documented self-hosted deployment puts Nginx in front of this
            // route, so a real public call arrives carrying the forwarding
            // headers that sample adds. They must reach dispatch as a normal
            // request and stay out of the DTO the allowlist builds below.
            headers: {
                authorization: `Bearer ${fixture.token}`,
                "content-type": "application/json",
                forwarded: "for=203.0.113.7;proto=https",
                "x-forwarded-for": "203.0.113.7",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "api.example.com",
                "x-real-ip": "203.0.113.7",
            },
            url: "/api/provider-broker/v1/chat/completions",
            body: { model: "gpt-test", stream: true },
            raw: new EventEmitter(),
        }, reply);
        expect(dispatch).toHaveBeenCalledOnce();
        const call = dispatch.mock.calls[0]?.[0] as Readonly<{
            request: Readonly<Record<string, unknown>>;
        }> | undefined;
        expect(call).toMatchObject({
            target: { custodianAccountId: fixture.custodianAccountId, brokerMachineId: fixture.brokerMachineId },
            request: {
                resourceId: fixture.resourceId,
                caller: { kind: "external_api_key" },
                pathAndQuery: "/v1/chat/completions",
            },
        });
        expect(call?.request).not.toHaveProperty("machineId");
        expect(call?.request).not.toHaveProperty("host");
        expect(call?.request).not.toHaveProperty("bearer");
        expect(call?.request.headers).toEqual({ "content-type": "application/json" });
        expect(Buffer.from(String(call?.request.bodyBase64), "base64").toString("utf8"))
            .toBe(JSON.stringify({ model: "gpt-test", stream: true }));
        expect(responseHeaders.authorization).toBeUndefined();
        expect(responseHeaders["content-type"]).toBe("text/event-stream");
    }, 180_000);

    it("returns the stable public 429 code and Retry-After only for a deterministic exhaustion reset", async () => {
        const fixture = await createDirectBrokerIngressFixture("retry-after");
        const routes = fixture.register({
            nowMs: () => 0,
            dispatch: vi.fn(async () => ({ ok: false as const, error: "team_credential_usage_limit" as const, retryAtMs: 2_000 })),
        });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/responses");
        const headers: Record<string, string> = {};
        const reply = {
            raw: new EventEmitter(),
            header(name: string, value: string) { headers[name] = value; return this; },
            code: vi.fn(() => reply), send: vi.fn((body: unknown) => body),
        };
        await (selected?.handler as (request: unknown, reply: unknown) => Promise<unknown>)({
            headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
            url: "/api/provider-broker/v1/responses", body: { model: "gpt-test", input: "hello" },
            raw: new EventEmitter(),
        }, reply);
        expect(reply.code).toHaveBeenCalledWith(429);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.objectContaining({ code: "team_credential_usage_limit" }),
        }));
        expect(headers["Retry-After"]).toBe("2");
    }, 180_000);

    it("streams broker bytes without eager buffering and cancels the broker request when the client disconnects", async () => {
        const fixture = await createDirectBrokerIngressFixture("streaming");
        const raw = new EventEmitter();
        const replyRaw = new EventEmitter();
        let yieldedChunks = 0;
        let dispatchSignal: AbortSignal | undefined;
        const dispatch = vi.fn(async (input: Readonly<{ signal: AbortSignal }>) => {
            dispatchSignal = input.signal;
            return {
                ok: true as const,
                statusCode: 200,
                headers: { "content-type": "text/event-stream" },
                body: (async function* () {
                    yieldedChunks += 1;
                    yield Buffer.from("data: first\n\n");
                    yieldedChunks += 1;
                    yield Buffer.from("data: second\n\n");
                })(),
            };
        });
        let sent: unknown;
        const reply = {
            raw: replyRaw,
            header() { return this; },
            code: vi.fn(() => reply),
            send: vi.fn((body: unknown) => { sent = body; return body; }),
        };
        const routes = fixture.register({ dispatch });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/chat/completions");
        await (selected?.handler as (request: unknown, reply: unknown) => Promise<unknown>)({
            headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
            url: "/api/provider-broker/v1/chat/completions",
            body: { model: "gpt-test", stream: true },
            raw,
        }, reply);

        expect(sent).toBeInstanceOf(Readable);
        expect(yieldedChunks).toBe(0);
        raw.emit("aborted");
        expect(dispatchSignal?.aborted).toBe(true);
        expect(raw.listenerCount("aborted")).toBe(0);
        expect(replyRaw.listenerCount("close")).toBe(0);
    }, 180_000);

    it("keeps negotiated JSON broker responses incremental and cancels their transport on disconnect", async () => {
        const fixture = await createDirectBrokerIngressFixture("compressed-json-streaming");
        const first = '{"rows":[' + ' '.repeat(2048);
        let aborted = () => {};
        const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
        const dispatch: ExternalProviderBrokerDispatch = async ({ signal }) => ({
            ok: true,
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            // Only the remote broker transport is substituted. The response
            // deliberately stays open until the real client disconnects.
            body: (async function* () {
                signal.addEventListener('abort', aborted, { once: true });
                try {
                    yield Buffer.from(first);
                    await cancelled;
                } finally {
                    signal.removeEventListener('abort', aborted);
                }
            })(),
        });
        const app = Fastify();
        const controller = new AbortController();
        try {
            await enableApiCompression(app);
            for (const route of fixture.register({ dispatch })) app.route(route as unknown as RouteOptions);
            const address = await app.listen({ port: 0, host: '127.0.0.1' });
            const response = await fetch(`${address}/api/provider-broker/v1/chat/completions`, {
                method: 'POST',
                headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'accept-encoding': 'gzip' },
                body: JSON.stringify({ model: 'gpt-test', stream: true }),
                signal: controller.signal,
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-encoding')).toBeNull();
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let received = '';
            while (received.length < first.length) {
                const chunk = await reader.read();
                expect(chunk.done).toBe(false);
                received += decoder.decode(chunk.value, { stream: true });
            }
            expect(received).toBe(first);
            controller.abort();
            await cancelled;
        } finally {
            controller.abort();
            await app.close();
        }
    }, 180_000);

    it("does not publish a late broker response after the external caller aborts", async () => {
        const fixture = await createDirectBrokerIngressFixture("late-response");
        const raw = new EventEmitter();
        type LateDispatchResult = {
            ok: true;
            statusCode: number;
            headers: Record<string, string>;
            body: AsyncIterable<Uint8Array>;
        };
        let resolveDispatch: ((value: LateDispatchResult) => void) | undefined;
        const dispatch = vi.fn(() => new Promise<LateDispatchResult>((resolve) => { resolveDispatch = resolve; }));
        const reply = {
            raw: new EventEmitter(),
            header() { return this; },
            code: vi.fn(() => reply),
            send: vi.fn(),
        };
        const routes = fixture.register({ dispatch });
        const selected = routes.find((route) => route.url === "/api/provider-broker/v1/responses");
        const handling = (selected?.handler as (request: unknown, reply: unknown) => Promise<unknown>)({
            headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
            url: "/api/provider-broker/v1/responses",
            body: { model: "gpt-test", input: "hello" },
            raw,
        }, reply);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        raw.emit("aborted");
        resolveDispatch?.({
            ok: true,
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: (async function* () { yield Buffer.from("late"); })(),
        });
        await handling;
        expect(reply.code).toHaveBeenCalledWith(499);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.objectContaining({ code: "request_cancelled" }),
        }));
        expect(reply.send).not.toHaveBeenCalledWith(expect.any(Readable));
        expect(raw.listenerCount("aborted")).toBe(0);
    }, 180_000);
});
