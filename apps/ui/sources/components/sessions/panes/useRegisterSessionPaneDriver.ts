import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { SessionPaneLazyLoader, type SessionPaneLazyLoaderProps } from './SessionPaneLazyLoader';

type SessionPaneScopedProps = Readonly<{ sessionId: string; scopeId: string }>;

type SessionPaneComponent = React.ComponentType<SessionPaneScopedProps>;

let rightPaneImpl: SessionPaneComponent | null = null;
let rightPanePromise: Promise<SessionPaneComponent> | null = null;
let detailsPaneImpl: SessionPaneComponent | null = null;
let detailsPanePromise: Promise<SessionPaneComponent> | null = null;

function loadRightPaneModule(): Promise<SessionPaneComponent> {
    if (rightPaneImpl) return Promise.resolve(rightPaneImpl);
    if (!rightPanePromise) {
        rightPanePromise = import('./SessionRightPanel')
            .then((mod) => {
                rightPaneImpl = mod.SessionRightPanel as SessionPaneComponent;
                return rightPaneImpl;
            })
            .catch((error) => {
                rightPanePromise = null;
                throw error;
            });
    }
    return rightPanePromise;
}

function loadDetailsPaneModule(): Promise<SessionPaneComponent> {
    if (detailsPaneImpl) return Promise.resolve(detailsPaneImpl);
    if (!detailsPanePromise) {
        detailsPanePromise = import('./SessionDetailsPanel')
            .then((mod) => {
                detailsPaneImpl = mod.SessionDetailsPanel as SessionPaneComponent;
                return detailsPaneImpl;
            })
            .catch((error) => {
                detailsPanePromise = null;
                throw error;
            });
    }
    return detailsPanePromise;
}

function prefetchSessionPaneModules(): void {
    void loadRightPaneModule().catch(() => {});
    void loadDetailsPaneModule().catch(() => {});
}

const LazySessionRightPanel = React.memo((props: SessionPaneScopedProps) => {
    const load = React.useCallback(async () => {
        return loadRightPaneModule();
    }, []);
    const Loader = SessionPaneLazyLoader as unknown as React.ComponentType<SessionPaneLazyLoaderProps<SessionPaneScopedProps>>;
    return React.createElement(Loader, { testID: 'session-right-pane-module-loading', load, props });
});

const LazySessionDetailsPanel = React.memo((props: SessionPaneScopedProps) => {
    const load = React.useCallback(async () => {
        return loadDetailsPaneModule();
    }, []);
    const Loader = SessionPaneLazyLoader as unknown as React.ComponentType<SessionPaneLazyLoaderProps<SessionPaneScopedProps>>;
    return React.createElement(Loader, { testID: 'session-details-pane-module-loading', load, props });
});

export function useRegisterSessionPaneDriver(sessionId: string): string {
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const paneCtx = useOptionalAppPaneContext();
    const registerDriver = paneCtx?.registerDriver ?? null;
    const canRegister = Boolean(registerDriver);

    React.useEffect(() => {
        if (!canRegister) return;
        prefetchSessionPaneModules();
    }, [canRegister]);

    React.useEffect(() => {
        if (!registerDriver) return;
        const driver: PaneDriver = {
            scopeId,
            renderRightPane: () => React.createElement(LazySessionRightPanel, { sessionId, scopeId }),
            renderDetailsPane: () => React.createElement(LazySessionDetailsPanel, { sessionId, scopeId }),
        };
        return registerDriver(driver);
    }, [registerDriver, scopeId, sessionId]);

    return scopeId;
}
