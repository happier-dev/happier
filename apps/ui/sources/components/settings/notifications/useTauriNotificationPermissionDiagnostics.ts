import * as React from 'react';

import {
    isPermissionGranted,
} from '@/activity/notifications/channels/tauriNotificationPlugin';
import { NotificationConfigurationActionOutputSchemas } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export type TauriNotificationPermissionDiagnosticsStatus =
    | 'checking'
    | 'granted'
    | 'notGranted'
    | 'error';

export function useTauriNotificationPermissionDiagnostics(enabled: boolean): Readonly<{
    status: TauriNotificationPermissionDiagnosticsStatus;
    requestPermission: () => Promise<void>;
    approval: ReturnType<typeof useMountedActionExecution>['approval'];
}> {
    const execution = useMountedActionExecution(useActiveServerAccountScope());
    const [status, setStatus] = React.useState<TauriNotificationPermissionDiagnosticsStatus>(
        enabled ? 'checking' : 'notGranted',
    );

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
            const result = await execution.execute('notifications.desktop.permission.request', {});
            if (!result.ok) throw new Error(result.errorCode);
            if (execution.isCurrent()) setStatus(NotificationConfigurationActionOutputSchemas['notifications.desktop.permission.request'].parse(result.result).status);
        } catch {
            setStatus('error');
            return;
        }

    }, [enabled, execution.execute, execution.isCurrent]);

    return {
        status,
        requestPermission: requestDesktopPermission,
        approval: execution.approval,
    };
}
