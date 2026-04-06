import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { layout } from '@/components/ui/layout/layout';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

type DirectSessionsEmptyStateProps = Readonly<{
    surface?: 'default' | 'sidebar' | 'primaryPane';
}>;

const stylesheet = StyleSheet.create(() => ({
    sidebarContainer: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: 12,
    },
    primaryPaneContainer: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 12,
    },
}));

export function DirectSessionsEmptyState(props: DirectSessionsEmptyStateProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const sidebarWidthPx = useLocalSetting('sidebarWidthPx');
    const primaryPaneMaxWidth = typeof sidebarWidthPx === 'number' && sidebarWidthPx > 0 ? sidebarWidthPx : 320;
    const containerStyle = props.surface === 'sidebar'
        ? styles.sidebarContainer
        : props.surface === 'primaryPane'
            ? [styles.primaryPaneContainer, { maxWidth: primaryPaneMaxWidth }]
            : undefined;

    return (
        <View testID="direct-sessions-empty-state" style={containerStyle}>
            <CenteredInfoTile
                titleTestID="direct-sessions-empty-state-title"
                descriptionTestID="direct-sessions-empty-state-description"
                paddingHorizontal={props.surface === 'default' ? 16 : 0}
                icon={(
                    <Ionicons
                        name="folder-open-outline"
                        size={48}
                        color={theme.colors.textSecondary}
                        style={{ marginBottom: 12 }}
                    />
                )}
                title={t('directSessions.emptyStateTitle')}
                description={t('directSessions.emptyStateDescription')}
            />
        </View>
    );
}
