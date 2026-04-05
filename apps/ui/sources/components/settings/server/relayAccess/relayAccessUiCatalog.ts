import type { ComponentProps } from 'react';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import { Ionicons } from '@expo/vector-icons';

import type { TranslationKey } from '@/text';

export type RelayAccessProviderUiDefinition = Readonly<{
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: ComponentProps<typeof Ionicons>['name'];
    requiresDetailsStep: boolean;
}>;

export const relayAccessProviderUiCatalog: Readonly<Record<RelayAccessProviderId, RelayAccessProviderUiDefinition>> = Object.freeze({
    localOnly: {
        titleKey: 'settings.relayAccess.providers.localOnly.title',
        subtitleKey: 'settings.relayAccess.providers.localOnly.subtitle',
        iconName: 'lock-closed-outline',
        requiresDetailsStep: false,
    },
    lan: {
        titleKey: 'settings.relayAccess.providers.lan.title',
        subtitleKey: 'settings.relayAccess.providers.lan.subtitle',
        iconName: 'wifi-outline',
        requiresDetailsStep: true,
    },
    tailscaleServe: {
        titleKey: 'settings.relayAccess.providers.tailscaleServe.title',
        subtitleKey: 'settings.relayAccess.providers.tailscaleServe.subtitle',
        iconName: 'shield-checkmark-outline',
        requiresDetailsStep: false,
    },
    tailscaleFunnel: {
        titleKey: 'settings.relayAccess.providers.tailscaleFunnel.title',
        subtitleKey: 'settings.relayAccess.providers.tailscaleFunnel.subtitle',
        iconName: 'globe-outline',
        requiresDetailsStep: false,
    },
    cloudflareNamed: {
        titleKey: 'settings.relayAccess.providers.cloudflareNamed.title',
        subtitleKey: 'settings.relayAccess.providers.cloudflareNamed.subtitle',
        iconName: 'cloud-outline',
        requiresDetailsStep: true,
    },
} satisfies Record<RelayAccessProviderId, RelayAccessProviderUiDefinition>);

export function relayAccessProviderRequiresDetailsStep(providerId: RelayAccessProviderId): boolean {
    return relayAccessProviderUiCatalog[providerId].requiresDetailsStep;
}
