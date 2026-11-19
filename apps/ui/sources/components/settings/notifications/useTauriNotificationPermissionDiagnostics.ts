import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { NotificationConfigurationActionOutputSchemas } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';

import {
    isPermissionGranted,
} from '@/activity/notifications/channels/tauriNotificationPlugin';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

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
    const { execute, isCurrent, ready, approval, binding } = useMountedActionExecution(useActiveServerAccountScope());
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
    }, [binding, enabled]);

    const requestDesktopPermission = React.useCallback(async () => {
        if (!enabled) {
            setStatus('notGranted');
            return;
        }

        if (!ready || status === 'checking') return;

        const actionId = 'notifications.desktop.permission.request';
        setStatus('checking');
        try {
            const result = await execute(actionId, {});
            if (!isCurrent()) return;
            if (!result.ok) {
                setStatus(status);
                if (result.errorCode === 'cancelled' || isActionApprovalDeclinedErrorCode(result.errorCode)) return;
                if (presentActionTurnedOffNoticeIfOff(result, actionId)) return;
                Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(
                    result, t('settingsNotifications.desktop.permission.errorSubtitle'),
                ));
                return;
            }
            setStatus(NotificationConfigurationActionOutputSchemas[actionId].parse(result.result).status);
        } catch {
            if (isCurrent()) setStatus('error');
        }
    }, [enabled, execute, isCurrent, ready, status]);

    return {
        status,
        requestPermission: requestDesktopPermission,
        approval,
    };
}
