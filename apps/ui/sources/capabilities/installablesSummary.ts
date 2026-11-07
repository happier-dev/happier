import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { InstallableRegistryEntry } from './installablesRegistry';

export type InstallablesSummary =
    | Readonly<{ status: 'unknown' | 'loading' | 'unavailable' }>
    | Readonly<{ status: 'ready'; installed: number; ready: number; held: boolean }>;

/** A read of held inventory only. The caller owns the already-observed registry and cache state. */
export function summarizeInstallables(
    entries: readonly InstallableRegistryEntry[],
    state: MachineCapabilitiesCacheState | null,
): InstallablesSummary {
    if (!state || state.status === 'idle') return { status: 'unknown' };
    if (state.status === 'not-supported') return { status: 'unavailable' };
    const snapshot = state.snapshot;
    if (!snapshot) return { status: state.status === 'loading' ? 'loading' : 'unavailable' };
    let installed = 0;
    let ready = 0;
    let incomplete = false;
    for (const entry of entries) {
        if (!entry.enabledWhen()) continue;
        const result = entry.getDetectResult(snapshot.response.results);
        if (result?.ok === false) return { status: 'unavailable' };
        const status = entry.getStatus(snapshot.response.results);
        if (!status || typeof status.installed !== 'boolean') {
            incomplete = true;
            continue;
        }
        if (status.installed) {
            installed++;
            if (status.runtimeState === undefined || status.runtimeState === 'ready') ready++;
        }
    }
    if (incomplete) return { status: state.status === 'loading' ? 'loading' : state.status === 'error' ? 'unavailable' : 'unknown' };
    return { status: 'ready', installed, ready, held: state.status !== 'loaded' };
}
