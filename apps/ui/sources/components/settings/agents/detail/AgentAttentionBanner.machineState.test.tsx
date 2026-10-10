import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { resolveMachineAdministrationTargetState, type MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

installUiListsCommonModuleMocks();

const { useAgentsMachineScope, resolveAgentsMachineCandidateAvailability } = await import('../collection/useAgentAdministrationCatalog');
const { MachineAdministrationTargetSelector, useMachineAdministrationTargetFilter } = await import('../../machines/MachineAdministrationTargetSelector');
const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');

function selectionFor(availability: MachineAdministrationCandidateV1['availability'] = 'locked', observation: 'live' | 'stale' = 'live'): MachineAdministrationTargetSelectionV1 {
    const target = { serverIdentityId: 'home-a', machineId: 'machine-a' };
    const candidate: MachineAdministrationCandidateV1 = {
        target, displayName: availability === 'locked' ? 'Locked machine' : 'Machine A', serverLabel: 'Personal Home',
        availability, observation, observedAt: 1,
    };
    const machine: MachineDisplayRenderable = {
        id: target.machineId, metadata: availability === 'locked' ? null : { displayName: 'Machine A' }, metadataVersion: 1,
        active: availability === 'online' || availability === 'locked', activeAt: Date.now(), updatedAt: 1,
        ...(availability === 'locked' ? { availability: { kind: 'locked', reason: 'encryption_material_unavailable' } as const } : {}),
    };
    return {
        candidates: [candidate], pickerRows: [{ candidate, machine, serverId: 'home-a', serverName: 'Personal Home' }],
        state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [candidate] }),
        selectedTarget: target, selectedTargetServerMatchesActiveAccount: true,
        canExecute: false, selectTarget: () => {}, clearTarget: () => {},
        resolveExecutionTarget: () => resolveFreshMachineAdministrationExecutionTarget(target),
    };
}

describe('Agent machine status', () => {
    it.each(['locked', 'missing', 'replaced', 'revoked'] as const)('names a %s machine accurately in the Agents picker', (availability) => {
        const selection = selectionFor(availability, 'stale');
        expect(resolveAgentsMachineCandidateAvailability(selection.candidates[0]!)).toEqual({
            detail: `settingsPlugins.targetSelection.${availability}`, selectable: false,
        });
    });

    it('does not project an offline presence for a locked administration chip', async () => {
        const scope = await renderHook(() => useMachineAdministrationTargetFilter({ selection: selectionFor(), testIDPrefix: 'machine.truth' }));
        expect(scope.getCurrent().presence).toBeUndefined();
    });

    it('keeps a stale locked candidate locked in the shared administration picker', async () => {
        const screen = await renderScreen(<MachineAdministrationTargetSelector selection={selectionFor('locked', 'stale')} presentation="context" testIDPrefix="machine.truth" />);
        await screen.pressByTestIdAsync('machine.truth.current');
        expect(screen.findHostByTestId('machine.truth.picker-option:machine-a')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('settingsProviders.detail.machineOffline');
        expect(screen.getTextContent()).toContain('settingsPlugins.targetSelection.locked');
    });

    it('keeps a live locked machine distinct from offline without authorizing execution', async () => {
        const selection = selectionFor();
        const scope = await renderHook(() => useAgentsMachineScope(selection));
        expect(scope.getCurrent().executionTarget).toBeNull();
        expect(scope.getCurrent().offline).toBe(false);
    });

    it('still presents last-known online observations as offline', async () => {
        const selection = selectionFor('online', 'stale');
        const scope = await renderHook(() => useAgentsMachineScope(selection));
        expect(scope.getCurrent().offline).toBe(true);
        expect(scope.getCurrent().executionTarget).toBeNull();
    });

    it.each(['missing', 'replaced', 'revoked'] as const)('keeps %s targets distinct from offline', async (availability) => {
        const selection = selectionFor(availability);
        const scope = await renderHook(() => useAgentsMachineScope(selection));
        expect(scope.getCurrent().offline).toBe(false);
        expect(scope.getCurrent().executionTarget).toBeNull();
    });
});
