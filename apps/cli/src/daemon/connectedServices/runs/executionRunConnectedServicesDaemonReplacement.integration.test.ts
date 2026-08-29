import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

/**
 * Daemon control-owner replacement harness for active execution-run Connected Services.
 *
 * Proves, over REAL HTTP control servers, REAL marker files, a REAL materialized
 * root, and the LIVE Vitest runner process that owns the marker, that the A→B corridor holds:
 * the runner's scoped capability token rotates with the daemon control token
 * (stale refusal), the surviving runner re-attests its carried registration to
 * the replacement daemon through the canonical re-attestation and adoption
 * owners (current acceptance), and the terminal cleanup receipt releases the
 * materialized root exactly once (exact custody).
 *
 * Only the credential-materialization boundary (the refresh/API-backed spawn-auth
 * resolver) and daemon-local session-tracking map are boundary stand-ins. Ownership,
 * custody, liveness, and cleanup decisions run through their production owners.
 */

type LoadedModules = Awaited<ReturnType<typeof loadExecutionRunReplacementOwners>>;

const RUN_ID = 'run_44444444-4444-4444-8444-444444444444';
const RUNNER_SESSION_ID = 'sess-execution-run-replacement';
const CREDENTIAL_REVISION = 'csr_0123456789ABCDEFGHJKMNPQRS';
const PROFILE_ID = 'team';
const SERVICE_KEY = 'happier.agent.codex/openai-codex';
const RUN_BINDINGS = {
    v: 1,
    bindingsByServiceId: {
        [SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: PROFILE_ID },
    },
} as const;

const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalPublicReleaseChannel = process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
const originalReleaseRing = process.env.HAPPIER_RELEASE_RING;
const originalReleaseChannel = process.env.HAPPIER_RELEASE_CHANNEL;

let happyHomeDir: string | null = null;
let materializationBaseDir: string | null = null;
let runningDaemons: Array<{ app: unknown; close(): Promise<void> }> = [];

async function assertPathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function removeTempRoots(): Promise<void> {
    const roots = [happyHomeDir, materializationBaseDir].filter(
        (root): root is string => typeof root === 'string',
    );
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
    happyHomeDir = null;
    materializationBaseDir = null;
}

afterEach(async () => {
    await Promise.all(runningDaemons.map((daemon) => daemon.close().catch(() => undefined)));
    runningDaemons = [];
    await removeTempRoots();
    if (originalHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    if (originalPublicReleaseChannel === undefined) delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    else process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = originalPublicReleaseChannel;
    if (originalReleaseRing === undefined) delete process.env.HAPPIER_RELEASE_RING;
    else process.env.HAPPIER_RELEASE_RING = originalReleaseRing;
    if (originalReleaseChannel === undefined) delete process.env.HAPPIER_RELEASE_CHANNEL;
    else process.env.HAPPIER_RELEASE_CHANNEL = originalReleaseChannel;
});

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function loadExecutionRunReplacementOwners() {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-exec-run-replacement-home-'));
    materializationBaseDir = await mkdtemp(join(tmpdir(), 'happier-exec-run-replacement-materialized-'));
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    delete process.env.HAPPIER_RELEASE_RING;
    delete process.env.HAPPIER_RELEASE_CHANNEL;
    vi.resetModules();

    const markerOwner = await import('@/daemon/executionRunRegistry');
    const { createExecutionRunConnectedServicesBridge } = await import('./executionRunMaterialization');
    const { ExecutionRunConnectedServicesRegistrationV1Schema } = await import('./materializeContract');
    const { createAdoptedExecutionRunRootCleanup } = await import('./createAdoptedExecutionRunRootCleanup');
    const {
        reattestRunningExecutionRunConnectedServices,
        rehydrateLiveExecutionRunTargets,
    } = await import('./rehydrateExecutionRunTargets');
    const {
        deriveConnectedServiceRunMaterializeToken,
        isValidConnectedServiceRunMaterializeToken,
    } = await import('./capabilityToken');
    const { ConnectedServiceRuntimeRegistry } = await import('../runtimeRegistry/registry');
    const { resolveConnectedServiceMaterializedRootDir } = await import(
        '../materialize/resolveConnectedServiceMaterializedRootDir'
    );
    const { ensurePrivateConnectedServiceMaterializedRoot } = await import(
        '../materialize/privateMaterializedRoot'
    );
    const { createDaemonControlApp } = await import('../../controlServer');
    const { parseConnectedServiceProjectionSnapshot } = await import(
        '../accountGroups/generation/connectedServiceProjectionSnapshot'
    );
    const { isExecutionRunConnectedServiceGenerationCurrent } = await import('./executionRunGenerationAdmission');
    const { buildExecutionRunConnectedServicesCleanupReceipt } = await import(
        '@/agent/runtime/bridges/executionRun/connectedServicesCleanupReceipt'
    );
    const { writeExecutionRunActivityMarker } = await import(
        '@/agent/runtime/bridges/executionRun/activityMarkers'
    );
    const { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } = await import('../connectedServiceChildEnvironment');

    return {
        markerOwner,
        createExecutionRunConnectedServicesBridge,
        ExecutionRunConnectedServicesRegistrationV1Schema,
        createAdoptedExecutionRunRootCleanup,
        reattestRunningExecutionRunConnectedServices,
        rehydrateLiveExecutionRunTargets,
        deriveConnectedServiceRunMaterializeToken,
        isValidConnectedServiceRunMaterializeToken,
        ConnectedServiceRuntimeRegistry,
        resolveConnectedServiceMaterializedRootDir,
        ensurePrivateConnectedServiceMaterializedRoot,
        createDaemonControlApp,
        parseConnectedServiceProjectionSnapshot,
        isExecutionRunConnectedServiceGenerationCurrent,
        buildExecutionRunConnectedServicesCleanupReceipt,
        writeExecutionRunActivityMarker,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
    };
}

/**
 * Stands in for the daemon-local session-tracking map only. The tracked PID is this
 * real Vitest runner process—the same process whose marker owner writes process.pid.
 */
function createTrackedRunner() {
    const trackedRunnerByPid = new Map<number, Readonly<{ happySessionId: string }>>();
    const pid = process.pid;
    const tracked = Object.freeze({ happySessionId: RUNNER_SESSION_ID });
    trackedRunnerByPid.set(pid, tracked);

    const captureRunnerIdentity = (input: Readonly<{
        runnerPid: number;
        expectedParentSessionId?: string;
    }>) => {
        const found = trackedRunnerByPid.get(input.runnerPid);
        if (!found) return null;
        if (input.expectedParentSessionId !== undefined && found.happySessionId !== input.expectedParentSessionId) {
            return null;
        }
        return Object.freeze({
            identity: found,
            parentSessionId: found.happySessionId,
            isCurrent: () => trackedRunnerByPid.get(input.runnerPid) === found,
        });
    };
    const proveRunnerLive = async (marker: Readonly<{
        pid: number;
        happySessionId: string | null;
    }>): Promise<boolean> => {
        if (marker.happySessionId === null) return false;
        const found = trackedRunnerByPid.get(marker.pid);
        if (!found || found.happySessionId !== marker.happySessionId) return false;
        return isProcessAlive(marker.pid);
    };

    return {
        pid,
        markUntracked: () => {
            trackedRunnerByPid.delete(pid);
        },
        captureRunnerIdentity,
        proveRunnerLive,
    };
}

function startReplacementHarness(modules: LoadedModules, input: Readonly<{
    controlToken: string;
    runner: ReturnType<typeof createTrackedRunner>;
}>) {
    const baseDir = materializationBaseDir!;
    const registry = new modules.ConnectedServiceRuntimeRegistry();
    const purposeLeaseDisposals: string[] = [];
    const rootCleanupCalls: string[] = [];

    /**
     * Boundary stand-in for the credential-refresh/API-backed spawn-auth resolver.
     * It creates the REAL private materialized root and binds the run's child
     * selections to the projected credential revision, exactly the shape the real
     * resolution returns for a connected profile selection.
     */
    const resolveAuthForSpawn = async (spawnInput: Readonly<{
        materializationKey: string;
    }>) => {
        const runRoot = modules.resolveConnectedServiceMaterializedRootDir({
            baseDir,
            agentId: 'codex',
            materializationKey: spawnInput.materializationKey,
        });
        await modules.ensurePrivateConnectedServiceMaterializedRoot(runRoot);
        await writeFile(join(runRoot, 'credential-sentinel.json'), '{"materialized":true}\n', 'utf8');
        return {
            env: {
                CODEX_HOME: join(runRoot, 'home'),
                [modules.HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                    {
                        kind: 'profile',
                        serviceId: SERVICE_KEY,
                        profileId: PROFILE_ID,
                        credentialRevision: CREDENTIAL_REVISION,
                    },
                ]),
            },
            cleanupOnFailure: null,
            cleanupOnExit: null,
            connectedServicesBindings: RUN_BINDINGS,
            targetMaterializedRoot: runRoot,
        };
    };

    const bridge = modules.createExecutionRunConnectedServicesBridge({
        resolveAuthForSpawn: resolveAuthForSpawn as never,
        registerRunTargets: (registration) => {
            registry.registerRunTarget({
                runKey: registration.runKey,
                pid: registration.runnerPid,
                materializationKey: registration.materializationKey,
                agentId: registration.agentId,
                connectedServicesBindingsRaw: registration.connectedServicesBindingsRaw,
                connectedServiceSelectionsEnv: registration.connectedServiceSelectionsEnv,
                sessionId: registration.sessionId,
                sessionDirectory: registration.sessionDirectory,
            });
        },
        unregisterRunTargets: (runKey) => {
            registry.unregisterRunKey(runKey);
        },
        resolveRunMaterializedRoot: ({ runKey, agentId }) => modules.resolveConnectedServiceMaterializedRootDir({
            baseDir,
            agentId,
            materializationKey: runKey,
        }),
        createAdoptedRootCleanup: ({ runKey, agentId, materializedRoot }) =>
            modules.createAdoptedExecutionRunRootCleanup({
                materializationBaseDir: baseDir,
                materializationKey: runKey,
                agentId,
                materializedRoot,
                removeRoot: async (root) => {
                    rootCleanupCalls.push(root);
                    await rm(root, { recursive: true, force: true });
                },
            }),
        captureRunnerIdentity: input.runner.captureRunnerIdentity,
        acquireAgentPurposeContributions: async () => ({
            contributions: {
                agentDefinitionsById: new Map([['codex', {
                    identity: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    richDefinition: {
                        definition: {
                            connectedAccounts: [{
                                purpose: 'primary',
                                service: 'openai-codex',
                                materializationKinds: ['httpHeaders'],
                            }],
                        },
                    },
                }]]),
            },
            resolveAgentContributionIdentity: async () => Object.freeze({
                pluginId: 'happier.agent.codex',
                localId: 'codex',
                immutableGenerationId: 'gen-1',
            }),
            isCurrent: () => true,
            release: async () => undefined,
        }),
        purposeBindingOwner: {
            activatePurposeBindings: (activation: Readonly<{
                subject: Readonly<{ isCurrent(): boolean }>;
            }>) => ({
                subjectId: 'execution-run-harness',
                isCurrent: () => activation.subject.isCurrent(),
                resolvePurposeBinding: () => null,
                listPurposeBindings: () => [],
                dispose: () => {
                    purposeLeaseDisposals.push('disposed');
                },
            }),
        } as never,
        requestAuthRegistry: {
            activate: (async () => {
                throw new Error('harness run carries no request-auth uses');
            }) as never,
            retire: (async () => undefined) as never,
        } as never,
        resolveRequestAuthHttpPort: () => 0,
        createRedactionLease: () => ({
            add: () => undefined,
            close: () => undefined,
        }),
        clearTerminalCleanupReceipt: modules.markerOwner.clearExecutionRunConnectedServicesCleanupReceipt,
    });

    const projection = modules.parseConnectedServiceProjectionSnapshot({
        connectedServicesV2: [{
            serviceId: 'openai-codex',
            profiles: [{ profileId: PROFILE_ID, status: 'connected' }],
            groups: [],
        }],
        connectedServiceCredentialRevisionsV1: [{
            serviceId: 'openai-codex',
            profileId: PROFILE_ID,
            credentialRevision: CREDENTIAL_REVISION,
        }],
    });

    const app = modules.createDaemonControlApp({
        getChildren: () => [],
        machineId: 'execution-run-replacement-harness',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
            type: 'error' as const,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'unused',
        }),
        requestShutdown: () => undefined,
        onHappySessionWebhook: () => undefined,
        controlToken: input.controlToken,
        verifyRunMaterializeToken: (provided: string) =>
            modules.isValidConnectedServiceRunMaterializeToken(provided, input.controlToken),
        materializeConnectedServicesForExecutionRun: bridge.materialize,
        checkConnectedServicesGenerationForExecutionRun: async ({
            runId,
            runnerPid,
            registration,
        }) => {
            let target = registry.getRunTargetByRunKey(runId);
            if (!target && registration) {
                await modules.reattestRunningExecutionRunConnectedServices({
                    markers: modules.markerOwner.listExecutionRunMarkersForRehydration,
                    runId,
                    runnerPid,
                    registration,
                    adopt: bridge.adoptLiveMaterialization,
                    proveRunnerLive: input.runner.proveRunnerLive,
                }).catch(() => false);
                target = registry.getRunTargetByRunKey(runId);
            }
            if (!target || target.pid !== runnerPid || target.materializationKey !== runId) {
                return { ok: true as const, current: false };
            }
            return {
                ok: true as const,
                current: modules.isExecutionRunConnectedServiceGenerationCurrent({
                    runId,
                    target,
                    projection,
                }),
            };
        },
        releaseConnectedServicesForExecutionRun: bridge.release,
    });

    const started = app.listen({ host: '127.0.0.1', port: 0 }).then(() => {
        const address = app.server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected daemon control server TCP address');
        }
        return address.port;
    });
    runningDaemons.push({ app, close: () => app.close() });

    const postAsRunner = async (path: string, body: unknown, authToken: string) => {
        const port = await started;
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-happier-daemon-token': authToken,
            },
            body: JSON.stringify(body),
        });
        return {
            status: response.status,
            body: await response.json().catch(() => null) as unknown,
        };
    };

    return {
        app,
        port: started,
        registry,
        bridge,
        purposeLeaseDisposals,
        rootCleanupCalls,
        postAsRunner,
        scopedToken: () => modules.deriveConnectedServiceRunMaterializeToken(input.controlToken),
    };
}

describe('execution-run Connected Services across daemon control-owner replacement', () => {
    it('refuses the stale scoped capability, re-attests the surviving runner on the replacement daemon, and keeps terminal cleanup custody exact', async () => {
        const modules = await loadExecutionRunReplacementOwners();
        const runner = createTrackedRunner();
        const runRoot = modules.resolveConnectedServiceMaterializedRootDir({
            baseDir: materializationBaseDir!,
            agentId: 'codex',
            materializationKey: RUN_ID,
        });

        const daemonA = startReplacementHarness(modules, { controlToken: 'replacement-control-token-a', runner });

        // 1. The runner materializes its run-scoped Connected Services authority on daemon A.
        const materialize = await daemonA.postAsRunner('/connected-service-run/materialize', {
            runId: RUN_ID,
            runnerPid: runner.pid,
            agentId: 'codex',
            connectedServices: RUN_BINDINGS,
            cwd: '/tmp/project',
        }, daemonA.scopedToken());
        expect(materialize.status).toBe(200);
        const materializeBody = materialize.body as {
            ok: boolean;
            result?: {
                activationId: string;
                registration: Record<string, unknown>;
            };
        };
        expect(materializeBody.ok).toBe(true);
        if (!materializeBody.result) throw new Error('Expected successful materialization result');
        const activationId = materializeBody.result.activationId;
        const registration = modules.ExecutionRunConnectedServicesRegistrationV1Schema.parse(
            materializeBody.result.registration,
        );
        expect(registration).toMatchObject({
            v: 1,
            runKey: RUN_ID,
            materializationKey: RUN_ID,
            agentId: 'codex',
            materializedRoot: runRoot,
            agentContribution: {
                pluginId: 'happier.agent.codex',
                localId: 'codex',
                immutableGenerationId: 'gen-1',
            },
        });
        expect(await assertPathExists(runRoot)).toBe(true);

        // 2. The runner writes its activity marker through the real marker owner; the
        //    launch registration stays runner-carried and only the cleanup receipt persists.
        const runState = {
            runId: RUN_ID,
            callId: 'call_replacement',
            sidechainId: 'side_replacement',
            sessionId: RUNNER_SESSION_ID,
            depth: 0,
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            backendId: 'codex',
            instructions: 'review',
            permissionMode: 'default',
            retentionPolicy: 'resumable',
            runClass: 'bounded',
            ioMode: 'request_response',
            launch: { connectedServicesRegistration: registration },
            status: 'running',
            startedAtMs: Date.now(),
        } satisfies ExecutionRunState;
        await modules.writeExecutionRunActivityMarker({
            runId: RUN_ID,
            nowMs: Date.now(),
            opts: { force: true },
            runs: new Map([[RUN_ID, runState]]),
            controllers: new Map(),
            enqueueMarkerWrite: async (_runId: string, write: () => Promise<void>) => {
                await write();
            },
        });
        const persistedMarkers = await modules.markerOwner.listExecutionRunMarkersForRehydration();
        expect(persistedMarkers).toHaveLength(1);
        expect(persistedMarkers[0]).toMatchObject({
            runId: RUN_ID,
            pid: runner.pid,
            happySessionId: RUNNER_SESSION_ID,
            status: 'running',
        });
        expect(persistedMarkers[0]?.executionRunConnectedServicesCleanupReceiptV1).toMatchObject({
            v: 1,
            runKey: RUN_ID,
            activationId,
            agentId: 'codex',
        });
        expect(persistedMarkers[0]).not.toHaveProperty('executionRunConnectedServicesLaunchV1');

        // 3. Daemon A reports the run generation current.
        await expect(daemonA.postAsRunner('/connected-service-run/generation-current', {
            runId: RUN_ID,
            runnerPid: runner.pid,
        }, daemonA.scopedToken())).resolves.toMatchObject({ status: 200, body: { ok: true, current: true } });

        // 4. Daemon A → B replacement: A's custody map dies with its process; B starts
        //    with a fresh control token, fresh registry, and the same real marker dir.
        await daemonA.app.close();
        runningDaemons = runningDaemons.filter((daemon) => daemon.app !== daemonA.app);
        const daemonB = startReplacementHarness(modules, { controlToken: 'replacement-control-token-b', runner });
        expect(daemonB.registry.getRunTargetByRunKey(RUN_ID)).toBeNull();

        // 5. Stale capability refusal: the token derived from A's control token must not
        //    authorize any scoped run endpoint on B.
        const staleToken = modules.deriveConnectedServiceRunMaterializeToken('replacement-control-token-a');
        expect(staleToken).not.toBe(daemonB.scopedToken());
        await expect(daemonB.postAsRunner('/connected-service-run/materialize', {
            runId: RUN_ID,
            runnerPid: runner.pid,
            agentId: 'codex',
            connectedServices: RUN_BINDINGS,
            cwd: '/tmp/project',
        }, staleToken)).resolves.toMatchObject({ status: 401 });
        await expect(daemonB.postAsRunner('/connected-service-run/generation-current', {
            runId: RUN_ID,
            runnerPid: runner.pid,
        }, staleToken)).resolves.toMatchObject({ status: 401 });
        await expect(daemonB.postAsRunner('/connected-service-run/release', {
            runId: RUN_ID,
            runnerPid: runner.pid,
            activationId,
        }, staleToken)).resolves.toMatchObject({ status: 401 });
        expect(daemonB.registry.getRunTargetByRunKey(RUN_ID)).toBeNull();
        expect(await assertPathExists(runRoot)).toBe(true);

        // 6. The surviving runner re-attests over its reconnect: the current scoped token
        //    is accepted and daemon B re-attests the carried registration against the real
        //    marker + live runner, then admits the run through the real adoption owner.
        await expect(daemonB.postAsRunner('/connected-service-run/generation-current', {
            runId: RUN_ID,
            runnerPid: runner.pid,
            registration,
        }, daemonB.scopedToken())).resolves.toMatchObject({ status: 200, body: { ok: true, current: true } });
        const adoptedTarget = daemonB.registry.getRunTargetByRunKey(RUN_ID);
        expect(adoptedTarget).toMatchObject({
            pid: runner.pid,
            materializationKey: RUN_ID,
        });

        // 7. Exact terminal cleanup: the run becomes terminal, its marker receipt joins the
        //    replacement daemon's custody, and the real rehydration owner releases the
        //    materialized root exactly once.
        const terminalReceipt = modules.buildExecutionRunConnectedServicesCleanupReceipt(
            registration as never,
        );
        expect(terminalReceipt).not.toBeNull();
        await modules.markerOwner.writeExecutionRunMarker({
            pid: runner.pid,
            happySessionId: RUNNER_SESSION_ID,
            runId: RUN_ID,
            callId: 'call_replacement',
            sidechainId: 'side_replacement',
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'default',
            runClass: 'bounded',
            ioMode: 'request_response',
            retentionPolicy: 'resumable',
            status: 'succeeded',
            startedAtMs: Date.now(),
            updatedAtMs: Date.now(),
            finishedAtMs: Date.now(),
            executionRunConnectedServicesCleanupReceiptV1: terminalReceipt!,
        });
        const firstPass = await modules.rehydrateLiveExecutionRunTargets({
            markers: modules.markerOwner.listExecutionRunMarkersForRehydration,
            adopt: daemonB.bridge.adoptLiveMaterialization,
            cleanupTerminal: daemonB.bridge.cleanupTerminalMaterialization,
            clearTerminalCleanupReceipt: modules.markerOwner.clearExecutionRunConnectedServicesCleanupReceipt,
            proveRunnerLive: runner.proveRunnerLive,
        });
        expect(firstPass.registeredRunIds).toEqual([]);
        expect(firstPass.inactiveRunIds).toEqual([RUN_ID]);
        expect(await assertPathExists(runRoot)).toBe(false);
        expect(daemonB.registry.getRunTargetByRunKey(RUN_ID)).toBeNull();
        const markersAfterCleanup = await modules.markerOwner.listExecutionRunMarkersForRehydration();
        expect(markersAfterCleanup).toHaveLength(1);
        expect(markersAfterCleanup[0]).not.toHaveProperty('executionRunConnectedServicesCleanupReceiptV1');
        expect(daemonB.purposeLeaseDisposals).toEqual(['disposed']);
        expect(daemonB.rootCleanupCalls).toEqual([runRoot]);

        // 8. Custody is drained exactly once: a second rehydration pass is a bounded no-op
        //    and a late release cannot double-release.
        const secondPass = await modules.rehydrateLiveExecutionRunTargets({
            markers: modules.markerOwner.listExecutionRunMarkersForRehydration,
            adopt: daemonB.bridge.adoptLiveMaterialization,
            cleanupTerminal: daemonB.bridge.cleanupTerminalMaterialization,
            clearTerminalCleanupReceipt: modules.markerOwner.clearExecutionRunConnectedServicesCleanupReceipt,
            proveRunnerLive: runner.proveRunnerLive,
        });
        expect(secondPass.inactiveRunIds).toEqual([RUN_ID]);
        expect(await assertPathExists(runRoot)).toBe(false);
        expect(daemonB.rootCleanupCalls).toEqual([runRoot]);
        await expect(daemonB.bridge.release({
            runId: RUN_ID,
            runnerPid: runner.pid,
            activationId,
        })).resolves.toEqual({ ok: true, released: false });
    });

    it('does not re-attest authority for a runner whose liveness cannot be proven after replacement', async () => {
        const modules = await loadExecutionRunReplacementOwners();
        const runner = createTrackedRunner();

        const daemonA = startReplacementHarness(modules, { controlToken: 'replacement-control-token-a2', runner });
        const materialize = await daemonA.postAsRunner('/connected-service-run/materialize', {
            runId: RUN_ID,
            runnerPid: runner.pid,
            agentId: 'codex',
            connectedServices: RUN_BINDINGS,
            cwd: '/tmp/project',
        }, daemonA.scopedToken());
        expect(materialize.status).toBe(200);
        const registrationRaw = (materialize.body as {
            result?: { registration: Record<string, unknown> };
        }).result?.registration;
        expect(registrationRaw).toBeDefined();
        const registration = modules.ExecutionRunConnectedServicesRegistrationV1Schema.parse(registrationRaw);
        const cleanupReceipt =
            modules.buildExecutionRunConnectedServicesCleanupReceipt(registration as never);
        if (!cleanupReceipt) throw new Error('Expected a cleanup receipt');

        // Everything the re-attestation join requires persists on disk: running marker,
        // matching pid, matching cleanup receipt. Only runner liveness will be missing.
        await modules.markerOwner.writeExecutionRunMarker({
            pid: runner.pid,
            happySessionId: RUNNER_SESSION_ID,
            runId: RUN_ID,
            callId: 'call_replacement_liveness',
            sidechainId: 'side_replacement_liveness',
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'default',
            runClass: 'bounded',
            ioMode: 'request_response',
            retentionPolicy: 'resumable',
            status: 'running',
            startedAtMs: Date.now(),
            updatedAtMs: Date.now(),
            executionRunConnectedServicesCleanupReceiptV1: cleanupReceipt,
        });

        // The replacement daemon cannot prove this still-live process belongs to the
        // marker's Session once its daemon-local tracking identity is absent.
        runner.markUntracked();

        await daemonA.app.close();
        runningDaemons = runningDaemons.filter((daemon) => daemon.app !== daemonA.app);
        const daemonB = startReplacementHarness(modules, { controlToken: 'replacement-control-token-b2', runner });

        await expect(daemonB.postAsRunner('/connected-service-run/generation-current', {
            runId: RUN_ID,
            runnerPid: runner.pid,
            registration,
        }, daemonB.scopedToken())).resolves.toMatchObject({ status: 200, body: { ok: true, current: false } });
        expect(daemonB.registry.getRunTargetByRunKey(RUN_ID)).toBeNull();
    });
});
