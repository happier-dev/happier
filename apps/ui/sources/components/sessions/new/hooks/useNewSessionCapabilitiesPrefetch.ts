import * as React from 'react';

import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';

export function useNewSessionCapabilitiesPrefetch(params: Readonly<{
    enabled: boolean;
    serverId?: string | null;
    machines: ReadonlyArray<{ id: string; daemonStateVersion?: number }>;
    favoriteMachineItems: ReadonlyArray<{ id: string; daemonStateVersion?: number }>;
    recentMachines: ReadonlyArray<{ id: string; daemonStateVersion?: number }>;
    selectedMachineId: string | null;
    isMachineOnline: (machine: any) => boolean;
    staleMs: number;
    request: any;
    prefetchMachineCapabilitiesIfStale: (args: {
        machineId: string;
        serverId?: string | null;
        cacheKeySalt?: string | number | null;
        staleMs: number;
        request: any;
    }) => Promise<any> | void;
}>): void {
    // One-time prefetch of machine capabilities for the wizard machine list.
    // This keeps machine glyphs responsive (cache-only in the list) without
    // triggering per-row auto-detect work during taps.
    const wizardGlyphsPrefetchStateRef = React.useRef<{
        scheduledKey: string | null;
        completedKey: string | null;
    }>({ scheduledKey: null, completedKey: null });
    React.useEffect(() => {
        if (!params.enabled) return;
        const nextKey = String(params.serverId ?? '');
        if (wizardGlyphsPrefetchStateRef.current.completedKey === nextKey) return;
        if (wizardGlyphsPrefetchStateRef.current.scheduledKey === nextKey) return;

        wizardGlyphsPrefetchStateRef.current.scheduledKey = nextKey;
        let didRun = false;

        const cancel = runAfterInteractionsWithFallback(() => {
            didRun = true;
            wizardGlyphsPrefetchStateRef.current.completedKey = nextKey;
            if (wizardGlyphsPrefetchStateRef.current.scheduledKey === nextKey) {
                wizardGlyphsPrefetchStateRef.current.scheduledKey = null;
            }
            try {
                const candidates: string[] = [];
                for (const m of params.favoriteMachineItems) candidates.push(m.id);
                for (const m of params.recentMachines) candidates.push(m.id);
                for (const m of params.machines.slice(0, 8)) candidates.push(m.id);

                const seen = new Set<string>();
                const unique = candidates.filter((id) => {
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });

                // Limit to avoid a thundering herd on iOS.
                const toPrefetch = unique.slice(0, 12);
                for (const machineId of toPrefetch) {
                    const machine = params.machines.find((m) => m.id === machineId);
                    if (!machine) continue;
                    if (!params.isMachineOnline(machine)) continue;
                    fireAndForget(
                        Promise.resolve().then(() => params.prefetchMachineCapabilitiesIfStale({
                            machineId,
                            serverId: params.serverId,
                            cacheKeySalt: resolveDaemonCapabilitiesCacheKeySalt(machine),
                            staleMs: params.staleMs,
                            request: params.request,
                        })),
                        { tag: `useNewSessionCapabilitiesPrefetch.prefetchWizardMachineGlyphs:${machineId}` },
                    );
                }
            } catch {
                // best-effort prefetch only
            }
        });
        return () => {
            cancel();
            if (!didRun && wizardGlyphsPrefetchStateRef.current.scheduledKey === nextKey) {
                wizardGlyphsPrefetchStateRef.current.scheduledKey = null;
            }
        };
    }, [
        params.enabled,
        params.serverId,
        params.favoriteMachineItems,
        params.recentMachines,
        params.machines,
        params.isMachineOnline,
        params.prefetchMachineCapabilitiesIfStale,
        params.request,
        params.staleMs,
    ]);

    // Cache-first + background refresh: for the actively selected machine, prefetch capabilities
    // if missing or stale. This updates the banners/agent availability on screen open, but avoids
    // any fetches on tap handlers.
    const selectedMachinePrefetchStateRef = React.useRef<{
        scheduledKey: string | null;
        completedKey: string | null;
    }>({ scheduledKey: null, completedKey: null });
    React.useEffect(() => {
        if (!params.enabled) return;
        if (!params.selectedMachineId) return;
        const machine = params.machines.find((m) => m.id === params.selectedMachineId);
        if (!machine) return;
        if (!params.isMachineOnline(machine)) return;

        const nextKey = [
            machine.id,
            String(machine.daemonStateVersion ?? ''),
            String(params.serverId ?? ''),
        ].join('|');
        if (selectedMachinePrefetchStateRef.current.completedKey === nextKey) return;
        if (selectedMachinePrefetchStateRef.current.scheduledKey === nextKey) return;

        selectedMachinePrefetchStateRef.current.scheduledKey = nextKey;
        let didRun = false;

        const cancel = runAfterInteractionsWithFallback(() => {
            didRun = true;
            selectedMachinePrefetchStateRef.current.completedKey = nextKey;
            if (selectedMachinePrefetchStateRef.current.scheduledKey === nextKey) {
                selectedMachinePrefetchStateRef.current.scheduledKey = null;
            }
            fireAndForget(
                Promise.resolve().then(() => params.prefetchMachineCapabilitiesIfStale({
                    machineId: params.selectedMachineId!,
                    serverId: params.serverId,
                    cacheKeySalt: resolveDaemonCapabilitiesCacheKeySalt(machine),
                    staleMs: params.staleMs,
                    request: params.request,
                })),
                { tag: `useNewSessionCapabilitiesPrefetch.prefetchSelectedMachine:${params.selectedMachineId}` },
            );
        });
        return () => {
            cancel();
            if (!didRun && selectedMachinePrefetchStateRef.current.scheduledKey === nextKey) {
                selectedMachinePrefetchStateRef.current.scheduledKey = null;
            }
        };
    }, [params.enabled, params.machines, params.selectedMachineId, params.serverId, params.isMachineOnline, params.prefetchMachineCapabilitiesIfStale, params.request, params.staleMs]);
}
