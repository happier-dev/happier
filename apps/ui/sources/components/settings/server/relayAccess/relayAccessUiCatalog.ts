import type { ComponentProps } from 'react';
import { getRelayAccessProviderDescriptor, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import { Ionicons } from '@expo/vector-icons';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { TranslationKey } from '@/text';

export type RelayAccessProviderUiDefinition = Readonly<{
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: ComponentProps<typeof Ionicons>['name'];
}>;

export const relayAccessProviderUiCatalog: Readonly<Record<RelayAccessProviderId, RelayAccessProviderUiDefinition>> = Object.freeze({
    localOnly: {
        titleKey: 'settings.relayAccess.providers.localOnly.title',
        subtitleKey: 'settings.relayAccess.providers.localOnly.subtitle',
        iconName: 'lock-closed-outline',
    },
    lan: {
        titleKey: 'settings.relayAccess.providers.lan.title',
        subtitleKey: 'settings.relayAccess.providers.lan.subtitle',
        iconName: 'wifi-outline',
    },
    tailscaleServe: {
        titleKey: 'settings.relayAccess.providers.tailscaleServe.title',
        subtitleKey: 'settings.relayAccess.providers.tailscaleServe.subtitle',
        iconName: 'shield-checkmark-outline',
    },
    tailscaleFunnel: {
        titleKey: 'settings.relayAccess.providers.tailscaleFunnel.title',
        subtitleKey: 'settings.relayAccess.providers.tailscaleFunnel.subtitle',
        iconName: 'globe-outline',
    },
    cloudflareNamed: {
        titleKey: 'settings.relayAccess.providers.cloudflareNamed.title',
        subtitleKey: 'settings.relayAccess.providers.cloudflareNamed.subtitle',
        iconName: 'cloud-outline',
    },
} satisfies Record<RelayAccessProviderId, RelayAccessProviderUiDefinition>);

export function relayAccessProviderUsesPrerequisitesStep(providerId: RelayAccessProviderId): boolean {
    return getRelayAccessProviderDescriptor(providerId).prerequisites.length > 0;
}

export function relayAccessProviderSupportsTarget(
    _providerId: RelayAccessProviderId,
    _target: RelayAccessTaskTarget | null | undefined,
): boolean {
    return true;
}
