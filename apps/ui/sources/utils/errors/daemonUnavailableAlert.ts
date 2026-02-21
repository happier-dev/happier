import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { Modal } from '@/modal';
import { t } from '@/text';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';

export type MachineStatusLineInput =
    | Readonly<{
          active?: boolean | null;
          activeAt?: number | null;
          metadata?: Readonly<{ displayName?: string | null; host?: string | null }> | null;
      }>
    | null
    | undefined;

function resolveMachineName(machine: MachineStatusLineInput): string | null {
    const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
    return host || null;
}

export function buildMachineStatusLine(machine: MachineStatusLineInput): string {
    const machineStatus = (() => {
        const activeAt = typeof machine?.activeAt === 'number' ? machine.activeAt : null;
        if (activeAt !== null) {
            if (machine?.active === true) return t('status.online');
            return t('status.lastSeen', { time: formatLastSeen(activeAt, false) });
        }
        return t('status.unknown');
    })();

    const machineName = resolveMachineName(machine);
    return machineName ? `${machineName} — ${machineStatus}` : machineStatus;
}

export function showDaemonUnavailableAlert(params: Readonly<{
    titleKey: string;
    bodyKey: string;
    machine?: MachineStatusLineInput;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
}>): void {
    const statusLine = buildMachineStatusLine(params.machine);
    const message = `${t(params.bodyKey)}\n\n${statusLine}`;
    const guardedRetry = params.onRetry
        ? () => {
              if (params.shouldContinue && !params.shouldContinue()) {
                  return;
              }
              params.onRetry?.();
          }
        : null;
    const buttons = [
        ...(guardedRetry
            ? [
                  {
                      text: t('common.retry'),
                      onPress: guardedRetry,
                  },
              ]
            : []),
        {
            text: t('common.cancel'),
            style: 'cancel' as const,
        },
    ];

    Modal.alert(t(params.titleKey), message, buttons);
}

export function tryShowDaemonUnavailableAlertForRpcError(params: Readonly<{
    error: unknown;
    machine?: MachineStatusLineInput;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
    titleKey?: string;
    bodyKey?: string;
}>): boolean {
    const rpcErrorCode = readRpcErrorCode(params.error);
    if (typeof rpcErrorCode === 'string' && rpcErrorCode.trim() && rpcErrorCode.trim() !== DAEMON_UNAVAILABLE_RPC_ERROR_CODE) {
        return false;
    }
    if (!isRpcMethodNotAvailableError(params.error as any)) {
        return false;
    }

    showDaemonUnavailableAlert({
        titleKey: params.titleKey ?? 'errors.daemonUnavailableTitle',
        bodyKey: params.bodyKey ?? 'errors.daemonUnavailableBody',
        machine: params.machine,
        onRetry: params.onRetry ?? null,
        shouldContinue: params.shouldContinue ?? null,
    });

    return true;
}

export function tryShowDaemonUnavailableAlertForRpcFailure(params: Readonly<{
    rpcErrorCode?: string | null;
    message?: string | null;
    machine?: MachineStatusLineInput;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
    titleKey?: string;
    bodyKey?: string;
}>): boolean {
    const normalizedCode = typeof params.rpcErrorCode === 'string' ? params.rpcErrorCode.trim() : '';
    if (normalizedCode && normalizedCode !== DAEMON_UNAVAILABLE_RPC_ERROR_CODE) {
        return false;
    }

    const carrier = {
        rpcErrorCode: normalizedCode || undefined,
        message: typeof params.message === 'string' ? params.message : undefined,
    };

    if (!isRpcMethodNotAvailableError(carrier as any)) {
        return false;
    }

    showDaemonUnavailableAlert({
        titleKey: params.titleKey ?? 'errors.daemonUnavailableTitle',
        bodyKey: params.bodyKey ?? 'errors.daemonUnavailableBody',
        machine: params.machine,
        onRetry: params.onRetry ?? null,
        shouldContinue: params.shouldContinue ?? null,
    });

    return true;
}

export const DAEMON_UNAVAILABLE_RPC_ERROR_CODE = RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
