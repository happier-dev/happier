import { describe, expect, it, vi } from 'vitest';

import {
    createManagedMachineSelectionDraft,
    ManagedMachineSelectionDraftReadSchema,
    ManagedMachineSelectionDraftSchema,
    managedMachineSelectionOptionId,
    buildManagedMachineSelectionOffers,
} from './managedMachineSelection';
import { buildMachineDestinationModel } from './buildMachineDestinationModel';
import { createMachineFixture } from '@/dev/testkit';

const selection = { kind: 'preset', homeId: 'home-a', id: 'preset-a', revision: 3 } as const;
const receipt = {
    launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
        name: 'Guest', choices: { cores: 2 } },
    controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current' as const,
    prerequisites: [], billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
    retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] as ('start' | 'stop' | 'delete')[] },
    retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    preset: { id: 'preset-a', revision: 3, name: 'Guest' },
};

describe('managed machine selection draft', () => {
    it('offers only current-Home unarchived recipes alongside one-off configuration without acquiring', () => {
        const onConfigure = vi.fn();
        const preset = { id: 'preset-a', homeId: 'home-a', revision: 3, name: 'Guest',
            owner: { kind: 'account' as const, accountId: 'owner' }, recipe: receipt.launch, controller: receipt.controller };
        const offers = buildManagedMachineSelectionOffers({ homeId: 'home-a', oneOffTitle: 'One-off',
            presets: [preset, { ...preset, id: 'archived', archivedAt: 1 }, { ...preset, id: 'foreign', homeId: 'home-b' }],
            onConfigure });
        expect(offers.map(offer => offer.id)).toEqual(['managed-machine:home-a:preset:preset-a:3', 'managed-machine:home-a:one-off']);
        expect(onConfigure).not.toHaveBeenCalled();
        offers[0]?.onSelect?.();
        expect(onConfigure).toHaveBeenLastCalledWith(preset);
        offers[1]?.onSelect?.();
        expect(onConfigure).toHaveBeenLastCalledWith(null);
        expect(offers[0]).not.toHaveProperty('draft');
        expect(offers[0]).not.toHaveProperty('price');
    });
    it('counts new-machine offers and waits for their projection before taking a sole-machine shortcut', () => {
        const machine = { ...createMachineFixture({ id: 'host' }), active: true, activeAt: Date.now() };
        const params = { groups: [{ serverId: 'home-a', machines: [machine], loading: false, signedOut: false }] };
        const available = buildMachineDestinationModel({ ...params,
            managedMachineProjection: { state: 'available', rowCount: 2 } });
        expect(available.managedMachineRowCount).toBe(2);
        expect(available.destinationRowCount).toBe(3);
        expect(available.soleSelectableDestination).toBeNull();
        const pending = buildMachineDestinationModel({ ...params,
            managedMachineProjection: { state: 'pending', rowCount: 0 } });
        expect(pending.destinationSetSettled).toBe(false);
        expect(pending.soleSelectableDestination).toBeNull();
        const unrelated = buildMachineDestinationModel({ ...params, purpose: 'trigger',
            managedMachineProjection: { state: 'pending', rowCount: 2 } });
        expect(unrelated.managedMachineRowCount).toBe(0);
        expect(unrelated.soleSelectableDestination?.machine.id).toBe('host');
    });

    it('keeps the executable reviewed revision separate from the receipt and defaults archive to Keep', () => {
        const draft = createManagedMachineSelectionDraft({ selection, receipt });
        expect(draft).toEqual({ selection, receipt, archiveEffect: 'keep' });
        expect(draft.selection).not.toHaveProperty('receipt');
        expect(draft.selection).not.toHaveProperty('price');
        expect(createManagedMachineSelectionDraft({ selection, receipt, archiveEffect: 'stop' }).archiveEffect).toBe('stop');
        expect(createManagedMachineSelectionDraft({ selection, receipt, archiveEffect: 'delete' }).archiveEffect).toBe('delete');
        expect(managedMachineSelectionOptionId(selection)).toBe('managed-machine:home-a:preset:preset-a:3');
        expect(managedMachineSelectionOptionId({ ...selection, homeId: 'home-b' })).not.toBe(managedMachineSelectionOptionId(selection));
        expect(managedMachineSelectionOptionId({ ...selection, revision: 4 })).not.toBe(managedMachineSelectionOptionId(selection));
    });

    it('drops only unknown stored fields and rejects known invalid executable routing or archive effects', () => {
        const draft = createManagedMachineSelectionDraft({ selection, receipt });
        const stored = { ...draft, future: true, selection: { ...selection, future: true },
            receipt: { ...receipt, future: true, controller: { ...receipt.controller, future: true } } };
        expect(ManagedMachineSelectionDraftSchema.safeParse(stored).success).toBe(false);
        expect(ManagedMachineSelectionDraftReadSchema.parse(stored)).toEqual(draft);
        expect(ManagedMachineSelectionDraftReadSchema.safeParse({ ...stored, archiveEffect: 'pause' }).success).toBe(false);
        expect(ManagedMachineSelectionDraftReadSchema.safeParse({ ...stored,
            selection: { ...selection, revision: -1 } }).success).toBe(false);
        expect(ManagedMachineSelectionDraftReadSchema.safeParse({ ...stored,
            receipt: { ...receipt, controller: { poolId: 'pool' } } }).success).toBe(false);
    });
});
