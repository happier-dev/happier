import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';
import { useSettingRevealRequested } from '@/components/settings/shell/SettingRow';

import { ProviderConnectionsSettingsScreen } from './ProviderConnectionsSettingsScreen';
import { PROVIDERS_SETTINGS } from './providersSettings';

const PROVIDER_COLLECTION_SETTINGS = Object.values(PROVIDERS_SETTINGS.settings);

/** The root remains a home; explicit connection and authoring routes own their details. */
export const ProviderSettingsIndex = React.memo(function ProviderSettingsIndex() {
    const view = useHappierCollectionIndexView();
    const focused = useIsFocused();
    const collectionSettingRequested = useSettingRevealRequested(PROVIDER_COLLECTION_SETTINGS);
    if (view === 'pending') return null;
    return <ProviderConnectionsSettingsScreen variant={view === 'land' && !collectionSettingRequested ? 'home' : 'page'} active={focused} />;
});
