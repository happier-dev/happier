import { describe, expect, it } from 'vitest';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import { buildManagedPresetHistory, findPresetLastSavedFacts } from './managedPresetHistory';

function row(id: string, patch: Partial<ManagedMachineV1> = {}): ManagedMachineV1 {
    return { id, homeId: 'home', custodianAccountId: 'owner', preset: { id: 'preset', revision: 1 },
        launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Original guest', choices: { cores: 2 } },
        controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'unsubmitted', creationState: 'active',
        desired: 'start', desiredWhen: 'now', intentRevision: 0, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, ...patch };
}

describe('buildManagedPresetHistory', () => {
    it('retains an unreadable sealed resource in history with its public identity and generic label', () => {
        const { launch: _launch, ...structural } = row('sealed');
        const machine = { ...structural, preset: { id: 'preset', revision: 4, contentEncryptionMode: 'e2ee' as const } };
        const history = buildManagedPresetHistory({ serverId: 'home', homeId: 'home', presetId: 'preset', machines: [machine] });
        expect(history).toMatchObject([{ managedId: 'sealed', presetRevision: 4, title: t('common.machine'),
            href: '/settings/machines/managed/sealed?serverId=home' }]);
    });

    it('links only real resources from the exact Home and preset, keeping original revision, name and archived recovery', () => {
        const admitted = row('pending');
        const enrolled = row('joined', { enrolledMachineId: 'actual-machine', archivedAt: 0, allocation: 'confirmed-absent' });
        const history = buildManagedPresetHistory({ serverId: 'route/home', homeId: 'home', presetId: 'preset',
            machines: [admitted, enrolled, row('foreign', { homeId: 'other' }), row('one-off', { preset: undefined }),
                row('different', { preset: { id: 'other', revision: 1 } })] });
        expect(history.map(item => ({ id: item.managedId, revision: item.presetRevision, title: item.title, href: item.href }))).toEqual([
            { id: 'pending', revision: 1, title: 'Original guest', href: '/settings/machines/managed/pending?serverId=route%2Fhome' },
            { id: 'joined', revision: 1, title: 'Original guest', href: '/settings/machines/managed/joined?serverId=route%2Fhome' },
        ]);
        expect(history[1]?.machine).toBe(enrolled);
        expect(buildManagedPresetHistory({ serverId: 'route/home', homeId: 'home', presetId: 'absent', machines: [admitted] })).toEqual([]);
    });
});

describe('findPresetLastSavedFacts', () => {
    const facts = (choices: Record<string, number>, nativeFacts?: NonNullable<ManagedMachineV1['reviewedFacts']>['nativeFacts']) => ({
        launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Original guest', choices },
        optionStatus: 'current' as const, prerequisites: [], billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
        retentionCapabilities: { supportedIntents: ['delete' as const] }, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
        ...(nativeFacts ? { nativeFacts } : {}) });
    const saved = { size: { id: 'medium', title: 'Medium', cpuCores: 2 }, image: { id: 'ubuntu', title: 'Ubuntu' },
        location: { id: 'here', title: 'Here' } };
    const presetLaunch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Original guest', choices: { cores: 2 } };
    const history = (machines: ManagedMachineV1[]) => buildManagedPresetHistory({ serverId: 'home', homeId: 'home', presetId: 'preset', machines });

    it('takes size and image from a machine made with exactly the preset\'s saved choices, never from different ones', () => {
        expect(findPresetLastSavedFacts({ launch: presetLaunch, history: history([
            row('edited', { reviewedFacts: facts({ cores: 8 }, { image: { id: 'debian', title: 'Debian' } }) }),
            row('same', { reviewedFacts: facts({ cores: 2 }, saved) }),
        ]) })).toEqual({ size: saved.size, image: saved.image });
        // No machine made with these choices, or none that kept native facts: nothing is invented.
        expect(findPresetLastSavedFacts({ launch: presetLaunch, history: history([
            row('edited', { reviewedFacts: facts({ cores: 8 }, saved) }), row('bare', { reviewedFacts: facts({ cores: 2 }) }), row('unreviewed'),
        ]) })).toBeUndefined();
    });
});
