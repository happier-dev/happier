import * as React from 'react';
import type { DesktopWindowsOpenInput } from '@happier-dev/protocol/actions/actionSpecs';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { listenDesktopHostEvent, useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';
import { closeDesktopWindow } from '@/utils/platform/desktopWindowBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { resolveDesktopWindowContext } from './isDesktopAuxiliaryWindowContext';

export const DESKTOP_NEW_WINDOW_REQUESTED_EVENT = 'desktop_new_window_requested';

/** Menu, Search and opaque current-UI commands consume the same mounted controls. */
export function useDesktopAppWindowCommands(openWindow: (input: DesktopWindowsOpenInput) => Promise<boolean>) {
    const availability = useDesktopHostRoleAvailability('windows');
    const authority = useActiveServerAccountScopeLifetime();
    const available = availability?.kind === 'available' && resolveDesktopWindowContext().chrome === 'full';
    const openNewWindow = React.useCallback(async () => {
        if (!authority) return false;
        return openWindow({ chrome: 'full', target: { kind: 'home',
            serverId: authority.scope.serverId, accountId: authority.scope.accountId } });
    }, [authority, openWindow]);
    const commands = useCurrentUiContextLocalCommands(available ? [
        { key: 'new-window', title: t('common.newWindow'), invoke: openNewWindow },
        { key: 'close-window', title: t('common.closeWindow'), invoke: closeDesktopWindow },
    ] : []);
    React.useEffect(() => {
        if (!available) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        fireAndForget(listenDesktopHostEvent(DESKTOP_NEW_WINDOW_REQUESTED_EVENT, () => {
            fireAndForget(openNewWindow(), { tag: 'DesktopAppWindowCommands.newWindow' });
        }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }), { tag: 'DesktopAppWindowCommands.listen' });
        return () => { disposed = true; stop?.(); };
    }, [available, openNewWindow]);
    const open = React.useCallback(async (): Promise<void> => { await commands.invoke('new-window'); }, [commands]);
    return React.useMemo(() => ({ available, open }), [available, open]);
}
