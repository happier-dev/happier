import type { ConnectedServiceUsageSourceV1 } from '@happier-dev/protocol';

import { resolveConnectedServiceGroupMemberByProviderAccountId } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

type CurrentGroupIdentity = Readonly<{
    generation: number;
    members: readonly Readonly<{ profileId: string }>[];
}>;

export async function resolveProviderAccountUsageSourceProfile(input: Readonly<{
    source: ConnectedServiceUsageSourceV1;
    providerAccountId: string;
    getCurrentGroup: () => Promise<CurrentGroupIdentity | null>;
    resolveProviderAccountId: (profileId: string) => Promise<string | null>;
}>): Promise<ConnectedServiceUsageSourceV1> {
    if (input.source.bindingKind !== 'group_member') return input.source;

    const currentGroup = await input.getCurrentGroup().catch(() => null);
    if (!currentGroup) return input.source;
    const profileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
        providerAccountId: input.providerAccountId,
        members: currentGroup.members,
        resolveProviderAccountId: input.resolveProviderAccountId,
    });
    if (!profileId) return input.source;

    return {
        serviceId: input.source.serviceId,
        profileId,
        bindingKind: 'group_member',
        groupId: input.source.groupId,
        groupGeneration: currentGroup.generation,
    };
}
