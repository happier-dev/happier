import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { useItemSubtitleTextStyle } from '@/components/ui/lists/ItemSubtitleText';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { formatNextScheduledRunAccessibilityLabel, formatScheduledRunQualifier, formatTriggerLastOutcome, readNextScheduledRunRefreshAtMs, type ScheduledRunQualifierTime } from './formatTriggerSummary';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { HappierTriggerRow, type HappierTriggerRowHost } from '@happier-dev/plugin-ui/presentation';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { getStorage, useUser } from '@/sync/domains/state/storage';
import { resolveEditedByLabel } from '../run/workflowEditedBy';

/**
 * One trigger, as every trigger list shows it (07 S16 owner-approved presentation, item 4; I4-W
 * §Handoff): named by what it runs, then one quiet line with its qualifier and last outcome, then
 * its switch. "Failed" takes the trouble tone; a turned-off row is dimmed and reads "Off", while its
 * switch keeps its full hit target.
 *
 * The row draws no card or inset of its own, and its hairline is the enclosing sheet's call. In a
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
    /** When it fires ("Every Sunday at 9:00 AM", "When a turn ends"): leads the quiet line where no heading says it. */
    when?: string | null;
    /** The qualifier ("Files changed", "When it needs you"), when there is one. */
    qualifier?: string | null;
    qualifierTime?: ScheduledRunQualifierTime;
    qualifierAccessibilityLabel?: string;
    sourceSavedBy?: WorkflowTriggerSetV1['sourceSavedBy'];
    sourceSavedAt?: number;
    sourceProfile?: Parameters<typeof resolveEditedByLabel>[0]['profile'];
    viewerAccountId?: string | null;
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
    /** Secondary actions (History, Run now): behind the row's ⋯, just before its switch. */
    menuActions?: readonly ItemAction[];
    /** The enclosing sheet's hairline decision (a sheet clones it onto its rows). */
    showDivider?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    // The ⋯ and the switch share the trailing column, the way a Context document row holds them.
    controls: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));

/**
 * The quiet line's words take the row's subtitle role and ink (dimmed with the row while it is off);
 * only a trouble tone adds its own colour, so a failed outcome still reads in an off row.
 */
function TriggerRowLineText({ tone, ...props }: React.ComponentProps<HappierTriggerRowHost['Text']>) {
    const rowSubtitleStyle = useItemSubtitleTextStyle();
    return <Text {...props} style={[rowSubtitleStyle ?? workStatusWordStyle('neutral'),
        tone === 'neutral' ? null : workStatusWordStyle(tone)]} />;
}

const triggerRowHost: HappierTriggerRowHost = {
    Toggle: Switch,
    Text: TriggerRowLineText,
    Row: (props) => {
        const trailing = props.menu ? <View style={stylesheet.controls}>{props.menu}{props.toggle}</View> : props.toggle;
        return props.presentation === 'column' && props.onPress ? (
            <CollectionNavigationRow testID={props.testID} title={props.title}
                {...(props.subtitleText ? { subtitle: props.subtitleText } : {})}
                {...(props.attention ? { subtitleLeading: <View style={collectionListStyles.troubleDot} /> } : {})}
                icon={props.icon} selected={false} rightElement={trailing} onPress={props.onPress} />
        ) : (
            <Item testID={props.testID} title={props.title} accessibilityLabel={props.accessibilityLabel}
                icon={props.icon} {...(props.multiline ? { titleLines: 0, subtitleLines: 0 } : {})}
                {...(props.subtitle ? { subtitle: props.subtitle } : {})}
                {...(props.attention ? { subtitleStyle: workStatusWordStyle('attention') }
                    : { dimmed: !props.enabled })}
                {...(props.onPress ? { onPress: props.onPress } : { mode: 'info' as const })}
                showChevron={false} showDivider={props.showDivider === true} rightElementOutsidePressable rightElement={trailing} />
        );
    },
};

export const TriggerRow = React.memo(function TriggerRow(props: TriggerRowProps) {
    const profileScope = getStorage()((state) => state.profileScope);
    const cachedProfile = useUser(props.sourceSavedBy?.kind === 'person' ? props.sourceSavedBy.accountId : '');
    const viewerAccountId = props.viewerAccountId === undefined ? profileScope?.accountId : props.viewerAccountId;
    const editedBy = resolveEditedByLabel({ savedBy: props.sourceSavedBy, viewerAccountId, viewerOwnSave: 'omit',
        profile: props.sourceProfile === undefined ? cachedProfile : props.sourceProfile });
    const savedAt = editedBy === null ? undefined : props.sourceSavedAt;
    const relativeAge = props.outcome?.relativeAge;
    const qualifierTime = props.attention ? undefined : props.qualifierTime;
    const readNextRefresh = React.useCallback((nowMs: number) => {
        const deadlines = [qualifierTime ? readNextScheduledRunRefreshAtMs(qualifierTime.atMs, nowMs) : null,
            relativeAge ? readRelativeTimeShortRefreshAtMs(relativeAge.atMs, nowMs) : null,
            savedAt === undefined ? null : readRelativeTimeShortRefreshAtMs(savedAt, nowMs)]
            .filter((at): at is number => at !== null);
        return deadlines.length === 0 ? null : Math.min(...deadlines);
    }, [qualifierTime, relativeAge, savedAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh,
        qualifierTime !== undefined || relativeAge !== undefined || savedAt !== undefined);
    const qualifier = qualifierTime
        ? formatScheduledRunQualifier(qualifierTime, nowMs, props.enabled)
        : props.qualifier;
    const lead = props.attention ?? ([props.when, props.enabled ? null : t('workflows.triggers.row.off'), qualifier]
        .filter(Boolean).join(' · ') || null);
    const outcome = props.outcome === undefined || props.outcome === null ? null : relativeAge
        ? { ...props.outcome, text: formatTriggerLastOutcome(formatRelativeTimeShort(relativeAge.atMs, nowMs), relativeAge.state) }
        : props.outcome;
    const menuActions = props.menuActions;
    const menu = React.useMemo(() => menuActions && menuActions.length > 0
        ? <ItemRowActions title={props.title} actions={[...menuActions]} overflowOnly overflowTriggerTestID={`${props.testID}-more`} />
        : undefined, [menuActions, props.testID, props.title]);
    const editedLine = editedBy === null ? null : [editedBy,
        savedAt === undefined ? null : formatRelativeTimeShort(savedAt, nowMs)].filter(Boolean).join(' · ');
    const qualifierAccessibilityLabel = qualifierTime && props.qualifierAccessibilityLabel
            ? formatNextScheduledRunAccessibilityLabel(qualifierTime.atMs, props.enabled, nowMs)
            : props.qualifierAccessibilityLabel ?? lead;
    return <HappierTriggerRow testID={props.testID} title={props.title}
        qualifier={lead || null} provenance={editedLine}
        qualifierAccessibilityLabel={qualifierAccessibilityLabel || undefined} outcome={outcome}
        enabled={props.enabled} attention={Boolean(props.attention)} toggleDisabled={props.toggleDisabled}
        toggleLabel={t(props.enabled ? 'workflows.triggers.row.turnOff' : 'workflows.triggers.row.turnOn', { name: props.title })}
        onToggle={props.onToggle} onPress={props.onPress} presentation={props.presentation} multiline={props.multiline}
        icon={props.glyph ? <Icon name={props.glyph} /> : undefined}
        menu={menu} showDivider={props.showDivider} host={triggerRowHost} />;
});
