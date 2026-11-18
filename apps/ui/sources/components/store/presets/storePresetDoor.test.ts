import { describe, expect, it } from 'vitest';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import type { OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { projectAddToPresetChoices } from './storePresetDoor';

const chrome = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'tools.browsers', recipeId: 'chrome', revision: '2' }, inputs: {} } };
const kuma = { kind: 'app' as const, definition: { name: 'Status page', project: { kind: 'create' as const }, bindings: [],
    definition: { from: 'catalogApp' as const, templateRef: { sourceId: 'catalog', itemId: 'uptime-kuma', version: '2.0.2',
        ref: { kind: 'version' as const, version: '2.0.2' } } } } };
const preset = (id: string, items: NonNullable<ManagedMachinePresetContentV1['setup']>['items']): OpenedManagedMachinePresetV1 =>
    createPlainManagedMachinePresetFixture({ homeId: 'srv', id, revision: 1, name: id,
        owner: { kind: 'account', accountId: 'a' }, setup: { items } }).opened;

describe('projectAddToPresetChoices', () => {
    it('marks a preset that already sets up the same recipe, at any revision, as already in it', () => {
        const rows = [preset('research', [{ ...chrome, kind: 'setupRecipe', selection: { ...chrome.selection, ref: { ...chrome.selection.ref, revision: '1' } } }]), preset('shop', [])];
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
