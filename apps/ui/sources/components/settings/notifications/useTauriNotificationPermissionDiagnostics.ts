import * as React from 'react';

import {
    isPermissionGranted,
    requestPermission,
} from '@/activity/notifications/channels/tauriNotificationPlugin';

export type TauriNotificationPermissionDiagnosticsStatus =
    | 'checking'
    | 'granted'
    | 'notGranted'
    | 'error';

export function useTauriNotificationPermissionDiagnostics(enabled: boolean): Readonly<{
    status: TauriNotificationPermissionDiagnosticsStatus;
    requestPermission: () => Promise<void>;
}> {
    const [status, setStatus] = React.useState<TauriNotificationPermissionDiagnosticsStatus>(
        enabled ? 'checking' : 'notGranted',
    );

    const refresh = React.useCallback(async () => {
        if (!enabled) {
            setStatus('notGranted');
            return;
        }

        setStatus('checking');
        try {
            setStatus((await isPermissionGranted()) ? 'granted' : 'notGranted');
        } catch {
            setStatus('error');
        }
    }, [enabled]);

    React.useEffect(() => {
        let cancelled = false;

        const run = async () => {
            if (!enabled) {
                setStatus('notGranted');
                return;
            }

            setStatus('checking');
            try {
                const granted = await isPermissionGranted();
                if (!cancelled) {
                    setStatus(granted ? 'granted' : 'notGranted');
                }
            } catch {
                if (!cancelled) {
                    setStatus('error');
                }
            }
        };

        void run();

        return () => {
            cancelled = true;
        };
    }, [enabled]);

    const requestDesktopPermission = React.useCallback(async () => {
        if (!enabled) {
            setStatus('notGranted');
            return;
        }

        setStatus('checking');
        try {
            const next = await requestPermission();
            setStatus(next === 'granted' ? 'granted' : 'notGranted');
        } catch {
            setStatus('error');
            return;
        }

        await refresh();
    }, [enabled, refresh]);

    return {
        status,
        requestPermission: requestDesktopPermission,
    };
}
