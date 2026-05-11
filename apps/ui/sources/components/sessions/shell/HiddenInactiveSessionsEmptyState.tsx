import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { t } from '@/text';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';

export function HiddenInactiveSessionsEmptyState() {
    const { theme } = useUnistyles();
    const { handleOpenArchivedSessions } = useSessionListNavigationActions();

    return (
        <ItemList testID="sessions-hidden-inactive-empty-state-list" containerStyle={{ paddingTop: 12 }}>
            <CenteredInfoTile
                titleTestID="sessions-hidden-inactive-empty-state-title"
                descriptionTestID="sessions-hidden-inactive-empty-state-description"
                icon={<Ionicons name="chatbubbles-outline" size={48} color={theme.colors.text.secondary} style={{ marginBottom: 12 }} />}
                title={t('settingsFeatures.hiddenInactiveSessionsEmptyStateTitle')}
                description={t('settingsFeatures.hiddenInactiveSessionsEmptyStateSubtitle')}
            />

            <ItemGroup>
                <Item
                    testID="sessions-hidden-inactive-empty-state-open-archived"
                    title={t('sessionInfo.inactiveAndArchivedSessions')}
                    icon={<Ionicons name="archive-outline" size={22} color={theme.colors.text.secondary} />}
                    onPress={handleOpenArchivedSessions}
                />
            </ItemGroup>
        </ItemList>
    );
}
