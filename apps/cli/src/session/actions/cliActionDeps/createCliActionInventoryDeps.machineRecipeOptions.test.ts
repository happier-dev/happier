import { expect, it } from 'vitest';
import { MachineSetupPlanInputV1Schema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DaemonContributionRegistryProjectionDescribeRequestSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { PLUGIN_MANIFEST as firstPartyRecipeManifest } from '@happier-dev/plugins-machine-recipes/manifest';
import { resolveEffectiveInputFields, writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { evaluateInputPredicate } from '@happier-dev/protocol/inputs/inputPredicates';

const pluginId = 'com.example.machine-tools';
const ref = { pluginId, recipeId: 'fonts', revision: '3' };

function describeSoftwareCatalog(empty: boolean) {
    const recipe = { id: ref.recipeId, revision: ref.revision, title: 'Fonts', software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
    };
    const { software: _software, ...setupRecipe } = recipe;
    return describeManifestCatalog({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Machine tools',
        runtime: { apiVersion: 1 }, contributes: { machineRecipes: empty ? [] : [recipe, { ...setupRecipe, id: 'setup-helper' }] } });
}

function describeManifestCatalog(input: unknown) {
    const manifest = normalizePluginManifestV2(input);
    const catalogPluginId = manifest.id;
    const loaded: LoadedPlugin = { pluginId: catalogPluginId, pluginRootPath: '/plugins/machine-tools', manifestPath: '/plugins/machine-tools/plugin.json',
        daemonEntryPath: null, devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: catalogPluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const registry = createResolvedContributionRegistry({ ...inputs,
        occurrenceIdsByPluginId: { [catalogPluginId]: createPluginRuntimeOccurrenceId(catalogPluginId) } });
    return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 })) };
}

it('preserves prepared target arrays when an agent writes the resolved Software choice', async () => {
    const originalRef = { ...ref, revision: '2' };
    const item = { kind: 'softwareRecipe' as const, selection: { ref: originalRef, inputs: {} } };
    const sources = [{ kind: 'direct' as const, setup: { items: [item, item] } }];
    const first = { homeId: 'reviewed-home', machineId: 'selected-machine', desiredRevision: 0, recipePlans: [], sources };
    const second = { ...first, machineId: 'other-machine' };
    const draftInput = { homeId: 'reviewed-home', machineId: 'combined-host', targets: [first, second] };
    const spec = getActionSpec('machines.setup.apply');
    expect(spec.inputSchema.safeParse(draftInput).success).toBe(true);
    const field = resolveEffectiveInputFields(spec, draftInput)
        .find(candidate => candidate.optionsSourceId === 'machines.setup.software.available');
    if (!field) throw new Error('Expected the Software field');
    const reads: unknown[] = [];
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
        serverId: 'caller-home', callMachineAction: async target => {
            reads.push({ homeId: target.serverId, machineId: target.machineId });
            DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request);
            return describeSoftwareCatalog(false);
        } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const result = await executor.execute('action.options.resolve', { actionId: spec.id, fieldPath: field.path, draftInput },
        { surface: 'agent', authority: 'account_automation', serverId: 'caller-home' });
    expect(result).toMatchObject({ ok: true, result: { options: [{ value: ref }] } });
    if (!result.ok) throw new Error('Expected target Software choices');
    const options = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options;
    const changed = writeInputPath(draftInput, field.path, options[0]?.value);
    expect(spec.inputSchema.safeParse(changed).success).toBe(true);
    expect(changed).toEqual({ ...draftInput, targets: [{ ...first, sources: [{ ...sources[0],
        setup: { items: [{ ...item, selection: { ...item.selection, ref } }, item] } }] }, second] });
    expect(Array.isArray(changed.targets)).toBe(true);
    if (!Array.isArray(changed.targets)) throw new Error('Expected target copies');
    expect(changed.targets[1]).toBe(second);
    expect(draftInput.targets[0]?.sources[0]?.setup.items[0]).toBe(item);
    expect(reads).toEqual([{ homeId: first.homeId, machineId: first.machineId }]);
});

it('resolves software refs on the reviewed Home and Machine, distinguishing an empty catalog from an unavailable target without native reads', async () => {
    const homeId = 'reviewed-home';
    const machineId = 'selected-machine';
    const draftInput = MachineSetupPlanInputV1Schema.parse({ homeId, machineId });
    let response: 'available' | 'empty' | 'unavailable' = 'available';
    const reads: unknown[] = [];
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null, serverId: 'caller-home',
        // Exact-Machine RPC is the system boundary. Its reply uses the real
        // manifest normalizer/registry/projector; native and other reads fail.
        callMachineAction: async target => {
            reads.push({ serverId: target.serverId, machineId: target.machineId, method: target.method, request: target.request });
            expect(target.serverId).toBe(homeId);
            expect(target.machineId).toBe(machineId);
            expect(target.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request))
                .toMatchObject({ machineId, selection: 'machineRecipes' });
            if (response === 'unavailable') throw new Error('Selected daemon is unavailable');
            return describeSoftwareCatalog(response === 'empty');
        },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const request = { actionId: 'machines.setup.plan', fieldPath: 'sources.0.setup.items.0.selection.ref', draftInput };
    const caller = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'caller-home' };
    const available = await executor.execute('action.options.resolve', request, caller);
    expect(available).toMatchObject({ ok: true, result: { optionsSourceId: 'machines.setup.software.available',
        options: [{ value: ref, label: 'Fonts' }] } });
    if (!available.ok) throw new Error('Expected the reviewed target software catalog');
    const options = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(available.result).options;
    expect(options).toHaveLength(1);
    expect(MachineSetupPlanInputV1Schema.parse({ ...draftInput, sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref: options[0]?.value, inputs: {} } }] } }] }).sources)
        .toMatchObject([{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] } }]);
    const applyDraft = MachineSetupApplyInputV1Schema.parse({ ...draftInput,
        targets: [{ homeId, machineId, desiredRevision: 0, recipePlans: [],
            sources: [{ kind: 'direct', setup: {} }] }] });
    expect(await executor.execute('action.options.resolve', { ...request, actionId: 'machines.setup.apply',
        fieldPath: 'targets.0.sources.0.setup.items.0.selection.ref', draftInput: applyDraft }, caller))
        .toMatchObject({ ok: true, result: { optionsSourceId: 'machines.setup.software.available', options: [{ value: ref }] } });
    response = 'empty';
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: true, result: { options: [] } });
    response = 'unavailable';
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(reads).toHaveLength(4);
});

it('reads exact picked software declarations through public options without native catalog work', async () => {
    const response = describeSoftwareCatalog(false);
    const selected = response.projection.familiesById.machineRecipes?.entriesById[`${pluginId}/fonts`];
    if (!selected) throw new Error('Expected normalized external software declaration');
    const requests: unknown[] = [];
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null, serverId: 'caller-home',
        // Only the exact target RPC is substituted; admission, manifest normalization,
        // projection, picked-ref resolution and the public result schema stay real.
        callMachineAction: async target => {
            requests.push(target.request);
            expect(target.serverId).toBe('reviewed-home');
            expect(target.machineId).toBe('selected-machine');
            expect(target.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request);
            return response;
        },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const request = { actionId: 'machines.setup.plan', fieldPath: 'sources.0.setup.items.0.selection.ref',
        draftInput: { homeId: 'reviewed-home', machineId: 'selected-machine' }, values: [ref] };
    const caller = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'caller-home' };
    const result = await executor.execute('action.options.resolve', request, caller);
    expect(result).toMatchObject({ ok: true, result: { options: [{ value: ref, label: 'Fonts' }], machineRecipeDetails: [selected] } });
    if (!result.ok) throw new Error('Expected exact picked recipe metadata');
    PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result);
    expect(requests).toEqual([{ machineId: 'selected-machine', selection: 'machineRecipes', recipeRefs: [ref] }]);
    expect(await executor.execute('action.options.resolve', { ...request, values: [{ ...ref, revision: 'unavailable' }] }, caller))
        .toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(await executor.execute('action.options.resolve', { ...request, values: [{ ...ref, recipeId: 'setup-helper' }] }, caller))
        .toMatchObject({ ok: false, errorCode: 'unavailable' });
    const priorReads = requests.length;
    expect(await executor.execute('action.options.resolve', { ...request, values: [{ ...ref, pluginId: '' }] }, caller))
        .toMatchObject({ ok: false });
    expect(requests).toHaveLength(priorReads);
});

it('offers named language toolchains through public software choices without runtime recipes or native reads', async () => {
    const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'selected', platform: 'linux', arch: 'x64',
        happyCliVersion: '0.3', homeDir: '/home/selected', happyHomeDir: '/home/selected/.happier' });
    let machineRecipeTarget: Pick<typeof metadata, 'platform' | 'arch'> | undefined = { platform: metadata.platform, arch: metadata.arch };
    let empty = false;
    const requests: unknown[] = [];
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null, serverId: 'caller-home',
        // Only the exact target transport is substituted. Real authored declarations,
        // normalized registry, target metadata and the public option resolver stay real.
        callMachineAction: async target => {
            requests.push(target.request);
            expect(target.serverId).toBe('reviewed-home');
            expect(target.machineId).toBe('selected-machine');
            expect(target.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request);
            return { ...describeSoftwareCatalog(empty), ...(machineRecipeTarget ? { machineRecipeTarget } : {}) };
        },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const request = { optionsSourceId: 'machines.setup.software.available', actionId: 'machines.setup.plan',
        // Draft content cannot masquerade as the actual hint-selected field.
        draftInput: { homeId: 'reviewed-home', machineId: 'selected-machine',
            fieldPath: 'sources.0.setup.items.0.selection.ref' } };
    const caller = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'caller-home' };
    const result = await executor.execute('action.options.resolve', request, caller);
    expect(result).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
        { value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, label: 'Node.js', icon: 'terminal', description: expect.any(String) },
        { value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' }, label: 'Python', icon: 'terminal', description: expect.any(String) },
    ]) } });
    if (!result.ok) throw new Error('Expected exact target software choices');
    const options = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options;
    expect(options.map(option => option.value)).toEqual([ref,
        { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, { kind: 'toolchain', adapterId: 'mise', tool: 'python' }]);
    expect(await executor.execute('action.options.resolve', { ...request, actionId: 'machines.setup.plan',
        fieldPath: 'sources.0.setup.items.0.selection.ref' }, caller)).toMatchObject({ ok: true, result: { options: [{ value: ref }] } });
    expect(await executor.execute('action.options.resolve', { ...request, values: [{ kind: 'toolchain', adapterId: 'mise', tool: 'node' }],
        query: 'Node', limit: 1 }, caller)).toMatchObject({ ok: true, result: { options: [expect.objectContaining({
            value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' },
        })] } });
    empty = true;
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: true, result: {
        options: [expect.objectContaining({ value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' } }),
            expect.objectContaining({ value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' } })],
    } });
    for (const target of [{ platform: 'darwin', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }]) {
        machineRecipeTarget = target;
        expect(await executor.execute('action.options.resolve', { ...request,
            values: [{ kind: 'toolchain', adapterId: 'mise', tool: 'node' }] }, caller)).toMatchObject({ ok: true, result: {
            options: [{ value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, disabled: true, description: expect.any(String) }],
        } });
    }
    machineRecipeTarget = { platform: 'linux' };
    expect(await executor.execute('action.options.resolve', { ...request,
        values: [{ kind: 'toolchain', adapterId: 'mise', tool: 'node' }] }, caller)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: true, result: {
        options: [expect.objectContaining({ disabled: true }), expect.objectContaining({ disabled: true })],
    } });
    machineRecipeTarget = undefined;
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(requests).toHaveLength(9);
});

it('offers the actual published bundled software declaration through the same real option path', async () => {
    const builtin = getResolvedContributionRegistry();
    const bundledPluginId = 'happier.machine.recipes';
    const bundledRef = { pluginId: bundledPluginId, recipeId: 'fonts', revision: '1' };
    expect(builtin.machineRecipes).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: bundledPluginId,
        definition: expect.objectContaining({ id: 'fonts', revision: '1', software: true }) })]));
    const registry = createResolvedContributionRegistry({ ...builtin, occurrenceIdsByPluginId: {
        ...builtin.occurrenceIdsByPluginId, [bundledPluginId]: createPluginRuntimeOccurrenceId(bundledPluginId),
    } });
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
        callMachineAction: async target => {
            expect(target.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request))
                .toMatchObject({ machineId: 'guest', selection: 'machineRecipes' });
            return { protocolVersion: 1, projection: buildPluginProjectionV2({ registry, generation: 1 }) };
        },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    expect(await executor.execute('action.options.resolve', { actionId: 'machines.setup.plan',
        fieldPath: 'sources.0.setup.items.0.selection.ref', draftInput: { homeId: 'home', machineId: 'guest' },
    }, { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: true, result: {
        options: expect.arrayContaining([expect.objectContaining({ value: bundledRef })]),
    } });
});

it('offers first-party media and temporary display packages as cold software choices', async () => {
    const reply = describeManifestCatalog(firstPartyRecipeManifest);
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
        // The target RPC is the system boundary; its payload is the real current
        // first-party author declaration through normalizer, registry and wire.
        callMachineAction: async target => {
            expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(target.request))
                .toMatchObject({ machineId: 'guest', selection: 'machineRecipes' });
            return reply;
        },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const result = await executor.execute('action.options.resolve', { actionId: 'machines.setup.plan',
        fieldPath: 'sources.0.setup.items.0.selection.ref', draftInput: { homeId: 'home', machineId: 'guest' },
    }, { surface: 'cli', authority: 'present_user', serverId: 'home' });
    expect(result).toMatchObject({ ok: true, result: {
        options: expect.arrayContaining(['ffmpeg', 'virtual-display'].map(recipeId => expect.objectContaining({
            value: { pluginId: 'happier.machine.recipes', recipeId, revision: '1' },
        }))),
    } });
    if (!result.ok) throw new Error(result.errorCode);
    const options = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options;
    expect(options).toEqual(expect.arrayContaining([expect.objectContaining({
        value: { pluginId: 'happier.machine.recipes', recipeId: 'fonts', revision: '1' },
        icon: 'file', version: firstPartyRecipeManifest.version,
        source: expect.objectContaining({ locator: 'happier.machine.recipes' }),
    })]));
    expect(options.every(option => !('brand' in option))).toBe(true);
    expect(result.result).not.toHaveProperty('machineRecipeDetails');
    const recipes = Object.values(reply.projection.familiesById.machineRecipes!.entriesById);
    expect(recipes.find(entry => entry.definition.id === 'virtual-display')?.definition.steps)
        .toEqual([{ id: 'display-packages', kind: 'package', manager: 'apt', packages: [{ name: 'xvfb' }] }]);
    expect(recipes.find(entry => entry.definition.id === 'ffmpeg')?.definition.steps)
        .toEqual([{ id: 'ffmpeg', kind: 'package', manager: 'apt', packages: [{ name: 'ffmpeg' }] }]);
});

it('submits primitive package fields from the actual published chosen recipe without a consumer mapper', async () => {
    const reply = describeManifestCatalog(firstPartyRecipeManifest);
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
        // Only the exact target transport is substituted; published author data,
        // declaration admission, option resolution and form bindings stay real.
        callMachineAction: async () => reply,
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const selectedRef = { pluginId: 'happier.machine.recipes', recipeId: 'install-package', revision: '1' };
    const result = await executor.execute('action.options.resolve', { actionId: 'machines.setup.plan',
        fieldPath: 'sources.0.setup.items.0.selection.ref', draftInput: { homeId: 'home', machineId: 'guest' },
        values: [selectedRef] }, { surface: 'cli', authority: 'present_user', serverId: 'home' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const chosen = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).machineRecipeDetails?.[0]?.definition;
    if (!chosen) throw new Error('Expected the actual selected first-party recipe');
    expect(chosen.inputHints?.fields.map(field => field.path)).toEqual(expect.arrayContaining([
        'package.manager', 'package.apt.name', 'package.apt.version', 'package.brew.kind',
        'package.winget.source', 'package.winget.scope',
    ]));
    for (const [manager, identity] of [
        ['apt', { name: 'jq', version: '1.7.1-1' }],
        ['brew', { name: 'google-chrome', kind: 'cask' }],
        ['winget', { name: 'Google.Chrome' }],
    ] as const) {
        let input: Record<string, unknown> = writeInputPath({}, 'package.manager', manager);
        for (const [key, value] of Object.entries(identity)) input = writeInputPath(input, `package.${manager}.${key}`, value);
        const fields = resolveEffectiveInputFields(chosen, input);
        expect(fields.every(field => field.widget !== 'json')).toBe(true);
        expect(fields.some(field => field.path === 'package.brew.kind')).toBe(manager === 'brew');
        expect(fields.some(field => field.path === 'package.winget.scope')).toBe(manager === 'winget');
        expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(chosen.inputSchema), input)).toBe(true);
        const step = chosen.steps.find(item => item.id === `package-${manager}`);
        const removal = chosen.removeSteps?.find(item => item.id === `package-${manager}`);
        if (!step || !removal) throw new Error('Expected explicit package install and removal declarations');
        expect(resolveMachineRecipeStepInputsV1(step, input)).toEqual({ id: `package-${manager}`, kind: 'package', manager,
            state: 'present', packages: [identity] });
        expect(resolveMachineRecipeStepInputsV1(removal, input)).toEqual({ id: `package-${manager}`, kind: 'package', manager,
            state: 'absent', packages: [identity] });
    }
    let switched = writeInputPath({}, 'package.manager', 'brew');
    switched = writeInputPath(switched, 'package.brew.name', 'jq');
    switched = writeInputPath(switched, 'package.brew.kind', 'formula');
    switched = writeInputPath(switched, 'package.manager', 'apt');
    switched = writeInputPath(switched, 'package.apt.name', 'jq');
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(chosen.inputSchema), switched)).toBe(true);
    const active = chosen.steps.filter(step => step.when?.every(condition => !('input' in condition)
        || evaluateInputPredicate(condition.input, switched)) ?? true);
    expect(active).toHaveLength(1);
    expect(resolveMachineRecipeStepInputsV1(active[0]!, switched)).toEqual({ id: 'package-apt', kind: 'package', manager: 'apt',
        state: 'present', packages: [{ name: 'jq' }] });
    // Changing the manager must also leave an unfinished, now-hidden draft inert.
    const incomplete = writeInputPath(writeInputPath({}, 'package.brew.name', ''), 'package.manager', 'apt');
    const completed = writeInputPath(incomplete, 'package.apt.name', 'jq');
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(chosen.inputSchema), completed)).toBe(true);
    expect(resolveMachineRecipeStepInputsV1(active[0]!, completed)).toEqual({ id: 'package-apt', kind: 'package', manager: 'apt',
        state: 'present', packages: [{ name: 'jq' }] });
});
