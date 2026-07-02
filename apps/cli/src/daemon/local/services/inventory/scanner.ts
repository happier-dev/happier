import { classifyLocalServiceProcess } from './classification';
import type { LocalServiceInventoryStoredLabel } from './labels';
import {
    matchWorkspaceAssociation,
    recoverProcessLineageFacts,
    type LocalServiceProcessFact,
    type LocalServiceWorkspaceFact,
} from './provenance';

export type LocalServiceInventoryDiagnostic = Readonly<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message?: string;
}>;

export type LocalServiceListenerFact = Readonly<{
    address: string;
    port: number;
    protocol: 'tcp';
    pid?: number;
}>;

export type NormalizedLocalServiceInventoryEntry = Readonly<{
    id: string;
    machineId: string;
    address: Readonly<{
        kind: 'loopback' | 'wildcard' | 'lan' | 'unknown';
        host: string;
        family: 'ipv4' | 'ipv6' | 'unknown';
    }>;
    port: number;
    protocol: 'tcp';
    detectedAt: number;
    lastSeenAt: number;
    state: 'listening' | 'stale' | 'gone' | 'unknown';
    source: 'detected' | 'managed' | 'registered' | 'system';
    provenance?: Readonly<{
        process?: Readonly<{
            pid: number;
            ppid?: number;
            lineagePids: readonly number[];
            command: string;
            cwd?: string;
            redacted: true;
        }>;
        workspace?: Readonly<{
            id?: string;
            path: string;
            association: 'cwd_containment';
        }>;
    }>;
    classification?: ReturnType<typeof classifyLocalServiceProcess>;
    presentation?: Readonly<{
        displayName?: string;
        folderLabel?: string;
        addressLabel: string;
    }>;
    labels: readonly LocalServiceInventoryStoredLabel[];
    confidence: 'high' | 'medium' | 'low';
    processOwnershipConfidence: 'high' | 'medium' | 'low';
    workspaceAssociationConfidence: 'high' | 'medium' | 'low';
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

export type NormalizedLocalServiceInventorySnapshot = Readonly<{
    v: 1;
    machineId: string;
    generatedAt: number;
    refreshState: 'idle' | 'refreshing' | 'error';
    entries: readonly NormalizedLocalServiceInventoryEntry[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

function classifyAddress(host: string): NormalizedLocalServiceInventoryEntry['address'] {
    const normalized = host.toLowerCase();
    const family = normalized.includes(':') ? 'ipv6' : /^\d+\.\d+\.\d+\.\d+$/.test(normalized) ? 'ipv4' : 'unknown';
    if (normalized === '127.0.0.1' || normalized.startsWith('127.') || normalized === '::1' || normalized === 'localhost') {
        return { kind: 'loopback', host, family };
    }
    if (normalized === '0.0.0.0' || normalized === '::' || normalized === '*') {
        return { kind: 'wildcard', host, family };
    }
    if (
        normalized.startsWith('10.')
        || normalized.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
        || normalized.startsWith('169.254.')
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('fe80:')
    ) {
        return { kind: 'lan', host, family };
    }
    return { kind: 'unknown', host, family };
}

function addressKey(address: NormalizedLocalServiceInventoryEntry['address']): string {
    return `${address.kind}:${address.host}`;
}

function buildInventoryId(input: Readonly<{
    machineId: string;
    address: NormalizedLocalServiceInventoryEntry['address'];
    port: number;
    pid?: number;
}>): string {
    const pidPart = input.pid ? `pid-${input.pid}` : 'pid-unknown';
    return `${input.machineId}:tcp:${addressKey(input.address)}:${input.port}:${pidPart}`;
}

function addressLabel(address: NormalizedLocalServiceInventoryEntry['address'], port: number): string {
    if (address.kind === 'loopback') return `localhost:${port}`;
    return `${address.host}:${port}`;
}

function folderLabel(cwd: string | undefined): string | undefined {
    if (!cwd) return undefined;
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1);
}

export function normalizeLocalServiceScan(input: Readonly<{
    machineId: string;
    now: number;
    previous: NormalizedLocalServiceInventorySnapshot | null;
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    workspaces: readonly LocalServiceWorkspaceFact[];
    staleAfterMs?: number;
}>): NormalizedLocalServiceInventorySnapshot {
    const entries = new Map<string, NormalizedLocalServiceInventoryEntry>();
    const now = Math.max(0, Math.trunc(input.now));
    const staleAfterMs = input.staleAfterMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.trunc(input.staleAfterMs));

    for (const listener of input.listeners) {
        const address = classifyAddress(listener.address);
        const recovered = listener.pid
            ? recoverProcessLineageFacts({
                listenerPid: listener.pid,
                maxDepth: 4,
                processes: input.processes,
            })
            : undefined;
        const workspaceMatch = matchWorkspaceAssociation({
            cwd: recovered?.cwd,
            workspaces: input.workspaces,
        });
        const listenerProcess = listener.pid ? input.processes.get(listener.pid) : undefined;
        const classificationCommand = [listenerProcess?.command, recovered?.command].filter(Boolean).join(' ');
        const classification = classificationCommand
            ? classifyLocalServiceProcess({ command: classificationCommand, cwd: recovered?.cwd })
            : undefined;
        const id = buildInventoryId({
            machineId: input.machineId,
            address,
            port: listener.port,
            pid: listener.pid,
        });
        const presentation = {
            ...(classification?.displayName ? { displayName: classification.displayName } : {}),
            ...(folderLabel(recovered?.cwd) ? { folderLabel: folderLabel(recovered?.cwd) } : {}),
            addressLabel: addressLabel(address, listener.port),
        };
        entries.set(id, {
            id,
            machineId: input.machineId,
            address,
            port: listener.port,
            protocol: listener.protocol,
            detectedAt: input.previous?.entries.find((entry) => entry.id === id)?.detectedAt ?? now,
            lastSeenAt: now,
            state: 'listening',
            source: 'detected',
            ...(recovered || workspaceMatch.workspace
                ? {
                    provenance: {
                        ...(recovered ? { process: recovered } : {}),
                        ...(workspaceMatch.workspace ? { workspace: workspaceMatch.workspace } : {}),
                    },
                }
                : {}),
            ...(classification ? { classification } : {}),
            presentation,
            labels: [],
            confidence: listener.pid ? 'high' : 'medium',
            processOwnershipConfidence: listener.pid ? 'medium' : 'low',
            workspaceAssociationConfidence: workspaceMatch.workspaceAssociationConfidence,
            diagnostics: [],
        });
    }

    for (const previous of input.previous?.entries ?? []) {
        if (entries.has(previous.id)) continue;
        const missingAgeMs = now - previous.lastSeenAt;
        if (previous.state === 'gone' && missingAgeMs >= staleAfterMs * 2) {
            continue;
        }
        entries.set(previous.id, {
            ...previous,
            state: previous.state === 'stale' && missingAgeMs >= staleAfterMs
                ? 'gone'
                : previous.state === 'gone'
                    ? 'gone'
                    : 'stale',
        });
    }

    return {
        v: 1,
        machineId: input.machineId,
        generatedAt: now,
        refreshState: 'idle',
        entries: [...entries.values()].sort((a, b) => a.port - b.port || a.id.localeCompare(b.id)),
        diagnostics: [],
    };
}
