import * as React from 'react';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedResourceKey, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * Which machine a Session uses for computer use, as this device has learned it from the surfaces that
 * already read it (an approval, a transcript row, the picker, the viewer). It is a hint for where to ask,
 * never a fact about the share: the computer owner on that machine answers whether a window is shared
 * and who is in control. Kept so the session-wide line can ask the right machine without every Session
 * that never used a computer issuing a machine RPC on open.
 */
type Entry = Readonly<{ machineId: string; machineName: string | null }>;

type ScopedEntry = {
    value: Entry;
    accountLifetime: ServerAccountScopeLifetime;
    retirement: Readonly<{ dispose(): void }> | null;
};
const entries = new Map<string, ScopedEntry>();
const listeners = new Map<string, Set<() => void>>();

function keyOf(sessionId: string | null, accountLifetime: ServerAccountScopeLifetime | null | undefined, serverId?: string | null): string | null {
    if (!sessionId?.trim() || !accountLifetime?.isCurrent()
        || !selectActiveServerAccountScopeForServer(accountLifetime.scope, serverId ?? accountLifetime.scope.serverId)) return null;
    return serverAccountScopedResourceKey(accountLifetime.scope, sessionId.trim());
}

function publish(key: string): void {
    for (const listener of listeners.get(key) ?? []) listener();
}

export function noteSessionComputerMachine(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
    machineId: string;
    machineName?: string | null;
}>): void {
    const machineId = input.machineId.trim();
    const accountLifetime = input.accountLifetime;
    const key = keyOf(input.sessionId, accountLifetime, input.serverId);
    if (!key || !accountLifetime || !machineId) return;
    const previous = entries.get(key);
    const machineName = input.machineName?.trim() || (previous?.value.machineId === machineId ? previous.value.machineName : null);
    if (previous?.accountLifetime === accountLifetime && previous.value.machineId === machineId && previous.value.machineName === machineName) return;
    previous?.retirement?.dispose();
    const entry: ScopedEntry = { value: { machineId, machineName }, accountLifetime, retirement: null };
    entries.set(key, entry);
    entry.retirement = accountLifetime.onRetire(() => {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        publish(key);
    });
    publish(key);
}

export function useSessionComputerMachine(sessionId: string | null, accountLifetime: ServerAccountScopeLifetime | null | undefined, serverId?: string | null): Entry | null {
    const key = keyOf(sessionId, accountLifetime, serverId);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!key) return () => {};
        const scoped = listeners.get(key) ?? new Set<() => void>();
        listeners.set(key, scoped);
        scoped.add(listener);
        return () => {
            scoped.delete(listener);
            if (scoped.size === 0) listeners.delete(key);
        };
    }, [key]);
    return React.useSyncExternalStore(
        subscribe,
        () => {
            const entry = key && accountLifetime?.isCurrent() ? entries.get(key) : null;
            return entry?.accountLifetime.isCurrent() ? entry.value : null;
        },
        () => null,
    );
}
