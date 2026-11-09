import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';

import { createMachineFixture } from './machineFixtures';

/** Real Administration selection/inventory state for screen subscription tests. */
export async function createMachineAdministrationFixture(selectionKey: string) {
    const previousState = storage.getState();
    const profiles = await Promise.all([1, 2].map(async (index) => {
        const serverUrl = `https://prompt-administration-${index}.example.test`;
        await upsertServerProfile({ serverUrl, name: `Prompt Administration ${index}` });
        const profile = await setServerProfileIdentityForUrl(serverUrl, `srv_prompt_administration_${index}`);
        if (!profile) throw new Error('Administration test profile was not created');
        return profile;
    }));
    const targets = profiles.map((profile, index): MachineAdministrationTargetV1 => ({
        serverIdentityId: profile.serverIdentityId!,
        machineId: `machine-${index + 1}`,
    }));
    const machines = targets.map((target, index) => {
        const machine = createMachineFixture({ id: target.machineId, activeAt: Date.now() });
        return {
            ...machine,
            metadata: {
                ...machine.metadata!,
                displayName: index === 0 ? 'Laptop' : 'Desktop',
                host: index === 0 ? 'laptop.local' : 'desktop.local',
                homeDir: index === 0 ? '/Users/test' : '/Users/desktop',
            },
        };
    });
    const selectTarget = (target: MachineAdministrationTargetV1 | null) => {
        storage.setState((state) => ({
            settings: {
                ...state.settings,
                machineAdministrationTargetsLocalV1: target ? { [selectionKey]: target } : {},
            },
        }));
    };
    storage.setState({
        isDataReady: true,
        machineListByServerId: Object.fromEntries(profiles.map((profile, index) => [profile.id, [machines[index]]])),
        machineListStatusByServerId: Object.fromEntries(profiles.map((profile) => [profile.id, 'idle' as const])),
    });
    selectTarget(targets[0]);

    return {
        targets,
        serverIds: profiles.map((profile) => profile.id),
        selectTarget,
        async cleanup() {
            storage.setState(previousState);
            for (const profile of profiles) await removeServerProfile(profile.id);
        },
    };
}
