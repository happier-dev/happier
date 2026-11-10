import type { ConnectedServiceUsageSourceV1 } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeBindingIdentity } from '../runtimeRegistry/target';

/** Project the Session runtime owner's active selection for usage admission. */
export function resolveProviderAccountUsageAuthoritativeSource(input: Readonly<{
    source: ConnectedServiceUsageSourceV1;
    activeBindings: readonly ConnectedServiceRuntimeBindingIdentity[];
}>): ConnectedServiceUsageSourceV1 | null {
    const current = input.activeBindings.find(binding => binding.serviceId === input.source.serviceId);
    if (!current || current.profileId !== input.source.profileId) return null;
    return current.groupId === null
        ? { serviceId: current.serviceId, profileId: current.profileId, bindingKind: 'profile' }
        : current.groupGeneration === null ? null
        : { serviceId: current.serviceId, profileId: current.profileId, bindingKind: 'group_member',
            groupId: current.groupId, groupGeneration: current.groupGeneration };
}
