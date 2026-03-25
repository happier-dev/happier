import * as React from 'react';
import { InteractionManager } from 'react-native';

import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';

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
    const didPrefetchWizardMachineGlyphsRef = React.useRef(false);
    React.useEffect(() => {
        if (!params.enabled) return;
        if (didPrefetchWizardMachineGlyphsRef.current) return;
        didPrefetchWizardMachineGlyphsRef.current = true;

        InteractionManager.runAfterInteractions(() => {
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
    }, [params.favoriteMachineItems, params.machines, params.recentMachines, params.enabled]);

    // Cache-first + background refresh: for the actively selected machine, prefetch capabilities
    // if missing or stale. This updates the banners/agent availability on screen open, but avoids
    // any fetches on tap handlers.
    const lastPrefetchedSelectedMachineKeyRef = React.useRef<string | null>(null);
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
        if (lastPrefetchedSelectedMachineKeyRef.current === nextKey) return;
        lastPrefetchedSelectedMachineKeyRef.current = nextKey;

        InteractionManager.runAfterInteractions(() => {
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
    }, [params.enabled, params.machines, params.selectedMachineId, params.serverId, params.isMachineOnline, params.prefetchMachineCapabilitiesIfStale, params.request, params.staleMs]);
}
