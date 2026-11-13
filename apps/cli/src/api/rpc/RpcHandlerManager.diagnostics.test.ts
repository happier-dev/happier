import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SocketRpcRequestIdSchema } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from './RpcHandlerManager';
import { createSessionRpcAuthorization } from '@/api/session/client/sessionRpcAuthorization';
import { logger as fileLogger } from '@/ui/logger';
import { createActionExecutor } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { Socket } from 'socket.io-client';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { createCapabilitiesService } from '@/capabilities/service';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

describe('RPC completion diagnostics', () => {
    it('records the Session upload-init authorization cause once without request content', async () => {
        const logger = vi.fn();
        const method = RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT;
        const requestId = 'rpc_12345678-1234-4123-8123-123456789abc';
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', scopeKind: 'session', encryptionMode: 'plain', logger,
            authorizeRequest: createSessionRpcAuthorization({ sessionId: 'session', serverUrl: 'https://home.invalid',
                isClosed: () => false, readHomeServerIdentityId: () => null,
                readOwnerCredentials: async () => null, readSessionAttachmentRequester: () => null }) });
        const handler = vi.fn(() => ({ ok: true }));
        rpc.registerHandler(method, handler);
        const response = await rpc.handleRequest({ method: `session:${method}`, traceId: requestId,
            params: { path: 'never-log-private-path', token: 'never-log-secret' } }, undefined, 'authenticated_home_socket');
        expect(response).toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false,
            failureCause: { phase: 'session.rpc.authorization.unrestricted_owner_required' } });
        expect(handler).not.toHaveBeenCalled();
        const completions = logger.mock.calls.filter(([message]) => message === '[RPC] Request completed');
        expect(completions).toEqual([['[RPC] Request completed', expect.objectContaining({ method, requestId,
            errorCode: 'agent_isolation_unavailable', effectAttempted: false,
            failureCause: { phase: 'session.rpc.authorization.unrestricted_owner_required' } })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each(['invoke', 'detect'] as const)('retains native preparation cause through capability %s and code-only completion', async kind => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        const details = { reason: 'member_setup_required', phase: 'native_execution_preparation',
            outcome: 'not_applied', reasonCode: 'not_preauthorized' };
        const service = createCapabilitiesService({ capabilities: [{
            descriptor: { id: 'cli.fixture', kind: 'cli', methods: { probeModels: {} } },
            effects: { detect: ['process'], invoke: { probeModels: ['process'] } },
            detect: async () => ({}), invoke: async () => ({ ok: true, result: {} }),
        }], checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
            buildContext: async () => ({ cliSnapshot: null }) });
        const executeEffects = async () => { throw Object.assign(new PluginError({
            code: 'agent_isolation_unavailable', message: 'never-log-private', retryable: false,
            details: { ...details, environment: { TOKEN: 'never-log-secret' }, output: 'never-log-child-output' },
        }), { rpcErrorCode: 'agent_isolation_unavailable' }); };
        const method = kind === 'invoke' ? RPC_METHODS.CAPABILITIES_INVOKE : RPC_METHODS.CAPABILITIES_DETECT;
        if (kind === 'invoke') rpc.registerHandler(method, () => service.invoke({ id: 'cli.fixture', method: 'probeModels' }, { executeEffects }));
        else rpc.registerHandler(method, () => service.detect({ requests: [{ id: 'cli.fixture' }] }, { executeEffects }));
        const response = await rpc.handleRequest({ method: `machine:${method}`, params: {} });
        expect(response).toMatchObject(kind === 'invoke'
            ? { ok: false, error: { code: 'agent_isolation_unavailable', details } }
            : { errorCode: 'agent_isolation_unavailable', details });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            outcomeCode: 'agent_isolation_unavailable', capabilityFailure: details,
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        expect(JSON.stringify(response)).not.toContain('never-log');
    });

    it.each(['plain', 'encrypted', 'local'] as const)('records the closed nested model probe outcome through %s dispatch', async transport => {
        const logger = vi.fn();
        const key = new Uint8Array(32).fill(7);
        const content: SocketRpcContent = { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', logger,
            ...(transport === 'encrypted' ? { encryptionKey: key, encryptionVariant: 'dataKey' as const } : { encryptionMode: 'plain' as const }) });
        const cases = [
            { source: 'unavailable', refreshError: true, availableModels: [],
                spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE' } },
            { source: 'static', refreshError: true, availableModels: [{ id: 'never-log-model-id', name: 'never-log-model-name' }] },
            { source: 'dynamic', refreshError: false, availableModels: [] },
        ] as const;
        for (const [index, observation] of cases.entries()) {
            const response = { ok: true, result: { ...AgentModelsProbeObservationSchema.parse({ ...observation, supportsFreeform: false }),
                rawError: 'never-log-error /private/path', token: 'never-log-secret' } };
            rpc.registerHandler(RPC_METHODS.CAPABILITIES_INVOKE, () => response);
            const params = { id: 'cli.test', method: 'probeModels', params: { token: 'never-log-input' } };
            const method = `machine:${RPC_METHODS.CAPABILITIES_INVOKE}`;
            const callId = index.toString(16).padStart(32, '0');
            const result = transport === 'local' ? await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, params)
                : await rpc.handleRequest({ method, params: transport === 'encrypted'
                    ? await socketRpcCodec.encodeParams(content, params, { method, callId }) : params });
            expect(transport === 'encrypted' ? await socketRpcCodec.decodeResult(content, { ok: true, result }, callId) : result)
                .toEqual(response);
            const completions = logger.mock.calls.filter(([message]) => message === '[RPC] Request completed');
            expect(completions).toHaveLength(index + 1);
            expect(completions.at(-1)).toEqual(['[RPC] Request completed', expect.objectContaining({
                method: RPC_METHODS.CAPABILITIES_INVOKE, outcomeCode: 'ok', modelProbe: {
                    source: observation.source, refreshError: observation.refreshError,
                    availableModelsCount: observation.availableModels.length,
                    ...('spawnFailure' in observation ? { spawnFailure: { code: observation.spawnFailure.reason } } : {}),
                },
            })]);
        }
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|EMFILE|\/private/);
    });

    it('projects model counts without visiting model rows and rejects open diagnostic strings', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        let modelReads = 0;
        const model = { get id() { modelReads += 1; return 'never-log-model'; }, name: 'never-log-model-name' };
        const response = { ok: true, result: { source: 'never-log-source', refreshError: 'never-log-error',
            availableModels: Array.from({ length: 1000 }, () => model),
            spawnFailure: { reason: 'never-log-classifier', code: 'never-log-code', errno: 'never-log-errno' } } };
        rpc.registerHandler(RPC_METHODS.CAPABILITIES_INVOKE, () => response);
        expect(await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, { method: 'probeModels' })).toBe(response);
        expect(modelReads).toBe(0);
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            outcomeCode: 'ok', modelProbe: { availableModelsCount: 1000 },
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        logger.mockClear();
        rpc.registerHandler('demo', () => response);
        await rpc.invokeLocal('demo', {});
        expect(logger.mock.calls[0]?.[1]).not.toHaveProperty('modelProbe');
    });

    it.each([true, false])('joins received, manager admission and completion through real Home verification (admitted=%s)', async admitted => {
        const logger = vi.fn();
        const key = tweetnacl.sign.keyPair();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        // The authenticated Home HTTP answer is the only replaced admission boundary.
        const network = vi.spyOn(axios, 'post').mockImplementation(async () => {
            await held;
            return { status: admitted ? 200 : 503, data: { v: 1, ok: true } };
        });
        const rpc = new RpcHandlerManager({ scopePrefix: 'never-log-machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'never-log-machine', resolveCustodianAccountId: async () => 'never-log-owner',
                resolveInstallationId: () => 'never-log-installation',
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                    privateKey: key.secretKey, daemonToken: 'never-log-token', serverHttpBaseUrl: 'https://home.invalid' }),
            }) });
        let executions = 0;
        rpc.registerHandler('demo', () => { executions += 1; return { ok: true, secret: 'never-log-result' }; });
        const requestId = 'rpc_12345678-1234-4123-8123-123456789abc';
        try {
            const pending = rpc.handleRequest({ method: 'never-log-machine:demo', traceId: requestId,
                params: { secret: 'never-log-input' }, machineAdmission: { actorAccountId: 'never-log-owner',
                    custodianAccountId: 'never-log-owner', machineId: 'never-log-machine',
                    installationId: 'never-log-installation', role: 'manage', encryptionMode: 'plain' } });
            await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
            expect(executions).toBe(0);
            expect(logger.mock.calls).toEqual([['[RPC] Request received', { requestId, method: 'demo' }]]);
            release();
            const result = await pending;
            expect(result).toMatchObject(admitted ? { ok: true } : { errorCode: RPC_ERROR_CODES.FORBIDDEN });
            expect(executions).toBe(admitted ? 1 : 0);
            expect(network).toHaveBeenCalledTimes(1);
            const events = logger.mock.calls.filter(([message]) => /^\[RPC\] Request (received|admitted|completed)$/.test(message));
            expect(events.map(([message]) => message)).toEqual(admitted
                ? ['[RPC] Request received', '[RPC] Request admitted', '[RPC] Request completed']
                : ['[RPC] Request received', '[RPC] Request completed']);
            for (const [, metadata] of events) expect(metadata).toMatchObject({ method: 'demo', requestId });
            expect(events.at(-1)?.[1]).toMatchObject({ outcomeCode: admitted ? 'ok' : RPC_ERROR_CODES.FORBIDDEN });
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        } finally { release(); network.mockRestore(); }
    });

    it('does not treat diagnostic trace identity as a cancellation request id', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        const socket = createApiSessionSocketStub({ connected: true });
        rpc.onSocketConnect(socket as unknown as Socket);
        const traceId = 'rpc_12345678-1234-4123-8123-123456789abc';
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let signal: AbortSignal | undefined;
        rpc.registerHandler('demo', async (_input, context) => { signal = context?.signal; await pending; return { ok: true }; });
        const result = rpc.handleRequest({ method: 'machine:demo', traceId, params: {} });
        try {
            await vi.waitFor(() => expect(signal).toBeDefined());
            socket.trigger('rpc-cancel', { requestId: traceId });
            expect(signal?.aborted).toBe(false);
            release();
            expect(await result).toEqual({ ok: true });
            expect(logger.mock.calls.filter(([message]) => message === '[RPC] Request completed'))
                .toEqual([['[RPC] Request completed', expect.objectContaining({ requestId: traceId, outcomeCode: 'ok' })]]);
        } finally { release(); rpc.onSocketDisconnect(); }
    });

    it.each(['requestId', 'traceId'] as const)('keeps opaque %s hashed across all socket request phases', async field => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'never-log-scope', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => ({ ok: true }));
        const requestId = 'never-log-token/private\n';
        await rpc.handleRequest({ method: 'never-log-scope:demo', [field]: requestId,
            ...(field === 'traceId' ? { requestId: 'rpc_12345678-1234-4123-8123-123456789abc' } : {}),
            params: { secret: 'never-log-payload' } });
        const events = logger.mock.calls.filter(([message]) => /^\[RPC\] Request (received|admitted|completed)$/.test(message));
        expect(events.map(([message]) => message)).toEqual([
            '[RPC] Request received', '[RPC] Request admitted', '[RPC] Request completed',
        ]);
        const hashed = `sha256:${createHash('sha256').update(SocketRpcRequestIdSchema.parse(requestId)).digest('hex')}`;
        for (const [, metadata] of events) expect(metadata).toMatchObject({ requestId: hashed, method: 'demo' });
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each(['requestId', 'traceId'] as const)('retains the admitted %s root through asynchronous handler phases', async field => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(fileLogger, 'warnLocalFile').mockImplementation(() => undefined);
        const requestId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger() {} });
        rpc.registerHandler('demo', async () => {
            await Promise.resolve();
            return await timeWebLatencyPhase('session.outbox.deliver', async () => 42);
        });
        try {
            expect(await rpc.handleRequest({ method: 'session:demo', [field]: `rpc_${requestId}`, params: {} })).toEqual(42);
            expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
                phase: 'session.outbox.deliver', status: 'completed', requestId,
            }));
        } finally { sink.mockRestore(); vi.unstubAllEnvs(); }
    });

    it('ignores malformed diagnostic trace metadata without changing request execution or its existing correlation', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => ({ ok: true }));
        const requestId = 'rpc_12345678-1234-4123-8123-123456789abc';
        // @ts-expect-error A malformed wire trace is diagnostic data, never request admission authority.
        expect(await rpc.handleRequest({ method: 'machine:demo', traceId: null, requestId, params: {} })).toEqual({ ok: true });
        for (const [, metadata] of logger.mock.calls) expect(metadata).toMatchObject({ requestId });
    });
    it.each([
        { phase: 'host_publication_rejected' },
        { phase: 'never-log-native-detail' },
        { phase: 'native_effect', error: 'never-log-objective' },
    ])('records only a closed Goal settlement phase %j once', async goalControlFailure => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
        rpc.registerHandler('session.goal.set', () => ({ ok: false,
            errorCode: 'session_goal_control_work_state_unavailable', goalControlFailure }));
        await rpc.invokeLocal('session.goal.set', { objective: 'never-log-objective' });
        expect(logger.mock.calls).toHaveLength(1);
        const completed = logger.mock.calls[0]?.[1];
        if (goalControlFailure.phase === 'host_publication_rejected') {
            expect(completed).toMatchObject({ goalControlFailure: { phase: 'host_publication_rejected' } });
        } else expect(completed).not.toHaveProperty('goalControlFailure');
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });
    it.each(['deadline', 'cancel', 'disconnect'] as const)('settles held Home admission on its existing %s while unrelated RPCs complete', async lifetime => {
        const logger = vi.fn();
        const key = tweetnacl.sign.keyPair();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let entered = false;
        // A transport can finish after cancellation; internal admission remains real.
        const network = vi.spyOn(axios, 'post').mockImplementation(async () => {
            entered = true;
            await held;
            return { status: 200, data: { v: 1, ok: true } };
        });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                    privateKey: key.secretKey, daemonToken: 'test-token', serverHttpBaseUrl: 'https://home.invalid' }),
            }) });
        let dispatched = false;
        rpc.registerHandler('demo', () => { dispatched = true; });
        rpc.registerHandler('health', () => ({ ok: true }));
        const socket = createApiSessionSocketStub({ connected: true });
        // Canonical Socket.IO boundary stub exposes the manager's consumed subset.
        rpc.onSocketConnect(socket as unknown as Socket);
        let result: unknown;
        const request = rpc.handleRequest({ method: 'machine:demo', params: {}, requestId: 'held-admission',
            ...(lifetime === 'deadline' ? { timeoutMs: 100 } : {}),
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' } })
            .then(value => { result = value; });
        try {
            await vi.waitFor(() => expect(entered).toBe(true));
            expect(await rpc.handleRequest({ method: 'machine:health', params: {} })).toEqual({ ok: true });
            if (lifetime === 'cancel') socket.trigger('rpc-cancel', { requestId: 'held-admission' });
            if (lifetime === 'disconnect') rpc.onSocketDisconnect();
            await vi.waitFor(() => expect(result).toBeDefined());
            expect(result).toEqual({ error: lifetime === 'deadline' ? 'RPC request timed out'
                : lifetime === 'cancel' ? 'RPC request cancelled by caller' : 'RPC target transport disconnected',
                ...(lifetime === 'deadline' ? { errorCode: 'MACHINE_RPC_TIMEOUT' } : {}) });
            expect(dispatched).toBe(false);
            expect(logger).toHaveBeenLastCalledWith('[RPC] Request completed', expect.objectContaining({
                ...(lifetime === 'deadline' ? { outcomeCode: 'RPC_REQUEST_TIMEOUT' } : {}),
                failedPhase: 'authorize_request', cancelled: true,
                phaseDurationsMs: expect.objectContaining({ authorize_request: expect.any(Number) }),
            }));
            expect(rpc.getInFlightRequestCount()).toBe(0);
        } finally { release(); await request; network.mockRestore(); }
        expect(dispatched).toBe(false);
    });
    it('answers a failed Home verification with its typed refusal and admission phase', async () => {
        const logger = vi.fn();
        const key = tweetnacl.sign.keyPair();
        const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 503, data: {} });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                    privateKey: key.secretKey, daemonToken: 'test-token', serverHttpBaseUrl: 'https://home.invalid' }),
            }) });
        let dispatched = false;
        rpc.registerHandler('demo', () => { dispatched = true; });
        try {
            expect(await rpc.handleRequest({ method: 'machine:demo', params: {},
                machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                    installationId: 'installation', role: 'manage', encryptionMode: 'plain' } }))
                .toEqual({ error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
            expect(dispatched).toBe(false);
            expect(logger).toHaveBeenLastCalledWith('[RPC] Request completed', expect.objectContaining({
                outcomeCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'machine_currentness',
                failedPhase: 'authorize_request', cancelled: false,
                phaseDurationsMs: expect.objectContaining({ authorize_request: expect.any(Number) }),
            }));
        } finally { network.mockRestore(); }
    });
    it.each(['ECONNABORTED', 'private_token'])('bounds wrapped failure diagnostics for %s', async code => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => {
            throw new Error('never-log-error', { cause: Object.assign(new Error('never-log-cause'), { code }) });
        });
        expect(await rpc.handleRequest({ method: 'machine:demo', params: {} })).toEqual({ error: 'never-log-error' });
        const completed = logger.mock.calls.at(-1)?.[1];
        expect(completed).toMatchObject({ failedPhase: 'handler', cancelled: false,
            phaseDurationsMs: expect.objectContaining({ handler: expect.any(Number) }) });
        if (code === 'ECONNABORTED') expect(completed).toMatchObject({ causeCode: code });
        else expect(completed).not.toHaveProperty('causeCode');
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private_token/);
    });
    it('records only generation schema issue paths and codes at the real Machine SCM boundary', async () => {
        const record = vi.spyOn(fileLogger, 'infoFile').mockImplementation(() => {});
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
        const executor = createActionExecutor({
            ...createUnavailableActionTransportDeps(),
            scmActionExecute: async () => { throw new Error('Invalid input must not cross SCM admission'); },
        });
        registerScmHandlers(rpc, '/repo', { machineId: 'machine', actionExecutor: executor });
        try {
            const result = await rpc.handleRequest({ method: 'machine:scm.diffSummary.generate', callerAuthority: 'present_user',
                params: { cwd: '/repo', source: { kind: 'workingTree' }, outputLanguage: 'never-log-language-value',
                    modelSelector: { modelId: 42 }, 'never-log-unknown-key': 'never-log-value' } });
            expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(record).toHaveBeenCalledWith('[RPC] SCM input validation failed', {
                actionId: 'scm.diffSummary.generate', issues: expect.arrayContaining([
                    { path: ['modelSelector', 'modelId'], code: 'invalid_type' },
                    { path: [], code: 'unrecognized_keys' },
                ]),
            });
            expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
        } finally { record.mockRestore(); }
    });
    it('retains the host request timeout reason through handler cancellation', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo.wait', (_input, context) => new Promise((_resolve, reject) => {
            if (!context) throw new Error('Expected actual handler cancellation context');
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        }));
        expect(await rpc.handleRequest({ method: 'machine:demo.wait', params: {}, timeoutMs: 1 }))
            .toEqual({ error: 'RPC request timed out', errorCode: 'MACHINE_RPC_TIMEOUT' });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ outcomeCode: 'RPC_REQUEST_TIMEOUT' })]]);
    });

    it('preserves the owning deadline code when a cancelled handler rejects with a boundary abort error', async () => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
        rpc.registerHandler('demo.wait', (_input, context) => new Promise((_resolve, reject) => {
            if (!context) throw new Error('Expected actual handler cancellation context');
            context.signal.addEventListener('abort', () => reject(new DOMException('Boundary aborted', 'AbortError')), { once: true });
        }));
        expect(await rpc.handleRequest({ method: 'machine:demo.wait', params: {}, timeoutMs: 1 }))
            .toMatchObject({ errorCode: 'MACHINE_RPC_TIMEOUT' });
    });

    it.each(['EACCES', 'ENOENT', 'RIPGREP_ABORTED'])(
        'retains native exception code %s without changing the transported error or logging prose', async (code) => {
            const logger = vi.fn();
            const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
            rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, () => {
                throw Object.assign(new Error('never-log-sensitive-path'), { code });
            });
            expect(await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST}`, params: {} }))
                .toEqual({ error: 'never-log-sensitive-path' });
            expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ outcomeCode: code })]]);
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        },
    );

    it('classifies cancellation and the workspace search failure union through actual dispatch', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, () => {
            throw new DOMException('never-log-cancelled-search', 'AbortError');
        });
        rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, () => ({ ok: false, code: 'ripgrep_failed' }));
        rpc.registerHandler('demo.execution', () => ({ ok: true, code: 0 }));
        await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST}`, params: {} });
        await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`, params: {} });
        await rpc.handleRequest({ method: 'machine:demo.execution', params: {} });
        expect(logger.mock.calls).toEqual(['request_cancelled', 'ripgrep_failed', 'ok'].map(outcomeCode =>
            ['[RPC] Request completed', expect.objectContaining({ outcomeCode })]));
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each(['permission_request_not_found', 'permission_actor_unattributable', 'permission_response_invalid', 'future_native_refusal_v2'])(
        'retains the typed handler refusal %s for a relay-attributed Session request', async (errorCode) => {
            const logger = vi.fn();
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
            rpc.registerHandler('session.permission.respond', () => ({ ok: false, errorCode, requestId: 'never-log-request' }));
            const result = await rpc.handleRequest({ method: 'session:session.permission.respond', params: {}, authorization: {
                kind: 'session.permission.respond', sessionId: 'session',
                actor: { kind: 'accountUser', accountId: 'never-log-account', relationship: 'owner' },
            } });
            expect(result).toMatchObject({ ok: false, errorCode });
            expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
                outcomeCode: errorCode, callerClass: 'session',
            })]]);
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        },
    );

    it('preserves shape-approved thrown codes and bounds the diagnostic token', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
        const code = `N${'a'.repeat(127)}`;
        rpc.registerHandler('demo', () => { throw new RpcError('never-log-error', code); });
        await rpc.handleRequest({ method: 'session:demo', params: {} });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ outcomeCode: code })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each(['private/path', 'private token', 'private\ncode', 'private_code\n', 'private-code', 'échec', `N${'a'.repeat(128)}`, ''])(
        'does not disclose a malformed or oversized refusal code %j', async (errorCode) => {
            const logger = vi.fn();
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
            rpc.registerHandler('demo', () => ({ ok: false, errorCode }));
            rpc.registerHandler('demo.native', () => { throw Object.assign(new Error('never-log-native-detail'), { code: errorCode }); });
            await rpc.handleRequest({ method: 'session:demo', params: {} });
            await rpc.handleRequest({ method: 'session:demo.native', params: {} });
            expect(logger.mock.calls).toEqual([0, 1].map(() =>
                ['[RPC] Request completed', expect.objectContaining({ outcomeCode: 'unclassified_error' })]));
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        },
    );

    it('does not attribute a malformed or differently scoped relay stamp to the Session', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => ({ ok: false, errorCode: 'permission_actor_unattributable' }));
        for (const authorization of [{ kind: 'session.permission.respond', sessionId: 'session' },
            { kind: 'session.write', sessionId: 'other-session' }]) {
            // Deliberately malformed/unscoped transport stamps must never acquire Session attribution.
            // @ts-expect-error Exercise invalid wire data rather than manufacturing a valid authority.
            await rpc.handleRequest({ method: 'session:demo', params: {}, authorization });
        }
        expect(logger.mock.calls).toEqual([0, 1].map(() => ['[RPC] Request completed', expect.objectContaining({
            outcomeCode: 'permission_actor_unattributable', callerClass: 'unattributed',
        })]));
    });

    it('uses the file info level so ordinary Session defaults retain completion records', async () => {
        // The file sink is the boundary; RPC admission and dispatch remain real.
        const info = vi.spyOn(fileLogger, 'infoFile').mockImplementation(() => {});
        const debug = vi.spyOn(fileLogger, 'debug').mockImplementation(() => {});
        try {
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain' });
            rpc.registerHandler('demo', () => ({ ok: true }));
            await rpc.handleRequest({ method: 'session:demo', params: {} });
            expect(info.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ method: 'demo', outcomeCode: 'ok' })]]);
            expect(debug.mock.calls).toEqual([]);
        } finally { info.mockRestore(); debug.mockRestore(); }
    });
    it('correlates overlapping dispatches independently without logging input or output', async () => {
        const logger = vi.fn();
        let now = 100;
        let release: () => void = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        const rpc = new RpcHandlerManager({ scopePrefix: 'private-session', encryptionMode: 'plain', logger, nowMs: () => now });
        rpc.registerHandler('demo', async (input: { wait?: boolean }) => {
            if (input.wait) await pending;
            return { secretResult: 'never-log-output' };
        });
        const first = rpc.handleRequest({ method: 'private-session:demo', requestId: 'relay-a', params: { wait: true, token: 'never-log-input' } });
        now = 110;
        await rpc.handleRequest({ method: 'private-session:demo', requestId: 'relay-b', params: {} });
        now = 145;
        release();
        await first;
        expect(logger.mock.calls.filter(([message]) => message === '[RPC] Request completed')).toEqual(['relay-b', 'relay-a'].map((id, index) => [
            '[RPC] Request completed', {
                method: 'demo', requestId: `sha256:${createHash('sha256').update(id).digest('hex')}`,
                durationMs: index === 0 ? 0 : 45, outcomeCode: 'ok', callerClass: 'unattributed',
            },
        ]));
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private-session/);
    });

    it('reuses native relay UUIDs and captures denial at the real admission owner', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger, nowMs: () => 100,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'private-owner',
                resolveInstallationId: () => null, verifyMachineAdmission: async () => true,
            }) });
        rpc.registerHandler('demo', () => { throw new Error('Must never dispatch'); });
        expect(await rpc.handleRequest({ method: 'machine:demo', params: {}, requestId: 'rpc_12345678-1234-4123-8123-123456789abc',
            callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'private-guest', custodianAccountId: 'private-owner',
                machineId: 'machine', installationId: 'private-installation', role: 'use', encryptionMode: 'plain' } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(logger.mock.calls.filter(([message]) => message === '[RPC] Request completed')).toEqual([['[RPC] Request completed', {
            method: 'demo', requestId: 'rpc_12345678-1234-4123-8123-123456789abc', durationMs: 0,
            outcomeCode: RPC_ERROR_CODES.FORBIDDEN, callerClass: 'unadmitted', admissionPredicate: 'machine_installation',
            errorCode: RPC_ERROR_CODES.FORBIDDEN, failureCause: { phase: 'rpc.authorize_request' }, effectAttempted: false,
            failedPhase: 'authorize_request', cancelled: false,
            phaseDurationsMs: { request_admission: 0, authorize_request: 0 },
        }]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('private-');
    });

    it('captures an admitted guest and the failed disclosure predicate without error prose', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: async () => true,
            }) });
        rpc.registerHandler('demo', (_input, context) => {
            context?.reportAdmissionDenial?.('machine_currentness');
            throw new RpcError('never-log-token /home/private-user/workspace', RPC_ERROR_CODES.FORBIDDEN);
        });
        expect(await rpc.handleRequest({ method: 'machine:demo', params: {}, machineAdmission: { actorAccountId: 'guest',
            custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            method: 'demo', requestId: expect.any(String), outcomeCode: RPC_ERROR_CODES.FORBIDDEN,
            callerClass: 'machine_guest', admissionPredicate: 'machine_currentness',
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private-user|workspace/);
    });

    it('bounds malformed routing and opaque ids and rejects arbitrary error code disclosure', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        await rpc.handleRequest({ method: 'machine:/home/never-log-path?token=never-log-token', params: {}, requestId: 'never-log-token\n' });
        rpc.registerHandler('demo', () => { throw new RpcError('never-log-error', 'never-log-secret-code'); });
        await rpc.handleRequest({ method: 'machine:demo', params: {} });
        expect(logger.mock.calls.filter(([message]) => message === '[RPC] Request completed')).toEqual([
            ['[RPC] Request completed', expect.objectContaining({ method: '<unregistered>', outcomeCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })],
            ['[RPC] Request completed', expect.objectContaining({ method: 'demo', outcomeCode: 'unclassified_error' })],
        ]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each([false, true])('leaves the encrypted call id response echo unchanged (diagnostic trace=%s)', async traced => {
        const logger = vi.fn();
        const key = new Uint8Array(32).fill(7);
        const callId = '0123456789abcdef0123456789abcdef';
        const traceId = 'rpc_12345678-1234-4123-8123-123456789abc';
        const content: SocketRpcContent = { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionKey: key, encryptionVariant: 'dataKey', logger });
        rpc.registerHandler('demo', () => ({ ok: true }));
        const result = await rpc.handleRequest({ method: 'session:demo', ...(traced ? { traceId } : {}), params: await socketRpcCodec.encodeParams(content,
            { secret: 'never-log-input' }, { method: 'session:demo', callId }) });
        expect(await socketRpcCodec.decodeResult(content, { ok: true, result }, callId)).toEqual({ ok: true });
        expect(logger.mock.calls.filter(([message]) => message === '[RPC] Request completed'))
            .toEqual([['[RPC] Request completed', expect.objectContaining({ requestId: traced ? traceId : callId, outcomeCode: 'ok' })]]);
        expect(logger.mock.calls).toHaveLength(traced ? 3 : 1);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it('logs in-process dispatch and early content retirement once', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => ({ error: 'never-log-error', errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        await rpc.invokeLocal('demo', { token: 'never-log-payload' });
        rpc.retireEncryptionContext();
        await rpc.handleRequest({ method: 'machine:demo', params: {} });
        expect(logger.mock.calls).toEqual([
            ['[RPC] Request completed', expect.objectContaining({ method: 'demo', callerClass: 'local',
                outcomeCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'handler_admission' })],
            ['[RPC] Request completed', expect.objectContaining({ method: 'demo', outcomeCode: RPC_ERROR_CODES.UPDATE_REQUIRED })],
        ]);
    });

    it('retains a confidential admission predicate while preserving the closed response', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger,
            authorizeRequest: () => ({ ok: false, error: 'never-log-credential', errorCode: RPC_ERROR_CODES.FORBIDDEN }) });
        rpc.registerHandler(RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE, () => ({ ok: true }));
        expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`, params: {},
            transportResponseEnvelopeVersion: 1 })).toEqual({ v: 1, result: {
            error: 'confidential_continuation_failed', errorCode: 'confidential_continuation_failed',
        } });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            outcomeCode: 'confidential_continuation_failed', callerClass: 'unadmitted', admissionPredicate: 'authorize_request',
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it('includes projection failure in the same safe completion record', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'private-session', encryptionMode: 'plain', logger,
            projectTransportAcknowledgement() { throw new Error('never-log-secret /home/private/work'); } });
        rpc.registerHandler('demo', () => ({ ok: true }));
        expect(await rpc.handleRequest({ method: 'private-session:demo', params: {}, transportResponseEnvelopeVersion: 1 }))
            .toEqual({ v: 1, result: { ok: true } });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            method: 'demo', outcomeCode: 'ok', acknowledgementOutcomeCode: 'unclassified_error',
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private-session|\/home/);
    });
});
