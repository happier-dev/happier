import * as React from 'react';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { Platform } from 'react-native';

import { UniversalSearchController } from '@/components/appShell/search/UniversalSearchController';
import { useUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { resolveUniversalSearchRouteInitialScope } from '@/components/appShell/search/universalSearchScope';
import { TERMINAL_JUMP_ROUTE_PARAM } from '@/components/sessions/terminal/jump/terminalJumpTarget';

type UniversalSearchRouteParams = { q?: string | string[]; source?: string | string[]; sessionId?: string | string[]; accountId?: string | string[]; serverId?: string | string[]; machineId?: string | string[]; rootPath?: string | string[]; replace?: string | string[]; [TERMINAL_JUMP_ROUTE_PARAM]?: string | string[] };

function readRouteSource(source: UniversalSearchRouteParams['source']) {
    return source === 'fileContent' || source === 'files' || source === 'symbols' ? source : undefined;
}

function readRouteTerminalJump(params: UniversalSearchRouteParams) {
    const scopeId = params[TERMINAL_JUMP_ROUTE_PARAM];
    return typeof scopeId === 'string' && scopeId.length > 0 ? { scopeId } : undefined;
}

/** Native presents Search as this route: the transparent overlay (`universalSearchRoutePresentation`). */
function UniversalSearchNativeRoute(): React.ReactElement {
    const router = useRouter();
    const params = useGlobalSearchParams<UniversalSearchRouteParams>();
    const runtime = useUniversalSearchRuntime();
    const symbols = runtime.routeSymbols;
    const initialQuery = typeof params.q === 'string' ? params.q : '';
    const initialSource = readRouteSource(params.source);
    const initialReplace = params.replace === '1' && initialSource === 'fileContent';
    const activeSessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
    const initialScope = React.useMemo(() => resolveUniversalSearchRouteInitialScope(params), [params]);
    const terminalJump = React.useMemo(() => readRouteTerminalJump(params), [params]);
    const commands = React.useMemo(
        () => runtime.buildCommands(activeSessionId, initialScope ?? undefined, symbols),
        [activeSessionId, initialScope, runtime, symbols],
    );
    const close = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/' as never);
    }, [router]);
    return (
        <UniversalSearchController
            commands={commands}
            symbols={symbols}
            initialQuery={initialQuery}
            initialSource={initialSource}
            initialReplace={initialReplace}
            activeSessionId={activeSessionId}
            initialScope={initialScope}
            terminalJump={terminalJump}
            presentation="route"
            onRequestClose={close}
        />
    );
}

/**
 * On the web Search is one surface, the modal over the shell that the shortcut and the rail open. A link
 * to `/search` hands its query and scope to that modal and leaves, so closing it returns to the shell.
 */
function UniversalSearchWebLink(): null {
    const router = useRouter();
    const params = useGlobalSearchParams<UniversalSearchRouteParams>();
    const runtime = useUniversalSearchRuntime();
    const handedOver = React.useRef(false);
    React.useEffect(() => {
        if (handedOver.current) return;
        handedOver.current = true;
        const source = readRouteSource(params.source);
        const terminals = readRouteTerminalJump(params);
        runtime.open(typeof params.q === 'string' && params.q ? params.q : undefined, resolveUniversalSearchRouteInitialScope(params), {
            ...(source ? { source } : {}),
            ...(params.replace === '1' && source === 'fileContent' ? { replace: true } : {}),
            ...(terminals ? { terminals } : {}),
        });
        if (router.canGoBack()) router.back();
        else router.replace('/' as never);
    }, [params, router, runtime]);
    return null;
}

export default function UniversalSearchRoute(): React.ReactElement | null {
    return Platform.OS === 'web' ? <UniversalSearchWebLink /> : <UniversalSearchNativeRoute />;
}
