import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { resolveNativePermissionAnswer } from '@/components/approvals/approvalStatusLabel';
import { resolveAccountActorName, resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * The one terminal-outcome mark of a tool call: a glyph and a word, in the failure rose or, for a
 * refusal or a blocked call, the quiet ink. The row, the collapsed preview row and the group header
 * all render it, so one outcome reads the same word in the same type everywhere.
 */
export const ToolOutcomeStatus = React.memo(function ToolOutcomeStatus(props: Readonly<{
    testID: string;
    label: string;
    /** A request sent for approval or still in progress reads with its own quiet glyph. */
    glyph: 'warning-circle' | 'minus-circle' | 'paper-plane-tilt' | 'clock' | 'check';
    /** `quiet` for a refusal, an approval wait or unsettled work: the product saying no is not a break. */
    tone: 'danger' | 'quiet';
}>) {
    const { theme } = useUnistyles();
    const quiet = props.tone === 'quiet';
    return (
        <View testID={props.testID} accessible={true} accessibilityLabel={props.label} style={styles.container}>
            <Icon
                name={props.glyph}
                size={ICON_SIZE.sm}
                color={quiet ? theme.colors.text.secondary : workStatusGlyphColor(theme.colors, 'danger')}
            />
            <Text style={[styles.text, quiet ? styles.textQuiet : null]} numberOfLines={1}>{props.label}</Text>
        </View>
    );
});

/**
 * A native decision collapsed to one line: the exact offered label that was applied, then who answered and
 * when (lab mb B `mbBoards:out`). Only rows with such an answer mount it, so only they read the viewer scope.
 */
export const PermissionAnswerOutcomeStatus = React.memo(function PermissionAnswerOutcomeStatus(props: Readonly<{
    permission: NonNullable<ToolCall['permission']>;
    serverId?: string;
}>) {
    const viewer = useServerCredentialAccountScopeResolution(props.serverId);
    const answer = resolveNativePermissionAnswer(props.permission);
    if (!answer) return null;
    const actor = props.permission.decisionActor;
    const who = actor?.kind === 'accountUser'
        ? (viewer.kind === 'bound' && viewer.scope.accountId === actor.accountId
            ? resolveAccountActorName({ accessibility: 'current', profile: null }, true) : resolveUnknownAccountActorName('value'))
        : actor?.kind === 'externalHuman' ? resolveUnknownAccountActorName('value') : null;
    const when = typeof props.permission.date === 'number' ? formatAsOfTime(props.permission.date) : null;
    const byline = [who, when].filter((part): part is string => part !== null).join(', ');
    return (
        <ToolOutcomeStatus
            testID="tool-timeline-row-native-answer"
            label={byline ? `${answer.label} · ${byline}` : answer.label}
            glyph={answer.refused ? 'minus-circle' : 'check'}
            tone="quiet"
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: theme.space.s6,
        minWidth: 0,
        maxWidth: 220,
    },
    text: {
        color: theme.colors.state.danger.textForeground,
        ...Typography.variant('meta', 'semiBold'),
        flexShrink: 1,
    },
    textQuiet: {
        color: theme.colors.text.secondary,
    },
}));
