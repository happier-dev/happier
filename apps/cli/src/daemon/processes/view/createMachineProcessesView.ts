import type { MachineProcessesListInputV1, MachineProcessesGetInputV1, MachineProcessesGetResultV1,
    MachineProcessesCheckInputV1, MachineProcessesCheckResultV1, MachineProcessesWatchInputV1, MachineProcessesWatchResultV1, ProcessRowV1, NotHappierRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import { subscribeProcessLaunchDiscovery } from '@/processes/launchNotification';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import type { LocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';
import type { ProcessRoleCatalog } from '@/processes/classification/processRoleCatalog';
import type { ProcessCensusField, ProcessStartIdentity } from '@/processes/census/processCensus';
import { compareProcessPrincipals } from '@/processes/ownership/principal';
import { readProcessOwnershipBootTimeMs } from '../roots/listHappierProcessRoots';
import type { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import type { createLeftBehindPass } from '../leftBehind/leftBehindPass';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot, type ProcessOwnerRef } from '../ownership/types';
import { createProcessMetrics } from './processMetrics';
import { decodeProcessRef, processRef } from './processRef';
import { projectMachineProcesses, resolveMachineProcessesUnavailableReason, type ProcessRequester, type ProcessRequesterIdentity, type ProcessesProjectionInput, type ProcessesProjectionOptions, type ProcessOwnershipRead } from './projectMachineProcesses';

export type MachineProcessesViewOptions = Readonly<{
    processOwnershipRuntime: ReturnType<typeof createProcessOwnershipRuntime>;
    leftBehind: Pick<ReturnType<typeof createLeftBehindPass>, 'observe' | 'confirmed'>;
    machineVitals: Pick<MachineVitalsSampler, 'demand' | 'subscribe' | 'latest' | 'host'>;
    platform: 'linux' | 'darwin' | 'win32'; selfPid?: number; bootTimeMs?: number;
    allProcessesVisible(): boolean;
    requesterForOwner(owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[]): ProcessRequesterIdentity | null;
    onRequesterEvidenceUnavailable?: ProcessesProjectionOptions['onRequesterEvidenceUnavailable'];
    readRequesterIdentities?: () => Promise<ReadonlyMap<string, Readonly<{ accountId: string; displayName: string }>>>;
    localServiceRoutes?: Pick<LocalServiceInventoryRoutes, 'readCurrentSnapshot' | 'getSnapshot' | 'watchSnapshot'>;
    roleCatalog?: ProcessRoleCatalog;
    readCeiling?: ProcessesProjectionOptions['readCeiling'];
}>;

/** The view consumes ownership and the Left-behind pass; it never owns another census or ownership rule. */
export function createMachineProcessesView(options: MachineProcessesViewOptions) {
    const metrics = createProcessMetrics();
    let ports: NormalizedLocalServiceInventorySnapshot | undefined;
    let bootTimeMs = options.bootTimeMs;
    let latestRead: ProcessOwnershipRead | undefined;
    let latestMetricAtMs: number | undefined;
    const listeners = new Set<() => void>();
    const allProcessListeners = new Set<() => void>();
    let releaseLive: (() => void) | undefined;
    let unsubscribeVitals: (() => void) | undefined;
    let portsController: AbortController | undefined;
    let ticking: Promise<void> | undefined;
    let discoveryDirty = false;
    let disposed = false;
    let requesterIdentities: ReadonlyMap<string, Readonly<{ accountId: string; displayName: string }>> | undefined;
    const watches = new Set<AbortController>();
    // Native daemon handles support unref; shared UI ambient types also expose numeric handles.
    let metricExpiry: (ReturnType<typeof setTimeout> & Readonly<{ unref?: () => void }>) | undefined;
    const clearMetrics = () => { metrics.reset(); currentMetrics = new Map(); };
    const prepare = async () => {
        if (options.platform === 'linux' && bootTimeMs === undefined) bootTimeMs = await readProcessOwnershipBootTimeMs(options.platform);
    };
    const capture = async (freshness: 'shared' | 'fresh') => {
        // Discovery needs detached markers, fences and group peers across the
        // host, but executable paths only serve macOS application grouping.
        // CPU samples have their own visible-demand metrics owner below.
        const fields: readonly ProcessCensusField[] = ['argv', 'cwd', 'ownershipEnvironment', 'cgroup', 'memory',
            ...(options.platform === 'darwin' ? ['executablePath' as const] : [])];
        const read = await options.processOwnershipRuntime.readOwners({ freshness, fields });
        const identities = await options.readRequesterIdentities?.().catch(() => undefined);
        options.leftBehind.observe(read);
        return { read, identities };
    };
    let ownershipCapture: Promise<Awaited<ReturnType<typeof capture>>> | undefined;
    const captureDemands = new Set<() => boolean>();
    const captureWatch = async (freshness: 'shared' | 'fresh', demanded = () => !disposed) => {
        captureDemands.add(demanded);
        try {
            // Concurrent opens share the entire discovery drain, so an older
            // read cannot consume an edge and overwrite another watch's result.
            ownershipCapture ??= (async () => {
                let captured: Awaited<ReturnType<typeof capture>>;
                do {
                    const invalidated = discoveryDirty;
                    discoveryDirty = false;
                    captured = await capture(invalidated ? 'fresh' : freshness);
                    freshness = 'fresh';
                } while (discoveryDirty && [...captureDemands].some(isDemanded => isDemanded()));
                return captured;
            })().finally(() => { ownershipCapture = undefined; });
            return await ownershipCapture;
        } finally { captureDemands.delete(demanded); }
    };
    const project = (read: ProcessOwnershipRead, request: ProcessesProjectionInput & Readonly<{ historySince?: number }>, requester: ProcessRequester, watched = false,
        facts: Readonly<{ ports?: NormalizedLocalServiceInventorySnapshot; identities?: typeof requesterIdentities }> = {}) =>
        projectMachineProcesses(read, request, requester, { ...options, allProcessesVisible: options.allProcessesVisible(),
            confirmed: options.leftBehind.confirmed(), ports: facts.ports ?? ports, bootTimeMs, requesterIdentities: facts.identities ?? requesterIdentities,
            ...(watched ? { metrics: read === latestRead ? currentMetrics
                : new Map([...currentMetrics].filter(([, metric]) => !metric.identityUnavailable)),
                ...(request.view === 'tree' ? { history: (ref: string) => metrics.history(request.historySince, [ref])[ref] } : {}), capturedAtMs: latestMetricAtMs } : {}) });
    let currentMetrics: ReadonlyMap<number, import('./processMetrics').ProcessMetrics> = new Map();
    const notify = () => { for (const listener of listeners) listener(); };
    const discover = () => {
        if (disposed || ticking || !discoveryDirty || !listeners.size) return;
        ticking = (async () => {
            const captured = await captureWatch('fresh', () => !disposed && listeners.size > 0);
            if (disposed || !listeners.size) return;
            latestRead = captured.read;
            latestMetricAtMs = captured.read.status === 'ok' ? captured.read.snapshot.capturedAtMs : undefined;
            requesterIdentities = captured.identities;
            notify();
        })().finally(() => { ticking = undefined; discover(); });
        void ticking.catch(() => {});
    };
    const unsubscribeLaunches = subscribeProcessLaunchDiscovery(() => {
        discoveryDirty = true;
        discover();
    });
    async function followPorts(signal: AbortSignal, publish: () => void) {
        const routes = options.localServiceRoutes;
        if (!routes) return;
        try {
            const initial = await routes.getSnapshot();
            if (signal.aborted) return;
            const changed = ports?.generatedAt !== initial.generatedAt;
            ports = initial;
            if (changed && latestRead) publish();
            while (!signal.aborted) {
                const answer = await routes.watchSnapshot({ sinceGeneratedAt: ports.generatedAt, signal });
                if (signal.aborted) return;
                if (answer.changed) { ports = answer.snapshot; if (latestRead) publish(); }
            }
        } catch { /* Inventory failure cannot manufacture process evidence or start a competing scanner. */ }
    }
    function subscribe(listener: () => void, scope: ProcessesProjectionInput['scope']) {
        listeners.add(listener);
        if (scope === 'all') allProcessListeners.add(listener);
        if (listeners.size === 1) {
            clearTimeout(metricExpiry); metricExpiry = undefined;
            const controller = new AbortController();
            portsController = controller;
            let firstMetricObservation = true;
            unsubscribeVitals = options.machineVitals.subscribe(({ sample }) => {
                const ownership = latestRead;
                if (ticking || ownership?.status !== 'ok') return;
                ticking = (async () => {
                    const metricPids = ownership.rows.flatMap(row => row.owner || allProcessListeners.size > 0 ? [row.pid] : []);
                    const snapshot = await options.processOwnershipRuntime.readProcessMetrics(metricPids);
                    if (disposed || controller.signal.aborted || !listeners.size) return;
                    if (snapshot.status === 'ok') {
                        const sampled = new Set(metricPids);
                        const observed = new Map(snapshot.rows.map(row => [row.pid, row]));
                        const partial = new Set(snapshot.partial?.filter(item => !observed.has(item.pid) || item.missing.includes('start')).map(item => item.pid));
                        // Only positive absence or a different birth retires cached
                        // ownership. An unreadable generation remains uncertain.
                        const retained = (row: { pid: number; start: ProcessStartIdentity }) =>
                            !sampled.has(row.pid) || partial.has(row.pid)
                            || !!observed.get(row.pid) && equalProcessStart(row.start, observed.get(row.pid)!.start);
                        const rows = ownership.rows.filter(retained);
                        if (latestRead === ownership && rows.length !== ownership.rows.length) latestRead = { ...ownership, rows,
                            snapshot: { ...ownership.snapshot, rows: ownership.snapshot.rows.filter(retained) } };
                        const owners = new Map<string, Map<number, string>>();
                        for (const row of rows) if (row.owner && row.level !== 'left_behind' && row.level !== 'not_happier') {
                            const key = processOwnerKey(row.owner);
                            const refs = owners.get(key) ?? new Map<number, string>();
                            refs.set(row.pid, processRef(row.pid, row.start)); owners.set(key, refs);
                        }
                        const principal = observed.get(options.selfPid ?? process.pid)?.principal ?? null;
                        const prior = new Map(ownership.snapshot.rows.map(row => [row.pid, row]));
                        const priorPrincipal = prior.get(options.selfPid ?? process.pid)?.principal ?? null;
                        const identityUnavailable = new Map<number, string>();
                        for (const row of rows) if (sampled.has(row.pid)) {
                            const current = observed.get(row.pid);
                            const previousPrincipal = prior.get(row.pid)?.principal ?? null;
                            const principalUncertain = current && (compareProcessPrincipals(current.principal, previousPrincipal) !== 'self'
                                || compareProcessPrincipals(previousPrincipal, priorPrincipal) === 'self'
                                    && compareProcessPrincipals(current.principal, principal) !== 'self');
                            if (!partial.has(row.pid) && !principalUncertain) continue;
                            identityUnavailable.set(row.pid, processRef(row.pid, row.start));
                        }
                        currentMetrics = metrics.observe(snapshot, sample.intervalMs, owners, identityUnavailable, options.machineVitals.host()?.effectiveCores);
                        latestMetricAtMs = snapshot.capturedAtMs;
                        // A cold or expired CPU baseline needs two observations in
                        // this active watch. Returning after the first would let
                        // transport/re-arm gaps expire that baseline on every poll.
                        const needsCpuBaseline = firstMetricObservation && snapshot.rows.some(row => row.cpuTimeUs !== null && !identityUnavailable.has(row.pid))
                            && ![...currentMetrics.values()].some(metric => metric.cpuPercent !== undefined);
                        if (needsCpuBaseline) return;
                    }
                    else clearMetrics();
                    firstMetricObservation = false;
                    notify();
                })().finally(() => { ticking = undefined; discover(); });
                void ticking.catch(() => {});
            });
            releaseLive = options.machineVitals.demand('live');
            // Inventory enrichment joins the next measured answer; it must not
            // end a cold watch before that watch has observed its CPU baseline.
            void followPorts(controller.signal, () => { if (!firstMetricObservation) notify(); });
            discover();
        }
        return () => {
            listeners.delete(listener);
            allProcessListeners.delete(listener);
            if (!listeners.size) {
                unsubscribeVitals?.(); unsubscribeVitals = undefined;
                releaseLive?.(); releaseLive = undefined;
                portsController?.abort(); portsController = undefined;
                // The existing parked-watch boundary lets the client re-arm without
                // repeating the ownership census or losing its metrics baseline.
                if (disposed) clearMetrics();
                else {
                    metricExpiry = setTimeout(() => {
                        metricExpiry = undefined; clearMetrics(); latestRead = undefined; latestMetricAtMs = undefined; ports = undefined;
                    }, MACHINE_WATCH_WINDOW_MS);
                    metricExpiry.unref?.();
                }
                requesterIdentities = undefined;
            }
        };
    }
    const scope = (requester: ProcessRequester) => requester.accountId === requester.custodianAccountId && options.allProcessesVisible() ? 'all' as const : 'happier' as const;
    async function list(request: MachineProcessesListInputV1, requester: ProcessRequester) {
        await prepare();
        // Port presentation follows the inventory watch. Unrelated endpoint/HTTP
        // probes must not hold the custody rows (or their fresh identity checks).
        const observedPorts = options.localServiceRoutes?.readCurrentSnapshot();
        const { read, identities } = await capture('shared');
        return project(read, { ...request, scope: request.scope ?? 'happier', view: request.view ?? 'tree' }, requester, false, { ports: observedPorts, identities });
    }
    async function detailed(request: MachineProcessesGetInputV1 | MachineProcessesCheckInputV1, requester: ProcessRequester, detailToken?: string) {
        await prepare();
        const observedPorts = options.localServiceRoutes?.readCurrentSnapshot();
        const { read, identities } = await capture('fresh');
        if (read.status !== 'ok') throw new Error(`Process evidence unavailable: ${read.reason}`);
        const answer = project(read, { machineId: request.machineId, scope: scope(requester), view: 'tree', ...(detailToken ? { detailToken } : {}) }, requester, true, { identities, ports: observedPorts });
        if (answer.state === 'unavailable') throw new Error(`Process evidence unavailable: ${answer.reason}`);
        return answer;
    }
    function visibleRows(answer: ReturnType<typeof project>): Array<ProcessRowV1 | NotHappierRowV1> {
        return [...answer.owners.flatMap(owner => owner.members), ...answer.leftBehind, ...(answer.notHappier?.flatMap(group => group.members) ?? [])];
    }
    return {
        list,
        async watch(request: MachineProcessesWatchInputV1, requester: ProcessRequester, signal?: AbortSignal): Promise<MachineProcessesWatchResultV1> {
            await prepare();
            if (signal?.aborted || disposed) return { changed: false };
            if (request.since === undefined || request.scope === 'all' && (requester.accountId !== requester.custodianAccountId || !options.allProcessesVisible())) {
                const { read, identities } = await captureWatch('shared', () => !disposed && !signal?.aborted);
                if (signal?.aborted || disposed) return { changed: false };
                latestRead = read;
                latestMetricAtMs = read.status === 'ok' ? read.snapshot.capturedAtMs : undefined;
                ports = options.localServiceRoutes?.readCurrentSnapshot();
                return { changed: true, answer: project(read, request, requester, false, { identities, ports }) };
            }
            let ownershipAtArm = latestRead;
            let since = request.since;
            const refreshForDiscovery = discoveryDirty;
            const ownershipCapturedAtMs = latestRead?.status === 'ok' ? latestRead.snapshot.capturedAtMs : undefined;
            if (discoveryDirty || ownershipCapturedAtMs === undefined || Date.now() - ownershipCapturedAtMs >= MACHINE_WATCH_WINDOW_MS) {
                const captured = await captureWatch('shared', () => !disposed && !signal?.aborted);
                if (signal?.aborted || disposed) return { changed: false };
                latestRead = captured.read;
                latestMetricAtMs = captured.read.status === 'ok' ? captured.read.snapshot.capturedAtMs : undefined;
                requesterIdentities = captured.identities;
                if (!refreshForDiscovery) {
                    // Expired custody was refreshed before parking. That read
                    // has no CPU delta; let this watch collect its metrics pair.
                    ownershipAtArm = latestRead;
                    since = Math.max(since, latestMetricAtMs ?? 0);
                }
            }
            const identities = await options.readRequesterIdentities?.().catch(() => undefined);
            if (signal?.aborted || disposed) return { changed: false };
            const read = () => project(latestRead!, request, requester, true);
            const newer = () => !!latestRead && (latestRead.status !== 'ok'
                || resolveMachineProcessesUnavailableReason(latestRead, request, requester, { platform: options.platform,
                    bootTimeMs, allProcessesVisible: options.allProcessesVisible() }) !== undefined
                || latestRead !== ownershipAtArm
                || (latestMetricAtMs ?? latestRead.snapshot.capturedAtMs) > since);
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) controller.abort();
            watches.add(controller);
            try {
                const answer = await parkWatch({ isNewer: newer,
                    subscribe: listener => { requesterIdentities = identities; return subscribe(listener, request.scope); }, read,
                    signal: controller.signal });
                return answer.changed ? { changed: true, answer: answer.snapshot } : { changed: false };
            } finally { watches.delete(controller); signal?.removeEventListener('abort', abort); }
        },
        async get(request: MachineProcessesGetInputV1, requester: ProcessRequester): Promise<MachineProcessesGetResultV1> {
            const answer = await detailed(request, requester, request.ref);
            const row = visibleRows(answer).find(candidate => candidate.ref === request.ref) ?? null;
            const owner = row ? answer.owners.find(candidate => candidate.members.some(member => member.ref === row.ref))?.owner
                ?? answer.leftBehind.find(candidate => candidate.ref === row.ref)?.owner : undefined;
            return { row, ...(owner ? { owner } : {}), ...(row && answer.history?.[row.ref] ? { history: [...answer.history[row.ref]] } : {}) };
        },
        async check(request: MachineProcessesCheckInputV1, requester: ProcessRequester): Promise<MachineProcessesCheckResultV1> {
            const answer = await detailed(request, requester);
            const rows = visibleRows(answer);
            return { checks: request.refs.map(ref => {
                const decoded = decodeProcessRef(ref);
                const row = decoded ? rows.find(candidate => candidate.pid === decoded.pid) : undefined;
                if (!row) return { ref, present: false, identityEqual: false };
                if (row.ref !== ref) return { ref, present: true, identityEqual: false };
                const owner = answer.owners.find(candidate => candidate.members.some(member => member.ref === ref))?.owner
                    ?? answer.leftBehind.find(candidate => candidate.ref === ref)?.owner;
                return { ref, present: true, identityEqual: true, level: 'level' in row ? row.level : 'not_happier', owner: owner ?? null, memoryBytes: row.memoryBytes };
            }) };
        },
        dispose() { disposed = true; for (const controller of watches) controller.abort();
            unsubscribeLaunches();
            unsubscribeVitals?.(); releaseLive?.(); portsController?.abort();
            clearTimeout(metricExpiry); metricExpiry = undefined; clearMetrics();
            ports = undefined; requesterIdentities = undefined; latestRead = undefined; latestMetricAtMs = undefined; },
    };
}
export type MachineProcessesView = ReturnType<typeof createMachineProcessesView>;
