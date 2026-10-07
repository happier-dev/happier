import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CommitProposal } from '@/components/sessions/files/commits/commitProposal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { isEditableKeyboardTarget } from '@/components/ui/keyboard/isEditableKeyboardTarget';
import { t } from '@/text';

/**
 * The Git pane's summary of a pending commit proposal (Walkthrough lab WT4-C2), in the commit card's place.
 * Tapping a commit selects it: its changes light up in the list above and the rest dim. Tapping it again, or
 * Open, jumps to it in the Commits view, where editing happens. Selection is a view state of the pane.
 */
export const GitProposedCommitsCard = React.memo(function GitProposedCommitsCard(props: Readonly<{
    proposal: CommitProposal;
    selectedGroupId: string | null;
    onSelectGroup: (groupId: string) => void;
    /** Esc clears the selection (a view state); the list reads as usual again. */
    onClearSelection?: () => void;
    onOpenGroup: (groupId: string) => void;
    onReview: () => void;
    onCreate?: () => void;
    createBusy?: boolean;
    onDiscard?: () => void;
    onRegenerate?: () => void;
    phone: boolean;
}>) {
    const { theme } = useUnistyles();
    const { proposal } = props;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const remaining = proposal.groups.length - proposal.landedCount;
    const onClearSelection = props.onClearSelection;
    const hasSelection = props.selectedGroupId !== null;
    React.useEffect(() => {
        if (!hasSelection || !onClearSelection || Platform.OS !== 'web') return;
        const w = (globalThis as { window?: Window }).window;
        if (!w || typeof w.addEventListener !== 'function') return;
        const handler = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || isEditableKeyboardTarget(event.target)) return;
            onClearSelection();
        };
        w.addEventListener('keydown', handler);
        return () => w.removeEventListener('keydown', handler);
    }, [hasSelection, onClearSelection]);
    const menuItems = React.useMemo<DropdownMenuItem[]>(() => [
        ...(props.onRegenerate ? [{ id: 'regenerate', title: t('commitProposal.regenerate'), icon: <Icon name="arrows-clockwise" size={15} color={theme.colors.text.secondary} /> }] : []),
        ...(props.onDiscard ? [{ id: 'discard', title: t('commitProposal.footer.discard'), destructive: true }] : []),
    ], [props.onDiscard, props.onRegenerate, theme.colors.text.secondary]);
    const onDiscard = props.onDiscard;
    const onRegenerate = props.onRegenerate;
    const selectMenu = React.useCallback((id: string) => {
        if (id === 'discard') onDiscard?.();
        else if (id === 'regenerate') onRegenerate?.();
    }, [onDiscard, onRegenerate]);
    return (
        <View testID="git-proposed-commits" accessibilityRole="summary" accessibilityLabel={t('commitProposal.gitPane.title')} style={[styles.card, props.phone ? styles.cardPhone : null]}>
            <View style={styles.head}>
                <Icon name="sparkle" size={14} color={theme.colors.text.secondary} />
                <Text style={styles.title}>{t('commitProposal.gitPane.title')}</Text>
                <Text style={styles.meta}>{t('commitProposal.gitPane.meta', { count: proposal.groups.length, files: proposal.committedFileCount })}</Text>
                <View style={styles.grow} />
                {!props.phone && menuItems.length > 0 ? (
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={menuItems}
                        onSelect={selectMenu}
                        search={false}
                        matchTriggerWidth={false}
                        maxWidthCap={260}
                        placement="top"
                        popoverAnchorAlign="end"
                        trigger={({ toggle }) => (
                            <IconButton testID="git-proposed-commits-more" variant="plain" size={28} iconName="dots-three" iconSize={16}
                                hasPopup="menu" expanded={menuOpen} accessibilityLabel={t('commitProposal.gitPane.more')} onPress={toggle} />
                        )}
                    />
                ) : null}
            </View>
            {proposal.groups.map((group) => {
                const selected = props.selectedGroupId === group.id;
                const dimmed = props.selectedGroupId !== null && !selected;
                return (
                    <View key={group.id} style={[styles.row, selected ? styles.rowSelected : null, dimmed ? styles.rowDimmed : null]}>
                        <HappierPressable
                            testID={`git-proposed-commit:${group.id}`}
                            accessibilityRole="button"
                            selected={selected}
                            accessibilityLabel={t('commitProposal.group.a11y', { number: group.number, message: group.message })}
                            accessibilityHint={selected ? t('commitProposal.gitPane.selectedHint') : t('commitProposal.gitPane.tapHint')}
                            onPress={() => props.onSelectGroup(group.id)}
                            style={(state) => [
                                styles.rowSelect,
                                Platform.OS === 'web' && state.hovered && !selected ? styles.rowHover : null,
                                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                            ]}
                        >
                            <View style={[styles.number, selected ? styles.numberSelected : null, group.state === 'landed' ? styles.numberLanded : null]}>
                                {group.state === 'landed'
                                    ? <Icon name="check" size={11} weight="bold" color={theme.colors.surface.base} />
                                    : <Text style={[styles.numberText, selected ? styles.numberTextSelected : null]}>{String(group.number)}</Text>}
                            </View>
                            <View style={styles.rowText}>
                                <Text style={styles.message} numberOfLines={2}>{group.message}</Text>
                                <Text style={styles.sub} numberOfLines={1}>
                                    {[t('commitProposal.fileCount', { count: group.changes.length }), group.rationale || null].filter(Boolean).join(' · ')}
                                </Text>
                            </View>
                        </HappierPressable>
                        {selected ? (
                            <HappierPressable
                                testID="git-proposed-commit-open"
                                accessibilityRole="button"
                                onPress={() => props.onOpenGroup(group.id)}
                                style={({ pressed, focused }) => [styles.open, pressed ? styles.openPressed : null,
                                    focusRingStyle({ focused, color: theme.colors.border.focus })]}
                            >
                                <Text style={styles.openText}>{t('commitProposal.gitPane.open')}</Text>
                                <Icon name="caret-right" size={12} color={theme.colors.text.secondary} />
                            </HappierPressable>
                        ) : null}
                    </View>
                );
            })}
            <View style={styles.actions}>
                <RoundButton
                    testID="git-proposed-commits-review"
                    size="small"
                    display="secondary"
                    title={props.phone ? t('commitProposal.gitPane.review') : t('commitProposal.gitPane.reviewInWalkthrough')}
                    onPress={props.onReview}
                />
                <View style={styles.grow} />
                {props.onCreate && remaining > 0 ? (
                    <RoundButton
                        testID="git-proposed-commits-create"
                        size="small"
                        title={t('commitProposal.footer.createShort', { count: remaining })}
                        loading={props.createBusy === true}
                        disabled={props.createBusy === true}
                        onPress={props.onCreate}
                    />
                ) : null}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        marginHorizontal: 10,
        marginTop: 8,
        marginBottom: 10,
        paddingTop: 10,
        paddingBottom: 10,
        paddingHorizontal: 6,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    cardPhone: { marginHorizontal: 12 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 8, minHeight: 28, marginBottom: 4 },
    title: { fontSize: 14, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    meta: { fontSize: 13, color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default() },
    grow: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, borderRadius: 10 },
    rowSelect: { flex: 1, minWidth: 0, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10,
        borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
    rowSelected: { backgroundColor: theme.colors.state.active.background },
    rowDimmed: { opacity: 0.55 },
    rowHover: { backgroundColor: theme.colors.surface.inset },
    number: {
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.25,
        borderColor: theme.colors.border.strong,
    },
    numberSelected: { backgroundColor: theme.colors.state.active.foreground, borderColor: theme.colors.state.active.foreground },
    numberLanded: { backgroundColor: theme.colors.state.success.foreground, borderColor: theme.colors.state.success.foreground },
    numberText: { fontSize: 11, color: theme.colors.text.secondary, fontVariant: ['tabular-nums'], ...Typography.default('semiBold') },
    numberTextSelected: { color: theme.colors.surface.base },
    rowText: { flex: 1, minWidth: 0 },
    message: { fontSize: 14, lineHeight: 19, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    sub: { marginTop: 1, fontSize: 12.5, lineHeight: 17, color: theme.colors.text.tertiary, ...Typography.default() },
    open: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        height: 28,
        paddingLeft: 10,
        paddingRight: 7,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    openPressed: { opacity: 0.6 },
    openText: { fontSize: 13, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingTop: 8 },
}));
