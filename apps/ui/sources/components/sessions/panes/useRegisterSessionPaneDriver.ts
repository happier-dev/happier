import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { SessionRightPanel } from './SessionRightPanel';
import { SessionBottomPanel } from './bottom/SessionBottomPanel';
import { SessionDetailsPanel } from './SessionDetailsPanel';

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
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const paneCtx = useOptionalAppPaneContext();
    const registerDriver = paneCtx?.registerDriver ?? null;
    const canRegister = Boolean(registerDriver);

    React.useEffect(() => {
        if (!canRegister) return;
        void prefetchSessionPaneModules();
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
