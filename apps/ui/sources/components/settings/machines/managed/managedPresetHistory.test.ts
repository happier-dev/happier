import { describe, expect, it } from 'vitest';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildManagedPresetHistory } from './managedPresetHistory';

function row(id: string, patch: Partial<ManagedMachineV1> = {}): ManagedMachineV1 {
    return { id, homeId: 'home', custodianAccountId: 'owner', preset: { id: 'preset', revision: 1 },
        launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Original guest', choices: { cores: 2 } },
        controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'unsubmitted', creationState: 'active',
        desired: 'start', desiredWhen: 'now', intentRevision: 0, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, ...patch };
}

describe('buildManagedPresetHistory', () => {
    it('links only real resources from the exact Home and preset, keeping original revision, name and archived recovery', () => {
        const admitted = row('pending');
        const enrolled = row('joined', { enrolledMachineId: 'actual-machine', archivedAt: 0, allocation: 'confirmed-absent' });
        const history = buildManagedPresetHistory({ serverId: 'route/home', homeId: 'home', presetId: 'preset',
            machines: [admitted, enrolled, row('foreign', { homeId: 'other' }), row('one-off', { preset: undefined }),
                row('different', { preset: { id: 'other', revision: 1 } })] });
        expect(history.map(item => ({ id: item.managedId, revision: item.presetRevision, title: item.title, href: item.href }))).toEqual([
            { id: 'pending', revision: 1, title: 'Original guest', href: '/settings/machines/managed/pending?serverId=route%2Fhome' },
            { id: 'joined', revision: 1, title: 'Original guest', href: '/settings/machines/actual-machine?serverId=route%2Fhome' },
        ]);
        expect(history[1]?.machine).toBe(enrolled);
        expect(buildManagedPresetHistory({ serverId: 'route/home', homeId: 'home', presetId: 'absent', machines: [admitted] })).toEqual([]);
    });
});
