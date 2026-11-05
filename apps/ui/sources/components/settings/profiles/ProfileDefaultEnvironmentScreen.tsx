import * as React from 'react';

import { SettingRow } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

import { PROFILES_SETTINGS } from './profilesSettings';
import { useProfilesCollection } from './useProfilesCollection';

/** The favorite id the pickers use for the no-profile choice. */
const DEFAULT_ENVIRONMENT_FAVORITE_ID = '';

/**
 * The no-profile choice in the collection: a new session uses the machine's environment. Its only
 * setting is whether pickers show it first, among your favorites.
 */
export const ProfileDefaultEnvironmentScreen = React.memo(function ProfileDefaultEnvironmentScreen() {
    const collection = useProfilesCollection();
    const favorite = collection.isFavorite(DEFAULT_ENVIRONMENT_FAVORITE_ID);
    return (
        <ItemList>
            <PageHeader
                testID="settings.profiles.defaultEnvironment.header"
                title={t('profiles.noProfile')}
                description={t('profiles.noProfileDescription')}
                leading={(
                    <PageHeaderMarkIcon name="house" />
                )}
            />
            <ItemGroup
                title={t('profilesPage.pickerSection')}
                description={t('profilesPage.pickerSectionDescription')}
            >
                <SettingRow
                    testID="settings.profiles.defaultEnvironment.favorite"
                    setting={PROFILES_SETTINGS.settings.showFirst}
                    showChevron={false}
                    onPress={() => collection.toggleFavorite(DEFAULT_ENVIRONMENT_FAVORITE_ID)}
                    rightElement={(
                        <Switch
                            value={favorite}
                            onValueChange={() => collection.toggleFavorite(DEFAULT_ENVIRONMENT_FAVORITE_ID)}
                            accessibilityLabel={t('profilesPage.showFirst')}
                        />
                    )}
                />
            </ItemGroup>
        </ItemList>
    );
});
