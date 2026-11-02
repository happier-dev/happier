import { readFile } from 'node:fs/promises';
import { configuration } from '@/configuration';
import type { ProcessCensusSnapshot, ProcessStartIdentity } from '@/processes/census/processCensus';
import { parseProcessOwnerTag, resolveProcessOwnerScopeKey, type ProcessOwnerRef } from '@/processes/ownerTag';
import { ancestorsOf, indexCensus } from '@/processes/tree/processTree';
import { compareProcessPrincipals } from '@/processes/ownership/principal';
import { parseHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot } from '../ownership/types';

export type HappierProcessRootSource = Readonly<{
    owner: ProcessOwnerRef; pid: number; start?: ProcessStartIdentity;
    processStartTimeMs?: number; ownerCreatedAtMs?: number; ownerCreatedStartTimeMs?: number;
    live?: boolean; endedAtMs?: number; workspacePath?: string;
    state?: HappierProcessRoot['state'];
    containment?: HappierProcessRoot['containment']; stop?: HappierProcessRoot['stop'];
    /** Actual physical launch unit retained by the incumbent launch owner, not inferred from a Session ID. */
    linuxLaunchUnit?: string;
    startAgain?: HappierProcessRoot['startAgain'];
    requesterWorkAttributionV1?: HappierProcessRoot['requesterWorkAttributionV1'];
}>;
export type HappierProcessRootsInput = Readonly<{
    snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>;
    selfPid?: number; happierHomeDir?: string; daemonScopeKey?: string; platform?: NodeJS.Platform; bootTimeMs?: number;
    trackedSessions?: Iterable<Readonly<{ pid: number; sessionRunnerPid?: number; happySessionId?: string;
        processStartTimeMs?: number; ownerCreatedAtMs?: number; ownerCreatedStartTimeMs?: number;
        linuxLaunchUnit?: string;
        runnerProcessIdentity?: Readonly<{ pid: number; processStartTimeMs: number }>;
        stopRequestedAtMs?: number;
        requesterWorkAttributionV1?: HappierProcessRoot['requesterWorkAttributionV1'];
        happySessionMetadataFromLocalWebhook?: Readonly<{ path?: string }>; spawnOptions?: Readonly<{ directory?: string }> }>>;
    terminalRegistry?: TerminalProcessRegistry;
    terminalRequesterAttribution?: (terminalId: string) => HappierProcessRoot['requesterWorkAttributionV1'];
    managedServices?: readonly HappierProcessRootSource[];
    executionRuns?: readonly HappierProcessRootSource[];
    helperProcesses?: readonly HappierProcessRootSource[];
    /** Existing lifecycle owners supply ended facts; an arbitrary tag is never proof of an owner. */
    endedRoots?: readonly HappierProcessRootSource[];
}>;

/** Reattach's exact dead-marker witness supplies ended-owner facts without adopting a native PID. */
export function reconstructEndedSessionProcessRoot(input: Readonly<{
    marker: Pick<DaemonSessionMarker, 'pid' | 'happySessionId' | 'processStartTimeMs' | 'createdAt' | 'cwd' | 'requesterWorkAttributionV1'>;
    session: Readonly<{ pid: number; sessionId: string; processStartTimeMs?: number; recoveredLiveSession?: boolean }>;
    endedAtMs: number;
}>): HappierProcessRootSource | null {
    const { marker, session } = input;
    if (session.recoveredLiveSession || session.processStartTimeMs === undefined || marker.pid !== session.pid
        || marker.happySessionId !== session.sessionId || marker.processStartTimeMs !== session.processStartTimeMs) return null;
    return { owner: { kind: 'session', sessionId: session.sessionId }, pid: session.pid,
        start: { startTimeMs: session.processStartTimeMs },
        processStartTimeMs: session.processStartTimeMs, ownerCreatedAtMs: marker.createdAt,
        ...(marker.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: marker.requesterWorkAttributionV1 } : {}),
        live: false, endedAtMs: input.endedAtMs, ...(marker.cwd ? { workspacePath: marker.cwd } : {}) };
}

/** A promoted runner never borrows its wrapper's process birth. */
export function readTrackedSessionProcessIdentity(session: Readonly<{ pid: number; sessionRunnerPid?: number;
    processStartTimeMs?: number; runnerProcessIdentity?: Readonly<{ pid: number; processStartTimeMs: number }> }>) {
    const pid = session.sessionRunnerPid ?? session.pid;
    const processStartTimeMs = session.runnerProcessIdentity?.pid === pid
        ? session.runnerProcessIdentity.processStartTimeMs : pid === session.pid ? session.processStartTimeMs : undefined;
    return { pid, processStartTimeMs };
}

/** Projection of current lifecycle owners and their exact census generations, never another root store. */
export function listHappierProcessRoots(input: HappierProcessRootsInput): readonly HappierProcessRoot[] {
    const platform = input.platform ?? process.platform;
    const selfPid = input.selfPid ?? process.pid;
    const index = indexCensus(input.snapshot.rows);
    const self = index.byPid.get(selfPid);
    const scope = input.daemonScopeKey ?? resolveProcessOwnerScopeKey(input.happierHomeDir ?? configuration.happyHomeDir, platform);
    const sources: HappierProcessRootSource[] = [];
    if (self) sources.push({ owner: { kind: 'happier' }, pid: selfPid, start: self.start });
    for (const session of input.trackedSessions ?? []) {
        if (!session.happySessionId) continue;
        const { pid, processStartTimeMs } = readTrackedSessionProcessIdentity(session);
        sources.push({ owner: { kind: 'session', sessionId: session.happySessionId },
            pid, processStartTimeMs,
            ...(session.linuxLaunchUnit === undefined ? {} : { linuxLaunchUnit: session.linuxLaunchUnit }),
            ownerCreatedAtMs: session.ownerCreatedAtMs, ownerCreatedStartTimeMs: session.ownerCreatedStartTimeMs,
            ...(typeof session.stopRequestedAtMs === 'number' && Number.isFinite(session.stopRequestedAtMs) ? { state: 'stopping' as const } : {}),
            ...(session.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: session.requesterWorkAttributionV1 } : {}),
            workspacePath: session.happySessionMetadataFromLocalWebhook?.path ?? session.spawnOptions?.directory });
    }
    for (const terminal of input.terminalRegistry?.listProcesses() ?? []) {
        const native = index.byPid.get(terminal.pid);
        const tag = parseProcessOwnerTag(native?.ownerTag);
        // Registry terminalId is the incumbent launch identity, not native PID
        // custody. Join it to the native private marker before borrowing birth.
        if (!native || !tag || tag.daemonScopeKey !== scope || tag.owner.kind !== 'terminal'
            || tag.owner.terminalId !== terminal.terminalId || !self
            || compareProcessPrincipals(native.principal, self.principal) !== 'self') continue;
        const requesterWorkAttributionV1 = input.terminalRequesterAttribution?.(terminal.terminalId);
        sources.push({ owner: { kind: 'terminal', terminalId: terminal.terminalId, ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}) },
            pid: terminal.pid, start: native.start, workspacePath: terminal.workspacePath,
            ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}) });
    }
    sources.push(...input.managedServices ?? [], ...input.executionRuns ?? [], ...input.helperProcesses ?? [], ...input.endedRoots ?? []);
    // The component tag is written only by the named spawn owner. A current daemon chain
    // supplies its live lifetime without a parallel registration collection.
    for (const row of input.snapshot.rows) {
        const tag = parseProcessOwnerTag(row.ownerTag);
        if (!tag || tag.daemonScopeKey !== scope || !self || row.pid === selfPid
            || compareProcessPrincipals(row.principal, self.principal) !== 'self') continue;
        if (tag.owner.kind !== 'happier' && tag.owner.kind !== 'workspace_sync' && tag.owner.kind !== 'browser_sidecar') continue;
        const underCurrentDaemon = ancestorsOf(index, row.pid).some(ancestor => ancestor.pid === selfPid && equalProcessStart(ancestor.start, self.start));
        // Fixed daemon/helper tags identify previous incumbents only when the native
        // generation predates this daemon. Post-start detached tags remain unknown.
        if (!underCurrentDaemon && row.start.startTimeMs >= self.start.startTimeMs) continue;
        const parent = index.byPid.get(row.ppid ?? -1);
        // Inherited helper tags name one root; descendants remain members of that root.
        if (parent?.ownerTag === row.ownerTag) continue;
        sources.push({ owner: tag.owner, pid: row.pid, start: row.start,
            ...(!underCurrentDaemon ? { live: false, endedAtMs: platform === 'linux'
                ? input.bootTimeMs === undefined ? undefined : input.bootTimeMs + self.start.startTimeMs
                : self.start.startTimeMs } : {}) });
    }
    const out = new Map<string, HappierProcessRoot>();
    for (const source of sources) {
        const row = index.byPid.get(source.pid);
        if (source.start === undefined && source.processStartTimeMs === undefined
            && (source.owner.kind === 'service' || source.owner.kind === 'run')) {
            const tag = parseProcessOwnerTag(row?.ownerTag);
            if (!tag || tag.daemonScopeKey !== scope || processOwnerKey(tag.owner) !== processOwnerKey(source.owner)
                || !self || compareProcessPrincipals(row?.principal ?? null, self.principal) !== 'self') continue;
        }
        const start = source.start ?? (source.processStartTimeMs === undefined ? row?.start : { startTimeMs: source.processStartTimeMs });
        if (!start) continue;
        const currentGeneration = row !== undefined && equalProcessStart(start, row.start);
        const live = source.live !== false && currentGeneration;
        const nativeCreatedAt = platform === 'linux' && input.bootTimeMs !== undefined
            ? input.bootTimeMs + start.startTimeMs : platform === 'linux' ? input.snapshot.capturedAtMs : start.startTimeMs;
        // Initial marker persistence can follow child launch; the native runner birth
        // is the earlier authoritative floor. Original creation still survives resume.
        const createdAt = source.ownerCreatedAtMs === undefined ? nativeCreatedAt : Math.min(source.ownerCreatedAtMs, nativeCreatedAt);
        const root: HappierProcessRoot = { owner: source.owner, pid: source.pid, start, live, ownerCreatedAtMs: createdAt,
            ...(live && source.state ? { state: source.state } : {}),
            ...(platform === 'linux' ? { ownerCreatedStartTimeMs: Math.min(start.startTimeMs, source.ownerCreatedStartTimeMs
                ?? (source.ownerCreatedAtMs !== undefined && input.bootTimeMs !== undefined ? Math.max(0, createdAt - input.bootTimeMs) : start.startTimeMs)) } : {}),
            ...(source.endedAtMs === undefined ? {} : { endedAtMs: source.endedAtMs }),
            ...(source.workspacePath ? { workspacePath: source.workspacePath } : {}),
            ...(source.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: source.requesterWorkAttributionV1 } : {}),
            ...(source.startAgain ? { startAgain: source.startAgain } : {}),
            ...(source.containment ? { containment: source.containment } : {}), ...(source.stop ? { stop: source.stop } : {}) };
        // Fence membership is observed on the real root and then checked by every row.
        const parts = row?.cgroup?.split('/') ?? [];
        const canObserveUnit = platform === 'linux' && currentGeneration && self
            && compareProcessPrincipals(row?.principal ?? null, self.principal) === 'self'
            && row?.cgroup?.startsWith('/') && !parts.some(part => part === '.' || part === '..');
        const unitIndex = canObserveUnit ? parts.findIndex(part => {
            const parsed = parseHappierLinuxScopeName(part);
            if (parsed?.daemonScopeKey !== scope) return false;
            // A fresh runner reports its canonical Session only after launch. Its
            // physical unit may encode the launching Happier owner instead. Exact
            // launch custody + witnessed runner birth + native membership is the
            // join; a shared cgroup or a recycled PID cannot substitute for it.
            return source.linuxLaunchUnit === undefined
                ? processOwnerKey(parsed.owner) === processOwnerKey(root.owner)
                : part === source.linuxLaunchUnit && (source.start !== undefined || source.processStartTimeMs !== undefined);
        }) : -1;
        const containment = root.containment ?? (unitIndex >= 0
            ? { kind: 'linux_unit' as const, prefix: parts.slice(0, unitIndex + 1).join('/') } : undefined);
        const key = `${processOwnerKey(root.owner)}:${root.pid}`;
        const previous = out.get(key);
        if (!previous?.live || root.live) {
            // Native helper discovery enriches the same root; its inferred row cannot
            // erase the actual launch owner's Stop or lend it to a recycled PID.
            const stop = root.stop ?? (previous && equalProcessStart(previous.start, root.start) ? previous.stop : undefined);
            const startAgain = root.startAgain ?? (previous && equalProcessStart(previous.start, root.start) ? previous.startAgain : undefined);
            const requesterWorkAttributionV1 = root.requesterWorkAttributionV1
                ?? (previous && equalProcessStart(previous.start, root.start) ? previous.requesterWorkAttributionV1 : undefined);
            out.set(key, { ...root, ...(containment ? { containment } : {}), ...(stop ? { stop } : {}),
                ...(startAgain ? { startAgain } : {}),
                ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}) });
        }
    }
    return [...out.values()];
}

/** Linux's boot wall-time is an OS observation, not a changed persisted identity derivation. */
export async function readProcessOwnershipBootTimeMs(platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
    if (platform !== 'linux') return undefined;
    try {
        const stat = await readFile('/proc/stat', 'utf8');
        const value = /^btime\s+(\d+)$/mu.exec(stat)?.[1];
        return value === undefined ? undefined : Number(value) * 1000;
    } catch { return undefined; }
}

export type NativeContainerProcessSource = Readonly<{
    owner: Extract<ProcessOwnerRef, { kind: 'container' }>; pid: number;
    requesterWorkAttributionV1?: HappierProcessRoot['requesterWorkAttributionV1'];
    workspacePath?: string;
}>;
