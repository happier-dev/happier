import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { StoreAddToPresetButton, StorePresetEditorHandoff } = await import('./StoreAddToPreset');
const { StoreListingPaneTitleContext } = await import('../storeListingPaneTitle');
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

const item = { kind: 'softwareRecipe' as const,
    selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' }, inputs: {} } };

it('says why its presets could not be read, with Retry, instead of an empty menu', async () => {
    const door = await renderScreen(<StoreAddToPresetButton serverId="srv" item={item} name="Google Chrome"
        onChoose={() => {}} testID="door" />);
    const menu = () => door.tree.findAll(node => node.props.testID === 'door.menu' && typeof node.props.onSelect === 'function')[0]!;
    await act(async () => menu().props.onOpenChange(true));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // Every saved preset read in this harness resolves unavailable (no bound Account on this server).
    const state = menu().props.header as React.ReactElement<{ testID: string }>;
    expect(state?.props.testID).toBe('door.state');
    expect(typeof (state.props as { onRetry?: unknown }).onRetry).toBe('function');
    expect(menu().props.items.map((entry: { id: string }) => entry.id)).toEqual(['store.preset.new']);
    await door.unmount();
});

it('starts a new preset from the door with the picked item already in it, and Cancel goes back', async () => {
    const onChoose = vi.fn();
    const door = await renderScreen(<StoreAddToPresetButton serverId="srv" item={item} name="Google Chrome"
        onChoose={onChoose} testID="door" />);
    const menu = door.tree.findAll(node => node.props.testID === 'door.menu' && typeof node.props.onSelect === 'function')[0]!;
    await act(async () => menu.props.onSelect('store.preset.new'));
    expect(onChoose).toHaveBeenCalledWith({ serverId: 'srv', preset: null, itemName: 'Google Chrome' });
    await door.unmount();

    const onReturn = vi.fn();
    const setPaneTitle = vi.fn();
    const screen = await renderScreen(<StoreListingPaneTitleContext.Provider value={setPaneTitle}>
        <StorePresetEditorHandoff choice={{ serverId: 'srv', preset: null, itemName: 'Google Chrome' }} item={item} onReturn={onReturn} />
    </StoreListingPaneTitleContext.Provider>);
    // The person sees why they are here: the picked item joins this new preset's Setup (Store delta 2 fix 5).
    expect(screen.getTextContent()).toContain('Google Chrome');
    // The listing pane is titled for the editor it handed its room to, never the kind word again.
    expect(setPaneTitle).toHaveBeenLastCalledWith(expect.stringMatching(/\S/));
    // First the same provider picker the Presets page uses, kept in place so the item travels with it.
    const picker = screen.tree.findAll(node => typeof node.props.onSelectProvisioner === 'function')[0]!;
    expect(picker.props.presetOnly).toBe(true);
    await act(async () => picker.props.onSelectProvisioner({ serverId: 'srv', provisioner: 'acme.cloud/vm' }));
    const editor = screen.tree.findAll(node => node.props.presetContinuation !== undefined)[0]!;
    expect(editor.props).toMatchObject({ serverId: 'srv', provisioner: 'acme.cloud/vm', presetOnly: true });
    expect(editor.props.presetId).toBeUndefined();
    expect(editor.props.presetContinuation).toMatchObject({ item, draft: { name: '' } });
    expect(editor.props.presetContinuation.preset).toBeUndefined();
    await screen.unmount();
    expect(setPaneTitle).toHaveBeenLastCalledWith(null);

    const back = await renderScreen(<StorePresetEditorHandoff choice={{ serverId: 'srv', preset: null }} item={item}
        onReturn={onReturn} />);
    await act(async () => back.pressByTestId('store.preset.new.cancel'));
    expect(onReturn).toHaveBeenCalledTimes(1);
    await back.unmount();
});

it('saves and reads back the carried Software with the exact Lima #131 fields and no mounts edit', async () => {
    const { LIMA_PLUGIN } = await import('../../../../../../packages/plugins/machine-lima/src/manifest');
    const { DEVCONTAINER_PLUGIN } = await import('../../../../../../packages/plugins/devcontainer/src/manifest');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(LIMA_PLUGIN.manifest);
    const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
        packageName: '@happier-dev/plugins-machine-lima', displayName: 'Lima Machines', entriesById: {}, normalizedManifest: manifest },
        { pluginId: DEVCONTAINER_PLUGIN.manifest.id, pluginVersion: DEVCONTAINER_PLUGIN.manifest.version,
            packageName: '@happier-dev/plugins-devcontainer', displayName: 'Docker container Machines', entriesById: {},
            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse(DEVCONTAINER_PLUGIN.manifest) }]));
    const serverId = await home.addHome({ name: 'Recipes', serverUrl: 'https://recipes.example.test',
        serverIdentityId: 'srv_recipes', accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain' });
    const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const { buildQualifiedPluginContributionKey } = await import('@happier-dev/protocol/plugins/contribution-identity');
    const { ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetRecipientCensusInputV1Schema,
        ManagedMachinePresetRecipientCensusResultV1Schema, ManagedMachinePresetV1Schema, PresetMutationResultV1Schema } =
        await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    const descriptor = manifest.contributes.machineProvisioners[0]!;
    const provisioner = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: descriptor.id });
    const onReturn = vi.fn();
    // Written by the boundary handler; a holder keeps the closure write visible to control flow.
    const persisted: { preset: ReturnType<typeof ManagedMachinePresetV1Schema.parse> | null } = { preset: null };
    const runtime = await import('@/utils/system/runtimeFetch');
    const runtimeHost = vi.spyOn(runtime, 'readRuntimeFetchHost');
    onTestFinished(() => runtimeHost.mockRestore());
    routerPush.mockClear();
    const screen = await renderScreen(<StorePresetEditorHandoff choice={{ serverId, preset: null }} item={item} onReturn={onReturn} />);
    try {
        const row = `managed-picker.provisioners.local.${provisioner}`;
        await waitForHomeGovernance(() => expect(screen.findByTestId(row), screen.getTextContent()).not.toBeNull());
        await act(async () => screen.pressByTestId(screen.findByTestId(`${row}.action`) ? `${row}.action` : row));
        const setup = () => screen.tree.findAll(node => node.props.testID === 'managed-config.setup'
            && typeof node.props.onChange === 'function')[0]?.props.setup;
        await waitForHomeGovernance(() => expect(setup(), screen.getTextContent()).toMatchObject({ items: [item] }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:store')).not.toBeNull());
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        for (const [field, value] of Object.entries({ store: '/home/happier/.lima', image: 'https://images.example.test/lima.qcow2',
            cpus: '4', memoryGiB: '4', diskGiB: '100' })) {
            await act(async () => screen.changeTextByTestId(`managed-config.field:${field}`, value));
        }
        // Enum fields use the production field-selection contract, just like a press in their menu.
        const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
        const form = screen.tree.findAllByType(ActionInputFields)[0]!;
        await act(async () => form.props.onPatch({ arch: 'x86_64', vmType: 'qemu' }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled, screen.getTextContent()).toBe(false));
        expect(form.props.input.mounts).toEqual([]);
        home.answer(serverId, '/v1/machines/presets/recipient-census', { select: value => {
            ManagedMachinePresetRecipientCensusInputV1Schema.parse(value);
            return { body: ManagedMachinePresetRecipientCensusResultV1Schema.parse({
                kind: 'ready', contentEncryptionMode: 'plain', recipients: [],
            }) };
        } });
        home.answer(serverId, '/v1/machines/presets/create', { select: value => {
            const input = ManagedMachinePresetCreateInputV1Schema.parse(value);
            persisted.preset = ManagedMachinePresetV1Schema.parse({ ...input, revision: 1 });
            return { body: PresetMutationResultV1Schema.parse({ kind: 'saved', preset: persisted.preset }) };
        } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(home.requestsFor('/v1/machines/presets/recipient-census')).toHaveLength(1));
        await waitForHomeGovernance(() => expect(onReturn).toHaveBeenCalledTimes(1));
        const request = ManagedMachinePresetCreateInputV1Schema.parse(home.requestsFor('/v1/machines/presets/create')[0]?.input);
        expect(request).toMatchObject({ contentEncryptionMode: 'plain', recipients: [], content: { t: 'plain', v: {
            setup: { items: [item] }, launch: { provider: { pluginId: manifest.id, localId: descriptor.id },
                choices: { store: '/home/happier/.lima', image: 'https://images.example.test/lima.qcow2',
                    arch: 'x86_64', vmType: 'qemu', cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] } },
        } } });
        expect(request).not.toHaveProperty('launch');
        expect(request).not.toHaveProperty('setup');
        expect(runtimeHost).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
        expect(home.requests.filter(request => /machines\.provisioners\.(check|options)|machines\.managed\.acquire/.test(request.path))).toHaveLength(0);
        expect(home.requestsFor('/v4/connect/qualified/accounts')).toHaveLength(0);
    } finally { await screen.unmount(); }

    const saved = persisted.preset;
    if (!saved) throw new Error('Expected persisted Lima preset');
    home.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
    const { createMachinePresetCollectionClient } = await import('@/sync/ops/machines/machinePresetCollectionClient');
    const readBack = await createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_recipes')
        .read('machines.presets.get', { homeId: 'srv_recipes', id: saved.id });
    if (readBack.kind !== 'succeeded' || readBack.value.kind !== 'found') throw new Error('Expected persisted Lima preset readback');
    expect(readBack.value.preset.launch?.choices).toMatchObject({ store: '/home/happier/.lima',
        image: 'https://images.example.test/lima.qcow2', arch: 'x86_64', vmType: 'qemu',
        cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] });
    expect(home.requestsFor('/v1/machines/presets/get')).toHaveLength(1);

    // A second local descriptor takes the same authoring path; its native review digest is never a user field.
    const container = PluginPortableReleaseManifestV1Schema.parse(DEVCONTAINER_PLUGIN.manifest);
    const containerKey = buildQualifiedPluginContributionKey({ pluginId: container.id, localId: container.contributes.machineProvisioners[0]!.id });
    const next = await renderScreen(<StorePresetEditorHandoff choice={{ serverId, preset: null }} item={item} onReturn={onReturn} />);
    try {
        const row = `managed-picker.provisioners.local.${containerKey}`;
        await waitForHomeGovernance(() => expect(next.findByTestId(row)).not.toBeNull());
        await act(async () => next.pressByTestId(next.findByTestId(`${row}.action`) ? `${row}.action` : row));
        await waitForHomeGovernance(() => expect(next.findByTestId('managed-config.setup')).not.toBeNull());
        const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
        const fields = next.tree.findAllByType(ActionInputFields).flatMap(form => form.props.fields);
        expect(fields.some(field => field.path === 'reviewedEffectDigest')).toBe(false);
        expect(next.findByTestId('managed-config.create')?.props.disabled).toBe(true);
    } finally { await next.unmount(); }
});
