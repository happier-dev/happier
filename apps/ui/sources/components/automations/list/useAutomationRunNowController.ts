import React from 'react';

import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type AutomationRunNowState = 'idle' | 'submitting' | 'acknowledged';

/**
 * Sole UI owner of Run Now invocation and pending acknowledgement. State is
 * module-scoped so list/detail navigation and virtualized row recycling cannot
 * create competing guards for the same Automation.
 */
export type AutomationRunNowController = Readonly<{
    stateFor: (automationId: string) => AutomationRunNowState;
    runNow: (automationId: string, options?: Readonly<{
        isInvocationCurrent?: () => boolean;
    }>) => Promise<void>;
}>;

const ACKNOWLEDGEMENT_MS = 2500;
const stateById = new Map<string, AutomationRunNowState>();
const inFlightIds = new Set<string>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function publishState(automationId: string, state: AutomationRunNowState): void {
    if (state === 'idle') stateById.delete(automationId);
    else stateById.set(automationId, state);
    snapshotVersion += 1;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function runAutomationNow(
    automationId: string,
    options?: Readonly<{
        isInvocationCurrent?: () => boolean;
        isAuthorityCurrent?: () => boolean;
    }>,
): Promise<void> {
    if (inFlightIds.has(automationId)) return;
    inFlightIds.add(automationId);
    const isCurrent = options?.isInvocationCurrent ?? (() => true);
    const isAuthorityCurrent = options?.isAuthorityCurrent ?? (() => true);
    try {
        publishState(automationId, 'submitting');
        await sync.runAutomationNow(automationId);
        if (!isAuthorityCurrent()) {
            publishState(automationId, 'idle');
            return;
        }
        publishState(automationId, 'acknowledged');
        setTimeout(() => {
            if (stateById.get(automationId) === 'acknowledged') publishState(automationId, 'idle');
        }, ACKNOWLEDGEMENT_MS);
    } catch (error) {
        publishState(automationId, 'idle');
        if (isAuthorityCurrent() && isCurrent()) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed'),
            );
        }
    } finally {
        inFlightIds.delete(automationId);
    }
}

export function useAutomationRunNowController(): AutomationRunNowController {
    React.useSyncExternalStore(subscribe, () => snapshotVersion, () => snapshotVersion);
    const accountLifetime = captureActiveServerAccountScopeLifetime();

    return React.useMemo(() => ({
        stateFor: (automationId: string) => stateById.get(automationId) ?? 'idle',
        runNow: async (automationId, options) => {
            if (accountLifetime !== null && !accountLifetime.isCurrent()) return;
            await runAutomationNow(automationId, {
                ...(options?.isInvocationCurrent
                    ? { isInvocationCurrent: options.isInvocationCurrent }
                    : {}),
                isAuthorityCurrent: () => accountLifetime?.isCurrent() ?? true,
            });
        },
    }), [accountLifetime, snapshotVersion]);
}
