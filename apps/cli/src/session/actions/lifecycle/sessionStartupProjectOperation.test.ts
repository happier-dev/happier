import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';

import { createSessionStartupProjectSpawn } from './sessionStartupProjectOperation';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '@/daemon/types';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionServerStartSpawnLifecycleTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';

describe('resume native startup observation', () => {
    it.each(['resume', 'cancel', 'native-timeout'] as const)('retains the original startup through a long setup review until %s', async decision => {
        vi.useFakeTimers();
        const timeoutMs = resolveSessionStartupTimeoutMs();
        const scope = { accountId: 'person', machineId: 'machine' };
        const details = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
            reviewedEffect: { commands: ['reviewed command'] } } as const;
        const admission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
            readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) });
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(4321),
            startedBy: 'daemon', pid: 4321, happySessionId: 'session',
            agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/runner-authority.json' };
        const changes = createSessionLiveWorkProducer({ readSessions: () => [tracked],
            readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
        const operations = createHostActionOperationRuntime({ machineId: 'machine',
            resolveAccountId: async () => 'person', generateOperationId: () => 'startup', supportsCoreCancellation: () => true });
        let observationStarted!: () => void;
        const started = new Promise<void>(resolve => { observationStarted = resolve; });
        let settled = false;
        let nativeOpens = 0;
        const observing = operations.observeExecution({ actionId: 'session.spawn_new',
            input: { creationKey: 'creation' }, execute: async operation => {
                const spawn = createSessionStartupProjectSpawn({
                    context: { signal: operation.signal, localActionContext: operation },
                    spawnSession: async options => {
                        const startup = options.projectSetupOperation!;
                        startup.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'setup',
                            serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo' } });
                        void admission.execute({ operationId: 'startup', workspaceRefId: 'workspace', signal: operation.signal,
                            accept() {}, run: async reservation => {
                                reservation.phase('setup');
                                try {
                                    await startup.operationReview!.waitForResume(details);
                                    if (decision !== 'native-timeout') {
                                        nativeOpens++;
                                        tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
                                            request: { kind: 'create', sessionId: 'session', cwd: '/repo' }, providerSessionId: null };
                                        changes.notifySessionChanged('session');
                                    }
                                    return { kind: 'no_launch', result: { ok: true, result: {} } };
                                } catch {
                                    return { kind: 'no_launch', result: { ok: false, errorCode: 'cancelled', error: 'cancelled' } };
                                }
                            } });
                        return { type: 'success', sessionId: 'session' };
                    },
                    stopSession: async () => true,
                    awaitAgentSessionOpen: input => {
                        observationStarted();
                        return awaitTrackedRunnerAgentSessionOpen({ ...input,
                            getTrackedSessions: () => [tracked],
                            subscribeChanges: listener => changes.subscribe(listener, 'session') });
                    },
                });
                const result = await spawn({ directory: '/repo' });
                settled = true;
                return { ok: true, result };
            } });
        void observing.catch(() => undefined);
        try {
            await started;
            await vi.advanceTimersByTimeAsync(timeoutMs + 1_000);
            expect(settled).toBe(false);
            expect(operations.store.get(scope, 'startup')).toMatchObject({ state: 'running', setupReview: details });
            expect(admission.dependencies()).toMatchObject([{ operationId: 'startup', state: 'setup' }]);
            if (decision !== 'cancel') {
                // Exact re-entry resumes the existing review continuation.
                const replay = operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'creation' },
                    execute: async () => { throw new Error('Must not replay startup'); } });
                if (decision === 'native-timeout') {
                    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
                    expect(settled).toBe(false);
                    await vi.advanceTimersByTimeAsync(1);
                    await expect(observing).resolves.toMatchObject({ result: { type: 'error',
                        errorDetail: { code: 'SESSION_WEBHOOK_TIMEOUT' } } });
                }
                await replay;
                await observing;
                expect(settled).toBe(true);
                expect(nativeOpens).toBe(decision === 'resume' ? 1 : 0);
            } else {
                operations.runner.cancel(scope, 'startup');
                await expect(observing).rejects.toMatchObject({ name: 'AbortError' });
                await vi.advanceTimersByTimeAsync(0);
                expect(nativeOpens).toBe(0);
            }
            expect(admission.dependencies()).toEqual([]);
        } finally {
            // Native open is the process boundary; the tracked-runner wait and
            // original Action lifecycle above are the production owners.
            tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
                request: { kind: 'create', sessionId: 'session', cwd: '/repo' }, providerSessionId: null };
            changes.notifySessionChanged('session');
            operations.runner.cancel(scope, 'startup');
            try { await observing.catch(() => undefined); } finally { vi.useRealTimers(); }
        }
    });
    it('keeps the admitted Session requester on postbirth HTTP effects instead of spending the daemon credential', async () => {
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-session-root', binding: {
            accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'session.spawn_new', requestId: 'creation',
            machineId: target.machineId, installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        const operations = createHostActionOperationRuntime({ machineId: target.machineId,
            resolveAccountId: async () => 'requester', generateOperationId: () => 'startup-operation' });
        let signedByOriginalRequester = false;
        await operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'creation' }, execute: async operation => {
            const lifecycle = createSpawnNewSessionLifecycleActionHandler({
                stopSession: async () => true,
                awaitAgentSessionOpen: async () => ({ status: 'opened', request: { kind: 'create', sessionId: 'committed-session', cwd: '/repo' } }),
                spawnSession: async options => {
                    const request = { method: 'POST', path: '/v1/machines/managed/controller/context',
                        body: { homeId: 'home', managedId: 'managed', sessionId: 'committed-session', expectedIntentRevision: 0,
                            controller: { machineId: target.machineId, installationId: 'installation' } } };
                    const resolved = resolveExternalActionServerRequestHeaders({ context: options.projectSetupOperation,
                        effectActionId: 'session.spawn_new', ...request, daemonToken: 'daemon-credential',
                        serverIdentityId: 'home', installationId: 'installation', privateKey: keys.secretKey });
                    signedByOriginalRequester = resolved.ok && verifyExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, target, installationId: 'installation', requestId: 'creation',
                        effectActionId: 'session.spawn_new', ...request,
                        signature: resolved.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], publicKey: keys.publicKey });
                    return { type: 'success', sessionId: 'committed-session' };
                } });
            const transport = createMachineSessionServerStartSpawnLifecycleTransport({ spawnLifecycleHandler: lifecycle });
            // The canonical exact-daemon creator forwards its admitted root and
            // operation ports in localActionContext; no serialized RPC runs.
            expect(await transport.spawn({ directory: '/repo',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            }, { signal: operation.signal,
                localActionContext: { ...operation, externalActionExecutionAuthorization: authorization,
                    externalActionTarget: target } })).toMatchObject({ type: 'success', sessionId: 'committed-session' });
            return { ok: true, result: {} };
        } });
        expect(signedByOriginalRequester).toBe(true);
    });
    it('refuses resume when native startup observation is unavailable', async () => {
        const spawn = createSessionStartupProjectSpawn({ context: undefined,
            spawnSession: async () => { throw new Error('must not launch without observation'); } });
        await expect(spawn({ directory: '/repo', existingSessionId: 'resumed-session' }))
            .resolves.toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE',
                errorDetail: { kind: 'launch_error', code: 'session_startup_observation_unavailable' } });
    });
    it('does not report a webhook-acknowledged resume as opened before native authentication settles', async () => {
        let finishNativeOpen!: () => void;
        const nativeOpen = new Promise<void>(resolve => { finishNativeOpen = resolve; });
        let settled = false;
        const spawn = createSessionStartupProjectSpawn({
            context: undefined,
            stopSession: async () => true,
            spawnSession: async () => ({ type: 'success', sessionId: 'resumed-session' }),
            awaitAgentSessionOpen: async () => {
                await nativeOpen;
                return { status: 'runner_exited', code: 'acp_session_start_failed',
                    failureCause: { phase: 'authentication', failureReason: 'unclassified_provider_error',
                        providerErrorCode: 'acp_authenticate_timeout' } };
            },
        });
        const result = spawn({ directory: '/repo', existingSessionId: 'resumed-session' });
        void result.then(() => { settled = true; });
        await new Promise<void>(resolve => { setImmediate(resolve); });
        try {
            expect(settled).toBe(false);
        } finally { finishNativeOpen(); }
        await expect(result).resolves.toMatchObject({ type: 'error', errorDetail: {
            kind: 'launch_error', code: 'acp_session_start_failed',
            failureCause: { phase: 'authentication', providerErrorCode: 'acp_authenticate_timeout' },
        } });
    });

    it('preserves a successfully opened resume without a project setup operation', async () => {
        const spawn = createSessionStartupProjectSpawn({
            context: undefined,
            stopSession: async () => true,
            spawnSession: async () => ({ type: 'success', sessionId: 'resumed-session' }),
            awaitAgentSessionOpen: async () => ({ status: 'opened',
                request: { kind: 'create', sessionId: 'resumed-session', cwd: '/repo' } }),
        });
        await expect(spawn({ directory: '/repo', existingSessionId: 'resumed-session' }))
            .resolves.toEqual({ type: 'success', sessionId: 'resumed-session' });
    });

    it('retains the exact admitted spawn Action for setup autostart rather than inferring a new parent', async () => {
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const originalInput = { directory: '/original-project', creationKey: 'original-creation' };
        const envelope = { v: 1 as const, requestId: 'spawn', target, input: originalInput };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted', binding: {
            serverIdentityId: 'home', accountId: 'person', authentication: { kind: 'account', tokenEpoch: 0 },
            actionId: 'session.spawn_new', requestId: 'spawn', requestEnvelopeDigest: 'a'.repeat(43),
            machineId: 'machine', custodianAccountId: 'person', installationId: 'installation', target, accountEncryptionMode: 'plain',
        } });
        const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'person', generateOperationId: () => 'startup' });
        await operations.observeExecution({ actionId: 'session.spawn_new', input: originalInput, execute: async operation => {
            const retained = { parent: { actionId: 'session.spawn_new' as const, input: originalInput }, context: {
                surface: 'rpc' as const, authority: 'account_automation' as const,
                originalActionEnvelope: envelope, externalActionExecutionAuthorization: authorization, externalActionTarget: target,
                executeHostReviewedChildAction: async () => ({ ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' }),
            } };
            const spawn = createSessionStartupProjectSpawn({ context: { signal: operation.signal,
                localActionContext: { ...operation, setupAutostart: retained } },
                awaitAgentSessionOpen: async () => ({ status: 'opened', request: { kind: 'create', sessionId: 'session', cwd: '/resolved-project' } }),
                stopSession: async () => true,
                spawnSession: async options => {
                    expect(options.projectSetupOperation?.setupAutostart?.parent).toEqual({ actionId: 'session.spawn_new', input: originalInput });
                    expect(options.projectSetupOperation?.setupAutostart?.context.externalActionExecutionAuthorization).toBe(authorization);
                    return { type: 'success', sessionId: 'session' };
                } });
            await spawn({ directory: '/resolved-project' });
            return { ok: true, result: {} };
        } });
    });
});
