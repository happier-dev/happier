import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ActionId } from '@happier-dev/protocol';

const SESSION_TERMINAL_COMPOSER_CLEAR_ACTION_ID = 'session.terminalComposer.clear' as ActionId;

export function canClearLiveTerminalComposerDraft(
    session: Pick<Session, 'active' | 'agentState'> | null | undefined,
): boolean {
    if (session?.active !== true) return false;
    const capabilities = session.agentState?.capabilities;
    return capabilities?.terminalComposerClearSupported !== false && (
        capabilities?.terminalComposerDraftPresent === true
        || capabilities?.inFlightSteerUnavailableReason === 'user_terminal_draft'
    );
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isApprovalRequestCreated(value: unknown): boolean {
    return readRecord(value)?.kind === 'approval_request_created';
}

function resolveClearTerminalComposerFailureMessage(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) {
        return t('session.pendingMessages.errors.clearTerminalComposerFailed');
    }
    if (record.ok === true) {
        return null;
    }

    const status = typeof record.status === 'string' ? record.status : '';
    const errorCode = typeof record.errorCode === 'string' ? record.errorCode : '';
    if (status === 'unsupported' || errorCode === 'unsupported_action') {
        return t('session.pendingMessages.errors.clearTerminalComposerUnsupported');
    }
    if (status === 'not_safe' || status === 'generating' || status === 'dialog_open') {
        return t('session.pendingMessages.errors.clearTerminalComposerUnsafe');
    }
    if (typeof record.errorMessage === 'string' && record.errorMessage.trim().length > 0) {
        return record.errorMessage;
    }
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
        return record.error;
    }
    return t('session.pendingMessages.errors.clearTerminalComposerFailed');
}

export function useTerminalComposerClearAction(sessionId: string): Readonly<{
    busy: boolean;
    clearTerminalComposer: (options?: Readonly<{ expectedStateAtMs?: number | null }>) => Promise<void>;
}> {
    const [busy, setBusy] = React.useState(false);
    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
        [],
    );

    const clearTerminalComposer = React.useCallback(async (options?: Readonly<{ expectedStateAtMs?: number | null }>) => {
        if (busy) return;
        setBusy(true);
        try {
            const confirmed = await Modal.confirm(
                t('session.pendingMessages.clearTerminalComposer.confirmTitle'),
                t('session.pendingMessages.clearTerminalComposer.confirmBody'),
                { confirmText: t('session.pendingMessages.clearTerminalComposer.confirmButton'), destructive: true },
            );
            if (!confirmed) return;

            const expectedStateAtMs = options?.expectedStateAtMs;
            const result = await actionExecutor.execute(
                SESSION_TERMINAL_COMPOSER_CLEAR_ACTION_ID,
                {
                    sessionId,
                    ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
                },
                {
                    defaultSessionId: sessionId,
                    surface: 'ui_button',
                },
            );
            if (result.ok !== true) {
                Modal.alert(t('common.error'), result.error ?? t('session.pendingMessages.errors.clearTerminalComposerFailed'));
                return;
            }
            if (isApprovalRequestCreated(result.result)) {
                return;
            }
            const failureMessage = resolveClearTerminalComposerFailureMessage(result.result);
            if (failureMessage) {
                Modal.alert(t('common.error'), failureMessage);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.errors.clearTerminalComposerFailed'));
        } finally {
            setBusy(false);
        }
    }, [actionExecutor, busy, sessionId]);

    return { busy, clearTerminalComposer };
}
