import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { t } from '@/text';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';
import { Icon } from '@/components/ui/icons/Icon';

export function HiddenInactiveSessionsEmptyState() {
    const { theme } = useUnistyles();
    const { handleOpenArchivedSessions } = useSessionListNavigationActions();

    return (
        <ItemList testID="sessions-hidden-inactive-empty-state-list" containerStyle={{ paddingTop: 12 }}>
            <CenteredInfoTile
                titleTestID="sessions-hidden-inactive-empty-state-title"
                descriptionTestID="sessions-hidden-inactive-empty-state-description"
                icon={<Icon name="chats-circle" size={48} color={theme.colors.text.secondary} style={{ marginBottom: 12 }} />}
                title={t('settingsFeatures.hiddenInactiveSessionsEmptyStateTitle')}
                description={t('settingsFeatures.hiddenInactiveSessionsEmptyStateSubtitle')}
            />

            <ItemGroup>
                <Item
                    testID="sessions-hidden-inactive-empty-state-open-archived"
                    title={t('sessionInfo.inactiveAndArchivedSessions')}
                    icon={<Icon name="archive" size={20} color={theme.colors.text.secondary} />}
                    onPress={handleOpenArchivedSessions}
                />
            </ItemGroup>
        </ItemList>
    );
}
