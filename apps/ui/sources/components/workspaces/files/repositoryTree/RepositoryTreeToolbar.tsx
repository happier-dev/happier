import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FileBrowserToolbar } from '@/components/ui/filesystemBrowser/FileBrowserToolbar';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

export type RepositoryTreeToolbarProps = Readonly<{
    /** Prefix of every control's testID (`repository-tree`, `workspace-repository-tree`). */
    testIDPrefix: string;
    searchValue: string;
    onSearchValueChange: (value: string) => void;
    /** Code owns Go to file above the table; keep only the shared View and creation controls. */
    showSearch?: boolean;
    /** The tree is pruned to the changed files (session tabs lab FC). */
    changedOnly: boolean;
    /** The one changed-file count (`selectScmChangedFiles(snapshot).length`); null while unknown. */
    changedCount: number | null;
    onChangedOnlyChange: (next: boolean) => void;
    detailsMode: boolean;
    onDetailsModeChange: (next: boolean) => void;
    /** Collapse all is offered only while a folder is open. */
    onCollapseAll: (() => void) | null;
    onRefresh: () => void;
    /** The tree root is loading: the View menu's trigger shows it. */
    refreshing: boolean;
    /** A host that has no pane header (the projects pane) keeps its + menu here. */
    trailing?: React.ReactNode;
    onRequestClose?: () => void;
}>;

/**
 * The Files tree's one toolbar (lab F1): search, Changed only and one View menu. With Changed only
 * on, the search row becomes the chip that says what the tree shows and how many, and clears it.
 */
export const RepositoryTreeToolbar = React.memo(function RepositoryTreeToolbar(props: RepositoryTreeToolbarProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [viewMenuOpen, setViewMenuOpen] = React.useState(false);
    const iconColor = theme.colors.text.secondary;
    const prefix = props.testIDPrefix;
    const { onChangedOnlyChange, onDetailsModeChange, onCollapseAll, onRefresh, detailsMode } = props;

    const viewItems = React.useMemo((): readonly DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [{
            id: `${prefix}-toggle-details`,
            testID: `${prefix}-toggle-details`,
            title: t('files.pane.sizeAndDate'),
            icon: <Icon name="list" size={16} color={iconColor} />,
            checked: detailsMode,
        }];
        if (onCollapseAll) {
            items.push({
                id: `${prefix}-collapse-all`,
                testID: `${prefix}-collapse-all`,
                title: t('files.repositoryCollapseAll'),
                icon: <Icon name="arrows-in" size={16} color={iconColor} />,
            });
        }
        items.push({
            id: `${prefix}-refresh`,
            testID: `${prefix}-refresh`,
            title: t('common.refresh'),
            icon: <Icon name="arrows-clockwise" size={16} color={iconColor} />,
        });
        return items;
    }, [detailsMode, iconColor, onCollapseAll, prefix]);

    const selectViewItem = React.useCallback((itemId: string) => {
        setViewMenuOpen(false);
        if (itemId === `${prefix}-toggle-details`) onDetailsModeChange(!detailsMode);
        else if (itemId === `${prefix}-collapse-all`) onCollapseAll?.();
        else if (itemId === `${prefix}-refresh`) onRefresh();
    }, [detailsMode, onCollapseAll, onDetailsModeChange, onRefresh, prefix]);

    const viewMenu = (
        <DropdownMenu
            testID={`${prefix}-view-menu`}
            open={viewMenuOpen}
            onOpenChange={setViewMenuOpen}
            items={viewItems}
            onSelect={selectViewItem}
            matchTriggerWidth={false}
            placement="bottom"
            trigger={({ open, toggle }) => (
                <IconButton
                    testID={`${prefix}-view`}
                    variant="plain"
                    size={32}
                    {...(props.refreshing
                        ? { icon: <ActivitySpinner testID={`${prefix}-refresh-loading`} size="small" color={iconColor} /> }
                        : { iconName: 'sliders-horizontal' as const })}
                    selected={open}
                    expanded={open}
                    hasPopup="menu"
                    accessibilityLabel={t('files.pane.viewOptions')}
                    tooltip={t('files.pane.viewOptions')}
                    onPress={toggle}
                />
            )}
        />
    );

    const close = props.onRequestClose ? (
        <IconButton
            testID={`${prefix}-close`}
            variant="plain"
            size={32}
            iconName="x"
            accessibilityLabel={t('common.close')}
            onPress={props.onRequestClose}
        />
    ) : null;

    const clearChangedOnly = React.useCallback(() => onChangedOnlyChange(false), [onChangedOnlyChange]);
    const changedOnlyChip = React.useMemo(() => ({
        id: 'changed-only',
        testID: `${prefix}-changed-only-chip`,
        label: t('files.pane.changedOnly'),
        valueLabel: t('files.pane.changedOnly'),
        icon: <Icon name="funnel-simple" size={14} color={iconColor} />,
        count: props.changedCount === null ? undefined : formatExactCount(props.changedCount),
        onClear: clearChangedOnly,
        clearAccessibilityLabel: t('files.pane.showAllFiles'),
    }), [clearChangedOnly, iconColor, prefix, props.changedCount]);

    if (props.changedOnly || props.showSearch === false) {
        return (
            <View testID={`${prefix}-toolbar`} style={styles.row}>
                {props.changedOnly ? <SelectionListFilterChip filter={changedOnlyChip} /> : null}
                <View style={styles.spacer} />
                {viewMenu}
                {props.trailing}
                {close}
            </View>
        );
    }

    return (
        <FileBrowserToolbar
            testID={`${prefix}-toolbar`}
            searchTestID={`${prefix}-search`}
            searchPlaceholder={t('files.searchPlaceholder')}
            searchValue={props.searchValue}
            onSearchValueChange={props.onSearchValueChange}
            style={styles.searchRow}
        >
            {props.searchValue.length > 0 ? (
                <IconButton
                    testID={`${prefix}-clear-search`}
                    variant="plain"
                    size={32}
                    iconName="x"
                    accessibilityLabel={t('files.clearSearchA11y')}
                    onPress={() => props.onSearchValueChange('')}
                />
            ) : null}
            <IconButton
                testID={`${prefix}-filter-changed`}
                variant="plain"
                size={32}
                iconName="funnel-simple"
                selected={false}
                accessibilityRole="switch"
                checked={false}
                accessibilityLabel={t('files.pane.changedOnly')}
                tooltip={t('files.pane.changedOnly')}
                onPress={() => onChangedOnlyChange(true)}
            />
            {viewMenu}
            {props.trailing}
            {close}
        </FileBrowserToolbar>
    );
});

const stylesheet = StyleSheet.create(() => ({
    // The toolbar sits on the pane without a rule under it; the segmented row or the tree follows.
    searchRow: {
        borderBottomWidth: 0,
        gap: 4,
        paddingBottom: 6,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 6,
    },
    spacer: {
        flex: 1,
    },
}));
