import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { resolveHappierPointerPlatform } from '@happier-dev/plugin-ui/presentation';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { useWorkspaceRouterFacts, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { WORKSPACE_VIEW_MINIMUM } from './workspaceSplit';
import type { WorkspaceOpenOptions } from './workspaceNavigationAdapter';
import { resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import { useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { executeWorkspaceUiAction } from './workspaceActionRuntime';
import type { DesktopWindowTarget } from '@happier-dev/protocol/actions/actionSpecs';
import { useRouter } from './destinationRoute';

export const WORKSPACE_OPEN_IN_NEW_TAB_ID = 'workspace.open.newTab';
export const WORKSPACE_OPEN_TO_RIGHT_ID = 'workspace.open.right';
export const WORKSPACE_OPEN_BELOW_ID = 'workspace.open.below';
export const WORKSPACE_OPEN_IN_WINDOW_ID = 'workspace.open.window';

export type WorkspaceOpenMode = 'newTab' | 'splitRight' | 'splitDown';
export type WorkspaceOpenActionsOptions = Readonly<{
    sourceTabId?: string;
    /** A pane or a surface outside the workspace keeps its actual qualified address. */
    windowTarget?: DesktopWindowTarget;
    presentationAction?: Readonly<{
        item: DropdownMenuItem & Readonly<{ icon: React.ReactElement }>;
        onSelect: () => void;
    }>;
}>;

/**
 * Opens `href` in the workspace as a kept tab (never the preview), or beside the focused pane — the
 * split admitted by that pane's measured size like every other split. False when the workspace is
 * not the navigation owner here or the destination/split cannot open.
 */
export function openInWorkspace(workspace: WorkspaceNavigationContextValue | null, href: string, mode: WorkspaceOpenMode,
    groupId?: string, onOpened?: () => void): boolean {
    // A phone keeps tabs but has no canvas to split: only a kept tab opens there.
    if (workspace?.phone) return mode === 'newTab' && (onOpened
        ? workspace.phone.openHref(href, 'newTab', onOpened) : workspace.phone.openHref(href, 'newTab'));
    if (!workspace?.active) return false;
    if (mode === 'newTab') return workspace.openHref(href, { mode: 'newTab', ...(groupId ? { groupId } : {}), ...(onOpened ? { onOpened } : {}) });
    const direction = mode === 'splitRight' ? 'right' : 'down';
    const measurement = workspace.canvasControlsRef?.current?.readSplitMeasurement(workspace.state.focusedGroupId, direction);
    if (!measurement) return false;
    const options: WorkspaceOpenOptions = {
        ...(onOpened ? { onOpened } : {}),
        mode,
        availableSizePx: measurement.availableSizePx,
        minimumFirstSizePx: measurement.minimumExistingSizePx,
        minimumSecondSizePx: direction === 'right' ? WORKSPACE_VIEW_MINIMUM.width : WORKSPACE_VIEW_MINIMUM.height,
    };
    return workspace.openHref(href, options);
}

/**
 * The open mode a pointer gesture asks for on a row that opens a destination (workspace lab O):
 * Middle-click, ⌥-click and the platform's Command/control-click keep the page as a new tab. A plain
 * click returns null and follows the row's own navigation (the focused pane's preview tab).
 */
export function resolveWorkspaceOpenModeFromPointer(event: unknown): WorkspaceOpenMode | null {
    if (!event || typeof event !== 'object') return null;
    const source = event as { metaKey?: unknown; ctrlKey?: unknown; altKey?: unknown; button?: unknown;
        nativeEvent?: { metaKey?: unknown; ctrlKey?: unknown; altKey?: unknown; button?: unknown } };
    const read = (key: 'metaKey' | 'ctrlKey' | 'altKey' | 'button') => source[key] ?? source.nativeEvent?.[key];
    if (read('button') === 2) return null;
    if (read('button') === 1 || read('altKey') === true) return 'newTab';
    const platform = resolveHappierPointerPlatform(Platform.OS);
    if (read(platform === 'macos' || platform === 'ios' ? 'metaKey' : 'ctrlKey') === true) return 'newTab';
    return null;
}

/**
 * "Open in new tab / to the right / below" for a row that opens `href`: the menu items and their
 * handler, from the one workspace owner. A phone offers only "Open in new tab" (it has no canvas to
 * split). Presentation items use the canonical desktop host availability and the supplied address.
 */
export function useWorkspaceOpenActions(href: string | null, onOpened?: () => void, options?: WorkspaceOpenActionsOptions): Readonly<{
    items: readonly (DropdownMenuItem & Readonly<{ icon: React.ReactElement }>)[];
    presentationItems: readonly (DropdownMenuItem & Readonly<{ icon: React.ReactElement }>)[];
    select: (itemId: string) => boolean;
    open: (mode: WorkspaceOpenMode) => boolean;
}> {
    // Tab state, titles and history are invocation-time facts: a row subscribes to capabilities only.
    const facts = useWorkspaceRouterFacts();
    const router = useRouter();
    const windows = useDesktopHostRoleAvailability('windows');
    const { theme } = useUnistyles();
    const active = facts?.active === true && href !== null;
    const phone = facts?.hasPhone === true && href !== null;
    const target = React.useMemo(() => href ? resolveDestinationRefFromHref(facts?.catalog ?? [], href) : null, [facts?.catalog, href]);
    const canOpenWindow = !phone && windows?.kind === 'available'
        && Boolean(options?.windowTarget || target?.kind === 'session' || (facts?.active && options?.sourceTabId) || (active && target));
    const presentationAction = !phone && (target?.kind === 'session' || options?.windowTarget?.kind === 'session') ? options?.presentationAction : undefined;
    const factsRef = React.useRef(facts);
    factsRef.current = facts;
    const open = React.useCallback((mode: WorkspaceOpenMode) => (href ? openInWorkspace(factsRef.current?.read() ?? null, href, mode, undefined, onOpened) : false), [href, onOpened]);
    const items = React.useMemo((): readonly (DropdownMenuItem & Readonly<{ icon: React.ReactElement }>)[] => (phone ? [
        { id: WORKSPACE_OPEN_IN_NEW_TAB_ID, testID: 'workspace-open-new-tab', title: t('workspaceBar.openInNewTab'),
            icon: <Icon name="plus" size={16} color={theme.colors.text.secondary} /> },
    ] : active ? [
        { id: WORKSPACE_OPEN_IN_NEW_TAB_ID, testID: 'workspace-open-new-tab', title: t('workspaceBar.openInNewTab'),
            icon: <Icon name="plus" size={16} color={theme.colors.text.secondary} /> },
        { id: WORKSPACE_OPEN_TO_RIGHT_ID, testID: 'workspace-open-right', title: t('workspaceBar.openToRight'),
            icon: <Icon name="square-split-horizontal" size={16} color={theme.colors.text.secondary} /> },
        { id: WORKSPACE_OPEN_BELOW_ID, testID: 'workspace-open-below', title: t('workspaceBar.openBelow'),
            icon: <Icon name="square-split-vertical" size={16} color={theme.colors.text.secondary} /> },
    ] : []), [active, phone, theme.colors.text.secondary]);
    const presentationItems = React.useMemo((): readonly (DropdownMenuItem & Readonly<{ icon: React.ReactElement }>)[] => [
        ...(canOpenWindow ? [{ id: WORKSPACE_OPEN_IN_WINDOW_ID, testID: 'workspace-open-window', title: t('workspaceBar.openInWindow'),
            icon: <Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} /> }] : []),
        ...(presentationAction ? [presentationAction.item] : []),
    ], [canOpenWindow, presentationAction, theme.colors.text.secondary]);
    const allItems = React.useMemo(() => [...items, ...presentationItems], [items, presentationItems]);
    const select = React.useCallback((itemId: string) => {
        if (presentationAction?.item.id === itemId) { presentationAction.onSelect(); return true; }
        switch (itemId) {
            case WORKSPACE_OPEN_IN_NEW_TAB_ID: open('newTab'); return true;
            case WORKSPACE_OPEN_TO_RIGHT_ID: open('splitRight'); return true;
            case WORKSPACE_OPEN_BELOW_ID: open('splitDown'); return true;
            case WORKSPACE_OPEN_IN_WINDOW_ID: {
                const workspace = factsRef.current?.read();
                if (!canOpenWindow) return false;
                const tabId = options?.sourceTabId ?? (href ? workspace?.findOpenHref?.(href)?.tabId : undefined);
                const scope = workspace?.desktopPresentation;
                const windowTarget = options?.windowTarget ?? (scope && tabId
                    ? { kind: 'workspaceTab' as const, serverId: scope.serverId, accountId: scope.accountId,
                        ...(scope.layoutId ? { layoutId: scope.layoutId } : {}), tabId }
                    : scope && href ? { kind: 'destination' as const, serverId: scope.serverId, accountId: scope.accountId,
                        ...(scope.layoutId ? { layoutId: scope.layoutId } : {}), href } : null);
                const sessionTarget = options?.windowTarget?.kind === 'session' ? options.windowTarget
                    : !options?.windowTarget && target?.kind === 'session' ? {
                        sessionId: target.params.id, serverId: target.params.serverId,
                    } : null;
                const request = sessionTarget ? { actionId: 'session.open' as const, input: {
                    sessionId: sessionTarget.sessionId, ...(sessionTarget.serverId ? { serverId: sessionTarget.serverId } : {}),
                    ...('destination' in sessionTarget && sessionTarget.destination ? { destination: sessionTarget.destination } : {}),
                    ...(tabId ? { tabId } : {}), presentation: 'window',
                } } : windowTarget ? { actionId: 'desktop.windows.open' as const, input: { target: windowTarget } } : null;
                if (!request) return false;
                // The window lifecycle moves presentation while retaining membership. `onOpened`
                // belongs to the existing tab/split handoff and must not close a moved pane tab.
                fireAndForget(executeWorkspaceUiAction(request, approvalHref => {
                    const group = workspace?.state.groups[workspace.state.focusedGroupId];
                    const navigation = group ? workspace?.navigationForTab(group.activeTabId) : null;
                    if (navigation) (navigation.pushRetainingCurrent ?? navigation.push)(approvalHref);
                    else router.push(approvalHref);
                }), { tag: 'Workspace.openWindow' });
                return true;
            }
            default: return false;
        }
    }, [canOpenWindow, href, open, options?.sourceTabId, options?.windowTarget, presentationAction, router, target]);
    return React.useMemo(() => ({ items: allItems, presentationItems, select, open }), [allItems, open, presentationItems, select]);
}
