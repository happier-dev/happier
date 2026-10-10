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

const handlesByScope = new Map<string, Map<string, Set<SessionTerminalLeafHandle>>>();

export function createSessionTerminalLeafHandles(scopeId: string): SessionTerminalLeafHandles {
    const read = () => handlesByScope.get(scopeId);
    return {
        register: (terminalId, handle) => {
            const handles = read() ?? new Map<string, Set<SessionTerminalLeafHandle>>();
            handlesByScope.set(scopeId, handles);
            const views = handles.get(terminalId) ?? new Set<SessionTerminalLeafHandle>();
            views.add(handle);
            handles.set(terminalId, views);
            return () => {
                views.delete(handle);
                if (views.size === 0 && handles.get(terminalId) === views) handles.delete(terminalId);
                if (handles.size === 0 && handlesByScope.get(scopeId) === handles) handlesByScope.delete(scopeId);
            };
        },
        get: (terminalId) => Array.from(read()?.get(terminalId) ?? []).at(-1) ?? null,
    };
}
