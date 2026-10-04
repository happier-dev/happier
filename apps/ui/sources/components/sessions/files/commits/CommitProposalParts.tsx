import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WalkthroughLineCounts, WalkthroughPath, WalkthroughStopNumber } from '@/components/sessions/files/walkthrough/WalkthroughAtoms';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { ScmChangeMark } from '@/components/workspaces/scm/changes/ScmChangeMark';
import { Typography } from '@/constants/Typography';
import { describeScmChangeKind, resolveScmChangeToneColor } from '@/scm/scmChangeKind';
import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import type { CommitProposalChange, CommitProposalGroup, CommitProposalGroupState } from './commitProposal';

/** Where a moved change goes (lab WT4-C1 Move menu): another commit, a new one after a commit, or Left out. */
export type CommitMoveTarget =
    | Readonly<{ kind: 'group'; groupId: string }>
    | Readonly<{ kind: 'newGroupAfter'; groupId: string }>
    | Readonly<{ kind: 'leftOut' }>;

export type CommitMoveChoice = Readonly<{ number: number; groupId: string; message: string }>;

function fileName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * A commit's mark: its number while it is a proposal; the ring fills and the check arrives when it lands (the
 * Walkthrough's own signature mark); a spinner while it is being written; amber for a hook that waits on the
 * person, red when it stopped the run.
 */
export const CommitGroupMark = React.memo(function CommitGroupMark(props: Readonly<{ number: number; state: CommitProposalGroupState }>) {
    const { theme } = useUnistyles();
    if (props.state === 'writing') {
        return (
            <View style={styles.mark}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} accessibilityLabel={t('commitProposal.state.writing')} />
            </View>
        );
    }
    if (props.state === 'paused' || props.state === 'failed' || props.state === 'unknown') {
        const tone = props.state === 'paused' ? theme.colors.state.warning.foreground
            : props.state === 'failed' ? theme.colors.state.danger.foreground : theme.colors.text.tertiary;
        return (
            <View style={[styles.mark, styles.markFilled, { backgroundColor: tone }]}>
                <Text style={styles.markGlyph}>{props.state === 'unknown' ? '?' : '!'}</Text>
            </View>
        );
    }
    return <WalkthroughStopNumber number={props.number} reviewed={props.state === 'landed'} />;
});

/** One file of a commit (or of Left out): its exact part of the file, its lines, and its Move menu. */
export const CommitChangeRow = React.memo(function CommitChangeRow(props: Readonly<{
    change: CommitProposalChange;
    groupNumber: number | null;
    choices: readonly CommitMoveChoice[] | null;
    focused: boolean;
    onFocus?: (key: string) => void;
    onMove?: (change: CommitProposalChange, target: CommitMoveTarget) => void;
    phone: boolean;
    inspect?: Readonly<{ expanded: boolean; onPress: () => void }>;
}>) {
    const { theme } = useUnistyles();
    const { change } = props;
    const descriptor = describeScmChangeKind(change.changeKind as ScmEntryKind);
    // The captured evidence class (the host's shared path classifier), labelled with the shared change-list copy.
    const pathTag = change.lockfile ? t('scmComparison.lockfileTag') : change.generated ? t('scmComparison.generatedTag') : null;
    const [open, setOpen] = React.useState(false);
    const onFocus = props.onFocus;
    const onOpenChange = React.useCallback((next: boolean) => {
        setOpen(next);
        if (next) onFocus?.(change.key);
    }, [change.key, onFocus]);
    const items = React.useMemo<DropdownMenuItem[]>(() => {
        if (!props.choices) return [];
        const title = t('commitProposal.move.title', { file: fileName(change.path) });
        const groups = props.choices.map((choice) => ({
            id: `group:${choice.groupId}`,
            title: `${choice.number} · ${choice.message}`,
            category: title,
            checked: choice.number === props.groupNumber,
            ...(choice.number <= 9 ? { shortcut: `⌥${choice.number}` } : {}),
        }));
        const after = props.groupNumber ?? props.choices.length;
        const afterGroup = props.choices[after - 1];
        return [
            ...groups,
            ...(afterGroup ? [{
                id: `new:${afterGroup.groupId}`,
                title: t('commitProposal.move.newCommitAfter', { number: after }),
                category: ' ',
                icon: <Icon name="plus" size={15} color={theme.colors.text.secondary} />,
                shortcut: '⌥N',
            }] : []),
            ...(props.groupNumber !== null ? [{
                id: 'leftOut',
                title: t('commitProposal.move.leaveOut'),
                subtitle: t('commitProposal.move.leaveOutHint'),
                category: ' ',
                icon: <Icon name="stack" size={15} color={theme.colors.text.secondary} />,
                shortcut: '⌥0',
            }] : []),
        ];
    }, [change.path, props.choices, props.groupNumber, theme.colors.text.secondary]);
    const onMove = props.onMove;
    const select = React.useCallback((id: string) => {
        if (!onMove) return;
        if (id === 'leftOut') onMove(change, { kind: 'leftOut' });
        else if (id.startsWith('group:')) onMove(change, { kind: 'group', groupId: id.slice('group:'.length) });
        else if (id.startsWith('new:')) onMove(change, { kind: 'newGroupAfter', groupId: id.slice('new:'.length) });
    }, [change, onMove]);
    const movable = Boolean(props.choices && onMove);
    const row = (
        <View
            testID={`commit-change:${props.groupNumber ?? 'left-out'}:${change.path}`}
            style={[
                styles.row,
                props.phone ? styles.rowPhone : null,
                props.focused || open ? styles.rowFocused : null,
                change.hookChanged ? styles.rowHook : null,
            ]}
        >
            <ScmChangeMark code={descriptor.code} color={resolveScmChangeToneColor(descriptor.tone, theme)} size="compact" />
            <View style={styles.rowPath}>
                <WalkthroughPath path={change.path} />
                {change.part && !props.phone ? (
                    <Text style={styles.part} numberOfLines={1}>{t('commitProposal.part', change.part)}</Text>
                ) : null}
            </View>
            {pathTag ? (
                <View style={styles.tag}><Text style={styles.tagText}>{pathTag}</Text></View>
            ) : null}
            <WalkthroughLineCounts added={change.added} removed={change.removed} />
            {movable ? (
                <DropdownMenu
                    open={open}
                    onOpenChange={onOpenChange}
                    items={items}
                    selectedId={props.groupNumber !== null ? `group:${props.choices?.[props.groupNumber - 1]?.groupId ?? ''}` : null}
                    onSelect={select}
                    search={false}
                    showCategoryTitles
                    matchTriggerWidth={false}
                    maxWidthCap={360}
                    placement="bottom"
                    popoverAnchorAlign="end"
                    trigger={({ toggle }) => (
                        <IconButton
                            testID={`commit-change-move:${change.path}`}
                            variant="plain"
                            size={30}
                            iconName="arrows-left-right"
                            iconSize={15}
                            hasPopup="menu"
                            expanded={open}
                            accessibilityLabel={t('commitProposal.move.a11y', { file: fileName(change.path) })}
                            onPress={toggle}
                        />
                    )}
                />
            ) : <View style={styles.moveSlot} />}
        </View>
    );
    return props.inspect ? (
        <HappierPressable testID={`commit-hook-change:${change.path}`} accessibilityRole="button" accessibilityLabel={change.path}
            expanded={props.inspect.expanded} onPress={props.inspect.onPress}>
            {row}
        </HappierPressable>
    ) : row;
});

/** The header of a commit: its mark, a message you can edit in place, the one-line rationale and its state. */
export const CommitGroupHeader = React.memo(function CommitGroupHeader(props: Readonly<{
    group: CommitProposalGroup;
    meta: React.ReactNode;
    phone: boolean;
    canMoveUp: boolean;
    canMoveDown: boolean;
    canMerge: boolean;
    onEditMessage?: (groupId: string, message: string) => void;
    onMoveGroup?: (groupId: string, direction: -1 | 1) => void;
    onMergeWithNext?: (groupId: string) => void;
    onToggle?: () => void;
}>) {
    const { theme } = useUnistyles();
    const { group } = props;
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(group.message);
    const [menuOpen, setMenuOpen] = React.useState(false);
    React.useEffect(() => { if (!editing) setDraft(group.message); }, [editing, group.message]);
    const onEditMessage = props.onEditMessage;
    const commit = React.useCallback(() => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== group.message && onEditMessage) onEditMessage(group.id, next);
    }, [draft, group.id, group.message, onEditMessage]);
    const editable = group.editable && Boolean(onEditMessage);
    const menuItems = React.useMemo<DropdownMenuItem[]>(() => [
        ...(props.canMoveUp ? [{ id: 'up', title: t('commitProposal.group.moveUp'), icon: <Icon name="arrow-up" size={15} color={theme.colors.text.secondary} /> }] : []),
        ...(props.canMoveDown ? [{ id: 'down', title: t('commitProposal.group.moveDown'), icon: <Icon name="arrow-down" size={15} color={theme.colors.text.secondary} /> }] : []),
        ...(props.canMerge ? [{ id: 'merge', title: t('commitProposal.group.mergeWithNext'), icon: <Icon name="stack-simple" size={15} color={theme.colors.text.secondary} /> }] : []),
    ], [props.canMerge, props.canMoveDown, props.canMoveUp, theme.colors.text.secondary]);
    const onMoveGroup = props.onMoveGroup;
    const onMergeWithNext = props.onMergeWithNext;
    const selectMenu = React.useCallback((id: string) => {
        if (id === 'up') onMoveGroup?.(group.id, -1);
        else if (id === 'down') onMoveGroup?.(group.id, 1);
        else if (id === 'merge') onMergeWithNext?.(group.id);
    }, [group.id, onMergeWithNext, onMoveGroup]);
    const titleStyle = [styles.message, props.phone ? styles.messagePhone : null];
    return (
        <View style={styles.header}>
            <View style={styles.markSlot}><CommitGroupMark number={group.number} state={group.state} /></View>
            <View style={styles.headerText}>
                {editing ? (
                    <TextInput
                        testID={`commit-group-message-input:${group.id}`}
                        accessibilityLabel={t('commitProposal.group.messageA11y', { number: group.number })}
                        value={draft}
                        onChangeText={setDraft}
                        autoFocus
                        selectTextOnFocus
                        onBlur={commit}
                        onSubmitEditing={commit}
                        onKeyPress={(event) => { if ((event.nativeEvent as { key?: string }).key === 'Escape') { setDraft(group.message); setEditing(false); } }}
                        returnKeyType="done"
                        style={[titleStyle, styles.messageInput]}
                    />
                ) : (
                    <Text
                        testID={`commit-group-message:${group.id}`}
                        style={titleStyle}
                        onPress={editable ? () => setEditing(true) : props.onToggle}
                        accessibilityRole={editable ? 'button' : undefined}
                        accessibilityLabel={t('commitProposal.group.a11y', { number: group.number, message: group.message })}
                    >
                        {group.message}
                    </Text>
                )}
                {group.rationale ? <Text style={[styles.rationale, props.phone ? styles.rationalePhone : null]}>{group.rationale}</Text> : null}
                <View style={styles.meta}>{props.meta}</View>
            </View>
            {editable ? (
                <View style={styles.headerActions}>
                    <IconButton
                        testID={`commit-group-edit:${group.id}`}
                        variant="plain"
                        size={30}
                        iconName="pencil-simple"
                        iconSize={15}
                        tooltip={t('commitProposal.group.editMessage')}
                        accessibilityLabel={t('commitProposal.group.editMessage')}
                        onPress={() => setEditing(true)}
                    />
                    {menuItems.length > 0 ? (
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            items={menuItems}
                            onSelect={selectMenu}
                            search={false}
                            matchTriggerWidth={false}
                            maxWidthCap={280}
                            placement="bottom"
                            popoverAnchorAlign="end"
                            trigger={({ toggle }) => (
                                <IconButton
                                    testID={`commit-group-more:${group.id}`}
                                    variant="plain"
                                    size={30}
                                    iconName="dots-three"
                                    iconSize={16}
                                    hasPopup="menu"
                                    expanded={menuOpen}
                                    accessibilityLabel={t('commitProposal.group.more')}
                                    onPress={toggle}
                                />
                            )}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});

export const commitPartsStyles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    cardQuiet: { backgroundColor: 'transparent', borderColor: theme.colors.border.default },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border.default },
}));

const styles = StyleSheet.create((theme) => ({
    mark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
    markFilled: { borderRadius: 11 },
    markGlyph: { fontSize: 12.5, color: theme.colors.surface.base, ...Typography.default('bold') },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingLeft: 16, paddingRight: 10, paddingTop: 14, paddingBottom: 14 },
    markSlot: { paddingTop: 1 },
    headerText: { flex: 1, minWidth: 0 },
    message: {
        fontSize: 16.5,
        lineHeight: 23,
        letterSpacing: -0.15,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    messagePhone: { fontSize: 17, lineHeight: 24 },
    messageInput: {
        marginHorizontal: -7,
        marginVertical: -3,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 7,
        borderWidth: 1.5,
        borderColor: theme.colors.border.focus,
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as object : null),
    },
    rationale: { marginTop: 3, fontSize: 14.5, lineHeight: 21, color: theme.colors.text.secondary, ...Typography.default() },
    rationalePhone: { fontSize: 15, lineHeight: 22 },
    meta: { marginTop: 6, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: -3 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 36,
        paddingLeft: 48,
        paddingRight: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    rowPhone: { paddingLeft: 16, gap: 8 },
    rowFocused: { backgroundColor: theme.colors.surface.inset },
    rowHook: { backgroundColor: theme.colors.state.warning.background },
    rowPath: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
    part: { flexShrink: 0, fontSize: 12.5, color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default() },
    tag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: theme.colors.surface.inset },
    tagText: { fontSize: 11.5, color: theme.colors.text.secondary, ...Typography.default('semiBold') },
    moveSlot: { width: 30 },
}));
