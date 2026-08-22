import * as React from 'react';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import { readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { Modal } from '@/modal';
import { t } from '@/text';
import { isDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { buildDaemonServiceTaskKind, TRAY_DAEMON_SERVICE_ACTION_EVENT, type TrayDaemonServiceActionPayload } from './trayDaemonLifecycle';

export function DesktopTrayDaemonLifecycleRuntime(): React.ReactElement | null {
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const [pendingTaskId, setPendingTaskId] = React.useState<string | null>(null);
    const [pendingAction, setPendingAction] = React.useState<TrayDaemonServiceActionPayload['action'] | null>(null);
    const pendingActionRef = React.useRef<TrayDaemonServiceActionPayload['action'] | null>(null);

    const snapshot = useSystemTaskSnapshot(runner, pendingTaskId);

    const startDaemonLifecycleAction = React.useCallback(async (action: TrayDaemonServiceActionPayload['action']) => {
        if (pendingActionRef.current) {
            return;
        }

        pendingActionRef.current = action;
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(buildDaemonServiceTaskKind(action)));
            setPendingAction(action);
            setPendingTaskId(taskId);
        } catch (error) {
            pendingActionRef.current = null;
            setPendingAction(null);
            setPendingTaskId(null);
            const message = readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed');
            Modal.alert(t('common.error'), message);
        }
    }, [runner]);

    React.useEffect(() => {
        if (!isDesktopHost()) {
            return () => {};
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;

        void listenDesktopHostEvent<TrayDaemonServiceActionPayload>(TRAY_DAEMON_SERVICE_ACTION_EVENT, (payload) => {
            if (disposed) {
                return;
            }
            void startDaemonLifecycleAction(payload.action);
        }).then((dispose) => {
            unlisten = dispose;
        }).catch(() => {});

        return () => {
            disposed = true;
            pendingActionRef.current = null;
            setPendingAction(null);
            setPendingTaskId(null);
            unlisten?.();
        };
    }, [startDaemonLifecycleAction]);

    React.useEffect(() => {
        if (!pendingAction || !snapshot?.result) {
            return;
        }

        if (!snapshot.result.ok) {
            Modal.alert(
                t('common.error'),
                snapshot.result.error?.message ?? t('settings.systemTaskStartFailed'),
            );
        }

        pendingActionRef.current = null;
        setPendingAction(null);
        setPendingTaskId(null);
    }, [pendingAction, snapshot]);

    return null;
}
