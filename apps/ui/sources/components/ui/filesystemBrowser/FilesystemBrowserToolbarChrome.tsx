import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import { FileBrowserToolbar, FileBrowserToolbarIconButton } from './FileBrowserToolbar';
import { resolveFilesystemBrowserToolbarState, type FilesystemBrowserToolbarAction } from './filesystemBrowserToolbarState';

export type { FilesystemBrowserToolbarAction } from './filesystemBrowserToolbarState';

export type FilesystemBrowserToolbarChromeProps = Readonly<{
    testID?: string;
    searchTestID?: string;
    searchPlaceholder?: string;
    searchValue: string;
    onSearchValueChange: (value: string) => void;
    actions: readonly FilesystemBrowserToolbarAction[];
    buildOverflowItems: (hiddenActions: readonly FilesystemBrowserToolbarAction[]) => ItemAction[];
    onWidthChange?: (width: number) => void;
    overflowTriggerTestID?: string;
    overflowTitle?: string;
    renderActionNode?: (action: FilesystemBrowserToolbarAction) => React.ReactNode;
    onActionPressIn?: () => void;
}>;

function defaultRenderActionNode(action: FilesystemBrowserToolbarAction): React.ReactNode {
    return (
        <FileBrowserToolbarIconButton
            key={action.id}
            testID={action.id}
            accessibilityLabel={action.accessibilityLabel}
            onPress={action.onPress}
            selected={action.selected}
            disabled={action.disabled}
        >
            {action.icon}
        </FileBrowserToolbarIconButton>
    );
}

export function FilesystemBrowserToolbarChrome(props: FilesystemBrowserToolbarChromeProps) {
    const { theme } = useUnistyles();
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const {
        actions,
        buildOverflowItems,
        onSearchValueChange,
        onWidthChange,
        overflowTitle,
        overflowTriggerTestID,
        renderActionNode,
        searchPlaceholder,
        searchTestID,
        searchValue,
        testID,
    } = props;
    const { visibleActions, hiddenActions } = React.useMemo(
        () => resolveFilesystemBrowserToolbarState({ toolbarWidth, actions }),
        [actions, toolbarWidth],
    );
    const overflowItems = React.useMemo(
        () => buildOverflowItems(hiddenActions),
        [buildOverflowItems, hiddenActions],
    );

    return (
        <FileBrowserToolbar
            testID={testID}
            searchTestID={searchTestID}
            searchPlaceholder={searchPlaceholder}
            searchValue={searchValue}
            onSearchValueChange={onSearchValueChange}
            onWidthChange={(width) => {
                setToolbarWidth(width);
                onWidthChange?.(width);
            }}
        >
            {visibleActions.map(renderActionNode ?? defaultRenderActionNode)}
            {overflowItems.length > 0 ? (
                <ItemRowActions
                    title={overflowTitle ?? t('common.moreActions')}
                    actions={overflowItems}
                    overflowTriggerTestID={overflowTriggerTestID}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    compactActionIds={[]}
                    renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                        <FileBrowserToolbarIconButton
                            testID={testID ?? overflowTriggerTestID}
                            accessibilityLabel={accessibilityLabel ?? t('common.moreActions')}
                            accessibilityHint={accessibilityHint}
                            accessibilityState={{ expanded: open }}
                            onPress={toggle}
                        >
                            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
                        </FileBrowserToolbarIconButton>
                    )}
                />
            ) : null}
        </FileBrowserToolbar>
    );
}
