import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { Modal } from '@/modal';
import { t, type TranslationKey } from '@/text';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';

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
        const activeAt = typeof machine?.activeAt === 'number' && Number.isFinite(machine.activeAt) && machine.activeAt > 0 ? machine.activeAt : null;
        if (activeAt !== null) {
            const statusMachine: Machine = {
                id: 'status-line-machine',
                seq: 0,
                createdAt: 0,
                updatedAt: 0,
                active: machine?.active === true,
                activeAt,
                revokedAt: null,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            if (isMachineOnline(statusMachine)) return t('status.online');
            return t('status.lastSeen', { time: formatLastSeen(activeAt, false) });
        }
        if (machine?.active === true) return t('status.online');
        return t('status.unknown');
    })();

    const machineName = resolveMachineName(machine);
    return machineName ? `${machineName} — ${machineStatus}` : machineStatus;
}

export function showDaemonUnavailableAlert(params: Readonly<{
    titleKey: TranslationKey;
    bodyKey: TranslationKey;
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
    titleKey?: TranslationKey;
    bodyKey?: TranslationKey;
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
    titleKey?: TranslationKey;
    bodyKey?: TranslationKey;
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
