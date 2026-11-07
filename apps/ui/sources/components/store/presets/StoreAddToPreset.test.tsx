import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { StoreAddToPresetButton, StorePresetEditorHandoff } = await import('./StoreAddToPreset');
const { StoreListingPaneTitleContext } = await import('../storeListingPaneTitle');
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

const item = { kind: 'softwareRecipe' as const,
    selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' }, inputs: {} } };

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
