import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { unexpectedCaptureSourceResolution } from "@/plugins/testkit/unexpectedCaptureSourceResolution";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
} from './contributions/targetRequestInterceptors';

import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '../invocation/services/unavailable';
import { createProjectNativeEnvironmentIoForHost, type ProjectNativeEffectCaptureForHost } from '../invocation/services/exec';
import { createProductionPluginInvocationServiceOwners } from '../invocation/services/production';
import { createPluginInvocationLifetime } from '../invocation/lifetime';
import { createPluginReloadController } from '../reload/controller';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import { ingestCanonicalPluginManifest } from '../../manifest/ingest';
import { activatePluginRuntimeRegistry } from './manager';
import type { PluginContributionActivationDemand } from './activation/targets';
import { resolveProjectNativeAdapter, type ProjectNativeAdapterProductionV1 } from './contributions/targetProjectNativeAdapters';
import { createProjectDefinitionAction } from '@/rpc/handlers/projectDefinitions';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeProjectFiniteProcess } from '@/workspaces/projectSetup/projectSetupExecution';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { prepareProjectSetup } from '@/workspaces/projectSetup/projectSetupPreparation';
import { inspectProjectSetupReadinessFromRuntime } from '@/workspaces/projectSetup/projectSetupReadiness';
import { resolveProjectNativeCommand } from '@/workspaces/projectSetup/projectNativeResolution';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import type { PtyProvider, PtyExitEvent, PtySpawnParams } from '@/terminal/pty/provider';
import { createPluginRuntimeOccurrenceId } from '../runtimeSlots';
import { pixiPlugin, pixiRuntime, pixiAdapter, importedPixiTask, importedPixiEnvironment, persistedQualifiedArms } from '../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/project-native-source';
import { authorizePluginExecLaunchForHost, authorizeResolvedProjectExecLaunchForHost, createStablePluginExecService } from '../invocation/services/exec';
import { createLoadedMachineProvisionerFixture, machineProvisionerFixtureRoleIds } from '../../projection/registry/machineProvisioners.testkit';
import { projectLoadedPluginContributes } from '../../projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '../../projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from '../../projection/registry/projection/v2';
import { resolveExecutableManagedDependenciesRegistry } from '../../projection/registry/managedDependencyExecutables';
import { createStableManagedExecutableResolver } from '../invocation/services/managedExecutableResolver';
import { createStablePluginManagedDependenciesHost } from '../invocation/services/managedDependencies';
import { resolveManifestHostAccessRequestsForQualifiedContribution } from '../hostAccess/manifestRequests';
import * as processTreeBoundary from '@/agent/runtime/process/killProcessTree';
import { readSupervisedPluginProcessIdForHost } from '../exec/processSupervisor';

type TargetPluginRegistrationApi = ReturnType<typeof createPluginRegistrationScope>['api'];

async function createCommittedFileBackedFixtureActivationSource(params: Readonly<{
    pluginId: string;
    root: string;
    entryPath: string;
}>) {
    return () => ({
        kind: 'file_backed' as const,
        entryPath: params.entryPath,
        trustPolicy: 'prompt' as const,
        committedAuthorization: {
            pluginId: params.pluginId,
            immutableGenerationId: `fixture:${params.pluginId}`,
        },
    });
}

describe('target activation publication', () => {
    it('resolves the public native command and environment, refusing late retired results', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'happier-native-adapter-project-'));
        const configContent = '[tasks]\ncheck = "echo checked"';
        await writeFile(join(projectRoot, 'pixi.toml'), configContent);
        // A real executable/PATH fixture supplies installed-tool OS facts;
        // this does not characterize an installed Pixi distribution.
        const installedPixiPath = join(projectRoot, process.platform === 'win32' ? 'pixi.exe' : 'pixi');
        await copyFile(process.execPath, installedPixiPath);
        if (process.platform !== 'win32') await chmod(installedPixiPath, 0o755);
        const ingested = ingestCanonicalPluginManifest(pixiPlugin.manifest, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(`Expected admitted external Pixi fixture: ${JSON.stringify(ingested.diagnostics)}`);
        const occurrenceId = createPluginRuntimeOccurrenceId(pixiAdapter.pluginId);
        let release!: () => void;
        const awaitingCommand = new Promise<void>(resolve => { release = resolve; });
        let commandStarted!: () => void;
        const started = new Promise<void>(resolve => { commandStarted = resolve; });
        let awaitRetirement = false;
        let effectSignal: AbortSignal | undefined;
        let uncertainCommandProcess: Awaited<ReturnType<PluginInvocationContext['services']['exec']['spawn']>> | undefined;
        const load = vi.fn(async () => ({ activate(api: PluginApi) {
            api.projectNativeAdapters.register(pixiAdapter.localId, {
                ...pixiRuntime,
                async resolveCommand(request, context, options) {
                    effectSignal = context.signal;
                    if (request.source.target === 'termination-unknown') {
                        uncertainCommandProcess = await context.services.exec.spawn({
                            executable: { kind: 'systemTool', id: 'pixi' }, args: ['run', 'check'],
                            cwd: { root: 'workspace', relativePath: '' },
                        });
                        // The real Exec owner, rather than the adapter, emits
                        // the native process-tree uncertainty from the OS boundary.
                        await uncertainCommandProcess.dispose();
                    }
                    if (request.source.target === 'invalid-result') {
                        return { kind: 'resolved', executable: { kind: 'systemTool', id: 'pixi' }, args: [], cwd: request.root,
                            reviewInputs: request.files, authorization: 'plugin-claimed' };
                    }
                    if (request.source.target === 'unowned-native-resource') return { kind: 'resolved', executable: { kind: 'systemTool', id: 'pixi' }, args: [], cwd: request.root,
                        reviewInputs: request.files, nativeInstance: { adapter: request.adapter, nativeResourceId: 'fixture-resource' } };
                    if (awaitRetirement) {
                        commandStarted();
                        await awaitingCommand;
                    }
                    const config = await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' });
                    if (new TextDecoder().decode(config) !== configContent) throw new Error('Native effect lost admitted Project root');
                    return pixiRuntime.resolveCommand!(request, context, options);
                },
            });
        } }));
        const targets = [{ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId: pixiAdapter.pluginId,
            manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.mjs',
            sourceSpec: { kind: 'package' as const, locator: '@acme/pixi', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest: ingested.manifest }];
        const inputs = projectLoadedPluginContributes({
            provenance: 'first_party',
            loadResult: { loadedPlugins: [{ pluginId: pixiAdapter.pluginId, pluginRootPath: projectRoot,
                manifestPath: targets[0]!.manifestPath, daemonEntryPath: targets[0]!.daemonEntryPath,
                devDaemonEntryPath: null, sourceSpec: targets[0]!.sourceSpec, manifest: ingested.manifest }],
                diagnosticsByPluginId: {} },
        });
        const contributes = createResolvedContributionRegistry({ ...inputs, activationTargets: targets });
        const registry = await activatePluginRuntimeRegistry({
            contributes,
            occurrenceIdsByPluginId: new Map([[pixiAdapter.pluginId, occurrenceId]]), generation: 39,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@acme/pixi/daemon', load }),
        });
        let nativeExecutableResolver: ReturnType<typeof createStableManagedExecutableResolver> | undefined;
        const serviceOwners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => projectRoot,
            resolveExecutable: async (reference, pluginId, context) => {
                if (!nativeExecutableResolver) throw new Error('Installed executable fixture is not prepared');
                return await nativeExecutableResolver(reference, pluginId, context);
            },
        } });
        const invocationSignals: AbortSignal[] = [];
        let completedInvocations = 0;
        let finalEnvironmentProduction: ProjectNativeAdapterProductionV1 | undefined;
        let inspectedProduction: ProjectNativeAdapterProductionV1 | undefined;
        try {
            expect(load).not.toHaveBeenCalled();
            await expect(resolveProjectNativeAdapter({ reference: pixiAdapter, role: 'nativeServiceLifecycle', targets, registry })).resolves.toEqual({ kind: 'refused', code: 'native_adapter_unsupported' });
            await expect(resolveProjectNativeAdapter({ reference: pixiAdapter, role: 'detect', targets, registry, isAdmitted: () => false })).resolves.toEqual({ kind: 'refused', code: 'native_adapter_retired' });
            expect(load).not.toHaveBeenCalled();
            expect(JSON.parse(persistedQualifiedArms)).toMatchObject({ scripts: { check: { source: importedPixiTask } }, environment: importedPixiEnvironment });
            const inspectAction = createProjectDefinitionAction({ serverId: 'home-a', machineId: 'machine-a', workingDirectory: projectRoot,
                accessPolicy: { kind: 'restrictedRoots', roots: [projectRoot] },
                acquirePluginRuntime: async () => ({ registry: { contributes,
                    resolveProjectNativeAdapter: (reference, role) => resolveProjectNativeAdapter({ reference, role, targets, registry }),
                }, async release() {} }),
            });
            await expect(inspectAction({ actionId: 'projects.inspect', input: { workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: projectRoot } },
                context: { serverId: 'home-a', surface: 'cli' } })).resolves.toMatchObject({
                definition: { basis: { kind: 'absent' } },
                detection: { entries: [{ source: importedPixiTask, usage: 'script' }], environments: [importedPixiEnvironment], coverage: 'complete' },
            });
            const workspace = { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: projectRoot };
            await expect(inspectAction({ actionId: 'projects.manifest.update',
                input: { workspace, expectedBasis: { kind: 'absent' }, bytes: persistedQualifiedArms },
                context: { serverId: 'home-a', surface: 'cli' },
            })).resolves.toMatchObject({ status: 'saved', basis: { kind: 'present' }, document: {
                status: 'valid', bytes: persistedQualifiedArms,
                manifest: { scripts: { check: { source: importedPixiTask } }, environment: importedPixiEnvironment },
            } });
            expect(await readFile(join(projectRoot, '.happier/project.json'), 'utf8')).toBe(persistedQualifiedArms);
            await expect(inspectAction({ actionId: 'projects.inspect', input: { workspace },
                context: { serverId: 'home-a', surface: 'cli' },
            })).resolves.toMatchObject({ definition: { basis: { kind: 'present' }, document: {
                status: 'valid', bytes: persistedQualifiedArms,
                manifest: { scripts: { check: { source: importedPixiTask } }, environment: importedPixiEnvironment },
            } } });
            const selected = await resolveProjectNativeAdapter({ reference: pixiAdapter, role: 'resolveCommand', targets, registry,
                createInvocationContext(input) {
                    const lifetime = createPluginInvocationLifetime(input.signal);
                    invocationSignals.push(lifetime.signal);
                    const seed = { plugin: { id: pixiAdapter.pluginId, version: pixiPlugin.manifest.version },
                        contribution: { id: pixiAdapter.localId, qualifiedId: `${pixiAdapter.pluginId}/projectNativeAdapters/${pixiAdapter.localId}` },
                        occurrenceId: input.occurrenceId, correlationId: 'native-owner-test', surface: 'cli' as const,
                        signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: input.isCurrent };
                    return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs,
                        services: serviceOwners.createOperationServices(seed, { filesystemRoots: { pluginData: projectRoot, workspace: input.root, projects: new Map() },
                            hostAccessRequests: ingested.manifest.hostAccess.required.map(request => ({ request, required: true })) }) },
                        complete() { completedInvocations++; lifetime.complete(); } };
                },
            });
            expect(selected.kind).toBe('ready');
            if (selected.kind !== 'ready' || importedPixiTask.kind !== 'pluginNative' || importedPixiEnvironment.kind !== 'pluginToolchain') throw new Error('Expected native fixture arms');
            const request = { root: projectRoot, adapter: pixiAdapter, files: [{ file: 'pixi.toml', content: configContent }] };
            await expect(selected.lease.runtime.detect!(request)).resolves.toMatchObject({
                entries: [{ source: importedPixiTask, usage: 'script' }], environments: [importedPixiEnvironment], coverage: 'complete',
            });
            const inspected = selected.lease.acquireProduction({ root: projectRoot });
            if (inspected.kind !== 'ready') throw new Error(inspected.code);
            inspectedProduction = inspected.production;
            await expect(inspectedProduction.resolveCommand({ ...request, source: { ...importedPixiTask, target: 'unowned-native-resource' } }))
                .resolves.toEqual({ kind: 'unsupported', code: 'native_adapter_unsupported' });
            await expect(inspectedProduction.resolveCommand({ ...request, source: importedPixiTask })).resolves.toMatchObject({
                kind: 'resolved', executable: { kind: 'systemTool', id: 'pixi' }, args: ['run', 'check'], cwd: projectRoot,
                reviewInputs: request.files, environmentApplied: importedPixiEnvironment,
            });
            expect(effectSignal?.aborted).toBe(false);
            await expect(inspectedProduction.produceEnvironment({ ...request, selection: importedPixiEnvironment, launch: { command: '/bin/echo', args: ['checked'], cwd: projectRoot, env: {} } })).resolves.toMatchObject({
                kind: 'ready', launch: { executable: { kind: 'systemTool', id: 'pixi' }, args: ['run', '--', '/bin/echo', 'checked'] }, reviewInputs: request.files,
            });
            inspectedProduction.release();
            expect(effectSignal?.aborted).toBe(true);
            const managedDependencies = createStablePluginManagedDependenciesHost({
                installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributes.managedDependencies ?? []),
                isCurrent: selected.lease.isCurrent, getSettings: () => ({}), resolveAdapter: getRuntimeInstallableAdapter,
                async removeManagedInstall() { throw new Error('System tool fixture must not remove a managed installation'); },
            });
            const systemToolContext = createDaemonSpawnToolResolutionContext({ processEnv: { PATH: projectRoot, PATHEXT: '.EXE' } });
            const resolveExecutable = createStableManagedExecutableResolver({
                systemTools: contributes.systemTools ?? [], managedDependencies,
                async resolveSystemTool(input) {
                    const resolved = await systemToolContext.resolveSystemTool({ toolId: input.toolId,
                        lookupNames: input.executableNames, reason: 'Resolve public native fixture installed executable' });
                    if (!resolved.ok) throw new Error(`Installed fixture executable unavailable: ${resolved.reasonCode}`);
                    return { toolId: input.toolId, command: resolved.command, args: resolved.args, env: { PATH: '' } };
                },
            });
            nativeExecutableResolver = resolveExecutable;
            // The host production port keeps each genuine selected invocation
            // alive across the returned managed reference and final capture.
            const completedBeforeProduction = completedInvocations;
            const commandProduction = selected.lease.acquireProduction({ root: projectRoot });
            const environmentProduction = selected.lease.acquireProduction({ root: projectRoot, environment: { KEEP: 'base' } });
            if (commandProduction.kind !== 'ready') throw new Error(commandProduction.code);
            if (environmentProduction.kind !== 'ready') throw new Error(environmentProduction.code);
            try {
                expect(commandProduction.production.pluginVersion).toBe(ingested.manifest.version);
                expect(environmentProduction.production.pluginVersion).toBe(ingested.manifest.version);
                expect(commandProduction.production.exec).not.toBe(environmentProduction.production.exec);
                const commandSignal = invocationSignals.at(-2)!;
                const environmentSignal = invocationSignals.at(-1)!;
                const resolved = await commandProduction.production.resolveCommand({ ...request, source: importedPixiTask });
                if (resolved.kind !== 'resolved') throw new Error(resolved.code);
                expect(commandSignal.aborted).toBe(false);
                expect(completedInvocations).toBe(completedBeforeProduction);
                const captured = await authorizePluginExecLaunchForHost(commandProduction.production.exec, {
                    executable: resolved.executable, args: resolved.args,
                    cwd: { root: 'workspace', relativePath: '' }, env: { KEEP: 'base' },
                });
                expect(captured).toMatchObject({ command: installedPixiPath, args: ['run', 'check'], cwd: projectRoot });
                captured.release();
                const wrapped = await authorizeResolvedProjectExecLaunchForHost({
                    launch: { command: '/bin/echo', args: ['checked'], cwd: projectRoot, env: { KEEP: 'base' } },
                    nativeExecutableOwner: environmentProduction.production.exec,
                    signal: new AbortController().signal,
                    assertCurrent: () => {
                        if (!environmentProduction.production.isCurrent()) throw new Error('Retired selected environment invocation');
                    },
                    projectLaunch: { status: 'ready', reviewedEffectDigest: 'retained-selected-invocation',
                        environment: { root: projectRoot, selection: importedPixiEnvironment, platform: 'linux', io: {
                            resolveTool: async () => { throw new Error('Plugin environment cannot use builtin resolution'); },
                            run: async () => { throw new Error('Plugin environment cannot use builtin execution'); },
                        } }, nativeAdapter: { lease: environmentProduction.production, files: request.files },
                    },
                });
                expect(wrapped).toMatchObject({ command: installedPixiPath, args: ['run', '--', '/bin/echo', 'checked'] });
                expect(environmentSignal.aborted).toBe(false);
                wrapped.release();
                expect(completedInvocations).toBe(completedBeforeProduction);
                await expect(commandProduction.production.resolveCommand({ ...request, root: join(projectRoot, 'another-root'), source: importedPixiTask }))
                    .resolves.toEqual({ kind: 'failed', code: 'native_adapter_reference_mismatch' });
                commandProduction.production.release();
                commandProduction.production.release();
                expect(commandSignal.aborted).toBe(true);
                expect(environmentSignal.aborted).toBe(false);
                expect(commandProduction.production.isCurrent()).toBe(false);
                expect(environmentProduction.production.isCurrent()).toBe(true);
                expect(completedInvocations).toBe(completedBeforeProduction + 1);
                await expect(commandProduction.production.resolveCommand({ ...request, source: importedPixiTask }))
                    .resolves.toEqual({ kind: 'unavailable', code: 'native_adapter_retired' });
            } finally {
                commandProduction.production.release();
                environmentProduction.production.release();
            }
            expect(completedInvocations).toBe(completedBeforeProduction + 2);
            // Node is the installed executable fixture, so this native task
            // keeps a real owned process alive until tree settlement is proven.
            await writeFile(join(projectRoot, 'run'), 'setInterval(() => {}, 1000);');
            const uncertainProduction = selected.lease.acquireProduction({ root: projectRoot });
            if (uncertainProduction.kind !== 'ready') throw new Error(uncertainProduction.code);
            const completedBeforeUncertainty = completedInvocations;
            const uncertainSignal = invocationSignals.at(-1)!;
            const treeTermination = vi.spyOn(processTreeBoundary, 'killProcessTree')
                .mockRejectedValueOnce(new Error('OS boundary could not confirm native tree termination'));
            let uncertainty: unknown;
            const unsubscribeUncertainty = uncertainProduction.production.onOutcomeUncertain(error => { uncertainty = error; });
            let preparationSettled = false;
            const uncertainResult = uncertainProduction.production.resolveCommand({ ...request,
                source: { ...importedPixiTask, target: 'termination-unknown' },
            });
            void uncertainResult.then(() => { preparationSettled = true; });
            try {
                await expect.poll(() => uncertainty).toMatchObject({ code: 'plugin_exec_termination_incomplete' });
                const pid = uncertainCommandProcess && readSupervisedPluginProcessIdForHost(uncertainCommandProcess);
                if (!pid) throw new Error('Expected the actual selected native process');
                expect(process.kill(pid, 0)).toBe(true);
                expect(uncertainSignal.aborted).toBe(false);
                expect(uncertainProduction.production.isCurrent()).toBe(true);
                expect(completedInvocations).toBe(completedBeforeUncertainty);
                expect(preparationSettled).toBe(false);
            } finally {
                treeTermination.mockRestore();
                // Retain the selected invocation through the real retry and
                // settlement; the failed attempt alone does not release it.
                await uncertainCommandProcess?.dispose();
                await expect(uncertainResult).resolves.toEqual({ kind: 'failed', code: 'native_adapter_failed' });
                await uncertainProduction.production.release();
                unsubscribeUncertainty();
            }
            expect(completedInvocations).toBe(completedBeforeUncertainty + 1);
            let originalExecutableReleased = 0;
            const finalEnvironment = selected.lease.acquireProduction({ root: projectRoot, environment: { KEEP: 'base' } });
            if (finalEnvironment.kind !== 'ready') throw new Error(finalEnvironment.code);
            finalEnvironmentProduction = finalEnvironment.production;
            const projectLaunch = {
                    status: 'ready', reviewedEffectDigest: 'current-reviewed-public-native-effect',
                    environment: { root: projectRoot, selection: importedPixiEnvironment, platform: 'linux', io: {
                        resolveTool: async () => { throw new Error('Plugin environment must not fall back to builtin resolution'); },
                        run: async () => { throw new Error('Plugin environment must not fall back to builtin execution'); },
                    } },
                    nativeAdapter: { lease: finalEnvironmentProduction, files: request.files },
            } satisfies Parameters<typeof authorizeResolvedProjectExecLaunchForHost>[0]['projectLaunch'];
            const admitted = await authorizeResolvedProjectExecLaunchForHost({
                launch: { command: '/bin/echo', args: ['checked'], cwd: projectRoot, env: { KEEP: 'base' },
                    release: () => { originalExecutableReleased += 1; } },
                nativeExecutableOwner: finalEnvironmentProduction.exec,
                signal: new AbortController().signal,
                assertCurrent: () => { if (!selected.lease.isCurrent()) throw new Error('Retired native contribution'); },
                projectLaunch,
            });
            expect(admitted).toMatchObject({ command: installedPixiPath,
                args: ['run', '--', '/bin/echo', 'checked'],
                cwd: projectRoot, env: { KEEP: 'base' } });
            expect(admitted.env).toEqual({ KEEP: 'base' });
            // Only native PTY IO is simulated. The operation, finite consumer,
            // held terminal, output ring and observed settlement stay real.
            let emitData!: (data: string) => void;
            let emitExit!: (event: PtyExitEvent) => void;
            let nativeSpawn: PtySpawnParams | undefined;
            const ptyProvider: PtyProvider = { spawn(input) {
                nativeSpawn = input;
                const data = new Set<(data: string) => void>();
                const exits = new Set<(event: PtyExitEvent) => void>();
                emitData = value => { for (const listener of data) listener(value); };
                emitExit = event => { for (const listener of exits) listener(event); };
                return { pid: 12345, ownedProcessGroupId: 12345, write() {}, resize() {}, kill() {},
                    onData(listener) { data.add(listener); return { dispose() { data.delete(listener); } }; },
                    onExit(listener) { exits.add(listener); return { dispose() { exits.delete(listener); } }; },
                };
            } };
            // Fake OS boundary: the owned process group is absent on exit.
            const terminals = createTerminalPtySessionManager({ ptyProvider, probeProcessGroup: () => 'absent', config: {
                maxSessions: 1, idleTimeoutMs: 0, bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
                bufferRetentionMs: 600_000, urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384,
                defaultCols: 80, defaultRows: 24,
            } });
            const operation = createHostActionOperationRuntime({ machineId: 'machine-a',
                resolveAccountId: async () => 'native-fixture-requester', generateOperationId: () => 'native-fixture-finite' });
            const operationScope = { accountId: 'native-fixture-requester', machineId: 'machine-a' };
            try {
                await expect(operation.observeExecution({ actionId: 'projects.compute.exec', input: { requestId: 'native-fixture-request' },
                    execute: async context => (await executeProjectFiniteProcess({
                        workspace: { id: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: projectRoot, createdAtMs: 0 },
                        purpose: 'exec', requesterAccountId: operationScope.accountId, operation: context, terminalSessions: terminals, launch: admitted,
                    })).result,
                })).resolves.toMatchObject({ ok: true, result: { operation: { operationId: 'native-fixture-finite' } } });
                expect(nativeSpawn).toMatchObject({ file: admitted.command, args: admitted.args, options: { cwd: projectRoot } });
                expect(nativeSpawn?.options.env).toEqual(admitted.env);
                const running = operation.store.get(operationScope, 'native-fixture-finite');
                expect(running).toMatchObject({ state: 'running', domainRef: { kind: 'projectCommand', purpose: 'exec', workspaceRefId: 'workspace-a', cwd: projectRoot } });
                if (running?.domainRef?.kind !== 'projectCommand' || !running.domainRef.terminalId) throw new Error('Expected observed native terminal');
                const terminalId = running.domainRef.terminalId;
                const capacityProbe = { terminalKey: 'native-fixture-capacity-probe', cwd: projectRoot,
                    requesterAccountId: operationScope.accountId, holdUntilExit: true as const,
                    launchProcess: { file: admitted.command, args: admitted.args, env: admitted.env } };
                expect(terminals.ensure(capacityProbe)).toMatchObject({ ok: false, errorCode: 'terminal_busy' });
                emitData('native fixture output\n');
                emitExit({ exitCode: 0 });
                await expect(operation.runner.waitForTerminal(operationScope, 'native-fixture-finite')).resolves.toMatchObject({ state: 'succeeded', result: { kind: 'success' } });
                const output = terminals.read({ terminalId, cursor: 0, maxBytes: 1_000_000, maxEvents: 1000 });
                expect(output).toMatchObject({ ok: true, done: true });
                if (!output.ok) throw new Error(output.errorCode);
                expect(output.events.some(event => event.t === 'data' && event.data.includes('native fixture output'))).toBe(true);
                expect(terminals.ensure(capacityProbe)).toMatchObject({ ok: true });
                emitExit({ exitCode: 0 });
            } finally { terminals.dispose(); admitted.release(); }
            admitted.release(); admitted.release();
            expect(originalExecutableReleased).toBe(1);
            const originalExecutable = { kind: 'systemTool', id: 'pixi' } as const;
            const originalExec = createStablePluginExecService({
                allowedExecutables: [originalExecutable], environment: { KEEP: 'base' },
                allowedEnvKeys: ['KEEP'],
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: reference => resolveExecutable(reference, pixiAdapter.pluginId),
                resolvePath: async () => projectRoot,
            });
            const nativeAgent = await authorizePluginExecLaunchForHost(originalExec, {
                executable: originalExecutable, args: ['checked'], cwd: { root: 'workspace', relativePath: '' },
            }, { projectLaunch, nativeExecutableOwner: finalEnvironmentProduction.exec });
            expect(nativeAgent).toMatchObject({ command: installedPixiPath,
                args: ['run', '--', installedPixiPath, 'checked'], cwd: projectRoot, env: { KEEP: 'base' } });
            // This PATH is part of the original executable's admitted input,
            // before native production, not a post-native wrapper overlay.
            expect(nativeAgent.env).toEqual({ KEEP: 'base', PATH: '' });
            nativeAgent.release(); nativeAgent.release();
            expect(originalExecutableReleased).toBe(1);
            // Original installed Agent and selected native tool have distinct
            // declaration namespaces. Only executable resolution is an OS fixture.
            const installedAgentRef = { kind: 'systemTool', id: 'fixture.agent' } as const;
            let installedAgentReleases = 0;
            const installedAgentExec = createStablePluginExecService({
                allowedExecutables: [installedAgentRef], environment: { KEEP: 'base' },
                allowedEnvKeys: ['KEEP'],
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async reference => {
                    expect(reference).toEqual(installedAgentRef);
                    return { command: process.execPath, args: ['--agent-prefix'],
                        release: () => { installedAgentReleases += 1; } };
                },
                resolvePath: async () => projectRoot,
            });
            const wrappedAgent = await authorizePluginExecLaunchForHost(installedAgentExec, {
                executable: installedAgentRef, args: ['checked'], cwd: { root: 'workspace', relativePath: '' },
            }, { projectLaunch, nativeExecutableOwner: finalEnvironmentProduction.exec });
            expect(wrappedAgent).toMatchObject({ command: installedPixiPath,
                args: ['run', '--', process.execPath, '--agent-prefix', 'checked'], cwd: projectRoot,
                env: { KEEP: 'base' } });
            expect(wrappedAgent.env).toEqual({ KEEP: 'base' });
            wrappedAgent.release(); wrappedAgent.release();
            expect(installedAgentReleases).toBe(1);
            await expect(finalEnvironmentProduction.resolveCommand({ ...request, adapter: { ...pixiAdapter, pluginId: 'other.plugin' }, source: importedPixiTask }))
                .resolves.toEqual({ kind: 'failed', code: 'native_adapter_reference_mismatch' });
            await expect(finalEnvironmentProduction.resolveCommand({ ...request, source: { ...importedPixiTask, target: 'invalid-result' } }))
                .resolves.toEqual({ kind: 'failed', code: 'native_adapter_result_invalid' });
            await expect(finalEnvironmentProduction.produceEnvironment({ ...request, selection: importedPixiEnvironment,
                launch: { command: '/bin/echo', args: ['checked'], cwd: projectRoot, env: {} } }, { signal: AbortSignal.abort() }))
                .resolves.toEqual({ kind: 'cancelled', code: 'native_adapter_cancelled' });
            awaitRetirement = true;
            const retiringProduction = selected.lease.acquireProduction({ root: projectRoot });
            if (retiringProduction.kind !== 'ready') throw new Error(retiringProduction.code);
            try {
                const resolution = retiringProduction.production.resolveCommand({ ...request, source: importedPixiTask });
                await started;
                await registry.dispose();
                release();
                await expect(resolution).resolves.toEqual({ kind: 'unavailable', code: 'native_adapter_retired' });
                expect(retiringProduction.production.isCurrent()).toBe(false);
                expect(selected.lease.acquireProduction({ root: projectRoot }))
                    .toEqual({ kind: 'unavailable', code: 'native_adapter_retired' });
            } finally { retiringProduction.production.release(); }
            expect(selected.lease.isCurrent()).toBe(false);
        } finally { release(); inspectedProduction?.release(); finalEnvironmentProduction?.release(); await registry.dispose(); await serviceOwners.dispose(); await rm(projectRoot, { recursive: true, force: true }); }
    });

    async function exerciseSelectedNativeInvocations(holdCapacity: boolean, stopNativePreparation = false, passiveOnly = false) {
        const projectRoot = await mkdtemp(join(tmpdir(), 'happier-native-environment-owner-'));
        const cleanups: Array<() => void | Promise<void>> = [() => rm(projectRoot, { recursive: true, force: true })];
        try {
        const commandAdapter = { pluginId: 'acme.native-command', localId: 'commands' } as const;
        const commandSource = { kind: 'pluginNative', adapter: commandAdapter, file: 'command.native', target: 'check' } as const;
        const commandTool = { kind: 'systemTool', id: 'runner' } as const;
        const environmentTool = { kind: 'systemTool', id: 'pixi' } as const;
        const commandContent = 'check';
        const configContent = '[tasks]\ncheck = "echo checked"';
        const commandPath = join(projectRoot, process.platform === 'win32' ? 'native-command.exe' : 'native-command');
        const wrapperPath = join(projectRoot, process.platform === 'win32' ? 'pixi.exe' : 'pixi');
        await Promise.all([copyFile(process.execPath, commandPath), copyFile(process.execPath, wrapperPath),
            writeFile(join(projectRoot, 'command.native'), commandContent), writeFile(join(projectRoot, 'pixi.toml'), configContent),
            mkdir(join(projectRoot, '.happier'))]);
        if (process.platform !== 'win32') await Promise.all([chmod(commandPath, 0o755), chmod(wrapperPath, 0o755)]);
        await writeFile(join(projectRoot, '.happier/project.json'), JSON.stringify({ version: 1,
            workspace: { setup: [!passiveOnly && (holdCapacity || stopNativePreparation) ? { ...commandSource, target: 'hold' } : commandSource] }, scripts: { check: { source: commandSource },
                ...(holdCapacity || stopNativePreparation ? { hold: { source: { ...commandSource, target: 'hold' } } } : {}) }, environment: importedPixiEnvironment }));
        let environmentEffects = 0;
        let commandEffects = 0;
        let nativePreparationProcess: Awaited<ReturnType<PluginInvocationContext['services']['exec']['spawn']>> | undefined;
        const commandPlugin = definePlugin({
            id: commandAdapter.pluginId, version: '1.0.0', displayName: 'Native command fixture', entrypoints: { daemon: './daemon.js' },
            hostAccess: { required: [{ id: 'command-process', capability: 'process', reason: 'Run the selected native command', scope: { executables: [commandTool] } },
                { id: 'command-root', capability: 'filesystem', reason: 'Read the selected command config', scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] },
            systemTools: { runner: { title: 'Native command', executableNames: ['native-command'] } },
            projectNativeAdapters: { [commandAdapter.localId]: { declaration: { files: ['command.native'], roles: ['resolveCommand'] }, runtime: {
                async resolveCommand(request, context) {
                    expect(new TextDecoder().decode(await context.services.fs.readFile({ root: 'workspace', relativePath: 'command.native' }))).toBe(commandContent);
                    if (stopNativePreparation && request.source.target === 'check') {
                        nativePreparationProcess = await context.services.exec.spawn({ executable: commandTool,
                            args: ['-e', 'setInterval(() => {}, 1000)'], cwd: { root: 'workspace', relativePath: '' } });
                        // A selected adapter can encounter a genuine unconfirmed
                        // tree while preparing its command, before any final PTY.
                        await nativePreparationProcess.dispose();
                    }
                    if (holdCapacity && request.source.target === 'check') {
                        await context.services.exec.run({ executable: commandTool, args: ['--version'],
                            cwd: { root: 'workspace', relativePath: '' } });
                        commandEffects += 1;
                    }
                    return { kind: 'resolved', executable: commandTool, args: [request.source.target], cwd: request.root, reviewInputs: request.files };
                },
            } } },
        });
        const environmentPlugin = definePlugin({
            id: pixiAdapter.pluginId, version: pixiPlugin.manifest.version, displayName: 'Selected native environment fixture', entrypoints: { daemon: './daemon.js' },
            hostAccess: { required: [{ id: 'environment-process', capability: 'process', reason: 'Resolve the selected native wrapper', scope: { executables: [environmentTool] } },
                { id: 'environment-root', capability: 'filesystem', reason: 'Read the selected environment config', scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] },
            systemTools: { pixi: { title: 'Pixi', executableNames: ['pixi'] } },
            projectNativeAdapters: { [pixiAdapter.localId]: { declaration: { files: ['pixi.toml'], roles: ['detect', 'produceEnvironment'] }, runtime: {
                detect: pixiRuntime.detect!,
                async produceEnvironment(request, context, options) {
                    environmentEffects += 1;
                    expect(context.plugin.id).toBe(pixiAdapter.pluginId);
                    expect(new TextDecoder().decode(await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' }))).toBe(configContent);
                    return pixiRuntime.produceEnvironment!(request, context, options);
                },
            } } },
        });
        const plugins = [commandPlugin, environmentPlugin];
        const manifests = plugins.map(plugin => {
            const admitted = ingestCanonicalPluginManifest(plugin.manifest, { sourceProvenance: 'registryCustodied' });
            if (!admitted.ok) throw new Error(`Public fixture manifest refused: ${JSON.stringify(admitted.diagnostics)}`);
            return admitted.manifest;
        });
        const targets = manifests.map(manifest => ({ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId: manifest.id,
            manifestPath: `/virtual/${manifest.id}/plugin.json`, daemonEntryPath: `/virtual/${manifest.id}/daemon.mjs`,
            sourceSpec: { kind: 'package' as const, locator: manifest.id, trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest }));
        const occurrenceIds = new Map(targets.map(target => [target.pluginId, createPluginRuntimeOccurrenceId(target.pluginId)]));
        const inputs = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: { diagnosticsByPluginId: {}, loadedPlugins: targets.map(target => ({
            ...target, pluginRootPath: projectRoot, devDaemonEntryPath: null,
        })) } });
        const contributes = createResolvedContributionRegistry({ ...inputs, activationTargets: targets });
        const registry = await activatePluginRuntimeRegistry({ contributes, occurrenceIdsByPluginId: occurrenceIds, generation: 40,
            resolveActivationSource: target => ({ kind: 'bundled', moduleId: `${target.pluginId}/daemon/${passiveOnly ? 'passive-inspection' : stopNativePreparation ? 'preparation-stop' : holdCapacity ? 'capacity' : 'selected'}`,
                load: async () => {
                    const plugin = plugins.find(candidate => candidate.manifest.id === target.pluginId);
                    if (!plugin) throw new Error('Selected native module fixture is unavailable');
                    return { manifest: plugin.manifest, activate: plugin.activate };
                } }),
        });
        cleanups.push(() => registry.dispose());
        const managedDependencies = createStablePluginManagedDependenciesHost({
            installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributes.managedDependencies ?? []),
            isCurrent: () => true, getSettings: () => ({}), resolveAdapter: getRuntimeInstallableAdapter,
            async removeManagedInstall() { throw new Error('Installed system-tool fixture cannot remove managed installations'); },
        });
        const systemTools = createDaemonSpawnToolResolutionContext({ processEnv: { PATH: projectRoot, PATHEXT: '.EXE' } });
        const resolveExecutable = createStableManagedExecutableResolver({ systemTools: contributes.systemTools ?? [], managedDependencies,
            async resolveSystemTool(input) {
                const resolved = await systemTools.resolveSystemTool({ toolId: input.toolId, lookupNames: input.executableNames, reason: 'Resolve an installed public native fixture tool' });
                if (!resolved.ok) throw new Error(resolved.reasonCode);
                return { toolId: input.toolId, command: resolved.command, args: resolved.args };
            },
        });
        const environmentInvocations: Array<{ signal: AbortSignal }> = [];
        const commandInvocations: Array<{ signal: AbortSignal }> = [];
        let completedCommandInvocations = 0;
        const executableOwners: string[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => projectRoot,
            async resolveExecutable(reference, pluginId, context) {
                executableOwners.push(pluginId);
                if (pluginId === pixiAdapter.pluginId) expect(environmentInvocations.some(invocation => !invocation.signal.aborted)).toBe(true);
                return resolveExecutable(reference, pluginId, context);
            },
        } });
        cleanups.push(() => owners.dispose());
        const roots = { pluginData: projectRoot, workspace: projectRoot, projects: new Map<string, string>() };
        const selectedFactories: NonNullable<ProjectFiniteActionRuntime['plugins']> = { resolveProjectNativeAdapter(reference, role) {
            return resolveProjectNativeAdapter({ reference, role, targets, registry,
            createInvocationContext(input) {
                const target = targets.find(candidate => occurrenceIds.get(candidate.pluginId) === input.occurrenceId)!;
                const localId = target.pluginId === commandAdapter.pluginId ? commandAdapter.localId : pixiAdapter.localId;
                const lifetime = createPluginInvocationLifetime(input.signal);
                const observation = { signal: lifetime.signal };
                if (target.pluginId === pixiAdapter.pluginId) environmentInvocations.push(observation);
                else commandInvocations.push(observation);
                const seed = { plugin: { id: target.pluginId, version: target.manifest.version },
                    contribution: { id: localId, qualifiedId: `${target.pluginId}/projectNativeAdapters/${localId}` },
                    occurrenceId: input.occurrenceId, correlationId: 'finite-selected-native-effect', surface: 'cli' as const,
                    signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                    isOccurrenceCurrent: () => !lifetime.signal.aborted && input.isCurrent() };
                const hostAccessRequests = resolveManifestHostAccessRequestsForQualifiedContribution({ manifest: target.manifest,
                    pluginId: target.pluginId, contribution: seed.contribution });
                if (!hostAccessRequests) { lifetime.complete(); throw new Error('Selected native invocation lost its declared HostAccess'); }
                try {
                    return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                        filesystemRoots: { ...roots, workspace: input.root }, environment: input.environment ?? {}, hostAccessRequests,
                    }) }, complete() {
                        if (target.pluginId === commandAdapter.pluginId) completedCommandInvocations += 1;
                        lifetime.complete();
                    } };
                } catch (error) { lifetime.complete(); throw error; }
            },
        }); } };
        const workspace = { id: 'native-workspace', serverId: 'native-home', machineId: 'native-machine', rootPath: projectRoot, projectKey: 'native-project', createdAtMs: 1 };
        const httpBaseUrl = 'https://native-home.example';
        const requesterToken = 'native-requester-token';
        let trust: ProjectTrustContentV1 | null = null;
        // Only requester Home HTTP and PTY IO are simulated. Row opening,
        // trust/effect admission, native leases and operation custody stay real.
        const httpGet = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
            expect(url).toBe(`${httpBaseUrl}/v1/account/encryption`);
            expect(options?.headers).toMatchObject({ Authorization: `Bearer ${requesterToken}` });
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        cleanups.push(() => { httpGet.mockRestore(); });
        const httpPost = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
            expect(options?.headers).toMatchObject({ Authorization: `Bearer ${requesterToken}` });
            if (url === `${httpBaseUrl}${PROJECT_TRUST_ROUTE_V1}/read`) {
                expect(body).toEqual({ project: { serverId: workspace.serverId, projectId: workspace.projectKey } });
                return { status: 200, data: trust ? { status: 'present', revision: 1, content: trust } : { status: 'absent' } };
            }
            if (url === `${httpBaseUrl}${PROJECT_TRUST_ROUTE_V1}/mutate`) {
                const mutation = ProjectTrustMutationRequestV1Schema.parse(body);
                expect(mutation.project).toEqual({ serverId: workspace.serverId, projectId: workspace.projectKey });
                trust = mutation.content;
                return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
            }
            expect(url).toBe(`${httpBaseUrl}${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`);
            expect(body).toEqual({});
            const key = { kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.id };
            return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 1, content: { t: 'plain', v: { key, value: workspace } } }] } };
        });
        cleanups.push(() => { httpPost.mockRestore(); });
        const spawned: Array<{ params: PtySpawnParams; exit(event: PtyExitEvent): void }> = [];
        const spawnObservers = new Set<() => void>();
        const waitForSpawn = (minimum: number) => new Promise<void>(resolve => {
            const observe = () => {
                if (spawned.length < minimum) return;
                spawnObservers.delete(observe);
                resolve();
            };
            spawnObservers.add(observe);
            cleanups.push(() => { spawnObservers.delete(observe); });
            observe();
        });
        const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn(params) {
            const exits = new Set<(event: PtyExitEvent) => void>();
            spawned.push({ params, exit(event) { for (const listener of exits) listener(event); } });
            for (const observe of spawnObservers) observe();
            return { pid: 12345, ownedProcessGroupId: 12345, write() {}, resize() {}, kill() {}, onData() { return { dispose() {} }; },
                onExit(listener) { exits.add(listener); return { dispose() { exits.delete(listener); } }; } };
        // This fake OS spawn has no descendants once its exit event fires.
        } }, probeProcessGroup: () => 'absent', config: { maxSessions: 2, idleTimeoutMs: 0, bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
            bufferRetentionMs: 600_000, urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 } });
        cleanups.push(() => { terminals.dispose(); });
        let operationSequence = 0;
        const operationRuntime = createHostActionOperationRuntime({ machineId: workspace.machineId, resolveAccountId: async () => 'native-requester',
            generateOperationId: () => stopNativePreparation ? operationSequence++ === 0 ? 'native-owner-operation' : 'native-next-operation'
                : holdCapacity && operationSequence++ === 0 ? 'native-capacity-operation' : 'native-owner-operation' });
        const workspaceConfig = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
            randomBytes: length => new Uint8Array(length), transport: { read: async () => ({ status: 'absent' }), mutate: async () => { throw new Error('Read-only preference'); } } });
        const runtime: ProjectFiniteActionRuntime = { accountId: 'native-requester', serverId: workspace.serverId, machineId: workspace.machineId,
            credentials: { token: requesterToken, encryption: null }, serverHttpBaseUrl: httpBaseUrl, isCurrent: async () => true,
            operationRuntime, terminalSessions: terminals, successHomeDir: join(projectRoot, 'success'), hostEnvironment: {},
            workerAdmission: createProjectWorkerAdmission({ machineId: workspace.machineId, admissionDrain: createDaemonAdmissionDrain(),
                readPolicy: async () => ({ status: 'ready', source: 'default', policy: { accepting: true, runAtMost: holdCapacity || stopNativePreparation ? 1 : null }, metadataVersion: 1 }) }),
            resolveWorkspaceExecutionConfig: async () => workspaceConfig, plugins: selectedFactories,
            nativeIo: { async resolveTool() { throw new Error('Plugin-native commands cannot fall back to built-in IO'); } },
            environmentIo: createProjectNativeEnvironmentIoForHost({ async resolveTool() {
                throw new Error('Plugin-native environment cannot fall back to built-in IO');
            } }),
        };
        const signal = new AbortController();
        cleanups.push(() => {
            signal.abort();
            for (const spawnedProcess of spawned) spawnedProcess.exit({ exitCode: 1 });
        });
        const invoke = (name = 'check', requestId = 'native-owner-request') => createProjectFiniteAction(runtime, { signal: signal.signal, transportRequestId: requestId,
            machineAdmission: { actorAccountId: runtime.accountId, custodianAccountId: runtime.accountId, machineId: runtime.machineId,
                installationId: 'native-installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true })({
            actionId: 'projects.script.run', input: { workspace: { serverId: workspace.serverId, machineId: workspace.machineId, rootPath: projectRoot, workspaceId: workspace.id },
                selection: { kind: 'named', name } }, context: { authority: 'account_automation', serverId: runtime.serverId, actionRequestId: requestId },
        });
        const scope = { accountId: runtime.accountId, machineId: runtime.machineId };
        if (passiveOnly) {
            const ingress = { signal: signal.signal, machineAdmission: { actorAccountId: runtime.accountId,
                custodianAccountId: runtime.accountId, machineId: runtime.machineId, installationId: 'native-installation',
                role: 'manage' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
            const inspect = createProjectDefinitionAction({ serverId: runtime.serverId, machineId: runtime.machineId,
                workingDirectory: projectRoot, accessPolicy: { kind: 'restrictedRoots', roots: [projectRoot] }, nativeIo: runtime.nativeIo,
                inspectSetupReadiness: ({ workspace, context }) => inspectProjectSetupReadinessFromRuntime({ runtime, ingress, workspace, context }) });
            const result = await inspect({ actionId: 'projects.inspect', input: { workspace: {
                serverId: workspace.serverId, machineId: workspace.machineId, rootPath: projectRoot, workspaceId: workspace.id,
            } }, context: { authority: 'account_automation', serverId: runtime.serverId } });
            expect(commandInvocations).toEqual([]);
            expect(environmentInvocations).toEqual([]);
            expect(commandEffects).toBe(0);
            expect(executableOwners).toEqual([]);
            expect(spawned).toEqual([]);
            expect(result).toMatchObject({ setupReadiness: { kind: 'unknown', code: 'native_setup_readiness_unresolved' } });
            return;
        }
        const waitForRunningOperation = (operationId: string) => new Promise<void>(resolve => {
            const observe = () => {
                const state = operationRuntime.store.get(scope, operationId)?.state;
                if (state !== 'running' && state !== 'failed') return;
                unsubscribe();
                resolve();
            };
            const unsubscribe = operationRuntime.store.subscribe(observe);
            cleanups.push(unsubscribe);
            observe();
        });
            const reviewedInvocations = new Set<ProjectNativeEffectCaptureForHost>();
            cleanups.push(async () => { await Promise.all([...reviewedInvocations].map(production => production.release())); });
            const reviewed = await prepareProjectSetup({ workspace, projectAssociation: { workspace, project: { serverId: workspace.serverId, projectId: workspace.projectKey } },
                requester: { credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl }, purpose: 'setup',
                platform: { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch }, nativeIo: runtime.nativeIo, plugins: selectedFactories,
                successHomeDir: runtime.successHomeDir, retainNativeInvocation: production => reviewedInvocations.add(production) });
            if (reviewed.kind !== 'pendingApproval') throw new Error(`Expected actual unremembered review: ${reviewed.kind}`);
            expect(commandInvocations).toEqual([]); expect(reviewedInvocations.size).toBe(0); expect(commandEffects).toBe(0);
            expect(environmentEffects).toBe(0); expect(executableOwners).toEqual([]); expect(spawned).toEqual([]);
            await createProjectSetupTrustClient({ credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl }).approveReviewedEffect({
                project: reviewed.plan.project, reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, currentEffectDigest: reviewed.plan.reviewedEffectDigest,
                approvedAtMs: 1, expectedRevision: 'absent', authority: 'present_user',
            });
            await Promise.all([...reviewedInvocations].map(production => production.release()));
            if (stopNativePreparation) {
                const completedBeforeUnknown = completedCommandInvocations;
                // Only the OS tree-termination boundary is faulted. Exec,
                // selected invocation custody, the runner and FIFO stay real.
                const termination = vi.spyOn(processTreeBoundary, 'killProcessTree')
                    .mockRejectedValueOnce(new Error('OS could not prove native preparation tree absent'));
                cleanups.push(async () => {
                    termination.mockRestore();
                    await nativePreparationProcess?.dispose();
                });
                const diagnostic = async (phase: string, ready: boolean) => {
                    const first = operationRuntime.store.get(scope, 'native-owner-operation');
                    const next = operationRuntime.store.get(scope, 'native-next-operation');
                    return JSON.stringify({ phase, ready, first: first && { state: first.state, error: first.error,
                        observation: first.observation, setupReview: first.setupReview },
                        next: next && { state: next.state, error: next.error, setupReview: next.setupReview },
                        load: await runtime.workerAdmission.load(), spawned: spawned.length,
                        completedCommandInvocations, terminationAttempts: termination.mock.calls.length });
                };
                await expect(invoke()).resolves.toMatchObject({ operation: { operationId: 'native-owner-operation' } });
                await expect.poll(() => diagnostic('native uncertainty', operationRuntime.store.get(scope, 'native-owner-operation')?.observation?.kind === 'outcome_uncertain')).toContain('"ready":true');
                const pid = nativePreparationProcess && readSupervisedPluginProcessIdForHost(nativePreparationProcess);
                if (!pid) throw new Error('Expected a real owned native preparation process');
                expect(process.kill(pid, 0)).toBe(true);
                expect(completedCommandInvocations).toBe(completedBeforeUnknown);
                expect(spawned).toEqual([]);
                await expect(invoke('hold', 'native-next-request')).resolves.toMatchObject({ operation: { operationId: 'native-next-operation' } });
                expect(await runtime.workerAdmission.load()).toMatchObject({ kind: 'known', running: 1, queued: 1 });
                expect(await operationRuntime.handlers.cancel({ operationId: 'native-owner-operation' })).toEqual({ kind: 'requested' });
                await expect.poll(async () => {
                    let absent = false;
                    try { process.kill(pid, 0); } catch (error) {
                        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') absent = true;
                        else throw error;
                    }
                    return await diagnostic('native process absent after public Stop', absent);
                }).toContain('"ready":true');
                expect(await operationRuntime.handlers.cancel({ operationId: 'native-owner-operation' })).toEqual({ kind: 'requested' });
                // Tree proof must settle the SAME original invocation, rather
                // than leave an immortal unknown reservation after public Stop.
                await expect.poll(() => diagnostic('original operation terminal', operationRuntime.store.get(scope, 'native-owner-operation')?.state === 'cancelled')).toContain('"ready":true');
                await waitForSpawn(1);
                expect(completedCommandInvocations).toBeGreaterThan(completedBeforeUnknown);
                return;
            }
            if (holdCapacity) {
                await expect(invoke('hold', 'native-capacity-request')).resolves.toMatchObject({ operation: { operationId: 'native-capacity-operation' } });
                await waitForRunningOperation('native-capacity-operation');
                expect(operationRuntime.store.get(scope, 'native-capacity-operation')?.error).toBeUndefined();
                expect(operationRuntime.store.get(scope, 'native-capacity-operation')).toMatchObject({ state: 'running' });
                expect(commandEffects).toBe(0);
            }
            await expect(invoke()).resolves.toMatchObject({ operation: { operationId: 'native-owner-operation' } });
            if (holdCapacity) {
                await expect.poll(() => runtime.workerAdmission.dependencies({ workspaceRefId: workspace.id })
                    .find(dependency => dependency.operationId === 'native-owner-operation')?.state).toBe('queued');
                expect(operationRuntime.store.get(scope, 'native-owner-operation')).toMatchObject({ state: 'accepted', progress: { kind: 'phase', phase: 'queued' } });
                // The reviewed source declaration may be read before admission;
                // a real selected adapter's Exec effects may not precede reservation.
                expect(commandEffects).toBe(0);
                expect(spawned).toHaveLength(1);
                spawned[0]!.exit({ exitCode: 0 });
                await waitForSpawn(2);
                expect(spawned).toHaveLength(2);
                await expect.poll(() => operationRuntime.store.get(scope, 'native-capacity-operation')?.domainRef).toMatchObject({
                    kind: 'projectCommand', purpose: 'script', terminalId: expect.any(String),
                });
                spawned[1]!.exit({ exitCode: 0 });
            }
            // Observe the owning operation's transition, not a shorter polling
            // deadline competing with real native process-tree settlement.
            await waitForRunningOperation('native-owner-operation');
            // Missing selected-environment capture must fail here, not be hidden
            // by supplying a separate static Exec service to the finalizer.
            // The canonical safe operation error distinguishes that producer
            // absence from a fixture or earlier admission failure on RED.
            expect(operationRuntime.store.get(scope, 'native-owner-operation')?.error).toBeUndefined();
            expect(operationRuntime.store.get(scope, 'native-owner-operation')).toMatchObject({ state: 'running', domainRef: { kind: 'projectCommand', purpose: holdCapacity ? 'script' : 'setup', terminalId: expect.any(String) } });
            expect(environmentInvocations.some(invocation => !invocation.signal.aborted)).toBe(true);
            expect(commandInvocations.some(invocation => !invocation.signal.aborted)).toBe(true);
            const firstCommand = holdCapacity ? 2 : 0;
            expect(spawned[firstCommand]?.params).toMatchObject({ file: wrapperPath, args: ['run', '--', commandPath, 'check'], options: { cwd: projectRoot, env: {} } });
            spawned[firstCommand]!.exit({ exitCode: 0 });
            if (!holdCapacity) {
            await waitForSpawn(firstCommand + 2);
            expect(spawned).toHaveLength(firstCommand + 2);
            expect(spawned[firstCommand + 1]!.params).toMatchObject({ file: wrapperPath, args: ['run', '--', commandPath, 'check'], options: { cwd: projectRoot, env: {} } });
            spawned[firstCommand + 1]!.exit({ exitCode: 0 });
            }
            await expect.poll(() => operationRuntime.store.get(scope, 'native-owner-operation')?.state).toBe('succeeded');
            expect(executableOwners).toContain(commandAdapter.pluginId);
            expect(executableOwners).toContain(pixiAdapter.pluginId);
            expect(environmentEffects).toBeGreaterThan(0);
            expect(environmentInvocations.every(invocation => invocation.signal.aborted)).toBe(true);
            expect(commandInvocations.every(invocation => invocation.signal.aborted)).toBe(true);
        } finally {
            for (const cleanup of cleanups.reverse()) await cleanup();
        }
    }

    it('runs a finite native command through the selected environment plugin invocation rather than the command plugin owner', () => exerciseSelectedNativeInvocations(false));
    it('passively inspects installed native setup without acquiring production or executing its resolver', () => exerciseSelectedNativeInvocations(true, false, true));
    it('parks primary native command effects behind the same finite reservation while capacity is held', () => exerciseSelectedNativeInvocations(true));
    it('settles the original uncertain native preparation through repeated public Stop before admitting the next FIFO job', () => exerciseSelectedNativeInvocations(false, true));

    it('keeps provisioner descriptor listing cold and demands only the selected or retained leaf', async () => {
        const ids = ['acme.provisioner.one', 'acme.provisioner.two'];
        const occurrenceIdsByPluginId = new Map(ids.map((id) => [id, createPluginRuntimeOccurrenceId(id)]));
        const inputs = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: ids.map(createLoadedMachineProvisionerFixture), diagnosticsByPluginId: {} },
            provenance: 'first_party',
        });
        const contributes = createResolvedContributionRegistry({ ...inputs,
            occurrenceIdsByPluginId: Object.fromEntries(occurrenceIdsByPluginId),
        });
        const loads = new Map(ids.map((pluginId) => [pluginId, vi.fn(async () => ({ activate(api: PluginApi) {
            for (const role of machineProvisionerFixtureRoleIds) api.actions.register(role, async () => ({}));
        } }))]));
        const registry = await activatePluginRuntimeRegistry({ contributes, occurrenceIdsByPluginId, generation: 39,
            resolveActivationSource: (target) => ({ kind: 'bundled', moduleId: `${target.pluginId}/daemon`, load: loads.get(target.pluginId)! }),
        });
        const retainedResource = { contributionRef: { pluginId: ids[0]!, localId: 'guest' } };
        const demand = { ...retainedResource.contributionRef, family: 'machineProvisioners' };
        try {
            // The executable-registry owner allocates cold candidate occurrences
            // before the manager imports any selected leaf.
            const listing = buildPluginProjectionV2({ registry: contributes, generation: 39 });
            expect(Object.keys(listing.familiesById.machineProvisioners?.entriesById ?? {})).toEqual(ids.map((id) => `${id}/guest`));
            for (const load of loads.values()) expect(load).not.toHaveBeenCalled();
            await registry.activateContributionsOnDemand([{ ...demand, localId: 'undeclared' }]);
            for (const load of loads.values()) expect(load).not.toHaveBeenCalled();
            await registry.activateContributionsOnDemand([demand]);
            expect(loads.get(ids[0]!)).toHaveBeenCalledOnce();
            expect(loads.get(ids[1]!)).not.toHaveBeenCalled();
            expect(registry.targetRegistrations.map((entry) => entry.pluginId)).toEqual(machineProvisionerFixtureRoleIds.map(() => ids[0]!));
            // Reopening a retained native resource uses this same family demand.
            await registry.activateContributionsOnDemand([demand]);
            expect(loads.get(ids[0]!)).toHaveBeenCalledOnce();
            const occurrence = registry.readPluginOccurrenceId(ids[0]!)!;
            await registry.dispose();
            expect(registry.isPluginOccurrenceCurrent(ids[0]!, occurrence)).toBe(false);
            expect(registry.targetRegistrations).toEqual([]);
            await registry.activateContributionsOnDemand([demand]);
            expect(loads.get(ids[0]!)).toHaveBeenCalledOnce();
        } finally { await registry.dispose(); }
    });

    it('keeps native adapters dormant and hands exact native command resources to retained lifecycle supervision', async () => {
        const pluginId = 'acme.pixi';
        const root = await mkdtemp(join(tmpdir(), 'happier-native-resource-'));
        await writeFile(join(root, 'pixi.toml'), '[services.dev]');
        const instance = { adapter: { pluginId, localId: 'pixi' }, nativeResourceId: 'retained-dev-service' };
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { projectNativeAdapters: [{ id: 'pixi', files: ['pixi.toml'], roles: ['detect', 'resolveCommand', 'produceEnvironment', 'nativeServiceLifecycle'] }] },
        }, { sourceProvenance: 'registryCustodied' });
        expect(ingested.ok).toBe(true);
        if (!ingested.ok) throw new Error('Expected admitted native adapter');
        const load = vi.fn(async () => ({ activate(api: PluginApi) {
            api.projectNativeAdapters.register('pixi', {
                detect: async () => ({ entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }),
                resolveCommand: async request => ({ kind: 'resolved', executable: { kind: 'systemTool', id: 'pixi' }, args: ['services', 'start', request.source.target],
                    cwd: request.root, reviewInputs: request.files, nativeInstance: request.source.target === 'wrong-adapter'
                        ? { ...instance, adapter: { pluginId: 'other.plugin', localId: 'pixi' } } : instance }),
                produceEnvironment: async () => ({ kind: 'unsupported', code: 'fixture_no_environment' }),
                nativeServiceLifecycle: {
                    async inspect(_instance, _options, context) {
                        if (!context) throw new Error('Native inspection lost admitted invocation services');
                        expect(new TextDecoder().decode(await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' }))).toBe('[services.dev]');
                        return { phase: 'running', readiness: 'not_reported', endpoint: null };
                    },
                    stop: async () => ({ status: 'stopped' }),
                },
            });
        } }));
        const contributes = createResolvedContributionRegistry({
                activationTargets: [{ provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                    manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.mjs',
                    sourceSpec: { kind: 'package', locator: '@acme/pixi', trustPolicy: 'local_trusted', installPolicy: 'copy' },
                    activationEvents: [], manifest: ingested.manifest }],
            });
        const registry = await activatePluginRuntimeRegistry({
            contributes,
            generation: 38,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@acme/pixi/daemon', load }),
        });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => tmpdir(),
            async resolveExecutable() { throw new Error('Resource handoff must not execute the launcher'); },
        } });
        let production: ProjectNativeAdapterProductionV1 | undefined;
        try {
            expect(load).not.toHaveBeenCalled();
            await registry.activateContributionsOnDemand([{ pluginId, family: 'projectNativeAdapters', localId: 'pixi' }]);
            expect(registry.targetRegistrations).toEqual([expect.objectContaining({ pluginId, registration: expect.objectContaining({ family: 'projectNativeAdapters', localId: 'pixi' }) })]);
            const selected = await resolveProjectNativeAdapter({ reference: instance.adapter, role: 'resolveCommand', targets: contributes.activationTargets, registry,
                createInvocationContext(input) {
                    const lifetime = createPluginInvocationLifetime(input.signal);
                    const seed = { plugin: { id: pluginId, version: '1.0.0' },
                        contribution: { id: 'pixi', qualifiedId: `${pluginId}/projectNativeAdapters/pixi` },
                        occurrenceId: input.occurrenceId, correlationId: 'native-instance-test', surface: 'cli' as const,
                        signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: input.isCurrent };
                    return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                        filesystemRoots: { pluginData: input.root, workspace: input.root, projects: new Map() }, hostAccessRequests: [],
                    }) }, complete() { lifetime.complete(); } };
                },
            });
            if (selected.kind !== 'ready') throw new Error('Expected native service role');
            const acquired = selected.lease.acquireProduction({ root });
            if (acquired.kind !== 'ready') throw new Error(acquired.code);
            production = acquired.production;
            const request = { root, adapter: instance.adapter, files: [{ file: 'pixi.toml', content: '[services.dev]' }],
                source: { kind: 'pluginNative' as const, adapter: instance.adapter, file: 'pixi.toml', target: 'dev' } };
            await expect(production.resolveCommand(request)).resolves.toMatchObject({ kind: 'resolved', nativeInstance: instance });
            await expect(production.resolveCommand({ ...request, source: { ...request.source, target: 'wrong-adapter' } }))
                .resolves.toEqual({ kind: 'failed', code: 'native_adapter_reference_mismatch' });
            await expect(resolveProjectNativeCommand({ root, source: request.source, usage: 'service',
                io: { resolveTool: async () => null }, plugin: { lease: production } })).resolves.toMatchObject({ kind: 'pluginResolved', command: { nativeInstance: instance } });
            await expect(resolveProjectNativeCommand({ root, source: request.source, usage: 'script',
                io: { resolveTool: async () => null }, plugin: { lease: production } })).resolves.toEqual({ kind: 'refused', reason: 'unsupported', code: 'native_service_only' });
            expect(selected.lease.captureNativeServiceLifecycle({ ...instance, adapter: { pluginId: 'other.plugin', localId: 'pixi' } }, { root }))
                .toEqual({ kind: 'refused', code: 'native_adapter_reference_mismatch' });
            const captured = selected.lease.captureNativeServiceLifecycle(instance, { root });
            if (captured.kind !== 'ready') throw new Error('Expected admitted retained lifecycle');
            await expect(captured.lifecycle.inspect(instance)).resolves.toMatchObject({ phase: 'running' });
            await registry.dispose();
            await expect(captured.lifecycle.stop(instance)).resolves.toEqual({ status: 'stopped' });
            await expect(captured.lifecycle.stop({ ...instance, nativeResourceId: 'other-service' })).resolves.toEqual({ status: 'unsupported' });
            await expect(captured.lifecycle.stop({ ...instance, adapter: { pluginId: 'other.plugin', localId: 'pixi' } })).resolves.toEqual({ status: 'unsupported' });
            await expect(captured.lifecycle.inspect(instance)).rejects.toMatchObject({ code: 'native_adapter_retired' });
            await captured.release();
            expect(selected.lease.captureNativeServiceLifecycle(instance, { root })).toEqual({ kind: 'refused', code: 'native_adapter_retired' });
        } finally { await production?.release(); await owners.dispose(); await registry.dispose(); await rm(root, { recursive: true, force: true }); }
    });

    it('joins slow on-demand module loading and activation without phase deadlines', async () => {
        vi.useFakeTimers();
        const pluginId = 'acme.slow-lazy';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: pluginId,
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected valid lazy activation fixture');
        let releaseLoad!: () => void;
        let releaseActivation!: () => void;
        const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
        const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve; });
        const load = vi.fn(async () => {
            await loadGate;
            return {
                async activate(api: PluginApi) {
                    await activationGate;
                    api.actions.register('run', async () => ({ ok: true }));
                },
            };
        });
        const registry = await activatePluginRuntimeRegistry({
            contributes: {
                agents: [], actions: [], resources: [],
                activationTargets: [{
                    provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                    manifestPath: '/virtual/slow/plugin.json', daemonEntryPath: '/virtual/slow/daemon.mjs',
                    sourceSpec: { kind: 'package', locator: '@happier-dev/slow-lazy', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                    activationEvents: [], manifest: ingested.manifest,
                }],
                catalogEntriesById: Object.freeze({}), agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: Object.freeze({}),
            } as unknown as ResolvedContributionRegistry,
            generation: 27,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@happier-dev/slow-lazy/daemon', load }),
        });
        const demand = [{ pluginId, family: 'actions' as const, localId: 'run' }];
        let settled = false;
        const activation = Promise.all([
            registry.activateContributionsOnDemand(demand),
            registry.activateContributionsOnDemand(demand),
        ]).then((results) => { settled = true; return results; });
        try {
            await vi.advanceTimersByTimeAsync(30_001);
            expect(settled).toBe(false);
            expect(registry.failedActivationPluginIds.has(pluginId)).toBe(false);
            releaseLoad();
            await vi.advanceTimersByTimeAsync(30_001);
            expect(settled).toBe(false);
            expect(registry.failedActivationPluginIds.has(pluginId)).toBe(false);
            releaseActivation();
            await activation;
            expect(load).toHaveBeenCalledOnce();
            expect(registry.activatedPluginIds.has(pluginId)).toBe(true);
            expect(registry.targetRegistrations).toEqual([expect.objectContaining({ pluginId })]);
        } finally {
            releaseLoad();
            releaseActivation();
            await activation;
            await registry.dispose();
            vi.useRealTimers();
        }
    });

    it('continues bundled source preparation beyond the starter readiness wait', async () => {
        vi.useFakeTimers();
        let releasePreparation!: () => void;
        const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
        const pluginId = 'acme.prepare-hangs';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: pluginId,
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            contributes: {},
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected valid preparation fixture');
        const load = vi.fn(async () => ({ activate: vi.fn() }));
        const activation = activatePluginRuntimeRegistry({
            contributes: {
                agents: [], actions: [], resources: [],
                activationTargets: [{
                    provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                    manifestPath: '/virtual/prepare/plugin.json', daemonEntryPath: '/virtual/prepare/daemon.mjs',
                    sourceSpec: { kind: 'package', locator: '@happier-dev/prepare-hangs', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                    activationEvents: ['startup'], manifest: ingested.manifest,
                }],
                catalogEntriesById: Object.freeze({}),
                agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: Object.freeze({}),
            } as unknown as ResolvedContributionRegistry,
            generation: 26,
            resolveActivationSource: () => ({
                kind: 'bundled', moduleId: '@happier-dev/prepare-hangs/daemon',
                prepare: () => preparation,
                load,
            }),
        });
        try {
            let settled = false;
            void activation.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(60_001);
            expect(settled).toBe(false);
            releasePreparation();
            const registry = await activation;
            expect(registry.targetActivationFacts).toEqual([
                expect.objectContaining({ pluginId, status: 'active', diagnostics: [] }),
            ]);
            expect(load).toHaveBeenCalledOnce();
            await registry.dispose();
        } finally {
            releasePreparation();
            await activation.then((registry) => registry.dispose());
            vi.useRealTimers();
        }
    }, 5_000);

    it('loads a slow cold-start module and its later peer after the starter wait expires', async () => {
        vi.useFakeTimers();
        let releaseLoad!: () => void;
        const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
        const hangingPluginId = 'acme.module-load-hangs';
        const healthyPluginId = 'acme.module-load-healthy';
        const createIngestedManifest = (pluginId: string) => ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: pluginId,
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            contributes: {},
        }, { sourceProvenance: 'registryCustodied' });
        const hangingManifest = createIngestedManifest(hangingPluginId);
        const healthyManifest = createIngestedManifest(healthyPluginId);
        if (!hangingManifest.ok || !healthyManifest.ok) {
            throw new Error('Expected valid module-load deadline fixtures');
        }
        const activateHealthy = vi.fn();
        const activation = activatePluginRuntimeRegistry({
            contributes: {
                agents: [], actions: [], resources: [],
                activationTargets: [
                    {
                        provenance: 'first_party', source: { kind: 'bundled' }, pluginId: hangingPluginId,
                        manifestPath: '/virtual/hanging/plugin.json', daemonEntryPath: '/virtual/hanging/daemon.mjs',
                        sourceSpec: { kind: 'package', locator: '@happier-dev/module-load-hangs', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                        activationEvents: ['startup'], manifest: hangingManifest.manifest,
                    },
                    {
                        provenance: 'first_party', source: { kind: 'bundled' }, pluginId: healthyPluginId,
                        manifestPath: '/virtual/healthy/plugin.json', daemonEntryPath: '/virtual/healthy/daemon.mjs',
                        sourceSpec: { kind: 'package', locator: '@happier-dev/module-load-healthy', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                        activationEvents: ['startup'], manifest: healthyManifest.manifest,
                    },
                ],
                catalogEntriesById: Object.freeze({}),
                agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: Object.freeze({}),
            } as unknown as ResolvedContributionRegistry,
            generation: 25,
            resolveActivationSource: (target) => target.pluginId === hangingPluginId
                ? {
                    kind: 'bundled',
                    moduleId: '@happier-dev/module-load-hangs/daemon',
                    load: async () => { await loadGate; return { activate: vi.fn() }; },
                }
                : {
                    kind: 'bundled',
                    moduleId: '@happier-dev/module-load-healthy/daemon',
                    load: async () => ({ activate: activateHealthy }),
                },
        });

        try {
            let settled = false;
            void activation.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(60_001);
            expect(settled).toBe(false);
            releaseLoad();
            const registry = await activation;
            expect(registry.targetActivationFacts).toEqual([
                expect.objectContaining({
                    pluginId: hangingPluginId,
                    status: 'active',
                    diagnostics: [],
                }),
                expect.objectContaining({
                    pluginId: healthyPluginId,
                    status: 'active',
                    diagnostics: [],
                }),
            ]);
            expect(activateHealthy).toHaveBeenCalledOnce();
            await registry.dispose();
        } finally {
            releaseLoad();
            await activation.then((registry) => registry.dispose());
            vi.useRealTimers();
        }
    }, 5_000);

    it('projects required HostAccess directly for static daemon consumers without a legacy grant map', async () => {
        const pluginId = 'acme.host-access-projection';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Host access projection',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [
                    {
                        id: 'workspace-read',
                        capability: 'filesystem',
                        reason: 'Observe a bounded workspace subtree.',
                        scope: {
                            locations: [{ root: 'workspace', pathPrefix: 'observed' }],
                            access: ['read'],
                        },
                    },
                    {
                        id: 'plugin-data-read',
                        capability: 'filesystem',
                        reason: 'Read plugin-local state through normal invocation services.',
                        scope: {
                            locations: [{ root: 'pluginData', pathPrefix: 'state' }],
                            access: ['read'],
                        },
                    },
                    {
                        id: 'runtime-environment',
                        capability: 'environment',
                        reason: 'Pass the declared environment variable to an SCM operation.',
                        scope: { keys: ['FORGE_TOKEN'] },
                    },
                    {
                        id: 'runtime-process',
                        capability: 'process',
                        reason: 'Run the declared executable with its declared variable.',
                        scope: { executables: [{ kind: 'systemTool', id: 'forge' }], envKeys: ['FORGE_REGION'] },
                    },
                ],
                optional: [],
            },
            contributes: {
                actions: [{
                    id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'],
                    execution: { target: 'daemon' },
                    placementBindings: ['primary'], dangerLevel: 'safe',
                }],
                systemTools: [{ id: 'forge', title: 'Forge', executableNames: ['forge'] }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));

        const activated = await activatePluginRuntimeRegistry({
            contributes: {
                agents: [], actions: [], resources: [],
                activationTargets: [{
                    provenance: 'external', source: { kind: 'path' }, pluginId,
                    manifestPath: '/virtual/happier.plugin.json', daemonEntryPath: '/virtual/daemon.mjs',
                    sourceSpec: { kind: 'path', locator: '/virtual', trustPolicy: 'local_trusted', installPolicy: 'copy' },
                    activationEvents: [], manifest: ingested.manifest,
                }],
                catalogEntriesById: Object.freeze({}),
                agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: Object.freeze({}),
            } as unknown as ResolvedContributionRegistry,
            generation: 24,
            occurrenceIdsByPluginId: new Map([[
                pluginId,
                'candidate:host-access-projection' as PluginRuntimeOccurrenceId,
            ]]),
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/host-access-projection',
                sourceAuthority: {
                    kind: 'bundled_first_party',
                    packagedRuntime: {
                        kind: 'cli_version_root',
                        versionRootId: 'cli-version-root-a',
                    },
                    resolvedRoot: '/virtual',
                },
                load: async () => ({
                    activate(api: PluginApi) {
                        api.actions.register('run', async () => ({ ok: true }));
                    },
                }),
            }),
        });

        try {
            await activated.activatePluginsForValidation([pluginId]);
            expect(activated).not.toHaveProperty('permissionsByPluginId');
            expect(activated.filesystemReadAllowedPathsByPluginId.get(pluginId))
                .toEqual(new Set(['observed']));
            expect(activated.envAllowedNamesByPluginId.get(pluginId))
                .toEqual(new Set(['FORGE_REGION', 'FORGE_TOKEN']));
            expect(activated.readPluginSourceCustody(pluginId)).toEqual({
                kind: 'bundled_first_party',
                packagedRuntime: {
                    kind: 'cli_version_root',
                    versionRootId: 'cli-version-root-a',
                },
            });
            expect(activated.readPluginOccurrenceId(pluginId)).toBe(
                'candidate:host-access-projection',
            );
        } finally {
            await activated.dispose();
        }
    });

    it.each([
        ['admits', 'manual', 'active'],
        ['rejects before publication', 'oauthDeviceCode', 'unavailable'],
    ] as const)(
        '%s an external Connected Account runtime only when it matches its declared authentication mode',
        async (_expectation, runtimeKind, expectedStatus) => {
            const pluginId = expectedStatus === 'active'
                ? 'acme.external.accounts.matched'
                : 'acme.external.accounts.mismatch';
            const ingested = ingestCanonicalPluginManifest({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'External account fixture',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                contributes: {
                    connectedAccountDescriptors: [{
                        id: 'forge',
                        title: 'Forge account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string' },
                                    secret: true,
                                }],
                            }],
                        },
                    }],
                },
            }, { sourceProvenance: 'registryCustodied' });
            if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
            const activate = vi.fn((api: PluginApi) => {
                api.connectedAccounts.register('forge', {
                    authentication: {
                        modes: {
                            manual: runtimeKind === 'manual'
                                ? {
                                    kind: 'manual',
                                    async complete() { return { status: 'rejected' as const }; },
                                }
                                : {
                                    kind: 'oauthDeviceCode',
                                    async begin() { return { status: 'failed' as const }; },
                                    async poll() { return { status: 'failed' as const }; },
                                    async cancel() {},
                                },
                        },
                    },
                    async refresh() { return { status: 'connected' as const }; },
                    async revoke() { return { status: 'remoteUnsupported' as const }; },
                    async status() { return { status: 'connected' as const }; },
                    async materialize() { return { kind: 'environment' as const, env: {} }; },
                } as never);
            });
            const activated = await activatePluginRuntimeRegistry({
                contributes: {
                    agents: [], actions: [], resources: [],
                    activationTargets: [{
                        provenance: 'external', source: { kind: 'path' }, pluginId,
                        manifestPath: '/virtual/happier.plugin.json',
                        daemonEntryPath: '/virtual/daemon.mjs',
                        sourceSpec: {
                            kind: 'path', locator: '/virtual', trustPolicy: 'prompt', installPolicy: 'copy',
                        },
                        activationEvents: [], manifest: ingested.manifest,
                    }],
                    catalogEntriesById: Object.freeze({}),
                    agentDefinitionsById: new Map(),
                    pluginDiagnosticsByPluginId: Object.freeze({}),
                } as unknown as ResolvedContributionRegistry,
                generation: 23,
                resolveActivationSource: () => ({
                    kind: 'bundled',
                    moduleId: `@happier-dev/${pluginId}`,
                    load: async () => ({ activate }),
                }),
            });

            try {
                await activated.activatePluginsForValidation([pluginId]);
                expect(activated.targetActivationFacts).toEqual([
                    expect.objectContaining({ pluginId, status: expectedStatus }),
                ]);
                if (expectedStatus === 'active') {
                    expect(activated.targetRegistrations).toEqual([
                        expect.objectContaining({
                            pluginId,
                            registration: expect.objectContaining({
                                family: 'connectedAccountDescriptors',
                                localId: 'forge',
                            }),
                        }),
                    ]);
                } else {
                    expect(activated.targetRegistrations).toEqual([]);
                    expect(activated.activatedPluginIds.has(pluginId)).toBe(false);
                }
            } finally {
                await activated.dispose();
            }
        },
    );

    it('scopes a native activation module by its committed immutable generation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-direct-activation-generation-'));
        const entryPath = join(root, 'daemon.mjs');
        const pluginId = 'acme.direct.activation';
        const evaluationCountKey = '__happierDirectActivationEvaluationCount';
        await writeFile(entryPath, [
            `globalThis[${JSON.stringify(evaluationCountKey)}] = (globalThis[${JSON.stringify(evaluationCountKey)}] ?? 0) + 1;`,
            'export function activate() {}',
            '',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Direct activation',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {},
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) {
            throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        }
        const createRegistry = () => ({
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId,
                manifestPath: join(root, 'happier.plugin.json'),
                daemonEntryPath: entryPath,
                sourceSpec: {
                    kind: 'path', locator: root, trustPolicy: 'prompt', installPolicy: 'copy',
                },
                activationEvents: ['startup'],
                manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry);
        const resolveActivationSource =
            await createCommittedFileBackedFixtureActivationSource({
                pluginId,
                root,
                entryPath,
            });
        let first: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> | null = null;
        let second: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> | null = null;
        try {
            first = await activatePluginRuntimeRegistry({
                contributes: createRegistry(),
                generation: 19,
                resolveActivationSource,
            });
            await first.dispose();
            second = await activatePluginRuntimeRegistry({
                contributes: createRegistry(),
                generation: 20,
                resolveActivationSource,
            });
            expect(Reflect.get(globalThis, evaluationCountKey)).toBe(1);
        } finally {
            await second?.dispose();
            await first?.dispose();
            Reflect.deleteProperty(globalThis, evaluationCountKey);
        }
    });

    it.each(['moduleLoad', 'activate'] as const)('does not retry a failed startup %s attempt during validation of the same generation', async (failurePhase) => {
        const pluginId = 'acme.validation.failed-startup';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Failed startup validation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-failed-startup', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: ['startup'], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const activate = vi.fn(() => {
            if (failurePhase === 'activate') throw new Error('rejected update');
        });
        const load = vi.fn(async () => {
            if (failurePhase === 'moduleLoad') throw new Error('rejected module');
            return { activate };
        });
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 14,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-failed-startup/daemon',
                load,
            }),
        });

        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(failurePhase === 'activate' ? 1 : 0);
        await activated.activatePluginsForValidation([pluginId]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(failurePhase === 'activate' ? 1 : 0);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({ pluginId, status: 'unavailable' }),
        ]);
        await activated.dispose();
    });

    it('retries startup source preparation once so package-local preflight can isolate an aggregate failure', async () => {
        const pluginId = 'acme.validation.startup-preparation-isolation';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Startup source preparation isolation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-startup-preparation-isolation', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: ['startup'], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const prepare = vi.fn()
            .mockRejectedValueOnce(new Error('bundled plugin workspace closure is stale'))
            .mockResolvedValueOnce(undefined);
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 15,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-startup-preparation-isolation/daemon',
                prepare,
                load,
            }),
        });

        expect(prepare).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({ pluginId, status: 'active' }),
        ]);
        await activated.dispose();
    });

    it('retries lazy activation on later demand only after bounded package isolation also fails', async () => {
        const pluginId = 'acme.validation.retryable-preparation';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Retryable source preparation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-retryable-preparation', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const prepare = vi.fn()
            .mockRejectedValueOnce(new Error('aggregate source-dev preparation selected package isolation'))
            .mockRejectedValueOnce(new Error('package-local source preparation is still unavailable'))
            .mockResolvedValueOnce(undefined);
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 15,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-retryable-preparation/daemon',
                prepare,
                load,
            }),
        });

        const demand = [{ pluginId, family: 'actions' as const, localId: 'run' }];
        const first = await activated.activateContributionsOnDemand(demand);

        expect(first).toEqual([expect.objectContaining({
            pluginId,
            diagnostics: [expect.objectContaining({
                code: 'plugin_daemon_module_load_failed',
                message: expect.stringContaining('package-local source preparation is still unavailable'),
            })],
        })]);
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(load).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
        expect(activated.targetActivationFacts).toEqual([]);

        await activated.activateContributionsOnDemand(demand);

        expect(prepare).toHaveBeenCalledTimes(3);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({ pluginId, status: 'active' }),
        ]);
        await activated.dispose();
    });

    it('does not load or activate a lazy bundled target after disposal completes during source preparation', async () => {
        const pluginId = 'acme.validation.disposed-preparation';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Disposed source preparation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-disposed-preparation', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        let releasePreparation!: () => void;
        let markPreparationEntered!: () => void;
        const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
        const preparationEntered = new Promise<void>((resolve) => { markPreparationEntered = resolve; });
        const prepare = vi.fn(async () => {
            markPreparationEntered();
            await preparationGate;
        });
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 15,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-disposed-preparation/daemon',
                prepare,
                load,
            }),
        });

        try {
            const demand = activated.activateContributionsOnDemand([{
                pluginId,
                family: 'actions',
                localId: 'run',
            }]);
            await preparationEntered;

            await activated.dispose();
            releasePreparation();
            await demand;

            expect(prepare).toHaveBeenCalledTimes(1);
            expect(load).not.toHaveBeenCalled();
            expect(activate).not.toHaveBeenCalled();
            expect(activated.targetActivationFacts).toEqual([]);
        } finally {
            releasePreparation();
            await activated.dispose();
        }
    });

    it('uses the contribution registration API for bundled targets', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.bundled', version: '1.0.0', displayName: 'Bundled target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './missing.mjs' },
            hostAccess: {
                required: [
                    {
                        id: 'api', capability: 'network', reason: 'Call the fixture API.',
                        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['POST'] },
                    },
                    {
                        id: 'external-session-files', capability: 'filesystem',
                        reason: 'Observe the declared workspace files.',
                        scope: {
                            locations: [{ root: 'workspace', pathPrefix: 'observed' }],
                            access: ['read'],
                        },
                    },
                    {
                        id: 'hosting-provider-environment', capability: 'environment',
                        reason: 'Pass the declared credential variable to the hosting provider.',
                        scope: { keys: ['FORGE_TOKEN'] },
                    },
                ],
                optional: [],
            },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                hooks: [{
                    id: 'after-spawn', on: 'session.spawned', category: 'lifecycle', scope: 'session',
                    executionKind: 'observe', priority: 12,
                }],
                mcp: {
                    servers: [],
                    discoverySources: [{ id: 'config', title: 'Config discovery' }],
                },
                scmBackends: [{
                    id: 'fixture', title: 'Fixture SCM', kind: 'git', capabilities: ['detect'],
                }],
                events: [{ id: 'review-ready-event', kind: 'event', title: 'Review ready' }],
                notifications: [{
                    id: 'review-ready', kind: 'activity', title: 'Review ready', eventIds: ['review-ready-event'],
                    defaultChannels: ['configured'],
                }],
                notificationChannels: [{
                    id: 'configured', kind: 'webhook', title: 'Configured delivery', configurable: true, defaultEnabled: true,
                }],
                systemTools: [{ id: 'fixture-cli', title: 'Fixture CLI', executableNames: ['fixture'] }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'acme.target.bundled',
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/missing.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-target-bundled', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 7,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-target-bundled/daemon',
                load: async () => ({
                    activate(api: PluginApi) {
                        api.actions.register('run', async () => ({ ok: true }));
                        api.hooks.register('after-spawn', async () => ({ handled: true }));
                        api.mcp.registerDiscoverySource('config', async () => ({
                            items: [],
                            endpoints: [],
                        }));
                        api.scm.registerBackend('fixture', {
                            handlers: {
                                detection: {
                                    detectRepo: async ({ cwd }) => ({
                                        isRepo: true,
                                        rootPath: cwd,
                                        mode: '.git',
                                    }),
                                },
                            },
                        });
                        api.notifications.registerChannel('configured', async (request) => ({
                            deliveryId: request.deliveryId,
                            channelId: request.channelId,
                            status: 'accepted',
                            evidence: 'provider',
                        }));
                    },
                }),
            }),
        });

        expect(activated.targetActivationFacts).toEqual([]);
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.bundled',
            family: 'notificationChannels',
            localId: 'configured',
        }]);
        expect(activated.pluginDiagnosticsByPluginId['acme.target.bundled']).toEqual([]);
        expect(activated.targetRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target.bundled', occurrenceId: activated.readPluginOccurrenceId('acme.target.bundled'),
                registration: expect.objectContaining({ family: 'actions', localId: 'run' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', occurrenceId: activated.readPluginOccurrenceId('acme.target.bundled'),
                registration: expect.objectContaining({ family: 'hooks', localId: 'after-spawn' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', occurrenceId: activated.readPluginOccurrenceId('acme.target.bundled'),
                registration: expect.objectContaining({ family: 'mcp.discoverySources', localId: 'config' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', occurrenceId: activated.readPluginOccurrenceId('acme.target.bundled'),
                registration: expect.objectContaining({ family: 'scmBackends', localId: 'fixture' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', occurrenceId: activated.readPluginOccurrenceId('acme.target.bundled'),
                registration: expect.objectContaining({ family: 'notificationChannels', localId: 'configured' }),
            }),
        ]);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target.bundled', status: 'active',
                required: expect.arrayContaining([
                    { family: 'actions', localId: 'run' },
                    { family: 'hooks', localId: 'after-spawn' },
                    { family: 'mcp.discoverySources', localId: 'config' },
                    { family: 'scmBackends', localId: 'fixture' },
                    { family: 'notificationChannels', localId: 'configured' },
                ]),
                bound: expect.arrayContaining([
                    { family: 'actions', localId: 'run' },
                    { family: 'hooks', localId: 'after-spawn' },
                    { family: 'mcp.discoverySources', localId: 'config' },
                    { family: 'scmBackends', localId: 'fixture' },
                    { family: 'notificationChannels', localId: 'configured' },
                ]),
            }),
        ]);
        const hook = activated.hookHandlersByHookId.get('session.spawned')?.[0];
        expect(hook).toEqual(expect.objectContaining({
            pluginId: 'acme.target.bundled', hookId: 'session.spawned', priority: 12,
        }));
        await expect(hook?.handler({ payload: {} }, {})).resolves.toEqual({ handled: true });
        const scmBackend = activated.scmBackendsById.get('acme.target.bundled/fixture');
        expect(scmBackend).toEqual(expect.objectContaining({
            pluginId: 'acme.target.bundled',
            registration: expect.objectContaining({
                id: 'fixture',
                handlers: expect.objectContaining({ detection: expect.any(Object) }),
            }),
        }));
        await expect(scmBackend?.registration.handlers.detection?.detectRepo?.({ cwd: '/workspace' }))
            .resolves.toEqual({ isRepo: true, rootPath: '/workspace', mode: '.git' });
        expect(activated).not.toHaveProperty('permissionsByPluginId');
        expect(activated.filesystemReadAllowedPathsByPluginId.get('acme.target.bundled'))
            .toEqual(new Set(['observed']));
        expect(activated.envAllowedNamesByPluginId.get('acme.target.bundled'))
            .toEqual(new Set(['FORGE_TOKEN']));
        expect(activated.runtimeCapabilitiesByPluginId.get('acme.target.bundled')).toEqual(expect.any(Set));
        expect(activated.systemToolDefinitionsByPluginId.get('acme.target.bundled')).toEqual([
            expect.objectContaining({ id: 'fixture-cli' }),
        ]);
        expect(activated.eventDeclarationsByPluginId.get('acme.target.bundled')).toEqual([
            expect.objectContaining({ id: 'review-ready-event', kind: 'event', title: 'Review ready' }),
        ]);
        await activated.dispose();
        expect(activated.targetRegistrations).toEqual([]);
        await expect(hook?.handler({ payload: {} }, {})).rejects.toThrow(/no longer active/);
        expect(() => scmBackend?.registration.handlers.detection?.detectRepo?.({ cwd: '/workspace' }))
            .toThrow(/no longer active/);
    });

    it('publishes an unavailable target fact when module loading fails before registration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-load-failure-'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.load-failure', version: '2.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './missing.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.load-failure',
                manifestPath: join(root, 'happier.plugin.json'),
                daemonEntryPath: join(root, 'missing.mjs'),
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link', devWatch: true },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        const onTerminalActivationFailure = vi.fn();
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 6,
            onTerminalActivationFailure,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target.load-failure',
                root,
                entryPath: join(root, 'missing.mjs'),
            }),
        });
        expect(onTerminalActivationFailure).not.toHaveBeenCalled();
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.load-failure', family: 'actions', localId: 'run',
        }]);

        expect(onTerminalActivationFailure).toHaveBeenCalledOnce();
        expect(onTerminalActivationFailure).toHaveBeenCalledWith('acme.target.load-failure');
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.load-failure', family: 'actions', localId: 'run',
        }]);
        expect(onTerminalActivationFailure).toHaveBeenCalledOnce();

        expect(activated.targetActivationFacts).toMatchObject([{
            pluginId: 'acme.target.load-failure', pluginVersion: '2.0.0', source: 'development',
            occurrenceId: expect.any(String), host: 'daemon', platform: process.platform, occurredAtMs: expect.any(Number),
            status: 'unavailable',
            diagnostics: [expect.objectContaining({ code: 'plugin_source_missing' })],
        }]);
        const [fact] = activated.targetActivationFacts;
        expect(fact?.required).toEqual([{ family: 'actions', localId: 'run' }]);
        expect(fact?.bound).toEqual([]);
        expect(JSON.stringify(fact?.required)).not.toMatch(
            /target|realm|artifactId|requiredFields|promptAssetDescriptor/,
        );
        await activated.dispose();
    });

    it('does not load a lazy target before demand and single-flights concurrent activation', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.lazy', version: '1.0.0', displayName: 'Lazy target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], execution: { target: 'daemon' }, surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'acme.target.lazy',
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-target-lazy', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));

        const onTerminalActivationFailure = vi.fn();
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 7,
            onTerminalActivationFailure,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-target-lazy/daemon',
                load,
            }),
        });

        expect(load).not.toHaveBeenCalled();
        expect(onTerminalActivationFailure).not.toHaveBeenCalled();
        await Promise.all([
            activated.activateContributionsOnDemand([{ pluginId: 'acme.target.lazy', family: 'actions', localId: 'run' }]),
            activated.activateContributionsOnDemand([{ pluginId: 'acme.target.lazy', family: 'actions', localId: 'run' }]),
        ]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.activatedPluginIds.has('acme.target.lazy')).toBe(true);
        expect(onTerminalActivationFailure).not.toHaveBeenCalled();

        await activated.dispose();
    });

    it('keeps a public request-policy target dormant until exact demand and fences its published handler on disposal', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: 'acme.target.request-policy',
            version: '1.0.0',
            displayName: 'Request policy',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                requestInterceptors: [{
                    id: 'authorize-api',
                    origins: ['https://api.example.test'],
                    methods: ['POST'],
                    priority: 10,
                }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'acme.target.request-policy',
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-target-request-policy', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const handler = vi.fn(async (request: PluginInterceptedRequest) => ({
            decision: 'continue' as const,
            request: Object.freeze({ ...request, headers: Object.freeze({ ...request.headers, authorization: 'Bearer fixture' }) }),
        }));
        const activate = vi.fn((api: TargetPluginRegistrationApi) => {
            api.interceptors.register('authorize-api', handler);
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 11,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-target-request-policy/daemon',
                load,
            }),
        });

        expect(load).not.toHaveBeenCalled();
        expect(activated.requestInterceptors).toEqual([]);
        await Promise.all([
            activated.activateContributionsOnDemand([{
                pluginId: 'acme.target.request-policy', family: 'requestInterceptors', localId: 'authorize-api',
            }]),
            activated.activateContributionsOnDemand([{
                pluginId: 'acme.target.request-policy', family: 'requestInterceptors', localId: 'authorize-api',
            }]),
        ]);

        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.requestInterceptors).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target.request-policy',
                occurrenceId: activated.readPluginOccurrenceId('acme.target.request-policy'),
                contribution: expect.objectContaining({ id: 'authorize-api' }),
            }),
        ]);
        const published = activated.requestInterceptors[0];
        if (!published) throw new Error('Expected a published request interceptor binding');
        const request: PluginInterceptedRequest = Object.freeze({
            url: 'https://api.example.test/data', method: 'POST', headers: Object.freeze({}),
        });
        const invocationContext = Object.freeze({}) as PluginInvocationContext;
        await expect(published.handler(request, invocationContext)).resolves.toEqual(expect.objectContaining({
            decision: 'continue',
            request: expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer fixture' }) }),
        }));

        await activated.dispose();
        expect(() => published.handler(request, invocationContext)).toThrow(/no longer active/);
    });

    it('fails closed for unqualified demand when plugins share a local contribution id', async () => {
        const createManifest = (pluginId: string) => ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: pluginId,
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        const alpha = createManifest('acme.target.alpha');
        const beta = createManifest('acme.target.beta');
        if (!alpha.ok || !beta.ok) throw new Error('Fixture manifests must be valid');
        const targets = [
            { pluginId: 'acme.target.alpha', manifest: alpha.manifest },
            { pluginId: 'acme.target.beta', manifest: beta.manifest },
        ].map(({ pluginId, manifest }) => ({
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            pluginId,
            manifestPath: `/virtual/${pluginId}/happier.plugin.json`,
            daemonEntryPath: `/virtual/${pluginId}/daemon.mjs`,
            sourceSpec: { kind: 'package' as const, locator: `@happier-dev/${pluginId}`, trustPolicy: 'bundled_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [],
            manifest,
        }));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: targets,
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const alphaLoad = vi.fn(async () => ({
            activate(api: PluginApi) { api.actions.register('run', async () => ({ owner: 'alpha' })); },
        }));
        const betaLoad = vi.fn(async () => ({
            activate(api: PluginApi) { api.actions.register('run', async () => ({ owner: 'beta' })); },
        }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 8,
            resolveActivationSource: (target) => ({
                kind: 'bundled',
                moduleId: target.pluginId,
                load: target.pluginId === 'acme.target.alpha' ? alphaLoad : betaLoad,
            }),
        });

        const malformedDemand = {
            family: 'actions',
            localId: 'run',
        } as unknown as PluginContributionActivationDemand;
        await expect(activated.activateContributionsOnDemand([malformedDemand])).resolves.toEqual([]);
        expect(alphaLoad).not.toHaveBeenCalled();
        expect(betaLoad).not.toHaveBeenCalled();

        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.beta',
            family: 'actions',
            localId: 'run',
        }]);
        expect(alphaLoad).not.toHaveBeenCalled();
        expect(betaLoad).toHaveBeenCalledTimes(1);
        await activated.dispose();
    });

    it('publishes target handlers only in the PluginInvocationContext registry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-activation-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 7,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target',
                root,
                entryPath: daemonEntryPath,
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target', family: 'actions', localId: 'run',
        }]);

        expect(activated.targetRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target', occurrenceId: activated.readPluginOccurrenceId('acme.target'),
                registration: expect.objectContaining({ family: 'actions', localId: 'run' }),
            }),
        ]);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({
                pluginVersion: '1.0.0',
                source: 'localPath',
                host: 'daemon',
                platform: process.platform,
                occurredAtMs: expect.any(Number),
                status: 'active',
                required: [{ family: 'actions', localId: 'run' }],
                bound: [{ family: 'actions', localId: 'run' }],
            }),
        ]);
        expect(activated.actions).toEqual([]);
        expect(activated.activatedPluginIds.has('acme.target')).toBe(true);
        await activated.dispose();
        expect(activated.targetRegistrations).toEqual([]);
    });

    it('single-flights concurrent disposal until target cleanup completes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-disposal-singleflight-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        let releaseCleanup!: () => void;
        let markCleanupEntered!: () => void;
        const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
        const cleanupEntered = new Promise<void>((resolve) => { markCleanupEntered = resolve; });
        const globalWithGate = globalThis as typeof globalThis & {
            __HAPPIER_TARGET_DISPOSAL_GATE?: Readonly<{
                entered(): void;
                promise: Promise<void>;
            }>;
        };
        globalWithGate.__HAPPIER_TARGET_DISPOSAL_GATE = {
            entered: markCleanupEntered,
            promise: cleanupGate,
        };
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '  return async () => {',
            '    globalThis.__HAPPIER_TARGET_DISPOSAL_GATE.entered();',
            '    await globalThis.__HAPPIER_TARGET_DISPOSAL_GATE.promise;',
            '  };',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.disposal', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.disposal',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        try {
            const activated = await activatePluginRuntimeRegistry({
                contributes: registry,
                generation: 8,
                resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                    pluginId: 'acme.target.disposal',
                    root,
                    entryPath: daemonEntryPath,
                }),
            });
            await activated.activateContributionsOnDemand([{
                pluginId: 'acme.target.disposal', family: 'actions', localId: 'run',
            }]);
            const first = activated.dispose();
            await cleanupEntered;
            let secondSettled = false;
            const second = activated.dispose().then(() => { secondSettled = true; });
            await Promise.resolve();

            expect(secondSettled).toBe(false);
            releaseCleanup();
            await Promise.all([first, second]);
            expect(activated.targetRegistrations).toEqual([]);
        } finally {
            releaseCleanup();
            delete globalWithGate.__HAPPIER_TARGET_DISPOSAL_GATE;
        }
    });

    it('isolates a target cleanup failure and reports it once while retiring registrations', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-disposal-failure-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '  return async () => { throw new Error("target cleanup failed"); };',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.cleanup-failure', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.cleanup-failure',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const onError = vi.fn(() => {
            throw new Error('diagnostic sink failed');
        });
        const laterCleanup = vi.fn(async () => undefined);
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 9,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target.cleanup-failure',
                root,
                entryPath: daemonEntryPath,
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.cleanup-failure', family: 'actions', localId: 'run',
        }]);
        activated.addRuntimeDisposable('acme.other-cleanup', laterCleanup);

        await expect(activated.dispose({ onError })).resolves.toBeUndefined();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.target.cleanup-failure',
            phase: 'target_activation',
        }));
        expect(laterCleanup).toHaveBeenCalledTimes(1);
        expect(activated.targetRegistrations).toEqual([]);
    });

    it('waits for slow target cleanup beyond five seconds and observes its eventual failure', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-disposal-timeout-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        let rejectCleanup!: (error: Error) => void;
        const cleanupGate = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
        const fixtureGlobal = globalThis as typeof globalThis & { __HAPPIER_SLOW_CLEANUP?: Promise<void> };
        fixtureGlobal.__HAPPIER_SLOW_CLEANUP = cleanupGate;
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '  return () => globalThis.__HAPPIER_SLOW_CLEANUP;',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.cleanup-timeout', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.cleanup-timeout',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const onError = vi.fn();
        const laterCleanup = vi.fn(async () => undefined);
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 10,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target.cleanup-timeout',
                root,
                entryPath: daemonEntryPath,
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.cleanup-timeout', family: 'actions', localId: 'run',
        }]);
        activated.addRuntimeDisposable('acme.later-cleanup', laterCleanup);

        vi.useFakeTimers();
        try {
            let settled = false;
            const disposal = activated.dispose({ onError }).then(() => { settled = true; });
            await Promise.resolve();
            expect(laterCleanup).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(5_001);
            expect(settled).toBe(false);
            expect(onError).not.toHaveBeenCalled();
            expect(laterCleanup).not.toHaveBeenCalled();
            rejectCleanup(new Error('slow target cleanup failed'));
            await expect(disposal).resolves.toBeUndefined();

            expect(onError).toHaveBeenCalledWith(expect.objectContaining({
                pluginId: 'acme.target.cleanup-timeout',
                phase: 'target_activation',
                error: expect.objectContaining({ message: 'slow target cleanup failed' }),
            }));
            expect(laterCleanup).toHaveBeenCalledTimes(1);
            expect(activated.targetRegistrations).toEqual([]);
        } finally {
            rejectCleanup(new Error('slow target cleanup failed'));
            delete fixtureGlobal.__HAPPIER_SLOW_CLEANUP;
            vi.useRealTimers();
        }
    });

    it('settles only changed-plugin runtime disposables before successor publication', async () => {
        const contributes: ResolvedContributionRegistry = {
            agents: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        };
        const changedCleanup = vi.fn(async () => undefined);
        const retainedPeerCleanup = vi.fn(async () => undefined);
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 11,
        });
        activated.addRuntimeDisposable('acme.changed', Object.freeze({
            dispose: changedCleanup,
        }));
        activated.addRuntimeDisposable('acme.retained-peer', Object.freeze({
            dispose: retainedPeerCleanup,
        }));

        activated.retireBackgroundServices(['acme.changed']);
        await activated.settleRetiredBackgroundServices(['acme.changed']);

        expect(changedCleanup).toHaveBeenCalledOnce();
        expect(retainedPeerCleanup).not.toHaveBeenCalled();

        await activated.dispose();
        expect(changedCleanup).toHaveBeenCalledOnce();
        expect(retainedPeerCleanup).toHaveBeenCalledOnce();
    });

    it('publishes the fenced successor without waiting for changed-plugin runtime disposal', async () => {
        const pluginId = 'acme.changed';
        const contributes: ResolvedContributionRegistry = {
            agents: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        };
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 12,
        });
        const events: string[] = [];
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        let markCleanupEntered!: () => void;
        const cleanupEntered = new Promise<void>((resolve) => {
            markCleanupEntered = resolve;
        });
        activated.addRuntimeDisposable(pluginId, Object.freeze({
            async dispose() {
                events.push('p-cleanup-start');
                markCleanupEntered();
                await cleanupGate;
                events.push('p-cleanup-end');
            },
        }));

        const executableRegistry = (
            dispose: () => Promise<void>,
            occurrenceId: string,
        ): ResolvedExecutablePluginRuntimeRegistry => ({
            contributes,
            hookHandlersByHookId: new Map(),
            agentRuntimesByAgentId: new Map(),
            scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
            activatedPluginIds: new Set([pluginId]),
            activateContributionsOnDemand: async () => [],
            resolveCaptureSource: unexpectedCaptureSourceResolution,
            resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
            resolvePromptAssetBlocks: async () => [],
            createAgentInvocationServices: async () => createUnavailablePluginServices(),
            readPluginOccurrenceId: () => occurrenceId as PluginRuntimeOccurrenceId,
            retireConsumers: () => {},
            retirePluginConsumers: async (pluginIds) => {
                activated.retireBackgroundServices(pluginIds);
            },
            settleRetiredBackgroundServices: async (pluginIds) => {
                await activated.settleRetiredBackgroundServices(pluginIds);
            },
            addRuntimeDisposable: activated.addRuntimeDisposable,
            dispose,
        });
        const previous = executableRegistry(
            async () => await activated.dispose(),
            'previous-occurrence',
        );
        const replacementDispose = vi.fn(async () => undefined);
        const replacement = executableRegistry(replacementDispose, 'replacement-occurrence');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => previous,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();

        const adoption = controller.adoptPreparedRuntimeRegistry({
            registry: replacement,
            changedPluginIds: Object.freeze([pluginId]),
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
            beforePublish: async (_registry, publish) => {
                events.push('q-publish');
                publish();
            },
        });
        await cleanupEntered;

        expect(controller.getState().activeRegistry?.readPluginOccurrenceId?.(pluginId))
            .toBe('replacement-occurrence');
        expect(events).toEqual(['q-publish', 'p-cleanup-start']);
        expect(() => activated.addRuntimeDisposable(pluginId, Object.freeze({
            dispose: vi.fn(async () => undefined),
        }))).toThrow(/retired/i);

        releaseCleanup();
        await adoption;

        expect(events).toEqual([
            'q-publish',
            'p-cleanup-start',
            'p-cleanup-end',
        ]);
        expect(controller.getState().activeRegistry).toBe(replacement);
        await controller.shutdown({ timeoutMs: 0 });
        expect(replacementDispose).toHaveBeenCalledOnce();
    });
});
