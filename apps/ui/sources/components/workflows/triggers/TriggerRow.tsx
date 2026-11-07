import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { useItemSubtitleTextStyle } from '@/components/ui/lists/ItemSubtitleText';
import { CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { formatNextScheduledRunAccessibilityLabel, formatScheduledRunQualifier, formatTriggerLastOutcome, readNextScheduledRunRefreshAtMs, type ScheduledRunQualifierTime } from './formatTriggerSummary';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { HAPPIER_COLLECTION_LIST_METRICS, HappierTriggerRow, useHappierPageSection, type HappierTriggerRowHost } from '@happier-dev/plugin-ui/presentation';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { getStorage, useUser } from '@/sync/domains/state/storage';
import { resolveEditedByLabel } from '../run/workflowEditedBy';

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
    /** The row's own line under its words (History · Run now); the switch then closes that line. */
    actions?: React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    // The habit's own line (History · Run now · switch) belongs to the row above it, so the quiet line and
    // its actions read as one block (lab `b-habit T`): the row gives up most of its bottom padding and the
    // line starts exactly where the row's press region ends, so the two never share a tap. The switch keeps
    // its full touch target through its own hit area.
    rowAboveActions: { paddingBottom: theme.space.s2 },
    actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s4,
        paddingBottom: theme.space.s4 },
}));

/**
 * The actions line starts on the row's own text edge, so its buttons stand under the title rather than
 * a few pixels outside it: the same inset the page section gives its rows (`Item`'s page anatomy).
 */
const actionsInsetStyles = new Map<number, Readonly<{ paddingHorizontal: number }>>();
function resolveActionsInsetStyle(insetPx: number): Readonly<{ paddingHorizontal: number }> {
    let style = actionsInsetStyles.get(insetPx);
    if (style === undefined) {
        style = { paddingHorizontal: insetPx };
        actionsInsetStyles.set(insetPx, style);
    }
    return style;
}

/**
 * The quiet line's words take the row's subtitle role and ink (dimmed with the row while it is off);
 * only a trouble tone adds its own colour, so a failed outcome still reads in an off row.
 */
function TriggerRowLineText({ tone, ...props }: React.ComponentProps<HappierTriggerRowHost['Text']>) {
    const rowSubtitleStyle = useItemSubtitleTextStyle();
    return <Text {...props} style={[rowSubtitleStyle ?? workStatusWordStyle('neutral'),
        tone === 'neutral' ? null : workStatusWordStyle(tone)]} />;
}

function createTriggerRowHost(actionsLineBelow: boolean, actionsInsetPx: number = HAPPIER_COLLECTION_LIST_METRICS.rowInset): HappierTriggerRowHost {
    return {
        Toggle: Switch,
        Text: TriggerRowLineText,
        actionsStyle: [stylesheet.actions, resolveActionsInsetStyle(actionsInsetPx)],
        Row: (props) => props.presentation === 'column' && props.onPress ? (
            <CollectionNavigationRow testID={props.testID} title={props.title}
                {...(props.subtitleText ? { subtitle: props.subtitleText } : {})}
                {...(props.attention ? { subtitleLeading: <View style={collectionListStyles.troubleDot} /> } : {})}
                icon={props.icon} selected={false} rightElement={props.toggle} onPress={props.onPress} />
        ) : (
            <Item testID={props.testID} title={props.title} accessibilityLabel={props.accessibilityLabel}
                icon={props.icon} {...(props.multiline ? { titleLines: 0, subtitleLines: 0 } : {})}
                {...(props.subtitle ? { subtitle: props.subtitle } : {})}
                {...(props.attention ? { subtitleStyle: workStatusWordStyle('attention') }
                    : { dimmed: !props.enabled })}
                {...(actionsLineBelow ? { style: stylesheet.rowAboveActions } : {})}
                {...(props.onPress ? { onPress: props.onPress } : { mode: 'info' as const })}
                showChevron={false} showDivider={false} rightElementOutsidePressable rightElement={props.toggle} />
        ),
    };
}

const triggerRowHost = createTriggerRowHost(false);
const triggerRowWithActionsHosts = new Map<number, HappierTriggerRowHost>();
function resolveTriggerRowWithActionsHost(insetPx: number): HappierTriggerRowHost {
    let host = triggerRowWithActionsHosts.get(insetPx);
    if (host === undefined) {
        host = createTriggerRowHost(true, insetPx);
        triggerRowWithActionsHosts.set(insetPx, host);
    }
    return host;
}

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
    const lead = props.attention ?? (props.enabled
        ? qualifier ?? null
        : [t('workflows.triggers.row.off'), qualifier].filter(Boolean).join(' · '));
    const outcome = props.outcome === undefined || props.outcome === null ? null : relativeAge
        ? { ...props.outcome, text: formatTriggerLastOutcome(formatRelativeTimeShort(relativeAge.atMs, nowMs), relativeAge.state) }
        : props.outcome;
    const actionsLine = props.presentation === 'column' && props.onPress ? undefined : props.actions;
    const pageSection = useHappierPageSection();
    const actionsInsetPx = pageSection?.rowInsetPx ?? PAGE_LIST_METRICS.rowPaddingHorizontalPx;
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
        actions={actionsLine} host={actionsLine ? resolveTriggerRowWithActionsHost(actionsInsetPx) : triggerRowHost} />;
});
