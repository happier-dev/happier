import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { t } from '@/text';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { PROVIDERS_SETTINGS } from '../providersSettings';

import type { ProviderAvailableContribution } from './providerCollectionModel';

/** The menu searches once its list no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
const CUSTOM_ID = 'custom';
const CATALOG_PREFIX = 'catalog:';

export function newProviderRoute(contributionKey: string | null): string {
    return contributionKey
        ? `/(app)/settings/providers/new?contributionKey=${encodeURIComponent(contributionKey)}`
        : '/(app)/settings/providers/new';
}

/**
 * The collection's "+": a provider from the catalog the machine offers, or your own compatible
 * endpoint. Either opens a new provider in the collection's detail pane.
 */
export const AddProviderMenu = React.memo(function AddProviderMenu(props: Readonly<{
    available: readonly ProviderAvailableContribution[];
    disabled?: boolean;
    onAdd: (href: string) => void;
    /** `all` (the "+"): the catalog and a custom endpoint. `catalog`: the catalog only. */
    include?: 'all' | 'catalog';
    /** Replaces the "+" trigger (a button in an empty collection's invitation). */
    renderTrigger?: (toggle: () => void) => React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const includeCustom = (props.include ?? 'all') === 'all';
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => [
        ...(includeCustom ? [{
            id: CUSTOM_ID,
            testID: 'settings-provider-add-custom',
            title: t('settingsProvidersCollection.customEndpoint'),
            subtitle: t('settingsProviders.addCustomDescription'),
            category: t('settingsProvidersCollection.menuOwnCategory'),
        } satisfies DropdownMenuItem] : []),
        ...props.available.map((provider): DropdownMenuItem => ({
            id: `${CATALOG_PREFIX}${provider.contributionKey}`,
            testID: `settings-provider-available:${provider.contributionKey}`,
            title: provider.name,
            subtitle: provider.provenance === 'external'
                ? `${t(`settingsProviders.kind.${provider.kind}`)} · ${t('settingsProviders.compatibility.experimental')}`
                : t(`settingsProviders.kind.${provider.kind}`),
            icon: <ProviderIcon icon={provider.icon} size={18} color={theme.colors.text.secondary} />,
            category: t('settingsProvidersCollection.menuCatalogCategory'),
        })),
    ], [includeCustom, props.available, theme.colors.text.secondary]);
    const menu = (
        <DropdownMenu
            testID="settings-providers-add-menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={(id) => {
                setOpen(false);
                if (id === CUSTOM_ID) {
                    props.onAdd(newProviderRoute(null));
                    return;
                }
                if (id.startsWith(CATALOG_PREFIX)) props.onAdd(newProviderRoute(id.slice(CATALOG_PREFIX.length)));
            }}
            search={items.length > SEARCH_THRESHOLD}
            searchPlaceholder={t('settingsProviders.searchPlaceholder')}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={340}
            showCategoryTitles={includeCustom}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => props.renderTrigger ? props.renderTrigger(toggle) : (
                <IconButton
                    testID="settings-providers-add"
                    iconName="plus"
                    accessibilityLabel={t('settingsProvidersCollection.addProvider')}
                    tooltip={t('settingsProvidersCollection.addProvider')}
                    variant="plain"
                    disabled={props.disabled}
                    onPress={toggle}
                />
            )}
        />
    );
    return (
        <SettingAnchor setting={PROVIDERS_SETTINGS.settings.add}>
            {includeCustom ? <SettingAnchor setting={PROVIDERS_SETTINGS.settings.custom}>{menu}</SettingAnchor> : menu}
        </SettingAnchor>
    );
});
