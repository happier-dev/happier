import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import axios from "axios";

import {
    PeerTcpTunnelRelayAuthorizationPayloadV2Schema,
    PeerTcpTunnelRelayEnvelopeSchema,
    decodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_ACK_AFTER_MS,
    verifyPeerTcpTunnelRelayAuthorizationV2,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { peerMediationGrantSigningEnv } from "@/testkit/env";
import { logger } from "@/utils/logging/log";

import { registerTeamCredentialResourceRoutes } from "./registerTeamCredentialResourceRoutes";
import { createTeamCredentialResourceTestBrokerDispatcher } from "@/app/api/routes/providers/externalProviderBrokerDispatcher";
import { createServer } from "node:http";
import { registerPeerTcpTunnelRelayTerminator } from "../../../../../cli/src/daemon/peer/mediation/tunnel/relay";
import { connectPeerTcpTunnelTcp } from "../../../../../cli/src/daemon/peer/mediation/tunnel/open";
import { startFirstBytesLocalCapabilityProxy } from "../../../../../cli/src/daemon/peer/mediation/loopback/firstBytesLocalCapability";
import { startProviderBrokerApplicationServer, writeProviderBrokerApplicationFailure } from "../../../../../cli/src/providers/broker/providerBrokerApplicationServer";
import { createProviderBrokerRequestHandler } from "../../../../../cli/src/providers/broker/providerBrokerRequestHandler";
import { createQualifiedConnectedAccountIdentityDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { createConnectedServiceCredentialRevision } from "@/app/api/routes/connect/credentials/credentialRevision";
import { TeamCredentialTestActionOutputV1Schema } from "@happier-dev/protocol/teams/credentials/actionsV1";
import { TEAM_CREDENTIAL_RESOURCE_TEST_ADMISSION_HTTP_PATH_V1, TeamCredentialResourceTestAdmissionV1Schema, TeamCredentialResourceTestAdmissionResponseV1Schema } from "@happier-dev/protocol/teams/credentials/externalProviderApiV1";

describe("Resource Test relay composition (SQLite integration)", () => {
    afterEach(() => vi.restoreAllMocks());
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let homeUrl: string;

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
        homeUrl = await app.listen({ host: "127.0.0.1", port: 0 });
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

    async function createAccount() {
        return await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
    }

    it.each(["available", "stalled_activation", "silent_carrier", "slow_response", "source_refusal", "source_reauth", "upstream_unauthorized", "application_exception"] as const)("tests a revision-zero resource through the real broker terminator: %s", async outcome => {
        const realApplication = outcome === "available" || outcome === "application_exception" || outcome === "source_reauth";
        const ordinaryResponse = realApplication || outcome === "available" || outcome === "source_refusal" || outcome === "upstream_unauthorized";
        const custodian = await createAccount();
        const team = await db.team.create({ data: { name: "Initial resource Test" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: "owner" } });
        const broker = await db.machine.create({ data: {
            id: `initial-resource-broker-${custodian.id}`, accountId: custodian.id,
            metadata: "{}", kind: "persistent", active: true,
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: "e".repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const connectedAccount = {
            service: { pluginId: "happier.agent.codex", localId: "openai-codex" },
            accountId: "initial-connected-account",
        };
        const credentialMetadata = { v: 4, storage: 'stored_envelope_v1', credentialRevision: createConnectedServiceCredentialRevision(), values: {} };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: custodian.id, servicePluginId: connectedAccount.service.pluginId,
            serviceLocalId: connectedAccount.service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(connectedAccount.service),
            connectedAccountId: connectedAccount.accountId,
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(connectedAccount),
            authenticationModeId: "api-key", token: Buffer.from("fixture-only"),
            metadata: credentialMetadata,
        } });
        const source = {
            v: 1, kind: "connected_account",
            target: { kind: "account", account: connectedAccount },
            credentialIncarnation: credential.id,
        } as const;
        // Keep the database's initial revision, just as the saved-resource route does.
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: "New source",
            disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify(source), brokerMachineId: broker.id,
        } });
        expect(resource.revision).toBe(0);
        const application = {
            agentTargetKey: "agent:happier.agent.codex/codex",
            implementationIdentity: { pluginId: "happier.provider.openai", localId: "openai" },
            endpointTemplateId: "responses", protocol: "openai-responses",
        } as const;
        const previousPresence = app.machineDaemonPresence;
        const previousRpc = app.forwardRpcForUser;
        const previousDispatch = app.forwardTeamCredentialBrokerResourceTest;
        app.machineDaemonPresence = { in: () => ({ fetchSockets: async () => [{
            data: { clientType: "machine-scoped", userId: custodian.id, machineId: broker.id },
        }] }) };
        // The remote daemon is a genuine process boundary; all route, placement,
        // actor, binding construction, minting and signature checks stay real.
        app.forwardRpcForUser = async () => ({ ok: true, result: {
            status: "success", application,
            request: { v: 1, kind: "resource_test", requestId: "initial-resource-test",
                teamId: team.id, resourceId: resource.id, route: "responses",
                method: "POST", pathAndQuery: "/v1/responses",
                headers: { "content-type": "application/json" },
                bodyBase64: Buffer.from(JSON.stringify({ model: "gpt-5", input: "Reply with OK.", max_output_tokens: 16 })).toString("base64") },
        } });
        const signing = peerMediationGrantSigningEnv();
        const trustRoots = [{ keyId: signing.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID!,
            publicKeyBase64Url: signing.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY! }];
        const relaySocketId = "initial-resource-relay";
        let admitted = false;
        let receive: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | undefined;
        let tunnelId: string | undefined;
        let admissionExpiresAt = 0;
        let opened!: () => void;
        const openSent = new Promise<void>(resolve => { opened = resolve; });
        let brokerReceive: ((payload?: unknown) => void | Promise<void>) | undefined;
        let connecting!: () => void;
        const connectionStarted = new Promise<void>(resolve => { connecting = resolve; });
        let acknowledged = false;
        const brokerFrames: string[] = [];
        let respond: (() => void) | undefined;
        let requestArrived!: () => void;
        const applicationRequestReceived = new Promise<void>(resolve => { requestArrived = resolve; });
        let resolveDenied!: (reason: string) => void;
        const denied = new Promise<string>(resolve => { resolveDenied = resolve; });
        // The remote Provider application is the HTTP system boundary. The real
        // daemon terminator, TCP adapter and first-bytes capability proxy carry
        // the dispatcher's actual bytes into it; no frame codec is imitated.
        let applicationRequest: unknown;
        const upstream = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", chunk => chunks.push(Buffer.from(chunk)));
            request.on("end", () => {
                applicationRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                respond = () => {
                    if (outcome === "application_exception") {
                        // A genuine upstream network failure, after real Home
                        // admission. No internal handler or admission is mocked.
                        request.socket.destroy();
                        return;
                    }
                    if (outcome === "source_refusal") {
                        writeProviderBrokerApplicationFailure({
                            header(name, value) { response.setHeader(name, value); },
                            code(statusCode) { response.statusCode = statusCode; return { send(payload) { response.end(JSON.stringify(payload)); } }; },
                        }, { ok: false, reasonCode: "source_unavailable" });
                        return;
                    }
                    if (outcome === "upstream_unauthorized") {
                        response.writeHead(401, { "content-type": "application/json" });
                        response.end('{"error":"private upstream response"}');
                        return;
                    }
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end('{"ok":true}');
                };
                if (outcome !== "slow_response") respond();
                requestArrived();
            });
        });
        await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
        const address = upstream.address();
        if (!address || typeof address === "string") throw new Error("Provider application not listening");
        const proxy = await startFirstBytesLocalCapabilityProxy({ targetPort: address.port });
        const applicationServer = realApplication ? await startProviderBrokerApplicationServer({
            handler: createProviderBrokerRequestHandler({
                createRequestId: () => "initial-resource-test",
                resolveRequestPolicy: async () => null,
                admit: async () => ({ ok: false, reasonCode: "resource_unavailable" }),
                resolveResourceTestRequestPolicy: async () => ({
                    resourceRevision: resource.revision, policy: null, application,
                    modelCatalog: { models: [{ id: "gpt-5" }], resolveCanonicalModelId: id => id === "gpt-5" ? id : null },
                }),
                admitResourceTest: async request => {
                    if (outcome === 'source_reauth') await db.serviceAccountToken.update({ where: { id: credential.id }, data: {
                        metadata: { ...credentialMetadata,
                            health: { v: 1, status: 'needs_reauth', reconnectRequired: true } },
                    } });
                    // Cross the real Home HTTP route with the same strict
                    // request/response codecs used by ApiClient. A rejected
                    // Home response throws AxiosError, as on the daemon.
                    const admitted = await axios.post(`${homeUrl}${TEAM_CREDENTIAL_RESOURCE_TEST_ADMISSION_HTTP_PATH_V1}`,
                        TeamCredentialResourceTestAdmissionV1Schema.parse({ v: 1, binding: request.binding, brokerMachineId: broker.id,
                            relayAuthorization: request.relayAuthorization, requestFacts: request.requestFacts }),
                        { headers: { "x-test-user-id": custodian.id }, signal: request.request.signal });
                    const admission = TeamCredentialResourceTestAdmissionResponseV1Schema.parse(admitted.data);
                    if (!admission.ok) return admission;
                    // Credential materialization/Provider HTTP is the external
                    // boundary here. The real handler, policy, Home admission,
                    // application parser, relay and TCP retain their wiring.
                    return { ok: true, access: {
                        endpointUrl: () => `http://127.0.0.1:${address.port}/v1`,
                        request: async providerRequest => {
                            const response = await fetch(`http://127.0.0.1:${address.port}${providerRequest.pathAndQuery}`, {
                                method: providerRequest.method, headers: providerRequest.headers,
                                body: providerRequest.body ? Buffer.from(providerRequest.body) : undefined,
                                signal: providerRequest.signal,
                            });
                            return { ok: response.ok, status: response.status, statusText: response.statusText,
                                headers: Object.fromEntries(response.headers), body: response.body };
                        },
                    } };
                },
            }),
        }) : null;
        const terminator = registerPeerTcpTunnelRelayTerminator({
            accountId: custodian.id, machineId: broker.id, nowMs: Date.now,
            relayAuthorizationTrustRoots: trustRoots,
            socket: {
                on(_event, handler) { brokerReceive = handler; },
                emit(_event, envelope) {
                    const parsed = PeerTcpTunnelRelayEnvelopeSchema.parse(envelope);
                    if (parsed.v === 2) {
                        const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: parsed.frame, maxHeaderBytes: 64 * 1024, maxPayloadBytes: 64 * 1024 });
                        if (decoded.ok) brokerFrames.push(`${decoded.header.kind}:${decoded.header.direction ?? "parent"}`);
                        if (decoded.ok && decoded.header.kind === "ack" && decoded.header.direction === "client_to_daemon") acknowledged = true;
                    }
                    receive?.(parsed);
                },
            },
            connectTcp: target => {
                if (ordinaryResponse || outcome === "slow_response") return connectPeerTcpTunnelTcp(target);
                connecting();
                return new Promise(() => {});
            },
            resolveProviderBrokerApplicationTarget: async ({ binding, relayAuthorization, signal }) => {
                if (!applicationServer) return proxy;
                if (binding.kind !== "resource_test") throw new Error("Expected resource Test");
                return await applicationServer.createStreamTarget({ kind: "external", binding, relayAuthorization }, signal);
            },
            observability: { emit(event) {
                if (outcome === "available" && event.kind === "flow.denied") resolveDenied(String(event.data.reasonCode ?? "unknown"));
            } },
        });
        app.forwardTeamCredentialBrokerResourceTest = createTeamCredentialResourceTestBrokerDispatcher({
            env: signing, enabled: () => true,
            createRelayTransport: () => {
                // Only time is substituted. The deadline is the authorization
                // actually minted by the production dispatcher, not a test cap.
                if (!ordinaryResponse) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
                return {
                    relaySocketId, close() {},
                    subscribe(handler) { receive = handler; return () => { receive = undefined; }; },
                    send(_event, envelope) {
                        if (envelope.v === 1 && envelope.frame.kind === "open") {
                            tunnelId = envelope.frame.open.tunnelId;
                            const authorization = envelope.frame.open.relayAuthorization;
                            expect(authorization).toBeDefined();
                            const verified = verifyPeerTcpTunnelRelayAuthorizationV2({
                                authorization, nowMs: Date.now(), trustRoots,
                            });
                            expect(verified).toMatchObject({ valid: true });
                            if (!verified.valid) return;
                            admissionExpiresAt = verified.payload.exp;
                            expect(PeerTcpTunnelRelayAuthorizationPayloadV2Schema.parse(verified.payload).providerBroker)
                                .toEqual({ v: 1, kind: "resource_test", teamId: team.id, resourceId: resource.id,
                                    requestId: "initial-resource-test", actorAccountId: custodian.id,
                                    expectedResourceRevision: resource.revision, application, source });
                            expect(verifyPeerTcpTunnelRelayAuthorizationV2({ authorization,
                                nowMs: verified.payload.exp, trustRoots }))
                                .toEqual({ valid: false, reasonCode: "authorization_expired" });
                            admitted = true;
                            opened();
                        }
                        if (outcome === "silent_carrier") return;
                        void brokerReceive?.(envelope);
                    },
                };
            },
        });
        const diagnostics = vi.spyOn(logger, "warn");
        try {
            let settled = false;
            const request = post("/v1/teams/credential-resources/test", custodian.id, {
                teamId: team.id, resourceId: resource.id,
            }).then(response => { settled = true; return response; });
            if (outcome === "slow_response") {
                await applicationRequestReceived;
                await vi.advanceTimersByTimeAsync(PEER_TCP_TUNNEL_ACK_AFTER_MS + 1);
                await vi.waitFor(() => expect(acknowledged, JSON.stringify(brokerFrames)).toBe(true));
                await vi.advanceTimersByTimeAsync(admissionExpiresAt - Date.now() + 1);
                expect(settled).toBe(false);
                respond!();
            } else if (!ordinaryResponse) {
                await (outcome === "stalled_activation" ? connectionStarted : openSent);
                await vi.advanceTimersByTimeAsync(admissionExpiresAt - Date.now() + 1);
                await vi.waitFor(() => expect(settled).toBe(true));
            }
            const tested = await Promise.race([request,
                denied.then(reason => { throw new Error(`Real broker refused carrier frames: ${reason}`); })]);
            expect(tested.statusCode, tested.body).toBe(200);
            const result = TeamCredentialTestActionOutputV1Schema.parse(tested.json());
            expect(result, JSON.stringify(diagnostics.mock.calls))
                .toMatchObject(outcome === "available" || outcome === "slow_response"
                    ? { result: "available", readiness: { kind: "available" } }
                    : outcome === 'source_reauth'
                        ? { result: 'needs_attention', code: 'connected_service_credential_reconnect_required',
                            readiness: { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' } }
                    : outcome === "source_refusal" || outcome === "upstream_unauthorized"
                        ? { result: "needs_attention", readiness: { kind: "source_unavailable" },
                            code: outcome === "source_refusal" ? "source_unavailable" : "upstream_unavailable" }
                    : { result: "needs_attention", readiness: { kind: "broker_unavailable" },
                        ...(outcome === "application_exception" ? { code: "broker_unavailable" } : {}) });
            if (outcome === "source_refusal" || outcome === "upstream_unauthorized") {
                expect(diagnostics).toHaveBeenCalledWith({ module: "team-credential-resource-test", stage: "dispatch", code: result.code });
                expect(JSON.stringify(result)).not.toContain("private");
            }
            expect(admitted).toBe(true);
            if (outcome === 'source_reauth') {
                expect(applicationRequest).toBeUndefined();
                expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);
            } else if (realApplication) {
                expect(applicationRequest).toMatchObject({ model: "gpt-5", input: "Reply with OK." });
                expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);
            } else if (ordinaryResponse || outcome === "slow_response") expect(applicationRequest).toMatchObject({ kind: "resource_test", resourceId: resource.id });
            else expect(applicationRequest).toBeUndefined();
        } finally {
            vi.useRealTimers();
            if (tunnelId) receive?.({ v: 1, scopeUserId: custodian.id,
                sender: { kind: "machine", machineId: broker.id }, recipient: { kind: "user", socketId: relaySocketId },
                frame: { v: 1, kind: "abort", tunnelId, reasonCode: "test_cleanup" } });
            await terminator.dispose();
            await applicationServer?.close();
            await proxy.close();
            upstream.closeAllConnections();
            await new Promise<void>(resolve => upstream.close(() => resolve()));
            app.machineDaemonPresence = previousPresence;
            app.forwardRpcForUser = previousRpc;
            app.forwardTeamCredentialBrokerResourceTest = previousDispatch;
        }
    });

});

