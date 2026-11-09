import type { MachineProcessesAnswerV1, MachineProcessesTotalsV1, OwnerRowV1, ProcessRowV1, LeftBehindRowV1, AppGroupRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { equalProcessStart, processOwnerKey, type ProcessOwnerRef, type HappierProcessRoot } from '../ownership/types';
import { resolveProcessOwnershipLevel } from '../ownership/levelRules';
import type { LeftBehindItem } from '../leftBehind/leftBehindTracker';
import { compareProcessPrincipals } from '@/processes/ownership/principal';
import { ancestorsOf, indexCensus } from '@/processes/tree/processTree';
import { classifyProcessRole, type LocalServiceProcessClassification } from '@/processes/classification/classifyProcessRole';
import { serviceOwnerDisplayName, serviceOwnerRole } from '@/lsp/processOwner';
import { readLanguageServerDefinitions } from '@/lsp/languageServerDefinitions';
import type { ProcessRoleCatalog } from '@/processes/classification/processRoleCatalog';
import { redactProcessCommand } from '@/processes/redaction/redactProcessCommand';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';
import { processRef } from './processRef';
import type { ProcessMetrics, ProcessMetricSample } from './processMetrics';

export type ProcessEnvironmentReadTarget = Readonly<{ serverId: string; environmentId: string }>;
export type ProcessRequester = Readonly<{ accountId: string; custodianAccountId: string;
    /** Captured Account read authority, never supplied by a Process request DTO. */
    canReadEnvironment?(target: ProcessEnvironmentReadTarget): Promise<boolean>;
}>;
export const processEnvironmentReadKey = (target: ProcessEnvironmentReadTarget): string => JSON.stringify([target.serverId, target.environmentId]);
export type ProcessRequesterIdentity = Readonly<{ accountId: string; displayName?: string }>;
export type ProcessRequesterEvidenceFailure = Readonly<{
    owner: ProcessOwnerRef;
    reason: 'requester_unavailable' | 'display_identity_unavailable';
}>;
export type ProcessOwnershipRead = Awaited<ReturnType<ReturnType<typeof createProcessOwnershipRuntime>['readOwners']>>;
export type ProcessesProjectionInput = Readonly<{
    machineId: string; scope: 'happier' | 'all'; view: 'tree' | 'owners'; detailToken?: string; sessionId?: string; query?: string;
}>;
export type ProcessesProjectionOptions = Readonly<{
    platform: 'linux' | 'darwin' | 'win32'; selfPid?: number; bootTimeMs?: number; allProcessesVisible: boolean;
    requesterForOwner(owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[]): ProcessRequesterIdentity | null;
    requesterIdentities?: ReadonlyMap<string, Readonly<{ accountId: string; displayName: string }>>;
    readableEnvironments?: ReadonlySet<string>;
    onRequesterEvidenceUnavailable?(failure: ProcessRequesterEvidenceFailure): void;
    confirmed: readonly LeftBehindItem[]; metrics?: ReadonlyMap<number, ProcessMetrics>;
    history?(ref: string): readonly ProcessMetricSample[] | undefined;
    capturedAtMs?: number;
    ports?: NormalizedLocalServiceInventorySnapshot; roleCatalog?: ProcessRoleCatalog;
    principalName?(row: ProcessCensusRow): string;
    readCeiling?(root: HappierProcessRoot): OwnerRowV1['ceiling'];
}>;
export function processTotals(rows: readonly Readonly<{ memoryBytes: number | null; cpuPercent?: number }>[]): MachineProcessesTotalsV1 {
    return { processCount: rows.length,
        memoryBytes: rows.some(row => row.memoryBytes === null) ? null : rows.reduce((sum, row) => sum + (row.memoryBytes ?? 0), 0),
        ...(rows.length && rows.some(row => row.cpuPercent === undefined) ? {} : { cpuPercent: Math.min(100, rows.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0)) }) };
}
function appGroup(row: ProcessCensusRow, platform: ProcessesProjectionOptions['platform']): string {
    if (platform === 'darwin') return row.executablePath?.split(/[\\/]/u).find(part => part.endsWith('.app'))?.slice(0, -4) || row.name;
    if (platform === 'linux') return row.cgroup?.split('/').reverse().find(part => /^app-.*\.scope$|\.service$/u.test(part)) || row.name;
    return row.name;
}
function belongsToSession(owner: ProcessOwnerRef, sessionId: string): boolean {
    return 'sessionId' in owner && owner.sessionId === sessionId;
}
function matches(row: ProcessRowV1, query: string | undefined): boolean {
    if (!query?.trim()) return true;
    return [row.name, row.command, row.role, row.browserEngine, row.driverLabel, String(row.pid), ...(row.ports?.map(port => String(port.port)) ?? [])]
        .some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
}

/** Availability needs no row projection; shared by answers and parked-watch admission. */
export function resolveMachineProcessesUnavailableReason(read: ProcessOwnershipRead, request: ProcessesProjectionInput,
    requester: ProcessRequester, options: Pick<ProcessesProjectionOptions, 'platform' | 'bootTimeMs' | 'allProcessesVisible'>
): MachineProcessesAnswerV1['reason'] {
    return read.status !== 'ok' ? read.reason : request.scope === 'all' && requester.accountId !== requester.custodianAccountId ? 'permission_denied'
        : request.scope === 'all' && !options.allProcessesVisible ? 'all_processes_disabled'
        : options.platform === 'linux' && options.bootTimeMs === undefined ? 'read_failed' : undefined;
}

/** Privacy is enforced on canonical ownership, before commands or histories enter any wire projection. */
export function projectMachineProcesses(read: ProcessOwnershipRead, request: ProcessesProjectionInput,
    requester: ProcessRequester, options: ProcessesProjectionOptions): MachineProcessesAnswerV1 {
    const zero = processTotals([]);
    const base = { v: 1 as const, machineId: request.machineId, capturedAtMs: options.capturedAtMs
        ?? (read.status === 'ok' ? read.snapshot.capturedAtMs : Date.now()),
        platform: options.platform, evidenceModel: options.platform === 'darwin' ? 'tree_and_marker' as const : 'fenced' as const };
    const custodian = requester.accountId === requester.custodianAccountId;
    const reason = resolveMachineProcessesUnavailableReason(read, request, requester, options);
    if (reason) return { ...base, state: 'unavailable', reason, owners: [], leftBehind: [], totals: { happier: zero, leftBehind: zero } };
    if (read.status !== 'ok') throw new Error('Unreachable unavailable process read');
    const index = indexCensus(read.snapshot.rows);
    const principal = index.byPid.get(options.selfPid ?? process.pid)?.principal ?? null;
    const ownership = new Map(read.rows.map(row => [row.pid, row]));
    const confirmed = new Map(options.confirmed.map(item => [item.ref, item]));
    const owners = new Map<string, OwnerRowV1>();
    const leftBehind: LeftBehindRowV1[] = [];
    const notHappier = new Map<string, AppGroupRowV1>();
    const foreign: Array<{ memoryBytes: number | null; cpuPercent?: number }> = [];
    const foreignNames = new Set<string>();
    const othersWork = new Set<string>();
    let unverifiableCount = 0;
    const history: Record<string, ProcessMetricSample[]> = {};
    for (const row of index.byPid.values()) {
        const resolved = ownership.get(row.pid);
        if (!resolved || !equalProcessStart(resolved.start, row.start)) continue;
        const ref = processRef(row.pid, row.start);
        const candidateMetric = options.metrics?.get(row.pid);
        const metric = candidateMetric?.ref === ref ? candidateMetric : undefined;
        const level = metric?.identityUnavailable ? resolveProcessOwnershipLevel({ samePrincipal: undefined,
            ownerEnded: resolved.ownerEnded, evidence: resolved.evidence, observationsIncomplete: true }) : resolved.level;
        const facts = { memoryBytes: metric ? metric.memoryBytes : row.memory?.bytes ?? null,
            ...(metric?.cpuPercent === undefined ? {} : { cpuPercent: metric.cpuPercent }) };
        const ownPrincipal = compareProcessPrincipals(row.principal, principal);
        if (!resolved.owner) {
            if (level === 'unknown') { if (custodian && !request.sessionId) unverifiableCount++; continue; }
            if (custodian && ownPrincipal === 'other') { foreign.push(facts); foreignNames.add(options.principalName?.(row) ?? row.principal!.value); }
            if (custodian && request.scope === 'all' && ownPrincipal === 'self' && level === 'not_happier') {
                const group = appGroup(row, options.platform);
                const existing = notHappier.get(group) ?? { appGroup: group, members: [] };
                existing.members.push({ name: row.name, appGroup: group, pid: row.pid, ref, ...facts });
                notHappier.set(group, existing);
            }
            continue;
        }
        const ownerKey = processOwnerKey(resolved.owner);
        const environmentOwner = resolved.owner.kind === 'container' && resolved.owner.environmentId !== undefined;
        if (resolved.owner.kind === 'container' && resolved.owner.machineId !== request.machineId) continue;
        if (environmentOwner && !options.readableEnvironments?.has(processEnvironmentReadKey({
            serverId: resolved.owner.serverId, environmentId: resolved.owner.environmentId! }))) continue;
        const identity = environmentOwner ? null : options.requesterForOwner(resolved.owner, read.roots);
        if (!environmentOwner && !custodian && identity?.accountId !== requester.accountId) { othersWork.add(ownerKey); continue; }
        if (request.sessionId && !belongsToSession(resolved.owner, request.sessionId)) continue;
        const displayIdentity = identity?.displayName ? { accountId: identity.accountId, displayName: identity.displayName }
            : identity ? options.requesterIdentities?.get(identity.accountId) : undefined;
        if (!environmentOwner && custodian && (!identity || identity.accountId !== requester.custodianAccountId && !displayIdentity)) {
            options.onRequesterEvidenceUnavailable?.({ owner: resolved.owner,
                reason: identity ? 'display_identity_unavailable' : 'requester_unavailable' });
            if (!request.sessionId) unverifiableCount++;
            continue;
        }
        const command = row.argv ? redactProcessCommand(row.argv) : row.commandLine ? redactProcessCommand(row.commandLine) : undefined;
        const ownerRole = serviceOwnerRole(resolved.owner);
        const ownerDisplayName = ownerRole ? serviceOwnerDisplayName(resolved.owner, readLanguageServerDefinitions()) : undefined;
        const ancestors = ancestorsOf(index, row.pid);
        const outsideNativeOwner = resolved.owner.kind === 'container' ? ancestors.findIndex(ancestor => {
            const claim = ownership.get(ancestor.pid);
            return !claim?.owner || processOwnerKey(claim.owner) !== ownerKey || !equalProcessStart(claim.start, ancestor.start);
        }) : -1;
        const classification: LocalServiceProcessClassification = ownerRole
            ? { role: ownerRole, ...(ownerDisplayName ? { displayName: ownerDisplayName } : {}), signals: [] }
            : classifyProcessRole({ command: command ?? row.name, cwd: row.cwd,
            ...options.roleCatalog, ancestors: (outsideNativeOwner < 0 ? ancestors : ancestors.slice(0, outsideNativeOwner))
                .map(ancestor => ({ command: ancestor.argv ? redactProcessCommand(ancestor.argv) : redactProcessCommand(ancestor.commandLine ?? ancestor.name) })) });
        const parent = row.ppid === null ? undefined : index.byPid.get(row.ppid);
        const parentOwner = parent ? ownership.get(parent.pid) : undefined;
        const ports = options.ports?.entries.filter(entry => entry.state === 'listening' && entry.provenance?.process?.pid === row.pid
            && (entry.provenance.process.processStartTimeMs === undefined || entry.provenance.process.processStartTimeMs === row.start.startTimeMs))
            .map(entry => ({ port: entry.port, inventoryEntryId: entry.id }));
        const processRow: ProcessRowV1 = { rowId: ref, ref, name: row.name || 'unknown', pid: row.pid,
            startedAtMs: options.platform === 'linux' ? options.bootTimeMs! + row.start.startTimeMs : row.start.startTimeMs,
            ...facts, memoryKind: row.memory?.kind ?? null, level: level === 'not_happier' ? 'unknown' : level,
            ...(parent && parentOwner?.owner && processOwnerKey(parentOwner.owner) === ownerKey ? { parentRowId: processRef(parent.pid, parent.start) } : { parentRowId: ownerKey }),
            ...(command === undefined ? {} : { command }), ...(row.cwd ? { cwd: row.cwd } : {}), ...(classification.role ? { role: classification.role } : {}),
            ...(classification.displayName ? { displayName: classification.displayName } : {}),
            ...(classification.browserEngine ? { browserEngine: classification.browserEngine, browserHelper: classification.browserHelper } : {}),
            ...(classification.driverLabel ? { driverLabel: classification.driverLabel } : {}),
            ...(ports?.length ? { ports } : {}), ...(request.detailToken === ref ? { evidence: [...resolved.evidence], chain: [...resolved.chain],
                ...(options.principalName ? { principalName: options.principalName(row) } : {}) } : {}) };
        if (level === 'left_behind') {
            if (!matches(processRow, request.query)) continue;
            const item = confirmed.get(ref);
            if (!item || !resolved.ownerEnded) continue;
            leftBehind.push({ ...processRow, level: 'left_behind', owner: resolved.owner, confirmedAtMs: item.confirmedAtMs });
        } else if (level === 'proven' || level === 'likely' || level === 'unknown') {
            let owner = owners.get(ownerKey);
            if (!owner) {
                const roots = read.roots.filter(root => {
                    const native = index.byPid.get(root.pid);
                    return root.live && native && processOwnerKey(root.owner) === ownerKey && equalProcessStart(root.start, native.start);
                });
                const root = roots.find(root => {
                    const claim = ownership.get(root.pid);
                    return claim?.owner && processOwnerKey(claim.owner) === ownerKey
                        && equalProcessStart(root.start, claim.start)
                        && (claim.level === 'proven' || claim.level === 'likely');
                });
                const rootClaim = root ? ownership.get(root.pid) : undefined;
                owner = { rowId: ownerKey, owner: resolved.owner,
                    state: roots.some(root => root.state === 'stopping') ? 'stopping' : 'running',
                    // Sessions use the executor's next-message resume path, not a service launch callback.
                    canStartAgain: roots.some(root => root.owner.kind === 'session' || !!root.startAgain),
                    ...(resolved.owner.kind !== 'container' && root && rootClaim && (rootClaim.level === 'proven' || rootClaim.level === 'likely')
                        ? { root: { ref: processRef(root.pid, rootClaim.start), level: rootClaim.level } } : {}),
                    members: [], totals: zero,
                    ...(displayIdentity && displayIdentity.accountId !== requester.custodianAccountId ? { requester: displayIdentity } : {}) };
                const ceiling = roots.find(root => root.owner.kind === 'session');
                const limit = ceiling && options.readCeiling?.(ceiling);
                if (limit) owner.ceiling = limit;
            }
            owner.members.push(processRow);
            owners.set(ownerKey, owner);
        }
        if (request.detailToken === ref) {
            const samples = options.history?.(ref);
            if (samples) history[ref] = [...samples];
        }
    }
    const ownerRows = [...owners.values()].map(owner => {
        const members = new Map(owner.members.map(row => [row.pid, row]));
        const browserMembers = new Map<number, ProcessRowV1[]>();
        for (const row of owner.members) {
            if (!row.browserEngine) continue;
            const main = row.browserHelper ? ancestorsOf(index, row.pid).map(ancestor => members.get(ancestor.pid))
                .find(ancestor => ancestor !== undefined && ancestor.browserEngine === row.browserEngine && !ancestor.browserHelper) : row;
            if (!main) continue;
            const group = browserMembers.get(main.pid) ?? [];
            group.push(row); browserMembers.set(main.pid, group);
            if (row !== main) row.parentRowId = main.rowId;
        }
        const selected = new Set(owner.members.filter(row => matches(row, request.query)).map(row => row.ref));
        for (const [pid, group] of browserMembers) if (group.some(row => selected.has(row.ref))) selected.add(members.get(pid)!.ref);
        const visible = owner.members.filter(row => selected.has(row.ref));
        for (const [pid, group] of browserMembers) {
            const main = members.get(pid)!;
            const shown = [main, ...group.filter(row => row !== main && selected.has(row.ref))];
            main.browserGroup = { memberRefs: shown.map(row => row.ref), totals: processTotals(shown) };
        }
        return { ...owner, members: visible, totals: processTotals(visible) };
    }).filter(owner => owner.members.length);
    // Owner observations were aggregated at capture time, before membership can change.
    // No process detail or recipient-hidden owner history enters the wire answer.
    if (options.history) for (const owner of ownerRows) {
        const samples = options.history(owner.rowId);
        if (samples) history[owner.rowId] = [...samples];
    }
    return { ...base, state: 'live', owners: ownerRows.map(owner => request.view === 'owners' ? { ...owner, members: [] } : owner), leftBehind,
        ...(custodian && request.scope === 'all' ? { notHappier: [...notHappier.values()] } : {}),
        ...(custodian && foreign.length ? { otherPrincipals: (() => {
            const { processCount: _count, ...totals } = processTotals(foreign);
            return { count: foreign.length, ...totals, names: [...foreignNames] };
        })() } : {}),
        ...(!custodian ? { othersWork: { count: othersWork.size } } : {}),
        ...(custodian && !request.sessionId ? { unverifiableCount } : {}),
        totals: { happier: processTotals(ownerRows.flatMap(owner => owner.members)), leftBehind: processTotals(leftBehind) },
        ...(Object.keys(history).length ? { history } : {}) };
}
