import {
    applyLocalServiceInventorySnapshot,
    createLocalServiceInventoryState,
    type LocalServiceInventoryRow,
    type LocalServiceInventoryState,
} from '@/sync/domains/local/services/inventory/store';

export function buildLocalServiceInventoryRow(
    overrides: Partial<LocalServiceInventoryRow> = {},
): LocalServiceInventoryRow {
    return {
        id: 'inventory-1',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        ...overrides,
    };
}

export function buildLocalServiceInventoryState(input: Readonly<{
    machineId?: string;
    generatedAt?: number;
    refreshState?: 'idle' | 'refreshing' | 'error';
    rows?: readonly LocalServiceInventoryRow[];
    diagnostics?: readonly unknown[];
}> = {}): LocalServiceInventoryState {
    return applyLocalServiceInventorySnapshot(createLocalServiceInventoryState(), {
        v: 1,
        machineId: input.machineId ?? 'machine-a',
        generatedAt: input.generatedAt ?? 1_000,
        refreshState: input.refreshState ?? 'idle',
        entries: input.rows ?? [],
        diagnostics: input.diagnostics ?? [],
    });
}
