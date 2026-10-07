import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { spawnTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { clearExecutionRunConnectedServicesCleanupReceipt } from '@/daemon/executionRunRegistry';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { deriveConnectedServiceRunMaterializeToken, isValidConnectedServiceRunMaterializeToken } from './capabilityToken';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { createBuiltInQualifiedNativeRefreshHarness } from '../refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { createExecutionRunConnectedServicesBridge } from './executionRunMaterialization';

const path = '/connected-service-run/refresh-runtime-auth';
const controlToken = 'master';
const scopedToken = deriveConnectedServiceRunMaterializeToken(controlToken);
const serviceId = 'happier.agent.codex/openai-codex';
const bindings = { v: 2 as const, bindingsByServiceId: { [serviceId]: {
    source: 'connected' as const, selection: 'group' as const, groupId: 'pool', profileId: 'backup',
} } };

function oauthResponse(accessToken = 'access-new') {
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-new',
        id_token: 'id-new', expires_in: 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

async function harness() {
    const directory = await mkdtemp(join(tmpdir(), 'happier-run-auth-http-'));
    const home = join(directory, 'home');
    const baseDir = join(home, 'materialized');
    const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'CODEX_HOME']);
    environment.patch({ HAPPIER_HOME_DIR: home, CODEX_HOME: undefined });
    reloadConfiguration();
    let qualified: Awaited<ReturnType<typeof createBuiltInQualifiedNativeRefreshHarness>> | null = null;
    let runner: ReturnType<typeof spawnTestProcess> | null = null;
    let bridge: ReturnType<typeof createExecutionRunConnectedServicesBridge> | null = null;
    let app: ReturnType<typeof createDaemonControlApp> | null = null;
    let request: Parameters<NonNullable<ReturnType<typeof createExecutionRunConnectedServicesBridge>['refreshRuntimeAuth']>>[0] | null = null;
    let retiringContribution: Promise<void> | null = null;
    let activationSequence = 0;
    const close = async () => {
        await app?.close();
        if (bridge && request) await bridge.release(request);
        if (runner?.pid) {
            runner.kill();
            if (!await waitForProcessExit(runner.pid)) throw new Error('Run fixture process did not exit');
        }
        await qualified?.dispose();
        await retiringContribution;
        environment.restore();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
    };
    try {
        const registry = new ConnectedServiceRuntimeRegistry();
        const h = await createBuiltInQualifiedNativeRefreshHarness({ controller: pluginReloadController, happyHomeDir: home, runtimeRegistry: registry });
        qualified = h;
        // OS/process, qualified-account HTTP/storage and OAuth are the genuine boundaries.
        // Plugin admission, purpose selection, materialization and refresh all remain real.
        runner = spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        await once(runner, 'spawn');
        const runnerPid = runner.pid;
        if (!runnerPid) throw new Error('Run fixture process has no OS identity');
        const tracked = new Map([[runnerPid, { happySessionId: 'runner-session' }]]);
        bridge = createExecutionRunConnectedServicesBridge({
            resolveAuthForSpawn: (input) => resolveConnectedServiceAuthForSpawn({ ...input,
                credentials: h.credentials, api: h.api, baseDir, activeServerDir: join(home, 'server'),
                qualifiedConnectedAccountApi: h.qualifiedApi, credentialRefreshService: h.coordinator,
                nowMs: () => h.now, processEnv: {} }),
            registerRunTargets: (registration) => registry.registerRunTarget({ ...registration, pid: registration.runnerPid }),
            unregisterRunTargets: (runKey) => registry.unregisterRunKey(runKey),
            getRunRuntimeTarget: (runKey) => registry.getRunTargetByRunKey(runKey),
            adoptRunCredentialRevision: (input) => registry.adoptExactCredentialRevisionForRun(input),
            resolveRunCredentialRevisionTarget: (input) => registry.resolveExactRunCredentialRevisionTarget(input),
            resolveDaemonAuthBridge: async (requestedService) => ({ serviceId: requestedService,
                async refresh(request, context) {
                    if (!context || !request.expectedCredentialRevision || !request.refreshAttemptId) {
                        return { status: 'unavailable', reason: 'missing_authority' };
                    }
                    const selected = context.target.connectedServiceSelections.find((selection) => selection.serviceId === requestedService);
                    if (!selected) return { status: 'unavailable', reason: 'missing_selection' };
                    return await h.coordinator.refreshConnectedServiceCredentialForRuntimeAuthBridge({
                        target: context.target, authority: context.authority, isCurrent: context.isCurrent,
                        acceptSettledCredentialRevision: context.acceptSettledCredentialRevision,
                        serviceId: requestedService, profileId: selected.kind === 'profile' ? selected.profileId : selected.activeProfileId,
                        refreshAttemptId: request.refreshAttemptId, expectedCredentialRevision: request.expectedCredentialRevision,
                    });
                },
            }),
            resolveRunMaterializedRoot: ({ runKey, agentId }) => resolveConnectedServiceMaterializedRootDir({ baseDir, materializationKey: runKey, agentId }),
            createAdoptedRootCleanup: () => null,
            captureRunnerIdentity: (input) => {
                const identity = tracked.get(input.runnerPid);
                if (!identity || input.runnerPid !== runnerPid) return null;
                return { identity, parentSessionId: identity.happySessionId,
                    isCurrent: () => tracked.get(input.runnerPid) === identity && runner?.exitCode === null };
            },
            acquireAgentPurposeContributions: async ({ agentId }) => {
                const lease = await h.controller.acquireRuntimeRegistry();
                await lease.registry.acquireAgentCatalogEntry?.(agentId);
                return { contributions: lease.registry.contributes,
                    resolveAgentContributionIdentity: async () => {
                        const identity = lease.registry.contributes.agentDefinitionsById.get(agentId)?.identity;
                        const sourceCustody = identity && lease.registry.readPluginSourceCustody?.(identity.pluginId);
                        return identity && sourceCustody ? { ...identity, sourceCustody } : null;
                    },
                    isCurrent: () => h.controller.isRuntimeRegistryCurrent(lease.registry), release: lease.release };
            },
            purposeBindingOwner: h.purposeRuntime,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
            resolveRequestAuthHttpPort: () => 42427,
            createRedactionLease: () => createProviderRedactionLease({ values: [] }),
            clearTerminalCleanupReceipt: clearExecutionRunConnectedServicesCleanupReceipt,
        });
        const capturedBridge = bridge;
        const capturedApp = createDaemonControlApp({ getChildren: () => [], machineId: 'machine', controlToken,
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {},
            verifyRunMaterializeToken: (token) => isValidConnectedServiceRunMaterializeToken(token, controlToken),
            refreshConnectedServiceRuntimeAuthForExecutionRun: (input) => capturedBridge.refreshRuntimeAuth(input),
        });
        app = capturedApp;
        return { ...h, bridge: capturedBridge, close,
            get request() {
                if (!request) throw new Error('Run fixture activation is not current');
                return request;
            },
            get nativeHome() {
                if (!request) throw new Error('Run fixture activation is not current');
                return resolveConnectedServiceMaterializedRootDir({ baseDir, materializationKey: request.runId, agentId: 'codex' });
            },
            async activate() {
                const runId = `run-${++activationSequence}`;
                const materialized = await capturedBridge.materialize({ runId, runnerPid, agentId: 'codex', connectedServices: bindings, cwd: directory });
                if (!materialized.ok) throw new Error(materialized.errorMessage);
                const group = await h.qualifiedApi.readGroup();
                const credential = await h.readCredential();
                request = { runId, runnerPid, activationId: materialized.activationId, serviceId,
                    refreshAttemptId: `refresh-${activationSequence}`, expectedCredentialRevision: credential.credentialRevision,
                    selection: { kind: 'group', serviceId, groupId: 'pool', activeProfileId: group.activeConnectedAccountId!,
                        fallbackProfileId: 'backup', generation: group.generation } };
            },
            async releaseActivation() {
                if (request) await capturedBridge.release(request);
                request = null;
                tracked.set(runnerPid, { happySessionId: 'runner-session' });
                if ((await h.qualifiedApi.readGroup()).activeConnectedAccountId !== 'work') h.switchGroupAccount('work');
            },
            post: (payload: unknown = request, token = scopedToken) => capturedApp.inject({ method: 'POST', url: path,
                headers: { 'x-happier-daemon-token': token, 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
            retireRunner: () => { tracked.delete(runnerPid); },
            retireContribution: () => { retiringContribution = h.controller.shutdown(); },
        };
    } catch (error) { await close(); throw error; }
}

describe('execution Run runtime auth refresh HTTP authority', () => {
    // The real singleton controller has one lifecycle. Re-importing the entire CLI graph
    // per case retains multiple module generations; isolate actual Run activations instead.
    let h: Awaited<ReturnType<typeof harness>>;
    beforeAll(async () => { h = await harness(); });
    afterEach(async () => { try { await h?.releaseActivation(); } finally { vi.unstubAllGlobals(); } });
    afterAll(async () => { await h?.close(); });

    it('uses real Run scope and rejects master control authority', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(oauthResponse()).mockResolvedValueOnce(oauthResponse('access-next')));
        await h.activate();
        expect((await h.post(h.request, 'master')).statusCode).toBe(401);
        const response = await h.post();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, result: { status: 'refreshed', result: {
            credentialRevision: h.secondRevision,
        } } });
        expect(response.body).not.toContain('refresh-new');
        // Codex adopts this returned revision and sends it for its next distinct attempt.
        // The unchanged registry environment is a launch projection, not credential authority.
        const next = await h.post({ ...h.request, refreshAttemptId: `${h.request.refreshAttemptId}-next`, expectedCredentialRevision: h.secondRevision });
        expect(next.json()).toEqual({ ok: true, result: { status: 'refreshed', result: {
            credentialRevision: h.thirdRevision,
        } } });
        expect(next.body).not.toContain('refresh-new');
    });

    it('rejects stale activation, wrong runner, mismatched member/revision and unknown authority fields', async () => {
        const fetch = vi.fn(async () => oauthResponse());
        vi.stubGlobal('fetch', fetch);
        await h.activate();
        for (const patch of [
            { activationId: '00000000-0000-4000-8000-000000000000' }, { runnerPid: h.request.runnerPid + 1 },
            { selection: { ...h.request.selection, activeProfileId: 'other' } }, { selection: { ...h.request.selection, generation: h.request.selection.kind === 'group' ? h.request.selection.generation + 1 : 0 } },
            { expectedCredentialRevision: h.request.expectedCredentialRevision === h.thirdRevision ? h.firstRevision : h.thirdRevision }, { serviceId: 'claude-subscription' },
        ]) {
            const response = await h.post({ ...h.request, ...patch });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        }
        expect((await h.post({ ...h.request, sessionId: 'invented-session' })).statusCode).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('retains the settlements of distinct concurrent attempt IDs for the same exact Run', async () => {
        let started!: () => void;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (response: Response) => void;
        const providerResponse = new Promise<Response>((resolve) => { settle = resolve; });
        const fetch = vi.fn(() => { started(); return providerResponse; });
        vi.stubGlobal('fetch', fetch);
        await h.activate();
        const firstRequest = { ...h.request, refreshAttemptId: h.request.refreshAttemptId + '-first' };
        const secondRequest = { ...h.request, refreshAttemptId: h.request.refreshAttemptId + '-second' };
        const first = h.post(firstRequest);
        await entered;
        const second = h.post(secondRequest);
        settle(oauthResponse('concurrent-access'));
        const [firstReply, secondReply] = await Promise.all([first, second]);
        expect(firstReply.json()).toMatchObject({ result: { status: 'refreshed' } });
        expect(secondReply.json()).toEqual(firstReply.json());
        expect((await h.post(firstRequest)).json()).toEqual(firstReply.json());
        expect((await h.post(secondRequest)).json()).toEqual(secondReply.json());
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(await readFile(join(h.nativeHome, 'auth.json'), 'utf8')))
            .toMatchObject({ tokens: { access_token: 'concurrent-access', refresh_token: '' } });
    });

    it('does not rematerialize or disclose provider material after another credential writer wins the CAS', async () => {
        let started!: () => void;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (response: Response) => void;
        const providerResponse = new Promise<Response>((resolve) => { settle = resolve; });
        vi.stubGlobal('fetch', vi.fn(() => { started(); return providerResponse; }));
        await h.activate();
        const before = await readFile(join(h.nativeHome, 'auth.json'), 'utf8');
        const pending = h.post();
        await entered;
        const current = await h.readCredential();
        await h.mutateCredential({ token: 'happier-token', mutation: { ref: h.account, authenticationModeId: 'oauth',
            expectedCredentialRevision: current.credentialRevision, expectedConfigurationRevision: null,
            content: current.content, metadata: current.metadata } });
        settle(oauthResponse('losing-private-access'));
        const response = await pending;
        expect(response.json().result.status).not.toBe('refreshed');
        expect(response.body).not.toContain('losing-private-access');
        await expect(readFile(join(h.nativeHome, 'auth.json'), 'utf8')).resolves.toBe(before);
    });

    // Contribution shutdown is terminal for the suite-owned real singleton and runs last.
    it.each(['runner', 'release', 'group', 'contribution'] as const)('refuses credentials after %s authority is retired while refresh is pending', async (retirement) => {
        let started!: () => void;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (result: Response) => void;
        vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>((resolve) => { settle = resolve; }); }));
        await h.activate();
        try {
            const responsePromise = h.post();
            await entered;
            if (retirement === 'runner') h.retireRunner();
            if (retirement === 'contribution') h.retireContribution();
            if (retirement === 'release') await h.bridge.release(h.request);
            if (retirement === 'group') h.switchGroupAccount('backup');
            settle(oauthResponse());
            const response = await responsePromise;
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
            expect(response.body).not.toContain('access-new');
            if (retirement === 'group') expect((await h.post()).json()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        } finally { settle?.(oauthResponse()); }
    });
});
