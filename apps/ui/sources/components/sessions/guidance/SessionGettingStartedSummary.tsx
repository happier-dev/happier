import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { resolveCliInvokerNameForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { t } from '@/text';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';
import { getSessionGettingStartedSubtitle, getSessionGettingStartedTitle } from './sessionGettingStartedText';

type SessionGettingStartedSummaryKind = Extract<
    SessionGettingStartedDecisionKind,
    'create_session' | 'connect_machine' | 'start_daemon'
>;

type SessionGettingStartedSummaryProps = Readonly<{
    kind: SessionGettingStartedSummaryKind;
    targetLabel: string;
    surface?: 'default' | 'sidebar' | 'primaryPane';
    testID?: string;
    titleTestID?: string;
    descriptionTestID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
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
    inlineCode: {
        ...Typography.mono(),
        fontSize: 13,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 1,
    },
}));

export const SessionGettingStartedSummary = React.memo((props: SessionGettingStartedSummaryProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const cliInvoker = resolveCliInvokerNameForCurrentApp();
    const sidebarWidthPx = useLocalSetting('sidebarWidthPx');
    const primaryPaneMaxWidth = typeof sidebarWidthPx === 'number' && sidebarWidthPx > 0 ? sidebarWidthPx : 320;
    const containerStyle = props.surface === 'sidebar'
        ? styles.sidebarContainer
        : props.surface === 'primaryPane'
            ? [styles.primaryPaneContainer, { maxWidth: primaryPaneMaxWidth }]
            : undefined;

    const description = props.kind === 'create_session'
        ? (
            <>
                {t('sessionsList.emptyState.descriptionPrefix')}
                <Text style={styles.inlineCode}>{cliInvoker}</Text>
                {t('sessionsList.emptyState.descriptionSuffix')}
            </>
        )
        : getSessionGettingStartedSubtitle(props.kind, props.targetLabel);

    return (
        <View testID={props.testID} style={containerStyle}>
            <CenteredInfoTile
                titleTestID={props.titleTestID}
                descriptionTestID={props.descriptionTestID}
                icon={(
                    <Ionicons
                        name={props.kind === 'create_session' ? 'terminal-outline' : 'desktop-outline'}
                        size={48}
                        color={theme.colors.textSecondary}
                        style={{ marginBottom: 12 }}
                    />
                )}
                title={getSessionGettingStartedTitle(props.kind)}
                description={description}
                paddingHorizontal={props.surface === 'default' ? 16 : 0}
            />
        </View>
    );
});
