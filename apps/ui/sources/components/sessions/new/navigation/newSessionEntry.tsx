import * as React from 'react';
import { router as appRouter, type Href, type Router } from 'expo-router';

import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSetting, useActiveServerAccountScope } from '@/sync/store/hooks';
import { useResolveNewSessionOrdinaryEntryRoute } from './newSessionOrdinaryEntryRoute';
import { newSessionBackgroundLaunches } from '@/components/sessions/new/modules/newSessionBackgroundLaunches';
import { useNewSessionEmbeddedHostState } from './useNewSessionEmbeddedHostState';
import type { NewSessionEmbeddedHost, NewSessionHostParams } from './newSessionHost';

export type NewSessionShellHost = Readonly<{
    enabled: boolean;
    host: NewSessionEmbeddedHost;
    /**
     * Open and on the screen that opened it. The dock belongs to that screen: another screen hides it (its draft
     * and fold are kept) and returning shows it again. `open` from another screen moves it there.
     */
    visible: boolean;
    /**
     * The open dock folded to its pill, in the same seat (desktop). Host state, not a setting: it lives as
     * long as the shell, survives page navigation, and every New entry (`open`) unfolds it.
     */
    collapsed: boolean;
    focusRequest: number;
    /**
     * The control that opened the dock, for this open only: the dock seats in the page pane that holds it. Entries
     * from outside a page pane (the sidebar's New, the shortcut, Home) carry none and keep the page's main column.
     */
    origin: unknown;
    open: (params?: NewSessionHostParams, forceFresh?: boolean, origin?: unknown) => void;
    close: () => void;
    collapse: () => void;
    returnToHost: (draftId: string, patch: Readonly<Record<string, unknown>>) => boolean;
}>;

const ShellHostContext = React.createContext<NewSessionShellHost | null>(null);
// The imperative seed/Action adapters share the mounted shell's entry owner.
// This is one UI entry port, retired with its provider, never a draft or focus registry.
let shellEntry: ((href: Href, origin?: unknown) => boolean) | null = null;

export function interceptNewSessionEntry(href: Href, origin?: unknown): boolean {
    return shellEntry?.(href, origin) ?? false;
}

function entryParams(href: Href): NewSessionHostParams | null {
    if (typeof href === 'string') {
        if (href !== '/new' && !href.startsWith('/new?')) return null;
        const query = href.indexOf('?');
        return query < 0 ? {} : Object.fromEntries(new URLSearchParams(href.slice(query + 1)));
    }
    if (href.pathname !== '/new') return null;
    return Object.fromEntries(Object.entries(href.params ?? {}).map(([key, value]) => [
        key, value === undefined ? undefined : Array.isArray(value) ? value.map(String) : String(value),
    ]));
}

export function NewSessionShellHostProvider(props: React.PropsWithChildren) {
    const mode = useSetting('newSessionPresentationModeV1');
    const scope = useActiveServerAccountScope();
    const { host: embeddedHost, replaceParams, markDemanded } = useNewSessionEmbeddedHostState(undefined, { renewOnHandOff: true });
    const resolveOrdinaryEntry = useResolveNewSessionOrdinaryEntryRoute();
    const [visible, setVisible] = React.useState(false);
    const [collapsed, setCollapsed] = React.useState(false);
    const [focusRequest, setFocusRequest] = React.useState(0);
    const [origin, setOrigin] = React.useState<unknown>(null);
    const pathname = usePathname();
    const pathnameRef = React.useRef(pathname);
    pathnameRef.current = pathname;
    const [screen, setScreen] = React.useState<string | null>(null);
    const enabled = mode === 'docked';
    const close = React.useCallback(() => {
        setVisible(false);
        setCollapsed(false);
        newSessionBackgroundLaunches.dismiss();
    }, []);
    const collapse = React.useCallback(() => setCollapsed(true), []);
    const open = React.useCallback((params?: NewSessionHostParams, forceFresh = false, opener?: unknown) => {
        const seededParams = params && Object.keys(params).length > 0 ? params : undefined;
        if (enabled) {
            // New again focuses the current document; seeded entries and Start another
            // explicitly select a document. Page navigation never reaches this branch.
            if (seededParams || !visible || forceFresh) {
                const ordinary = seededParams ? null : resolveOrdinaryEntry({ forceFresh });
                const entry = seededParams ?? { draftId: ordinary!.draftId, draftOrigin: ordinary!.draftOrigin };
                replaceParams({ ...(scope ? { draftServerId: scope.serverId, draftAccountId: scope.accountId } : {}), ...entry });
            }
            markDemanded();
            setOrigin(opener ?? null);
            setScreen(pathnameRef.current);
            setVisible(true);
            setCollapsed(false);
            setFocusRequest((request) => request + 1);
            return;
        }
        const entry = resolveOrdinaryEntry({ forceFresh });
        appRouter.push({ pathname: '/new', params: seededParams ?? { draftId: entry.draftId, draftOrigin: entry.draftOrigin } });
    }, [enabled, markDemanded, replaceParams, resolveOrdinaryEntry, scope, visible]);
    const returnToHost = React.useCallback((draftId: string, patch: Readonly<Record<string, unknown>>) => {
        if (!visible || embeddedHost.params.draftId !== draftId) return false;
        embeddedHost.setParams(patch);
        return true;
    }, [embeddedHost.params.draftId, embeddedHost.setParams, visible]);
    const onHandedOff = React.useCallback((destination: Href, outcome?: Readonly<{ opened: boolean }>) => {
        embeddedHost.onHandedOff(destination);
        if (outcome?.opened) setCollapsed(true);
        else if (typeof destination === 'string') newSessionBackgroundLaunches.presented(destination);
    }, [embeddedHost.onHandedOff]);
    const host = React.useMemo<NewSessionEmbeddedHost>(() => ({ ...embeddedHost,
        kind: 'docked', createdSessionPresentation: 'inPlace', onHandedOff,
    }), [embeddedHost, onHandedOff]);
    const shown = enabled && visible && screen === pathname;
    const value = React.useMemo<NewSessionShellHost>(() => ({ enabled, host, visible: shown, collapsed, focusRequest, origin, open, close, collapse, returnToHost }),
        [host, enabled, shown, collapsed, focusRequest, origin, open, close, collapse, returnToHost] as const);
    React.useLayoutEffect(() => close(), [scope?.serverId, scope?.accountId, close]);
    // Provider retirement also retires the only imperative entry port.
    React.useLayoutEffect(() => {
        const entry = (href: Href, opener?: unknown) => {
            if (!enabled) return false;
            const params = entryParams(href);
            if (params === null) return false;
            open(params, false, opener);
            return true;
        };
        shellEntry = entry;
        return () => { if (shellEntry === entry) shellEntry = null; };
    }, [enabled, open]);
    return <ShellHostContext.Provider value={value}>{props.children}</ShellHostContext.Provider>;
}

export function useNewSessionShellHost(): NewSessionShellHost | null { return React.useContext(ShellHostContext); }

export function useNewSessionPickerReturnHost(): NewSessionShellHost['returnToHost'] | null {
    return React.useContext(ShellHostContext)?.returnToHost ?? null;
}

export function useNewSessionEntryRouter(): ReturnType<typeof useRouter> {
    const router = useRouter();
    const shell = React.useContext(ShellHostContext);
    return React.useMemo(() => ({ ...router,
        push: ((href, options) => { if (!interceptNewSessionEntry(href)) router.push(href, options); }) as Router['push'],
        replace: ((href, options) => { if (!interceptNewSessionEntry(href)) router.replace(href, options); }) as Router['replace'],
    }), [router, shell?.open]);
}

export function useOpenNewSession(): (options?: Readonly<{ forceFresh?: boolean }>) => void {
    const shell = React.useContext(ShellHostContext);
    const router = useRouter();
    const resolveOrdinaryEntry = useResolveNewSessionOrdinaryEntryRoute();
    return React.useCallback((options) => {
        if (shell?.enabled) { shell.open(undefined, options?.forceFresh); return; }
        const { draftId, draftOrigin } = resolveOrdinaryEntry(options);
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveOrdinaryEntry, router, shell]);
}
