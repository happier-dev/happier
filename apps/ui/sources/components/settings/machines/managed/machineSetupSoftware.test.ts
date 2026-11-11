import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PluginProjectedMachineRecipeEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getMachineSetupDesiredV1, machineSetupItemKeyV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createCombinedMachineSetupActionDeps } from '../../../../../../cli/src/machines/setup/composeMachineSetup';
import { prepareMachineSetupPlanV1 } from '../../../../../../cli/src/machines/setup/prepareMachineSetupPlan';
import { prepareMachineSetupSoftwareApplyInput } from './machineSetupSoftware';
import { MachineSetupCombinedPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

it('reuses the observed Software plan while reviewing deliberate inputs without a second current-state read', async () => {
    const ref = { pluginId: 'example.software', recipeId: 'configured', revision: '1' };
    const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({ id: `${ref.pluginId}/${ref.recipeId}`,
        pluginId: ref.pluginId, pluginVersion: '1', definition: { id: ref.recipeId, revision: ref.revision, software: true,
            title: 'Configured software', inputSchema: { type: 'object', properties: { config: { type: 'object',
                properties: { reviewed: { type: 'boolean' } }, additionalProperties: false } },
                required: ['config'], additionalProperties: false },
            steps: [{ id: 'check', kind: 'command', executable: 'test', args: ['-e', 'fixture'],
                check: { executable: 'test', args: ['-e', 'fixture'], unsatisfiedExitCodes: [1] } }],
        } });
    const current = await getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        compareAndSwap: async () => { throw new Error('Review cannot write desired Software'); },
    });
    const modes: unknown[] = [];
    const deps = createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
        if ('targets' in input) throw new Error('The native leaf receives one target');
        modes.push(input.mode);
        return prepareMachineSetupPlanV1({ input, current, readRecipes: async () => [recipe], runNative: async command => {
            if (command.executable !== 'test') throw new Error('Review attempted a native effect');
            return { code: 1, stdout: '', stderr: '' };
        } });
    } });
    const combined = createCombinedMachineSetupActionDeps({ readDeps: () => deps, targetPlan: deps.machineSetupPlan!,
        readHostFacts: async () => ({ machines: [{ machineId: 'guest', online: true }] }), orchestrationDirectory: '.',
        startCombined: async () => { throw new Error('Review cannot start a Run'); },
        waitForRun: async () => { throw new Error('Review cannot wait for a Run'); },
    });
    const executor = createActionExecutor({ ...deps, machineSetupPlan: combined.machineSetupPlan });
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    const target = { homeId: 'home', machineId: 'guest' };
    const observed = await executor.execute('machines.setup.plan', { ...target, targets: [target] }, context);
    if (!observed.ok) throw new Error(observed.errorCode);
    const currentPlan = MachineSetupCombinedPlanResultV1Schema.parse(observed.result);
    for (const config of [{}, { reviewed: true }]) {
        const request = { executeAction: executor.execute, context, ...target, targets: [target], currentPlan,
            setup: { items: [{ kind: 'softwareRecipe' as const, selection: { ref, inputs: { config } } }] }, isCurrent: () => true };
        const prepared = await prepareMachineSetupSoftwareApplyInput(request);
        expect(prepared).toMatchObject({ ok: true, input: { targets: [{ sources: [{ kind: 'direct', setup: {
            items: [{ selection: { ref, inputs: { config } } }],
        } }] }] } });
    }
    // One current-state read serves both reviews. Each edit gets its own effects Plan, never an Apply.
    expect(modes).toEqual([undefined, 'effects', 'effects']);
});

it('reviews direct Software detachment with native opt-in removal while preserving shared, foreign and pre-existing items', async () => {
    const item = (name: string) => ({ kind: 'softwareRecipe' as const, selection: {
        ref: { pluginId: 'example.software', recipeId: name, revision: '1' }, inputs: {},
    } });
    const owned = item('owned');
    const preExisting = item('pre-existing');
    const shared = item('shared');
    const foreign = item('foreign');
    const sources = [
        { kind: 'accountPreset' as const, presetId: 'shared-tools', presetRevision: 1, setup: { items: [shared] } },
        { kind: 'direct' as const, setup: { items: [owned, preExisting, shared, foreign], scripts: [{ body: 'echo retained\r\n' }] } },
    ];
    const sourceFacts = { direct: { firstPresence: {
        [machineSetupItemKeyV1(owned)]: 'absent' as const,
        [machineSetupItemKeyV1(preExisting)]: 'present' as const,
        [machineSetupItemKeyV1(shared)]: 'absent' as const,
    } } };
    const current = await getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadataVersion: 4, metadata: {
            setup: { version: 1, revision: 4, sources, sourceFacts, exclusions: [] },
        } }),
        compareAndSwap: async () => { throw new Error('Review cannot mutate desired Software'); },
    });
    const recipes = [owned, preExisting, shared, foreign].map(entry => PluginProjectedMachineRecipeEntryV1Schema.parse({
        id: `example.software/${entry.selection.ref.recipeId}`, pluginId: 'example.software', pluginVersion: '1.0.0',
        definition: { id: entry.selection.ref.recipeId, revision: '1', title: entry.selection.ref.recipeId, software: true,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'install', kind: 'command', executable: 'install', args: [entry.selection.ref.recipeId],
                check: { executable: 'test', args: ['-e', entry.selection.ref.recipeId], unsatisfiedExitCodes: [1] } }],
            removeSteps: [{ id: 'remove', kind: 'command', executable: 'rm', args: ['--', entry.selection.ref.recipeId],
                check: { executable: 'test', args: ['!', '-e', entry.selection.ref.recipeId], unsatisfiedExitCodes: [1] } }],
        },
    }));
    const deps = createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
        if ('targets' in input) throw new Error('The native leaf receives one exact target');
        return await prepareMachineSetupPlanV1({ input, current, readRecipes: async () => recipes,
            // Only process observation is substituted. Source ownership, native
            // declaration expansion and removal eligibility remain real.
            runNative: async command => {
                if (command.executable !== 'test') throw new Error('Review attempted a native effect');
                return { code: command.args.includes('!') ? 1 : 0, stdout: '', stderr: '' };
            } });
    } });
    const combined = createCombinedMachineSetupActionDeps({ readDeps: () => deps, targetPlan: deps.machineSetupPlan!,
        readHostFacts: async () => ({ machines: [{ machineId: 'guest', online: true }] }), orchestrationDirectory: '.',
        startCombined: async () => { throw new Error('Review cannot start a Run'); },
        waitForRun: async () => { throw new Error('Review cannot wait for a Run'); },
    });
    const executor = createActionExecutor({ ...deps, machineSetupPlan: combined.machineSetupPlan });
    const request = { executeAction: executor.execute, context: { surface: 'ui' as const, authority: 'present_user' as const },
        homeId: 'home', machineId: 'guest', targets: [{ homeId: 'home', machineId: 'guest' }],
        setup: { items: [owned, preExisting, shared] }, intent: 'remove' as const, isCurrent: () => true };
    const unselected = await prepareMachineSetupSoftwareApplyInput(request);
    expect(unselected).toMatchObject({ ok: true, facts: [{ removalOffers: [
        { itemKey: machineSetupItemKeyV1(owned), status: 'eligible', selected: false },
        { itemKey: machineSetupItemKeyV1(preExisting), status: 'notEligible', reason: 'preExisting' },
    ] }], input: { targets: [{ sources: [sources[0], { kind: 'direct', setup: { items: [shared, foreign, owned, preExisting],
        scripts: sources[1]!.setup.scripts } }], recipePlans: [], removalPlans: [], removeItemKeys: [] }] } });
    const selected = await prepareMachineSetupSoftwareApplyInput({ ...request,
        removeItemKeys: { guest: [machineSetupItemKeyV1(owned)] } });
    expect(selected).toMatchObject({ ok: true, input: { targets: [{ sources: [sources[0], { kind: 'direct', setup: {
        items: [shared, foreign, preExisting], scripts: sources[1]!.setup.scripts,
    } }], recipePlans: [], removeItemKeys: [machineSetupItemKeyV1(owned)],
    removalPlans: [{ itemKey: machineSetupItemKeyV1(owned), plan: { steps: [{ executable: 'rm', args: ['--', 'owned'] }] } }] }] } });
    expect(await prepareMachineSetupSoftwareApplyInput({ ...request,
        removeItemKeys: { guest: [machineSetupItemKeyV1(preExisting)] } })).toMatchObject({ ok: false, errorCode: 'remove_unsupported' });
    const software = await import('./machineSetupSoftware');
    const { countMachineSetupTargetChanges, groupMachineSetupChanges } = await import('./machineSetupReviewChanges');
    const removal = await software.prepareMachineSetupSoftwareRemoveInput({ ...request,
        removeItemKeys: [machineSetupItemKeyV1(owned)] });
    expect(removal.ok).toBe(true);
    if (!removal.ok) throw new Error(removal.errorCode);
    expect(removal.input).not.toHaveProperty('targets');
    expect(removal.input).not.toHaveProperty('recipePlans');
    expect(countMachineSetupTargetChanges(removal.input)).toBe(1);
    expect(groupMachineSetupChanges([removal.input])).toEqual([{ kind: 'commands', added: 0, removed: 1,
        lines: [{ machineIds: ['guest'], operand: '$ rm -- owned', removes: true }] }]);
    // The machine transport is the effect boundary. The real Action executor
    // validates the exact reviewed removal input; no native effect runs here.
    let received: unknown;
    const removeExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ presentUserActionConfirmation: async () => true,
        machineSetupRemove: async ({ input }) => {
        received = input;
        return { operationId: 'remove-operation' };
    } }));
    const result = await software.removeMachineSetupSoftware({ executeAction: { confirmed: removeExecutor.execute },
        context: request.context, prepared: removal });
    expect(result).toEqual({ ok: true, result: { operationId: 'remove-operation' } });
    expect(received).toEqual(removal.input);

});
