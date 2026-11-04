import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SelectionList, type SelectionListKeyboardHint, type SelectionListOption, type SelectionListSectionDescriptor, type SelectionListStep, type SelectionListPagination } from '@/components/ui/selectionList';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionSelectionRow } from './projectSessionSelectionRows';

const styles = StyleSheet.create(theme => ({
    sessionMeta: { alignItems: 'flex-end', gap: theme.space.s2, marginLeft: theme.space.s12, minWidth: 48, maxWidth: 128 },
    sessionStatus: { ...Typography.variant('meta', 'semiBold') },
    sessionActivity: { color: theme.colors.text.secondary, ...Typography.variant('micro') },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0 },
    statusLine: { color: theme.colors.text.secondary, flexShrink: 1 },
    attentionDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.status.actionRequired },
}));

function RowMeta({ row, testID }: Readonly<{ row: SessionSelectionRow; testID: string }>) {
    const { theme } = useUnistyles();
    const color = row.statusTone === 'danger' ? theme.colors.status.error
        : row.statusTone === 'attention' ? theme.colors.status.actionRequired : theme.colors.status.default;
    return <View testID={`${testID}-meta-${row.address.sessionId}`} style={styles.sessionMeta}>
        <Text style={[styles.sessionStatus, { color }]} numberOfLines={1}>{row.statusText}</Text>
        {row.activityLabel ? <Text style={styles.sessionActivity} numberOfLines={1}>{row.activityLabel}</Text> : null}
    </View>;
}

/** The one word a row says about itself when there is no column for it: what needs you, else how recent. */
function readRowStatusLine(row: SessionSelectionRow): string {
    if (row.disabledReason) return row.disabledReason;
    return row.working || row.statusTone !== 'neutral' ? row.statusText : row.activityLabel;
}

function RowStatusLine({ row }: Readonly<{ row: SessionSelectionRow }>) {
    const { theme } = useUnistyles();
    const status = readRowStatusLine(row);
    const quiet = Boolean(row.disabledReason) || row.statusTone === 'neutral';
    const color = row.statusTone === 'danger' ? theme.colors.status.error : theme.colors.status.actionRequired;
    return (
        <View style={styles.statusRow}>
            {row.disabledReason ? null : row.working
                ? <ActivitySpinner size={12} color={theme.colors.text.secondary} />
                : row.statusTone === 'attention' ? <View style={styles.attentionDot} /> : null}
            <Text variant="meta" numberOfLines={1} style={styles.statusLine}>
                {quiet ? [status, row.place].filter(Boolean).join(' · ') : <><Text variant="meta" style={{ color }}>{status}</Text>{` · ${row.place}`}</>}
            </Text>
        </View>
    );
}

export type SessionSelectionListProps = Readonly<{
    rows: readonly SessionSelectionRow[];
    title: string;
    searchPlaceholder: string;
    emptyStateLabel: string;
    testID: string;
    maxHeight: number;
    leadingOptions?: readonly SelectionListOption[];
    selectedOptionId?: string;
    /** `inline`: one line carries status and place, for a popover too narrow for a meta column (lab `sc`). */
    rowPresentation?: 'meta' | 'inline';
    /** Titles the `focused` and `recent` row groups; without it the rows stand in one section. */
    groupTitles?: Readonly<{ focused: string; recent: string }>;
    inputSuffix?: React.ReactNode;
    footerAction?: React.ReactNode;
    pinnedRow?: React.ReactNode;
    footerHints?: readonly SelectionListKeyboardHint[];
    inputValue?: string;
    onChangeInputValue?: (query: string) => void;
    pagination?: SelectionListPagination;
    onSelectSession: (address: SessionAddress) => void;
    onSelectOption?: (id: string) => void;
    onRequestClose: () => void;
}>;

/** Shared picker presentation; data is owned by its in-process or bridge page source. */
export const SessionSelectionList = React.memo(function SessionSelectionList(props: SessionSelectionListProps) {
    const { theme } = useUnistyles();
    const inline = props.rowPresentation === 'inline';
    const toOption = React.useCallback((row: SessionSelectionRow): SelectionListOption => ({
        id: row.id, testID: `${props.testID}-option-${row.address.sessionId}`,
        label: row.label, disabled: Boolean(row.disabledReason),
        icon: <SessionAgentCatalogIdentityIcon agentId={row.agentId} machineId={row.machineId}
            serverId={row.address.serverId} size={20} color={theme.colors.text.secondary}
            testID={`${props.testID}-agent-logo-${row.address.sessionId}`} />,
        ...(inline ? {
            subtitle: [readRowStatusLine(row), row.place].filter(Boolean).join(' · '),
            subtitleContent: <RowStatusLine row={row} />,
            subtitleLines: 1,
        } : {
            subtitle: row.disabledReason ?? row.subtitle,
            rightAccessory: <RowMeta row={row} testID={props.testID} />,
        }),
    }), [inline, props.testID, theme.colors.text.secondary]);
    const sections = React.useMemo<readonly SelectionListSectionDescriptor[]>(() => {
        const { groupTitles } = props;
        const leading = props.leadingOptions ?? [];
        if (!groupTitles) {
            return [{ kind: 'static', id: 'sessions', options: [...leading, ...props.rows.map(toOption)], virtualization: 'auto' }];
        }
        const groups = [
            { id: 'focused', title: groupTitles.focused, rows: props.rows.filter(row => row.group === 'focused') },
            { id: 'recent', title: groupTitles.recent, rows: props.rows.filter(row => row.group !== 'focused') },
        ].filter(group => group.rows.length > 0);
        return groups.map((group, index) => ({
            kind: 'static', id: group.id, title: group.title, virtualization: 'auto',
            options: [...(index === 0 ? leading : []), ...group.rows.map(toOption)],
        }));
    }, [props.groupTitles, props.leadingOptions, props.rows, toOption]);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: `${props.testID}-root`, title: props.title, inputPlaceholder: props.searchPlaceholder,
        emptyStateLabel: props.emptyStateLabel, sections,
        ...(props.footerHints ? { footerHints: props.footerHints } : {}),
    }), [props.emptyStateLabel, props.footerHints, props.searchPlaceholder, props.testID, props.title, sections]);
    return <SelectionList testID={`${props.testID}-list`} rootStep={rootStep}
        selectedOptionId={props.selectedOptionId}
        inputSuffix={props.inputSuffix}
        footerAction={props.footerAction}
        pinnedRow={props.pinnedRow}
        inputValue={props.inputValue} onChangeInputValue={props.onChangeInputValue}
        pagination={props.pagination}
        onSelect={id => {
            const row = props.rows.find(candidate => candidate.id === id);
            if (row) props.onSelectSession(row.address);
            else props.onSelectOption?.(id);
        }} onRequestClose={props.onRequestClose} autoFocusInputOnWeb keyboardHintsEnabled
        maxHeight={props.maxHeight} heightBehavior="fixedToMaxHeight" showsVerticalScrollIndicator />;
});
