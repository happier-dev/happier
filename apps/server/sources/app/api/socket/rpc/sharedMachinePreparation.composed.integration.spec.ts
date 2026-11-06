import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { io as connect } from 'socket.io-client';
import { Server } from 'socket.io';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1,
    resolvePublishedMachineDataEncryptionKeyV1 } from '@happier-dev/protocol';
import { callSocketRpc, type SocketRpcContent } from '@happier-dev/sync-client';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodeBase64 as encodeCanonicalBase64 } from '@happier-dev/protocol/crypto/base64';
import { buildMachineAgentsDetectRequest, projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { parseCapabilitiesDetectResponse } from '../../../../../../ui/sources/sync/api/capabilities/capabilitiesProtocol';
import { parseDaemonContributionRegistryProjectionDescribeResponse } from '../../../../../../ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { currentAccountStoredContentCompatibilitySocketAuth } from '@/app/api/testkit/accountStoredContentCompatibility';
import * as machineAccess from '@/app/machines/machineAccess';
import { serializeAccessibleMachineRow } from '@/app/machines/machineSerialization';
import { startSocket } from '../../socket';
import type { Fastify as AppFastify } from '../../types';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../../../cli/src/api/machine/machineRpcAuthorization';
import { encrypt, decrypt } from '../../../../../../cli/src/api/encryption';
import { registerSessionCreationTargetPreparationRpc } from '../../../../../../cli/src/session/creation/registerSessionCreationTargetPreparationRpc';
import { createActionOperationStore } from '../../../../../../cli/src/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '../../../../../../cli/src/daemon/actionOperations/actionOperationRunner';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from '../../../../../../cli/src/daemon/actionOperations/actionOperationRpcHandlers';
import { registerCapabilitiesHandlers } from '../../../../../../cli/src/rpc/handlers/capabilities';
import { registerDaemonContributionRegistryProjectionHandler } from '../../../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection';
import { createResolvedContributionRegistry } from '../../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { loadBundledPluginLocatorResult } from '../../../../../../cli/src/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '../../../../../../cli/src/plugins/projection/registry/resolvePluginContributions';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../../../../../cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests';

let harness: LightSqliteHarness;
const DIRECTORY_PREFLIGHT = RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-shared-preflight-', initAuth: true, initEncrypt: true }); }, 180_000);
afterAll(async () => { if (harness) await harness.close(); });

it('composes requester bound-v2 client, real Home sockets and guest inventory/preparation/operation readers', async () => {
    const ownerKeys = tweetnacl.box.keyPair(), requesterKeys = tweetnacl.box.keyPair();
    const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
    const requester = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(requesterKeys.publicKey) } });
    const installation = tweetnacl.sign.keyPair(), dataKey = tweetnacl.randomBytes(32);
    const ownerEnvelope = sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: ownerKeys.publicKey, randomBytes: tweetnacl.randomBytes });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: 'opaque',
        dataEncryptionKey: ownerEnvelope, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(installation.publicKey),
        active: true, lastActiveAt: new Date() } });
    expect(await inTx(tx => machineAccess.setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
        principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
    const census = await inTx(tx => machineAccess.readMachineRecipientCensusInTx(tx, { actorAccountId: owner.id, machineId: machine.id }));
    if ('kind' in census) throw new Error(census.code);
    const recipientEnvelope = sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: requesterKeys.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(await inTx(tx => machineAccess.commitMachineRecipientKeyEnvelopesInTx(tx, {
        actorAccountId: owner.id, machineId: machine.id,
        expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
        expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
        expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
        recipientKeyEnvelopes: [{ recipientAccountId: requester.id, encryptedDataKey: encodeBase64(recipientEnvelope),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requesterKeys.publicKey) }],
    }))).toMatchObject({ appliedRecipientAccountIds: [requester.id] });
    const actor = { actorAccountId: requester.id, machineId: machine.id };
    const projection = await inTx(async tx => {
        const access = await machineAccess.readAccessibleMachineAccessInTx(tx, actor);
        if (!access) throw new Error('Current requester access is required');
        const published = await tx.machine.findUniqueOrThrow({ where: { id: machine.id },
            include: { managedResource: { select: { id: true, homeId: true } } } });
        return serializeAccessibleMachineRow(published, { access, owned: false,
            callerDataEncryptionKey: await machineAccess.readMachineDataKeyForCallerInTx(tx, actor) });
    });
    expect(projection.dataEncryptionKey).not.toBe(projection.keyBasis.dataEncryptionKey);
    if (!projection.dataEncryptionKey) throw new Error('Requester envelope unavailable');
    const requesterMachineKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(projection.dataEncryptionKey), recipientSecretKeyOrSeed: requesterKeys.secretKey });
    expect(requesterMachineKey).toEqual(dataKey);
    if (!requesterMachineKey) throw new Error('Requester Machine key unavailable');
    // Consume the actual Home row projection through the same key decision used
    // by the UI's scoped Machine transport; owner write identity is not its opening key.
    expect(resolvePublishedMachineDataEncryptionKeyV1({ machine: projection, viewerAccountId: requester.id,
        openedDataEncryptionKey: requesterMachineKey })).toEqual({ status: 'e2ee', dataKey });
    const daemonToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
    const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerMachineAdmissionRoutes(app);
    startSocket(app as unknown as AppFastify);
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const manager = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id,
        encryptionMode: 'e2ee', encryptionKey: dataKey, encryptionVariant: 'dataKey', logger() {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId: machine.id, resolveInstallationId: () => machine.installationId,
            resolveCustodianAccountId: async () => owner.id,
            verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: installation.secretKey,
                daemonToken, serverHttpBaseUrl: origin }),
        }),
    });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: manager });
    registerCapabilitiesHandlers(manager);
    const bundledAgents = loadBundledPluginLocatorResult(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter(
        ({ pluginId }) => pluginId === 'happier.agent.claude' || pluginId === 'happier.agent.codex',
    ));
    expect(bundledAgents.pluginFailures).toEqual([]);
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: { loadedPlugins: bundledAgents.loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party',
    }));
    registerDaemonContributionRegistryProjectionHandler(manager, {
        resolveRegistry: async () => registry,
        resolveInstalledPackages: async () => [],
        // Home feature retrieval is an external network boundary. All registry
        // producers, request admission and the client response parser stay real.
        resolveServerFeaturesSnapshot: async () => undefined,
    });
    const store = createActionOperationStore();
    for (const accountId of [owner.id, requester.id]) store.create({ operationId: `op-${accountId}`, actionId: 'projects.script.run',
        title: 'Run', scope: { accountId, machineId: machine.id }, cancellation: 'unsupported', inputIdentity: '{}' });
    registerActionOperationRpcHandlers(manager, createActionOperationRpcHandlers({ store,
        runner: createActionOperationRunner({ store, resolveAction: () => null }), machineId: machine.id, resolveAccountId: async () => owner.id }));

    // No internal owners or transport are replaced: the requester and guest
    // connect to the actual Home; only the guest process runs in this test.
    let wrongMethod = false;
    const options = { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false };
    const daemon = connect(origin, { ...options, auth: { token: daemonToken, clientType: 'machine-scoped',
        machineId: machine.id, runtimeId: 'shared-machine-test', startupSource: 'manual', serviceManaged: false,
        installationId: machine.installationId, installationPublicKey: encodeCanonicalBase64(installation.publicKey, 'base64url'),
        installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
            installationId: machine.installationId!, accountId: owner.id }, privateKey: installation.secretKey }),
        ...currentAccountStoredContentCompatibilitySocketAuth } });
    const socket = connect(origin, { ...options, auth: { token: requesterToken,
        ...currentAccountStoredContentCompatibilitySocketAuth } });
    const connected = (client: ReturnType<typeof connect>) => new Promise<void>((resolve, reject) => {
        client.once('connect', resolve); client.once('connect_error', reject); client.connect();
    });
    daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (result: unknown) => void) => {
        acknowledge(await manager.handleRequest(wrongMethod ? { ...request, method: `${machine.id}:${ACTION_OPERATION_RPC_METHODS_V2.list}` } : request));
    });
    const content = (key: Uint8Array): SocketRpcContent => ({ mode: 'e2ee', cipher: {
        encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
        decryptRaw: async value => decrypt(key, 'dataKey', new Uint8Array(Buffer.from(value, 'base64'))),
    } });
    const call = (method: string, params: unknown, key = requesterMachineKey) => callSocketRpc({ socket,
        target: { kind: 'machine', id: machine.id }, method, params, content: content(key), timeoutMs: 10_000 });
    const missing = join(harness.baseDir, 'must-not-create');
    try {
        await connected(daemon);
        for (const method of [DIRECTORY_PREFLIGHT, RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
            ACTION_OPERATION_RPC_METHODS_V2.list, RPC_METHODS.CAPABILITIES_DETECT,
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE]) {
            const qualified = `${machine.id}:${method}`;
            const registered = new Promise<void>((resolve, reject) => {
                const receive = (value: { method: string }) => {
                    if (value.method === qualified) { daemon.off(SOCKET_RPC_EVENTS.REGISTERED, receive); resolve(); }
                };
                daemon.on(SOCKET_RPC_EVENTS.REGISTERED, receive);
                daemon.once(SOCKET_RPC_EVENTS.ERROR, reject);
            });
            daemon.emit(SOCKET_RPC_EVENTS.REGISTER, { method: qualified });
            await registered;
        }
        await connected(socket);
        const home = (app as unknown as AppFastify).machineDaemonPresence;
        if (!(home instanceof Server)) throw new Error('Expected actual Home sockets');
        expect(await home.in(`rpc:${owner.id}:${machine.id}:${RPC_METHODS.CAPABILITIES_DETECT}`).fetchSockets())
            .toMatchObject([{ data: { clientType: 'machine-scoped', machineId: machine.id,
                verifiedMachineInstallationId: machine.installationId } }]);
        const describe = () => call(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { machineId: machine.id });
        const described = parseDaemonContributionRegistryProjectionDescribeResponse(await describe());
        expect(Object.keys(described?.projection.agentsById ?? {}).sort()).toEqual(['claude', 'codex']);
        // A mis-bound registry handler must fail the real client parser rather
        // than masquerade as an empty installed-Agent inventory.
        manager.unregisterHandler(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(parseDaemonContributionRegistryProjectionDescribeResponse(await describe())).toBeNull();
        registerDaemonContributionRegistryProjectionHandler(manager, {
            resolveRegistry: async () => registry,
            resolveInstalledPackages: async () => [],
            resolveServerFeaturesSnapshot: async () => undefined,
        });
        expect(Object.keys(parseDaemonContributionRegistryProjectionDescribeResponse(await describe())?.projection.agentsById ?? {}).sort())
            .toEqual(['claude', 'codex']);
        // Use admits Agent inventory, not the custodian's connected-account
        // control carrier. With no registered control target, FORBIDDEN also
        // distinguishes admission-before-discovery from a routing failure.
        await expect(call(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema.parse({
            v: 1, machineId: machine.id,
            command: { operation: 'describeService', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
        }))).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        const definitions = [{ definitionId: 'shared-command', title: 'Shared command',
            launch: { kind: 'command' as const, command: process.execPath, args: [] } }];
        const detectRequest = buildMachineAgentsDetectRequest({ agents: [], definitions, refresh: true });
        const detected = parseCapabilitiesDetectResponse(await call(RPC_METHODS.CAPABILITIES_DETECT, detectRequest));
        expect(detected).not.toBeNull();
        expect(projectMachineAgentsDetectResponse({ agents: [], definitions, response: detected! })).toMatchObject({ items: [
            { definitionId: 'shared-command', installed: true, fit: { kind: 'can_run' } },
        ] });
        expect(await call(DIRECTORY_PREFLIGHT, { directory: { kind: 'path', path: harness.baseDir } }))
            .toEqual({ ok: true, directory: harness.baseDir, directoryKind: 'path', directoryCreationRequired: false, checkout: null });
        expect(await call(DIRECTORY_PREFLIGHT, { directory: { kind: 'path', path: missing } }))
            .toMatchObject({ ok: true, directoryCreationRequired: true });
        await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' });
        // A shared read must not expose preparation's worktree or managed-directory writes.
        for (const params of [{ directory: { kind: 'managed' }, sessionCreationTag: `create:v1:${'a'.repeat(43)}` },
            { directory: { kind: 'path', path: harness.baseDir }, checkoutCreationDraft: { kind: 'git_worktree', displayName: 'new-worktree', baseRef: null } }]) {
            expect(await call(DIRECTORY_PREFLIGHT, params)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        }
        await expect(call(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, { directory: { kind: 'path', path: missing } }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        const operations = await call(ACTION_OPERATION_RPC_METHODS_V2.list, {});
        expect(operations).toMatchObject({ items: [{ operationId: `op-${requester.id}`, scope: { accountId: requester.id } }] });
        expect(JSON.stringify(operations)).not.toContain(`op-${owner.id}`);
        // Missing registration models an older guest: it must never fall back to
        // the older materializing preparation method under shared Use.
        manager.unregisterHandler(DIRECTORY_PREFLIGHT);
        expect(await call(DIRECTORY_PREFLIGHT, { directory: { kind: 'path', path: missing } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: manager });
        // Mis-bound method/key must fail at the real bound-v2 consumer, not reach a different handler.
        wrongMethod = true;
        await expect(call(DIRECTORY_PREFLIGHT, { directory: { kind: 'path', path: missing } }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        wrongMethod = false;
        await expect(call(ACTION_OPERATION_RPC_METHODS_V2.list, {}, requesterKeys.secretKey))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        await inTx(tx => machineAccess.removeMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id } }));
        await expect(call(DIRECTORY_PREFLIGHT, { directory: { kind: 'path', path: missing } }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        await expect(describe()).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { socket.close(); daemon.close(); await app.close(); }
}, 30_000);
