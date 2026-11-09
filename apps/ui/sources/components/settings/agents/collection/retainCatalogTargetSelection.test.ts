import { describe, expect, it } from 'vitest';

import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { resolveMachineAdministrationTargetState, type MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

installUiListsCommonModuleMocks();

const { retainCatalogTargetSelection } = await import('./useAgentAdministrationCatalog');

const target = { serverIdentityId: 'home-a', machineId: 'machine-a' };

function machine(overrides: Partial<MachineDisplayRenderable> = {}): MachineDisplayRenderable {
    return {
        id: 'machine-a', metadataVersion: 1, active: true, activeAt: 1, updatedAt: 1,
        metadata: { displayName: 'Machine A', host: 'a.local', agentInventory: undefined }, ...overrides,
    };
}

function selectionFor(record: MachineDisplayRenderable, observedAt = 1): MachineAdministrationTargetSelectionV1 {
    const candidate: MachineAdministrationCandidateV1 = {
        target, displayName: 'Machine A', serverLabel: 'Home', availability: 'online', observation: 'live', observedAt,
    };
    return {
        candidates: [candidate], pickerRows: [{ candidate, machine: record, serverId: 'home-a', serverName: 'Home' }],
        state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [candidate] }),
        selectedTarget: target, selectedTargetServerMatchesActiveAccount: true, canExecute: true,
        selectTarget: () => {}, clearTarget: () => {}, resolveExecutionTarget: () => null,
    };
}

describe('retainCatalogTargetSelection', () => {
    it('keeps the selection when only fields the catalog does not read change', () => {
        const before = selectionFor(machine());
        // Heartbeat clocks and the observation stamp are not catalog facts.
        const after = selectionFor(machine({ activeAt: 99, updatedAt: 99 }), 99);
        expect(retainCatalogTargetSelection(before, after)).toBe(before);
    });

    it.each([
        ['display name', machine({ metadata: { displayName: 'Renamed', host: 'a.local' } })],
        ['published agent inventory', machine({ metadata: { displayName: 'Machine A', host: 'a.local', agentInventory: { v: 1 } as never } })],
        ['presence', machine({ active: false })],
    ])('publishes a new selection when a field the catalog reads changes: %s', (_label, changed) => {
        const before = selectionFor(machine());
        const after = selectionFor(changed);
        expect(retainCatalogTargetSelection(before, after)).toBe(after);
    });
});
