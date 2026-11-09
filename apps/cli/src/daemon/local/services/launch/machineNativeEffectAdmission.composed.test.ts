import { describe, expect, it } from 'vitest';
import { createMachineNativeEffectAdmission, machineNativeEffectAdmission, type MachineNativeEffectContext, type MachineNativeEffectKey } from './machineNativeEffectAdmission';
import { applyMachineSetup } from '@/machines/setup/applyMachineSetup';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtyProvider } from '@/terminal/pty/provider';
import { assertNativeComposeAvailable } from './nativeComposeLifecycle';
import { MachineSetupV1Schema } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnServerDeploymentRequest, OwnServerDeploymentResult } from '@/deployments/targets/ownServer/ownServerDeploymentTarget';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

it('keeps native key admission at run rather than repeating it in admitted callees', async () => {
    const callees = await Promise.all([
        readFile(new URL('../../../agentIsolation/agentIsolationProvisioner.ts', import.meta.url), 'utf8'),
        readFile(new URL('../../../../storage/dockerPrune.ts', import.meta.url), 'utf8'),
    ]);
    expect(callees.flatMap(source => [...source.matchAll(/machineNativeEffectAdmission\.assertContext\(/g)])).toHaveLength(0);
});

async function waitForSetupSpawn(started: Promise<void>, pending: Promise<unknown>): Promise<void> {
    await Promise.race([started, pending.then(result => {
        const code = result && typeof result === 'object' && 'errorCode' in result
            && typeof result.errorCode === 'string' ? result.errorCode : 'unexpected_settlement';
        throw new Error(`Setup settled before native spawn: ${code}`);
    })]);
}

const project = (projectName: string): MachineNativeEffectKey => ({ kind: 'composeProject', dockerEndpoint: 'engine', projectName });

// Only the OS PTY/process-tree boundary is substituted; the setup/terminal owners are real.
class NativeSetupProcess implements PtyProcess {
    readonly pid = 23456;
    readonly ownedProcessGroupId = 23456;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    write() { throw new Error('not interactive'); }
    resize() {}
    kill() {}
    onData() { return { dispose() {} }; }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
    exit() { for (const listener of this.exits) listener({ exitCode: 0, signal: 0 }); }
}

function setupFixture() {
    const started = deferred();
    const processes: NativeSetupProcess[] = [];
    const provider: PtyProvider = { spawn() {
        const process = new NativeSetupProcess();
        processes.push(process);
        if (processes.length === 1) started.resolve();
        else queueMicrotask(() => process.exit());
        return process;
    } };
    const terminalSessions = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/sh' },
        probeProcessGroup: () => 'absent', stopProcessTree: async () => {},
        config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000, 
            urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
    const controller = new AbortController();
    const input = {
        homeId: 'home', machineId: 'machine', preset: { id: 'preset', revision: 1 }, requesterAccountId: 'person',
        userHomeDirectory: '/tmp', setup: { scripts: [{ body: 'portable-setup', affects: 'none' as const }],  }, terminalSessions,
        hostEnvironment: { SHELL: '/bin/sh', PATH: '/bin' }, platform: 'linux' as const,
        environmentIo: { resolveTool: async () => null, run: async () => ({ exitCode: 0, stdout: '{"ID":"engine"}\n' }) },
        operation: { actionRequestId: 'setup-first', signal: controller.signal,
            operationOwnerUpdate: { update() {} }, operationProgress: { update() {} } },
        isCurrent: async () => true,
    };
    return { input, started, processes, controller, terminalSessions };
}

describe('Machine native effect admission', () => {
    it('borrows the original masking only for its active engine and retires without retaining the lease or probing cold engines', async () => {
        const owner = createMachineNativeEffectAdmission();
        const lease = createProviderRedactionLease({ values: ['launch-secret'] });
        const entered = deferred(), finish = deferred(), settling = deferred(), settled = deferred();
        const target = { projectName: 'masking', sourcePath: '/release', composeService: 'web', containerIds: ['container'] };
        let engineReads = 0;
        const readEngine = async () => { engineReads++; return 'engine'; };
        expect(await owner.readComposeLogMasking(target, readEngine)).toBeUndefined();
        expect(engineReads).toBe(0);
        const running = owner.run({ operation: { operationId: 'masking', kind: 'deploy' }, keys: [project('masking')],
            async settleNative() { settling.resolve(); await settled.promise; } }, async context => {
            owner.lendComposeLogMasking(context, () => ({ lease, complete: true }));
            entered.resolve(); await finish.promise;
        });
        try {
            await entered.promise;
            expect((await owner.readComposeLogMasking(target, readEngine))?.lease).toBe(lease);
            expect(engineReads).toBe(1);
            expect(await owner.readComposeLogMasking(target, async () => 'another-engine')).toBeUndefined();
            finish.resolve(); await settling.promise;
            expect((await owner.readComposeLogMasking(target, readEngine))?.lease).toBe(lease);
            settled.resolve(); await running;
            const readsAtRetirement = engineReads;
            expect(await owner.readComposeLogMasking(target, readEngine)).toBeUndefined();
            expect(engineReads).toBe(readsAtRetirement);
            // Borrowing and retirement never retain, close or replace the lease.
            expect(lease.isActive()).toBe(true);
            expect(lease.redact('launch-secret')).toBe('[REDACTED]');
        } finally { finish.resolve(); settled.resolve(); await running; lease.close(); }
    });

    it('retains uncertain command cleanup until exact operation proof and keeps neighboring unknown custody', async () => {
        const admission = createMachineNativeEffectAdmission();
        let releasedA = 0, releasedB = 0;
        for (const name of ['A', 'B']) await admission.run({ operation: { operationId: name, kind: 'service-exec' },
            keys: [project(name)] }, async context => {
            admission.markUnsettled(context, { releaseAfterNativeSettlement() { if (name === 'A') releasedA++; else releasedB++; } });
        });
        await admission.reconcileUnknown({ keys: [{ kind: 'dockerEngine', dockerEndpoint: 'engine' }],
            observeSettled: async operation => operation.operationId === 'A' });
        expect([releasedA, releasedB]).toEqual([1, 0]);
        await admission.run({ operation: { operationId: 'new-A', kind: 'service-exec' }, keys: [project('A')] }, async () => {});
        await expect(admission.run({ operation: { operationId: 'new-B', kind: 'service-exec' }, keys: [project('B')] }, async () => {}))
            .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'B' });
        await admission.reconcileUnknown({ keys: [project('B')], observeSettled: async operation => operation.operationId === 'B' });
        expect([releasedA, releasedB]).toEqual([1, 1]);
    });

    it('reconciles producer-owned native observations before fresh affected work without replaying or retiring unrelated unknown custody', async () => {
        const owner = createMachineNativeEffectAdmission();
        const engine = [{ kind: 'dockerEngine' as const, dockerEndpoint: 'prune-engine' }];
        const other = [{ kind: 'dockerEngine' as const, dockerEndpoint: 'unrelated-engine' }];
        let nativeSettled = false, oldEffects = 0, freshEffects = 0, cleanups = 0, unrelatedCleanups = 0;
        let cleanupSettled = false;
        await owner.run({ operation: { operationId: 'lost-prune', kind: 'storageDockerPrune' }, keys: engine }, async context => {
            oldEffects++;
            // This producer-owned callback represents fresh native observation,
            // not an admission mock or a Home receipt acknowledgement. A
            // variable keeps the new optional hook runtime-RED/type-compatible.
            const settlement = {
                observeNativeSettlement: async () => nativeSettled,
                async releaseAfterNativeSettlement() { cleanups++; await Promise.resolve(); cleanupSettled = true; },
            };
            owner.markUnsettled(context, settlement);
        });
        await owner.run({ operation: { operationId: 'unrelated-unknown', kind: 'service-exec' }, keys: other }, async context => {
            owner.markUnsettled(context, { releaseAfterNativeSettlement() { unrelatedCleanups++; } });
        });
        const fresh = () => owner.run({ operation: { operationId: 'fresh-prune', kind: 'storageDockerPrune' }, keys: engine }, async () => {
            expect(cleanupSettled).toBe(true);
            freshEffects++;
        });
        await expect(fresh()).rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'lost-prune' });
        expect([oldEffects, freshEffects, cleanups, unrelatedCleanups]).toEqual([1, 0, 0, 0]);
        nativeSettled = true;
        await expect(fresh()).resolves.toBeUndefined();
        await expect(fresh()).resolves.toBeUndefined();
        expect([oldEffects, freshEffects, cleanups, unrelatedCleanups]).toEqual([1, 2, 1, 0]);
        await expect(owner.run({ operation: { operationId: 'new-unrelated', kind: 'fixture' }, keys: other }, async () => {}))
            .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'unrelated-unknown' });
    });

    it('does not free unknown native custody when the fresh producer settlement probe is aborted', async () => {
        const owner = createMachineNativeEffectAdmission();
        const keys = [{ kind: 'dockerEngine' as const, dockerEndpoint: 'abort-prune-engine' }];
        const entered = deferred(), observed = deferred();
        const controller = new AbortController();
        let nativeSettled = true, oldEffects = 0, newEffects = 0, cleanups = 0, probes = 0;
        await owner.run({ operation: { operationId: 'unknown-prune', kind: 'storageDockerPrune' }, keys }, async context => {
            oldEffects++;
            const settlement = {
                async observeNativeSettlement(signal?: AbortSignal) {
                    if (probes++ === 0) expect(signal).toBe(controller.signal);
                    entered.resolve();
                    await observed.promise;
                    signal?.throwIfAborted();
                    return nativeSettled;
                },
                releaseAfterNativeSettlement() { cleanups++; },
            };
            owner.markUnsettled(context, settlement);
        });
        const fresh = owner.run({ operation: { operationId: 'canceled-fresh-prune', kind: 'storageDockerPrune', signal: controller.signal }, keys },
            async () => { newEffects++; });
        const result = fresh.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        try {
            // An ignored hook settles the attempted run immediately. Do not
            // leave a future callback gate hanging merely to demonstrate RED.
            expect(await Promise.race([entered.promise.then(() => true), result.then(() => false)])).toBe(true);
            controller.abort();
            observed.resolve();
            expect(await result).toMatchObject({ ok: false, error: { name: 'AbortError' } });
            expect([oldEffects, newEffects, cleanups]).toEqual([1, 0, 0]);
        } finally { observed.resolve(); }
        nativeSettled = false;
        await expect(owner.run({ operation: { operationId: 'still-unconfirmed', kind: 'fixture' }, keys }, async () => { newEffects++; }))
            .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'unknown-prune' });
        expect([oldEffects, newEffects, cleanups]).toEqual([1, 0, 0]);
    });

    it('holds unknown custody through original finalization and keeps concurrent retries busy until cleanup settles', async () => {
        const owner = createMachineNativeEffectAdmission();
        const keys = [{ kind: 'dockerEngine' as const, dockerEndpoint: 'finalizing-prune-engine' }];
        const originalFinalizing = deferred(), originalSettled = deferred();
        const cleanupEntered = deferred(), cleanupSettled = deferred(), freshEntered = deferred(), freshSettled = deferred();
        let observations = 0, cleanups = 0, freshEffects = 0;
        const original = owner.run({ operation: { operationId: 'finalizing-prune', kind: 'storageDockerPrune' }, keys,
            async settleNative() { originalFinalizing.resolve(); await originalSettled.promise; } }, async context => {
            const settlement = {
                async observeNativeSettlement() { observations++; return true; },
                async releaseAfterNativeSettlement() { cleanups++; cleanupEntered.resolve(); await cleanupSettled.promise; },
            };
            owner.markUnsettled(context, settlement);
        });
        const attempt = (operationId: string) => owner.run({ operation: { operationId, kind: 'storageDockerPrune' }, keys,
        }, async () => { freshEffects++; freshEntered.resolve(); await freshSettled.promise; })
            .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        let first: ReturnType<typeof attempt> | undefined;
        let competing: ReturnType<typeof attempt> | undefined;
        try {
            await originalFinalizing.promise;
            expect(await attempt('too-early')).toMatchObject({ ok: false, error: { code: 'effect_in_progress' } });
            expect([observations, cleanups, freshEffects]).toEqual([0, 0, 0]);
            originalSettled.resolve();
            await original;
            first = attempt('first-retry');
            expect(await Promise.race([cleanupEntered.promise.then(() => true), first.then(() => false)])).toBe(true);
            competing = attempt('competing-retry');
            let competingResult: Awaited<ReturnType<typeof attempt>> | undefined;
            void competing.then(result => { competingResult = result; });
            // Native cleanup is held at its real boundary; another retry must
            // keep the existing busy result rather than join that wait.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(competingResult).toMatchObject({ ok: false,
                error: { code: 'effect_in_progress', actionOperationId: 'finalizing-prune' } });
            expect([observations, cleanups, freshEffects]).toEqual([1, 1, 0]);
            cleanupSettled.resolve();
            expect(await Promise.race([freshEntered.promise.then(() => true), first.then(() => false)])).toBe(true);
            expect([observations, cleanups, freshEffects]).toEqual([1, 1, 1]);
        } finally {
            originalSettled.resolve(); cleanupSettled.resolve(); freshSettled.resolve();
            await Promise.all([original, first, competing]);
        }
    });

    it('admits reboot closure against every incumbent, including native callers without Docker coordinates', async () => {
        const admission = createMachineNativeEffectAdmission();
        const started = deferred(), settled = deferred();
        const incumbent = admission.run({ operation: { operationId: 'non-docker', kind: 'service-control' }, keys: [] }, async () => {
            started.resolve(); await settled.promise;
        });
        await started.promise;
        const reboot = { operation: { operationId: 'reboot', kind: 'reboot' }, keys: [], allNative: true as const };
        let competingEffects = 0;
        const competing = admission.run(reboot, async () => { competingEffects++; });
        try {
            await Promise.resolve();
            expect(competingEffects).toBe(0);
        } finally { settled.resolve(); await incumbent; await competing; }
        expect(competingEffects).toBe(1);
    });

    it('refuses keys-empty work under reboot closure, releases pre-dispatch failure and retains uncertain dispatch', async () => {
        const admission = createMachineNativeEffectAdmission();
        const reboot = { operation: { operationId: 'reboot', kind: 'reboot' }, keys: [], allNative: true as const };
        let competingEffects = 0;
        const compete = () => admission.run({ operation: { operationId: 'native-control', kind: 'service-control' }, keys: [] },
            async () => { competingEffects++; });
        const preDispatchFailure = new Error('pre-dispatch failure');
        await expect(admission.run(reboot, async context => {
            await expect(compete()).rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'reboot' });
            await admission.runStage(context, async () => {});
            expect(competingEffects).toBe(0);
            throw preDispatchFailure;
        })).rejects.toBe(preDispatchFailure);
        await compete();
        expect(competingEffects).toBe(1);
        await admission.run(reboot, async context => { admission.markUnsettled(context); });
        await expect(compete()).rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'reboot' });
        await expect(admission.run(reboot, async () => { competingEffects++; }))
            .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'reboot' });
        expect(competingEffects).toBe(1);
    });

    it('does not admit reboot while a keys-empty native outcome is still unknown', async () => {
        const admission = createMachineNativeEffectAdmission();
        await admission.run({ operation: { operationId: 'unknown-native', kind: 'service-control' }, keys: [] }, async context => {
            admission.markUnsettled(context);
        });
        const reboot = { operation: { operationId: 'reboot', kind: 'reboot' }, keys: [], allNative: true as const };
        let rebootEffects = 0;
        await expect(admission.run(reboot, async () => { rebootEffects++; }))
            .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'unknown-native' });
        expect(rebootEffects).toBe(0);
    });
    it('links the actual deployment executor to an incumbent setup before any competing Docker effect', async () => {
        const { DeploymentEnvironmentDetailV1Schema, DeploymentReceiptDetailV1Schema } = await import('@happier-dev/deployment-protocol');
        const { createOwnServerDeploymentTargetForHost } = await import('@/deployments/targets/ownServer/ownServerDeploymentTarget');
        const root = await mkdtemp(join(tmpdir(), 'happier-admission-deploy-'));
        const setup = setupFixture();
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        const services = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Environment observations have no managed-dependency lookup; fail closed if that changes.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
        let nativeEffects = 0;
        let nativeActivationStarted = false;
        const deploymentStarted = deferred();
        const deploymentExited = deferred();
        const nativeSettled = deferred();
        const deploymentController = new AbortController();
        let first: Promise<unknown> | undefined;
        let deploying: Promise<OwnServerDeploymentResult> | undefined;
        try {
            const repository = join(root, 'repository');
            await mkdir(repository);
            const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
            git(['init', '--quiet']); git(['config', 'user.name', 'Admission Fixture']); git(['config', 'user.email', 'admission@example.test']);
            // JSON is valid Compose YAML and keeps this boundary's constant
            // source readable through native --file input and include files.
            await writeFile(join(repository, 'compose.yaml'), JSON.stringify({ services: { web: { image: 'fixture:latest' } } }));
            git(['add', '.']); git(['commit', '--quiet', '-m', 'source']);
            const sha = git(['rev-parse', 'HEAD']);
            const imageConfig = JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} });
            const configHash = createHash('sha256').update(imageConfig).digest('hex');
            const artifact = { contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1 };
            const environment = DeploymentEnvironmentDetailV1Schema.parse({ environment: {
                v: 1, id: 'environment', serverId: 'home', projectSourceId: 'source', revision: 1,
                owner: { kind: 'account', accountId: 'person' }, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: 'machine', ...artifact, createdByAccountId: 'person', createdAtMs: 0, updatedAtMs: 0,
                capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true },
            }, content: { name: 'Production', retainPreviousDeployments: 0, bindings: [],
                definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['web'] } } },
            targetLinks: [{ targetLink: { v: 1, id: 'target', environmentId: 'environment', revision: 1, role: 'runtime',
                source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer', state: 'configured', machines: ['machine'],
                members: [{ machineId: 'machine', installationId: 'installation', state: 'active' }], ...artifact,
                createdByAccountId: 'person', createdAtMs: 0, updatedAtMs: 0 }, content: {} }] });
            let receipt = DeploymentReceiptDetailV1Schema.parse({ deployment: { v: 1, id: 'deployment', environmentId: 'environment',
                targetLinkId: 'target', revision: 1, operation: 'deploy', state: 'queued', requestKey: 'request', requestedByAccountId: 'person',
                actionOperationId: 'deployment-operation', requestedAtMs: 0,
                acceptedExecution: { v: 1,
                    controller: { machineId: 'machine', installationId: 'installation' },
                    builder: { machineId: 'machine', installationId: 'installation' } }, ...artifact },
            content: { sourceIntent: { kind: 'repository', projectSourceId: 'source', sourceRevision: 1, sha,
                compose: { path: 'compose.yaml', profiles: [], services: ['web'] } }, machines: ['machine'], buildMachineId: 'machine',
                onFailure: 'keepPartial', images: [{ service: 'web', platform: 'linux/amd64', configDigest: `sha256:${configHash}`,
                    manifestDigest: `sha256:${'b'.repeat(64)}` }], machineResults: [], steps: [] } });
            let receiptStateAtNativeStart: typeof receipt.deployment.state | undefined;
            const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy', input: { serverId: 'home', environmentId: 'environment',
                expectedRevision: 1, targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'request', ...artifact },
                receipt: { ok: true, environmentId: 'environment', revision: 1, deploymentId: 'deployment', deploymentRevision: 1, state: 'queued' },
                context: { signal: deploymentController.signal, operationAcceptance: { operationId: 'deployment-operation', accept() {} } } };
            const exec = createStablePluginExecService({
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => repository,
                systemTools: { async resolve() { return { executablePath: '/docker', launch: { executablePath: '/docker' } }; } } });
            const target = createOwnServerDeploymentTargetForHost({ credentials: { token: 'token', encryption: null }, serverId: 'home',
                serverHttpBaseUrl: 'https://home.example.test', machineId: 'machine',
                readEnvironment: async () => environment, readReceipt: async () => receipt,
                writeTransition: async transition => {
                    if (transition.state !== 'running' && deploymentController.signal.aborted)
                        throw Object.assign(new Error('Lost receipt acknowledgement'), { code: 'outcome_unknown' });
                    expect(transition.expectedRevision).toBe(receipt.deployment.revision);
                    receipt = DeploymentReceiptDetailV1Schema.parse({ ...receipt, content: transition.content,
                        deployment: { ...receipt.deployment, state: transition.state, revision: receipt.deployment.revision + 1 } });
                    return { ok: true, environmentId: receipt.deployment.environmentId, revision: environment.environment.revision,
                        deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
                },
                runtime: { async acquire(runtimeRequest) { return { exec, projectManagedServices: services,
                    source: { environmentId: 'environment', environmentInstanceId: 'environment', deploymentId: runtimeRequest.materialization.kind === 'review'
                        ? runtimeRequest.materialization.contentArtifactId : runtimeRequest.materialization.deploymentId, machineId: 'machine',
                        installationId: 'installation', sourcePath: repository, commitSha: sha, deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'artifacts') },
                    secrets: { installationPrivateSeed: new Uint8Array(32), grants: [] },
                    assertSourceCurrent: async () => {}, assertCurrent: async () => {},
                    // Before fake up enters there is no pending native process;
                    // an early refusal must settle so the activation race can report it.
                    settleNative: () => nativeActivationStarted ? nativeSettled.promise : Promise.resolve(), release: async () => {},
                    nativeIo: { resolveTool: async () => null, async run(input) {
                        if (input.args.includes('info')) return { exitCode: 0, stdout: '{"ID":"engine"}' };
                        if (input.args.includes('version')) return { exitCode: 0, stdout: input.args[0] === 'version' ? 'linux/amd64' : '29.9.0' };
                        if (input.args.includes('config')) {
                            // This source has no interpolation references. Read
                            // the actual producer's stdin/include projection;
                            // never return an include wrapper as native config.
                            if (input.args.includes('--variables')) return { exitCode: 0, stdout: '{}' };
                            const file = input.args[input.args.indexOf('--file') + 1];
                            if (!file || file === '-' && !input.stdin) throw new Error('Native config input is missing');
                            let model: unknown = JSON.parse(file === '-'
                                ? Buffer.from(input.stdin!).toString('utf8') : await readFile(file, 'utf8'));
                            if (model && typeof model === 'object' && 'include' in model) {
                                const include = model.include;
                                const selected: unknown = Array.isArray(include) && include.length === 1 ? include[0] : undefined;
                                if (!selected || typeof selected !== 'object' || !('path' in selected)
                                    || typeof selected.path !== 'string') throw new Error('Native include input is invalid');
                                model = JSON.parse(await readFile(selected.path, 'utf8'));
                            }
                            if (!model || typeof model !== 'object' || !('services' in model))
                                throw new Error('Native config model is invalid');
                            return { exitCode: 0, stdout: JSON.stringify(model) };
                        }
                        if (input.args[0] === 'image' && input.args[1] === 'inspect') return { exitCode: 0,
                            stdout: JSON.stringify([{ Id: `sha256:${configHash}`, Descriptor: { digest: `sha256:${'b'.repeat(64)}` } }]) };
                        if (input.args.includes('save')) {
                            // Identity verification reads image bytes into an invocation-owned
                            // archive; it does not mutate Docker or compete with engine setup.
                            await writeFile(join(root, `${configHash}.json`), imageConfig);
                            await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configHash}.json`, RepoTags: ['fixture:latest'], Layers: [] }]));
                            await createTar({ file: input.args[input.args.indexOf('--output') + 1], cwd: root }, [`${configHash}.json`, 'manifest.json']);
                            return { exitCode: 0, stdout: '' };
                        }
                        // This first deployment has no existing containers.
                        // Generation capture reads that native fact before up;
                        // it is not a competing Docker mutation.
                        if (input.args[0] === 'ps') return { exitCode: 0, stdout: '' };
                        nativeEffects++;
                        if (input.args.includes('tag')) return { exitCode: 0, stdout: '' };
                        if (input.args.includes('up')) { receiptStateAtNativeStart = receipt.deployment.state;
                            nativeActivationStarted = true;
                            deploymentStarted.resolve(); await deploymentExited.promise;
                            throw Object.assign(new Error('Native termination is not confirmed'), { code: 'plugin_exec_termination_incomplete' }); }
                        throw new Error('Competing Docker effect');
                    } } }; } },
            });
            const review = await target.review({ actionId: request.actionId, input: request.input, content: receipt.content, context: {} });
            receipt = { ...receipt, content: { ...receipt.content, ownServer: { approvedInputBasis: review.inputBasis } } };
            const queuedReceipt = structuredClone(receipt);
            first = applyMachineSetup({ ...setup.input, setup: { scripts: [{ body: 'engine-setup', affects: 'dockerEngine' }] } });
            await waitForSetupSpawn(setup.started.promise, first);
            expect(await target.execute(request)).toMatchObject({ ok: false, errorCode: 'effect_in_progress',
                details: { actionOperationId: 'setup-first' } });
            expect(nativeEffects).toBe(0);
            expect(setup.processes).toHaveLength(1);
            setup.processes[0].exit(); await first;
            // A known refused receipt is terminal, not a replayable native command.
            // The person explicitly starts a new admitted deployment operation.
            receipt = { ...queuedReceipt, deployment: { ...queuedReceipt.deployment, id: 'deployment-after-setup',
                requestKey: 'request-after-setup', actionOperationId: 'deployment-operation-after-setup' } };
            deploying = target.execute({ ...request, input: { ...request.input, requestKey: 'request-after-setup' },
                receipt: { ...request.receipt, deploymentId: receipt.deployment.id },
                context: { ...request.context, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } });
            await Promise.race([deploymentStarted.promise, deploying.then(result => {
                // A rollout may successfully persist a failed receipt. Expose
                // only closed state/reason facts, never its content or errors.
                const status = result.ok && 'state' in result ? result.state : result.ok ? 'pending' : 'refused';
                const closedReasons = ['target_mismatch', 'deployment_conflict', 'invalid_parameters', 'unsupported_action',
                    'effect_in_progress', 'plan_changed', 'native_tool_unavailable', 'native_failed', 'deployment_failed',
                    'cancelled', 'outcome_unknown', 'rollback_image_unavailable'];
                const reason = result.ok ? 'none' : 'errorCode' in result && typeof result.errorCode === 'string'
                    && closedReasons.includes(result.errorCode) ? result.errorCode : 'unclassified_refusal';
                const memberPhase = receipt.content.machineResults[0]?.activation ?? 'not_dispatched';
                const nativePhase = nativeActivationStarted ? 'activation' : nativeEffects > 0 ? 'other_native_effect' : 'pre_effect';
                throw new Error(`Deployment settled before native activation: status=${status}; reason=${reason}; memberPhase=${memberPhase}; nativePhase=${nativePhase}`);
            })]);
            expect(receiptStateAtNativeStart).toBe('running');
            deploymentController.abort();
            deploymentExited.resolve();
            // Lost receipt ACK/cancellation does not release the physical native wait.
            expect(await applyMachineSetup({ ...setup.input, setup: { scripts: [{ body: 'engine-setup', affects: 'dockerEngine' }] },
                operation: { ...setup.input.operation, actionRequestId: 'setup-after-deploy' } })).toMatchObject({
                ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'deployment-operation-after-setup' } });
            expect(setup.processes).toHaveLength(1);
            nativeSettled.resolve();
            expect(await deploying).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
        } finally {
            deploymentExited.resolve(); nativeSettled.resolve();
            for (const process of setup.processes) process.exit();
            await first; await deploying; setup.terminalSessions.dispose(); await services.dispose(); await runtime.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves the script string and its explicit native-impact sibling at the setup ingress', () => {
        expect(MachineSetupV1Schema.parse({ scripts: [{ body: 'portable-setup', affects: 'none' }],  }))
            .toEqual({ scripts: [{ body: 'portable-setup', affects: 'none' }],  });
        expect(MachineSetupV1Schema.parse({ scripts: [{ body: 'service-setup', affects: { services: ['service-A'] } }],  }))
            .toEqual({ scripts: [{ body: 'service-setup', affects: { services: ['service-A'] } }],  });
    });

    it('takes endpoint identity from the same Docker prerequisite probe and rejects an empty identity', async () => {
        const input = { command: '/docker', prefix: [], cwd: '/tmp', env: { DOCKER_CONTEXT: 'reviewed-context' },
            io: { run: async () => ({ exitCode: 0, stdout: JSON.stringify({ ID: 'actual-engine-id', OperatingSystem: 'Ubuntu 24.04.3 LTS' }) }) } };
        expect(await assertNativeComposeAvailable(input)).toBe('actual-engine-id');
        await expect(assertNativeComposeAvailable({ ...input, io: { run: async () => ({ exitCode: 0, stdout: '\n' }) } }))
            .rejects.toMatchObject({ code: 'native_tool_unavailable' });
    });

    it('refuses a second actual setup caller with the incumbent operation and zero competing native effects', async () => {
        const f = setupFixture();
        const first = applyMachineSetup(f.input);
        try {
            await waitForSetupSpawn(f.started.promise, first);
            const second = await applyMachineSetup({ ...f.input,
                operation: { ...f.input.operation, actionRequestId: 'setup-second' } });
            expect(second).toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'setup-first' } });
            expect(f.processes).toHaveLength(1);
        } finally { for (const process of f.processes) process.exit(); await first; f.terminalSessions.dispose(); }
    });

    it('links a conflicting operation before dispatch while allowing unrelated projects', async () => {
        const owner = createMachineNativeEffectAdmission();
        const native = deferred();
        let entered = false;
        const deploy = owner.run({ operation: { operationId: 'deploy-A', kind: 'deploy' }, keys: [project('A')] }, async () => {
            entered = true;
            await native.promise;
        });
        expect(entered).toBe(true);
        let competingEffects = 0;
        try {
            await expect(owner.run({ operation: { operationId: 'deploy-A2', kind: 'deploy' }, keys: [project('A')] }, async () => {
                competingEffects++;
            })).rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'deploy-A' });
            await owner.run({ operation: { operationId: 'deploy-B', kind: 'deploy' }, keys: [project('B')] }, async () => { competingEffects++; });
            expect(competingEffects).toBe(1);
        } finally { native.resolve(); await deploy; }
    });

    it('uses app equality and engine scope while allowing unrelated apps and portable setup', async () => {
        const owner = createMachineNativeEffectAdmission();
        const native = deferred();
        const keys: MachineNativeEffectKey[] = [project('A')];
        const first = owner.run({ operation: { operationId: 'deploy-A', kind: 'build' }, keys }, async () => native.promise);
        let effects = 0;
        try {
            for (const key of keys) await expect(owner.run({ operation: { operationId: 'contender', kind: 'deploy' }, keys: [key] }, async () => { effects++; }))
                .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'deploy-A' });
            await expect(owner.run({ operation: { operationId: 'engine-setup', kind: 'setup' },
                keys: [{ kind: 'machineSetup' }, { kind: 'dockerEngine', dockerEndpoint: 'engine' }] }, async () => { effects++; }))
                .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'deploy-A' });
            // A failed full-set acquisition did not leave a partial setup claim.
            await owner.run({ operation: { operationId: 'portable-setup', kind: 'setup' }, keys: [{ kind: 'machineSetup' }] }, async () => { effects++; });
            await owner.run({ operation: { operationId: 'app-B', kind: 'deploy' },
                keys: [project('B')] }, async () => { effects++; });
            await owner.run({ operation: { operationId: 'other-engine', kind: 'pull' },
                keys: [{ kind: 'dockerEngine', dockerEndpoint: 'other-engine' }] }, async () => { effects++; });
            expect(effects).toBe(3);
        } finally { native.resolve(); await first; }
    });

    it('admits app keys once and only joins native settlement for nested stages', async () => {
        const owner = createMachineNativeEffectAdmission();
        const foreign = createMachineNativeEffectAdmission();
        let retained: MachineNativeEffectContext | undefined;
        let effects = 0;
        await owner.run({ operation: { operationId: 'deploy', kind: 'deploy' }, keys: [project('A'), { kind: 'machineSetup' }] }, async context => {
            retained = context;
            await owner.runStage(context, async () => {
                await owner.runStage(context, async () => { effects++; });
            });
            await owner.runStage(context, async () => { effects++; });
            await owner.runStage(context, async () => { effects++; });
            await expect(foreign.runStage(context, async () => { effects++; })).rejects.toMatchObject({ code: 'admission_unavailable' });
            await expect(owner.runStage({ ...context }, async () => { effects++; })).rejects.toMatchObject({ code: 'admission_unavailable' });
        });
        expect(retained).toBeDefined();
        await expect(owner.runStage(retained!, async () => { effects++; })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(effects).toBe(3);
    });

    it.each(['during', 'before', 'force'] as const)('settles only an admitted protected stage before applying Stop: %s', async timing => {
        const owner = createMachineNativeEffectAdmission();
        const controller = new AbortController();
        const entered = deferred(), finish = deferred();
        const statuses: string[] = [];
        let protectedEffects = 0;
        let unstartedEffects = 0;
        await owner.run({ operation: { operationId: `protected-${timing}`, kind: 'restore', signal: controller.signal },
            keys: [project(`protected-${timing}`)] }, async context => {
            if (timing === 'before') controller.abort();
            const pending = owner.runStage(context, async () => {
                protectedEffects++;
                entered.resolve();
                await finish.promise;
                // This is verify-or-undo under the SAME admission after Stop,
                // not a new top-level stage or a forged recovery context.
                return owner.runStage(context, async () => {
                    context.operation.signal?.throwIfAborted();
                    protectedEffects++;
                    return 'swap-terminal';
                });
            }, { protected: true, onStopPending() { statuses.push('stop_pending'); } });
            const observed = pending.then(value => ({ value }), error => ({ error }));
            if (timing !== 'before') {
                await entered.promise;
                try {
                    controller.abort();
                    expect(statuses).toEqual(['stop_pending']);
                    expect(context.operation.signal?.aborted, 'the owner defers forwarding, never replaces the admitted context').toBe(false);
                    // A sibling not entered through the protected callback is NOT
                    // rescued merely because the same job has a protected stage.
                    await expect(owner.runStage(context, async () => { unstartedEffects++; }))
                        .rejects.toMatchObject({ code: 'cancelled' });
                    if (timing === 'force') {
                        owner.forceStop(context);
                        expect(context.operation.signal?.aborted).toBe(true);
                    }
                } finally { finish.resolve(); }
            } else finish.resolve();
            if (timing === 'during') expect(await observed).toEqual({ value: 'swap-terminal' });
            else expect(await observed).toMatchObject({ error: { code: 'cancelled' } });
            expect(context.operation.signal?.aborted).toBe(true);
            await expect(owner.runStage(context, async () => { unstartedEffects++; }))
                .rejects.toMatchObject({ code: 'cancelled' });
        });
        expect(protectedEffects).toBe(timing === 'before' ? 0 : timing === 'force' ? 1 : 2);
        expect(unstartedEffects).toBe(0);
    });

    it('holds admitted Docker engines through cancellation while allowing other engines and portable effects', async () => {
        const owner = createMachineNativeEffectAdmission();
        const native = deferred();
        const started = deferred();
        const controller = new AbortController();
        let effects = 0;
        const operation = owner.run({ operation: { operationId: 'local-system-docker', kind: 'setup', signal: controller.signal },
            keys: [{ kind: 'dockerEngine', dockerEndpoint: 'initially-observed' }] }, async context => {
            await owner.runStage(context, async () => {});
            started.resolve();
            await native.promise;
        });
        await started.promise;
        try {
            controller.abort();
            await owner.run({ operation: { operationId: 'portable', kind: 'setup' }, keys: [{ kind: 'machineSetup' }] }, async () => { effects++; });
            await owner.run({ operation: { operationId: 'unrelated', kind: 'fixture' }, keys: [] }, async () => { effects++; });
            await expect(owner.run({ operation: { operationId: 'same-engine', kind: 'deploy' },
                keys: [{ kind: 'composeProject', dockerEndpoint: 'initially-observed', projectName: 'same' }] }, async () => { effects++; }))
                .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'local-system-docker' });
            await owner.run({ operation: { operationId: 'new-engine', kind: 'deploy' },
                keys: [{ kind: 'composeProject', dockerEndpoint: 'newly-observed', projectName: 'new' }] }, async () => { effects++; });
            expect(effects).toBe(3);
        } finally { native.resolve(); await operation; }
        await owner.run({ operation: { operationId: 'after-native-settlement', kind: 'deploy' },
            keys: [{ kind: 'composeProject', dockerEndpoint: 'initially-observed', projectName: 'same' }] }, async () => { effects++; });
        expect(effects).toBe(4);
    });

    it('holds cancellation and response loss until nested native settlement, independently of receipt acknowledgement', async () => {
        const owner = createMachineNativeEffectAdmission();
        const native = deferred();
        const entered = deferred();
        const controller = new AbortController();
        let returned = false;
        const operation = owner.run({ operation: { operationId: 'deploy', kind: 'deploy', signal: controller.signal }, keys: [project('A')] }, async context => {
            void owner.runStage(context, async () => { entered.resolve(); await native.promise; });
            throw new Error('receipt_ack_lost');
        }).finally(() => { returned = true; });
        const outcome = expect(operation).rejects.toThrow('receipt_ack_lost');
        await entered.promise;
        controller.abort();
        try {
            expect(returned).toBe(false);
            await expect(owner.run({ operation: { operationId: 'other', kind: 'deploy' }, keys: [project('A')] }, async () => {}))
                .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'deploy' });
        } finally { native.resolve(); await outcome; }
        await owner.run({ operation: { operationId: 'fresh', kind: 'deploy' }, keys: [project('A')] }, async () => {});
    });

    it('reconciles unknown native custody without replaying an uncertain effect', async () => {
        const owner = createMachineNativeEffectAdmission();
        let effects = 0;
        await expect(owner.run({ operation: { operationId: 'unknown-deploy', kind: 'deploy' }, keys: [project('A')],
            settleNative: async () => { throw new Error('native_termination_unconfirmed'); } }, async () => { effects++; }))
            .rejects.toThrow('native_termination_unconfirmed');
        await owner.reconcileUnknown({ keys: [project('A')], observeSettled: async () => false });
        await expect(owner.run({ operation: { operationId: 'fresh', kind: 'deploy' }, keys: [project('A')] }, async () => { effects++; }))
            .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'unknown-deploy' });
        await owner.reconcileUnknown({ keys: [project('A')], observeSettled: async operation => {
            expect(operation.operationId).toBe('unknown-deploy');
            return true;
        } });
        expect(effects).toBe(1);
        await owner.run({ operation: { operationId: 'fresh', kind: 'deploy' }, keys: [project('A')] }, async () => { effects++; });
        expect(effects).toBe(2);
    });

    it('makes an explicit Docker-engine setup impact conflict with a deployment on its observed Docker engine', async () => {
        const f = setupFixture();
        const native = deferred();
        const deploy = machineNativeEffectAdmission.run({ operation: { operationId: 'deploy-A', kind: 'deploy' }, keys: [project('A')] }, async () => native.promise);
        let publications = 0;
        try {
            expect(await applyMachineSetup({ ...f.input, setup: { scripts: [{ body: 'engine-setup', affects: 'dockerEngine' }] }, onAdmitted: async () => { publications++; } }))
                .toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'deploy-A' } });
            expect(f.processes).toHaveLength(0);
            expect(publications).toBe(0);
        } finally { native.resolve(); await deploy; f.terminalSessions.dispose(); }
    });

    it('holds the actual cancelled setup claim until its native process exits', async () => {
        const f = setupFixture();
        const first = applyMachineSetup(f.input);
        const otherSignal = new AbortController().signal;
        try {
            await waitForSetupSpawn(f.started.promise, first);
            f.controller.abort();
            expect(await applyMachineSetup({ ...f.input, signal: otherSignal,
                operation: { ...f.input.operation, signal: otherSignal, actionRequestId: 'setup-contender' } }))
                .toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'setup-first' } });
            expect(f.processes).toHaveLength(1);
            f.processes[0]!.exit();
            expect(await first).toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(await applyMachineSetup({ ...f.input, signal: otherSignal,
                operation: { ...f.input.operation, signal: otherSignal, actionRequestId: 'setup-fresh' } }))
                .toMatchObject({ ok: true });
        } finally { for (const process of f.processes) process.exit(); await first; f.terminalSessions.dispose(); }
    });

});
