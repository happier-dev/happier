import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { desktopHostKind, getDesktopHostWindowLabel, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { resolveDesktopWindowContext } from './isDesktopAuxiliaryWindowContext';
import { fireAndForget } from '@/utils/system/fireAndForget';

type HomeResponder = Readonly<{ homeId: string; accountId: string; windowId: string }>;

/** Tauri live-window order selects the responder; other hosts retain their primary realm. */
export function useDesktopHomeResponder(): boolean {
    const scope = useActiveServerAccountScope();
    const context = resolveDesktopWindowContext();
    const multiwindow = desktopHostKind() === 'tauri';
    const [responders, setResponders] = React.useState<readonly HomeResponder[]>([]);
    React.useEffect(() => {
        if (!multiwindow || context.role === 'presenter' || context.chrome !== 'full') return;
        let current = true;
        let published = false;
        let stop: (() => void) | undefined;
        fireAndForget((async () => {
            stop = await listenDesktopHostEvent<readonly HomeResponder[]>('desktopAppWindow://responders', snapshot => {
                published = true;
                if (current) setResponders(snapshot);
            });
            if (!current) { stop(); return; }
            const snapshot = await invokeDesktopHost<readonly HomeResponder[]>('desktop_app_window_responders',
                context.role === 'primary' ? { homeId: scope?.serverId ?? null, accountId: scope?.accountId ?? null } : undefined);
            if (current && !published) setResponders(snapshot);
        })(), { tag: 'desktop.homeResponder' });
        return () => { current = false; stop?.(); };
    }, [multiwindow, context.role, context.chrome, scope?.serverId, scope?.accountId]);
    if (!multiwindow) return context.role === 'primary';
    if (!scope) return false;
    const windowId = getDesktopHostWindowLabel()?.replace(/^destination_/u, '');
    return responders.some(responder => responder.homeId === scope.serverId && responder.accountId === scope.accountId
        && responder.windowId === windowId);
}
