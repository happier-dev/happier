import * as React from 'react';

import { describeMachinePresenceCounts } from '@/components/machines/MachinePresenceCounts';
import {
    describeMachinesRailTooltip,
    readMachinePublishedResources,
    type MachineAttentionSubject,
} from '@/components/machines/summary/machineResourceSentences';
import type { MachineResourceAutomaticActionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useMachineResourceFleetAttention, type MachineResourceFleetAttention } from '@/sync/domains/machines/resources/useMachineResourceFleetAttention';
import { useMachinePresenceCounts } from '@/sync/domains/state/storage';
import { useMachinesRailSeen } from '@/sync/domains/state/machineAdministrationUiState';
import { storage } from '@/sync/domains/state/storageStore';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { resolveAppRailBadgeTone, type AppRailBadgeSignal } from './AppRailBadge';

/** What this device has seen within one exact Account and Home. */
export type MachinesRailSeen = Readonly<{ look: Readonly<Record<string, readonly string[]>>; guardSeenAt: number }>;

export type MachinesRailLevel = 'needs_you' | 'look' | 'guard';

/**
 * The rail icon's one badge rule (R4, MPG-15): a count of the machines that need you now (until they
 * recover); else a dot for a "worth a look" reason this device has not seen since it appeared or got
 * worse; else a muted dot when the guard acted since the popover was last opened; else nothing (calm
 * and offline say nothing).
 */
export function resolveMachinesRailSignal(input: Readonly<{ fleet: MachineResourceFleetAttention; seen: MachinesRailSeen }>): Readonly<{
    level: MachinesRailLevel | null;
    signal: AppRailBadgeSignal | null;
}> {
    const { fleet, seen } = input;
    if (fleet.needsYou.length > 0) {
        return { level: 'needs_you', signal: { kind: 'count', value: fleet.needsYou.length, tone: resolveAppRailBadgeTone({ source: 'machines', level: 'needs_you' }) } };
    }
    if (fleet.look.some(entry => !(seen.look[entry.machineKey] ?? []).includes(entry.reasonKey))) {
        return { level: 'look', signal: { kind: 'dot', tone: resolveAppRailBadgeTone({ source: 'machines', level: 'look' }) } };
    }
    if (fleet.lastAutomaticActionAt !== null && fleet.lastAutomaticActionAt > seen.guardSeenAt) {
        return { level: 'guard', signal: { kind: 'dot', tone: resolveAppRailBadgeTone({ source: 'machines', level: 'guard' }) } };
    }
    return { level: null, signal: null };
}

/**
 * What opening the popover records (MPG-16): every current "worth a look" reason per machine (a machine
 * whose reasons are gone is dropped, so a later recurrence badges again) and the moment of opening.
 */
/** A fresh device-local navigation record, readable wherever `MachinesRailSeen` is. */
export function buildMachinesRailSeen(fleet: MachineResourceFleetAttention, nowMs: number): { look: Record<string, string[]>; guardSeenAt: number } {
    const look: Record<string, string[]> = {};
    for (const entry of fleet.look) (look[entry.machineKey] ??= []).push(entry.reasonKey);
    return { look, guardSeenAt: nowMs };
}

/** Forget only reasons a reporting machine has actually recovered from; never acknowledge a new one. */
export function forgetRecoveredMachinesRailReasons(fleet: MachineResourceFleetAttention, seen: ReturnType<typeof buildMachinesRailSeen>): ReturnType<typeof buildMachinesRailSeen> {
    const reporting = new Set(fleet.reportingMachineKeys);
    const current = buildMachinesRailSeen(fleet, seen.guardSeenAt).look;
    let look = seen.look;
    for (const [machineKey, reasons] of Object.entries(seen.look)) {
        if (!reporting.has(machineKey)) continue;
        const retained = reasons.filter(reason => current[machineKey]?.includes(reason));
        if (retained.length === reasons.length) continue;
        if (look === seen.look) look = { ...look };
        if (retained.length > 0) look[machineKey] = retained;
        else delete look[machineKey];
    }
    return look === seen.look ? seen : { look, guardSeenAt: seen.guardSeenAt };
}

/**
 * The closed rail icon's signal, tooltip and accessible name. It reads only string-keyed projections — the
 * fleet attention, the seen record, presence counts, and (only while one is named) one machine's name and
 * published reason — so an unrelated machine update renders nothing (MPG-30).
 */
export function useMachinesRailSignal(): Readonly<{
    signal: AppRailBadgeSignal | null;
    level: MachinesRailLevel | null;
    /** The text after "Machines" in the tooltip and accessible name. */
    detail: string | null;
    fleet: MachineResourceFleetAttention;
}> {
    const fleet = useMachineResourceFleetAttention();
    const seen = useMachinesRailSeen(fleet.accountScope);
    const counts = useMachinePresenceCounts();
    const { level, signal } = React.useMemo(() => resolveMachinesRailSignal({ fleet, seen }), [fleet, seen]);
    // The one machine the tooltip names: the headline (needs you or the look shown), or the guard's latest.
    const namedKey = level === 'guard' ? 'guard' : fleet.needsYou.length === 1 || level === 'look' ? JSON.stringify(fleet.headline?.machineKey ?? null) : null;
    const namedJson = storage(React.useCallback((state: ReturnType<typeof storage.getState>) => {
        if (!namedKey) return 'null';
        if (namedKey === 'guard') {
            let latest: { at: number; name: string; action: unknown } | null = null;
            for (const machine of Object.values(state.machines)) {
                const action = readMachinePublishedResources(machine.daemonState)?.lastAutomaticAction;
                if (action && (!latest || action.at > latest.at)) latest = { at: action.at, name: getMachineDisplayName(machine), action };
            }
            return JSON.stringify(latest);
        }
        const key = JSON.parse(namedKey) as { serverId?: string; machineId: string } | null;
        if (!key) return 'null';
        const machine = resolveServerScopedMachine(state, key.serverId ?? null, key.machineId);
        const published = machine ? readMachinePublishedResources(machine.daemonState) : null;
        return machine && published ? JSON.stringify({ name: getMachineDisplayName(machine), attention: published.attention }) : 'null';
    }, [namedKey]));
    const detail = React.useMemo(() => {
        const named = JSON.parse(namedJson) as Readonly<{ name: string; attention?: MachineAttentionSubject['attention']; action?: MachineResourceAutomaticActionV1 }> | null;
        return describeMachinesRailTooltip({
            needsYouCount: fleet.needsYou.length,
            subject: level !== 'guard' && named?.attention ? { name: named.name, attention: named.attention } : null,
            guard: level === 'guard' && named?.action ? { action: named.action, machineName: named.name } : null,
            presence: describeMachinePresenceCounts(counts) || null,
        });
    }, [counts, fleet.needsYou.length, level, namedJson]);
    return { signal, level, detail, fleet };
}
