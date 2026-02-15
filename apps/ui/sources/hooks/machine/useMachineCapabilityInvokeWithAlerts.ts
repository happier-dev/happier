import * as React from 'react';

import { Modal } from '@/modal';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilitiesInvokeRequest, CapabilitiesInvokeResponse } from '@/sync/ops';

type UnsupportedReason = 'not-supported' | 'error';

function resolveLogPathFromInvokeResponse(response: CapabilitiesInvokeResponse): string | null {
    if (!response.ok) return typeof (response as any).logPath === 'string' ? (response as any).logPath : null;
    const raw = (response as any).result;
    const logPath = raw && typeof raw === 'object' ? (raw as any).logPath : null;
    return typeof logPath === 'string' ? logPath : null;
}

export type CapabilityInvokeAlerts = Readonly<{
    errorTitle: string;
    successTitle: string;
    unsupportedMessage: (reason: UnsupportedReason) => string;
    formatErrorMessage?: (error: Readonly<{ message: string; code?: string }>) => string;
    successMessage?: string;
    successWithLogPath?: (logPath: string) => string;
}>;

export type InvokeMachineCapabilityWithAlertsParams = Readonly<{
    machineId: string;
    request: CapabilitiesInvokeRequest;
    serverId?: string | null;
    timeoutMs?: number;
    alerts: CapabilityInvokeAlerts;
}>;

export function useMachineCapabilityInvokeWithAlerts() {
    const [isInvoking, setIsInvoking] = React.useState(false);

    const invokeWithAlerts = React.useCallback(async (params: InvokeMachineCapabilityWithAlertsParams) => {
        setIsInvoking(true);
        try {
            const invoke = await machineCapabilitiesInvoke(
                params.machineId,
                params.request,
                { timeoutMs: params.timeoutMs, serverId: params.serverId },
            );

            if (!invoke.supported) {
                Modal.alert(params.alerts.errorTitle, params.alerts.unsupportedMessage(invoke.reason));
                return invoke;
            }

            if (!invoke.response.ok) {
                const msg = params.alerts.formatErrorMessage
                    ? params.alerts.formatErrorMessage(invoke.response.error)
                    : invoke.response.error.message;
                Modal.alert(params.alerts.errorTitle, msg);
                return invoke;
            }

            const logPath = resolveLogPathFromInvokeResponse(invoke.response);
            const successMsg = logPath && params.alerts.successWithLogPath
                ? params.alerts.successWithLogPath(logPath)
                : (params.alerts.successMessage ?? 'Done.');
            Modal.alert(params.alerts.successTitle, successMsg);
            return invoke;
        } catch (e) {
            Modal.alert(params.alerts.errorTitle, e instanceof Error ? e.message : 'Request failed.');
            return { supported: false, reason: 'error' as const };
        } finally {
            setIsInvoking(false);
        }
    }, []);

    return { isInvoking, invokeWithAlerts } as const;
}

