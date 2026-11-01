import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { SessionRightPanel } from './SessionRightPanel';
import { SessionBottomPanel } from './bottom/SessionBottomPanel';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { SessionActionRail } from './SessionActionRail';
import { resolveSessionPaneScopeId } from './sessionPaneScopeId';

type SessionPaneScopedProps = Readonly<{ sessionId: string; scopeId: string }>;

export function useRegisterSessionPaneDriver(sessionId: string): string {
    const scopeId = React.useMemo(() => resolveSessionPaneScopeId(sessionId), [sessionId]);
    const paneCtx = useOptionalAppPaneContext();
    const registerDriver = paneCtx?.registerDriver ?? null;

    React.useEffect(() => {
        if (!registerDriver) return;
        const driver: PaneDriver = {
            scopeId,
            renderActionRail: () => React.createElement(SessionActionRail, { sessionId, scopeId }),
            renderRightPane: () => React.createElement(SessionRightPanel, { sessionId, scopeId }),
            renderDetailsPane: () => React.createElement(SessionDetailsPanel, { sessionId, scopeId }),
            renderBottomPane: () => React.createElement(SessionBottomPanel, { sessionId, scopeId }),
        };
        return registerDriver(driver);
    }, [registerDriver, scopeId, sessionId]);

    return scopeId;
}
