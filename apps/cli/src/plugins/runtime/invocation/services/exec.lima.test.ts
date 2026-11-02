import { describe, expect, it, vi } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
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
            // invocation policy, environment admission and process IO stay real.
            const effectsPath = join(root, 'native-effect');
            const nativeScript = `#!${process.execPath}
                const args = process.argv.slice(2);
                if (args[0] === '--version') {
                    const executable = require('node:path').basename(process.argv[1]);
                    process.stdout.write(executable === 'limactl' ? 'limactl version 2.2.1'
                        : executable === 'qemu-img' ? 'qemu-img version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)'
                            : 'QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)');
                } else if (args[0] === 'info') {
                    if (process.env.HOME !== ${JSON.stringify(root)} || process.env.PATH !== ${JSON.stringify(root)}
                        || process.env.UNRELATED_SECRET) process.exit(2);
                    process.stdout.write(JSON.stringify({hostOS:'linux',hostArch:'x86_64',vmTypes:['qemu']}));
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
            vi.stubEnv('UNRELATED_SECRET', 'not-admitted');
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
            const registry = createTargetActionInvocationRegistry({
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
                const recipe = { instance: 'happier-qb-design', store: '/home/happier/.lima',
                    image: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img',
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

    it('checks an installed Lima through the admitted HOME and PATH without inheriting unrelated environment', async () => {
        const requests = normalizePluginManifestV2(LIMA_PLUGIN.manifest).hostAccess.required.map((request) => ({ request, required: true }));
        vi.stubEnv('HOME', '/fixture/lima-home');
        vi.stubEnv('PATH', '/fixture/native-tools');
        vi.stubEnv('UNRELATED_SECRET', 'not-admitted');
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            exec: {
                // Only the native executable is replaced. Real manifest admission,
                // ExecService, process supervision, parsing and the Action stay real.
                resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
                    if (process.env.HOME !== '/fixture/lima-home' || process.env.PATH !== '/fixture/native-tools'
                        || process.env.UNRELATED_SECRET) process.exit(2);
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
