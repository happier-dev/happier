import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema, ExecutionRunFollowFrontierResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { callSocketRpc, type SocketRpcContent } from '@happier-dev/sync-client';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Socket } from 'socket.io-client';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { projectExecutionRunSessionUpdateState } from '@/agent/runtime/bridges/executionRun/publicState';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';

describe('Machine Run get through the shared registered handler', () => {
    let directory: string;
    const managers: ExecutionRunHostBridge[] = [];

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'happier-machine-run-get-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        vi.stubEnv('HAPPIER_EXPERIMENTAL_EXECUTION_RUNS', '1');
        reloadConfiguration();
    });
    afterEach(async () => {
        await Promise.all(managers.splice(0).map(manager => manager.dispose()));
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
    });

    it.each(['plain', 'e2ee'] as const)('keeps the %s Follow frontier content-free while preserving private Run GET', async mode => {
        const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'machine-comparison',
            metadata: { sourceKey: 'machine-comparison', source: { kind: 'workingTree' } },
            comparison: { id: 'machine-comparison', source: { kind: 'workingTree' }, repository: { rootPath: directory },
                endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
            requestedOutputs: ['summary', 'walkthrough'], resultId: 'machine-result', revision: 1,
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            outputs: { summary: { state: 'pending' }, walkthrough: { state: 'complete', value: { title: 'Retained native output', intro: '', stops: [], otherChangeRefs: [] } } },
        });
        const run = { runId: 'machine-run', callId: 'machine-call', sidechainId: 'machine-sidechain', sessionId: null,
            depth: 0, intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
            instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
            status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
            requesterWorkAttributionV1: { serverId: 'home', accountId: 'requester', machineId: 'machine', installationId: 'installation' },
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: output }, latestToolResult: output,
        } satisfies ExecutionRunState;
        await retainExecutionRunState(run);
        await retainExecutionRunState({ ...run, terminalOccurrenceId: 'machine-terminal-original' });
        await retainExecutionRunState({ ...run, runId: 'session-run', sessionId: 'hosting-session',
            terminalOccurrenceId: 'terminal-original' });
        await retainExecutionRunState({ ...run, runId: 'active-session-run', sessionId: 'hosting-session',
            status: 'running', finishedAtMs: undefined });
        const admission = { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: mode } as const;
        const key = new Uint8Array(32).fill(7);
        const content: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine',
            ...(mode === 'plain' ? { encryptionMode: 'plain' as const }
                : { encryptionKey: key, encryptionVariant: 'dataKey' as const }),
            // The Home admission service is outside this daemon/codec boundary.
            authorizeRequest: async request => {
                expect(request.machineAdmission).toEqual(admission);
                return { ok: true };
            },
        });
        registerExecutionRunHandlers(rpc, {
            sessionId: null, cwd: directory, serverId: 'home', machineId: 'machine', parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
            executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } } },
            }) }),
            onManagerCreated: manager => { managers.push(manager); },
        });
        const published = new Set<string>();
        // Socket.IO is the system boundary. The real daemon registration,
        // protocol packet codec, dispatch, Action executor and retained store run.
        rpc.onSocketConnect({ auth: { clientType: 'machine-scoped' },
            on() {}, emit(event: string, payload: { method: string }) {
                // The deciding sensitivity run withdraws only the real frontier
                // publication at this Socket.IO boundary, never production code.
                const disabledFrontier = process.env.HAPPIER_TEST_EXECUTION_RUN_FRONTIER_PUBLICATION === 'disabled'
                    && payload.method === `machine:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`;
                if (event === SOCKET_RPC_EVENTS.REGISTER && !disabledFrontier) published.add(payload.method);
            },
        } as unknown as Socket);
        const socket = {
            async emitWithAck(event: string, payload: SocketRpcRequestPayload) {
                expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
                if (!published.has(payload.method)) return { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'RPC method not available' };
                const result = await rpc.handleRequest({ ...payload, callerAuthority: 'present_user', machineAdmission: admission });
                return { ok: true, result };
            },
            emit() {}, on() {}, off() {},
            timeout() { return this; },
        };
        const invoke = (method: string, params: unknown) => callSocketRpc({ socket, target: { kind: 'machine', id: 'machine' },
            method, params, content });
        const request = ExecutionRunGetRequestSchema.parse({ runId: run.runId, includeStructured: true,
            waitForInputId: 'native-input',
            waitForOutput: { kind: 'review_walkthrough', comparisonId: 'machine-comparison', resultId: 'machine-result', afterRevision: 0 } });
        const response = ExecutionRunGetResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request));
        expect(response.run).toMatchObject({ runId: run.runId, status: 'succeeded' });
        expect(ScmDiffSummaryGenerateOutputSchema.parse(response.structuredMeta?.payload)).toEqual(output);
        expect(ScmDiffSummaryGenerateOutputSchema.parse(response.latestToolResult)).toEqual(output);
        const header = ExecutionRunGetResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: run.runId, includeStructured: false, includeLatestToolResult: false }));
        expect(header.run.runId).toBe(run.runId);
        expect(header).not.toHaveProperty('latestToolResult');
        expect(header).not.toHaveProperty('structuredMeta');
        const outputRef = { kind: 'scm_diff_summary', output: 'walkthrough', comparisonId: 'machine-comparison', resultId: 'machine-result' };
        const summaryRef = { ...outputRef, output: 'summary' };
        expect(ExecutionRunFollowFrontierResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { machineId: 'machine', runId: run.runId, outputRefs: [outputRef, summaryRef] }))).toEqual({ machineId: 'machine', sessionId: null,
            runId: run.runId, status: 'succeeded', terminalEventId: 'machine-terminal-original',
            outputs: [{ outputRef, revision: 1, state: 'complete' }, { outputRef: summaryRef, revision: 1, state: 'pending' }] });
        for (const request of [
            { machineId: 'other-machine', runId: run.runId },
            { machineId: 'machine', runId: 'session-run' },
            { machineId: 'machine', sessionId: 'hosting-session', runId: run.runId },
            { runId: run.runId },
        ]) expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER, request)).toMatchObject({ ok: false });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { ...request, runId: 'session-run' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        const frontier = await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'active-session-run' });
        expect(frontier).toEqual({ sessionId: 'hosting-session', runId: 'active-session-run', status: 'running', terminalEventId: null });
        await retainExecutionRunState({ ...run, runId: 'active-session-run', sessionId: 'hosting-session', status: 'running',
            finishedAtMs: undefined, attention: { kind: 'permission_required', requestIds: ['run-permission'], requests: [{ requestId: 'run-permission', createdAt: 1 }] } });
        expect(ExecutionRunFollowFrontierResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'active-session-run' })))
            .toMatchObject({ status: 'running', terminalEventId: null, attention: { kind: 'permission_required', requestIds: ['run-permission'] } });
        await retainExecutionRunState({ ...run, runId: 'active-session-run', sessionId: 'hosting-session', status: 'running', finishedAtMs: undefined });
        expect(ExecutionRunFollowFrontierResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'active-session-run' }))).not.toHaveProperty('attention');
        expect.soft(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'session-run' }))
            .toEqual({ sessionId: 'hosting-session', runId: 'session-run', status: 'succeeded', terminalEventId: 'terminal-original' });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'other-session', runId: 'active-session-run' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'machine-run' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
        expect(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: run.runId }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
        await retainExecutionRunState({ ...run, runId: 'timed-out-run', status: 'timeout', terminalOccurrenceId: 'timeout-original' });
        expect(ExecutionRunFollowFrontierResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { machineId: 'machine', runId: 'timed-out-run' })))
            .toMatchObject({ machineId: 'machine', sessionId: null, status: 'timeout', terminalEventId: 'timeout-original' });
        const recoveryIssue = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            occurredAt: 1000, usageLimit: { v: 1, resetAtMs: 1_800_000, retryAfterMs: null, quotaScope: 'provider', recoverability: 'wait' },
            failureCause: { phase: 'turn', failureReason: 'usage_limit', retryable: true } } as const;
        const runtimeIssueV1 = { ...recoveryIssue, sanitizedPreview: 'Native provider failure in /private/project',
            agentTurnId: '/private/native-turn',
            failureCause: { ...recoveryIssue.failureCause, providerErrorMessage: 'Native request contains private content' },
            usageLimit: { ...recoveryIssue.usageLimit, providerLimitId: 'private-plan', planType: 'private-plan',
                action: { kind: 'open_url', url: 'https://example.com/private-project' } } } as const;
        await retainExecutionRunState({ ...run, runId: 'failed-session-run', sessionId: 'hosting-session',
            status: 'failed', terminalOccurrenceId: 'failed-original', error: { code: 'usage_limit', runtimeIssueV1 } });
        expect.soft(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { sessionId: 'hosting-session', runId: 'failed-session-run' }))
            .toEqual({ sessionId: 'hosting-session', runId: 'failed-session-run', status: 'failed',
                terminalEventId: 'failed-original', runtimeIssueV1: recoveryIssue });
        await retainExecutionRunState({ ...run, runId: 'failed-machine-run', status: 'failed',
            terminalOccurrenceId: 'failed-machine-original', error: { code: 'usage_limit', runtimeIssueV1 } });
        // Home sees this raw plain reply even when the installed Machine codec is E2EE.
        expect.soft(await rpc.handleRequest({ method: `machine:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`,
            params: { machineId: 'machine', runId: 'failed-machine-run' }, machineAdmission: admission,
            authorization: { kind: 'machine.read.serverOrigin', accountId: 'requester', machineId: 'machine' } }))
            .toEqual({ machineId: 'machine', sessionId: null, runId: 'failed-machine-run', status: 'failed',
                terminalEventId: 'failed-machine-original', runtimeIssueV1: recoveryIssue });
        const privateRead = ExecutionRunGetResponseSchema.parse(await invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: 'failed-machine-run' }));
        expect(privateRead.run.error?.runtimeIssueV1).toEqual(runtimeIssueV1);
        // The clear Session socket is a sibling projection of the same retained error.
        expect.soft(projectExecutionRunSessionUpdateState({ ...privateRead.run, error: {
            ...privateRead.run.error!, message: 'Native prose', details: { path: '/private/project' },
        } }).error).toEqual({ code: 'usage_limit', runtimeIssueV1: recoveryIssue });
        // Removing the published registration must make this same front door
        // fail, even though the in-process handler remains available.
        published.delete(`machine:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
        await expect(invoke(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request)).rejects.toMatchObject({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        published.delete(`machine:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`);
        await expect(invoke(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
            { machineId: 'machine', runId: run.runId, outputRefs: [outputRef] }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        rpc.onSocketDisconnect();
    });

    it('redacts registered host secrets from every Run output read before it leaves the hosting process', async () => {
        const secret = 'live-host-bearer-secret';
        const unregister = registerTranscriptSecret(secret);
        try {
            const run = { runId: 'secret-run', callId: 'secret-call', sidechainId: 'secret-sidechain', sessionId: null,
                depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
                instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
                status: 'failed', startedAtMs: 1, finishedAtMs: 2, terminalOccurrenceId: 'secret-terminal',
                requesterWorkAttributionV1: { serverId: 'home', accountId: 'requester', machineId: 'machine', installationId: 'installation' },
                latestToolResult: { answer: `echoed ${secret}` },
                error: { code: 'execution_run_failed', message: `provider said ${secret}` },
            } satisfies ExecutionRunState;
            await retainExecutionRunState(run);
            const admission = { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' } as const;
            const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
                authorizeRequest: async () => ({ ok: true }) });
            registerExecutionRunHandlers(rpc, {
                sessionId: null, cwd: directory, serverId: 'home', machineId: 'machine', parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
                executionRunProfileCatalog: buildExecutionRunProfileCatalog(),
                getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                    features: { execution: { runs: { enabled: true } } },
                }) }),
                onManagerCreated: manager => { managers.push(manager); },
            });
            // The registered daemon handler, dispatch, Action executor and retained store run for real.
            const call = (method: string, params: unknown) => rpc.handleRequest({ method: `machine:${method}`, params,
                callerAuthority: 'present_user', machineAdmission: admission });
            const reads = [
                await call(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: run.runId, includeStructured: true }),
                await call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {}),
                await call(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, { runId: run.runId, timeoutSeconds: 1 }),
            ];
            expect(reads[0]).toMatchObject({ run: { runId: run.runId }, latestToolResult: { answer: 'echoed [redacted]' } });
            for (const read of reads) {
                expect(JSON.stringify(read)).toContain('[redacted]');
                expect(JSON.stringify(read)).not.toContain(secret);
            }
        } finally {
            unregister();
        }
    });
});
