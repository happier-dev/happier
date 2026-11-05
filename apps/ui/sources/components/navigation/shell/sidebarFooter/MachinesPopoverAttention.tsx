import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineResourceAutomaticActionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { HappierCollectionListMark, HappierPressable, HAPPIER_PRESS_FEEDBACK_V1, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { MachineSummaryStrip } from '@/components/machines/summary/MachineSummaryStrip';
import {
    describeAutomaticAction,
    describeMachineAttentionWord,
    describeMachineReasonDetail,
    resolveMachineReasonAction,
    selectAttentionSubjects,
    selectHeadlineReason,
} from '@/components/machines/summary/machineResourceSentences';
import { resolveMachineAttentionWordColor } from '@/components/machines/summary/machineSummaryStripModel';
import { useMachineSummarySettingValue } from '@/components/machines/summary/useMachineSummarySetting';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { MachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { t } from '@/text';
import { useMachineWorkingCount } from '@/components/machines/work/machineWorkingCounts';
import type { MachineAttentionEntry } from '@/components/machines/attention/collectMachineAttention';

/**
 * "Needs you" (lab `rm` P): each machine that needs you or is worth a look, worst first, opening in
 * place — the strip under its name with the one wrong metric in tone, the reason, one line of detail and
 * its one action. Absent when every machine is calm.
 */
export const MachinesNeedsYouGroup = React.memo(function MachinesNeedsYouGroup(props: Readonly<{
    entries: readonly MachineAttentionEntry[];
    caption?: React.ReactNode;
    nowMs: number;
    onOpen: (href: string, tag: string) => void;
}>) {
    const subjects = React.useMemo(() => selectAttentionSubjects(props.entries), [props.entries]);
    if (subjects.length === 0) return null;
    return (
        <View testID="sidebar-machines-needs-you">
            <CollectionListGroupLabel title={t('machineAttention.groups.needsYou')} count={subjects.length} trailing={props.caption ?? undefined} />
            {subjects.map(entry => <MachineNeedsYouRow key={entry.key} entry={entry} nowMs={props.nowMs} onOpen={props.onOpen} />)}
        </View>
    );
});

const MachineNeedsYouRow = React.memo(function MachineNeedsYouRow(props: Readonly<{
    entry: MachineAttentionEntry;
    nowMs: number;
    onOpen: (href: string, tag: string) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { entry } = props;
    const [expanded, setExpanded] = React.useState(true);
    const summaryRef = React.useRef<View>(null);
    const summarySetting = useMachineSummarySettingValue();
    const availability = useMachineResourceSummary({ serverId: entry.serverId, machineId: entry.machineId });
    const working = useMachineWorkingCount({ serverId: entry.serverId, machineId: entry.machineId });
    const reason = selectHeadlineReason(entry.attention)!;
    const toneColor = resolveMachineAttentionWordColor(theme.colors);
    const action = resolveMachineReasonAction(reason);
    const word = describeMachineAttentionWord(reason);
    const workText = working > 0 ? t('machineDetailPage.work.working', { count: working }) : t('machineDetailPage.work.none');
    return (
        <ExpandableItem
            testID={`sidebar-machines-needs-you.${entry.serverId}.${entry.machineId}`}
            expanded={expanded}
            onExpandedChange={setExpanded}
            showDivider={false}
            header={({ headerProps }) => (
                <HappierPressable
                    testID={`sidebar-machines-needs-you.${entry.serverId}.${entry.machineId}.header`}
                    onPress={headerProps.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={`${entry.name}, ${word}`}
                    expanded={expanded}
                    style={(state) => [
                        styles.header,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    ]}
                >
                    <HappierCollectionListMark>
                        <Icon name="desktop" size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                    <MachineResourceLiveDemand
                        machineKeys={[{ serverId: entry.serverId, machineId: entry.machineId }]}
                        detail="summary"
                        enabled={entry.online && summarySetting.metrics.length > 0}
                        viewportRef={summaryRef}
                    >
                        {(measure) => (
                            <View ref={summaryRef} collapsable={false} onLayout={measure} style={styles.headerText}>
                                <View style={styles.titleLine}>
                                    <Text style={styles.name} numberOfLines={1}>{entry.name}</Text>
                                    <Text style={styles.work} numberOfLines={1}>{workText}</Text>
                                </View>
                                <MachineSummaryStrip availability={availability} style={summarySetting.style}
                                    metrics={summarySetting.metrics} layout="under"
                                    testID={`sidebar-machines-needs-you.${entry.serverId}.${entry.machineId}.strip`} />
                            </View>
                        )}
                    </MachineResourceLiveDemand>
                </HappierPressable>
            )}
        >
            <View style={styles.body}>
                <Text style={[styles.reason, { color: toneColor }]} numberOfLines={1}>{word}</Text>
                <Text style={styles.detail} numberOfLines={2}>{describeMachineReasonDetail(reason, props.nowMs)}</Text>
                {action ? (
                    <View style={styles.actions}>
                        <RoundButton
                            testID={`sidebar-machines-needs-you.${entry.serverId}.${entry.machineId}.action`}
                            size="small"
                            display="secondary"
                            title={action.label}
                            onPress={() => {
                                beginMachinePageTabIntent({ machineId: entry.machineId, serverId: entry.serverId }, action.tab);
                                props.onOpen(
                                    machinePageHref({ door: 'rail', target: { machineId: entry.machineId, serverId: entry.serverId }, tab: action.tab }),
                                    'SidebarMachines.needsYouAction',
                                );
                            }}
                        />
                    </View>
                ) : null}
            </View>
        </ExpandableItem>
    );
});

/**
 * "Since you last looked" (lab `rm` PS 6): what the guard did since the popover was last opened, with Undo
 * when the act can be undone. It leaves when the popover closes; the Guard tab keeps the log.
 */
export const MachinesSinceYouLastLooked = React.memo(function MachinesSinceYouLastLooked(props: Readonly<{
    entries: readonly MachineAttentionEntry[];
    /** When this device last opened the popover, read before this opening recorded itself. */
    guardSeenAt: number;
}>) {
    const latest = React.useMemo(() => {
        let found: MachineAttentionEntry | null = null;
        for (const entry of props.entries) {
            const at = entry.lastAutomaticAction?.at ?? 0;
            if (at > props.guardSeenAt && at > (found?.lastAutomaticAction?.at ?? 0)) found = entry;
        }
        return found;
    }, [props.entries, props.guardSeenAt]);
    if (!latest?.lastAutomaticAction) return null;
    return (
        <View testID="sidebar-machines-since-last-looked">
            <CollectionListGroupLabel title={t('machineAttention.groups.sinceYouLastLooked')} />
            <GuardActionRow entry={latest} action={latest.lastAutomaticAction} />
        </View>
    );
});

const GuardActionRow = React.memo(function GuardActionRow(props: Readonly<{ entry: MachineAttentionEntry; action: MachineResourceAutomaticActionV1 }>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const execution = useMountedActionExecution(props.entry.serverId);
    const [undoing, setUndoing] = React.useState(false);
    const [undone, setUndone] = React.useState(false);
    const undo = async () => {
        setUndoing(true);
        try {
            const result = await execution.execute('machines.guard.activity.undo', {
                serverId: props.entry.serverId, machineId: props.entry.machineId, entryId: props.action.entryId,
            });
            if (result.ok) setUndone(true);
        } finally {
            setUndoing(false);
        }
    };
    return (
        <View style={styles.guard} testID={`sidebar-machines-guard.${props.entry.serverId}.${props.entry.machineId}`}>
            <Icon name="shield-check" size={16} color={theme.colors.text.secondary} />
            <Text style={styles.guardText} numberOfLines={2}>{describeAutomaticAction(props.action, props.entry.name)}</Text>
            {props.action.undoable && !undone ? (
                <RoundButton
                    testID={`sidebar-machines-guard.${props.entry.serverId}.${props.entry.machineId}.undo`}
                    size="small"
                    display="secondary"
                    title={t('machineAttention.actions.undo')}
                    loading={undoing}
                    disabled={undoing}
                    onPress={() => { void undo(); }}
                />
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    titleLine: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
    },
    name: {
        ...Typography.variant('label', 'semiBold'),
        flex: 1,
        color: theme.colors.text.primary,
    },
    work: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    body: {
        paddingLeft: theme.space.s48,
        paddingRight: theme.space.s16,
        paddingBottom: theme.space.s12,
        gap: theme.space.s2,
    },
    reason: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('meta'),
    },
    detail: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        paddingTop: theme.space.s8,
    },
    guard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
    },
    guardText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        flex: 1,
        color: theme.colors.text.primary,
    },
}));
