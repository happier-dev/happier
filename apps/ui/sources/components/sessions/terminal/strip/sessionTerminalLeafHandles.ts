import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

/**
 * The verbs only a mounted terminal view can perform (copy its selection, paste, clear, restart). The
 * pane's tab menu reaches the visible tab's terminals through these; a tab that is not on screen has
 * no mounted view, so its menu offers only the layout verbs.
 */
export type SessionTerminalLeafHandle = Readonly<{
    find?: (() => void) | null;
    copySelection: (() => void) | null;
    paste: () => void;
    clear: () => void;
    restart: (context?: ActionExecutorContext) => void;
}>;

export type SessionTerminalLeafHandles = Readonly<{
    register: (terminalId: string, handle: SessionTerminalLeafHandle) => () => void;
    get: (terminalId: string) => SessionTerminalLeafHandle | null;
}>;

type MountedLeafHandle = Readonly<{ presentationId: string | undefined; handle: SessionTerminalLeafHandle }>;

const handlesByScope = new Map<string, Map<string, Set<MountedLeafHandle>>>();

/** Bind local view commands to their presentation; process-level Actions may use any mounted view. */
export function createSessionTerminalLeafHandles(scopeId: string, presentationId?: string): SessionTerminalLeafHandles {
    const read = () => handlesByScope.get(scopeId);
    return {
        register: (terminalId, handle) => {
            const handles = read() ?? new Map<string, Set<MountedLeafHandle>>();
            handlesByScope.set(scopeId, handles);
            const views = handles.get(terminalId) ?? new Set<MountedLeafHandle>();
            const mounted = { presentationId, handle };
            views.add(mounted);
            handles.set(terminalId, views);
            return () => {
                views.delete(mounted);
                if (views.size === 0 && handles.get(terminalId) === views) handles.delete(terminalId);
                if (handles.size === 0 && handlesByScope.get(scopeId) === handles) handlesByScope.delete(scopeId);
            };
        },
        get: (terminalId) => {
            let selected: SessionTerminalLeafHandle | null = null;
            for (const view of read()?.get(terminalId) ?? []) {
                if (presentationId === undefined || view.presentationId === presentationId) selected = view.handle;
            }
            return selected;
        },
    };
}
