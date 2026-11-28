import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { usePaneGeometry } from '@/sync/domains/state/paneGeometryUiState';
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
        paddingHorizontal: theme.space.s20,
        paddingTop: theme.space.s12,
    },
    primaryPaneContainer: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: theme.space.s12,
    },
}));

export const SessionGettingStartedSummary = React.memo((props: SessionGettingStartedSummaryProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const cliInvoker = resolveCliInvokerNameForCurrentApp();
    const sidebarWidthPx = usePaneGeometry('sidebarWidthPx');
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
                <InlineCode>{cliInvoker}</InlineCode>
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
