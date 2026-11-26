import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SelectionList, type SelectionListKeyboardHint, type SelectionListOption, type SelectionListSectionDescriptor, type SelectionListStep, type SelectionListPagination } from '@/components/ui/selectionList';
import { SELECTION_LIST_SKELETON_ROW_SHAPE } from '@/components/ui/selectionList/_constants';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { SessionListSelectionCheckbox } from '@/components/sessions/shell/selection/SessionListSelectionCheckbox';
import { t } from '@/text';
import type { SessionSelectionRow } from './projectSessionSelectionRows';

const styles = StyleSheet.create(theme => ({
    sessionMeta: { alignItems: 'flex-end', gap: theme.space.s2, marginLeft: theme.space.s12, minWidth: 48, maxWidth: 128 },
    sessionStatus: { ...Typography.variant('meta', 'semiBold') },
    sessionActivity: { color: theme.colors.text.secondary, ...Typography.variant('micro') },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0 },
    statusLine: { color: theme.colors.text.secondary, flexShrink: 1 },
    attentionDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.status.actionRequired },
    // The checkbox takes the identity mark's square, so titles keep one left edge in both modes.
    checkbox: { width: 20, height: 20 },
    inset: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s12 },
}));

/**
 * Single: a tap chooses one Session (every caller's default). Multiple: lists of Sessions you act on lead each
 * row with the session list's round checkbox (owner 2026-11-17 decision 1), and a tap toggles that row.
 */
export type SessionSelectionListMode =
    | Readonly<{ kind: 'single' }>
    | Readonly<{ kind: 'multiple'; selectedIds: ReadonlySet<string>; onToggle: (address: SessionAddress) => void }>;

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

type SessionSelectionDisplayRow = SessionSelectionRow & Readonly<{ botFace?: SessionBotFaceFacts }>;

export type SessionSelectionSection = Readonly<{
    id: string;
    title?: string;
    rows: readonly SessionSelectionDisplayRow[];
}>;

type SessionSelectionNotice = Readonly<{ testID: string; label: string }>;

export type SessionSelectionListProps = (
    | Readonly<{ rows: readonly SessionSelectionRow[]; sections?: never }>
    | Readonly<{ rows?: never; sections: readonly SessionSelectionSection[] }>
) & Readonly<{
    title: string;
    listAccessibilityLabel?: string;
    searchPlaceholder: string;
    emptyStateLabel: string;
    testID: string;
    maxHeight?: number;
    layout?: 'fixed' | 'fill' | 'content';
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
    loading?: SessionSelectionNotice & Readonly<{ presentation: 'line' | 'skeleton' }>;
    queryStatus?: SessionSelectionNotice & Readonly<{ onRetry?: () => void; retryDisabled?: boolean }>;
    error?: SessionSelectionNotice;
    disabled?: boolean;
    pendingOptionId?: string | null;
    note?: Readonly<{ label: string; value: string; onChangeText: (value: string) => void }>;
    /** Defaults to single. Row ids are `SessionSelectionRow.id`. */
    selectionMode?: SessionSelectionListMode;
    onSelectSession: (address: SessionAddress) => void;
    onSelectOption?: (id: string) => void;
    onRequestClose: () => void;
}>;

/** Shared picker presentation; data is owned by its in-process or bridge page source. */
export const SessionSelectionList = React.memo(function SessionSelectionList(props: SessionSelectionListProps) {
    const { theme } = useUnistyles();
    const inline = props.rowPresentation === 'inline';
    const multiple = props.selectionMode?.kind === 'multiple' ? props.selectionMode : null;
    const multipleSelectedIds = multiple?.selectedIds ?? null;
    const onToggle = multiple?.onToggle;
    const isMultiple = multiple !== null;
    const toOption = React.useCallback((row: SessionSelectionDisplayRow): SelectionListOption => ({
        id: row.id, testID: `${props.testID}-option-${row.address.sessionId}`,
        label: row.label,
        disabled: Boolean(row.disabledReason) || props.disabled === true || props.pendingOptionId != null,
        ...(props.pendingOptionId === row.id ? { loading: true } : {}),
        icon: multipleSelectedIds && onToggle
            ? <SessionListSelectionCheckbox sessionId={row.address.sessionId} selectionKey={row.id}
                selected={multipleSelectedIds.has(row.id)} style={styles.checkbox}
                onPress={() => onToggle(row.address)} />
            : row.botFace ? <SessionBotFace facts={row.botFace} size={20}
                mood={row.working ? 'working' : row.statusTone === 'attention' ? 'needsYou' : undefined} />
            : <SessionAgentCatalogIdentityIcon agentId={row.agentId} machineId={row.machineId}
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
    }), [inline, multipleSelectedIds, onToggle, props.disabled, props.pendingOptionId, props.testID, theme.colors.text.secondary]);
    const sections = React.useMemo<readonly SelectionListSectionDescriptor[]>(() => {
        const { groupTitles } = props;
        const leading = isMultiple ? [] : (props.leadingOptions ?? []).map(option => props.pendingOptionId != null
            ? { ...option, disabled: true, loading: option.id === props.pendingOptionId } : option);
        if (props.sections) {
            return [
                ...(leading.length > 0 ? [{ kind: 'static' as const, id: 'leading', options: leading }] : []),
                ...props.sections.map(section => ({
                    kind: 'static' as const, id: section.id, title: section.title, options: section.rows.map(toOption),
                    virtualization: 'auto' as const,
                })),
            ];
        }
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
    }, [isMultiple, props.groupTitles, props.leadingOptions, props.pendingOptionId, props.rows, props.sections, toOption]);
    const rows = React.useMemo(() => props.rows ?? props.sections.flatMap(section => section.rows), [props.rows, props.sections]);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: `${props.testID}-root`, title: props.title, inputPlaceholder: props.searchPlaceholder,
        emptyStateLabel: props.emptyStateLabel, sections,
        ...(props.footerHints ? { footerHints: props.footerHints } : {}),
    }), [props.emptyStateLabel, props.footerHints, props.searchPlaceholder, props.testID, props.title, sections]);
    const selection = React.useMemo(() => multipleSelectedIds
        ? { kind: 'multiple' as const, selectedIds: multipleSelectedIds } : undefined, [multipleSelectedIds]);
    const { error, loading, note, queryStatus } = props;
    return (
        <>
            {queryStatus?.onRetry ? <Item testID={queryStatus.testID} title={queryStatus.label} titleLines={0}
                detail={t('common.retry')} disabled={queryStatus.retryDisabled} onPress={queryStatus.onRetry}
                accessibilityLiveRegion="polite" /> : queryStatus ? <Text
                testID={queryStatus.testID} accessibilityLiveRegion="polite">{queryStatus.label}</Text> : null}
            <SelectionList testID={`${props.testID}-list`} rootStep={rootStep}
                listAccessibilityLabel={props.listAccessibilityLabel}
                {...(selection ? { selection, selectionMark: 'none' as const } : { selectedOptionId: props.selectedOptionId })}
                inputSuffix={props.inputSuffix}
                inputAccessoryRow={note ? <FieldTextInput
                    testID={`${props.testID}-note`}
                    accessibilityLabel={note.label}
                    placeholder={note.label}
                    value={note.value}
                    onChangeText={note.onChangeText}
                    editable={props.pendingOptionId == null}
                    multiline
                    minLines={1}
                /> : undefined}
                footerAction={props.footerAction}
                pinnedRow={props.pinnedRow}
                inputValue={props.inputValue} onChangeInputValue={props.onChangeInputValue}
                pagination={props.pagination}
                contentState={loading?.presentation === 'line' ? <SurfaceStateCard testID={loading.testID}
                    kind="loading" size="line" title={loading.label} /> : loading ? <View
                    testID={loading.testID} accessibilityRole="progressbar" accessibilityLabel={loading.label}>
                    <SkeletonRows rows={4} {...SELECTION_LIST_SKELETON_ROW_SHAPE} />
                </View> : undefined}
                onSelect={id => {
                    const row = rows.find(candidate => candidate.id === id);
                    if (row && onToggle) onToggle(row.address);
                    else if (row) props.onSelectSession(row.address);
                    else props.onSelectOption?.(id);
                }} onRequestClose={props.onRequestClose} autoFocusInputOnWeb keyboardHintsEnabled
                maxHeight={props.maxHeight}
                fillAvailableSpace={props.layout === 'fill'}
                heightBehavior={props.layout === 'content' ? 'content' : 'fixedToMaxHeight'}
                showsVerticalScrollIndicator />
            {error ? <View style={styles.inset}>
                <SurfaceStateCard testID={error.testID} kind="error" size="line" title={error.label} accessibilitySemantics="alert" />
            </View> : null}
        </>
    );
});
