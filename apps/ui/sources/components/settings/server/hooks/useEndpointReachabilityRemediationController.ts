import * as React from 'react';
import { Platform } from 'react-native';

import { Modal } from '@/modal';
import { t } from '@/text';
import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { SYSTEM_TASK_PROTOCOL_VERSION, createTailscaleEnsureReadyTaskSpec } from '@happier-dev/protocol';

import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationAction,
} from '@/components/serverReachability/remediation';

type UseEndpointReachabilityRemediationControllerParams = Readonly<{
    remediation: EndpointReachabilityRemediation | null;
    endpoint: string | null;
    onRetryEndpoint: (endpoint: string) => Promise<void> | void;
}>;

type UseEndpointReachabilityRemediationControllerResult = Readonly<{
    error: string | null;
    taskSnapshot: SystemTaskRunState | null;
    onAction: (actionId: EndpointReachabilityRemediationAction['id']) => Promise<void>;
}>;

export function useEndpointReachabilityRemediationController(
    params: UseEndpointReachabilityRemediationControllerParams,
): UseEndpointReachabilityRemediationControllerResult {
    const systemTaskRunner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const [taskId, setTaskId] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const handledTaskIdRef = React.useRef<string | null>(null);
    const remediationRef = React.useRef<EndpointReachabilityRemediation | null>(params.remediation);
    const endpointRef = React.useRef<string | null>(params.endpoint);
    const retryEndpointRef = React.useRef(params.onRetryEndpoint);
    const retryAfterTaskEndpointRef = React.useRef<string | null>(null);
    const taskSnapshot = useSystemTaskSnapshot(systemTaskRunner, taskId);

    React.useEffect(() => {
        remediationRef.current = params.remediation;
    }, [params.remediation]);

    React.useEffect(() => {
        endpointRef.current = params.endpoint;
    }, [params.endpoint]);

    React.useEffect(() => {
        retryEndpointRef.current = params.onRetryEndpoint;
    }, [params.onRetryEndpoint]);

    const onAction = React.useCallback(async (
        actionId: EndpointReachabilityRemediationAction['id'],
    ) => {
        const remediation = remediationRef.current;
        const endpoint = endpointRef.current;
        if (!remediation || !endpoint) {
            return;
        }

        const action = remediation.actions.find((candidate) => candidate.id === actionId);
        if (!action) {
            return;
        }

        if (action.kind === 'retry') {
            setError(null);
            await retryEndpointRef.current(endpoint);
            return;
        }

        if (action.kind === 'external-url') {
            const opened = await openExternalUrl(action.url, { platformOS: Platform.OS });
            if (!opened) {
                await Modal.alert(t('common.error'), t('server.reachabilityRemediation.failedToOpenInstallLink'));
            }
            return;
        }

        if (action.kind === 'callback' && action.callbackSlot === 'tailscale.ensureReady') {
            try {
                setError(null);
                const taskSpec = createTailscaleEnsureReadyTaskSpec({
                    installPolicy: 'installIfMissing',
                    loginPolicy: 'interactive',
                    mode: 'normalUser',
                });
                const nextTaskId = await systemTaskRunner.start({
                    ...taskSpec,
                    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                });
                handledTaskIdRef.current = null;
                retryAfterTaskEndpointRef.current = endpoint;
                setTaskId(nextTaskId);
            } catch (caughtError) {
                const message = readSystemTaskStartErrorMessage(caughtError);
                setError(
                    isSystemTaskBridgeUnavailableError(caughtError)
                        ? t('settings.systemTaskBridgeUnavailable')
                        : (message ?? t('settings.systemTaskStartFailed')),
                );
            }
        }
    }, [systemTaskRunner]);

    React.useEffect(() => {
        const result = taskSnapshot?.result;
        if (!result) {
            return;
        }
        if (handledTaskIdRef.current === taskSnapshot.taskId) {
            return;
        }
        handledTaskIdRef.current = taskSnapshot.taskId;

        if (!result.ok) {
            const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
            setError(message || t('settings.systemTaskStartFailed'));
            setTaskId(null);
            return;
        }

        const endpoint = retryAfterTaskEndpointRef.current;
        setError(null);
        setTaskId(null);

        if (!endpoint) {
            return;
        }

        void Promise.resolve(retryEndpointRef.current(endpoint));
    }, [taskSnapshot]);

    React.useEffect(() => {
        if (params.remediation) {
            return;
        }
        if (taskId) {
            return;
        }
        setError(null);
    }, [params.remediation, taskId]);

    return {
        error,
        taskSnapshot: taskSnapshot ?? null,
        onAction,
    };
}
