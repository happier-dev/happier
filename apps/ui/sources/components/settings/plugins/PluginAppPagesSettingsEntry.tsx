import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
    type CompactAppPluginDestination,
    useCompactAppDestinations,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { CompactAppDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import { usePluginAppPageCatalogActivationHandler } from '@/components/appShell/plugins/pluginAppPageNavigation';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

/**
 * Settings consumer of the host-owned compact App catalog (EU-5b).
 *
 * This remains a convenience discovery surface, not a second page registry:
 * ordering, availability, identity and routes all come from the compact catalog.
 * The existing route/launch owner still clears staged input and mounts the page.
 */
export function PluginAppPagesSettingsEntry(): React.ReactElement | null {
    const { theme } = useUnistyles();
    const activatePluginAppPage = usePluginAppPageCatalogActivationHandler();
    const compactDestinations = useCompactAppDestinations({ browseExistingSessionsEnabled: false });
    // This is the management surface for the same catalog, so hidden entries
    // stay here for recovery; ordinary discovery surfaces filter them instead.
    const pages = React.useMemo(() => compactDestinations.filter(
        (destination): destination is CompactAppPluginDestination => (
            destination.kind === 'plugin' && destination.container === 'appPage'
        ),
    ), [compactDestinations]);

    if (pages.length === 0) {
        return null;
    }

    return (
        <ItemGroup
            title={t('pluginSurfaces.appPage.title')}
            footer={t('pluginSurfaces.appPage.subtitle')}
        >
            {pages.map((page) => (
                <Item
                    key={page.id}
                    testID={`settings.plugins.appPages.${page.id}`}
                    title={page.title}
                    subtitle={page.availability === 'unavailable'
                        ? resolveReasonCopy({
                            reasonCode: page.unavailableReason,
                            kind: 'pluginRuntime',
                        }).message
                        : page.destination.pluginId}
                    disabled={page.availability !== 'available'}
                    icon={(
                        <Icon
                            name={page.icon}
                            size={29}
                            color={theme.colors.accent.indigo}
                        />
                    )}
                    rightElement={page.badge ? <CompactAppDestinationBadge destination={page} /> : undefined}
                    keepChevronWithRightElement
                    onPress={() => activatePluginAppPage(page)}
                />
            ))}
        </ItemGroup>
    );
}
