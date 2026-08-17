import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Popover } from '@/components/ui/popover';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { SelectableMenuResults } from '@/components/ui/forms/dropdown/SelectableMenuResults';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { CREATE_ITEM_ID, useSelectableMenu } from '@/components/ui/forms/dropdown/useSelectableMenu';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export type WorkspaceScmBranchPopoverTabId = 'branches' | 'worktrees';

export type WorkspaceScmBranchPopoverControls = Readonly<{
    closeMenu: () => void;
    reopenMenu: () => void;
}>;

export type WorkspaceScmBranchPopoverProps = Readonly<{
    open: boolean;
    onOpenChange: (next: boolean) => void;
    currentBranch: string | null;
    disabled?: boolean;
    branchItems: ReadonlyArray<SelectableMenuItem>;
    worktreeItems: ReadonlyArray<SelectableMenuItem>;
    onSelectItem: (itemId: string, controls: WorkspaceScmBranchPopoverControls) => void | Promise<void>;
    onCreateBranch?: ((query: string) => void | Promise<void>) | null;
    testID?: string;
}>;

function buildTabDescriptors(props: Pick<WorkspaceScmBranchPopoverProps, 'branchItems' | 'worktreeItems'>): ReadonlyArray<SegmentedTab<WorkspaceScmBranchPopoverTabId>> {
    const tabs: Array<SegmentedTab<WorkspaceScmBranchPopoverTabId>> = [];
    if (props.branchItems.length > 0) {
        tabs.push({ id: 'branches', label: t('files.branchMenu.category.branches') });
    }
    if (props.worktreeItems.length > 0) {
        tabs.push({ id: 'worktrees', label: t('files.branchMenu.category.worktrees') });
    }
    if (tabs.length === 0) {
        tabs.push({ id: 'branches', label: t('files.branchMenu.category.branches') });
    }
    return tabs;
}

export function WorkspaceScmBranchPopover(props: WorkspaceScmBranchPopoverProps): React.ReactElement {
    const { theme } = useUnistyles();
    const disabled = props.disabled === true;
    const anchorRef = React.useRef<View>(null);
    const triggerTestId = props.testID ?? 'scm-branch-menu-trigger';
    const tabs = React.useMemo(() => buildTabDescriptors(props), [props]);
    const [activeTabId, setActiveTabId] = React.useState<WorkspaceScmBranchPopoverTabId>(tabs[0]?.id ?? 'branches');

    React.useEffect(() => {
        if (tabs.some((tab) => tab.id === activeTabId)) return;
        setActiveTabId(tabs[0]?.id ?? 'branches');
    }, [activeTabId, tabs]);

    const items = activeTabId === 'worktrees' ? props.worktreeItems : props.branchItems;
    const allowCreateBranch = activeTabId === 'branches' ? (props.onCreateBranch ?? null) : null;
    const { searchQuery, selectedIndex, filteredCategories, inputRef, handleSearchChange, handleKeyPress, setSelectedIndex } = useSelectableMenu({
        items,
        onRequestClose: () => props.onOpenChange(false),
        open: props.open,
        initialSelectedId: activeTabId === 'branches' && props.currentBranch ? `branch:${props.currentBranch}` : null,
        onCreateItem: allowCreateBranch
            ? (query) => {
                void allowCreateBranch(query);
            }
            : null,
        createItemFactory: allowCreateBranch
            ? (query) => ({
                title: t('files.branchMenu.create.title'),
                subtitle: t('files.branchMenu.create.subtitle', { name: query.trim() }),
                disabled: !query.trim(),
            })
            : null,
        allowEmptySelection: false,
    });

    const closeMenu = React.useCallback(() => props.onOpenChange(false), [props]);
    const reopenMenu = React.useCallback(() => props.onOpenChange(true), [props]);
    const controls = React.useMemo<WorkspaceScmBranchPopoverControls>(() => ({ closeMenu, reopenMenu }), [closeMenu, reopenMenu]);

    const handleActivateItem = React.useCallback((item: SelectableMenuItem) => {
        if (item.id === CREATE_ITEM_ID && allowCreateBranch) {
            void allowCreateBranch(searchQuery);
            return;
        }
        void props.onSelectItem(item.id, controls);
    }, [allowCreateBranch, controls, props, searchQuery]);

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <Pressable
                    testID={triggerTestId}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.branchMenu.openA11y')}
                    onPress={() => props.onOpenChange(!props.open)}
                    disabled={disabled}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        opacity: disabled ? 0.6 : pressed ? 0.82 : 1,
                    })}
                >
                    <Text numberOfLines={1} style={{ fontSize: 14, color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                        {props.currentBranch || t('files.detachedHead')}
                    </Text>
                    <Icon name={props.open ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.secondary} />
                </Pressable>
            </View>
            <Popover
                open={props.open}
                onRequestClose={closeMenu}
                anchorRef={anchorRef}
                placement="bottom"
                gap={4}
                maxHeightCap={480}
                maxWidthCap={420}
                portal={{ web: { target: 'body' }, native: true }}
            >
                {() => (
                    <View
                        style={{
                            width: 360,
                            maxWidth: 420,
                            minWidth: 280,
                            borderRadius: 14,
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            backgroundColor: theme.colors.surface.base,
                            overflow: 'hidden',
                        }}
                    >
                        {tabs.length > 1 ? (
                            <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10 }}>
                                <SegmentedTabBar
                                    tabs={tabs}
                                    activeTabId={activeTabId}
                                    onSelectTab={setActiveTabId}
                                    testIDPrefix="workspace-scm-branch-popover-tab"
                                    compact
                                />
                            </View>
                        ) : null}
                        <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
                            <TextInput
                                ref={inputRef}
                                value={searchQuery}
                                onChangeText={handleSearchChange}
                                placeholder={t('files.branchMenu.searchPlaceholder')}
                                placeholderTextColor={theme.colors.text.secondary}
                                testID="workspace-scm-branch-popover-search"
                                onKeyPress={(event) => {
                                    handleKeyPress(String(event.nativeEvent.key ?? ''), handleActivateItem);
                                }}
                                style={{
                                    fontSize: 13,
                                    color: theme.colors.text.primary,
                                    borderWidth: 1,
                                    borderColor: theme.colors.border.default,
                                    borderRadius: 10,
                                    paddingHorizontal: 12,
                                    paddingVertical: 8,
                                    backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
                                }}
                            />
                        </View>
                        <ScrollView
                            style={{ maxHeight: 360 }}
                            contentContainerStyle={{ paddingBottom: 8 }}
                            keyboardShouldPersistTaps="handled"
                            nestedScrollEnabled
                            testID="workspace-scm-branch-popover-scroll"
                        >
                            <SelectableMenuResults
                                categories={filteredCategories}
                                selectedIndex={selectedIndex}
                                onSelectionChange={setSelectedIndex}
                                onPressItem={handleActivateItem}
                                rowVariant="slim"
                                emptyLabel={t('files.branchMenu.empty')}
                            />
                        </ScrollView>
                    </View>
                )}
            </Popover>
        </>
    );
}
