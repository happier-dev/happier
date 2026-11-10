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
    expect(onChoose).toHaveBeenCalledWith({ serverId: 'srv', preset: null });
    await door.unmount();

    const onReturn = vi.fn();
    const setPaneTitle = vi.fn();
    const screen = await renderScreen(<StoreListingPaneTitleContext.Provider value={setPaneTitle}>
        <StorePresetEditorHandoff choice={{ serverId: 'srv', preset: null }} item={item} onReturn={onReturn} />
    </StoreListingPaneTitleContext.Provider>);
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

it('chooses a local provider and saves the carried Software without a controller or acquisition reads', async () => {
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
        serverIdentityId: 'srv_recipes', accountId: 'owner', currentAccount: true });
    const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    onTestFinished(clearPluginAccountAvailabilityProjection);
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const { buildQualifiedPluginContributionKey } = await import('@happier-dev/protocol/plugins/contribution-identity');
    const descriptor = manifest.contributes.machineProvisioners[0]!;
    const provisioner = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: descriptor.id });
    const onReturn = vi.fn();
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
        for (const [field, value] of Object.entries({ store: '/srv/lima', image: 'https://images.example.test/linux.qcow2',
            cpus: '2', memoryGiB: '4', diskGiB: '20', mounts: '[]' })) {
            await act(async () => screen.changeTextByTestId(`managed-config.field:${field}`, value));
        }
        // Enum fields use the production field-selection contract, just like a press in their menu.
        const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
        const form = screen.tree.findAllByType(ActionInputFields)[0]!;
        await act(async () => form.props.onPatch({ arch: 'x86_64', vmType: 'qemu' }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled, screen.getTextContent()).toBe(false));
        home.answer(serverId, '/v1/machines/presets/create', { select: input => ({ body: { kind: 'saved', preset: { ...input,
            homeId: 'srv_recipes', revision: 1 } } }) });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(onReturn).toHaveBeenCalledTimes(1));
        expect(home.requestsFor('/v1/machines/presets/create')[0]?.input).toMatchObject({
            setup: { items: [item] }, launch: { provider: { pluginId: manifest.id, localId: descriptor.id },
                choices: { store: '/srv/lima', arch: 'x86_64', vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [] } },
        });
        expect(runtimeHost).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
        expect(home.requests.filter(request => /machines\.provisioners\.(check|options)|machines\.managed\.acquire/.test(request.path))).toHaveLength(0);
        expect(home.requestsFor('/v4/connect/qualified/accounts')).toHaveLength(0);
    } finally { await screen.unmount(); }

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
