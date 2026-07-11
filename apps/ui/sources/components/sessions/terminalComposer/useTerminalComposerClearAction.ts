import * as React from 'react';
import type { ActionId } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { t } from '@/text';

const TERMINAL_COMPOSER_CLEAR_ACTION_ID = 'session.terminalComposer.clear' as ActionId;

function getTerminalComposerClearFailureMessage(status: unknown): string {
    switch (status) {
        case 'unsupported':
            return t('session.pendingMessages.clearComposer.errors.unsupported');
        case 'no_live_terminal':
        case 'host_dead':
            return t('session.pendingMessages.clearComposer.errors.noLiveTerminal');
        case 'generating':
            return t('session.pendingMessages.clearComposer.errors.generating');
        case 'dialog_open':
        case 'not_safe':
            return t('session.pendingMessages.clearComposer.errors.notSafe');
        case 'capture_unavailable':
            return t('session.pendingMessages.clearComposer.errors.captureUnavailable');
        default:
            return t('session.pendingMessages.clearComposer.errors.failed');
    }
}

function getTerminalComposerClearFailureStatus(result: unknown): string | null {
    const value = result as {
        ok?: unknown;
        errorCode?: unknown;
        error?: unknown;
        status?: unknown;
        result?: {
            ok?: unknown;
            errorCode?: unknown;
            error?: unknown;
            status?: unknown;
        };
    } | null;
    if (!value || typeof value !== 'object') {
        return 'clear_failed';
    }
    if (value.ok === false) {
        return String(value.errorCode ?? value.status ?? value.error ?? 'clear_failed');
    }
    const payload = value.result;
    if (payload && typeof payload === 'object' && payload.ok === false) {
        return String(payload.status ?? payload.errorCode ?? payload.error ?? 'clear_failed');
    }
    return null;
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
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.clearComposer.confirmTitle'),
            t('session.pendingMessages.clearComposer.confirmBody'),
            { confirmText: t('session.pendingMessages.clearComposer.action'), destructive: true },
        );
        if (!confirmed) return;

        setBusy(true);
        try {
            const expectedStateAtMs = options?.expectedStateAtMs;
            const result = await actionExecutor.execute(
                TERMINAL_COMPOSER_CLEAR_ACTION_ID,
                {
                    sessionId,
                    ...(typeof expectedStateAtMs === 'number' && Number.isFinite(expectedStateAtMs)
                        ? { expectedStateAtMs }
                        : {}),
                },
                { defaultSessionId: sessionId, surface: 'ui', placement: 'pending_messages' },
            );
            const failureStatus = getTerminalComposerClearFailureStatus(result);
            if (failureStatus) {
                Modal.alert(t('common.error'), getTerminalComposerClearFailureMessage(failureStatus));
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('session.pendingMessages.clearComposer.errors.failed'));
        } finally {
            setBusy(false);
        }
    }, [actionExecutor, busy, sessionId]);

    return { busy, clearTerminalComposer };
}
