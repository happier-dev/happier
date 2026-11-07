import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { createActionExecutor, decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionDaemonDispatchRequestSchema, ExternalActionResponseEnvelopeV1Schema,
    createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { createCliSessionHandoffActionDeps } from '../../../../../../cli/src/session/handoff/cliActionDeps';
import { registerMachineSessionHandoffRpcHandlers } from '../../../../../../cli/src/api/machine/sessionHandoff/handlers';
import type { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import type { RpcHandler } from '../../../../../../cli/src/api/rpc/types';
import { createSessionHandoffPrepareTargetJobStore } from '../../../../../../cli/src/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

it('exposes same-job recovery and resumes its exact target through public Home admission', async () => {
    const actionId = 'session.handoff.prepare_target.resume';
    const statusActionId = 'session.handoff.status.get';
    // Discovery is part of the contract: an executor-only implementation is unreachable to agents.
    for (const id of [actionId, statusActionId] as const) {
        expect(getActionSpec(id).surfaces).toMatchObject({ agent: true, mcp: true, cli: true, api: true });
    }
    const homeId = 'srv_handoffResume';
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'handoff-resume-', initAuth: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const activeServerDir = await mkdtemp(join(tmpdir(), 'public-handoff-resume-'));
    try {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'target', platform: 'linux', happyCliVersion: 'test' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: true,
            installationId: crypto.randomUUID(), installationPublicKey: nacl.sign.keyPair().publicKey,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const handoffId = 'retained-handoff';
        const jobId = `prepare_${handoffId}`;
        const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
        await store.write({ handoffId, jobId, createdAtMs: 1, updatedAtMs: 1,
            status: { handoffId, jobId, status: 'pending', phase: 'staging_target', recoveryActions: [] },
            prepareTargetRequest: { handoffId, sessionId: 'session', sourceMachineId: 'source', targetMachineId: machine.id,
                targetPath: '/target', stateTransfer: 'existing', sourceSessionStorageMode: 'persisted',
                negotiatedTransportStrategy: 'direct_peer', endpointCandidates: [] } });
        const interrupted = await store.hydrateInterrupted(jobId, 2);
        if (!interrupted || interrupted.schemaVersion !== 2) throw new Error('Recovery fixture did not hydrate');
        const input = { handoffId, jobId, expectedRevision: interrupted.transitionRevision, attemptId: 'resume-attempt' };
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        // RPC registration/delivery is the transport boundary; the real registrar,
        // recovery handler, persisted job and continuation remain below it.
        const rpcHandlerManager = { registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => handlers.set(method, handler) } as unknown as RpcHandlerManager;
        registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager, runtimeConfig: { activeServerDir },
            admitExistingSessionState: async () => null,
            loadSessionMetadata: async () => { throw new Error('Unsupported native state must not be read'); } });
        // Only the socket/OS transport is substituted; Home routing, authentication,
        // admission, schemas and the CLI recovery dependency factory remain real.
        const recovery = createCliSessionHandoffActionDeps({ token, credentials: { token, encryption: null }, serverId: homeId }, {
            notSupported: () => { throw new Error('unsupported'); },
            resolveTransportForSession: async () => { throw new Error('Recovery must use the admitted target, not the source Session'); },
            callMachineAction: async call => {
                expect(call.machineId).toBe(machine.id);
                expect(call.serverId).toBe(homeId);
                const handler = handlers.get(call.method);
                if (!handler) throw new Error(`Unregistered RPC: ${call.method}`);
                return handler(call.request);
            },
        });
        const executor = createActionExecutor(recovery);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
            forwardRpc: async call => {
                const admitted = ExternalActionDaemonDispatchRequestSchema.parse(call.callParams);
                expect(admitted.executionAuthorization?.binding).toMatchObject({ accountId: account.id, machineId: machine.id });
                if (admitted.envelope.v !== 1) throw new Error('Expected plain Account');
                const execution = await executor.execute(admitted.actionId, admitted.envelope.input, { surface: 'agent',
                    bypassApprovals: true, externalActionTarget: admitted.envelope.target, serverId: homeId });
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId: admitted.actionId, execution })) };
            } }) });
        const invoke = async (id: typeof actionId | typeof statusActionId, value: unknown) => {
            const response = await app.inject({ method: 'POST', url: `/v1/actions/${id}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, target: { kind: 'machine', machineId: machine.id }, input: value } });
            expect(response.statusCode, response.body).toBe(200);
            return ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution;
        };
        expect(await invoke(statusActionId, { handoffId })).toMatchObject({ ok: true, result: {
            transitionRevision: input.expectedRevision, status: { handoffId, jobId, status: 'awaiting_user_resume' } } });
        expect(await invoke(actionId, input)).toMatchObject({ ok: true, result: { handoffId, jobId,
            transitionRevision: input.expectedRevision + 1 } });
        // The real resumed continuation settles visibly when native support is absent;
        // public Resume must preserve its retained job rather than create a new one.
        await vi.waitFor(async () => expect((await store.read(jobId))?.failedAtMs).toBeTypeOf('number'));
        expect(await store.read(jobId)).toMatchObject({ handoffId, jobId, lastErrorCode: 'handoff_existing_state_update_required',
            prepareRecovery: { status: 'attempted', attemptId: input.attemptId } });
        expect(await invoke(actionId, { ...input, attemptId: 'different-attempt' })).toMatchObject({ ok: true,
            result: { ok: false, error: { code: 'attempt_conflict' } } });
        expect(await invoke(actionId, { ...input, expectedRevision: input.expectedRevision + 1 })).toMatchObject({ ok: true,
            result: { ok: false, error: { code: 'stale_revision' } } });
    } finally { await app.close(); await harness.close(); await rm(activeServerDir, { recursive: true, force: true }); }
});
