import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PluginProjectionV2Schema, MachineSetupPlanResultV1Schema, createEmptyMachineSetupDesiredV1, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DaemonContributionRegistryProjectionDescribeRequestSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { applyMachineSetupEffectPlan, createMachineSetupNativeBackend, type MachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createCliActionInventoryDeps } from '@/session/actions/cliActionDeps/createCliActionInventoryDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

describe('installed external Machine setup declarations', () => {
    it('loads both cold families from an installed public author and executes its checked package through the host interpreter', async () => {
        const pluginId = 'com.example.machine-setup';
        // Load the maintained public example itself; a hand-copied declaration
        // here would not catch author/manifest drift.
        const examplePath = fileURLToPath(new URL('../../../../../../packages/plugin-sdk/examples/public-authoring/index.ts', import.meta.url));
        const { machineSetupAuthoring: author }: { machineSetupAuthoring: { manifest: PluginManifest } }
            = await import(pathToFileURL(examplePath).href);
        const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
            plugins: [{ manifest: author.manifest, files: {} }],
        });
        try {
            const loaded = await loadInstalledPlugins({ happyHomeDir: runtime.happyHomeDir });
            expect(Object.values(loaded.diagnosticsByPluginId).flat()).toEqual([]);
            expect(loaded.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([pluginId]);
            expect(loaded.loadedPlugins[0]?.daemonEntryPath).toBeNull();
            const inputs = projectLoadedPluginContributes({ loadResult: loaded, provenance: 'external' });
            const registry = createResolvedContributionRegistry({ ...inputs,
                occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) },
            });
            const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
            expect(Object.keys(projection.familiesById.machineRecipes?.entriesById ?? {}))
                .toEqual(author.manifest.contributes?.machineRecipes?.map(recipe => `${pluginId}/${recipe.id}`));
            expect(Object.keys(projection.familiesById.machineSetupPresets?.entriesById ?? {}))
                .toEqual(author.manifest.contributes?.machineSetupPresets?.map(preset => `${pluginId}/${preset.id}`));
            expect(inputs.activationTargets).toEqual([]);
            const recipe = registry.machineRecipes?.find(row => row.definition.id === 'fonts')?.definition;
            const preset = registry.machineSetupPresets?.find(row => row.definition.id === 'browser-bot')?.definition;
            expect(preset?.setup.items?.[0]).toMatchObject({ kind: 'softwareRecipe', selection: {
                ref: { pluginId, recipeId: recipe?.id, revision: recipe?.revision }, inputs: {},
            } });
            if (!recipe || !preset) throw new Error('Installed recipe and preset were not projected');
            const item = preset.setup.items?.[0];
            if (!item || item.kind !== 'softwareRecipe') throw new Error('Installed preset has no software selection');
            const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
                // The Machine RPC is the system boundary. The response comes
                // from this installed author's real normalized projection.
                callMachineAction: async target => {
                    expect(target.serverId).toBe('reviewed-home');
                    expect(target.machineId).toBe('adopted-machine');
                    expect(target.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
                    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request))
                        .toMatchObject({ machineId: 'adopted-machine', selection: 'machineRecipes' });
                    return { protocolVersion: 1, projection };
                },
            });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
            expect(await executor.execute('action.options.resolve', { actionId: 'machines.setup.plan',
                fieldPath: 'sources.0.setup.items.0.selection.ref',
                draftInput: { homeId: 'reviewed-home', machineId: 'adopted-machine' },
            }, { surface: 'cli', authority: 'present_user', serverId: 'caller-home' }))
                .toMatchObject({ ok: true, result: { options: [{ value: {
                    pluginId, recipeId: recipe.id, revision: recipe.revision,
                } }] } });
            let installed = false;
            const effects: string[][] = [];
            // The process/package manager is the system boundary; declaration
            // admission, projection, plan digests and interpreter stay real.
            const runNative = async (command: MachineSetupNativeCommand) => {
                const success = (stdout = '') => ({ code: 0, stdout, stderr: '' });
                if (command.executable === 'dpkg') return success('amd64\n');
                if (command.executable === 'apt-get' && command.args[0] === '--version') return success('apt 2.6');
                if (command.executable === 'dpkg-query') return installed
                    ? success('fonts-dejavu-core\tinstall ok installed\t2.37-6\tall\n')
                    : { code: 1, stdout: '', stderr: '' };
                if (command.executable === 'lslocks') return success('{"locks":[]}');
                if (command.executable === 'apt-cache') return success(command.args[0] === 'policy'
                    ? 'fonts-dejavu-core:\n  Installed: (none)\n  Candidate: 2.37-6\n  Version table:\n     2.37-6 500\n'
                    : 'Package: fonts-dejavu-core\nVersion: 2.37-6\nArchitecture: all\n\n');
                if (command.executable === 'apt-get' && command.args[0] === 'install') {
                    effects.push([...command.args]); installed = true; return success();
                }
                throw new Error(`Unexpected package process: ${command.executable}`);
            };
            const backend = createMachineSetupNativeBackend({ run: runNative });
            const planExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({
                homeId: 'reviewed-home', machineId: 'adopted-machine', runNative,
                apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
                    read: async () => ({ status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }),
                    compareAndSwap: async () => { throw new Error('Read-only Plan cannot attach a preset'); },
                }) },
                acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
                    controller: runtime.controller, happyHomeDir: runtime.happyHomeDir,
                }),
            }) });
            const source = { kind: 'bundledPreset' as const, ref: { pluginId, localId: preset.id, revision: preset.revision }, setup: preset.setup };
            const sources = [source, ...createEmptyMachineSetupDesiredV1().sources];
            const prepare = () => planExecutor.execute('machines.setup.plan', {
                homeId: 'reviewed-home', machineId: 'adopted-machine', sources,
            }, { surface: 'cli', authority: 'present_user' });
            const prepared = await prepare();
            expect(prepared).toMatchObject({ ok: true, result: { sources, support: [{ status: 'drifted' }],
                recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: { basis: { kind: 'setup', machineId: 'adopted-machine',
                    selection: item.selection },
                    steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }] } }],
            } });
            if (!prepared.ok) throw new Error('Installed author did not prepare a plan');
            const plan = MachineSetupPlanResultV1Schema.parse(prepared.result).recipePlans?.[0]?.plan;
            if (!plan) throw new Error('Installed author did not expand its recipe');
            expect(await applyMachineSetupEffectPlan({ plan, backend }))
                .toMatchObject({ status: 'applied', completedStepIds: ['fonts'] });
            const repeatedResult = await prepare();
            expect(repeatedResult).toMatchObject({ ok: true, result: { support: [{ status: 'satisfied' }] } });
            if (!repeatedResult.ok) throw new Error('Installed author did not recheck');
            const repeated = MachineSetupPlanResultV1Schema.parse(repeatedResult.result).recipePlans?.[0]?.plan;
            if (!repeated) throw new Error('Installed author did not retain its expanded plan');
            expect(await applyMachineSetupEffectPlan({ plan: repeated, backend }))
                .toMatchObject({ status: 'applied', completedStepIds: [] });
            expect(effects).toEqual([expect.arrayContaining(['install', 'fonts-dejavu-core'])]);
            expect(await planExecutor.execute('machines.setup.plan', {
                homeId: 'reviewed-home', machineId: 'adopted-machine', sources: [{ ...source, setup: { ...source.setup,
                    items: [{ ...item, selection: { ...item.selection, ref: { ...item.selection.ref, revision: 'unavailable' } } }],
                } }, ...createEmptyMachineSetupDesiredV1().sources],
            }, { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'machine_recipe_unavailable' });
            expect(effects).toHaveLength(1);
        } finally { await runtime.dispose(); }
    });
});
