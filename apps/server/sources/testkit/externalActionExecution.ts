import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
    ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAccountTokenForTests } from './lightSqliteHarness';
import { createLightSqliteHarness, type LightSqliteSetupPhase } from './lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerEnvironmentSecretLaunchAdmissionRoute } from '@/app/api/routes/deployments/environmentSecretLaunchAdmissionRoute';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { registerPeerMediationGrantRoutes } from '@/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes';
import { resolveServerFeaturesForGating } from '@/app/features/catalog/serverFeatureGate';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readMachineConnectorSecretGrantInTx, setMachineConnectorSecretGrantInTx } from '@/app/deployments/environmentSecretGrantRepository';
import { MachineConnectorSecretGrantSubjectV1Schema } from '@happier-dev/deployment-protocol';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { Server } from 'socket.io';
import { io as connectSocket } from 'socket.io-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import type { ExternalActionHomeForTestsOptions, ExternalActionHomeForTests } from './externalActionExecution.testkit.mjs';
export type { ExternalActionHomeForTestsOptions, ExternalActionHomeForTests } from './externalActionExecution.testkit.mjs';

/** Real Home ingress for consumers that substitute only the remote daemon transport. */
export async function createExternalActionHomeForTests(options: ExternalActionHomeForTestsOptions,
    observeSetup?: (phase: LightSqliteSetupPhase | 'sqlite_setup' | 'identity_seed' | 'listen' | 'socket_ready') => void,
): Promise<ExternalActionHomeForTests> {
    observeSetup?.('sqlite_setup');
    const sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-external-action-home-', initAuth: true, observeSetup,
        env: { HAPPIER_SERVER_IDENTITY_ID: options.serverIdentityId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            ...(options.workspaceSyncTarget ? { HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: 'true',
                HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED: 'true' } : {}),
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none' } });
    observeSetup?.('identity_seed');
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    const io = new Server(app.server, { path: '/v1/updates', transports: ['websocket'] });
    const daemons = new Map<string, ReturnType<typeof connectSocket>>();
    let closed = false;
    const active = new Map<string, AbortController>();
    const close = async () => {
        if (closed) return;
        closed = true;
        for (const controller of active.values()) controller.abort();
        for (const daemon of daemons.values()) daemon.disconnect();
        try { await new Promise<void>(resolve => io.close(() => resolve())); }
        finally { try { await app.close(); } finally { await sqlite.close(); } }
    };
    try {
        const accountEncryptionMode = options.accountEncryptionMode ?? 'plain';
        const machineStoredContent = options.machineStoredContent ?? {
            metadata: encodePlainMachineStoredContent({ host: 'external Action receiver', platform: process.platform,
                happyCliVersion: 'test', homeDir: sqlite.baseDir, happyHomeDir: sqlite.baseDir }),
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        };
        await db.account.create({ data: { id: options.accountId, encryptionMode: accountEncryptionMode } });
        await db.machine.create({ data: { id: options.machineId, accountId: options.accountId,
            installationId: options.installationId, installationPublicKey: new Uint8Array(options.installationPublicKey),
            metadata: machineStoredContent.metadata, dataEncryptionKey: decodeBase64(machineStoredContent.dataEncryptionKey),
            active: true, lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                ...(options.manageGranteeAccountId && options.workspaceSyncTarget
                    ? { requesterExecutionIsolation: { protocolVersions: [1] } } : {}),
                ...(options.workspaceSyncTarget ? { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64),
                    directAddresses: ['127.0.0.1:7777'] } } : {}) },
        } });
        if (options.session) {
            const { ownerMetadata, ...session } = options.session;
            await db.session.create({ data: { ...session, accountId: options.accountId, tag: randomUUID(),
                encryptionMode: 'plain', ownerMetadata: JSON.stringify(ownerMetadata) } });
            await db.accessKey.create({ data: { accountId: options.accountId, machineId: options.machineId,
                sessionId: options.session.id, data: 'opaque-source-key' } });
            app.decorate('resolveCurrentSessionMachine', async ({ sessionId }: Readonly<{ sessionId: string }>) =>
                sessionId === options.session?.id ? options.machineId : null);
            registerSessionPatchRoute(app);
        }
        const token = await auth.createToken(options.accountId, undefined, options.authentication === 'present_user'
            ? { kind: 'account', authority: 'present_user' } : { kind: 'terminal', authority: 'account_automation' });
        const peers = [{ accountId: options.accountId, machineId: options.machineId,
            installationId: options.installationId, token }];
        if (options.workspaceSyncTarget) {
            const target = options.workspaceSyncTarget;
            await db.account.create({ data: { id: target.accountId, encryptionMode: 'plain' } });
            await db.machine.create({ data: { id: target.machineId, accountId: target.accountId,
                installationId: target.installationId, installationPublicKey: new Uint8Array(target.installationPublicKey),
                metadata: encodePlainMachineStoredContent({ host: 'Sync target', platform: 'linux', happyCliVersion: 'test',
                    homeDir: sqlite.baseDir, happyHomeDir: sqlite.baseDir }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: true, lastActiveAt: new Date(),
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64), directAddresses: ['127.0.0.1:7777'] },
                    requesterExecutionIsolation: { protocolVersions: [1] } },
            } });
            const granted = await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
                actorAccountId: target.accountId, machineId: target.machineId,
                principal: { kind: 'account', accountId: options.accountId }, level: 'admin',
            }));
            if (granted.kind !== 'saved') throw new Error('external_action_home_target_grant_refused');
            peers.push({ accountId: target.accountId, machineId: target.machineId, installationId: target.installationId,
                token: await auth.createToken(target.accountId, undefined, { kind: 'terminal', authority: 'account_automation' }) });
            io.use(async (socket, next) => {
                const verified = await auth.verifyTokenForRoute(socket.handshake.auth.token);
                const peer = peers.find(candidate => candidate.token === socket.handshake.auth.token);
                if (!verified || !peer || verified.userId !== peer.accountId) return next(new Error('invalid_token'));
                socket.data.authTokenKind = verified.authTokenKind;
                socket.data.authAuthority = narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling);
                socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
                next();
            });
        }
        let manageGrantee: ExternalActionHomeForTests['manageGrantee'];
        const manageGranteeAccountId = options.manageGranteeAccountId;
        if (manageGranteeAccountId) {
            await db.account.create({ data: { id: options.manageGranteeAccountId, encryptionMode: 'plain' } });
            if (options.workspaceSyncTarget) {
                const targetGrant = await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
                    actorAccountId: options.workspaceSyncTarget!.accountId, machineId: options.workspaceSyncTarget!.machineId,
                    principal: { kind: 'account', accountId: manageGranteeAccountId }, level: 'admin',
                }));
                if (targetGrant.kind !== 'saved') throw new Error('external_action_home_requester_target_grant_refused');
            }
            const granted = await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
                actorAccountId: options.accountId, machineId: options.machineId,
                principal: { kind: 'account', accountId: manageGranteeAccountId }, level: 'admin',
            }));
            if (granted.kind !== 'saved') throw new Error('external_action_home_manage_grant_refused');
            const admitted = await resolveMachineAdmission({ actorAccountId: options.manageGranteeAccountId,
                machineId: options.machineId, requiredRole: 'manage' });
            if (admitted.kind !== 'admitted' || admitted.role !== 'manage') throw new Error('external_action_home_manage_admission_refused');
            manageGrantee = { accountId: options.manageGranteeAccountId,
                token: await auth.createToken(options.manageGranteeAccountId, undefined, { kind: 'terminal', authority: 'account_automation' }),
                machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: admitted.actorAccountId,
                    custodianAccountId: admitted.custodianAccountId, machineId: admitted.machineId,
                    installationId: admitted.installationId, role: admitted.role, encryptionMode: admitted.encryptionMode }),
            };
            registerMachineAdmissionRoutes(app);
        }
        const registerPeerRpc = options.workspaceSyncTarget
            ? (await import('@/app/api/socket/rpc/registerSocketRpcHandlers')).registerSocketRpcHandlers : undefined;
        let readyPeers = 0;
        const ready = new Promise<void>(resolve => io.on('connection', async socket => {
            const peer = options.workspaceSyncTarget ? peers.find(candidate => candidate.token === socket.handshake.auth.token) : peers[0];
            if (!peer) throw new Error('external_action_home_unknown_peer');
            // This is the substituted remote-daemon network edge, matching the
            // carrier integration harness. Home still owns all admission facts.
            socket.data.clientType = 'machine-scoped';
            socket.data.userId = peer.accountId;
            socket.data.machineId = peer.machineId;
            socket.data.verifiedMachineInstallationId = peer.installationId;
            writeAccountStoredContentCompatibilityForSocket(socket,
                evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            registerPeerRpc?.({ userId: peer.accountId, socket, io });
            await socket.join(buildRpcMethodRoom({ userId: peer.accountId,
                method: `${peer.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` }));
            if (++readyPeers === peers.length) resolve();
        }));
        observeSetup?.('listen');
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io }) });
        if (options.workspaceSyncTarget) registerPeerMediationGrantRoutes(app, { env: sqlite.envBase });
        registerEnvironmentSecretLaunchAdmissionRoute(app);
        const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const connected = peers.map(async peer => {
            const receiver = connectSocket(baseUrl, { path: '/v1/updates', transports: ['websocket'],
                reconnection: false, autoConnect: false,
                auth: { ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                    token: peer.token, clientType: 'machine-scoped', machineId: peer.machineId } });
            daemons.set(peer.machineId, receiver);
            receiver.on(SOCKET_RPC_EVENTS.CANCEL, (packet: Readonly<{ requestId: string }>) => active.get(packet.requestId)?.abort());
            receiver.on(SOCKET_RPC_EVENTS.REQUEST, async (packet: SocketRpcRequestPayload, acknowledge: (result: unknown) => void) => {
                const controller = new AbortController();
                if (packet.requestId) active.set(packet.requestId, controller);
                try { acknowledge(await options.dispatch(packet, { signal: controller.signal })); }
                catch { acknowledge({ ok: false, error: 'remote_daemon_failed' }); }
                finally { if (packet.requestId) active.delete(packet.requestId); }
            });
            observeSetup?.('socket_ready');
            await new Promise<void>((resolve, reject) => {
                receiver.once('connect', resolve);
                receiver.once('connect_error', reject);
                receiver.connect();
            });
        });
        await Promise.all([ready, ...connected]);
        const exactConnectorSubject = (raw: unknown) => {
            const subject = MachineConnectorSecretGrantSubjectV1Schema.parse(raw);
            if (subject.machineId !== options.machineId || subject.installationId !== options.installationId) {
                throw new Error('external_action_home_connector_target');
            }
            return subject;
        };
        return {
            token,
            ...(options.workspaceSyncTarget ? { peerMediationGrantSigningKeys:
                resolveServerFeaturesForGating(sqlite.envBase).capabilities.machines.peerMediation.grantSigningKeys } : {}),
            forwardMachineRpc: async (machineId, payload) => {
                const sender = daemons.get(machineId);
                const receiver = daemons.get(payload.method.slice(0, payload.method.indexOf(':')));
                if (!options.workspaceSyncTarget || !sender || !receiver) throw new Error('external_action_home_rpc_peer_unavailable');
                await new Promise<void>((resolve, reject) => {
                    const registered = (packet: Readonly<{ method: string }>) => {
                        if (packet.method !== payload.method) return;
                        receiver.off(SOCKET_RPC_EVENTS.REGISTERED, registered);
                        receiver.off(SOCKET_RPC_EVENTS.ERROR, failed);
                        resolve();
                    };
                    const failed = (packet: Readonly<{ method?: string }>) => {
                        if (packet.method !== payload.method) return;
                        receiver.off(SOCKET_RPC_EVENTS.REGISTERED, registered);
                        receiver.off(SOCKET_RPC_EVENTS.ERROR, failed);
                        reject(new Error('external_action_home_rpc_registration_refused'));
                    };
                    receiver.on(SOCKET_RPC_EVENTS.REGISTERED, registered);
                    receiver.on(SOCKET_RPC_EVENTS.ERROR, failed);
                    receiver.emit(SOCKET_RPC_EVENTS.REGISTER, { method: payload.method });
                });
                return sender.emitWithAck(SOCKET_RPC_EVENTS.CALL, payload);
            },
            ...(manageGrantee ? { manageGrantee } : {}),
            readConnectorGrantCount: async raw => {
                const subject = exactConnectorSubject(raw);
                return await inReadSnapshot(tx => readMachineConnectorSecretGrantInTx(tx, subject)) ? 1 : 0;
            },
            removeConnectorGrant: async raw => {
                const subject = exactConnectorSubject(raw);
                await inTx(tx => setMachineConnectorSecretGrantInTx(tx, { subject, grant: null }));
            },
            request: async (method, path, body, headers = {}, signal) => {
                const requestHeaders = new Headers(headers);
                if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
                const response = await fetch(new URL(path, baseUrl), { method, headers: requestHeaders,
                    body: JSON.stringify(body), signal });
                const text = await response.text();
                return { status: response.status, data: text ? JSON.parse(text) as unknown : null };
            },
            close,
        };
    } catch (error) { await close(); throw error; }
}

/** Mint a plain-Account root through real HTTP authentication, then sign the exact POST with the installed Machine key. */
export async function createSignedExternalActionPostHeadersForTests(
    app: Pick<FastifyInstance, 'inject'>,
    input: Readonly<{
        accountId: string;
        machineId: string;
        installationId: string;
        privateKey: Uint8Array;
        actionId: string;
        actionInput: unknown;
        path: string;
        body: Record<string, unknown>;
    }>,
): Promise<Readonly<Record<string, string>>> {
    const token = await createAccountTokenForTests(input.accountId, { kind: 'account', authority: 'present_user' });
    const minted = await app.inject({ method: 'POST',
        url: bindExternalActionExecutionAuthorizationHttpPathV1(input.actionId),
        headers: { authorization: `Bearer ${token}` },
        payload: { v: 1, machineId: input.machineId, envelope: { v: 1, requestId: randomUUID(),
            target: { kind: 'machine', machineId: input.machineId }, input: input.actionInput } },
    });
    if (minted.statusCode !== 200) throw new Error(`External Action root mint refused (${minted.statusCode})`);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
    return {
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.actionId,
        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
            effectActionId: input.actionId, target: root.binding.target, installationId: input.installationId,
            requestId: root.binding.requestId, method: 'POST', path: input.path, body: input.body, privateKey: input.privateKey }),
    };
}
