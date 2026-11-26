import '../../../../ui/sources/dev/vitestSetup';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { configuration } from '@/configuration';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import type { RpcRequest } from '@/api/rpc/types';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { MACHINE_SESSION_STOP_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/lifecycle/createStopSessionLifecycleActionExecutor';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { buildWorkflowActionContext } from '../workflows/workflowActionContext';
import { createWorkflowRunMachineTransport } from '../workflows/workflowMachineTransport';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '../../../../server/sources/app/api/socket/machineSocketInstallationProof';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
import { narrowCredentialAuthority } from '../../../../server/sources/app/auth/effectiveCredentialAuthority';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Socket } from 'socket.io';
import { io as createSocketClient } from 'socket.io-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
    MachineSessionTerminalCaptureResponseV1Schema, MachineSessionTerminalFinalizeResponseV1Schema,
    type MachineSessionTerminalAuthorityV1 } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { createSessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { z } from 'zod/mini';
import { SessionMetadataTuplePatchV1Schema, createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1 } from '@happier-dev/protocol';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { applySessionTurnMutation } from '../../../../server/sources/app/session/sessionWriteService';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { ExactSessionTurnEndMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { enableAuthentication } from '../../../../server/sources/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../server/sources/app/api/utils/enableErrorHandlers';
import { sessionRoutes } from '../../../../server/sources/app/api/routes/session/sessionRoutes';
import { accountRoutes } from '../../../../server/sources/app/api/routes/account/accountRoutes';
import { createSessionPublisherPresence } from '../../../../server/sources/app/presence/sessionPublisherPresence';
import { buildRpcMethodRoom } from '../../../../server/sources/app/api/socket/rpc/rpcMethodRoom';
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { machineUpdateHandler } from '../../../../server/sources/app/api/socket/machineUpdateHandler';
import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../../../../server/sources/app/api/testkit/socketHarness';
import { createSessionActionTarget } from '../../../../ui/sources/components/sessions/actions/sessionActionContext';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readProcessIdentityByPid } from '../processIdentity';
import type { TrackedSession } from '../types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';
import { projectMachineRpcTransportAcknowledgement } from '@/api/machine/projectMachineRpcTransportAcknowledgement';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe.skipIf(process.platform !== 'linux')('plain runner Stop retirement through Home publication', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-stop-retirement-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 0);
    afterAll(async () => { if (database) await database.close(); });

    it('uses the starter’s Session authority for same-Machine Workflow Stop, send, and title changes', async () => {
        const [owner, guest] = await Promise.all([
            db.account.create({ data: { encryptionMode: 'plain' } }),
            db.account.create({ data: { encryptionMode: 'plain' } }),
        ]);
        const machineId = randomUUID();
        const installationId = randomUUID();
        const homeId = await getOrCreateServerIdentityId();
        const serverId = configuration.activeServerId;
        const serverUrl = 'https://workflow-session-stop.example';
        await db.machine.create({ data: {
            id: machineId, accountId: owner.id, installationId, active: true,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        await db.machineGrant.create({ data: { machineId, principalKind: 'account', accountId: guest.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const createSession = async (accountId: string) => {
            const metadata = { machineId, path: database.baseDir };
            const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
            if (!ownerMetadata.ok) throw new Error('Invalid Session metadata fixture');
            const session = await db.session.create({ data: {
                accountId, tag: randomUUID(), active: false, encryptionMode: 'plain', metadataLayoutVersion: 1,
                metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
                ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)),
            } });
            await db.accessKey.create({ data: { accountId, machineId, sessionId: session.id, data: 'fixture-access' } });
            return session.id;
        };
        const ownerOrigin = await createSession(owner.id);
        const targetSession = await createSession(owner.id);
        const guestOrigin = await createSession(guest.id);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app);
        sessionRoutes(app); accountRoutes(app); machinesRoutes(app);
        const sockets = await createRequesterCurrentnessSocketHarness();
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
        const stopEffects: string[] = [];
        const rpc = new RpcHandlerManager({
            scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId, encryptionMode: 'plain',
            projectTransportAcknowledgement: projectMachineRpcTransportAcknowledgement,
            authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
                machineId, resolveInstallationId: () => installationId, resolveCustodianAccountId: async () => owner.id,
                verifyMachineAdmission: async () => { throw new Error('Stop should use the authenticated Home admission'); },
            }, source),
            logger() {},
        });
        registerSessionLifecycleRpcHandlers({ rpcHandlerManager: rpc, scopes: MACHINE_SESSION_STOP_RPC_SCOPES,
            actionExecutor: createMachineSessionStopLifecycleActionExecutor({ stopSession: async sessionId => {
                stopEffects.push(sessionId);
                return { status: 'stopped' };
            } }) });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const machineSocket = createSocketClient(sockets.serverUrl, {
            path: '/v1/updates', autoConnect: false, reconnection: false,
            auth: { token: ownerToken, clientType: 'machine-scoped',
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        });
        machineSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, acknowledge: (result: unknown) => void) => {
            void rpc.handleRequest(request, undefined, 'authenticated_home_socket').then(acknowledge);
        });
        const presence = createSessionPublisherPresence();
        sockets.server.use(async (socket, next) => {
            const verified = await auth.verifyTokenForRoute(socket.handshake.auth.token);
            if (!verified) return next(new Error('Unauthorized'));
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            socket.data.userId = verified.userId;
            socket.data.clientType = socket.handshake.auth.clientType;
            socket.data.authTokenKind = verified.authTokenKind;
            socket.data.authAuthority = narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling);
            socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
            if (socket.data.clientType === 'machine-scoped') {
                if (verified.userId !== owner.id) return next(new Error('Unexpected Machine account'));
                // Fixture for an already-verified installation at the network boundary.
                socket.data.machineId = machineId;
                socket.data[VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = installationId;
            }
            next();
        });
        sockets.server.on('connection', async socket => {
            if (socket.data.clientType === 'machine-scoped') {
                machineUpdateHandler(owner.id, socket, { sessionPublisherPresence: presence,
                    operationSocketBatchLimits: { ok: false, errorCode: 'socket_capacity_insufficient' } });
                await socket.join(buildRpcMethodRoom({ userId: owner.id, method: `${machineId}:${RPC_METHODS.STOP_SESSION}` }));
                socket.emit('fixture:workflow-machine-ready');
                return;
            }
            registerSocketRpcHandlers({ userId: socket.data.userId, socket, io: sockets.server, sessionPublisherPresence: presence });
        });
        const runs: ReturnType<typeof createWorkflowRunMachineTransport>[] = [];
        const createRun = async (accountId: string, originSessionId: string) => {
            const credentials = { token: await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
            const runId = randomUUID();
            const attribution = { serverId, accountId, machineId, installationId };
            const run = createWorkflowRunMachineTransport({
                runId, credentials, requesterWorkAttributionV1: attribution,
                machineAdmission: { actorAccountId: accountId, custodianAccountId: owner.id, encryptionMode: 'plain',
                    machineId, installationId, role: accountId === owner.id ? 'manage' : 'use' },
                boundary: { serverId, serverHttpBaseUrl: serverUrl, happyHomeDir: database.baseDir,
                    getObservedServerIdentityId: () => homeId },
                isCurrent: async () => true,
                transport: { machineId, invoke: (method, request, options) => rpc.invokeLocal(method, request, options) },
            });
            runs.push(run);
            const executor = createActionExecutor(createCliActionDeps({ credentials, token: credentials.token, sessionId: originSessionId,
                mode: 'plain', ctx: null, serverId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
                machineActionDirectTargetTransport: run.transport,
                machineAdmissionTransport: async request => {
                    const response = await machineSocket.emitWithAck(SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, request);
                    return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
                },
            }));
            const requester = await run.resolveActionRequesterContext();
            expect(requester).not.toBeNull();
            const context = { ...buildWorkflowActionContext({ runId, invocationRecordId: randomUUID(),
                authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
                origin: { kind: 'direct', originSessionId }, workspace: { machineId } }, attribution), ...requester, defaultSessionId: originSessionId };
            return { executor, context, credentials };
        };
        const send = { sessionId: targetSession, message: 'workflow input', requestedAction: { v: 1, kind: 'enqueue' }, reply: 'none' } as const;
        const title = { sessionId: targetSession, title: 'Workflow title' };
        const stop = { sessionId: targetSession };
        try {
            await new Promise<void>((resolve, reject) => {
                machineSocket.once('fixture:workflow-machine-ready', resolve);
                machineSocket.once('connect_error', reject);
                machineSocket.connect();
            });
            await runWithServerHttpBaseUrl(serverUrl, async () => {
                const ownerRun = await createRun(owner.id, ownerOrigin);
                const guestRun = await createRun(guest.id, guestOrigin);
                expect(await guestRun.executor.execute('session.stop', stop, guestRun.context))
                    .toMatchObject({ ok: true, result: { ok: false, code: 'session_not_found' } });
                expect(await guestRun.executor.execute('session.title.set', title, guestRun.context)).toMatchObject({ ok: false });
                const guestSend = await guestRun.executor.execute('session.message.send', send, guestRun.context);
                expect(guestSend).not.toMatchObject({ ok: true, result: { status: 'accepted' } });
                expect(stopEffects).toEqual([]);

                const stopped = await ownerRun.executor.execute('session.stop', stop, ownerRun.context);
                expect(stopped).toMatchObject({ ok: true, result: { sessionId: targetSession, stopped: true } });
                expect(stopEffects).toEqual([targetSession]);

                expect(await ownerRun.executor.execute('session.title.set', title, ownerRun.context)).toMatchObject({ ok: true });
                const updated = await fetchSessionByIdCompat({ reason: 'session-query', token: ownerRun.credentials.token, sessionId: targetSession });
                expect(updated && tryDecryptSessionOwnerMetadataView({ credentials: ownerRun.credentials,
                    accountEncryptionMode: 'plain', rawSession: updated })).toMatchObject({ summary: { text: title.title } });

                const sent = await ownerRun.executor.execute('session.message.send', send, ownerRun.context);
                const pending = await db.sessionPendingMessage.findMany({ where: { sessionId: targetSession }, select: { localId: true } });
                expect(pending).toHaveLength(1);
                expect(sent).toMatchObject({ ok: true, result: { status: 'accepted', localId: pending[0]?.localId } });
            });
        } finally {
            await Promise.all(runs.map(run => run.dispose()));
            machineSocket.disconnect();
            restoreHttp();
            await sockets.close();
            await app.close();
        }
    });

    it.each(['bound', 'bound-active-turn', 'bound-terminal-turn', 'missing-retirement-binding', 'replacement-runner'] as const)(
        'makes a stopped managed Session deletable only with %s', async wiring => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: '{}' } });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        let patchRejection: unknown = null;
        let patchValidation: unknown = null;
        let routeValidation: string | null = null;
        let detailFailure: Error | null = null;
        app.addHook('onError', async (request, _reply, error) => {
            if (request.method === 'GET' && request.url.startsWith('/v2/sessions/')) detailFailure = error;
        });
        app.addHook('preHandler', async request => {
            if (request.method === 'PATCH' && request.validationError) routeValidation = request.validationError.message;
        });
        app.addHook('preValidation', async request => {
            if (request.method === 'PATCH') {
                const parsed = SessionMetadataTuplePatchV1Schema.safeParse(request.body);
                if (!parsed.success) patchValidation = parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path, message: issue.message }));
            }
        });
        app.addHook('onSend', async (request, reply, payload) => {
            if (request.method === 'PATCH' && reply.statusCode === 400 && typeof payload === 'string') patchRejection = JSON.parse(payload);
            return payload;
        });
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app);
        sessionRoutes(app); accountRoutes(app);
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
        const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
            { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = once(child, 'exit');
        try {
            await once(child, 'message');
            const pid = child.pid!;
            const identity = await readProcessIdentityByPid(pid);
            if (!identity) throw new Error('Owned fixture process identity unavailable');
            const projectMetadata = (runnerPid: number, startTimeMs?: number) => {
                const metadata = { path: database.baseDir, machineId, hostPid: runnerPid,
                    hostProcessStartTimeMs: startTimeMs, startedBy: 'daemon', sessionDirectoryV1: { v: 1, kind: 'managed' } };
                const owner = createSessionOwnerMetadataV1({ metadata });
                if (!owner.ok) throw new Error('Invalid canonical owner fixture');
                return { metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
                    ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)) };
            };
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
                ...projectMetadata(pid, identity.processStartTimeMs), active: false } });
            await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: 'fixture-access' } });
            const presence = createSessionPublisherPresence();
            const registered = await presence.registerPublisher({ socket: {},
                binding: { accountId: account.id, machineId, sessionId: session.id },
                completeActivitySnapshot: { state: 'active', activeCount: 1 } });
            if (registered.status !== 'registered') throw new Error(`Fixture publisher admission failed: ${JSON.stringify(registered)}`);
            const authentication = createPresentUserSessionAccessAuthentication();
            const exactTurnId = wiring === 'bound-active-turn' || wiring === 'bound-terminal-turn' ? randomUUID() : undefined;
            if (exactTurnId) {
                for (const [action, observedAt] of [['begin', Date.now()], ['cancel', Date.now() + 1]] as const) {
                    if (action === 'cancel' && wiring !== 'bound-terminal-turn') continue;
                    expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
                        mutation: { v: 1, sessionId: session.id, mutationId: randomUUID(), action,
                            turnId: exactTurnId, observedAt } })).toMatchObject({ ok: true, didApply: true });
                }
            }
            const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, childProcess: child, startedBy: 'daemon', happySessionId: session.id,
                ...(exactTurnId ? { activeTurnId: exactTurnId } : {}),
                processStartTimeMs: identity.processStartTimeMs, stopRequestedAtMs: Date.now(),
                spawnOptions: { directory: database.baseDir } };
            const sessions = new Map([[legacyPidSessionTrackingKey(pid), tracked]]);
            // Replace only the socket carrier. The registered Machine handlers, authority
            // capture, SQLite close and post-commit publication are production owners.
            const machineSocket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId } });
            machineUpdateHandler(account.id, machineSocket as unknown as Socket, { sessionPublisherPresence: presence,
                operationSocketBatchLimits: { ok: false, errorCode: 'socket_capacity_insufficient' } });
            const machine = {
                captureMachineSessionTerminal: async (sessionId: string) => {
                    const ack = vi.fn();
                    await triggerSocketHandler(machineSocket, MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, { v: 1, sessionId }, ack);
                    return MachineSessionTerminalCaptureResponseV1Schema.parse(ack.mock.calls[0]?.[0]);
                },
                finalizeMachineSessionTerminal: async (target: { sessionId: string; authority: MachineSessionTerminalAuthorityV1 }) => {
                    const ack = vi.fn();
                    await triggerSocketHandler(machineSocket, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, { v: 1, ...target }, ack);
                    return MachineSessionTerminalFinalizeResponseV1Schema.parse(ack.mock.calls[0]?.[0]);
                },
                enqueueDaemonTerminalExactTurnEnd: async (mutation) => {
                    const result = await applySessionTurnMutation({ actorUserId: account.id, authentication,
                        mutation: ExactSessionTurnEndMutationV1Schema.parse(mutation) });
                    expect(result).toMatchObject({ ok: true,
                        receipt: { decision: wiring === 'bound-terminal-turn' ? 'duplicate-terminal' : 'applied' } });
                },
            } satisfies Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal' | 'enqueueDaemonTerminalExactTurnEnd'>;
            const onExit = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
                sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => machine as ApiMachineClient,
                removeSessionMarkerFn: async () => undefined });
            let retirementFailure: string | null = null;
            const stop = createStopSession({ trackedSessionsByKey: sessions,
                readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
                waitForTrackedRunnersExit: async () => {
                    const [code, signal] = await exited;
                    await onExit(pid, { reason: 'process-exited', code, signal });
                    // Daemon-control callers do not pass through the caller RPC's
                    // explicit-stop close. Observed exit must settle Home itself.
                    if (exactTurnId) {
                        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { active: true } }))
                            .toEqual({ active: false });
                    }
                    if (wiring === 'replacement-runner') {
                        await db.session.update({ where: { id: session.id }, data: projectMetadata(pid + 1, identity.processStartTimeMs! + 1) });
                    }
                    return sessions.size === 0;
                },
                ...(wiring === 'missing-retirement-binding' ? {} : {
                    retireAbsentTerminalControlServiceability: async ({ trackedSession }: { trackedSession: TrackedSession }) => {
                        try { return await retireExactTerminalControlServiceability({ credentials, sessionId: session.id, terminalMode: 'plain',
                            expectedRunner: { pid: trackedSession.sessionRunnerPid ?? trackedSession.pid,
                                startTimeMs: trackedSession.runnerProcessIdentity?.processStartTimeMs ?? trackedSession.processStartTimeMs } });
                        } catch (error) { retirementFailure = error instanceof Error ? error.message : 'metadata-write-failed'; throw error; }
                    },
                }),
            });
            const target = { id: 'daemon', data: { clientType: 'machine-scoped', machineId },
                timeout: () => ({ emitWithAck: async () => {
                    const result = StopSessionResultSchema.parse(await stop(session.id));
                    const acknowledgement = projectMachineRpcTransportAcknowledgement({ method: RPC_METHODS.STOP_SESSION, result });
                    return acknowledgement ? { v: 1, result, acknowledgement } : result;
                } }) };
            const io = createSocketRoomDiscoveryHarness(async () => [target]);
            const caller = createFakeSocket({ id: 'caller', data: { clientType: 'user-scoped', authAuthority: 'present_user',
                authTokenAuthenticationEvidence: [] } });
            registerSocketRpcHandlers({ userId: account.id, socket: caller as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method: `${machineId}:${RPC_METHODS.STOP_SESSION}`,
                params: 'fixture-request', authorization: { kind: 'session.write', sessionId: session.id } }, callback);
            const raw = await fetchSessionByIdCompat({ reason: 'session-query', token: credentials.token, sessionId: session.id }).catch(error => {
                if (detailFailure) throw new Error('Composed Session detail failed', { cause: detailFailure });
                throw error;
            });
            if (!raw) throw new Error('Stopped fixture disappeared');
            const owner = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession: raw });
            const actionTarget = createSessionActionTarget({ session: createSessionFixture({ id: session.id, active: raw.active,
                metadataLayoutVersion: raw.metadataLayoutVersion, ownerMetadataView: owner }), serverId: 'fixture-home', isConnected: false });
            expect(sessions.size).toBe(0);
            const isBound = wiring === 'bound' || wiring === 'bound-active-turn' || wiring === 'bound-terminal-turn';
            if (isBound) {
                expect(patchValidation).toBeNull();
                expect(routeValidation).toBeNull();
                expect(patchRejection).toBeNull();
                expect(retirementFailure).toBeNull();
                expect(callback.mock.calls).toEqual([[{ ok: true, result: { status: 'stopped' } }]]);
            }
            expect(actionTarget.canDelete).toBe(isBound);
            if (isBound) {
                expect(raw.active).toBe(false);
                expect(createSessionTerminalMetadataSchema(z, 'owner').parse(owner?.terminal).controlServiceabilityV1?.retired).toBe(true);
            } else if (wiring === 'replacement-runner') {
                expect(callback).toHaveBeenCalledWith({ ok: true, result: {
                    status: 'incomplete', reason: 'terminal_control_serviceability_retirement_failed',
                    effectAttempted: true,
                    failureCause: expect.objectContaining({ phase: 'stop.plain_control_serviceability_retirement' }),
                } });
                expect(owner?.hostPid).toBe(pid + 1);
            }
        } finally {
            restoreHttp(); await app.close();
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
        }
    });
});
