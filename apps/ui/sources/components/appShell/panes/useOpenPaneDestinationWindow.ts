import * as React from 'react';
import { useWorkspaceRouterFacts } from '../workspace/WorkspaceNavigationContext';
import { useRouter } from '../workspace/destinationRoute';
import { executeWorkspaceUiAction } from '../workspace/workspaceActionRuntime';
import type { PluginSurfaceOpenOutcome } from '@/components/plugins/surfaces/openPluginSurface';
import type { PaneTabAddress } from '@happier-dev/protocol/actions';
import { AppPaneContext } from './AppPaneContext';
import { findSelectedPaneSlot, restorePaneDestinationSelection } from './model/selectedPaneDestination';
import { resolvePaneTabWindowTarget } from './paneTabWindowTransfer';
import { retargetDesktopPaneWindow } from '@/desktop/window/appWindowRuntime';
import { useWorkspaceOpenActions } from '../workspace/useWorkspaceOpenActions';
import { selectedPaneDestinationTabKey, type SelectedPaneSlot } from './model/selectedPaneDestination';
import { useDesktopAppWindowRecord } from '@/desktop/window/AppWindowRecordContext';
import type { AppWindowRecord } from '@/desktop/window/appWindowBoot';

/** Recipient commands retain the addressed pane's source layout. */
export function resolvePaneDestinationWindowAddress(
    presentation: Readonly<{ serverId: string; accountId: string; layoutId?: string }> | undefined,
    record: AppWindowRecord | null,
    scopeId: string,
    tabKey: string,
): PaneTabAddress | null {
    if (record?.selectedAddress.kind === 'paneTab' && record.selectedAddress.scopeId === scopeId) {
        return { kind: 'paneTab', serverId: record.homeId, accountId: record.accountId,
            layoutId: record.selectedAddress.layoutId, scopeId, tabKey };
    }
    return presentation?.layoutId ? { kind: 'paneTab', serverId: presentation.serverId, accountId: presentation.accountId,
        layoutId: presentation.layoutId, scopeId, tabKey } : null;
}

/** Slot headers consume the same Open menu and Action as workspace and Details tabs. */
export function usePaneDestinationWindowActions(scopeId: string | null | undefined, slot: SelectedPaneSlot) {
    const facts = useWorkspaceRouterFacts();
    const record = useDesktopAppWindowRecord();
    const presentation = facts?.read()?.desktopPresentation;
    const target = React.useMemo<PaneTabAddress | undefined>(() => scopeId && !facts?.hasPhone
        ? resolvePaneDestinationWindowAddress(presentation, record, scopeId, selectedPaneDestinationTabKey(slot)) ?? undefined
        : undefined, [facts?.hasPhone, presentation?.accountId, presentation?.layoutId, presentation?.serverId, record, scopeId, slot]);
    return useWorkspaceOpenActions(null, undefined, { windowTarget: target });
}

/** Every pane window request enters the shared Action executor with its actual scoped address. */
export function useOpenPaneDestinationWindow() {
    const facts = useWorkspaceRouterFacts();
    const router = useRouter();
    const paneSubscription = React.useContext(AppPaneContext);
    const record = useDesktopAppWindowRecord();
    const latest = React.useRef({ facts, record });
    latest.current = { facts, record };
    return React.useCallback(async (scopeId: string, tabKey: string, commitSelection?: () => void): Promise<PluginSurfaceOpenOutcome> => {
        const address = resolvePaneDestinationWindowAddress(latest.current.facts?.read()?.desktopPresentation,
            latest.current.record, scopeId, tabKey);
        if (!address) return { ok: false, code: 'unavailable', reason: 'desktop_window_owner_unavailable' };
        const context = paneSubscription?.getSnapshot();
        const scope = context?.getReadState().scopes[scopeId];
        const placed = scope && (findSelectedPaneSlot(scope, tabKey)?.presentation ?? scope.details.tabsByKey[tabKey]?.presentation);
        if (placed) {
            const rollback: { selection?: () => void } = {};
            try {
                const accepted = await retargetDesktopPaneWindow(address, () => {
                    const before = paneSubscription?.getSnapshot().getReadState().scopes[scopeId];
                    if (before && commitSelection) rollback.selection = () => {
                        const current = paneSubscription?.getSnapshot();
                        const currentScope = current?.getReadState().scopes[scopeId];
                        if (current && currentScope) current.dispatch({ type: 'restoreScope', scopeId, selectedPaneTabKey: tabKey,
                            scope: restorePaneDestinationSelection(currentScope, before, tabKey) });
                    };
                    commitSelection?.();
                    const current = paneSubscription?.getSnapshot();
                    return current ? resolvePaneTabWindowTarget(current, address) : null;
                });
                if (!accepted) rollback.selection?.();
                return accepted ? { ok: true } : { ok: false, code: 'unavailable', reason: 'desktop_window_retarget_cancelled' };
            } catch {
                rollback.selection?.();
                return { ok: false, code: 'unavailable', reason: 'desktop_window_retarget_failed' };
            }
        }
        commitSelection?.();
        const target = context ? resolvePaneTabWindowTarget(context, address) : address;
        if (!target) return { ok: false, code: 'unavailable', reason: 'desktop_window_pane_unavailable' };
        const result = await executeWorkspaceUiAction({ actionId: 'desktop.windows.open', input: { target } }, href => router.push(href));
        if (result.ok && result.result && typeof result.result === 'object' && 'status' in result.result
            && (result.result.status === 'opened' || result.result.status === 'focused')) return { ok: true };
        return { ok: false, code: 'unavailable', reason: 'desktop_window_open_unavailable' };
    }, [paneSubscription, router]);
}
