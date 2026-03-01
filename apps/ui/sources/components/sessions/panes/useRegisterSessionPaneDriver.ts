import * as React from 'react';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { SessionPaneLazyLoader, type SessionPaneLazyLoaderProps } from './SessionPaneLazyLoader';

type SessionPaneScopedProps = Readonly<{ sessionId: string; scopeId: string }>;

const LazySessionRightPanel = React.memo((props: SessionPaneScopedProps) => {
    const load = React.useCallback(async () => {
        const mod = await import('./SessionRightPanel');
        return mod.SessionRightPanel as React.ComponentType<SessionPaneScopedProps>;
    }, []);
    const Loader = SessionPaneLazyLoader as unknown as React.ComponentType<SessionPaneLazyLoaderProps<SessionPaneScopedProps>>;
    return React.createElement(Loader, { testID: 'session-right-pane-module-loading', load, props });
});

const LazySessionDetailsPanel = React.memo((props: SessionPaneScopedProps) => {
    const load = React.useCallback(async () => {
        const mod = await import('./SessionDetailsPanel');
        return mod.SessionDetailsPanel as React.ComponentType<SessionPaneScopedProps>;
    }, []);
    const Loader = SessionPaneLazyLoader as unknown as React.ComponentType<SessionPaneLazyLoaderProps<SessionPaneScopedProps>>;
    return React.createElement(Loader, { testID: 'session-details-pane-module-loading', load, props });
});

export function useRegisterSessionPaneDriver(sessionId: string): string {
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const { registerDriver } = useAppPaneContext();

    React.useEffect(() => {
        const driver: PaneDriver = {
            scopeId,
            renderRightPane: () => React.createElement(LazySessionRightPanel, { sessionId, scopeId }),
            renderDetailsPane: () => React.createElement(LazySessionDetailsPanel, { sessionId, scopeId }),
        };
        return registerDriver(driver);
    }, [registerDriver, scopeId, sessionId]);

    return scopeId;
}
