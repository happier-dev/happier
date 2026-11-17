import { describe, expect, it, vi } from 'vitest';

import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';

import {
    buildTeamCredentialBrokerMachineSelection,
    presentTeamCredentialBrokerMachineCandidate,
} from './teamCredentialBrokerMachineSelection';

describe('buildTeamCredentialBrokerMachineSelection', () => {
    it('keeps the Home-qualified eligible set when two profiles expose duplicate names and machine ids', () => {
        const source = createMachineAdministrationTargetSelectionFixture({
            serverId: 'profile-a',
            serverIdentityId: 'identity-a',
            machines: [
                { machineId: 'same-id', displayName: 'Studio', serverId: 'profile-a', serverIdentityId: 'identity-a', serverLabel: 'Home A' },
                { machineId: 'same-id', displayName: 'Studio', serverId: 'profile-b', serverIdentityId: 'identity-b', serverLabel: 'Home B' },
                { machineId: 'ineligible', displayName: 'Studio', serverId: 'profile-a', serverIdentityId: 'identity-a', serverLabel: 'Home A' },
            ],
        });
        const onSelectMachineId = vi.fn();
        const result = buildTeamCredentialBrokerMachineSelection({
            serverId: 'profile-a',
            eligibleTargets: [{ machineId: 'same-id', displayName: 'server copy', availability: 'offline' }],
            selectedMachineId: null,
            pickerRows: source.pickerRows,
            onSelectMachineId,
            onClear: vi.fn(),
        });

        expect(result.selection.pickerRows).toHaveLength(1);
        expect(result.selection.pickerRows[0]?.candidate).toMatchObject({
            target: { serverIdentityId: 'identity-a', machineId: 'same-id' },
            displayName: 'Studio',
            serverLabel: 'Home A',
            availability: 'offline',
        });
        result.selection.selectTarget(result.selection.pickerRows[0]!.candidate.target);
        expect(onSelectMachineId).toHaveBeenCalledWith('same-id');
    });

    it('does not call a still-eligible broker machine gone while this device has not listed it yet', () => {
        const source = createMachineAdministrationTargetSelectionFixture({
            serverId: 'profile-a',
            serverIdentityId: 'identity-a',
            machines: [],
        });
        const build = (eligibleIds: readonly string[]) => buildTeamCredentialBrokerMachineSelection({
            serverId: 'profile-a',
            eligibleTargets: eligibleIds.map((machineId) => ({ machineId, displayName: 'Studio', availability: 'available' as const })),
            selectedMachineId: 'broker',
            pickerRows: source.pickerRows,
            onSelectMachineId: vi.fn(),
            onClear: vi.fn(),
        });
        // The Home still lists it as eligible: this device's machine rows have just not arrived.
        expect(build(['broker']).selection.state).toMatchObject({ kind: 'missing', inventoryKnown: false });
        // The Home no longer lists it: it has really left the choice.
        expect(build([]).selection.state).not.toHaveProperty('inventoryKnown');
    });

    it('keeps update-required as a visible disabled-state candidate without trusting the server display label', () => {
        const source = createMachineAdministrationTargetSelectionFixture({
            serverId: 'profile-a',
            serverIdentityId: 'identity-a',
            machines: [{ machineId: 'old', displayName: 'Canonical name', serverId: 'profile-a' }],
        });
        const onSelectMachineId = vi.fn();
        const result = buildTeamCredentialBrokerMachineSelection({
            serverId: 'profile-a',
            eligibleTargets: [{ machineId: 'old', displayName: 'untrusted presentation', availability: 'update_required' }],
            selectedMachineId: null,
            pickerRows: source.pickerRows,
            onSelectMachineId,
            onClear: vi.fn(),
        });

        expect(result.selection.candidates[0]).toMatchObject({ displayName: 'Canonical name', availability: 'locked' });
        expect(JSON.stringify(result.selection)).not.toContain('untrusted presentation');
        result.selection.selectTarget(result.selection.candidates[0]!.target);
        expect(onSelectMachineId).not.toHaveBeenCalled();
    });

    it('does not let an offline eligibility projection revive a canonically locked Machine', () => {
        const source = createMachineAdministrationTargetSelectionFixture({
            serverId: 'profile-a',
            serverIdentityId: 'identity-a',
            machines: [{
                machineId: 'locked',
                displayName: 'Locked Machine',
                serverId: 'profile-a',
                availability: 'locked',
            }],
        });
        const result = buildTeamCredentialBrokerMachineSelection({
            serverId: 'profile-a',
            eligibleTargets: [{ machineId: 'locked', displayName: null, availability: 'offline' }],
            selectedMachineId: null,
            pickerRows: source.pickerRows,
            onSelectMachineId: vi.fn(),
            onClear: vi.fn(),
        });

        expect(result.selection.candidates[0]?.availability).toBe('locked');
    });

    it('never falls back to opaque ids when canonical presentation is unnamed', () => {
        const source = createMachineAdministrationTargetSelectionFixture({
            serverId: 'profile-a',
            serverIdentityId: 'identity-a',
            serverLabel: 'identity-a',
            machines: [{ machineId: 'opaque-machine-id', displayName: 'opaque-machine-id', serverId: 'profile-a' }],
        });
        const candidate = source.candidates[0]!;

        const presentation = presentTeamCredentialBrokerMachineCandidate({
            candidate,
            pickerRows: source.pickerRows,
            unnamedTitle: 'Unnamed Machine',
        });

        expect(presentation).toEqual({ title: 'Unnamed Machine' });
        expect(JSON.stringify(presentation)).not.toContain(candidate.target.machineId);
        expect(JSON.stringify(presentation)).not.toContain(candidate.target.serverIdentityId);
    });
});
