import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import { FileBrowserToolbar, FileBrowserToolbarIconButton } from './FileBrowserToolbar';
import { resolveFilesystemBrowserToolbarState, type FilesystemBrowserToolbarAction } from './filesystemBrowserToolbarState';
import { Icon } from '@/components/ui/icons/Icon';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

export type { FilesystemBrowserToolbarAction } from './filesystemBrowserToolbarState';

export type FilesystemBrowserToolbarChromeProps = Readonly<{
    currentUiContextCommandScope?: string;
    testID?: string;
    searchTestID?: string;
    searchPlaceholder: string;
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
    const [overflowOpen, setOverflowOpen] = React.useState(false);
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
    const scope = props.currentUiContextCommandScope;
    const commands = useCurrentUiContextLocalCommands(scope === undefined || overflowItems.length === 0 ? [] : [{
        key: 'overflow', title: overflowTitle ?? t('common.moreActions'),
        description: JSON.stringify({ control: `${scope}.overflow`, input: { open: 'boolean' } }),
        invoke: input => {
            if (input === undefined) return { ok: true, result: { open: overflowOpen } };
            if (input === null || typeof input !== 'object' || Array.isArray(input) || typeof input.open !== 'boolean') return false;
            setOverflowOpen(input.open); return true;
        },
    }], { foregroundOverlay: true, contextKey: scope });
    const changeOverflowOpen = React.useCallback((open: boolean) => {
        void commands.invoke('overflow', { open });
    }, [commands.invoke]);
    const renderOverflowTriggerButton = React.useCallback((props: Readonly<{
        testID?: string;
        accessibilityLabel?: string;
        accessibilityHint?: string;
        accessibilityState?: Readonly<{ expanded?: boolean }>;
        onPress?: () => void;
    }>) => (
        <FileBrowserToolbarIconButton
            testID={props.testID ?? overflowTriggerTestID}
            accessibilityLabel={props.accessibilityLabel ?? t('common.moreActions')}
            accessibilityHint={props.accessibilityHint}
            expanded={props.accessibilityState?.expanded}
            onPress={() => props.onPress?.()}
        >
            <Icon name="dots-three" size={16} color={theme.colors.text.secondary} />
        </FileBrowserToolbarIconButton>
    ), [overflowTriggerTestID, theme.colors.text.secondary]);

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
                    overflowOpen={scope === undefined ? undefined : overflowOpen}
                    onOverflowOpenChange={scope === undefined ? undefined : changeOverflowOpen}
                    title={overflowTitle ?? t('common.moreActions')}
                    actions={overflowItems}
                    overflowTriggerTestID={overflowTriggerTestID}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    compactActionIds={[]}
                    renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) =>
                        renderOverflowTriggerButton({
                            testID: testID ?? overflowTriggerTestID,
                            accessibilityLabel: accessibilityLabel ?? t('common.moreActions'),
                            accessibilityHint,
                            accessibilityState: { expanded: open },
                            onPress: toggle,
                        })
                    }
                />
            ) : null}
        </FileBrowserToolbar>
    );
}
