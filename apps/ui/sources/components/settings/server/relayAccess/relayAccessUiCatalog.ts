import type { ComponentProps } from 'react';
import { getRelayAccessProviderDescriptor, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { TranslationKey } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';

export type RelayAccessProviderUiDefinition = Readonly<{
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: IconName;
}>;

export const relayAccessProviderUiCatalog: Readonly<Record<RelayAccessProviderId, RelayAccessProviderUiDefinition>> = Object.freeze({
    localOnly: {
        titleKey: 'settings.relayAccess.providers.localOnly.title',
        subtitleKey: 'settings.relayAccess.providers.localOnly.subtitle',
        iconName: 'lock',
    },
    lan: {
        titleKey: 'settings.relayAccess.providers.lan.title',
        subtitleKey: 'settings.relayAccess.providers.lan.subtitle',
        iconName: 'wifi-high',
    },
    tailscaleServe: {
        titleKey: 'settings.relayAccess.providers.tailscaleServe.title',
        subtitleKey: 'settings.relayAccess.providers.tailscaleServe.subtitle',
        iconName: 'shield-check',
    },
    tailscaleFunnel: {
        titleKey: 'settings.relayAccess.providers.tailscaleFunnel.title',
        subtitleKey: 'settings.relayAccess.providers.tailscaleFunnel.subtitle',
        iconName: 'globe',
    },
    cloudflareNamed: {
        titleKey: 'settings.relayAccess.providers.cloudflareNamed.title',
        subtitleKey: 'settings.relayAccess.providers.cloudflareNamed.subtitle',
        iconName: 'cloud',
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
