import * as React from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type ExternalSessionsEmptyStateProps = Readonly<{
    surface?: 'default' | 'sidebar' | 'primaryPane';
}>;

const stylesheet = StyleSheet.create(() => ({
    sidebarContainer: {
        width: '100%',
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

export function ExternalSessionsEmptyState(props: ExternalSessionsEmptyStateProps) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const sidebarWidthPx = useLocalSetting('sidebarWidthPx');
    const sidebarMaxWidthStyle = useLayoutMaxWidthStyle();
    const primaryPaneMaxWidth = typeof sidebarWidthPx === 'number' && sidebarWidthPx > 0 ? sidebarWidthPx : 320;
    const containerStyle = props.surface === 'sidebar'
        ? [styles.sidebarContainer, sidebarMaxWidthStyle]
        : props.surface === 'primaryPane'
            ? [styles.primaryPaneContainer, { maxWidth: primaryPaneMaxWidth }]
            : undefined;
    const handleBrowse = React.useCallback(() => {
        router.push('/external/browse');
    }, [router]);

    return (
        <View testID="direct-sessions-empty-state" style={containerStyle}>
            <EmptyState
                titleTestID="direct-sessions-empty-state-title"
                subtitleTestID="direct-sessions-empty-state-description"
                paddingHorizontal={props.surface === 'default' ? 16 : 0}
                icon={(
                    <Icon
                        name="folder-open"
                        size={48}
                        color={theme.colors.text.secondary}
                        style={{ marginBottom: 12 }}
                    />
                )}
                title={t('externalSessions.emptyStateTitle')}
                subtitle={t('externalSessions.emptyStateDescription')}
                action={(
                    <RoundButton
                        testID="direct-sessions-empty-state-browse"
                        size="normal"
                        title={t('externalSessions.browseOpenExisting')}
                        accessibilityLabel={t('externalSessions.browseOpenExisting')}
                        onPress={handleBrowse}
                    />
                )}
            />
        </View>
    );
}
