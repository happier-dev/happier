import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MANAGED_EXEC_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createDevelopmentPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createTargetActionInvocationRegistry, type TargetActionInvocationRegistration } from '../targetActionRegistry';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createProductionPluginInvocationServiceOwners } from './production';
import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';
import { createStablePluginManagedDependenciesHost } from './managedDependencies';
import { createProductionManagedDependencySourceAdapter } from './managedDependencySourceAdapters';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { createManagedServicesOwner } from './managedServicesOwner';
import { createStableManagedExecutableResolver } from './managedExecutableResolver';

describe('Lima declared native process environment', () => {
    it.skipIf(process.platform === 'win32')('revalidates preset options through real registration, admission, dependency readiness and strict consumers', async ({ onTestFinished }) => {
        await withTempDir('happier-lima-options-', async root => {
            // These disposable executables replace Lima/QEMU at the OS boundary.
            // Declaration parsing, dependency probing, Action registration,
            // invocation policy, native environment and process IO stay real.
            const effectsPath = join(root, 'native-effect');
            const image = 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img';
            const nativeInfo = { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], limaHome: '/home/happier/.lima',
                defaultTemplate: { cpus: 2, memory: '2GiB', disk: '8GiB',
                    images: [{ arch: 'x86_64', location: image }] } };
            const nativeScript = `#!${process.execPath}
                const args = process.argv.slice(2);
                if (args[0] === '--version') {
                    const executable = require('node:path').basename(process.argv[1]);
                    process.stdout.write(executable === 'limactl' ? 'limactl version 2.2.1'
                        : executable === 'qemu-img' ? 'qemu-img version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)'
                            : 'QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)');
                } else if (args[0] === 'info') {
                    if (process.env.HOME !== ${JSON.stringify(root)} || process.env.PATH !== ${JSON.stringify(root)}) process.exit(2);
                    process.stdout.write(JSON.stringify(${JSON.stringify(nativeInfo)}));
                } else {
                    require('node:fs').writeFileSync(${JSON.stringify(effectsPath)}, args[0]);
                    process.exit(9);
                }
            `;
            for (const executable of ['limactl', 'qemu-system-x86_64', 'qemu-img']) {
                await writeFile(join(root, executable), nativeScript, { mode: 0o755 });
            }
            vi.stubEnv('HOME', root);
            vi.stubEnv('PATH', root);
            onTestFinished(() => { vi.unstubAllEnvs(); });
            const manifest = normalizePluginManifestV2(LIMA_PLUGIN.manifest);
            const pluginId = manifest.id;
            const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
            const sourceCustody = createDevelopmentPluginSourceCustody(root);
            const contributions = manifest.contributes.managedDependencies.map(definition => ({
                pluginId, provenance: 'external' as const, source: { kind: 'path' as const },
                manifestPath: join(root, 'plugin.json'), daemonEntryPath: null,
                sourceSpec: { kind: 'path' as const, locator: root, trustPolicy: 'local_trusted' as const, installPolicy: 'link' as const },
                definition,
            })) satisfies readonly ResolvedInstallableContribution[];
            const dependencies = createStablePluginManagedDependenciesHost({
                installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributions),
                sourceModel: createV2ManagedDependencySourceModel({ platform: 'linux', architecture: 'x64', contributions }),
                sourceCustodiesByPluginId: new Map([[pluginId, sourceCustody]]),
                isCurrent: () => true, getSettings: () => ({}),
                resolveAdapter: async () => { throw new Error('Unexpected legacy dependency'); },
                resolveSourceAdapter: input => createProductionManagedDependencySourceAdapter({ ...input, env: process.env }),
                removeManagedInstall: async () => { throw new Error('Options must not remove dependencies'); },
            });
            const managedServices = createManagedServicesOwner({
                processSupervisorHost: createManagedServiceProcessSupervisorHost({}),
                dependencies: scope => dependencies.bind(scope.pluginId),
                resolveScope: scope => scope,
            });
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write() {} }, managedServices,
                exec: { resolveExecutable: createStableManagedExecutableResolver({
                    systemTools: [], managedDependencies: dependencies,
                    resolveSystemTool: async () => { throw new Error('Unexpected system tool'); },
                }), resolvePath: async () => root },
            });
            const activated = await activateContributionModule({
                pluginId, occurrenceId, manifest, moduleNamespace: { activate: LIMA_PLUGIN.activate }, isOccurrenceCurrent: () => true,
            });
            const registry = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined,
                actions: activated.registrations.flatMap((registration): TargetActionInvocationRegistration[] => {
                    if (registration.family !== 'actions') return [];
                    const declaration = manifest.contributes.actions.find(action => action.id === registration.localId)!;
                    return [{ pluginId, pluginVersion: manifest.version, occurrenceId, sourceCustody,
                        localId: registration.localId,
                        // The loaded module ABI is the native plugin boundary.
                        handler: (input, context) => Reflect.apply(registration.value, undefined, [input, context]),
                        definition: { ...declaration, hostAccessRequests: manifest.hostAccess.required
                            .filter(request => declaration.hostAccess?.includes(request.id))
                            .map(request => ({ request, required: true })) },
                    }];
                }),
                readCurrentPluginOccurrenceId: () => occurrenceId,
                resolveAuthorizationFacts: () => ({
                    generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
                    resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
                }), resolveHostBinding: owners.resolveHostBinding, createServices: owners.createServices,
            });
            try {
                expect(activated.status).toBe('active');
                const provisioner = manifest.contributes.machineProvisioners[0]!;
                const localId = provisioner.actions.options;
                if (!localId) throw new Error('Lima has no declared options role');
                const launchSchema = createPluginJsonSchemaZodValueAdapter(provisioner.launchSchema);
                const recipe = { store: '/home/happier/.lima',
                    image,
                    arch: 'x86_64', vmType: 'qemu', cpus: 2, memoryGiB: 2, diskGiB: 8, mounts: [] };
                const invoke = async (input: unknown) => {
                    const result = await registry.invoke({ pluginId, localId, input, surface: 'cli' });
                    expect(result.status).toBe('executed');
                    if (result.status !== 'executed') throw new Error(`Options failed: ${result.status}`);
                    return MachineProvisionerOptionsResultV1Schema.parse(result.value);
                };
                expect(launchSchema.parse(recipe)).toEqual(recipe);
                const options = await invoke(recipe);
                expect(options.base).toMatchObject({ available: true, launch: recipe });
                const selection = Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) =>
                    entries[0] ? [[dimension, entries[0].id]] : []));
                const selected = projectMachineProvisionerSelectionV1({ options, selection, launchSchema: provisioner.launchSchema });
                expect(selected.kind).toBe('ready');
                if (selected.kind !== 'ready') throw new Error('Native-qualified Lima recipe was not executable');
                expect(launchSchema.parse(selected.launch)).toEqual(recipe);
                const incomplete = await invoke({});
                expect(projectMachineProvisionerSelectionV1({ options: incomplete, selection: {}, launchSchema: provisioner.launchSchema }).kind).toBe('incomplete');
                const unsupported = await invoke({ ...recipe, vmType: 'vz' });
                expect(unsupported.base).toMatchObject({ available: false });
                expect(projectMachineProvisionerSelectionV1({ options: unsupported, selection, launchSchema: provisioner.launchSchema }).kind).toBe('unavailable');
                await unlink(join(root, 'qemu-img'));
                const unavailable = await invoke(recipe);
                expect(unavailable.base).toMatchObject({ available: false });
                expect(projectMachineProvisionerSelectionV1({ options: unavailable, selection, launchSchema: provisioner.launchSchema }).kind).toBe('unavailable');
                expect(existsSync(effectsPath)).toBe(false);
            } finally {
                await registry.dispose();
                await activated.dispose();
                await owners.dispose();
                await managedServices.dispose();
                vi.unstubAllEnvs();
            }
        });
    });

    it.skipIf(process.platform !== 'linux')('stops a running guest process group when the non-PTY Lima carrier aborts', async ({ onTestFinished }) => {
        await withTempDir('hpl-stop-', async root => {
            const controller = new AbortController();
            const started = join(root, 'started');
            const completed = join(root, 'completed');
            const instance = 'happier-stop';
            const requests = normalizePluginManifestV2(LIMA_PLUGIN.manifest).hostAccess.required.map(request => ({ request, required: true }));
            // Like non-PTY SSH, this transport forwards the pipes while the guest
            // lives in a separate session outside the host supervisor's process tree.
            const socketPath = join(root, 'transport.sock');
            const server = createServer(socket => {
                socket.once('data', header => {
                    const end = header.indexOf(10);
                    const [command, ...args] = JSON.parse(header.subarray(0, end).toString()) as string[];
                    const guest = spawn(command!, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
                    guest.stdin.on('error', () => {});
                    guest.stdin.write(header.subarray(end + 1));
                    socket.pipe(guest.stdin);
                    socket.once('close', () => guest.stdin.end());
                    guest.once('exit', () => socket.end());
                });
            });
            await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
            onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
            const carrier = String.raw`
                const args = process.argv.slice(1);
                if (args[0] === 'list') {
                    process.stdout.write(JSON.stringify({ name: args.at(-1), status: 'Running', dir: require('node:path').join(process.env.LIMA_HOME, args.at(-1)) }));
                } else if (args.at(-1) === 'exit-status-probe') {
                    const [command, ...argv] = args.slice(args.indexOf('--') + 1);
                    const guest = require('node:child_process').spawn(command, argv, { stdio: 'inherit' });
                    guest.on('exit', status => { process.exitCode = status ?? 1; });
                } else {
                    const remote = require('node:net').connect(${JSON.stringify(socketPath)}, () => {
                        remote.write(JSON.stringify(args.slice(args.indexOf('--') + 1)) + '\n');
                        process.stdin.pipe(remote);
                    });
                    remote.resume();
                }
            `;
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write() {} },
                exec: {
                    resolveExecutable: async () => ({ command: process.execPath, args: ['-e', carrier, '--'] }),
                    resolvePath: async () => root,
                },
            });
            const pluginId = LIMA_PLUGIN.manifest.id;
            const seedFor = (signal: AbortSignal) => ({
                plugin: { id: pluginId, version: '0.0.0' },
                contribution: { id: 'exec', qualifiedId: `${pluginId}/actions/exec` },
                occurrenceId: 'lima-stop-test', correlationId: 'lima-stop-test', surface: 'cli' as const,
                signal, isOccurrenceCurrent: () => true,
            });
            const handlers = new Map<string, ActionHandler>();
            await LIMA_PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) {
                handlers.set(id, handler);
                return { dispose() {} };
            } } } as unknown as PluginApi);
            const invocationContext = (signal: AbortSignal) => {
                const seed = seedFor(signal);
                const binding = owners.resolveInvocationHostPolicy({
                    pluginId, occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
                }, { hostAccessRequests: requests, surface: seed.surface, signal }).serviceBinding;
                return {
                    invokedAtMs: 123,
                    signal,
                    services: { ...owners.createServices(seed, binding), managedServices: { dependencies: { status: async (id: string) => ({
                        state: 'ready', id, version: '2.2.1', sourceId: 'system',
                        executable: { kind: 'managedDependency', id: { pluginId, localId: id } },
                    }) } } },
                } as unknown as PluginInvocationContext;
            };
            const exec = handlers.get('exec');
            if (!exec) throw new Error('Lima exec Action was not activated');
            const resource = { instance, store: root, arch: 'x86_64', vmType: 'qemu', cpus: 1,
                memoryBytes: 1024 ** 3, diskBytes: 1024 ** 3, image: 'https://example.test/lima.img', mounts: [] };
            const invoke = (argv: readonly string[], command: string, signal = controller.signal) => Promise.resolve(exec({
                resource, argv, inputBase64: Buffer.from(command + '\n').toString('base64'), allowWake: false, timeoutMs: null,
            }, invocationContext(signal)));
            // Read a real exit and output before aborting the same carrier type.
            // Bash job notifications must never be included in guest stderr.
            await expect(invoke(['/bin/sh', '-s', '--', 'exit-status-probe'],
                "printf 'one\\000two'; printf 'guest-stderr' >&2; exit 19")).resolves.toMatchObject({
                termination: { observed: { kind: 'exit', exitCode: 19 }, requestedBy: { kind: 'none' } },
                stdoutBase64: Buffer.from('one\0two').toString('base64'),
                stderrBase64: Buffer.from('guest-stderr').toString('base64'),
            });
            const command = `sleep 30 & child=$!; printf '%s %s\n' "$$" "$child" > "${started}"; wait "$child"; touch "${completed}"`;
            const scope = { accountId: 'requester', machineId: 'controller' };
            const operationId = 'managed-exec-stop';
            const store = createActionOperationStore();
            const spec = getActionSpec(MANAGED_EXEC_ACTION_ID_V1);
            const runner = createActionOperationRunner({ store, generateOperationId: () => operationId,
                resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
            const settled = runner.observe({ actionId: spec.id, scope, requestId: operationId, input: {},
                cancellation: 'supported', execute: async ({ signal }) => {
                    try {
                        return { ok: true, result: await invoke(['/bin/sh', '-s'], command, signal) };
                    } catch (error) {
                        return { ok: false, ...normalizeActionExecutorThrownError(error, spec.id) };
                    }
                },
            });
            let pids: number[] = [];
            try {
                await vi.waitFor(async () => {
                    pids = (await readFile(started, 'utf8')).trim().split(' ').map(Number);
                    expect(pids).toHaveLength(2);
                });
                expect(runner.cancel(scope, operationId)).toEqual({ kind: 'requested' });
                await vi.waitFor(async () => {
                    const running = await Promise.all(pids.map(async pid => {
                        const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
                        return Boolean(state) && !state.slice(state.lastIndexOf(')') + 2).startsWith('Z ');
                    }));
                    expect(running).toEqual([false, false]);
                }, { timeout: 2000 });
                expect(existsSync(completed)).toBe(false);
                expect(await settled).toMatchObject({ ok: false, errorCode: 'cancelled' });
                expect(store.get(scope, operationId)).toMatchObject({ state: 'cancelled', settledAt: expect.any(Number) });
            } finally {
                runner.cancel(scope, operationId);
                controller.abort();
                for (const pid of pids) {
                    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
                }
                await settled;
                await owners.dispose();
            }
        });
    });

    it('checks an installed Lima through the host HOME and PATH', async () => {
        const requests = normalizePluginManifestV2(LIMA_PLUGIN.manifest).hostAccess.required.map((request) => ({ request, required: true }));
        vi.stubEnv('HOME', '/fixture/lima-home');
        vi.stubEnv('PATH', '/fixture/native-tools');
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            exec: {
                // Only the native executable is replaced. Real manifest admission,
                // ExecService, process supervision, parsing and the Action stay real.
                resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
                    if (process.env.HOME !== '/fixture/lima-home' || process.env.PATH !== '/fixture/native-tools') process.exit(2);
                    process.stdout.write(process.argv[1] === '--version'
                        ? 'limactl version 2.2.1'
                        : JSON.stringify({hostOS:'linux',hostArch:'x86_64',vmTypes:['qemu']}));
                `, '--'] }),
                resolvePath: async () => process.cwd(),
            },
        });
        const seed = {
            plugin: { id: LIMA_PLUGIN.manifest.id, version: '0.0.0' },
            contribution: { id: 'check', qualifiedId: `${LIMA_PLUGIN.manifest.id}/actions/check` },
            occurrenceId: 'lima-test', correlationId: 'lima-test', surface: 'cli' as const,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        };
        const binding = owners.resolveInvocationHostPolicy({
            pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
        }, { hostAccessRequests: requests, surface: seed.surface, signal: seed.signal }).serviceBinding;
        const services = owners.createServices(seed, binding);
        const handlers = new Map<string, ActionHandler>();
        const api = { actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler);
            return { dispose() {} };
        } } } as unknown as PluginApi;
        await LIMA_PLUGIN.activate(api);
        const context = {
            invokedAtMs: 123,
            signal: new AbortController().signal,
            services: { ...services, managedServices: { dependencies: { status: async (id: string) => ({
                state: 'ready', id, version: '2.2.1', sourceId: 'system',
                executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } },
            }) } } },
        } as unknown as PluginInvocationContext;
        const check = handlers.get('check');
        if (!check) throw new Error('Lima check Action was not activated');
        try {
            expect(await check({}, context)).toMatchObject({ available: true });
        } finally {
            await owners.dispose();
            vi.unstubAllEnvs();
        }
    });
});
