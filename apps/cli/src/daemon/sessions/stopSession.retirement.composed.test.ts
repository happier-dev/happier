import '../../../../ui/sources/dev/vitestSetup';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Socket } from 'socket.io';
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
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { machineUpdateHandler } from '../../../../server/sources/app/api/socket/machineUpdateHandler';
import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../../../../server/sources/app/api/testkit/socketHarness';
import { createSessionActionTarget } from '../../../../ui/sources/components/sessions/actions/sessionActionContext';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
