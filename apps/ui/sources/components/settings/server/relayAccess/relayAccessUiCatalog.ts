import { filterRelayAccessProviderDescriptors, relayAccessProviderDescriptors, type RelayAccessProviderDescriptor, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { TranslationKey } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';

export type RelayAccessProviderUiDefinition = Readonly<{
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IconName;
}>;

/** Presentation only: availability and config admission stay with the canonical descriptor. */
export const relayAccessProviderUiCatalog: Readonly<Record<string, RelayAccessProviderUiDefinition>> = Object.freeze(
    Object.fromEntries(relayAccessProviderDescriptors.flatMap(descriptor => descriptor.homeUi ? [[descriptor.id, {
        titleKey: descriptor.homeUi.titleKey as TranslationKey,
        subtitleKey: descriptor.homeUi.subtitleKey as TranslationKey,
        iconName: descriptor.definition.icon as IconName,
    }]] : [])),
);

export function relayAccessProviderUsesPrerequisitesStep(providerId: RelayAccessProviderId | null | undefined): boolean {
    const descriptor = getAvailableRelayAccessProviderDescriptors().find(candidate => candidate.id === providerId);
    return (descriptor?.prerequisites.length ?? 0) > 0;
}

export function relayAccessProviderSupportsTarget(
    providerId: RelayAccessProviderId,
    _target: RelayAccessTaskTarget | null | undefined,
): boolean {
    return getAvailableRelayAccessProviderDescriptors().some(descriptor => descriptor.id === providerId);
}

export function getAvailableRelayAccessProviderDescriptors(): readonly RelayAccessProviderDescriptor[] {
    return filterRelayAccessProviderDescriptors(resolveSetupSurfacePolicy().relayAccess)
        .filter(descriptor => descriptor.definition.targets.includes('homeRelay'));
}
