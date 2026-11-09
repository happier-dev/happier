import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    PluginProjectionV2Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    MachineSetupPlanInputV1Schema} from '@happier-dev/protocol/machines/managed/actionsV1';
import { PluginProjectedMachineRecipeEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

const ref = { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '3' };

function describeRecipes(kind: 'available' | 'empty' | 'absent') {
    // The daemon network boundary carries strict public projection data; the
    // Action resolver and all Home/Machine admission below it remain real.
    const software = PluginProjectedMachineRecipeEntryV1Schema.parse({
        id: `${ref.pluginId}/${ref.recipeId}`, pluginId: ref.pluginId, pluginVersion: '1.0.0',
        definition: { id: ref.recipeId, revision: ref.revision, title: 'Fonts', software: true,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
        },
    });
    const { software: _software, ...setupDefinition } = software.definition;
    const setup = PluginProjectedMachineRecipeEntryV1Schema.parse({ ...software,
        id: `${ref.pluginId}/setup-helper`, definition: { ...setupDefinition, id: 'setup-helper' },
    });
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: {}, agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {},
            familiesById: kind === 'absent' ? {} : { machineRecipes: { family: 'machineRecipes',
                entriesById: kind === 'empty' ? {} : { [software.id]: software, [setup.id]: setup },
            } }, diagnostics: [],
        }),
    });
}

beforeEach(async () => {
    await homes.reset();
    network.resetRequests();
    network.setHttpResponder(async (input, init) => {
        if (new URL(String(input)).pathname.startsWith('/v1/machines/')) return null;
        return homes.request(input, init);
    });
});
afterEach(async () => {
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await standardCleanup();
});
afterAll(async () => { await network.dispose(); });

it('resolves structured software refs from the reviewed Home and Machine, with honest empty/unavailable outcomes and no native reads', async () => {
    const addHome = async (name: string, serverUrl: string, active: boolean) => {
        const id = await homes.addHome({ name, serverUrl, accountId: 'alice', active });
        await network.addHome(serverUrl, 'alice');
        return id;
    };
    const homeId = await addHome('Reviewed Home', 'https://recipe-reviewed.test', false);
    const callerHome = await addHome('Caller Home', 'https://recipe-caller.test', false);
    const focusedHome = await addHome('Focused Home', 'https://recipe-focused.test', true);
    expect(new Set([homeId, callerHome, focusedHome]).size).toBe(3);
    const machineId = 'reviewed-machine';
    const draftInput = MachineSetupPlanInputV1Schema.parse({ homeId, machineId });
    const responses = { available: describeRecipes('available'), empty: describeRecipes('empty'), absent: describeRecipes('absent') };
    let reply: 'available' | 'empty' | 'absent' | 'failed' = 'available';
    const sent: Array<ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>> = [];
    network.setRpcAckResponder(async request => {
        const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
        sent.push(payload);
        return reply === 'failed' ? { ok: false, errorCode: 'MACHINE_RPC_UNAVAILABLE', error: 'unavailable' }
            : { ok: true, result: responses[reply] };
    });
    const executor = createDefaultActionExecutor();
    const request = { actionId: 'machines.setup.plan', fieldPath: 'sources.0.setup.items.0.selection.ref', draftInput };
    const caller = { surface: 'ui' as const, serverId: callerHome, defaultSessionMachineId: 'caller-machine' };
    // Constructing the inventory has no catalog/native demand.
    expect(network.requests).toHaveLength(0);
    const result = await executor.execute('action.options.resolve', request, caller);
    expect(network.requests).toMatchObject([{ serverUrl: 'https://recipe-reviewed.test', targetId: machineId,
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        payload: { machineId, selection: 'machineRecipes' } }]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { optionsSourceId: 'machines.setup.software.available',
        options: [{ value: ref, label: 'Fonts' }],
    } });
    if (!result.ok) throw new Error('Expected the reviewed target software catalog');
    expect(result.result).not.toHaveProperty('machineRecipeDetails');
    const options = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result).options;
    expect(options).toHaveLength(1);
    expect(MachineSetupPlanInputV1Schema.parse({ ...draftInput, sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref: options[0]?.value, inputs: {} } }] },
    }] }).sources).toMatchObject([{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] } }]);
    reply = 'empty';
    const prepared = await executor.prepare('action.options.resolve', request, caller);
    if (prepared.kind !== 'ready') throw new Error('Expected prepared software options');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { options: [] } });
    reply = 'absent';
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    reply = 'failed';
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    const { homeId: _homeId, ...withoutHome } = draftInput;
    expect(await executor.execute('action.options.resolve', { ...request, draftInput: withoutHome }, caller))
        .toMatchObject({ ok: false, errorCode: 'missing_option_dependency' });
    expect(sent).toHaveLength(4);
    expect(network.requests).toHaveLength(4);
    expect(network.httpRequests.some(({ url }) => /environment|provenance|setup\/plan/.test(new URL(url).pathname))).toBe(false);
});

it('offers target-qualified toolchain choices through the same public source without trusting draft hint paths or loading picked recipe bodies', async () => {
    const serverUrl = 'https://recipe-toolchain-reviewed.test';
    const homeId = await homes.addHome({ name: 'Reviewed Home', serverUrl, accountId: 'alice', active: false });
    await network.addHome(serverUrl, 'alice');
    const callerUrl = 'https://recipe-toolchain-caller.test';
    const callerHome = await homes.addHome({ name: 'Caller Home', serverUrl: callerUrl, accountId: 'alice' });
    await network.addHome(callerUrl, 'alice');
    const machineId = 'toolchain-machine';
    const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'reviewed-target', platform: 'linux', arch: 'x64',
        happyCliVersion: '0.3', homeDir: '/home/reviewed', happyHomeDir: '/home/reviewed/.happier' });
    let target: Pick<typeof metadata, 'platform' | 'arch'> | undefined = { platform: metadata.platform, arch: metadata.arch };
    let empty = false;
    const sent: Array<ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>> = [];
    network.setRpcAckResponder(async request => {
        expect(request.serverUrl).toBe(serverUrl);
        expect(request.targetId).toBe(machineId);
        const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
        sent.push(payload);
        const noBodies = 'recipeRefs' in payload && payload.recipeRefs?.length === 0;
        return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            ...describeRecipes(empty || noBodies ? 'empty' : 'available'), ...(target ? { machineRecipeTarget: target } : {}),
        }) };
    });
    const node = { kind: 'toolchain', adapterId: 'mise', tool: 'node' };
    const python = { kind: 'toolchain', adapterId: 'mise', tool: 'python' };
    const executor = createDefaultActionExecutor();
    const caller = { surface: 'ui' as const, serverId: callerHome, defaultSessionMachineId: 'caller-machine' };
    const request = { optionsSourceId: 'machines.setup.software.available', actionId: 'machines.setup.plan',
        // Draft content is not authority to narrow this direct source to a recipe-ref field.
        draftInput: { homeId, machineId, fieldPath: 'sources.0.setup.items.0.selection.ref' } };
    const browse = await executor.execute('action.options.resolve', request, caller);
    expect(browse).toMatchObject({ ok: true, result: { options: [expect.objectContaining({ value: ref }),
        expect.objectContaining({ value: node }), expect.objectContaining({ value: python })] } });
    if (!browse.ok) throw new Error('Expected target-qualified software choices');
    const choices = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(browse.result).options;
    expect(choices.slice(1).some(choice => choice.disabled)).toBe(false);
    expect(browse.result).not.toHaveProperty('machineRecipeDetails');
    for (const [actionId, fieldPath] of [['machines.setup.plan', 'sources.0.setup.items.0.selection.ref'],
        ['machines.setup.apply', 'targets.0.sources.0.setup.items.0.selection.ref']]) {
        const draftInput = actionId === 'machines.setup.apply'
            ? { homeId: callerHome, machineId: 'combined-host', targets: [{ homeId, machineId }] }
            : request.draftInput;
        expect(await executor.execute('action.options.resolve', { ...request, actionId, fieldPath, draftInput }, caller))
            .toMatchObject({ ok: true, result: { options: [{ value: ref }] } });
    }
    const selected = await executor.execute('action.options.resolve', { ...request, values: [node], query: 'Node', limit: 1 }, caller);
    expect(selected).toMatchObject({ ok: true, result: { options: [expect.objectContaining({ value: node })] } });
    expect(sent.at(-1)).toMatchObject({ machineId, selection: 'machineRecipes', recipeRefs: [] });
    if (!selected.ok) throw new Error('Expected the chosen toolchain');
    expect(selected.result).not.toHaveProperty('machineRecipeDetails');
    empty = true;
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: true, result: {
        options: [expect.objectContaining({ value: node }), expect.objectContaining({ value: python })],
    } });
    target = { platform: 'darwin', arch: 'x64' };
    expect(await executor.execute('action.options.resolve', { ...request, values: [node] }, caller)).toMatchObject({ ok: true,
        result: { options: [expect.objectContaining({ value: node, disabled: true })] } });
    target = { platform: 'linux' };
    expect(await executor.execute('action.options.resolve', { ...request, values: [node] }, caller))
        .toMatchObject({ ok: false, errorCode: 'unavailable' });
    target = undefined;
    expect(await executor.execute('action.options.resolve', request, caller)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(network.httpRequests.some(({ url }) => /environment|provenance|setup\/plan/.test(new URL(url).pathname))).toBe(false);
});

it.each(['machines.setup.plan', 'machines.setup.apply'] as const)('reads only chosen software revision input for %s without refreshing unrelated target facts', async actionId => {
    const serverUrl = 'https://recipe-selected.test';
    const homeId = await homes.addHome({ name: 'Reviewed Home', serverUrl, accountId: 'alice', active: false });
    await network.addHome(serverUrl, 'alice');
    const callerHome = await homes.addHome({ name: 'Caller Home', serverUrl: 'https://recipe-selected-caller.test', accountId: 'alice' });
    await network.addHome('https://recipe-selected-caller.test', 'alice');
    const machineId = 'selected-machine';
    const selected = PluginProjectedMachineRecipeEntryV1Schema.parse({
        id: `${ref.pluginId}/${ref.recipeId}`, pluginId: ref.pluginId, pluginVersion: '1.0.0',
        definition: { id: ref.recipeId, revision: ref.revision, title: 'Exact package', software: true,
            inputSchema: { type: 'object', properties: {
                manager: { type: 'string', enum: ['apt', 'dnf', 'brew', 'winget'] },
                packages: { type: 'array', items: { type: 'object', properties: {
                    name: { type: 'string' }, version: { type: 'string' }, kind: { type: 'string', enum: ['formula', 'cask'] },
                    source: { type: 'string' }, scope: { type: 'string', enum: ['user', 'machine'] },
                }, required: ['name'], additionalProperties: false } },
            }, required: ['manager', 'packages'], additionalProperties: false },
            inputHints: { fields: [{ path: 'manager', title: { key: 'software.manager', fallback: 'Package manager' }, widget: 'select',
                options: [{ value: 'apt', label: 'APT' }, { value: 'dnf', label: 'DNF' },
                    { value: 'brew', label: 'Homebrew' }, { value: 'winget', label: 'WinGet' }] }] },
            steps: [{ id: 'install', kind: 'package', manager: { kind: 'input', path: 'manager' }, packages: { kind: 'input', path: 'packages' } }],
            removeSteps: [{ id: 'remove', kind: 'package', state: 'absent', manager: { kind: 'input', path: 'manager' }, packages: { kind: 'input', path: 'packages' } }],
        },
    });
    const unrelated = PluginProjectedMachineRecipeEntryV1Schema.parse({ ...selected, id: `${ref.pluginId}/unrelated`,
        definition: { ...selected.definition, id: 'unrelated', title: 'Unrelated package', removeSteps: undefined } });
    const response = describeRecipes('empty');
    response.projection.familiesById.machineRecipes = { family: 'machineRecipes', entriesById: {
        [selected.id]: selected, [unrelated.id]: unrelated,
    } };
    network.setRpcAckResponder(async request => {
        DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
        return { ok: true, result: response };
    });
    const fieldPath = actionId === 'machines.setup.plan' ? 'sources.0.setup.items.0.selection.ref'
        : 'targets.0.sources.0.setup.items.0.selection.ref';
    const draftInput = actionId === 'machines.setup.plan' ? { homeId, machineId }
        : { homeId: callerHome, machineId: 'combined-host', targets: [
            { homeId, machineId, sources: [{ kind: 'direct', setup: { scripts: [{ body: 'private' }] } }] },
            { homeId, machineId: 'unrelated-target' },
        ] };
    const result = await createDefaultActionExecutor().execute('action.options.resolve', {
        actionId, fieldPath, draftInput, values: [ref],
    }, { surface: 'ui', serverId: callerHome, defaultSessionMachineId: 'caller-machine' });
    expect(result).toMatchObject({ ok: true, result: {
        optionsSourceId: 'machines.setup.software.available', options: [{ value: ref, label: 'Exact package' }],
        machineRecipeDetails: [selected],
    } });
    if (!result.ok) throw new Error('Expected the selected recipe declaration');
    const parsed = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result);
    expect(parsed.options).toHaveLength(1);
    expect(network.requests).toMatchObject([{ serverUrl, targetId: machineId,
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        payload: { machineId, selection: 'machineRecipes', recipeRefs: [ref] },
    }]);
    expect(network.requests).toHaveLength(1);
    expect(network.httpRequests.some(({ url }) => /environment|provenance|setup\/plan/.test(new URL(url).pathname))).toBe(false);

    // Store consumes the same public demand owner, never a private selected loader.
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const { useInputFieldOptions } = await import('@/components/sessions/actions/useInputFieldOptions');
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const readAccount = await captureLazyActionAccountContext(callerHome);
    const field = { path: fieldPath, optionsSourceId: 'machines.setup.software.available' };
    // resetRequests also removes the genuine network reply, not just its log.
    const initialRequests = network.requests.length;
    const mounted = await renderHook((props: Readonly<{ enabled: boolean; refreshKey: string; draftInput: Record<string, unknown> }>) =>
        useInputFieldOptions({ serverId: callerHome, accountLifetime: readAccount.accountLifetime, enabled: props.enabled,
            requests: [{ field, actionId, draftInput: props.draftInput, values: [ref] }], refreshKey: props.refreshKey }),
    { initialProps: { enabled: false, refreshKey: 'initial', draftInput } });
    try {
        expect(network.requests).toHaveLength(initialRequests);
        await mounted.rerender({ enabled: true, refreshKey: 'initial', draftInput });
        await waitForHomeGovernance(() => expect(mounted.getCurrent().state(field)).toMatchObject({
            status: 'ready', options: [{ value: ref, label: 'Exact package' }], machineRecipeDetails: [selected],
        }));
        expect(network.requests).toHaveLength(initialRequests + 1);
        expect(network.requests[initialRequests]).toMatchObject({ serverUrl, targetId: machineId,
            payload: { machineId, selection: 'machineRecipes', recipeRefs: [ref] } });
        const ready = mounted.getCurrent().state(field);
        if (actionId === 'machines.setup.apply') {
            await mounted.rerender({ enabled: true, refreshKey: 'initial', draftInput: {
                homeId: callerHome, machineId: 'combined-host', targets: [
                    { homeId, machineId, sources: [{ kind: 'direct', setup: { scripts: [{ body: 'changed private' }] } }] },
                    { homeId, machineId: 'changed-unrelated-target' },
                ],
            } });
            await flushHookEffects();
            expect(network.requests).toHaveLength(initialRequests + 1);
            expect(mounted.getCurrent().state(field)).toBe(ready);
        }
        await mounted.rerender({ enabled: true, refreshKey: 'same-facts', draftInput });
        await waitForHomeGovernance(() => expect(network.requests).toHaveLength(initialRequests + 2));
        await flushHookEffects();
        expect(mounted.getCurrent().state(field)).toBe(ready);
        await network.setAccount('https://recipe-selected-caller.test', 'bob');
        await waitForHomeGovernance(() => expect(mounted.getCurrent().state(field)).not.toHaveProperty('machineRecipeDetails'));
        expect(network.httpRequests.some(({ url }) => /environment|provenance|setup\/plan/.test(new URL(url).pathname))).toBe(false);
    } finally {
        await mounted.unmount();
        readAccount.dispose();
        disposeLoader();
    }
});

it('carries the exact reviewed target metadata with a true-empty selected read without guessing host facts', async () => {
    const serverUrl = 'https://recipe-target-fact.test';
    const homeId = await homes.addHome({ name: 'Target Home', serverUrl, accountId: 'alice', active: false });
    await network.addHome(serverUrl, 'alice');
    const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'reviewed-target', platform: 'darwin', arch: 'arm64',
        happyCliVersion: '0.3', homeDir: '/Users/reviewed', happyHomeDir: '/Users/reviewed/.happier' });
    const target = { platform: metadata.platform, arch: metadata.arch };
    let available = true;
    let hasMetadata = true;
    network.setRpcAckResponder(async request => {
        expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload))
            .toEqual({ machineId: 'reviewed-target', selection: 'machineRecipes', recipeRefs: [] });
        if (!available) return { ok: false, errorCode: 'MACHINE_RPC_UNAVAILABLE', error: 'unavailable' };
        return { ok: true, result: { ...describeRecipes('empty'), ...(hasMetadata ? { machineRecipeTarget: target } : {}) } };
    });
    const { createUiMachineRecipesRead } = await import('./machineRecipeActionDeps');
    const read = createUiMachineRecipesRead(undefined);
    const args = { homeId, machineId: 'reviewed-target', recipeRefs: [] };
    const context = { surface: 'ui' as const, serverId: homeId };
    expect(await read(args, context)).toEqual({ entries: [], target });
    hasMetadata = false;
    // Missing metadata does not invent a platform or withdraw a valid recipe read.
    expect(await read(args, context)).toEqual({ entries: [] });
    available = false;
    expect(await read(args, context)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(network.requests).toHaveLength(3);
    expect(network.httpRequests.some(({ url }) => /environment|provenance|setup\/plan/.test(new URL(url).pathname))).toBe(false);
});

it('does not disclose an in-flight recipe projection after the reviewed target Account changes', async () => {
    const serverUrl = 'https://recipe-retiring.test';
    const homeId = await homes.addHome({ name: 'Reviewed Home', serverUrl, accountId: 'alice', active: false });
    await network.addHome(serverUrl, 'alice');
    const callerUrl = 'https://recipe-current.test';
    const callerHome = await homes.addHome({ name: 'Caller Home', serverUrl: callerUrl, accountId: 'alice' });
    await network.addHome(callerUrl, 'alice');
    const response = describeRecipes('available');
    const release = createDeferred<void>();
    network.setRpcResponder(async () => { await release.promise; return response; });
    const pending = createDefaultActionExecutor().execute('action.options.resolve', {
        actionId: 'machines.setup.plan', fieldPath: 'sources.0.setup.items.0.selection.ref',
        draftInput: { homeId, machineId: 'retiring-machine' },
    }, { surface: 'ui', serverId: callerHome });
    try {
        await network.waitForRpcRequest(request => request.serverUrl === serverUrl
            && request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        await network.setAccount(serverUrl, 'bob');
        release.resolve();
        expect(await pending).toMatchObject({ ok: false, errorCode: 'unavailable' });
        expect(network.requests).toHaveLength(1);
    } finally {
        release.resolve();
        await pending;
    }
});
