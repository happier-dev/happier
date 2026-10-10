import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PromptStackEntryV1 } from '@happier-dev/protocol';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import { promptStackPlacementLabel } from './promptStackEntryPresentation';
import { promptStackBudgetChoices } from './promptStackBudgetChoices';

/**
 * One document in a Context list (Account, Voice, Profile, Project, a Session's Work › Context): its
 * title, then one quiet line of where its text goes and who can read it. "⋯" holds Edit, Move and
 * Remove beside the switch, which keeps a document attached without using it. A layer that cannot
 * switch or edit an entry passes no handler and the control is not drawn; a read-only row has neither.
 */
export const PromptStackEntryRow = React.memo(function PromptStackEntryRow(props: Readonly<{
    testID: string;
    entry: PromptStackEntryV1;
    title: string;
    /** Appended to the placement word: "Shared with Acme", "Only you", "Can read". */
    access?: string;
    /** Replaces the whole second line (an owner-private or unreadable document). */
    note?: string;
    /** Lead glyph for a row that cannot be opened (a lock). */
    unavailable?: boolean;
    disabled?: boolean;
    onOpen?: () => void;
    onMove?: (delta: -1 | 1) => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onRemove?: () => void;
    onShare?: () => void;
    onEnabledChange?: (enabled: boolean) => void;
    onBudgetChange?: (maxChars: number | null) => void;
    /**
     * Whether the document is in effect on this surface, when that is not the entry's own switch (a
     * Session's view of an inherited entry it turned off, or one that is off where it was added).
     */
    on?: boolean;
    /** The switch shows the state but cannot change it from here (off at its source). */
    switchDisabled?: boolean;
    /** This surface's word for taking the document out ("Remove from this session"). */
    removeLabel?: string;
    showDivider?: boolean;
}>) {
    const { entry, onOpen, onMove, onRemove, onShare } = props;
    const actions = React.useMemo((): ItemAction[] => {
        const list: ItemAction[] = [];
        if (onOpen) list.push({ id: 'edit', title: t('common.edit'), icon: 'pencil', onPress: onOpen });
        if (onShare) list.push({ id: 'share', title: t('contextPages.share'), icon: 'share-network', onPress: onShare });
        if (onMove) {
            list.push({ id: 'moveUp', title: t('common.moveUp'), icon: 'caret-up', disabled: !props.canMoveUp || props.disabled, onPress: () => onMove(-1) });
            list.push({ id: 'moveDown', title: t('common.moveDown'), icon: 'caret-down', disabled: !props.canMoveDown || props.disabled, onPress: () => onMove(1) });
        }
        if (props.onBudgetChange) {
            for (const choice of promptStackBudgetChoices(entry.maxChars, {
                everything: t('contextPages.load.everything'), words: count => t('contextPages.load.words', { count: count.toLocaleString() }),
            })) list.push({ id: `budget.${choice.maxChars ?? 'all'}`, title: choice.title, icon: 'file-text',
                group: { id: 'budget', title: t('contextPages.load.title') },
                selected: (entry.maxChars ?? null) === choice.maxChars, disabled: props.disabled,
                onPress: () => props.onBudgetChange?.(choice.maxChars) });
        }
        if (onRemove) list.push({ id: 'delete', title: props.removeLabel ?? t('common.remove'), icon: 'trash', destructive: true, disabled: props.disabled, onPress: onRemove });
        return list;
    }, [entry.maxChars, onMove, onOpen, onRemove, onShare, props.canMoveDown, props.canMoveUp, props.disabled, props.removeLabel, props.onBudgetChange]);
    const off = props.on === undefined ? entry.enabled === false : !props.on;
    // With a switch on the row, the switch says "off"; the word is only for rows that have none.
    const subtitle = props.note ?? [
        promptStackPlacementLabel(entry.placement),
        props.access,
        off && !props.onEnabledChange ? t('contextPages.off') : null,
    ].filter(Boolean).join('  ·  ');
    const hasControls = actions.length > 0 || props.onEnabledChange;
    return (
        <Item
            testID={props.testID}
            icon={props.unavailable ? <Icon name="lock" /> : undefined}
            title={props.title}
            titleStyle={off || props.unavailable ? styles.quiet : undefined}
            subtitle={subtitle}
            onPress={onOpen}
            mode={onOpen ? 'interactive' : 'info'}
            showChevron={false}
            showDivider={props.showDivider}
            rightElementOutsidePressable
            rightElement={hasControls ? (
                <View style={styles.controls}>
                    {actions.length > 0 ? (
                        <ItemRowActions
                            title={props.title}
                            actions={actions}
                            overflowOnly
                            overflowTriggerTestID={`${props.testID}.more`}
                        />
                    ) : null}
                    {props.onEnabledChange ? (
                        <Switch
                            testID={`${props.testID}.enabled`}
                            value={!off}
                            disabled={props.disabled || props.switchDisabled}
                            accessibilityLabel={props.title}
                            onValueChange={props.onEnabledChange}
                        />
                    ) : null}
                </View>
            ) : undefined}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    quiet: {
        color: theme.colors.text.tertiary,
    },
}));
