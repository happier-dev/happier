import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

/** Resolves the ephemeral data-plane origin without changing the stable Home identity. */
export function resolveServerRuntimeOrigin(snapshot: Readonly<{
    serverUrl: string;
    runtimeOrigin?: string;
    carrier?: 'https' | 'iroh';
}>): string {
    if (snapshot.carrier === 'iroh' && typeof snapshot.runtimeOrigin === 'string' && snapshot.runtimeOrigin.trim()) {
        const candidate = snapshot.runtimeOrigin.trim().replace(/\/+$/, '');
        try {
            const parsed = new URL(candidate);
            if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
                return candidate;
            }
        } catch {
            // An invalid native origin must never replace the stable Home URL.
        }
    }
    return String(snapshot.serverUrl ?? '').trim().replace(/\/+$/, '');
}

export function resolveActiveServerRuntimeOrigin(snapshot: ActiveServerSnapshot): string {
    return resolveServerRuntimeOrigin(snapshot);
}
