import {
    resolveCliInvokerNameForPublicRing,
    resolvePublicReleaseRingIdForLabel,
    resolvePublicReleaseRingLabelForId,
    type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

import { readDefaultManagedReleaseChannel } from '../firstPartyRuntime/defaultReleaseChannelState.js';

import type { HappierInstallationInventory } from './types.js';

const RELEASE_CHANNEL_SORT_ORDER: Record<PublicReleaseRingId, number> = {
    stable: 0,
    preview: 1,
    publicdev: 2,
};

export type ManagedReleaseChannelInventoryEntry = Readonly<{
    releaseChannel: PublicReleaseRingId;
    label: 'stable' | 'preview' | 'dev';
    version: string | null;
    installationId: string;
    installationPath: string;
    invokerName: string;
    isDefault: boolean;
    onPath: boolean;
}>;

export type ManagedReleaseChannelInventory = Readonly<{
    defaultReleaseChannel: PublicReleaseRingId;
    managedReleaseChannels: readonly ManagedReleaseChannelInventoryEntry[];
}>;

export async function deriveManagedReleaseChannelInventory(params: Readonly<{
    inventory: HappierInstallationInventory;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<ManagedReleaseChannelInventory> {
    const defaultReleaseChannel = await readDefaultManagedReleaseChannel({ processEnv: params.processEnv });
    const managedReleaseChannels = params.inventory.installations
        .filter((installation) => (
            installation.source === 'firstPartyManaged'
            && installation.components.includes('happier-cli')
            && installation.ring != null
        ))
        .flatMap((installation) => {
            const releaseChannel = resolvePublicReleaseRingIdForLabel(installation.ring!);
            if (!releaseChannel) {
                return [];
            }

            return [{
                releaseChannel,
                label: resolvePublicReleaseRingLabelForId(releaseChannel),
                version: installation.version,
                installationId: installation.id,
                installationPath: installation.path,
                invokerName: resolveCliInvokerNameForPublicRing(releaseChannel),
                isDefault: releaseChannel === defaultReleaseChannel,
                onPath: installation.onPath,
            } satisfies ManagedReleaseChannelInventoryEntry];
        })
        .sort((left, right) => RELEASE_CHANNEL_SORT_ORDER[left.releaseChannel] - RELEASE_CHANNEL_SORT_ORDER[right.releaseChannel]);

    return {
        defaultReleaseChannel,
        managedReleaseChannels,
    };
}
