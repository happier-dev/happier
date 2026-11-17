import * as React from 'react';
import { AppState } from 'react-native';
import type { SessionAttentionStanding } from '@happier-dev/protocol/sessions/organization/standings';

import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type SessionAttentionReminderDeadline = Readonly<{
    address: SessionAddress;
    remindAt: number;
}>;

/**
 * Inventory refreshes distinguish a successful projection load from a
 * fulfilled-but-unable-to-load attempt (for example, while a Home credential
 * is unavailable). The scheduler must only suppress future retries for the
 * former.
 */
export type SessionAttentionReminderInventoryRefreshResult = Readonly<{
    kind: 'loaded' | 'retryable_failure';
}>;

export function resolveSessionAttentionReminderDeadline(
    serverId: string,
    standing: SessionAttentionStanding,
): SessionAttentionReminderDeadline | null {
    if (typeof standing.remindAt !== 'number' || !Number.isFinite(standing.remindAt)) return null;
    return {
        address: { serverId, sessionId: standing.sessionId },
        remindAt: standing.remindAt,
    };
}

export function resolveSessionAttentionReminderRefreshPlan(params: Readonly<{
    nowMs: number;
    reminders: readonly SessionAttentionReminderDeadline[];
}>): Readonly<{
    due: readonly SessionAttentionReminderDeadline[];
    nextDeadlineAt: number | null;
}> {
    const due: SessionAttentionReminderDeadline[] = [];
    let nextDeadlineAt: number | null = null;

    for (const reminder of params.reminders) {
        if (reminder.remindAt <= params.nowMs) {
            due.push(reminder);
            continue;
        }
        nextDeadlineAt = nextDeadlineAt === null
            ? reminder.remindAt
            : Math.min(nextDeadlineAt, reminder.remindAt);
    }

    return { due, nextDeadlineAt };
}

function reminderToken(reminder: SessionAttentionReminderDeadline): string {
    return JSON.stringify([sessionAddressKey(reminder.address), reminder.remindAt]);
}

function removeServerTokens(
    tokens: Set<string>,
    reminders: readonly SessionAttentionReminderDeadline[],
    serverId: string,
): void {
    for (const reminder of reminders) {
        if (reminder.address.serverId === serverId) tokens.delete(reminderToken(reminder));
    }
}

/**
 * Owns wall-clock invalidation for the server-projected `reminder_due` fact.
 * Attention meaning stays Protocol/server-owned: this hook only wakes the
 * exact Session projection when a persisted deadline can have crossed.
 */
export function useSessionAttentionReminderRefresh(params: Readonly<{
    connectedByServerId: Readonly<Record<string, boolean>>;
    /**
     * The Home whose changes catch-up runs after every lost connection (the active Home). Its
     * organization changes made while the connection was down arrive through that catch-up, so a
     * lost or regained connection does not re-read its whole inventory.
     */
    catchUpServerId?: string | null;
    /**
     * The exact-Home invalidation leaf's own contract: its promise covers the
     * replacement the controller queues behind an in-flight request. Inventory
     * refreshes return an explicit loaded/retryable settlement; due reminders
     * are completed by `refreshSession`.
     */
    invalidateSessionListQueryHome: (serverId: string) => Promise<void>;
    refreshReminderInventory: (serverId: string) => Promise<SessionAttentionReminderInventoryRefreshResult>;
    refreshSession: (address: SessionAddress) => Promise<EnsureSessionVisibleForRouteResult>;
    reminders: readonly SessionAttentionReminderDeadline[];
}>): void {
    const [wakeRevision, setWakeRevision] = React.useState(0);
    const completedTokensRef = React.useRef(new Set<string>());
    const inFlightTokensRef = React.useRef(new Set<string>());
    const refreshedInventoryServerIdsRef = React.useRef(new Set<string>());
    const inventoryRefreshInFlightServerIdsRef = React.useRef(new Set<string>());
    const previousConnectivityRef = React.useRef<Readonly<Record<string, boolean>>>({});
    const catchUpServerIdRef = React.useRef(params.catchUpServerId);
    catchUpServerIdRef.current = params.catchUpServerId;

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState !== 'active') return;
            completedTokensRef.current.clear();
            // A connected Home pushed its organization changes while the app was away, a connection
            // lost meanwhile re-reads on reconnect, and the catch-up Home's changes feed covers its
            // gap; only other Homes with no live connection have nothing but foreground to refresh them.
            for (const [serverId, connected] of Object.entries(previousConnectivityRef.current)) {
                if (!connected && serverId !== catchUpServerIdRef.current) refreshedInventoryServerIdsRef.current.delete(serverId);
            }
            setWakeRevision((value) => value + 1);
        });
        return () => subscription.remove();
    }, []);

    React.useEffect(() => {
        const currentTokens = new Set(params.reminders.map(reminderToken));
        for (const token of completedTokensRef.current) {
            if (!currentTokens.has(token)) completedTokensRef.current.delete(token);
        }

        const previousConnectivity = previousConnectivityRef.current;
        for (const [serverId, connected] of Object.entries(params.connectedByServerId)) {
            const coveredByCatchUp = serverId === params.catchUpServerId;
            if (!connected && previousConnectivity[serverId] === true) {
                removeServerTokens(completedTokensRef.current, params.reminders, serverId);
                if (!coveredByCatchUp) refreshedInventoryServerIdsRef.current.delete(serverId);
            }
            if (connected && previousConnectivity[serverId] === false && !coveredByCatchUp) {
                refreshedInventoryServerIdsRef.current.delete(serverId);
            }
        }
        previousConnectivityRef.current = params.connectedByServerId;

        // The keys are the app-global known-Home inventory. A false value only
        // prevents due Session refresh; it must not hide an offscreen Home's
        // persisted deadline from the one shared clock.
        for (const serverId of Object.keys(params.connectedByServerId)) {
            if (refreshedInventoryServerIdsRef.current.has(serverId)
                || inventoryRefreshInFlightServerIdsRef.current.has(serverId)) {
                continue;
            }
            inventoryRefreshInFlightServerIdsRef.current.add(serverId);
            void params.refreshReminderInventory(serverId).then(
                (result) => {
                    inventoryRefreshInFlightServerIdsRef.current.delete(serverId);
                    if (result.kind === 'loaded') {
                        refreshedInventoryServerIdsRef.current.add(serverId);
                    } else {
                        refreshedInventoryServerIdsRef.current.delete(serverId);
                    }
                },
                () => {
                    inventoryRefreshInFlightServerIdsRef.current.delete(serverId);
                },
            );
        }

        const nowMs = Date.now();
        const plan = resolveSessionAttentionReminderRefreshPlan({ nowMs, reminders: params.reminders });
        const invalidatedServerIds = new Set<string>();
        for (const reminder of plan.due) {
            if (params.connectedByServerId[reminder.address.serverId] !== true) continue;
            const token = reminderToken(reminder);
            if (completedTokensRef.current.has(token) || inFlightTokensRef.current.has(token)) continue;
            inFlightTokensRef.current.add(token);
            if (!invalidatedServerIds.has(reminder.address.serverId)) {
                invalidatedServerIds.add(reminder.address.serverId);
                void params.invalidateSessionListQueryHome(reminder.address.serverId);
            }
            void params.refreshSession(reminder.address).then(
                (result) => {
                    inFlightTokensRef.current.delete(token);
                    if (result.kind !== 'retryable_failure') completedTokensRef.current.add(token);
                },
                () => {
                    inFlightTokensRef.current.delete(token);
                },
            );
        }

        if (plan.nextDeadlineAt === null) return undefined;
        const timeout = setTimeout(
            () => setWakeRevision((value) => value + 1),
            Math.min(MAX_TIMER_DELAY_MS, Math.max(1, plan.nextDeadlineAt - nowMs)),
        );
        return () => clearTimeout(timeout);
    }, [params.catchUpServerId, params.connectedByServerId, params.invalidateSessionListQueryHome, params.refreshReminderInventory, params.refreshSession, params.reminders, wakeRevision]);
}
