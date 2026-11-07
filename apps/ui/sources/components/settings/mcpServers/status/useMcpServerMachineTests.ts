import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { McpServerTestFact } from './mcpServerStatus';

export type McpServerMachineTest = McpServerTestFact & Readonly<{ stderrTail?: string; durationMs?: number; message?: string }>;
type Results = Readonly<Record<string, McpServerMachineTest | undefined>>;
type Snapshot = Readonly<{ results: Results; running: ReadonlySet<string> }>;
type Entry = { configuration: string; pluginDefinition?: McpServerCatalogEntryV1; snapshot: Snapshot };
type Partition = { entries: ReadonlyMap<string, Entry>; listeners: Set<() => void>; invalidate: (serverId?: string) => void };
const EMPTY: Snapshot = Object.freeze({ results: {}, running: new Set<string>() });
const EMPTY_ENTRIES: ReadonlyMap<string, Entry> = new Map();

// On-demand facts survive reopening only within the incumbent Account lifetime and tested configuration.
const sessionResults = new WeakMap<ActiveServerAccountScopeLifetime, Partition>();

function configuration(lifetime: ActiveServerAccountScopeLifetime, serverId: string, pluginDefinition?: McpServerCatalogEntryV1): string | null {
    const catalog = getMcpServerCatalogSnapshot(lifetime.scope).value;
    const server = catalog?.servers.find(server => server.id === serverId)
        ?? (serverId.startsWith('plugin:') ? pluginDefinition : undefined);
    return server ? stableJsonStringify([server.name, server.transport, server.stdio, server.remote, server.env,
        server.configOverrides]) : null;
}

function partitionFor(lifetime: ActiveServerAccountScopeLifetime): Partition {
    const existing = sessionResults.get(lifetime);
    if (existing) return existing;
    const partition: Partition = { entries: new Map(), listeners: new Set(), invalidate: serverId => {
        // A refresh retains facts; a proven configuration change or deletion retires them, even with no page open.
        const next = new Map(partition.entries);
        for (const [id, entry] of partition.entries) {
            if (serverId !== undefined && id !== serverId) continue;
            if (configuration(lifetime, id, entry.pluginDefinition) === entry.configuration) continue;
            next.delete(id);
        }
        if (next.size !== partition.entries.size) {
            partition.entries = next;
            for (const listener of partition.listeners) listener();
        }
    } };
    sessionResults.set(lifetime, partition);
    const unsubscribe = subscribeMcpServerCatalogSnapshots(() => partition.invalidate());
    lifetime.onRetire(() => {
        unsubscribe();
        partition.entries = EMPTY_ENTRIES;
        sessionResults.delete(lifetime);
        for (const listener of partition.listeners) listener();
    });
    return partition;
}

/** Read the Test owner's held results without starting a Test or mounting one controller per server. */
export function useHeldMcpServerMachineTests(): ReadonlyMap<string, Results> {
    const lifetime = useActiveServerAccountScopeLifetime();
    const partition = React.useMemo(() => lifetime ? partitionFor(lifetime) : null, [lifetime]);
    const read = React.useCallback(() => lifetime?.isCurrent() && partition ? partition.entries : EMPTY_ENTRIES,
        [lifetime, partition]);
    const subscribe = React.useCallback((listener: () => void) => {
        partition?.listeners.add(listener);
        return () => { partition?.listeners.delete(listener); };
    }, [partition]);
    const entries = React.useSyncExternalStore(subscribe, read, read);
    return React.useMemo(() => new Map([...entries].map(([id, entry]) => [id, entry.snapshot.results])), [entries]);
}

/** The canonical Test Action, with late answers fenced by the Account and configuration that requested them. */
export function useMcpServerMachineTests(serverId: string, pluginDefinition?: McpServerCatalogEntryV1) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const execution = useMountedActionExecution(lifetime?.scope ?? null);
    const partition = React.useMemo(() => lifetime ? partitionFor(lifetime) : null, [lifetime]);
    const read = React.useCallback(() => {
        if (!lifetime?.isCurrent() || !partition) return EMPTY;
        return partition.entries.get(serverId)?.snapshot ?? EMPTY;
    }, [lifetime, partition, serverId]);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!partition) return () => {};
        partition.listeners.add(listener);
        return () => { partition.listeners.delete(listener); };
    }, [partition]);
    const snapshot = React.useSyncExternalStore(subscribe, read, read);
    React.useLayoutEffect(() => {
        // Plugin declarations arrive through the detail input, not the Account catalog publisher.
        if (!partition || !serverId.startsWith('plugin:')) return;
        const entry = partition.entries.get(serverId);
        if (!entry) return;
        entry.pluginDefinition = pluginDefinition;
        partition.invalidate(serverId);
    }, [partition, serverId, pluginDefinition]);
    const run = React.useCallback((machineIds: readonly string[]) => {
        if (!lifetime?.isCurrent() || !partition || !execution.ready) return;
        const signature = configuration(lifetime, serverId, pluginDefinition);
        if (!signature) return;
        const previous = partition.entries.get(serverId);
        const entry: Entry = previous?.configuration === signature ? previous
            : { configuration: signature, ...(serverId.startsWith('plugin:') ? { pluginDefinition } : {}), snapshot: EMPTY };
        const current = () => lifetime.isCurrent() && partition.entries.get(serverId) === entry;
        const emit = () => {
            partition.entries = new Map(partition.entries).set(serverId, entry);
            for (const listener of partition.listeners) listener();
        };
        const targets = [...new Set(machineIds)].filter(id => !entry.snapshot.running.has(id));
        if (targets.length === 0) return;
        entry.snapshot = { ...entry.snapshot, running: new Set([...entry.snapshot.running, ...targets]) };
        emit();
        for (const machineId of targets) void (async () => {
            const receipt = await execution.execute('mcp.servers.test', { t: 'byId', machineId, directory: '/', serverId }).catch(() => null);
            if (!current()) return;
            const parsed = receipt?.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].safeParse(receipt.result) : null;
            const checkedAt = Date.now();
            const response = parsed?.success ? parsed.data : null;
            const result: McpServerMachineTest = response ? response.ok
                ? { ok: true, toolCount: response.toolCount, checkedAt, durationMs: response.durationMs, ...(response.stderrTail ? { stderrTail: response.stderrTail } : {}) }
                : { ok: false, errorCode: response.errorCode, message: response.error, checkedAt, durationMs: response.durationMs,
                    ...(response.runtimeMissing ? { runtimeMissing: response.runtimeMissing } : {}), ...(response.stderrTail ? { stderrTail: response.stderrTail } : {}) }
                : { ok: false, errorCode: receipt && !receipt.ok ? receipt.errorCode ?? 'test_failed' : 'test_failed',
                    ...(receipt && !receipt.ok && receipt.error ? { message: receipt.error } : {}), checkedAt };
            const running = new Set(entry.snapshot.running);
            running.delete(machineId);
            entry.snapshot = { results: { ...entry.snapshot.results, [machineId]: result }, running };
            emit();
        })();
    }, [execution.execute, execution.ready, lifetime, partition, serverId, pluginDefinition]);
    return React.useMemo(() => ({ ...snapshot, run }), [snapshot, run]);
}
