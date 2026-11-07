import '../../../../../ui/sources/dev/vitestSetup';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol/actions';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExecutionRunGetResponseSchema, ExecutionRunStopResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import type { Socket } from 'socket.io-client';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '../../../../../ui/sources/dev/testkit/cleanup/standardCleanup';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createDeferred } from '@/testkit/async/deferred';
import { createCapabilitiesService } from '@/capabilities/service';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';

const boundary = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the Machine network port is replaced; its packet codec, daemon registrar,
// Action executors, bridge, retained storage and both output consumers stay real.
vi.mock('../../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.machine,
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Resolve UI source under its own Vitest program without rooting its entire
// application dependency graph in the CLI TypeScript project.
const uiExecutorPath = '../../../../../ui/sources/sync/ops/actions/defaultActionExecutor';
const { createDefaultActionExecutor }: { createDefaultActionExecutor(): {
    execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
} } = await import(uiExecutorPath);
const { io } = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');

describe('detached Run Stop through the UI Action and registered Machine RPC', () => {
    let directory: string;
    const managers: ExecutionRunHostBridge[] = [];
    beforeEach(async () => {
        await homes.reset();
        boundary.machine.mockReset();
        directory = await mkdtemp(join(tmpdir(), 'happier-machine-run-stop-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        vi.stubEnv('HAPPIER_EXPERIMENTAL_EXECUTION_RUNS', '1');
        reloadConfiguration();
    });
    afterEach(async () => {
        await Promise.all(managers.splice(0).map(manager => manager.dispose()));
        standardCleanup();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
    });

    it.each([
        { actorAccountId: 'alice', refuse: false },
        { actorAccountId: 'guest', refuse: false },
        { actorAccountId: 'guest', refuse: true },
    ])('preserves Run custody and typed refusals through installed daemon admission ($actorAccountId, refusal=$refuse)', async ({ actorAccountId, refuse }) => {
        const serverId = await homes.addHome({ name: 'Run Home', serverUrl: 'https://run-stop.test', accountId: actorAccountId });
        const run = { runId: 'machine-run', callId: 'machine-call', sidechainId: 'machine-sidechain', sessionId: null,
            depth: 0, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
            instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
            status: 'running', startedAtMs: 1,
            requesterWorkAttributionV1: { serverId, accountId: actorAccountId, machineId: 'machine', installationId: 'installation' },
        } satisfies ExecutionRunState;
        await retainExecutionRunState(run);
        await retainExecutionRunState({ ...run, runId: 'retained-own-run', callId: 'retained-own-call', status: 'cancelled', finishedAtMs: 2 });
        await retainExecutionRunState({ ...run, runId: 'foreign-run', callId: 'foreign-call', status: 'cancelled', finishedAtMs: 2,
            requesterWorkAttributionV1: { ...run.requesterWorkAttributionV1, accountId: actorAccountId === 'alice' ? 'guest' : 'alice' } });
        const installation = tweetnacl.sign.keyPair();
        // Home admission HTTP is a genuine external boundary. The request
        // signer, exact-Machine checks and method-scope decision run for real.
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
        const machineAdmission = { actorAccountId, custodianAccountId: 'alice', machineId: 'machine',
            installationId: 'installation', role: actorAccountId === 'alice' ? 'manage' as const : 'use' as const, encryptionMode: 'plain' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveInstallationId: () => 'installation', resolveCustodianAccountId: async () => 'alice',
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: installation.secretKey,
                    daemonToken: 'fixture-daemon', serverHttpBaseUrl: 'https://run-stop.test' }),
            }),
        });
        registerExecutionRunHandlers(rpc, {
            sessionId: null, cwd: directory, machineId: 'machine', parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
            serverId, runtimeAccountId: 'alice',
            executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } } },
            }) }),
            onManagerCreated: manager => {
                managers.push(manager);
                // Seed an already admitted live Run, as the bridge owner tests
                // do. Recovery intentionally cannot acquire a live Run merely
                // from its retained record. No control/read logic is replaced.
                (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs.set(run.runId, run);
            },
        });
        const published = new Set<string>();
        const http = createServer();
        const relay = new Server(http);
        const clients: Socket[] = [];
        onTestFinished(async () => {
            rpc.onSocketDisconnect();
            clients.forEach(client => client.disconnect());
            await new Promise<void>(resolve => relay.close(() => resolve()));
        });
        // Real Socket.IO registration and request/ack transport. The Home
        // network endpoint is redirected to loopback; it stamps the verified
        // admission fixture before the real daemon authorization runs.
        relay.on('connection', client => {
            client.on(SOCKET_RPC_EVENTS.REGISTER, (payload: { method: string }) => published.add(payload.method));
            client.on('fixture-registration-ready', (reply: () => void) => reply());
            client.on(SOCKET_RPC_EVENTS.CALL, async (payload: SocketRpcRequestPayload, reply: (result: unknown) => void) => {
                if (!published.has(payload.method)) {
                    reply({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'RPC method not available' });
                    return;
                }
                reply({ ok: true, result: await rpc.handleRequest({ ...payload, machineAdmission, callerAuthority: 'present_user' }) });
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture socket address');
        const connect = async (clientType: string) => {
            const client = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], autoConnect: false, auth: { clientType } });
            clients.push(client);
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
                client.connect();
            });
            return client;
        };
        const daemonSocket = await connect('machine-scoped');
        rpc.onSocketConnect(daemonSocket);
        await daemonSocket.emitWithAck('fixture-registration-ready');
        const socket = await connect('user-scoped');
        const readyCapability = createCapabilitiesService({
            capabilities: [executionRunsCapability],
            checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
            buildContext: async () => { throw new Error('Effectful capability discovery is unavailable'); },
        }).describe();
        let readCapability: () => Promise<unknown> = async () => readyCapability;
        boundary.machine.mockImplementation(async ({ method, payload, machineId }) => {
            expect(machineId).toBe('machine');
            // Capability discovery is the remote OS/tool boundary fixture. Its
            // real UI parser and V2 support decision remain in the path.
            if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return await readCapability();
            return await callSocketRpc({ socket, target: { kind: 'machine', id: machineId }, method, params: payload, content: { mode: 'plain' } });
        });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui', authority: 'present_user', serverId, executionRunTargetMachineId: 'machine' } as const;
        const get = () => executor.execute('execution.run.get', { sessionId: null, runId: run.runId }, context);
        if (refuse) {
            machineAdmission.installationId = 'replaced-installation';
            expect(await get()).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN', effectAttempted: false });
            return;
        }
        const before = await get();
        expect(before, JSON.stringify(before)).toMatchObject({ ok: true, result: { run: { status: 'running' } } });
        const recovered = await executor.execute('execution.run.get', { sessionId: null, runId: 'retained-own-run' }, context);
        expect(recovered).toMatchObject({ ok: true, result: { run: { runId: 'retained-own-run', status: 'cancelled' } } });
        if (!recovered.ok) throw new Error(recovered.errorCode);
        expect(ExecutionRunGetResponseSchema.parse(recovered.result).run.runId).toBe('retained-own-run');
        const foreign = await executor.execute('execution.run.get', { sessionId: null, runId: 'foreign-run' }, context);
        const missing = await executor.execute('execution.run.get', { sessionId: null, runId: 'missing-run' }, context);
        expect(foreign).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        // Correlation ids identify these two requests, never the queried Run.
        expect({ ...foreign, requestId: null }).toEqual({ ...missing, requestId: null });
        // A missing socket publication must refuse through this same front
        // door and leave the live Run untouched, even with a local handler.
        const stopMethod = `machine:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`;
        published.delete(stopMethod);
        expect(await executor.execute('execution.run.stop', { sessionId: null, runId: run.runId }, context))
            .toMatchObject({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        expect(await get()).toMatchObject({ ok: true, result: { run: { status: 'running' } } });
        published.add(stopMethod);
        // R54's preflight may remain pending, then fail before Stop dispatch.
        // Model the external observation with a deferred response, not an
        // invented timer. A later same-owner observation must recover normally.
        const capabilityIssued = createDeferred();
        const capabilityFailure = createDeferred<never>();
        readCapability = async () => { capabilityIssued.resolve(); return await capabilityFailure.promise; };
        const pendingStop = executor.execute('execution.run.stop', { sessionId: null, runId: run.runId }, context);
        await capabilityIssued.promise;
        expect(managers.at(-1)?.get(run.runId)?.status).toBe('running');
        capabilityFailure.reject(new Error('Capability transport unavailable'));
        expect(await pendingStop).toMatchObject({ ok: false, errorCode: 'execution_run_target_unavailable' });
        readCapability = async () => readyCapability;
        expect(await get()).toMatchObject({ ok: true, result: { run: { status: 'running' } } });
        const stopped = await executor.execute('execution.run.stop', { sessionId: null, runId: run.runId }, context);
        expect(stopped).toEqual({ ok: true, result: { ok: true } });
        if (!stopped.ok) throw new Error(stopped.errorCode);
        expect(ExecutionRunStopResponseSchema.parse(stopped.result)).toEqual({ ok: true });
        const observed = await get();
        expect(observed).toMatchObject({ ok: true, result: { run: { status: 'cancelled' } } });
        if (!observed.ok) throw new Error(observed.errorCode);
        expect(ExecutionRunGetResponseSchema.parse(observed.result).run.status).toBe('cancelled');
    });
});
