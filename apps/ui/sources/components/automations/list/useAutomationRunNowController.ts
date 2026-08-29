import React from 'react';

import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    serverAccountScopedStorageKey,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

export type AutomationRunNowState = 'idle' | 'submitting' | 'acknowledged';

/**
 * Sole UI owner of Run Now invocation and pending acknowledgement. State is
 * module-scoped so list/detail navigation and virtualized row recycling cannot
 * create competing guards for the same Automation. Transient state is keyed by
 * the canonical server/account scope plus the Automation id, so one Automation
 * id under two Accounts can never share or clear the other's transient state.
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

function resolveRunNowStateKey(scope: ServerAccountScope, automationId: string): string {
    return serverAccountScopedStorageKey(automationId, scope);
}

function publishState(stateKey: string, state: AutomationRunNowState): void {
    if (state === 'idle') stateById.delete(stateKey);
    else stateById.set(stateKey, state);
    snapshotVersion += 1;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function runAutomationNow(
    automationId: string,
    stateKey: string,
    options?: Readonly<{
        isInvocationCurrent?: () => boolean;
        isAuthorityCurrent?: () => boolean;
    }>,
): Promise<void> {
    if (inFlightIds.has(stateKey)) return;
    inFlightIds.add(stateKey);
    const isCurrent = options?.isInvocationCurrent ?? (() => true);
    const isAuthorityCurrent = options?.isAuthorityCurrent ?? (() => true);
    try {
        publishState(stateKey, 'submitting');
        await sync.runAutomationNow(automationId);
        if (!isAuthorityCurrent()) {
            publishState(stateKey, 'idle');
            return;
        }
        publishState(stateKey, 'acknowledged');
        setTimeout(() => {
            if (stateById.get(stateKey) === 'acknowledged') publishState(stateKey, 'idle');
        }, ACKNOWLEDGEMENT_MS);
    } catch (error) {
        publishState(stateKey, 'idle');
        if (isAuthorityCurrent() && isCurrent()) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed'),
            );
        }
    } finally {
        inFlightIds.delete(stateKey);
    }
}

export function useAutomationRunNowController(): AutomationRunNowController {
    React.useSyncExternalStore(subscribe, () => snapshotVersion, () => snapshotVersion);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const scope = accountLifetime?.scope ?? null;

    return React.useMemo(() => ({
        stateFor: (automationId: string) => scope === null
            ? 'idle'
            : stateById.get(resolveRunNowStateKey(scope, automationId)) ?? 'idle',
        runNow: async (automationId, options) => {
            if (accountLifetime === null || !accountLifetime.isCurrent()) return;
            await runAutomationNow(automationId, resolveRunNowStateKey(accountLifetime.scope, automationId), {
                ...(options?.isInvocationCurrent
                    ? { isInvocationCurrent: options.isInvocationCurrent }
                    : {}),
                isAuthorityCurrent: () => accountLifetime.isCurrent(),
            });
        },
    }), [accountLifetime, scope, snapshotVersion]);
}
