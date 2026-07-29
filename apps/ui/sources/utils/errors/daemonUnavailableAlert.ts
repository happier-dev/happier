import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { Modal } from '@/modal';
import { t, type TranslationKey } from '@/text';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR,
    SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE,
} from '@/sync/runtime/sessionMachineRpcErrorCodes';
import { isCreatedSessionLocalReadinessErrorMessage } from '@/sync/runtime/sessionMessageDeliveryErrors';

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

export async function promptDaemonUnavailableRetry(params: Readonly<{
    titleKey: TranslationKey;
    bodyKey: TranslationKey;
    machine?: MachineStatusLineInput;
}>): Promise<'retry' | 'cancel'> {
    const statusLine = buildMachineStatusLine(params.machine);
    const message = `${t(params.bodyKey)}\n\n${statusLine}`;

    return await new Promise<'retry' | 'cancel'>((resolve) => {
        Modal.alert(t(params.titleKey), message, [
            {
                text: t('common.retry'),
                onPress: () => resolve('retry'),
            },
            {
                text: t('common.cancel'),
                style: 'cancel',
                onPress: () => resolve('cancel'),
            },
        ]);
    });
}

export function tryShowDaemonUnavailableAlertForRpcError(params: Readonly<{
    error: unknown;
    machine?: MachineStatusLineInput;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
    titleKey?: TranslationKey;
    bodyKey?: TranslationKey;
}>): boolean {
    if (!isDaemonUnavailableAlertError(params.error)) {
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
    const carrier = {
        rpcErrorCode: normalizedCode || undefined,
        message: typeof params.message === 'string' ? params.message : undefined,
    };

    if (!isDaemonUnavailableAlertError(carrier)) {
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

const DAEMON_UNAVAILABLE_ALERT_ERROR_CODES = new Set<string>([
    DAEMON_UNAVAILABLE_RPC_ERROR_CODE,
    SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE,
]);

const DOMAIN_FATAL_ERROR_CODES = new Set<string>([
    SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
    SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
    SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
    SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
    SPAWN_SESSION_ERROR_CODES.RESUME_UNSUPPORTED_ENCRYPTION_VARIANT,
    SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
    SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
    SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
    SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED,
    SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
    SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    'auth_required',
    'forbidden',
    'handoff_disabled',
    'invalid_parameters',
    'invalid_request',
    'not_authenticated',
    'server_routed_file_transfer_too_large',
    'transfer_disabled',
    'unauthorized',
]);

const DOMAIN_FATAL_ERROR_MESSAGES = new Set<string>([
    'File exceeds the server-routed transfer size limit',
    'Machine transfer is disabled on the selected server',
    'Server-routed transfer is disabled on the selected server',
]);

export type LaunchRetryFailurePhase = 'spawn' | 'upload' | 'send';

export type LaunchRetryFailureClassification =
    | Readonly<{
        kind: 'retryable';
        reason: 'daemon_unavailable' | 'session_target_unavailable' | 'launch_still_pending';
        titleKey: TranslationKey;
        bodyKey: TranslationKey;
        retryButtonKey: TranslationKey;
        cancelButtonKey: TranslationKey;
    }>
    | Readonly<{
        kind: 'fatal';
        reason: 'domain_error';
        errorCode?: string;
        message?: string;
    }>;

function readStringProperty(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readLaunchFailureErrorCode(failure: unknown): string | undefined {
    return readRpcErrorCode(failure)
        ?? readStringProperty(failure, 'errorCode')
        ?? readStringProperty(failure, 'code');
}

function readLaunchFailureMessage(failure: unknown): string | undefined {
    if (failure instanceof Error && failure.message.trim().length > 0) {
        return failure.message.trim();
    }
    return readStringProperty(failure, 'errorMessage')
        ?? readStringProperty(failure, 'error')
        ?? readStringProperty(failure, 'message');
}

function buildRetryableLaunchFailureClassification(
    phase: LaunchRetryFailurePhase,
    reason: 'daemon_unavailable' | 'session_target_unavailable',
): LaunchRetryFailureClassification {
    return {
        kind: 'retryable',
        reason,
        titleKey: phase === 'spawn' ? 'newSession.daemonRpcUnavailableTitle' : 'errors.daemonUnavailableTitle',
        bodyKey: phase === 'spawn' ? 'newSession.daemonRpcUnavailableBody' : 'errors.daemonUnavailableBody',
        retryButtonKey: 'common.retry',
        cancelButtonKey: 'common.cancel',
    };
}

export function classifyLaunchRetryFailure(params: Readonly<{
    phase: LaunchRetryFailurePhase;
    failure: unknown;
    previousFailure?: unknown;
}>): LaunchRetryFailureClassification {
    void params.previousFailure;

    const errorCode = readLaunchFailureErrorCode(params.failure);
    const message = readLaunchFailureMessage(params.failure);
    const normalizedCode = errorCode?.trim();

    if (
        params.phase === 'spawn'
        && normalizedCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
    ) {
        return {
            kind: 'retryable',
            reason: 'launch_still_pending',
            titleKey: 'newSession.launchStillPendingTitle',
            bodyKey: 'newSession.launchStillPendingBody',
            retryButtonKey: 'common.retry',
            cancelButtonKey: 'common.cancel',
        };
    }

    if (
        normalizedCode
        && normalizedCode !== SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE
        && normalizedCode !== DAEMON_UNAVAILABLE_RPC_ERROR_CODE
        && DOMAIN_FATAL_ERROR_CODES.has(normalizedCode)
    ) {
        return {
            kind: 'fatal',
            reason: 'domain_error',
            errorCode: normalizedCode,
            ...(message ? { message } : {}),
        };
    }

    if (message && DOMAIN_FATAL_ERROR_MESSAGES.has(message)) {
        return {
            kind: 'fatal',
            reason: 'domain_error',
            ...(normalizedCode ? { errorCode: normalizedCode } : {}),
            message,
        };
    }

    if (
        normalizedCode === SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE
        || message === SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR
        || message === INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR
        || (message ? isCreatedSessionLocalReadinessErrorMessage(message) : false)
    ) {
        return buildRetryableLaunchFailureClassification(params.phase, 'session_target_unavailable');
    }

    if (
        normalizedCode === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE
        || normalizedCode === DAEMON_UNAVAILABLE_RPC_ERROR_CODE
        || isDaemonUnavailableAlertError(params.failure)
    ) {
        return buildRetryableLaunchFailureClassification(params.phase, 'daemon_unavailable');
    }

    return {
        kind: 'fatal',
        reason: 'domain_error',
        ...(normalizedCode ? { errorCode: normalizedCode } : {}),
        ...(message ? { message } : {}),
    };
}

export function isDaemonUnavailableAlertError(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (typeof rpcErrorCode === 'string' && rpcErrorCode.trim()) {
        return DAEMON_UNAVAILABLE_ALERT_ERROR_CODES.has(rpcErrorCode.trim());
    }
    return isRpcMethodNotAvailableError(error);
}
