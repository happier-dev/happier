import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

installSettingsViewCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ renderCustomModals: true }).module;
    },
});
afterEach(() => standardCleanup());
const { ModalProvider } = await import('@/modal');
const { prepareMachineSetupPresetApplyInput } = await import('./machineSetupApply');
const { showManagedCreationReview } = await import('./ManagedCreationReview');
const ref = { pluginId: 'example.host', recipeId: 'journal', revision: '1' };
const recipe = { id: 'example.host/journal', pluginId: ref.pluginId, pluginVersion: '1', definition: MachineRecipeV1Schema.parse({
    id: ref.recipeId, revision: ref.revision, title: 'Journal',
    inputSchema: { type: 'object', properties: { maximumUse: { type: 'string', minLength: 1 } }, required: ['maximumUse'], additionalProperties: false },
    inputHints: { fields: [{ path: 'maximumUse', title: 'Maximum disk use', widget: 'text', required: true }] }, steps: [],
}) };

it('keeps managed creation incomplete until the saved preset inputs are edited', async () => {
    const onConfirm = vi.fn();
    const onEditSetup = vi.fn();
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => { showManagedCreationReview({ name: 'Host', server: { title: 'Host', spec: 'Server', mark: null },
        preset: { name: 'Security', revision: 1 }, scope: null, confirmLabel: 'Create', onConfirm, onEditSetup,
        projection: { ...EMPTY_PLUGIN_UI_PROJECTION, machineRecipesById: { [recipe.id]: recipe } },
        setup: { items: [{ kind: 'setupRecipe', selection: { ref, inputs: {} } }] },
    }); });
    expect(screen.findByTestId('managed-config.review.confirm')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('managed-config.review.edit-inputs');
    expect(onEditSetup).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    await screen.unmount();
});

it('collects required selected recipe inputs before the first effects Plan and carries the reviewed source copy into Apply', async () => {
    const dispose = publishCommittedAppShellPluginUiProjection(() => ({ ...EMPTY_PLUGIN_UI_PROJECTION, machineRecipesById: { [recipe.id]: recipe } }));
    const requests: unknown[] = [];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
        requests.push(input);
        const single = 'targets' in input ? null : input;
        return MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0,
            sources: single?.sources ?? [{ kind: 'direct', setup: {} }], support: [], exclusions: [],
            ...(single?.mode === 'effects' ? { recipePlans: [] } : {}),
        });
    } }));
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    let prepared: Awaited<ReturnType<typeof prepareMachineSetupPresetApplyInput>> | undefined;
    let pending: Promise<void>;
    await act(async () => { pending = prepareMachineSetupPresetApplyInput({ executeAction: executor.execute, context: { surface: 'ui', serverId: 'fixture-home', expectedAccountId: 'owner' },
        homeId: 'home', machineId: 'machine', preset: createPlainManagedMachinePresetFixture({ id: 'preset', homeId: 'home', revision: 1, name: 'Saved setup', owner: { kind: 'account', accountId: 'owner' }, setup: { items: [
            { kind: 'setupRecipe', selection: { ref, inputs: {} } },
        ] } }).opened, isCurrent: () => true }).then(value => { prepared = value; }); });
    expect(requests).toHaveLength(0);
    const field = screen.tree.findAll(node => node.props?.testID === 'machine-setup-inputs.0.maximumUse'
        && typeof node.props.onChangeText === 'function')[0];
    expect(field).toBeDefined();
    await act(async () => { field!.props.onChangeText('2G'); });
    await screen.pressByTestIdAsync('machine-setup-inputs.confirm');
    await act(async () => { await pending!; });
    expect(prepared).toMatchObject({ ok: true, input: { targets: [{ sources: [
        { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 1, contentEncryptionMode: 'plain', presetContentOverride: { content: { t: 'plain', v: { setup: { items: [{ selection: { inputs: { maximumUse: '2G' } } }] } } } } },
        { kind: 'direct' },
    ] }] } });
    await screen.unmount();
    dispose();
});

it('cancels input review without planning or changing the preset', async () => {
    const dispose = publishCommittedAppShellPluginUiProjection(() => ({ ...EMPTY_PLUGIN_UI_PROJECTION, machineRecipesById: { [recipe.id]: recipe } }));
    const requests: unknown[] = [];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
        requests.push(input);
        return MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], support: [], exclusions: [] });
    } }));
    const preset = createPlainManagedMachinePresetFixture({ id: 'preset', homeId: 'home', revision: 1, name: 'Saved setup', owner: { kind: 'account', accountId: 'owner' }, setup: { items: [{ kind: 'setupRecipe' as const, selection: { ref, inputs: {} } }] } }).opened;
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    let pending: ReturnType<typeof prepareMachineSetupPresetApplyInput>;
    await act(async () => { pending = prepareMachineSetupPresetApplyInput({ executeAction: executor.execute,
        context: { surface: 'ui', serverId: 'fixture-home', expectedAccountId: 'owner' }, homeId: 'home', machineId: 'machine', preset, isCurrent: () => true }); });
    await screen.pressByTestIdAsync('machine-setup-inputs.cancel');
    expect(await pending!).toBeNull();
    expect(requests).toHaveLength(0);
    const item = preset.setup?.items?.[0];
    if (item?.kind !== 'setupRecipe') throw new Error('Expected retained setup recipe');
    expect(item.selection.inputs).toEqual({});
    await screen.unmount();
    dispose();
});
