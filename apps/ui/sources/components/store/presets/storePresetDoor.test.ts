import { describe, expect, it } from 'vitest';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectAddToPresetChoices } from './storePresetDoor';

const chrome = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'tools.browsers', recipeId: 'chrome', revision: '2' }, inputs: {} } };
const kuma = { kind: 'app' as const, definition: { name: 'Status page', project: { kind: 'create' as const },
    definition: { from: 'catalogApp' as const, templateRef: { sourceId: 'catalog', itemId: 'uptime-kuma', version: '2.0.2' } } } };
const preset = (id: string, items: ManagedMachinePresetV1['setup'] extends infer S ? S extends { items?: infer I } ? I : never : never): ManagedMachinePresetV1 =>
    ({ homeId: 'srv', id, revision: 1, name: id, owner: { kind: 'account', accountId: 'a' }, setup: { items } }) as ManagedMachinePresetV1;

describe('projectAddToPresetChoices', () => {
    it('marks a preset that already sets up the same recipe, at any revision, as already in it', () => {
        const rows = [preset('research', [{ ...chrome, selection: { ...chrome.selection, ref: { ...chrome.selection.ref, revision: '1' } } }]), preset('shop', [])];
        const choices = projectAddToPresetChoices(rows.map(p => ({ serverId: 's1', preset: p })), chrome);
        expect(choices.map(c => [c.preset.id, c.contains])).toEqual([['research', true], ['shop', false]]);
    });
    it('matches an app by its catalog identity, not its pinned version', () => {
        const pinned = { ...kuma, definition: { ...kuma.definition, definition: { ...kuma.definition.definition,
            templateRef: { ...kuma.definition.definition.templateRef, version: '1.9.0' } } } };
        const choices = projectAddToPresetChoices([{ serverId: 's1', preset: preset('ops', [pinned]) }, { serverId: 's1', preset: preset('web', [chrome]) }], kuma);
        expect(choices.map(c => [c.preset.id, c.contains])).toEqual([['ops', true], ['web', false]]);
    });
});
