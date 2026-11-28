import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { usePaneGeometry } from '@/sync/domains/state/paneGeometryUiState';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type ExternalSessionsEmptyStateProps = Readonly<{
    surface?: 'default' | 'sidebar' | 'primaryPane';
}>;

const stylesheet = StyleSheet.create(() => ({
    lineContainer: {
        width: '100%',
        paddingTop: 8,
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
    const sidebarWidthPx = usePaneGeometry('sidebarWidthPx');
    const primaryPaneMaxWidth = typeof sidebarWidthPx === 'number' && sidebarWidthPx > 0 ? sidebarWidthPx : 320;
    const handleBrowse = React.useCallback(() => {
        router.push('/external/browse');
    }, [router]);

    // Inside the session list (the rail or the phone list) emptiness is one quiet line with a link;
    // the main pane keeps the page state, where there is room for it.
    if (props.surface !== 'primaryPane') {
        const browseLabel = t('externalSessions.browseOpenExisting');
        return (
            <View testID="direct-sessions-empty-state" style={styles.lineContainer}>
                <EmptyState
                    testID="direct-sessions-empty-state-line"
                    layout="line"
                    titleTestID="direct-sessions-empty-state-title"
                    title={t('externalSessions.emptyStateTitle')}
                    primaryAction={{
                        label: browseLabel,
                        onPress: handleBrowse,
                        testID: 'direct-sessions-empty-state-browse',
                    }}
                />
            </View>
        );
    }

    return (
        <View testID="direct-sessions-empty-state" style={[styles.primaryPaneContainer, { maxWidth: primaryPaneMaxWidth }]}>
            <EmptyState
                titleTestID="direct-sessions-empty-state-title"
                subtitleTestID="direct-sessions-empty-state-description"
                paddingHorizontal={0}
                icon={(
                    <Icon
                        name="folder-open"
                        size={48}
                        color={theme.colors.text.secondary}
                        style={{ marginBottom: theme.space.s12 }}
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
