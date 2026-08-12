import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { SessionRightPanel } from './SessionRightPanel';
import { SessionBottomPanel } from './bottom/SessionBottomPanel';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { resolveSessionPaneScopeId } from './sessionPaneScopeId';

type SessionPaneScopedProps = Readonly<{ sessionId: string; scopeId: string }>;

export async function loadSessionSubagentDetailsModule(): Promise<void> {
    await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
}

export const sessionPaneModulePrefetchLoaders: Array<() => Promise<void>> = [
    loadSessionSubagentDetailsModule,
];

export async function prefetchSessionPaneModules(): Promise<void> {
    await Promise.all(sessionPaneModulePrefetchLoaders.map((loadModule) => loadModule()));
}

export function useRegisterSessionPaneDriver(sessionId: string): string {
    const scopeId = React.useMemo(() => resolveSessionPaneScopeId(sessionId), [sessionId]);
    const paneCtx = useOptionalAppPaneContext();
    const registerDriver = paneCtx?.registerDriver ?? null;
    const canRegister = Boolean(registerDriver);

    React.useEffect(() => {
        if (!canRegister) return;
        // Defer prefetch so it does not compete with session content rendering.
        // The SessionSubagentDetailsView bundle is 6MB compressed / 35MB uncompressed;
        // fetching it immediately on mount causes a ~1.3s V8 parse freeze that blocks
        // the first paint of transcript items. Delaying by 3s lets the transcript render
        // and become interactive before the bundle download and parse begin.
        const timer = setTimeout(() => {
            void prefetchSessionPaneModules();
        }, 3000);
        return () => clearTimeout(timer);
    }, [canRegister]);

    React.useEffect(() => {
        if (!registerDriver) return;
        const driver: PaneDriver = {
            scopeId,
            renderRightPane: () => React.createElement(SessionRightPanel, { sessionId, scopeId }),
            renderDetailsPane: () => React.createElement(SessionDetailsPanel, { sessionId, scopeId }),
            renderBottomPane: () => React.createElement(SessionBottomPanel, { sessionId, scopeId }),
        };
        return registerDriver(driver);
    }, [registerDriver, scopeId, sessionId]);

    return scopeId;
}
