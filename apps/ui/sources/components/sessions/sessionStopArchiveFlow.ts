import { SessionArchiveTimeoutError, withSessionArchiveDeadline } from '@/sync/ops/sessionArchiveLifecycle';
import type { SessionStopOutcome } from '@happier-dev/protocol/sessions/control/contract';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { HappyError } from '@/utils/errors/errors';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import type { SessionStopRecovery } from '@/sync/ops/sessionStopContract';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionArchivePending, type SessionArchiveOperation } from '@/sync/domains/session/listing/sessionArchiveState';
import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';
import { resolveDisplayMachineIdForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
    recovery?: SessionStopRecovery;
    stopOutcome?: SessionStopOutcome;
    details?: unknown;
}>;

/** Read the Session stop owner's result from the Action's JSON output. */
export function readSessionStopActionResponse(value: unknown): SessionMutationResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('success' in value) || typeof value.success !== 'boolean') return null;
    const recovery = 'recovery' in value ? value.recovery : undefined;
    return {
        success: value.success,
        ...('message' in value && typeof value.message === 'string' ? { message: value.message } : {}),
        ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
        ...(recovery === 'wait_for_inactive' || recovery === 'retry_when_runtime_available' ? { recovery } : {}),
    };
}

export type StopSessionAndMaybeArchiveParams = Readonly<{
    address: SessionAddress;
    hideInactiveSessions: boolean;
    isPinned: boolean;
    archiveAfterStop: 'never' | 'always';
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: (operation?: SessionArchiveOperation) => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    archiveErrorMessage: string;
}>;

export function isSessionActiveArchiveResult(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_active';
}

export function isAcceptedPendingSessionStop(result: SessionMutationResult): boolean {
    return (
        result.success === false
        && result.code === 'session_stop_requested'
        && result.recovery === 'wait_for_inactive'
    );
}

export function resolveSessionStopFailureMessage(
    result: SessionMutationResult,
    fallbackMessage: string,
): string {
    if (result.recovery === 'retry_when_runtime_available') {
        return t('sessionInfo.stopSessionControlUnavailable');
    }
    return result.message && result.message !== 'unknown_error' ? result.message : fallbackMessage;
}

export function isSessionArchivePending(address: SessionAddress): boolean {
    return readSessionArchivePending(storage.getState(), address);
}

function canAttemptArchiveAfterUnavailableStop(address: SessionAddress, result: SessionMutationResult): boolean {
    if (result.code !== 'session_stop_control_unavailable') return false;
    const state = storage.getState();
    const machineId = resolveDisplayMachineIdForSessionFromState({ state, ...address });
    if (!machineId) return false;
    const inventory = resolveServerScopedMachineInventory<Machine>({
        serverId: address.serverId, activeServerId: '', activeMachines: [],
        machineListByServerId: state.machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId,
    });
    if (inventory.status !== 'idle' || inventory.machines === null) return false;
    const machine = inventory.machines.find(machine => machine.id === machineId);
    return machine === undefined || isMachineOnline(machine) === false;
}

/** Call after confirmation; every archive entry point shares synchronous admission. */
export async function archiveSessionWithPendingState<T extends SessionMutationResult | undefined>(
    address: SessionAddress,
    archiveSession: (operation: SessionArchiveOperation) => Promise<T>,
): Promise<T | false> {
    const operation = storage.getState().beginSessionArchive(address);
    if (!operation) return false;
    try {
        const result = await archiveSession(operation);
        if (result?.success && result.stopOutcome?.status === 'physical_stop_unconfirmed'
            && result.stopOutcome.reason === 'target_daemon_unavailable') {
            publishPresentationNotice({
                key: `session-stop:${operation.serverId}:${operation.sessionId}`,
                severity: 'info',
                message: t('workflows.run.stopWhenMachineReconnectsUnknown'),
            });
        }
        return result;
    } finally {
        storage.getState().finishSessionArchive(operation);
    }
}

export type StopSessionAndRunActionParams = Readonly<{
    stopSession: () => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    endAction?: Readonly<{
        run: (signal?: AbortSignal) => Promise<SessionMutationResult>;
        errorMessage: string;
        canRunAfterStopFailure?: (result: SessionMutationResult) => boolean;
        readiness?: Readonly<{ isReady: () => boolean; signal: AbortSignal }>;
    }>;
}>;

/** Observe lifecycle publication only while this one confirmed end action needs it. */
async function waitForEndActionReadiness(isReady: () => boolean, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (isReady()) return;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            signal.removeEventListener('abort', abort);
            if (error !== undefined) reject(error);
            else resolve();
        };
        const abort = () => finish(signal.reason ?? new Error('Session end action cancelled'));
        const check = () => {
            try { throwIfAborted(signal); if (isReady()) finish(); }
            catch (error) { finish(error); }
        };
        unsubscribe = storage.subscribe(check);
        signal.addEventListener('abort', abort, { once: true });
        // Cover a publication or cancellation between the initial check and admission.
        check();
    });
}

/** Stop acknowledgements never prove end-action eligibility; each end action keeps its own guard. */
export async function stopSessionAndRunAction(params: StopSessionAndRunActionParams): Promise<SessionMutationResult | undefined> {
    const stopResult = await params.stopSession();
    const targetMissing = stopResult.code === 'session_stop_not_found';
    const canProceed = params.endAction && (targetMissing || params.endAction.canRunAfterStopFailure?.(stopResult));
    if (!stopResult.success && !isAcceptedPendingSessionStop(stopResult) && !canProceed) {
        throw new HappyError(resolveSessionStopFailureMessage(stopResult, params.stopErrorMessage), false, {
            code: stopResult.code, details: stopResult.details,
        });
    }
    const endAction = params.endAction;
    if (!endAction) return;
    const run = async (signal?: AbortSignal) => {
        if (endAction.readiness && !targetMissing) await waitForEndActionReadiness(endAction.readiness.isReady, signal ?? endAction.readiness.signal);
        const result = await endAction.run(signal);
        if (!result.success) {
            throw new HappyError(isSessionActiveArchiveResult(result) ? endAction.errorMessage
                : result.message || endAction.errorMessage, false, { code: result.code, details: result.details });
        }
        return result;
    };
    if (!endAction.readiness) return await run();
    try {
        // The existing end-stage owner supplies the budget; Stop itself is outside it.
        return await withSessionArchiveDeadline(endAction.readiness.signal, run);
    } catch (error) {
        if (error instanceof SessionArchiveTimeoutError) throw new HappyError(endAction.errorMessage, false, { code: 'session_end_action_timeout' });
        throw error;
    }
}

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void | false> {
    const run = (operation?: SessionArchiveOperation) => stopSessionAndRunAction({
        stopSession: params.stopSession,
        stopErrorMessage: params.stopErrorMessage,
        ...(params.archiveAfterStop === 'always' ? { endAction: {
            run: () => params.archiveSession(operation),
            errorMessage: params.archiveErrorMessage,
            canRunAfterStopFailure: (result: SessionMutationResult) => canAttemptArchiveAfterUnavailableStop(params.address, result),
        } } : {}),
    });
    const result = await (params.archiveAfterStop === 'always'
        ? archiveSessionWithPendingState(params.address, run)
        : run());
    return result === false ? false : undefined;
}
