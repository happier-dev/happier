import { classifyProcessRole as classifyLocalServiceProcess } from '@/processes/classification/classifyProcessRole';
import type { ProcessRoleCatalog } from '@/processes/classification/processRoleCatalog';
import { createProcessLineageProjector } from '@/processes/classification/projectProcessLineage';
import { resolveLocalServiceOwnership } from '@/daemon/processes/ownership/resolveLocalServiceOwnership';
import { processOwnerKey, type ResolvedProcessOwnership } from '@/daemon/processes/ownership/types';
import type { LocalServiceInventoryStoredLabel } from './labels';
import {
    matchWorkspaceAssociation,
    type LocalServiceProcessFact,
    type LocalServiceWorkspaceFact,
} from './provenance';
import type { TerminalProcessRegistry } from './terminalRegistry';
import type { LocalServiceEndpointFact } from './endpoint';
import { isLiteralLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';

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
    /** Missing socket observation is unknown, never zero visitors. */
    establishedConnections?: number | null;
}>;

export type NormalizedLocalServiceInventoryEntry = Readonly<{
    id: string;
    machineId: string;
    address: Readonly<{
        kind: 'loopback' | 'wildcard' | 'lan' | 'unknown';
        host: string;
        family: 'ipv4' | 'ipv6' | 'unknown';
    }>;
    endpoint?: LocalServiceEndpointFact;
    port: number;
    protocol: 'tcp';
    detectedAt: number;
    establishedConnections?: number | null;
    lastSeenAt: number;
    state: 'listening' | 'stale' | 'gone' | 'unknown';
    source: 'detected';
    provenance?: Readonly<{
        process?: Readonly<{
            pid: number;
            ppid?: number;
            processStartTimeMs?: number;
            lineagePids: readonly number[];
            command: string;
            cwd?: string;
            redacted: true;
        }>;
        session?: Readonly<{ id: string; turnId?: string }>;
        workspace?: Readonly<{
            id?: string;
            path: string;
            association: 'cwd_containment' | 'process_tree';
        }>;
    }>;
    classification?: Pick<ReturnType<typeof classifyLocalServiceProcess>, 'kind' | 'displayName' | 'confidence' | 'lowSignal' | 'signals'>;
    presentation?: Readonly<{
        pageTitle?: string;
        pageTitleSource?: 'application_name' | 'og_title' | 'twitter_title' | 'html_title';
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
    processStartTimeMs?: number;
}>): string {
    const pidPart = input.pid ? `pid-${input.pid}` : 'pid-unknown';
    const startPart = typeof input.processStartTimeMs === 'number' && Number.isFinite(input.processStartTimeMs)
        ? `start-${Math.max(0, Math.trunc(input.processStartTimeMs))}`
        : 'start-unknown';
    return `${input.machineId}:tcp:${addressKey(input.address)}:${input.port}:${pidPart}:${startPart}`;
}

function addressLabel(address: NormalizedLocalServiceInventoryEntry['address'], port: number): string {
    if (address.kind === 'loopback' || address.kind === 'wildcard') return `localhost:${port}`;
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
    terminalRegistry?: TerminalProcessRegistry;
    ownership?: readonly ResolvedProcessOwnership[];
    /** Private native FD failures, not an ownership claim or public inventory field. */
    socketOwnerReadFailures?: readonly number[];
    processRoleCatalog?: ProcessRoleCatalog;
    staleAfterMs?: number;
    /** Exact owned listener processes, never their arbitrary descendants. */
    internalProcessPids?: readonly number[];
    /** Configured Happier endpoint authorities, not command/title or bare-port guesses. */
    internalEndpointUrls?: readonly string[];
}>): NormalizedLocalServiceInventorySnapshot {
    const entries = new Map<string, NormalizedLocalServiceInventoryEntry>();
    const previousById = new Map(input.previous?.entries.map(entry => [entry.id, entry]));
    const ownershipByPid = new Map((input.ownership ?? resolveLocalServiceOwnership(input)).map(item => [item.pid, item]));
    const incompleteSocketOwners = new Set((input.socketOwnerReadFailures ?? []).flatMap(pid => {
        const owner = ownershipByPid.get(pid)?.owner;
        return owner ? [processOwnerKey(owner)] : [];
    }));
    const internalEndpoints = (input.internalEndpointUrls ?? []).flatMap((value) => {
        try {
            const url = new URL(value);
            const host = normalizeHostnameForLoopbackCheck(url.hostname);
            if (!isLiteralLoopbackHostname(host) || (url.protocol !== 'http:' && url.protocol !== 'https:')) return [];
            return [{ host, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }];
        } catch { return []; }
    });
    const now = Math.max(0, Math.trunc(input.now));
    const staleAfterMs = input.staleAfterMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.trunc(input.staleAfterMs));
    const projectProcessLineage = createProcessLineageProjector(input.processes);
    const isInternalListener = (listener: Pick<LocalServiceListenerFact, 'address' | 'port' | 'pid'>): boolean => {
        if (listener.pid !== undefined && input.internalProcessPids?.includes(listener.pid)) return true;
        const address = classifyAddress(listener.address);
        const host = normalizeHostnameForLoopbackCheck(address.host);
        return internalEndpoints.some(endpoint => {
            if (endpoint.port !== listener.port) return false;
            if (host === endpoint.host) return true;
            const localhost = endpoint.host === 'localhost';
            if (address.kind === 'loopback') return localhost && (host === '127.0.0.1' || host === '::1');
            if (address.kind !== 'wildcard') return false;
            return host === '*' || localhost
                || (address.family === 'ipv4' && !endpoint.host.includes(':'))
                || (address.family === 'ipv6' && endpoint.host.includes(':'));
        });
    };

    for (const listener of input.listeners) {
        if (isInternalListener(listener)) continue;
        const address = classifyAddress(listener.address);
        const recovered = listener.pid
            ? projectProcessLineage(listener.pid)
            : undefined;
        const owned = listener.pid === undefined ? undefined : ownershipByPid.get(listener.pid);
        const cwdMatch = matchWorkspaceAssociation({ cwd: recovered?.cwd, workspaces: input.workspaces });
        const workspaceMatch = owned?.workspacePath
            ? { workspace: { path: owned.workspacePath, association: 'process_tree' as const }, workspaceAssociationConfidence: 'high' as const }
            : cwdMatch;
        const ownerSessionId = owned?.owner?.kind === 'session' ? owned.owner.sessionId
            : owned?.owner && 'sessionId' in owned.owner ? owned.owner.sessionId : undefined;
        const sessionAttribution = ownerSessionId ? { id: ownerSessionId } : undefined;
        const listenerProcess = listener.pid ? input.processes.get(listener.pid) : undefined;
        const listenerClassification = listenerProcess?.command
            ? classifyLocalServiceProcess({ command: listenerProcess.command, cwd: listenerProcess.cwd, ...input.processRoleCatalog })
            : undefined;
        // A browser, shell or Agent does not become a web server through its launcher.
        // Generic runtime children still inherit their dev command's useful classification.
        const classification = listenerClassification?.role || listenerClassification?.lowSignal
            ? listenerClassification
            : recovered?.command && recovered.command !== listenerProcess?.command
                ? classifyLocalServiceProcess({ command: recovered.command, cwd: recovered.cwd, ...input.processRoleCatalog })
                : listenerClassification;
        const id = buildInventoryId({
            machineId: input.machineId,
            address,
            port: listener.port,
            pid: listener.pid,
            processStartTimeMs: listenerProcess?.processStartTimeMs,
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
            establishedConnections: owned?.owner && incompleteSocketOwners.has(processOwnerKey(owned.owner))
                ? null : listener.establishedConnections ?? null,
            detectedAt: previousById.get(id)?.detectedAt ?? now,
            lastSeenAt: now,
            state: 'listening',
            source: 'detected',
            ...(recovered || workspaceMatch.workspace || sessionAttribution
                ? {
                    provenance: {
                        ...(recovered ? { process: recovered } : {}),
                        ...(sessionAttribution ? { session: { id: sessionAttribution.id } } : {}),
                        ...(workspaceMatch.workspace ? { workspace: workspaceMatch.workspace } : {}),
                    },
                }
                : {}),
            ...(classification ? { classification: {
                kind: classification.kind, displayName: classification.displayName,
                confidence: classification.confidence, lowSignal: classification.lowSignal, signals: classification.signals,
            } } : {}),
            presentation,
            labels: [],
            confidence: listener.pid ? 'high' : 'medium',
            processOwnershipConfidence: owned?.level === 'proven' || owned?.level === 'likely' ? 'high'
                : !listener.pid || owned?.level === 'not_happier' ? 'low' : 'medium',
            workspaceAssociationConfidence: workspaceMatch.workspaceAssociationConfidence,
            diagnostics: [],
        });
    }

    for (const previous of input.previous?.entries ?? []) {
        if (isInternalListener({ address: previous.address.host, port: previous.port, pid: previous.provenance?.process?.pid })) continue;
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
