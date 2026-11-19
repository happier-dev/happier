import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';

import { createSessionStartupProjectSpawn } from './sessionStartupProjectOperation';
import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionServerStartSpawnLifecycleTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';

describe('resume native startup observation', () => {
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
