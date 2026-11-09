import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, PluginWebhookEndpointEnsureInputV1Schema, PluginWebhookEndpointEnsureResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { createPluginInstallationManifestPublisherSigningInputV1, PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, stringifyPluginInstallationManifestCanonicalJsonV1 } from '@happier-dev/protocol/plugins/installations/manifests';

import { db } from '@/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { eventRouter } from '@/app/events/connectionEventRouter';
import type { SocketRoomEventName } from '@/app/events/socketRoomEmitter';
import { registerPluginWebhookIngressRoute } from '@/app/api/routes/plugins/webhooks/registerPluginWebhookIngressRoute';
import { registerPluginWebhookDaemonRoutes } from '@/app/api/routes/plugins/webhooks/registerPluginWebhookDaemonRoutes';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createPluginWebhookEndpointActionsV1 } from './endpointActions';
import { ingestPluginWebhookV1 } from './ingest';
import { ensurePluginWebhookEndpointV1 } from './endpointStore';

const accountId = 'heartbeat-account';
const pluginId = 'acme.heartbeat';
const checkId = '脈'.repeat(1500);
const publisherKey = tweetnacl.sign.keyPair();
const target = {
    materialization: { machineId: 'heartbeat-machine', materializationId: 'heartbeat-materialization', pluginId },
    machineInstallationId: 'heartbeat-installation', pluginVersion: '1.0.0',
};
const input = PluginWebhookEndpointEnsureInputV1Schema.parse({
    webhookContribution: { pluginId, localId: 'heartbeat' }, targetMaterialization: target.materialization,
    sourceInstanceId: 'source-heartbeat', setup: { kind: 'capabilityUrlV1', checkId },
    idempotencyKey: 'heartbeat-ensure-0001',
});

describe('record-only heartbeat ingress', () => {
    let harness: LightSqliteHarness;
    let token: string;
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-heartbeat-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_heartbeatCurrent1', HAPPIER_PUBLIC_SERVER_URL: 'https://happier.example' } });
        await db.account.create({ data: { id: accountId, encryptionMode: 'plain' } });
        token = await createAccountTokenForTests(accountId, { kind: 'account', authority: 'present_user' });
        const facts = normalizePluginReleaseFactsV1({ ref: { pluginId, version: '1.0.0' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Heartbeat',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' },
                contributes: { webhooks: [{ id: 'heartbeat', title: 'Heartbeat',
                    verifier: { kind: 'capabilityUrl_v1', routing: 'accountEndpoint' }, delivery: 'recordReceiptOnly' }] } },
            collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        });
        await db.machine.create({ data: { id: target.materialization.machineId, accountId, metadata: '{}',
            installationId: target.machineInstallationId, installationPublicKey: publisherKey.publicKey, pluginMaterializationRevision: 1n,
            operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        await db.accountPluginIntent.create({ data: { accountId, pluginId, desiredVersion: '1.0.0', enabled: true, writableCollections: [] } });
        await db.accountPluginRelease.create({ data: { accountId, pluginId, version: '1.0.0',
            archiveDigestSha256: facts.archiveDigestSha256, normalizedManifest: facts.normalizedManifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: facts.packageAssetArchive } });
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: 'srv_heartbeatCurrent1',
            machineId: target.materialization.machineId, materializationId: target.materialization.materializationId,
            pluginId, version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
            archiveDigestSha256: facts.archiveDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as never);
        registerPluginWebhookDaemonRoutes(app as never, undefined, {
            HAPPIER_FEATURE_PLUGINS__ENABLED: '1', HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: '1',
        });
        registerPluginWebhookIngressRoute(app as never, { env: {
            HAPPIER_FEATURE_PLUGINS__ENABLED: '1', HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: '1',
        }, distributedAdmission: null });
        await app.ready();
    }, 120_000);

    afterAll(async () => { eventRouter.clearIo(); await app.close(); await harness?.close(); });

    function callHost(path: string, body: object) {
        const proof = { v: 1 as const, alg: 'ed25519-machine-installation-v1' as const,
            machineId: target.materialization.machineId, installationId: target.machineInstallationId,
            issuedAt: Date.now(), nonce: 'heartbeat-publisher-proof', method: 'POST' as const, path,
            bodySha256Base64Url: createHash('sha256').update(stringifyPluginInstallationManifestCanonicalJsonV1(body)).digest('base64url') };
        const signature = tweetnacl.sign.detached(createPluginInstallationManifestPublisherSigningInputV1({ proof }), publisherKey.secretKey);
        return app.inject({ method: 'POST', url: path, payload: body, headers: { authorization: `Bearer ${token}`,
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: Buffer.from(JSON.stringify({ proof: {
                ...proof, signatureBase64Url: Buffer.from(signature).toString('base64url'),
            } })).toString('base64url') } });
    }

    it('records only monotonic liveness through GET/POST, exact reads, reassignment, route rotation and revocation', async () => {
        const createdResponse = await callHost(PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, { caller: target.materialization, input });
        expect(createdResponse.statusCode).toBe(200);
        const ensured = PluginWebhookEndpointEnsureResultV1Schema.parse(createdResponse.json());
        const actions = createPluginWebhookEndpointActionsV1();
        const readInput = { webhookEndpointId: ensured.webhookEndpointId, sourceInstanceId: input.sourceInstanceId, checkId };
        const readResponse = await callHost(PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, { caller: target.materialization, input: readInput });
        expect(readResponse.statusCode).toBe(200);
        expect(readResponse.json()).toEqual({ kind: 'ready', lastAcceptedAt: null });
        const unsignedRead = await app.inject({ method: 'POST', url: PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1,
            headers: { authorization: `Bearer ${token}` }, payload: { caller: target.materialization, input: readInput } });
        expect(unsignedRead.statusCode).toBe(401);
        expect(await actions.readHeartbeat({ accountId, caller: target.materialization, input: readInput })).toEqual({ kind: 'ready', lastAcceptedAt: null });
        expect(ensured.readiness).toBe('ready');
        expect(ensured.oneTimeGeneratedSecret).toBeUndefined();
        const [identity] = await db.$queryRawUnsafe<Array<{ checkId: string; checkIdDigest: string }>>(
            'SELECT "checkId", "checkIdDigest" FROM "PluginWebhookEndpoint" WHERE "id" = ?', ensured.webhookEndpointId);
        expect(identity).toEqual({ checkId, checkIdDigest: createHash('sha256').update(JSON.stringify(checkId)).digest('hex') });
        const endpointBefore = await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: ensured.webhookEndpointId } });
        const accountChangesBefore = await db.accountChange.findMany({ where: { accountId } });
        // Socket transport is the boundary; keep the real recipient routing beneath it.
        const sent: Array<{ room: string | string[]; event: SocketRoomEventName; payload: unknown }> = [];
        eventRouter.setIo({ to: room => ({
            emit: (event, payload) => { sent.push({ room, event, payload }); },
            disconnectSockets: () => undefined,
        }) });
        const path = new URL(ensured.publicUrl).pathname;
        for (const method of ['POST', 'GET'] as const) {
            expect((await app.inject({ method, url: path })).statusCode).toBe(202);
        }
        const firstReceiptHints = sent.length;
        expect(firstReceiptHints).toBeGreaterThanOrEqual(1);
        expect(firstReceiptHints).toBeLessThanOrEqual(2);
        const routeId = path.split('/').at(-1)!;
        // Older requests committing after a newer receipt cannot move the timestamp backwards.
        const latest = new Date(Date.now() + 1000);
        await ingestPluginWebhookV1({ opaqueRouteId: routeId, headers: {}, rawBody: new Uint8Array(), now: latest });
        await Promise.all([latest.getTime() - 10, latest.getTime() - 20].map(ms => ingestPluginWebhookV1({
            opaqueRouteId: routeId, headers: {}, rawBody: new Uint8Array(), now: new Date(ms),
        })));
        const endpointAfter = await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: ensured.webhookEndpointId } });
        expect(endpointAfter).toEqual({ ...endpointBefore, lastAcceptedAt: latest });
        expect(await db.accountChange.findMany({ where: { accountId } })).toEqual(accountChangesBefore);
        expect(await db.pluginWebhookDelivery.count()).toBe(0);
        expect(await db.pluginWebhookCredential.count()).toBe(0);
        expect(sent).toHaveLength(firstReceiptHints + 1);
        for (const hint of sent) {
            expect(hint).toMatchObject({ event: 'ephemeral', room: `machine:${target.materialization.machineId}:${accountId}`,
                payload: { type: 'health-check-heartbeat-received', webhookEndpointId: ensured.webhookEndpointId,
                    sourceInstanceId: input.sourceInstanceId, checkId, lastAcceptedAt: expect.any(Number) } });
        }
        const created = await actions.ensureHeartbeat({ accountId, callerPluginId: pluginId, input });
        expect(await db.pluginWebhookEndpoint.count()).toBe(1);
        expect(created.webhookEndpointId).toBe(ensured.webhookEndpointId);
        expect(await actions.readHeartbeat({ accountId, caller: target.materialization, input: readInput })).toMatchObject({ kind: 'ready' });
        expect(await actions.readHeartbeat({ accountId, caller: { ...target.materialization, machineId: 'other-machine' }, input: readInput })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        expect(await actions.readHeartbeat({ accountId, caller: target.materialization, input: { ...readInput, checkId: 'wrong-check' } })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        expect(await actions.readHeartbeat({ accountId, caller: target.materialization, input: { ...readInput, sourceInstanceId: 'wrong-source' } })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        expect(await actions.readHeartbeat({ accountId: 'other-account', caller: target.materialization, input: readInput })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        const nextMachine = 'heartbeat-machine-next';
        const nextMaterialization = 'heartbeat-materialization-next';
        await db.machine.create({ data: { id: nextMachine, accountId, metadata: '{}', installationId: 'heartbeat-installation-next',
            pluginMaterializationRevision: 1n,
            operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const priorMaterialization = await db.pluginMachineMaterialization.findUniqueOrThrow({ where: {
            machineId_materializationId: { machineId: target.materialization.machineId, materializationId: target.materialization.materializationId },
        } });
        await db.pluginMachineMaterialization.create({ data: { ...priorMaterialization, id: 'heartbeat-row-next', machineId: nextMachine, materializationId: nextMaterialization } });
        const nextTarget = { pluginId, machineId: nextMachine, materializationId: nextMaterialization };
        const reassigned = await actions.ensureHeartbeat({ accountId, callerPluginId: pluginId, input: {
            ...input, targetMaterialization: nextTarget, idempotencyKey: 'heartbeat-ensure-next-0001',
        } });
        expect(reassigned.webhookEndpointId).toBe(created.webhookEndpointId);
        expect(await db.pluginWebhookEndpoint.count()).toBe(1);
        expect(await actions.readHeartbeat({ accountId, caller: target.materialization, input: readInput })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        expect(await actions.readHeartbeat({ accountId, caller: nextTarget, input: readInput })).toEqual({ kind: 'ready', lastAcceptedAt: latest.getTime() });
        const beforeReassignedPing = sent.length;
        await ingestPluginWebhookV1({ opaqueRouteId: routeId, rawBody: new Uint8Array(), headers: {}, now: new Date(latest.getTime() + 1) });
        expect(sent.slice(beforeReassignedPing)).toEqual([expect.objectContaining({ event: 'ephemeral', room: `machine:${nextMachine}:${accountId}` })]);
        await db.machine.update({ where: { id: nextMachine }, data: { installationId: 'replacement-installation' } });
        expect(await actions.readHeartbeat({ accountId, caller: nextTarget, input: readInput })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(404);
        await db.machine.update({ where: { id: nextMachine }, data: { installationId: 'heartbeat-installation-next' } });
        const row = await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: created.webhookEndpointId } });
        await db.pluginWebhookRoute.update({ where: { id: row.routeId }, data: { opaqueRouteId: 'rotated-heartbeat-route' } });
        expect((await app.inject({ method: 'GET', url: new URL(created.publicUrl).pathname })).statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: '/v1/plugins/webhooks/rotated-heartbeat-route' })).statusCode).toBe(202);
        await actions.revoke({ accountId, input: { webhookEndpointId: row.id, expectedRevision: row.revision, idempotencyKey: 'heartbeat-revoke-0001' } });
        const revoked = await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: row.id } });
        expect(await actions.readHeartbeat({ accountId, caller: nextTarget, input: readInput })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
        expect((await app.inject({ method: 'POST', url: '/v1/plugins/webhooks/rotated-heartbeat-route' })).statusCode).toBe(404);
        expect(await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: row.id } })).toEqual(revoked);
        await db.pluginWebhookRoute.create({ data: { opaqueRouteId: 'ordinary-signed-route', verifierKind: 'github_hmac_sha256_v1', routingKind: 'accountEndpoint' } });
        expect((await app.inject({ method: 'GET', url: '/v1/plugins/webhooks/ordinary-signed-route' })).statusCode).toBe(405);
        expect((await app.inject({ method: 'POST', url: '/v1/plugins/webhooks/ordinary-signed-route', headers: { 'content-length': '0' } })).statusCode).toBe(401);
    });

    it('keeps exact long Unicode identities distinct and preserves ordinary source uniqueness', async () => {
        const actions = createPluginWebhookEndpointActionsV1();
        const checkIds = ['脈'.repeat(1999) + '一', '脈'.repeat(1999) + '二'];
        const endpointIds: string[] = [];
        for (const [index, rawCheckId] of checkIds.entries()) {
            const heartbeatInput = PluginWebhookEndpointEnsureInputV1Schema.parse({ ...input,
                sourceInstanceId: 'long-shared-source', setup: { kind: 'capabilityUrlV1', checkId: rawCheckId },
                idempotencyKey: `heartbeat-long-identity-${index}` });
            const endpoint = await actions.ensureHeartbeat({ accountId, callerPluginId: pluginId, input: heartbeatInput });
            endpointIds.push(endpoint.webhookEndpointId);
            const [row] = await db.$queryRawUnsafe<Array<{ checkId: string; checkIdDigest: string }>>(
                'SELECT "checkId", "checkIdDigest" FROM "PluginWebhookEndpoint" WHERE "id" = ?', endpoint.webhookEndpointId);
            expect(row).toEqual({ checkId: rawCheckId,
                checkIdDigest: createHash('sha256').update(JSON.stringify(rawCheckId)).digest('hex') });
            expect(await actions.ensureHeartbeat({ accountId, callerPluginId: pluginId, input: heartbeatInput })).toEqual(endpoint);
            expect(await actions.readHeartbeat({ accountId, caller: target.materialization, input: {
                webhookEndpointId: endpoint.webhookEndpointId, sourceInstanceId: heartbeatInput.sourceInstanceId, checkId: rawCheckId,
            } })).toEqual({ kind: 'ready', lastAcceptedAt: null });
        }
        expect(new Set(endpointIds).size).toBe(2);
        const ordinaryInput = PluginWebhookEndpointEnsureInputV1Schema.parse({ ...input,
            sourceInstanceId: 'ordinary-source', setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
            idempotencyKey: 'ordinary-source-identity-1' });
        const ordinaryParams = { accountId, input: ordinaryInput, target,
            contribution: { pluginId, localId: 'heartbeat', handlerActionLocalId: 'receive',
                verifierKind: 'github_hmac_sha256_v1' as const, routingKind: 'accountEndpoint' as const },
            publicBaseUrl: 'https://happier.example' };
        const ordinary = await ensurePluginWebhookEndpointV1(ordinaryParams);
        const [ordinaryRow] = await db.$queryRawUnsafe<Array<{ checkId: string; checkIdDigest: string }>>(
            'SELECT "checkId", "checkIdDigest" FROM "PluginWebhookEndpoint" WHERE "id" = ?', ordinary.webhookEndpointId);
        expect(ordinaryRow).toEqual({ checkId: '', checkIdDigest: '' });
        await expect(ensurePluginWebhookEndpointV1({ ...ordinaryParams,
            input: { ...ordinaryInput, idempotencyKey: 'ordinary-source-identity-2' },
        })).rejects.toMatchObject({ code: 'source_conflict' });
    });
});
