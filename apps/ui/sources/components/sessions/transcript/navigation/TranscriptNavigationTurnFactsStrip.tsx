import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { t } from '@/text';
import { formatTranscriptNavigationDuration, formatTranscriptNavigationElapsed } from './transcriptNavigationTimeFormat';
import type { TranscriptNavigationTurnApproval, TranscriptNavigationTurnFacts } from './transcriptNavigationTypes';

/** The live turn's counter: the only per-second work, mounted only on the live row. */
const LiveElapsed = React.memo((props: Readonly<{ sinceMs: number }>) => {
    const styles = stylesheet;
    const elapsed = useElapsedTime(props.sinceMs);
    return <Text style={styles.factTextStrong}>{formatTranscriptNavigationElapsed(elapsed)}</Text>;
});

function approvalCounts(approvals: readonly TranscriptNavigationTurnApproval[]) {
    let allowed = 0;
    let denied = 0;
    for (const approval of approvals) {
        if (approval.outcome === 'allowed') allowed += 1;
        else if (approval.outcome === 'denied') denied += 1;
    }
    return { allowed, denied };
}

/**
 * What happened between a prompt and its answer, as one quiet strip: tools, approvals, failures and
 * how long it took (a live counter for the turn in progress). Only known facts render; an unknown
 * or empty turn renders nothing rather than zeros. Shared by the Navigate pane and the trail preview.
 */
export const TranscriptNavigationTurnFactsStrip = React.memo((props: Readonly<{
    facts: TranscriptNavigationTurnFacts;
    createdAtMs: number | null;
    live: boolean;
    showApprovalCounts: boolean;
    testID: string;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { facts } = props;
    const { allowed, denied } = approvalCounts(facts.approvals);
    const duration = !props.live && props.createdAtMs !== null && facts.endedAtMs !== null
        ? formatTranscriptNavigationDuration(facts.endedAtMs - props.createdAtMs)
        : null;
    const liveSince = props.live ? props.createdAtMs : null;
    const hasAnything = facts.toolCount > 0
        || facts.failedCount > 0
        || (props.showApprovalCounts && (allowed > 0 || denied > 0))
        || duration !== null
        || liveSince !== null;
    if (!hasAnything) return null;
    return (
        <View testID={props.testID} style={styles.facts}>
            {facts.toolCount > 0 ? (
                <View style={styles.fact}>
                    <Icon name="wrench" size={12} color={theme.colors.text.tertiary} />
                    <Text style={styles.factText}>{t('session.transcriptNavigation.toolCount', { count: facts.toolCount })}</Text>
                </View>
            ) : null}
            {props.showApprovalCounts && allowed > 0 ? (
                <View style={styles.fact}>
                    <Icon name="shield-check" size={12} color={theme.colors.state.success.foreground} />
                    <Text style={styles.factText}>{t('session.transcriptNavigation.allowedCount', { count: allowed })}</Text>
                </View>
            ) : null}
            {props.showApprovalCounts && denied > 0 ? (
                <View style={styles.fact}>
                    <Icon name="shield-check" size={12} color={theme.colors.text.tertiary} />
                    <Text style={styles.factText}>{t('session.transcriptNavigation.deniedCount', { count: denied })}</Text>
                </View>
            ) : null}
            {facts.failedCount > 0 ? (
                <View style={styles.fact}>
                    <Icon name="warning" size={12} color={theme.colors.state.danger.foreground} />
                    <Text style={styles.factTextStrong}>{t('session.transcriptNavigation.failedCount', { count: facts.failedCount })}</Text>
                </View>
            ) : null}
            {liveSince !== null ? (
                <View style={styles.fact}>
                    <Icon name="clock" size={12} color={theme.colors.state.warning.foreground} />
                    <LiveElapsed sinceMs={liveSince} />
                </View>
            ) : duration ? (
                <View style={styles.fact}>
                    <Icon name="clock" size={12} color={theme.colors.text.tertiary} />
                    <Text style={styles.factText}>{duration}</Text>
                </View>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 10,
        rowGap: 3,
        marginTop: 4,
    },
    fact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    factText: {
        color: theme.colors.text.tertiary,
        fontSize: 11,
        lineHeight: 15,
        fontVariant: ['tabular-nums'],
    },
    factTextStrong: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        lineHeight: 15,
        fontVariant: ['tabular-nums'],
    },
}));
