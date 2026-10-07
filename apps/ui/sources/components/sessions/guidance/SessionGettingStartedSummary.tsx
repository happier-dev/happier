import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { resolveCliInvokerNameForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { t } from '@/text';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';
import { getSessionGettingStartedSubtitle, getSessionGettingStartedTitle } from './sessionGettingStartedText';
import { Icon } from '@/components/ui/icons/Icon';

type SessionGettingStartedSummaryKind = Extract<
    SessionGettingStartedDecisionKind,
    'create_session' | 'connect_machine' | 'start_daemon' | 'select_session'
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
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.surface.elevated,
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
    const sidebarMaxWidthStyle = useLayoutMaxWidthStyle();
    const primaryPaneMaxWidth = typeof sidebarWidthPx === 'number' && sidebarWidthPx > 0 ? sidebarWidthPx : 320;
    const containerStyle = props.surface === 'sidebar'
        ? [styles.sidebarContainer, sidebarMaxWidthStyle]
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
            <EmptyState
                titleTestID={props.titleTestID}
                subtitleTestID={props.descriptionTestID}
                // First run and a missing machine are Daybreak scenes; "select a session" keeps its glyph.
                scene={props.kind === 'create_session' ? 'firstRun' : props.kind === 'select_session' ? undefined : 'noMachines'}
                icon={props.kind === 'select_session' ? (
                    <Icon name="chats-circle" size={48} color={theme.colors.text.secondary} />
                ) : undefined}
                title={getSessionGettingStartedTitle(props.kind)}
                subtitle={description}
                paddingHorizontal={props.surface === 'default' ? 16 : 0}
            />
        </View>
    );
});
