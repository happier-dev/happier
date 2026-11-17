import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import Fastify from 'fastify';
import { io } from 'socket.io-client';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { DaemonFilesystemListDirectoryResponseSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { Fastify as AppFastify } from '../../../../server/sources/app/api/types';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { inTx } from '../../../../server/sources/storage/inTx';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { enableSchemaValidation } from '../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../server/sources/app/api/utils/enableAuthentication';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { registerAccountProfileRoute } from '../../../../server/sources/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { registerAuthPingRoute } from '../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { featuresRoutes } from '../../../../server/sources/app/api/routes/features/featuresRoutes';
import { startSocket } from '../../../../server/sources/app/api/socket';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { RpcHandlerManager } from '../../../../cli/src/api/rpc/RpcHandlerManager';
import { registerMachineFileBrowserHandlers } from '../../../../cli/src/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../cli/src/api/machine/machineRpcAuthorization';
import { encrypt } from '../../../../cli/src/api/encryption';
import { registerExternalActionRpcHandler } from '../../../../cli/src/rpc/handlers/externalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../cli/src/api/externalActionExecutionAuthorization';
import { prepareRequesterAccountActionContext } from '../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createCliActionDeps } from '../../../../cli/src/session/actions/createCliActionDeps';
import type { StoredCredentials } from '../../../../cli/src/persistence';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { observeServerFeaturesSnapshot } from '../../../../cli/src/features/serverFeaturesClient';
import { Encryption } from '@/sync/encryption/encryption';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { machineFilesystemListDirectory } from './machineFileBrowser';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import integrationConfig from '../../../vitest.integration.config';

describe('recipient directory through real Home, socket and daemon filesystem owners', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-recipient-directory-', initAuth: true,
            initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => {
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
        if (database) await database.close();
    });

    it('opens the recipient envelope and lists real files without confusing Account and Machine keys', async () => {
        const ownerSecret = new Uint8Array(randomBytes(32));
        const requesterSecret = new Uint8Array(randomBytes(32));
        const ownerEncryption = await Encryption.create(ownerSecret);
        const requesterEncryption = await Encryption.create(requesterSecret);
        async function account(encryption: Encryption) {
            const signing = tweetnacl.sign.keyPair();
            return db.account.create({ data: { encryptionMode: 'e2ee', publicKey: Buffer.from(signing.publicKey).toString('hex'),
                contentPublicKey: new Uint8Array(encryption.contentDataKey), contentPublicKeySig: signAccountContentKeyBindingV1({
                    accountSigningSecretKey: signing.secretKey, contentPublicKey: encryption.contentDataKey,
                }) } });
        }
        const owner = await account(ownerEncryption);
        const requester = await account(requesterEncryption);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const installationKeys = tweetnacl.sign.keyPair();
        const installationId = crypto.randomUUID();
        const installationPrivateKey = encodeBase64(installationKeys.secretKey, 'base64url');
        const machineKey = new Uint8Array(randomBytes(32));
        const ownerEnvelope = await ownerEncryption.encryptEncryptionKey(machineKey);
        const requesterEnvelope = await requesterEncryption.encryptEncryptionKey(machineKey);
        const root = join(database.baseDir, 'project');
        await mkdir(join(root, 'src'), { recursive: true });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            installationId, installationPublicKey: new Uint8Array(installationKeys.publicKey),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
            dataEncryptionKey: new Uint8Array(ownerEnvelope), metadata: encodeBase64(encrypt(machineKey, 'dataKey', {
                host: 'recipient-directory', platform: 'linux', happyCliVersion: '0.3', homeDir: database.baseDir,
                happyHomeDir: database.baseDir,
            })) } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
            actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view',
        }))).toMatchObject({ kind: 'saved' });
        await db.machineKeyEnvelope.create({ data: { machineId: machine.id, recipientAccountId: requester.id,
            encryptedDataKey: new Uint8Array(requesterEnvelope), machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(ownerEnvelope),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requesterEncryption.contentDataKey) } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app);
        registerAccountProfileRoute(app); registerAccountEncryptionRoutes(app); registerAuthPingRoute(app);
        registerAccountSettingsRoutes(app);
        machinesRoutes(app); featuresRoutes(app); startSocket(app);
        registerExternalActionRoutes(app);
        onTestFinished(async () => { await app.close(); });
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        const snapshot = await observeServerFeaturesSnapshot({ serverUrl: endpoint });
        if (snapshot.status !== 'ready') throw new Error('Machine Home features did not settle');
        const manager = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id,
            encryptionKey: machineKey, encryptionVariant: 'dataKey', authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: machine.id, resolveCustodianAccountId: async () => owner.id, resolveInstallationId: () => installationId,
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, serverHttpBaseUrl: endpoint,
                    daemonToken: ownerToken, privateKey: installationPrivateKey }),
            }) });
        registerMachineFileBrowserHandlers({ rpcHandlerManager: manager, workingDirectory: root });
        const serverIdentityId = await getOrCreateServerIdentityId();
        const ownerCredentials: StoredCredentials = { token: ownerToken, encryption: { type: 'dataKey',
            machineKey: ownerEncryption.getContentPrivateKey(), publicKey: ownerEncryption.contentDataKey } };
        const nativeTarget = { machineId: machine.id,
            invoke: (method: string, input: unknown, options: Parameters<RpcHandlerManager['invokeLocal']>[2]) =>
                manager.invokeLocal(method, input, options),
        };
        const actionParams = { token: ownerToken, credentials: ownerCredentials, sessionId: '', mode: 'e2ee' as const,
            ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' as const },
            serverId: serverIdentityId, serverIdentityId, serverHttpBaseUrl: endpoint,
            machineActionDirectTargetTransport: nativeTarget,
            externalActionMachineInstallationId: installationId,
            externalActionMachineRequestPrivateKey: installationPrivateKey,
        };
        const verifyRoot: Parameters<typeof registerExternalActionRpcHandler>[1]['verifyExecutionAuthorization'] = input =>
            verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey: installationPrivateKey,
                installationId, serverHttpBaseUrl: endpoint });
        registerExternalActionRpcHandler(manager, { machineId: machine.id, currentServerId: serverIdentityId,
            currentServerHttpBaseUrl: endpoint, resolveAccountId: async () => owner.id,
            resolveInstallationId: () => installationId, externalActionMachineRequestPrivateKey: installationPrivateKey,
            verifyExecutionAuthorization: verifyRoot,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: ownerCredentials, serverApiUrl: endpoint }),
            executor: createActionExecutor(createCliActionDeps(actionParams)),
            prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
                purpose: request.purpose ?? { kind: 'external_action' }, machineId: machine.id, installationId,
                installationPrivateKey: installationKeys.secretKey, serverId: serverIdentityId, serverIdentityId,
                serverHttpBaseUrl: endpoint, ownCredentials: ownerCredentials,
                isCurrent: () => verifyRoot({ authorization: request.authorization,
                    effectActionId: request.authorization.binding.actionId,
                    target: request.authorization.binding.target, signal: request.signal }),
                createExecutor: context => createActionExecutor(createCliActionDeps({ ...actionParams,
                    token: context.credentials.token, credentials: context.credentials,
                    savedSecretOperationContext: context.savedSecretOperationContext,
                    actionsSettingsProvider: { getActionsSettings: () => context.accountSettingsContext.settings.actionsSettingsV1,
                        getAccountSettings: () => context.accountSettingsContext.settings },
                })),
            }),
        });
        const daemonSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: ownerToken, clientType: 'machine-scoped',
                machineId: machine.id, installationId, installationPublicKey: encodeBase64(installationKeys.publicKey, 'base64url'),
                installationProof: signMachineInstallationProof({ payload: { version: 1, installationId,
                    machineId: machine.id, accountId: owner.id }, privateKey: installationPrivateKey }) } });
        onTestFinished(() => { daemonSocket.disconnect(); });
        let daemonReceipts = 0;
        daemonSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, acknowledge: (reply: unknown) => void) => {
            daemonReceipts += 1;
            void runWithServerHttpBaseUrl(endpoint, () => manager.handleRequest(request))
                .then(acknowledge, error => acknowledge({ error: String(error) }));
        });
        daemonSocket.on('connect', () => manager.onSocketConnect(daemonSocket));
        daemonSocket.on('disconnect', () => manager.onSocketDisconnect());
        await new Promise<void>((resolve, reject) => { daemonSocket.once('connect', resolve); daemonSocket.once('connect_error', reject); daemonSocket.connect(); });
        expect(await manager.waitForRegisteredHandlers([RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1], { timeoutMs: integrationConfig.test!.testTimeout! })).toEqual({ status: 'ready' });
        // Connection claims withdraw connection-owned facts. Publish the installed
        // authorization boundary's support through the current socket after registration.
        expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(await daemonSocket.emitWithAck(
            MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, { machineId: machine.id,
                capabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                    requesterExecutionIsolation: snapshot.features.capabilities?.machines?.requesterExecutionIsolation } },
        ))).toMatchObject({ result: 'success' });
        const profile = await adoptHomeProfile({ descriptor: { serverUrl: endpoint, homeServerIdentityId: serverIdentityId,
            displayName: 'Recipient directory' }, source: 'manual' });
        const credentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint, { serverId: profile.id }, {
            token: requesterToken, secret: encodeBase64(requesterSecret, 'base64url'),
        });
        if (!credentials) throw new Error('Requester credentials unavailable');
        onTestFinished(async () => { expect(await credentials.rollback()).toBe(true); });
        const result = await machineFilesystemListDirectory(machine.id, { path: root, includeFiles: false }, {
            serverId: profile.id, accountId: requester.id,
        });
        expect(result, JSON.stringify({ result, daemonReceipts })).toMatchObject({ ok: true, path: root,
            entries: [expect.objectContaining({ name: 'src', type: 'directory' })] });
        expect(DaemonFilesystemListDirectoryResponseSchema.parse(result)).toEqual(result);
        expect(daemonReceipts).toBe(1);
        const outsiderSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: outsiderToken, clientType: 'user-scoped' } });
        onTestFinished(() => { outsiderSocket.disconnect(); });
        await new Promise<void>((resolve, reject) => { outsiderSocket.once('connect', resolve); outsiderSocket.once('connect_error', reject); outsiderSocket.connect(); });
        await expect(callSocketRpc({ socket: outsiderSocket, target: { kind: 'machine', id: machine.id },
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY, params: { path: root }, content: { mode: 'plain' }, timeoutMs: 10_000,
        })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(daemonReceipts).toBe(1);
    });
});
