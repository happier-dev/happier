import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';

import {
    deriveConnectedServiceRunMaterializeToken,
    isValidConnectedServiceRunMaterializeToken,
} from './connectedServices/runs/capabilityToken';
import { createDaemonControlApp } from './controlServer';
import type { ConnectedServiceRunRejectedStartRequest } from './connectedServices/runs/materializeContract';
import { createExecutionRunConnectedServicesBridge } from './connectedServices/runs/executionRunMaterialization';
import { resolveConnectedServiceAuthForSpawn } from './connectedServices/resolveConnectedServiceAuthForSpawn';
import type { ApiClient } from '@/api/api';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import { readAppliedParentConnectedServices, recoverExecutionRunConnectedServiceRuntimeFailure } from './controlClient';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from './connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import * as persistence from '@/persistence';
import { recoverConnectedServiceRuntimeFailure } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';

const RUN_BINDINGS = {
    v: 1,
    bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile_1',
        },
    },
} as const;
const EMITTED_RUN_BINDINGS = ConnectedServiceBindingsV2IngressSchema.parse(RUN_BINDINGS);

function createApp(overrides: Record<string, unknown> = {}) {
    return createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'unused',
        }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'master-token',
        verifyRunMaterializeToken: (provided: string) =>
            isValidConnectedServiceRunMaterializeToken(provided, 'master-token'),
        ...overrides,
    } as Parameters<typeof createDaemonControlApp>[0]);
}

describe('connected-service run materialize capability token', () => {
    it('derives a scoped token distinct from the master and verifies constant-time', () => {
        const scoped = deriveConnectedServiceRunMaterializeToken('master-token');
        expect(scoped).not.toBe('');
        expect(scoped).not.toBe('master-token');
        expect(isValidConnectedServiceRunMaterializeToken(scoped, 'master-token')).toBe(true);
        expect(isValidConnectedServiceRunMaterializeToken('master-token', 'master-token')).toBe(false);
        expect(isValidConnectedServiceRunMaterializeToken('', 'master-token')).toBe(false);
        expect(isValidConnectedServiceRunMaterializeToken(scoped, '')).toBe(false);
    });

});

describe('createDaemonControlApp connected-service run materialization bridge', () => {
    const scopedToken = deriveConnectedServiceRunMaterializeToken('master-token');
    const activationId = '11111111-1111-4111-8111-111111111111';

    it('pushes persisted Run recovery waiting before the same HTTP operation finishes without cancelling recovery', async () => {
        const records = new Map<string, unknown>();
        const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
            nowMs: Date.now,
            store: { read: key => records.get(key) ?? null, write: (key, intent) => { records.set(key, intent); } },
            resume: async () => ({ status: 'continued' }),
        });
        const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
            leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: Date.now,
            // Single-profile recovery never accesses group persistence or a native group switch.
            loadState: async () => { throw new Error('No group for this profile'); },
            commitSwitch: async () => { throw new Error('No group for this profile'); },
            applyGeneration: async () => { throw new Error('No group for this profile'); },
        });
        let recoverySignal: AbortSignal | undefined;
        const app = createApp({ recoverConnectedServiceRuntimeFailureForExecutionRun: async (
            _request: unknown, signal: AbortSignal, onRecoveryWaiting?: (recovery: SessionUsageLimitRecoveryV1) => void,
        ) => {
            recoverySignal = signal;
            return await recoverConnectedServiceRuntimeFailure({ scope: { kind: 'run', runId: 'waiting-run' },
                selection: { kind: 'profile', serviceId: 'happier.agent.claude/anthropic', profileId: 'profile' },
                classification: { kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account',
                    serviceId: 'happier.agent.claude/anthropic', profileId: 'profile', groupId: null, resetsAtMs: Date.now() + 86_400_000,
                    retryAfterMs: null, providerLimitId: 'weekly', action: null, planType: null, rateLimits: null,
                    source: 'structured_provider_error' },
                switchCoordinator, temporaryThrottleScheduler: scheduler,
                continuation: { interruptedOriginId: 'turn-1', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'usage_limit' },
                signal, isCurrent: () => !signal.aborted, nowMs: Date.now, onRecoveryWaiting,
            });
        } });
        try {
            const address = await app.listen({ host: '127.0.0.1', port: 0 });
            // The local daemon state file is the OS boundary; admission and
            // the HTTP client/server operation remain real.
            vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid,
                httpPort: Number(new URL(address).port), controlToken: 'master-token',
                startedAt: Date.now(), startedWithCliVersion: '0.3.0',
            });
            const waiting: SessionUsageLimitRecoveryV1[] = [];
            let finished = false;
            const pending = recoverExecutionRunConnectedServiceRuntimeFailure({ activationId, runId: 'waiting-run',
                runnerPid: process.pid, nativeResumeId: 'native-session', interruptedOriginId: 'turn-1', diagnostic: {},
            }, { signal: new AbortController().signal,
                onRecoveryWaiting: recovery => { waiting.push(recovery); },
            }).then(result => { finished = true; return result; });
            await vi.waitFor(() => expect(scheduler.read('run:waiting-run')?.status).toBe('waiting'));
            await vi.waitFor(() => expect(waiting).toHaveLength(1));
            expect(waiting[0]).toMatchObject({ v: 1, status: 'waiting', attemptCount: 0,
                nextCheckAtMs: expect.any(Number), selectedAuth: { kind: 'profile', serviceId: 'happier.agent.claude/anthropic', profileId: 'profile' } });
            expect(finished).toBe(false);
            expect(recoverySignal?.aborted).toBe(false);
            expect(scheduler.read('run:waiting-run')?.status).toBe('waiting');
            await scheduler.finishRun('waiting-run');
            await expect(pending).resolves.toEqual({ status: 'failed', reason: 'runtime_recovery_cancelled' });
            expect(recoverySignal?.aborted).toBe(false);
        } finally { await scheduler.finishRun('waiting-run'); scheduler.dispose(); await app.close(); vi.restoreAllMocks(); }
    });

    it('preserves final JSON recovery for callers that do not request progress', async () => {
        const app = createApp({ recoverConnectedServiceRuntimeFailureForExecutionRun: async () => ({ status: 'failed', reason: 'unavailable' }) });
        try {
            const response = await app.inject({ method: 'POST', url: '/connected-service-run/recover-runtime-failure',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { activationId, runId: 'legacy-run', runnerPid: process.pid, nativeResumeId: 'native', interruptedOriginId: 'turn', diagnostic: {} },
            });
            expect(response.statusCode).toBe(200);
            expect(response.headers['content-type']).toContain('application/json');
            expect(response.json()).toEqual({ status: 'failed', reason: 'unavailable' });
        } finally { await app.close(); }
    });

    it('reads applied parent bindings with scoped auth and distinguishes unavailable reasons without credential details', async () => {
        const registry = new ConnectedServiceRuntimeRegistry();
        registry.registerTarget({ pid: 4242, sessionId: 'parent', agentId: 'codex', connectedServicesBindingsRaw: {
            v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
                source: 'connected', selection: 'group', groupId: 'parent-pool', profileId: 'private-member',
            } },
        } });
        const app = createApp({ readAppliedSessionConnectedServices: (input: { runnerPid: number; sessionId: string; agentId: string }) =>
            registry.readAppliedSessionBindings(input) });
        try {
            const address = await app.listen({ host: '127.0.0.1', port: 0 });
            vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid,
                httpPort: Number(new URL(address).port), controlToken: 'master-token',
                startedAt: Date.now(), startedWithCliVersion: '0.3.0',
            });
            const payload = { runnerPid: 4242, sessionId: 'parent', agentId: 'codex' };
            const denied = await app.inject({ method: 'POST', url: '/connected-service-run/applied-parent-selection',
                headers: { 'x-happier-daemon-token': 'master-token' }, payload });
            expect(denied.statusCode).toBe(401);
            await expect(readAppliedParentConnectedServices(payload)).resolves.toEqual({ status: 'applied', connectedServices: { v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
            } } });
            await expect(readAppliedParentConnectedServices({ ...payload, sessionId: 'other' })).resolves
                .toEqual({ status: 'unavailable', reason: 'not_registered' });
            registry.updateTarget({ pid: 4242, sessionId: 'parent', connectedServicesBindingsRaw: null });
            await expect(readAppliedParentConnectedServices(payload)).resolves
                .toEqual({ status: 'unavailable', reason: 'validation_failed' });
            registry.updateTarget({ pid: 4242, sessionId: 'parent', connectedServicesBindingsRaw: {
                v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
                    source: 'team_resource', resourceId: 'private-resource', deliveryMode: 'direct',
                    disclosedMember: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'private-account' },
                } },
            } });
            await expect(readAppliedParentConnectedServices(payload)).resolves
                .toEqual({ status: 'unavailable', reason: 'direct_custody' });
        } finally { await app.close(); vi.restoreAllMocks(); }
    });

    it('admits rejected-start recovery only with scoped Run auth and sanitized evidence', async () => {
        // Unknown activation admission never reaches materialization, registry or filesystem I/O.
        const unexpectedMaterialization = () => { throw new Error('unexpected Run materialization'); };
        const bridge = createExecutionRunConnectedServicesBridge({
            resolveAuthForSpawn: async (input) => await resolveConnectedServiceAuthForSpawn({
                ...input, activeServerDir: '/unused-server', baseDir: '/unused-materialization',
                credentials: { token: 'boundary-token', encryption: null },
                // No authenticated network call is authorized by this unknown-activation request.
                api: {} as ApiClient,
            }),
            registerRunTargets: unexpectedMaterialization, unregisterRunTargets: unexpectedMaterialization,
            resolveRunMaterializedRoot: unexpectedMaterialization, createAdoptedRootCleanup: unexpectedMaterialization,
            captureRunnerIdentity: () => null,
            acquireAgentPurposeContributions: async () => unexpectedMaterialization(),
            purposeBindingOwner: { activatePurposeBindings: unexpectedMaterialization },
            requestAuthRegistry: { activate: async () => unexpectedMaterialization(), retire: async () => unexpectedMaterialization() },
            resolveRequestAuthHttpPort: unexpectedMaterialization, createRedactionLease: unexpectedMaterialization,
            clearTerminalCleanupReceipt: async () => unexpectedMaterialization(),
        });
        let admitted: ConnectedServiceRunRejectedStartRequest | null = null;
        const recoverConnectedServicesRejectedStartForExecutionRun = async (input: ConnectedServiceRunRejectedStartRequest) => {
            admitted = input;
            return await bridge.recoverRejectedStart(input);
        };
        const app = createApp({ recoverConnectedServicesRejectedStartForExecutionRun });
        const payload = {
            runId: 'run_1', runnerPid: 4242, activationId, modelId: 'requested-model',
            classification: {
                serviceId: 'openai-codex', profileId: 'profile_1', groupId: 'pool', groupGeneration: 1,
                expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', kind: 'plan', limitCategory: 'plan_invalid',
                quotaScope: 'model', providerLimitId: 'requested-model', source: 'stable_provider_message',
                privateProviderPayload: 'secret-not-forwarded',
            },
        };
        try {
            const denied = await app.inject({ method: 'POST', url: '/connected-service-run/rejected-start',
                headers: { 'x-happier-daemon-token': 'master-token' }, payload });
            expect(denied.statusCode).toBe(401);
            expect(admitted).toBeNull();
            const accepted = await app.inject({ method: 'POST', url: '/connected-service-run/rejected-start',
                headers: { 'x-happier-daemon-token': scopedToken }, payload });
            expect(accepted.statusCode).toBe(200);
            expect(accepted.json()).toEqual({ ok: false, errorCode: 'connected_service_run_activation_stale' });
            expect(admitted).toMatchObject({
                classification: { serviceId: 'happier.agent.codex/openai-codex' },
            });
            expect(JSON.stringify(admitted)).not.toContain('secret-not-forwarded');
        } finally { await app.close(); }
    });

    it('rejects the master control token and bad tokens on the run-materialize endpoint', async () => {
        const materializeConnectedServicesForExecutionRun = vi.fn();
        const app = createApp({ materializeConnectedServicesForExecutionRun });
        try {
            for (const token of ['master-token', 'nonsense', '']) {
                const response = await app.inject({
                    method: 'POST',
                    url: '/connected-service-run/materialize',
                    headers: token ? { 'x-happier-daemon-token': token } : {},
                    payload: { activationId: randomUUID(),
                        runId: 'run_1',
                        runnerPid: 4242,
                        agentId: 'codex',
                        connectedServices: RUN_BINDINGS,
                        cwd: '/tmp/project',
                    },
                });
                expect(response.statusCode).toBe(401);
            }
            expect(materializeConnectedServicesForExecutionRun).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('fails closed with 501 when no run materialization handler is wired', async () => {
        const app = createApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/materialize',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { activationId: randomUUID(),
                    runId: 'run_1',
                    runnerPid: 4242,
                    agentId: 'codex',
                    connectedServices: RUN_BINDINGS,
                    cwd: '/tmp/project',
                },
            });
            expect(response.statusCode).toBe(501);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'connected_service_run_materialization_unavailable',
            });
        } finally {
            await app.close();
        }
    });

    it('materializes via the injected daemon handler and returns the run env', async () => {
        const registration = {
            v: 1 as const,
            activationId,
            runKey: 'run_1',
            agentId: 'codex',
            materializationKey: 'run_1',
            connectedServicesBindings: EMITTED_RUN_BINDINGS,
            connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '{"v":1}' },
            sessionDirectory: '/tmp/project',
            materializedRoot: '/stack/daemon/connected-services/materialized/run_1/codex',
        };
        const materializeConnectedServicesForExecutionRun = vi.fn(async () => ({
            ok: true as const,
            activationId,
            env: { CODEX_HOME: '/stack/daemon/connected-services/materialized/run_1/codex-home' },
            connectedServicesBindings: EMITTED_RUN_BINDINGS,
            registration,
        }));
        const app = createApp({ materializeConnectedServicesForExecutionRun });
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/materialize',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { activationId: randomUUID(),
                    runId: 'run_1',
                    runnerPid: 4242,
                    agentId: 'codex',
                    connectedServices: RUN_BINDINGS,
                    cwd: '/tmp/project',
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                ok: true,
                result: {
                    activationId,
                    env: { CODEX_HOME: '/stack/daemon/connected-services/materialized/run_1/codex-home' },
                    connectedServicesBindings: EMITTED_RUN_BINDINGS,
                    registration,
                },
            });
            expect(materializeConnectedServicesForExecutionRun).toHaveBeenCalledWith({
                activationId: expect.any(String),
                runId: 'run_1',
                runnerPid: 4242,
                agentId: 'codex',
                connectedServices: EMITTED_RUN_BINDINGS,
                cwd: '/tmp/project',
            }, expect.any(AbortSignal));
        } finally {
            await app.close();
        }
    });

    it.each(['connected_service_run_materialization_blocked', 'provider_session_state_unavailable_for_resume'] as const)(
      'propagates fail-closed materialization denial %s as 403', async (errorCode) => {
        const materializeConnectedServicesForExecutionRun = vi.fn(async () => ({
            ok: false as const,
            errorCode,
            errorMessage: 'credential expired',
        }));
        const app = createApp({ materializeConnectedServicesForExecutionRun });
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/materialize',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { activationId: randomUUID(),
                    runId: 'run_1',
                    runnerPid: 4242,
                    agentId: 'codex',
                    connectedServices: RUN_BINDINGS,
                    cwd: '/tmp/project',
                },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({
                ok: false,
                errorCode,
                errorMessage: 'credential expired',
            });
        } finally {
            await app.close();
        }
    });

    it('releases run materialization through the injected release handler', async () => {
        const releaseConnectedServicesForExecutionRun = vi.fn(async () => ({ ok: true as const, released: true }));
        const app = createApp({ releaseConnectedServicesForExecutionRun });
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/release',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: {
                    runId: 'run_1',
                    runnerPid: 4242,
                    activationId,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, released: true });
            expect(releaseConnectedServicesForExecutionRun).toHaveBeenCalledWith({
                runId: 'run_1',
                runnerPid: 4242,
                activationId,
            });
        } finally {
            await app.close();
        }
    });

    it('checks generation through the scoped endpoint and fails closed without a handler', async () => {
        const checkConnectedServicesGenerationForExecutionRun = vi.fn(async () => ({ ok: true as const, current: true }));
        const app = createApp({ checkConnectedServicesGenerationForExecutionRun });
        try {
            const authorized = await app.inject({
                method: 'POST',
                url: '/connected-service-run/generation-current',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { runId: 'run_1', runnerPid: 4242 },
            });
            expect(authorized.json()).toEqual({ ok: true, current: true });
            expect(checkConnectedServicesGenerationForExecutionRun).toHaveBeenCalledWith({ runId: 'run_1', runnerPid: 4242 });
        } finally {
            await app.close();
        }

        const appWithoutHandler = createApp();
        try {
            const closed = await appWithoutHandler.inject({
                method: 'POST',
                url: '/connected-service-run/generation-current',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { runId: 'run_1', runnerPid: 4242 },
            });
            expect(closed.json()).toEqual({ ok: true, current: false });
        } finally {
            await appWithoutHandler.close();
        }
    });

    it('reports unavailable cleanup when no release handler is wired', async () => {
        const app = createApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: '/connected-service-run/release',
                headers: { 'x-happier-daemon-token': scopedToken },
                payload: { runId: 'run_1', runnerPid: 4242, activationId },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: false, errorCode: 'connected_service_run_cleanup_unavailable' });
        } finally {
            await app.close();
        }
    });
});
