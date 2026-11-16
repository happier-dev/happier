import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows, type ItemLoadState } from '@/components/ui/lists/ItemLoadStateRows';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** The list form's visible rows before the rest fold (lab `ad`: more than 8 folds). */
const LIST_FOLD_AFTER = 8;
const LOADING: ItemLoadState = Object.freeze({ kind: 'loading' });

export type CapabilityMachineTruthRow = Readonly<{
    machineId: string;
    machineName: string;
    /** The name is still loading: the title is a placeholder, so it reads quiet rather than as a name. */
    namePending?: boolean;
    deviceIcon: IconName;
    /** "macOS", "Linux": a quiet qualifier after the name. */
    os?: string;
    /** What it looks like there ("41 tools · checked 10:31", the Agents that get it). */
    who: React.ReactNode;
    /** A quiet dated line at the end ("last known Oct 9"). */
    note?: string;
    status?: CapabilityStatus | null;
    /**
     * An offline machine reads dimmed and waits behind the section's one "N offline machines" row, which says
     * offline for all of them; its `who`, `status` and `note` carry only its last-known facts, never "offline".
     */
    offline?: boolean;
    /** That machine's own operations (Install, Update, Remove), in the row's control column. */
    actions?: React.ReactNode;
    /** Given, the row opens in place into this (the machine's own setup rows). */
    detail?: React.ReactNode;
}>;

/**
 * "On your machines" (P5 detail grammar): what a capability looks like on each of the Account's
 * machines. Closed, one summary ("Ready on 2 · offline 1"); open, one row per machine with its own
 * status and fix. The consumer supplies the words and the one section operation (Test, Check now).
 */
export function CapabilityMachineTruth(props: Readonly<{
    rows: readonly CapabilityMachineTruthRow[];
    /** The closed line: one line that shortens with an ellipsis when the room is short. */
    summary: string;
    /** Kept whole after the summary ("2 offline"), so the ellipsis never takes it. */
    summaryNote?: string;
    description?: string;
    sectionAction?: Readonly<{ label: string; onPress: () => void; busy?: boolean; icon?: IconName }>;
    /** Open on arrival (a machine needs the person). */
    defaultExpanded?: boolean;
    /**
     * The rules that decide these machines are not read yet: the rows are reserved, and the section
     * never says it is on no machine.
     */
    loading?: boolean;
    /** What the section says when it is on no machine (default: "No machines yet"). */
    emptyLabel?: string;
    /**
     * `summary` (default): one closed line that opens into the rows. `list`: every machine at once,
     * for a capability whose machines are the page's first question (an Agent: where it's installed).
     */
    presentation?: 'summary' | 'list';
    /** `list`: the machine whose row is open (controlled by the page, which may act on that machine). */
    expandedMachineId?: string | null;
    onExpandedMachineChange?: (machineId: string | null) => void;
    /** `list`: rows shown before the rest fold behind "N more machines" (default 8). */
    visibleCount?: number;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(props.defaultExpanded === true);
    // The list form shows its first rows; a long tail (machines that can't run it, offline) folds behind one row.
    const [showAll, setShowAll] = React.useState(false);
    const visibleCount = Math.max(1, props.visibleCount ?? LIST_FOLD_AFTER);
    // Offline machines are said once: they wait behind one row that names how many, after the reachable ones.
    const onlineRows = props.rows.filter((row) => !row.offline);
    const offlineRows = props.rows.filter((row) => row.offline);
    // The machine a page opens (for example, the one a recovery names) is never folded away.
    const shownRows = showAll
        ? onlineRows
        : onlineRows.filter((row, index) => index < visibleCount || row.machineId === props.expandedMachineId);
    const action = props.sectionAction;
    return (
        <ItemGroup
            testID={props.testID}
            title={t('capabilities.detail.onYourMachines')}
            description={props.description}
            action={action ? (
                <RoundButton
                    testID={`${props.testID}:action`}
                    size="small"
                    display="inverted"
                    title={action.label}
                    leading={action.icon ? <Icon name={action.icon} size={14} color={theme.colors.text.primary} /> : undefined}
                    loading={action.busy}
                    disabled={action.busy}
                    onPress={action.onPress}
                />
            ) : undefined}
        >
            {props.loading ? (
                <ItemLoadStateRows testID={`${props.testID}:loading`} state={LOADING} rows={1} lines={1} />
            ) : props.rows.length === 0 ? (
                <Item testID={`${props.testID}:none`} title={props.emptyLabel ?? t('capabilities.detail.noMachines')} showChevron={false} />
            ) : props.presentation === 'list' ? (
                <>
                    {shownRows.map((row) => (
                        <CapabilityMachineTruthRowView
                            key={row.machineId}
                            row={row}
                            testID={props.testID}
                            expanded={props.expandedMachineId === row.machineId}
                            onExpandedChange={props.onExpandedMachineChange}
                        />
                    ))}
                    {shownRows.length < onlineRows.length ? (
                        <Item
                            testID={`${props.testID}:more`}
                            title={t('capabilities.detail.moreMachines', { count: onlineRows.length - shownRows.length })}
                            titleStyle={styles.more}
                            onPress={() => setShowAll(true)}
                        />
                    ) : null}
                    <OfflineMachines
                        rows={offlineRows}
                        testID={props.testID}
                        alone={onlineRows.length === 0}
                        expandedMachineId={props.expandedMachineId}
                        onExpandedMachineChange={props.onExpandedMachineChange}
                    />
                </>
            ) : (
                <ExpandableItem
                    testID={`${props.testID}:disclosure`}
                    expanded={expanded}
                    onExpandedChange={setExpanded}
                    showDivider={false}
                    header={({ headerProps, expanded: open }) => (
                        <Item
                            {...(headerProps as Readonly<Record<string, unknown>>)}
                            testID={`${props.testID}:summary`}
                            title={t('capabilities.detail.byMachine')}
                            keepChevronWithRightElement
                            rightElement={open ? null : (
                                <View style={styles.summaryLine}>
                                    <Text variant="meta" numberOfLines={1} style={styles.summaryText}>{props.summary}</Text>
                                    {props.summaryNote ? <Text variant="meta" numberOfLines={1} style={styles.summaryNote}>{`· ${props.summaryNote}`}</Text> : null}
                                </View>
                            )}
                        />
                    )}
                >
                    {expanded ? (
                        <>
                            {onlineRows.map((row) => (
                                <CapabilityMachineTruthRowView key={row.machineId} row={row} testID={props.testID} />
                            ))}
                            <OfflineMachines rows={offlineRows} testID={props.testID} alone={onlineRows.length === 0} />
                        </>
                    ) : null}
                </ExpandableItem>
            )}
        </ItemGroup>
    );
}

/**
 * The section's offline machines behind one row that says so once ("2 offline machines"). It opens in place into
 * their dimmed rows with the last-known facts; it starts open when nothing else is listed or the page opened one.
 */
function OfflineMachines(props: Readonly<{
    rows: readonly CapabilityMachineTruthRow[];
    testID: string;
    alone: boolean;
    expandedMachineId?: string | null;
    onExpandedMachineChange?: (machineId: string | null) => void;
}>): React.ReactElement | null {
    const holdsOpenMachine = props.rows.some((row) => row.machineId === props.expandedMachineId);
    const [open, setOpen] = React.useState(props.alone || holdsOpenMachine);
    if (props.rows.length === 0) return null;
    const shown = open || holdsOpenMachine;
    return (
        <ExpandableItem
            testID={`${props.testID}:offline:disclosure`}
            expanded={shown}
            onExpandedChange={setOpen}
            showDivider={false}
            header={({ headerProps }) => (
                <Item
                    {...(headerProps as Readonly<Record<string, unknown>>)}
                    testID={`${props.testID}:offline`}
                    title={t('capabilities.detail.offlineMachines', { count: props.rows.length })}
                    titleStyle={styles.more}
                />
            )}
        >
            {shown ? props.rows.map((row) => (
                <CapabilityMachineTruthRowView
                    key={row.machineId}
                    row={row}
                    testID={props.testID}
                    expanded={props.expandedMachineId === row.machineId}
                    onExpandedChange={props.onExpandedMachineChange}
                />
            )) : null}
        </ExpandableItem>
    );
}

/** One machine: name and OS, what it looks like there, its status, its operations; open, its own setup. */
function CapabilityMachineTruthRowView(props: Readonly<{
    row: CapabilityMachineTruthRow;
    testID: string;
    expanded?: boolean;
    onExpandedChange?: (machineId: string | null) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { row } = props;
    const rowTestID = `${props.testID}:machine:${row.machineId}`;
    const end = row.status || row.note || row.actions ? (
        <View style={styles.end}>
            {row.status ? <CapabilityStatusChip status={row.status} showFix={!row.actions} testID={`${rowTestID}:status`} /> : null}
            {row.note ? <Text variant="meta" style={styles.note} testID={`${rowTestID}:note`}>{row.note}</Text> : null}
            {row.actions ? <View style={styles.actions}>{row.actions}</View> : null}
        </View>
    ) : undefined;
    const header = (headerProps?: Readonly<Record<string, unknown>>) => (
        <Item
            {...headerProps}
            testID={rowTestID}
            title={row.machineName}
            titleQualifier={row.os ?? null}
            titleStyle={row.namePending ? styles.pending : row.offline ? styles.offline : undefined}
            subtitle={row.who}
            subtitleLines={1}
            icon={<Icon name={row.deviceIcon} size={20} color={row.offline ? theme.colors.text.tertiary : theme.colors.text.secondary} />}
            rightElement={end}
            rightElementOutsidePressable={Boolean(row.actions)}
            accessoryLayout="adaptive"
            showChevron={false}
        />
    );
    if (!row.detail || !props.onExpandedChange) return header();
    const onExpandedChange = props.onExpandedChange;
    return (
        <ExpandableItem
            testID={`${rowTestID}:disclosure`}
            expanded={props.expanded === true}
            onExpandedChange={(open) => onExpandedChange(open ? row.machineId : null)}
            header={({ headerProps }) => header(headerProps as Readonly<Record<string, unknown>>)}
        >
            {row.detail}
        </ExpandableItem>
    );
}

const styles = StyleSheet.create((theme) => ({
    summaryLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0, flexShrink: 1 },
    summaryText: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'], flexShrink: 1, minWidth: 0 },
    summaryNote: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'], flexShrink: 0 },
    end: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
    note: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    offline: { color: theme.colors.text.secondary },
    pending: { color: theme.colors.text.tertiary },
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    more: { color: theme.colors.text.secondary },
}));
