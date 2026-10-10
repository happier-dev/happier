import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { formatScheduledRunQualifier, formatTriggerLastOutcome, readNextScheduledRunRefreshAtMs, type ScheduledRunQualifierTime } from './formatTriggerSummary';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

/**
 * One trigger, as every trigger list shows it (07 S16 owner-approved presentation, item 4; I4-W
 * §Handoff): named by what it runs, then one quiet line with its qualifier and last outcome, then
 * its switch. "Failed" takes the trouble tone; a turned-off row is dimmed and reads "Off", while its
 * switch keeps its full hit target.
 *
 * The row draws no divider, card or inset of its own: the enclosing sheet group owns them. In a
 * navigation column (`presentation="column"`) the same words take the column's row anatomy instead:
 * the event glyph in the rows' mark column, so a trigger lines up with the workflows beside it.
 */
export type TriggerRowOutcome = Readonly<{
    text: string;
    tone: WorkStatusTone;
    relativeAge?: Readonly<{ atMs: number; state?: string }>;
}>;

export type TriggerRowProps = Readonly<{
    testID: string;
    /** What it runs: a workflow's name or the inline Then ("Notify me → Discord"). */
    title: string;
    /** The qualifier ("Files changed", "When it needs you"), when there is one. */
    qualifier?: string | null;
    qualifierTime?: ScheduledRunQualifierTime;
    qualifierAccessibilityLabel?: string;
    /** Retained legacy content is not a one-line editable summary. */
    multiline?: boolean;
    outcome?: TriggerRowOutcome | null;
    /** Paused for an explicit review, not an ordinary user-disabled trigger. */
    attention?: string;
    enabled: boolean;
    /** Why the switch cannot change right now (a pending write, an unavailable writer). */
    toggleDisabled?: boolean;
    onToggle: (next: boolean) => void;
    /** Opens the trigger's popover; without it the row is information only. */
    onPress?: () => void;
    /** `column`: a row of a navigation column (the Workflows column's Triggers group). */
    presentation?: 'sheet' | 'column';
    /** The event's glyph; a column row leads with it like its sibling rows' marks. */
    glyph?: IconName;
    /** Secondary controls for rows that cannot offer the editor (retained legacy records). */
    actions?: React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    off: { color: theme.colors.text.tertiary },
    actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.margins.xs,
        paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: theme.margins.xs },
}));

export const TriggerRow = React.memo(function TriggerRow(props: TriggerRowProps) {
    const styles = stylesheet;
    const relativeAge = props.outcome?.relativeAge;
    const qualifierTime = props.attention ? undefined : props.qualifierTime;
    const readNextRefresh = React.useCallback((nowMs: number) => {
        const deadlines = [qualifierTime ? readNextScheduledRunRefreshAtMs(qualifierTime.atMs, nowMs) : null,
            relativeAge ? readRelativeTimeShortRefreshAtMs(relativeAge.atMs, nowMs) : null]
            .filter((at): at is number => at !== null);
        return deadlines.length === 0 ? null : Math.min(...deadlines);
    }, [qualifierTime, relativeAge]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, qualifierTime !== undefined || relativeAge !== undefined);
    const qualifier = qualifierTime
        ? formatScheduledRunQualifier(qualifierTime, nowMs, props.enabled)
        : props.qualifier;
    const lead = props.attention ?? (props.enabled
        ? qualifier ?? null
        : [t('workflows.triggers.row.off'), qualifier].filter(Boolean).join(' · '));
    const outcome = props.outcome === undefined || props.outcome === null ? null : relativeAge
        ? { ...props.outcome, text: formatTriggerLastOutcome(formatRelativeTimeShort(relativeAge.atMs, nowMs), relativeAge.state) }
        : props.outcome;
    const subtitle = outcome === null
        ? lead
        : (
            <Text style={workStatusWordStyle('neutral')}>
                {lead ? `${lead} · ` : ''}
                <Text testID={`${props.testID}-outcome`} style={workStatusWordStyle(outcome.tone)}>{outcome.text}</Text>
            </Text>
        );
    const toggle = (
        <Switch
            testID={`${props.testID}-switch`}
            value={props.enabled}
            disabled={props.toggleDisabled}
            accessibilityLabel={t(props.enabled ? 'workflows.triggers.row.turnOff' : 'workflows.triggers.row.turnOn', { name: props.title })}
            onValueChange={props.onToggle}
        />
    );
    if (props.presentation === 'column' && props.onPress) {
        const line = [lead, outcome?.text].filter(Boolean).join(' · ');
        return (
            <CollectionNavigationRow
                testID={props.testID}
                title={props.title}
                {...(line ? { subtitle: line } : {})}
                {...(props.attention ? { subtitleLeading: <View style={collectionListStyles.troubleDot} /> } : {})}
                {...(props.glyph ? { icon: <Icon name={props.glyph} /> } : {})}
                selected={false}
                rightElement={toggle}
                onPress={props.onPress}
            />
        );
    }
    return (<>
        <Item
            testID={props.testID}
            title={props.title}
            {...(props.qualifierAccessibilityLabel ? { accessibilityLabel: [props.title, lead, props.qualifierAccessibilityLabel, outcome?.text].filter(Boolean).join('. ') } : {})}
            {...(props.glyph ? { icon: <Icon name={props.glyph} /> } : {})}
            {...(props.multiline ? { titleLines: 0, subtitleLines: 0 } : {})}
            {...(subtitle ? { subtitle } : {})}
            {...(props.attention ? { subtitleStyle: workStatusWordStyle('attention') }
                : props.enabled ? {} : { titleStyle: styles.off, subtitleStyle: styles.off })}
            {...(props.onPress ? { onPress: props.onPress } : { mode: 'info' as const })}
            showChevron={false}
            rightElementOutsidePressable
            rightElement={toggle}
        />
        {props.actions ? <View testID={`${props.testID}-actions`} style={styles.actions}>{props.actions}</View> : null}
    </>);
});
