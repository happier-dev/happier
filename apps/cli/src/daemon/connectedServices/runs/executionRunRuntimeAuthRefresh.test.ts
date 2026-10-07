import { describe, expect, it } from 'vitest';
import type { ConnectedServiceDaemonAuthBridgeRefreshRequest, ConnectedServiceDaemonAuthBridgeRefreshResult } from '../daemonAuthBridgeTypes';
import { SPAWN_SESSION_ERROR_CODES, type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createExecutionRunConnectedServicesBridge } from './executionRunMaterialization';

const path = '/connected-service-run/refresh-runtime-auth';
const selection = { kind: 'group' as const, serviceId: 'happier.agent.codex/openai-codex' as const, groupId: 'pool',
    activeProfileId: 'member', fallbackProfileId: 'fallback', generation: 7 };
const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const bindings = { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
    source: 'connected' as const, selection: 'group' as const, groupId: 'pool', profileId: 'fallback',
} } };

async function harness(refresh: (request: ConnectedServiceDaemonAuthBridgeRefreshRequest) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>) {
    const registry = new ConnectedServiceRuntimeRegistry();
    const runnerIdentity = {};
    let runnerCurrent = true;
    let contributionCurrent = true;
    let purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    const unusedBoundary = async (): Promise<never> => { throw new Error('No contributed purpose in this fixture'); };
    // Materialization is already complete in this fixture. The real retained-activation owner,
    // registry, HTTP authorization and refresh bridge dispatch run beneath that boundary.
    const bridge = createExecutionRunConnectedServicesBridge({
        resolveAuthForSpawn: async () => ({ env: { CODEX_HOME: '/materialized/run/codex',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{ ...selection, credentialRevision: revision }]) },
            cleanupOnFailure: null, cleanupOnExit: async () => {}, connectedServicesBindings: bindings,
            targetMaterializedRoot: '/materialized/run/codex' }),
        registerRunTargets: (registration) => { registry.registerRunTarget({ ...registration, pid: registration.runnerPid }); },
        unregisterRunTargets: (runKey) => { registry.unregisterRunKey(runKey); },
        getRunRuntimeTarget: (runKey) => registry.getRunTargetByRunKey(runKey),
        resolveDaemonAuthBridge: async () => ({ serviceId: selection.serviceId, refresh }),
        resolveRunMaterializedRoot: () => '/materialized/run/codex',
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: () => ({ identity: runnerIdentity, parentSessionId: 'parent-session', isCurrent: () => runnerCurrent }),
        acquireAgentPurposeContributions: async () => ({ contributions: { agentDefinitionsById: new Map() },
            resolveAgentContributionIdentity: async () => null, isCurrent: () => contributionCurrent, release: async () => {} }),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => purposeBindings, update: async (mutate) => { purposeBindings = mutate(purposeBindings); return purposeBindings; },
                subscribe: () => ({ dispose: () => {} }) },
            selectTarget: unusedBoundary, resolveTarget: unusedBoundary, materializeAccount: unusedBoundary,
            projectTargetAccounts: unusedBoundary, assertTargetAccountMaterializable: unusedBoundary,
        }),
        requestAuthRegistry: { activate: async () => { throw new Error('No request-auth purpose in this fixture'); }, retire: async () => {} },
        resolveRequestAuthHttpPort: () => 42427,
        createRedactionLease: () => ({ add: () => {}, close: () => {} }),
        clearTerminalCleanupReceipt: async () => {},
    });
    const materialized = await bridge.materialize({ runId: 'run', runnerPid: 4242, agentId: 'codex', connectedServices: bindings, cwd: '/project' });
    if (!materialized.ok) throw new Error(materialized.errorMessage);
    const request = { runId: 'run', runnerPid: 4242, activationId: materialized.activationId,
        serviceId: selection.serviceId, refreshAttemptId: 'refresh-1', selection, expectedCredentialRevision: revision };
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken: 'master',
        stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {},
        verifyRunMaterializeToken: (token) => token === 'scoped',
        refreshConnectedServiceRuntimeAuthForExecutionRun: (input) => bridge.refreshRuntimeAuth(input),
    });
    const post = async (payload: unknown = request, token = 'scoped') => await app.inject({ method: 'POST', url: path,
        headers: { 'x-happier-daemon-token': token, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    return { app, bridge, request, post, registry,
        retireRunner: () => { runnerCurrent = false; }, retireContribution: () => { contributionCurrent = false; } };
}

describe('execution Run runtime auth refresh HTTP authority', () => {
    it('uses real Run scope and rejects master control authority', async () => {
        const requests: ConnectedServiceDaemonAuthBridgeRefreshRequest[] = [];
        const h = await harness(async (request) => { requests.push(request); return { status: 'refreshed', result: { proof: 'fresh' } }; });
        try {
            expect((await h.post(h.request, 'master')).statusCode).toBe(401);
            const response = await h.post();
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, result: { status: 'refreshed', result: { proof: 'fresh' } } });
            expect(requests).toEqual([{ runId: 'run', refreshAttemptId: 'refresh-1', selection,
                expectedCredentialRevision: revision, forceRefresh: true }]);
        } finally { await h.app.close(); }
    });

    it('rejects stale activation, wrong runner, mismatched member/revision and unknown authority fields', async () => {
        const requests: ConnectedServiceDaemonAuthBridgeRefreshRequest[] = [];
        const h = await harness(async (request) => { requests.push(request); return { status: 'refreshed', result: {} }; });
        try {
            for (const patch of [
                { activationId: '00000000-0000-4000-8000-000000000000' }, { runnerPid: 4243 },
                { selection: { ...selection, activeProfileId: 'other' } },
                { selection: { ...selection, generation: 8 } },
                { expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' }, { serviceId: 'claude-subscription' },
            ]) {
                const response = await h.post({ ...h.request, ...patch });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
            }
            expect((await h.post({ ...h.request, sessionId: 'invented-session' })).statusCode).toBe(400);
            expect(requests).toEqual([]);
        } finally { await h.app.close(); }
    });

    it.each(['runner', 'contribution', 'release'] as const)('refuses credentials after %s authority is retired while refresh is pending', async (retirement) => {
        let started!: () => void;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (result: ConnectedServiceDaemonAuthBridgeRefreshResult) => void;
        const pending = new Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>((resolve) => { settle = resolve; });
        const h = await harness(async () => { started(); return await pending; });
        try {
            const responsePromise = h.post();
            await entered;
            if (retirement === 'runner') h.retireRunner();
            if (retirement === 'contribution') h.retireContribution();
            if (retirement === 'release') await h.bridge.release(h.request);
            settle({ status: 'refreshed', result: { proof: 'must-not-disclose' } });
            const response = await responsePromise;
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
            expect(response.body).not.toContain('must-not-disclose');
        } finally { settle({ status: 'failed', reason: 'closed' }); await h.app.close(); }
    });

    it('preserves matching pending admission and rejects another refresh attempt acknowledgment', async () => {
        let attemptId = 'refresh-1';
        const h = await harness(async () => ({ status: 'pending', refreshAttemptId: attemptId }));
        try {
            expect((await h.post()).json()).toEqual({ ok: true, result: { status: 'pending', refreshAttemptId: 'refresh-1' } });
            attemptId = 'someone-else';
            expect((await h.post()).json()).toEqual({ ok: true,
                result: { status: 'failed', reason: 'runtime_auth_refresh_attempt_mismatch' } });
        } finally { await h.app.close(); }
    });
});
