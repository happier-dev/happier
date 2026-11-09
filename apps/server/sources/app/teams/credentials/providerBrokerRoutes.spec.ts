import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';

import {
    PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
    PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1,
    PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1,
    RPC_METHODS,
} from '@happier-dev/protocol';
import { encodeSessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createEnvPatcher } from '@/testkit/env';
import { db } from '@/storage/db';

import { registerTeamCredentialProviderBrokerRoutes } from './providerBrokerRoutes';

describe('Team credential Provider broker HTTP routes', () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let openRouteRunnerBinding: unknown;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'team-provider-broker-routes-',
            initAuth: false,
        });
        app = createAuthenticatedTestApp();
        app.addHook('onRoute', (route: RouteOptions) => {
            if (route.url === PROVIDER_BROKER_OPEN_HTTP_PATH_V1) {
                openRouteRunnerBinding = route.config?.restrictedCredentialBinding;
            }
        });
        registerTeamCredentialProviderBrokerRoutes(app);
        await app.ready();
    }, 180_000);

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    it('mounts both authenticated routes and fails closed when the Home signing root is unavailable', async () => {
        const signingEnv = createEnvPatcher([
            'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID',
            'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY',
            'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY',
            'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT',
        ]);
        signingEnv.setMany({
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'unavailable',
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: undefined,
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: undefined,
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: undefined,
        });
        try {
            expect(openRouteRunnerBinding).toEqual({
                scope: 'session',
                session: 'body.consumer.sessionId',
                machine: 'body.initiatorMachineId',
            });
            const headers = { 'x-test-user-id': 'account-1' };
            const open = await app.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers,
                payload: {
                    v: 1,
                    resourceId: 'resource-1',
                    expectedResourceRevision: 1,
                    modelId: 'gpt-5',
                    sourceRevision: 'source-revision-1',
                    initiatorMachineId: 'worker-1',
                    consumer: { kind: 'session', sessionId: 'session-1' },
                    application: {
                        agentTargetKey: 'codex',
                        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                        endpointTemplateId: 'cliproxyapi-openai-responses',
                        protocol: 'openai-responses',
                    },
                },
            });
            expect({ status: open.statusCode, body: open.json() }).toEqual({
                status: 200,
                body: { ok: false, reasonCode: 'update_required' },
            });

            const admit = await app.inject({
                method: 'POST',
                url: PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1,
                headers,
                payload: {},
            });
            expect(admit.statusCode).toBe(400);

            const externalModels = await app.inject({
                method: 'POST',
                url: PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1,
                headers,
                payload: {
                    v: 1,
                    binding: {
                        v: 1,
                        kind: 'external_api_key',
                        teamId: 'team-1',
                        resourceId: 'resource-1',
                        requestId: 'request-1',
                        externalApiKeyId: '550e8400-e29b-41d4-a716-446655440000',
                        operationId: null,
                        brokerPlacementFingerprint: 'a'.repeat(64),
                        assignedAccountId: 'account-1',
                        assignedTeamMembershipId: 'membership-1',
                    },
                    brokerMachineId: 'broker-1',
                    expectedResourceRevision: 1,
                    application: {
                        implementationIdentity: { pluginId: 'provider.plugin', localId: 'provider' },
                        endpointTemplateId: 'provider-responses',
                        protocol: 'openai-responses',
                    },
                },
            });
            expect({ status: externalModels.statusCode, body: externalModels.json() }).toEqual({
                status: 200,
                body: { ok: false, reasonCode: 'operation_not_current' },
            });
        } finally {
            signingEnv.restore();
        }
    });

    it('fails a Pool open closed on malformed daemon eligibility and removes request listeners', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Pool route ${crypto.randomUUID()}` } });
        const requesterMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const worker = await db.machine.create({ data: {
            id: `route-worker-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            kind: 'persistent',
            operationProtocolCapabilities: {
                irohMachineEndpoint: { protocolVersions: [1], endpointId: '4'.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const broker = await db.machine.create({ data: {
            id: `route-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: '{}',
            kind: 'persistent',
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: '5'.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: custodian.id,
            name: 'Pool route',
            members: { create: { machineId: broker.id, priorityTier: 0, enabled: true } },
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Pool route resource',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId: 'route-connection',
                connectionSecurityFingerprint: 'connection-security:v1:route',
                credentialSlotId: 'apiKey',
            }),
            brokerPoolId: pool.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        const session = await db.session.create({ data: {
            id: `route-session-${requester.id}`,
            tag: `route-session-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            active: true,
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id,
            machineId: worker.id,
            sessionId: session.id,
            data: '{}',
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: 'provider_model:brokered',
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })),
            resourceId: resource.id,
            resourceRevision: resource.revision,
        } });

        const routeApp = createAuthenticatedTestApp();
        const forwardRpcForUser = vi.fn(async () => ({ ok: true as const, result: { status: 'eligible', extra: true } }));
        routeApp.decorate('machineDaemonPresence', {
            in: () => ({ fetchSockets: async () => [
                { data: { clientType: 'machine-scoped', userId: requester.id, machineId: worker.id } },
                { data: { clientType: 'machine-scoped', userId: custodian.id, machineId: broker.id } },
            ] }),
        });
        routeApp.decorate('forwardRpcForUser', forwardRpcForUser);
        const capturedRaw: {
            request: FastifyRequest['raw'] | null;
            reply: FastifyReply['raw'] | null;
        } = { request: null, reply: null };
        routeApp.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
            capturedRaw.request = request.raw;
            capturedRaw.reply = reply.raw;
            request.authTokenEpoch = requester.tokenEpoch;
        });
        registerTeamCredentialProviderBrokerRoutes(routeApp);
        await routeApp.ready();

        const signingSeed = new Uint8Array(32).fill(42);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
        const previous = {
            keyId: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID,
            privateKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY,
            publicKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY,
            credentialResources: process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED,
        };
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = 'route-test';
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = Buffer.from(signingSeed).toString('base64url');
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('base64url');
        process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = '1';
        try {
            const response = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': requester.id },
                payload: {
                    v: 1,
                    resourceId: resource.id,
                    expectedResourceRevision: resource.revision,
                    modelId: 'model-1',
                    sourceRevision: 'source-revision-1',
                    initiatorMachineId: worker.id,
                    consumer: { kind: 'session', sessionId: session.id },
                    application: {
                        agentTargetKey: 'agent:happier.agent.codex/codex',
                        implementationIdentity: { pluginId: 'provider.plugin', localId: 'provider' },
                        endpointTemplateId: 'provider-responses',
                        protocol: 'openai-responses',
                    },
                },
            });
            expect(response.json()).toEqual({ ok: false, reasonCode: 'broker_unavailable' });
            expect(forwardRpcForUser).toHaveBeenCalledWith(expect.objectContaining({
                userId: custodian.id,
                method: `${broker.id}:daemon.providers.teamCredentialBroker.eligibility`,
                params: expect.objectContaining({
                    machineId: broker.id,
                    resourceId: resource.id,
                    expectedResourceRevision: resource.revision,
                    modelId: 'model-1',
                    sourceRevision: 'source-revision-1',
                }),
            }));
            expect(capturedRaw.request?.listenerCount('aborted')).toBe(0);
            expect(capturedRaw.reply?.listenerCount('close')).toBe(0);
        } finally {
            if (previous.keyId === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = previous.keyId;
            if (previous.privateKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = previous.privateKey;
            if (previous.publicKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = previous.publicKey;
            if (previous.credentialResources === undefined) delete process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED;
            else process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = previous.credentialResources;
            await routeApp.close();
        }
    });

    it('denies ordinary missing and unauthorized resources identically before presence or daemon RPC', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Broker oracle ${crypto.randomUUID()}` } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: custodian.id, role: 'owner' },
        });
        const worker = await db.machine.create({ data: {
            id: `oracle-worker-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            kind: 'persistent',
            operationProtocolCapabilities: {
                irohMachineEndpoint: { protocolVersions: [1], endpointId: '6'.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const broker = await db.machine.create({ data: {
            id: `oracle-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: '{}',
            kind: 'persistent',
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: '7'.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Unentitled resource',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId: 'oracle-connection',
                connectionSecurityFingerprint: 'connection-security:v1:oracle',
                credentialSlotId: 'apiKey',
            }),
            brokerMachineId: broker.id,
        } });
        const session = await db.session.create({ data: {
            id: `oracle-session-${requester.id}`,
            tag: `oracle-session-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            active: true,
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id,
            machineId: worker.id,
            sessionId: session.id,
            data: '{}',
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: 'provider_model:brokered',
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })),
            resourceId: resource.id,
            resourceRevision: resource.revision,
        } });

        const presenceFetch = vi.fn(async () => []);
        const forwardRpcForUser = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' }));
        const routeApp = createAuthenticatedTestApp();
        routeApp.addHook('onRequest', async (request: FastifyRequest) => {
            request.authTokenEpoch = requester.tokenEpoch;
        });
        routeApp.decorate('machineDaemonPresence', {
            in: () => ({ fetchSockets: presenceFetch }),
        });
        routeApp.decorate('forwardRpcForUser', forwardRpcForUser);
        registerTeamCredentialProviderBrokerRoutes(routeApp);
        await routeApp.ready();

        const signingSeed = new Uint8Array(32).fill(44);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
        const previous = {
            keyId: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID,
            privateKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY,
            publicKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY,
            credentialResources: process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED,
        };
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = 'oracle-route-test';
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = Buffer.from(signingSeed).toString('base64url');
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('base64url');
        process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = '1';
        const requestForResource = (resourceId: string) => ({
            v: 1,
            resourceId,
            expectedResourceRevision: 1,
            modelId: 'model-1',
            sourceRevision: 'source-revision-1',
            initiatorMachineId: worker.id,
            consumer: { kind: 'session', sessionId: session.id },
            application: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                implementationIdentity: { pluginId: 'provider.plugin', localId: 'provider' },
                endpointTemplateId: 'provider-responses',
                protocol: 'openai-responses',
            },
        });
        try {
            const existing = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': requester.id },
                payload: requestForResource(resource.id),
            });
            const missing = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': requester.id },
                payload: requestForResource(crypto.randomUUID()),
            });
            expect(existing.json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
            expect(missing.json()).toEqual(existing.json());
            expect(presenceFetch).not.toHaveBeenCalled();
            expect(forwardRpcForUser).not.toHaveBeenCalled();
        } finally {
            if (previous.keyId === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = previous.keyId;
            if (previous.privateKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = previous.privateKey;
            if (previous.publicKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = previous.publicKey;
            if (previous.credentialResources === undefined) delete process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED;
            else process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = previous.credentialResources;
            await routeApp.close();
        }
    });

    it('denies Execution Run missing and unauthorized resources before Run currentness, presence, or daemon RPC', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Broker Run oracle ${crypto.randomUUID()}` } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: custodian.id, role: 'owner' },
        });
        const broker = await db.machine.create({ data: {
            id: `run-oracle-broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: '{}',
            kind: 'persistent',
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: '8'.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Unentitled Execution Run resource',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId: 'run-oracle-connection',
                connectionSecurityFingerprint: 'connection-security:v1:run-oracle',
                credentialSlotId: 'apiKey',
            }),
            brokerMachineId: broker.id,
        } });

        const presenceFetch = vi.fn(async () => []);
        const forwardRpcForUser = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' }));
        const routeApp = createAuthenticatedTestApp();
        routeApp.decorate('machineDaemonPresence', {
            in: () => ({ fetchSockets: presenceFetch }),
        });
        routeApp.decorate('forwardRpcForUser', forwardRpcForUser);
        registerTeamCredentialProviderBrokerRoutes(routeApp);
        await routeApp.ready();

        const signingSeed = new Uint8Array(32).fill(45);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
        const previous = {
            keyId: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID,
            privateKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY,
            publicKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY,
            credentialResources: process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED,
        };
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = 'run-oracle-route-test';
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = Buffer.from(signingSeed).toString('base64url');
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('base64url');
        process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = '1';
        const requestForResource = (resourceId: string) => ({
            v: 1,
            resourceId,
            expectedResourceRevision: 1,
            modelId: 'model-1',
            sourceRevision: 'source-revision-1',
            initiatorMachineId: `run-oracle-worker-${requester.id}`,
            consumer: { kind: 'execution_run', executionRunId: `run-oracle-${requester.id}` },
            application: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                implementationIdentity: { pluginId: 'provider.plugin', localId: 'provider' },
                endpointTemplateId: 'provider-responses',
                protocol: 'openai-responses',
            },
        });
        try {
            const existing = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': requester.id },
                payload: requestForResource(resource.id),
            });
            const missing = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': requester.id },
                payload: requestForResource(crypto.randomUUID()),
            });
            expect(existing.json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
            expect(missing.json()).toEqual(existing.json());
            expect(presenceFetch).not.toHaveBeenCalled();
            expect(forwardRpcForUser).not.toHaveBeenCalled();
        } finally {
            if (previous.keyId === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = previous.keyId;
            if (previous.privateKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = previous.privateKey;
            if (previous.publicKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = previous.publicKey;
            if (previous.credentialResources === undefined) delete process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED;
            else process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = previous.credentialResources;
            await routeApp.close();
        }
    });

    it('denies a Runner resource mismatch opaquely before resource discovery or presence work', async () => {
        const runnerAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
        const runner = {
            accountId: runnerAccount.id,
            activationId: crypto.randomUUID(),
            sessionId: `runner-route-session-${crypto.randomUUID()}`,
            machineId: `runner-route-machine-${crypto.randomUUID()}`,
            installationId: `runner-route-installation-${crypto.randomUUID()}`,
            installationPublicKey: Buffer.alloc(32, 9).toString('base64url'),
        };
        await db.session.create({ data: {
            id: runner.sessionId,
            accountId: runner.accountId,
            tag: `runner-route-${crypto.randomUUID()}`,
            metadata: '{}',
            active: true,
        } });
        await db.machine.create({ data: {
            id: runner.machineId,
            accountId: runner.accountId,
            metadata: '{}',
            kind: 'ephemeral_session_runner',
            installationId: runner.installationId,
            installationPublicKey: Buffer.alloc(32, 9),
        } });
        await db.accessKey.create({ data: {
            accountId: runner.accountId,
            sessionId: runner.sessionId,
            machineId: runner.machineId,
            data: '{}',
        } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Runner broker route ${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const boundBroker = await db.machine.create({ data: {
            id: `runner-bound-broker-${crypto.randomUUID()}`,
            accountId: custodian.id,
            metadata: '{}',
            kind: 'persistent',
        } });
        const unrelatedBroker = await db.machine.create({ data: {
            id: `runner-unrelated-broker-${crypto.randomUUID()}`,
            accountId: custodian.id,
            metadata: '{}',
            kind: 'persistent',
        } });
        const sourceBindingJson = JSON.stringify({
            v: 1,
            kind: 'provider_connection',
            connectionId: 'runner-route-connection',
            connectionSecurityFingerprint: 'connection-security:v1:runner-route',
            credentialSlotId: 'apiKey',
        });
        const boundResource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Runner bound resource',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson,
            brokerMachineId: boundBroker.id,
        } });
        const unrelatedResource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Runner unrelated resource',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson,
            brokerMachineId: unrelatedBroker.id,
        } });
        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'openai-responses',
            protocol: 'openai-responses' as const,
        };
        const credentialSelection = {
            v: 1 as const,
            request: {
                v: 1 as const,
                selection: {
                    kind: 'team_credential_provider_model' as const,
                    resourceId: boundResource.id,
                    teamId: team.id,
                    expectedResourceRevision: boundResource.revision,
                    agentTargetKey: application.agentTargetKey,
                    modelId: 'model-1',
                },
                application,
                sourceRevision: 'source-revision-1',
                plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            },
            binding: {
                v: 1 as const,
                resourceId: boundResource.id,
                brokerMachineId: boundBroker.id,
                revision: boundResource.revision,
                application,
                sourceRevision: 'source-revision-1',
            },
        };
        await db.ephemeralRunnerActivation.create({
            data: {
                id: runner.activationId,
                creatorAccountId: runner.accountId,
                creatorTokenEpoch: runnerAccount.tokenEpoch,
                draftId: crypto.randomUUID(),
                sessionId: runner.sessionId,
                machineId: runner.machineId,
                state: 'materialized',
                workspacePolicy: 'choose_on_endpoint',
                homeServerIdentityId: 'srv_runner_route',
                activationSigningPublicKey: Buffer.alloc(32, 10).toString('base64url'),
                authoringCommitment: Buffer.alloc(32, 11).toString('base64url'),
                artifact: {},
                endpointFactsRecipient: {},
                authenticationEvidence: {
                    v: 1,
                    evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
                },
                credentialSelection,
                review: {
                    sealedLaunchManifest: 'sealed-runner-manifest',
                    authoringCommitment: Buffer.alloc(32, 11).toString('base64url'),
                    launchManifestCommitment: Buffer.alloc(32, 13).toString('base64url'),
                    endpointFactsProof: {
                        activationSignature: Buffer.alloc(64, 14).toString('base64url'),
                        installationSignature: Buffer.alloc(64, 15).toString('base64url'),
                    },
                    agentTargetKey: application.agentTargetKey,
                    machineContentKeyBinding: null,
                    credentialSelectionBinding: credentialSelection.binding,
                    displayFacts: {
                        v: 1,
                        homeId: 'srv_runner_route',
                        homeName: 'Runner Home',
                        requesterId: runner.accountId,
                        requesterName: 'Runner Creator',
                        teamId: team.id,
                        teamName: 'Runner Team',
                    },
                },
            },
        });
        const principal = {
            kind: 'ephemeral_session_runner' as const,
            authority: 'session_runtime' as const,
            accountId: runner.accountId,
            activationId: runner.activationId,
            sessionId: runner.sessionId,
            machineId: runner.machineId,
            installationId: runner.installationId,
            installationPublicKey: runner.installationPublicKey,
            creatorTokenEpoch: runnerAccount.tokenEpoch,
        };
        const presenceFetch = vi.fn(async () => []);
        const forwardRpcForUser = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' }));
        const routeApp = createAuthenticatedTestApp();
        routeApp.addHook('onRequest', async (request: FastifyRequest) => {
            request.sessionRuntimePrincipal = principal;
        });
        routeApp.decorate('machineDaemonPresence', {
            in: () => ({ fetchSockets: presenceFetch }),
        });
        routeApp.decorate('forwardRpcForUser', forwardRpcForUser);
        registerTeamCredentialProviderBrokerRoutes(routeApp);
        await routeApp.ready();

        const signingSeed = new Uint8Array(32).fill(43);
        const keyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
        const previous = {
            keyId: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID,
            privateKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY,
            publicKey: process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY,
        };
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = 'runner-route-test';
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = Buffer.from(signingSeed).toString('base64url');
        process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('base64url');
        const requestForResource = (resourceId: string) => ({
            v: 1,
            resourceId,
            expectedResourceRevision: 1,
            modelId: 'model-1',
            sourceRevision: 'source-revision-1',
            initiatorMachineId: runner.machineId,
            consumer: { kind: 'session', sessionId: runner.sessionId },
            application,
        });
        try {
            const existing = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': runner.accountId },
                payload: requestForResource(unrelatedResource.id),
            });
            const missing = await routeApp.inject({
                method: 'POST',
                url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
                headers: { 'x-test-user-id': runner.accountId },
                payload: requestForResource(crypto.randomUUID()),
            });
            expect(existing.json()).toEqual({ ok: false, reasonCode: 'resource_forbidden' });
            expect(missing.json()).toEqual(existing.json());
            expect(presenceFetch).not.toHaveBeenCalled();
            expect(forwardRpcForUser).not.toHaveBeenCalled();
        } finally {
            if (previous.keyId === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID = previous.keyId;
            if (previous.privateKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY = previous.privateKey;
            if (previous.publicKey === undefined) delete process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY;
            else process.env.HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY = previous.publicKey;
            await routeApp.close();
        }
    });
});
