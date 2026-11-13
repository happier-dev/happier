import type {
    MachineProcessTargetV1, MachineProcessesActionResultV1, MachineProcessesCleanUpInputV1,
    MachineProcessesCleanUpResultV1, MachineProcessesKillInputV1, MachineProcessesStartAgainInputV1,
    MachineProcessesStartAgainResultV1, MachineProcessesStopInputV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createProcessTreeTerminator, terminateProcessTree, type ProcessTreeTerminationInput } from '@/processes/terminate/terminateProcessTree';
import { descendantsOf, indexCensus, protectedSet } from '@/processes/tree/processTree';
import { compareProcessPrincipals } from '@/processes/ownership/principal';
import { classifyProcessRole } from '@/processes/classification/classifyProcessRole';
import type { ProcessCensusRow, ProcessStartIdentity } from '@/processes/census/processCensus';
import type { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { equalProcessStart, processOwnerKey, resolveRawProcessControlRefusal, type HappierProcessRoot, type ProcessOwnerRef, type ResolvedProcessOwnership } from '../ownership/types';
import type { LeftBehindItem } from '../leftBehind/leftBehindTracker';
import { decodeProcessRef } from '../view/processRef';

export type ProcessActionRequester = Readonly<{ accountId: string; isCustodian: boolean }>;
export type ProcessActionExecution = Readonly<{
    signal?: AbortSignal;
    rpcContext?: RpcHandlerContext;
    actionContext?: RuntimeActionExecuteArgs['context'];
    /** Executor-owned native-effect lifetime and once-per-Session producer witness. Never transported. */
    physicalStopEffect?: Readonly<{ completion: Promise<void>; recordedSessionIds: Set<string> }>;
    /** Native listener termination consumes the same Action's fresh membership checks. */
    authorizeSnapshot?: ProcessTreeTerminationInput['authorizeSnapshot'];
    authorizeSignal?: ProcessTreeTerminationInput['authorizeSignal'];
    tree?: boolean;
}>;
type OwnershipRuntime = ReturnType<typeof createProcessOwnershipRuntime>;
type CurrentOwnership = Extract<Awaited<ReturnType<OwnershipRuntime['readOwners']>>, { status: 'ok' }>;
type Outcome = MachineProcessesActionResultV1['outcomes'][number];
type ExactTarget = Readonly<{ pid: number; start: ProcessStartIdentity }>;

export type ProcessActionExecutorInput = Readonly<{
    ownership: OwnershipRuntime;
    leftBehind: Readonly<{ confirmed(): readonly LeftBehindItem[] }>;
    requesterForOwner(owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[]): Readonly<{ accountId: string }> | null;
    allProcessesVisible(): boolean;
    platform?: NodeJS.Platform;
    selfPid?: number;
    /** Genuine native read/signal boundaries; the ownership and tree owners stay real. */
    systemBoundary?: Parameters<typeof createProcessTreeTerminator>[0];
    prepareKill?: (input: Readonly<{ targets: readonly ExactTarget[] }> & ProcessActionExecution) => Promise<(() => Promise<boolean>) | null>;
    stopOwner?: (root: HappierProcessRoot, execution: ProcessActionExecution) => Promise<unknown>;
    closeTerminal?: (owner: Extract<ProcessOwnerRef, { kind: 'terminal' }>, execution: ProcessActionExecution) => Promise<unknown>;
    /** The existing listener executor, including TOCTOU and port-release verification. */
    terminateDetected?: (row: ProcessCensusRow, execution: ProcessActionExecution) => Promise<Readonly<{ status: 'succeeded' | 'denied' | 'failed'; reasonCode?: string }> | null>;
    startOwner?: (root: HappierProcessRoot, execution: ProcessActionExecution) => Promise<MachineProcessesStartAgainResultV1>;
    /** Existing root retention consumes only this owner's verified end fact. */
    onRootEnded?: (root: HappierProcessRoot) => void;
}>;

/** Action approval is already decided at the canonical Action ingress. This owner rechecks facts, not approval. */
export function createProcessActionExecutor(input: ProcessActionExecutorInput) {
    const selfPid = input.selfPid ?? process.pid;
    const terminate = input.systemBoundary ? createProcessTreeTerminator(input.systemBoundary) : terminateProcessTree;
    const isCurrent = async (execution: ProcessActionExecution) => !execution.signal?.aborted;
    const withPhysicalStopEffect = async <T>(execution: ProcessActionExecution,
        operation: (execution: ProcessActionExecution) => Promise<T>): Promise<T> => {
        let complete!: () => void;
        const completion = new Promise<void>(resolve => { complete = resolve; });
        try {
            return await operation({ ...execution, physicalStopEffect: { completion, recordedSessionIds: new Set() } });
        } finally { complete(); }
    };
    const allowedOwner = (owner: ProcessOwnerRef | null, requester: ProcessActionRequester, roots: readonly HappierProcessRoot[]) => requester.isCustodian
        || owner !== null && input.requesterForOwner(owner, roots)?.accountId === requester.accountId;
    const lifecycleFailed = (value: unknown) => value === false || value !== null && typeof value === 'object'
        && ('ok' in value && value.ok === false || 'success' in value && value.success === false
            || 'status' in value && ['failed', 'denied', 'refused'].includes(String(value.status)));
    const expectEqual = (target: MachineProcessTargetV1, row: ResolvedProcessOwnership) => target.expect.level === row.level
        && (target.expect.owner ? row.owner !== null && processOwnerKey(target.expect.owner) === processOwnerKey(row.owner) : row.owner === null);
    const refused = (ref: string, reasonCode: string): Outcome => ({ ref, outcome: 'refused', reasonCode });
    const result = (outcomes: Outcome[]): MachineProcessesActionResultV1 => ({
        status: outcomes.every(row => row.outcome === 'ended' || row.outcome === 'gone_before') ? 'ended'
            : outcomes.every(row => row.outcome === 'refused') ? 'refused' : 'partial', outcomes,
    });
    const nativeRow = (view: CurrentOwnership, pid: number) => view.snapshot.rows.find(row => row.pid === pid && row.state !== 'zombie');
    const resolvedRow = (view: CurrentOwnership, pid: number) => view.rows.find(row => row.pid === pid);
    const endedMemberMemory = (members: readonly ProcessCensusRow[], after: CurrentOwnership) => {
        const current = new Map(after.snapshot.rows.map(row => [row.pid, row]));
        const unreadable = new Set(after.snapshot.partial?.map(row => row.pid));
        const ended = new Map<number, number>();
        for (const member of members) {
            const now = current.get(member.pid);
            if (now ? now.state === 'zombie' || !equalProcessStart(now.start, member.start) : !unreadable.has(member.pid)) {
                ended.set(member.pid, member.memory?.bytes ?? 0);
            }
        }
        return ended;
    };

    function validate(target: MachineProcessTargetV1, view: CurrentOwnership, requester: ProcessActionRequester,
        tree: boolean, setSize: number, policy: boolean): Readonly<{ outcome: Outcome }> | Readonly<{ native: ProcessCensusRow; ownership: ResolvedProcessOwnership }> {
        const decoded = decodeProcessRef(target.ref);
        if (!decoded) return { outcome: refused(target.ref, 'invalid_ref') };
        const row = nativeRow(view, decoded.pid);
        if (!row) return { outcome: { ref: target.ref, outcome: 'gone_before' } };
        if (!equalProcessStart(decoded.start, row.start)) return { outcome: refused(target.ref, 'identity_changed') };
        const ownership = resolvedRow(view, row.pid);
        if (!ownership || ownership.level === 'unknown') return { outcome: refused(target.ref, 'ownership_unavailable') };
        if (!expectEqual(target, ownership)) return { outcome: refused(target.ref, 'expectation_changed') };
        if (!allowedOwner(ownership.owner, requester, view.roots)) return { outcome: refused(target.ref, 'access_denied') };
        const nativeControl = resolveRawProcessControlRefusal(ownership.owner);
        if (nativeControl) return { outcome: refused(target.ref, nativeControl) };
        const self = nativeRow(view, selfPid);
        if (!self || compareProcessPrincipals(row.principal, self.principal) !== 'self') return { outcome: refused(target.ref, 'other_principal') };
        if (ownership.level === 'not_happier'
            && (policy || !requester.isCustodian || !input.allProcessesVisible() || tree || setSize !== 1)) {
            return { outcome: refused(target.ref, 'not_happier') };
        }
        const protectedRows = protectedSet(indexCensus(view.snapshot.rows), selfPid, { signalExtent: 'process' });
        if (protectedRows.has(row.pid)) return { outcome: refused(target.ref, 'protected_process') };
        return { native: row, ownership };
    }

    const killEffect = async (request: MachineProcessesKillInputV1, requester: ProcessActionRequester,
        execution: ProcessActionExecution = {}, policy = false): Promise<MachineProcessesActionResultV1> => {
        if (!await isCurrent(execution)) return result(request.targets.map(target => refused(target.ref, 'access_denied')));
        const outcomes: Outcome[] = [];
        for (const target of request.targets) {
            if (!await isCurrent(execution)) { outcomes.push(refused(target.ref, 'access_denied')); continue; }
            const view = await input.ownership.readOwners({ freshness: 'fresh' });
            if (view.status !== 'ok') { outcomes.push(refused(target.ref, 'ownership_unavailable')); continue; }
            const current = validate(target, view, requester, request.tree, request.targets.length, policy);
            if ('outcome' in current) { outcomes.push(current.outcome); continue; }
            const index = indexCensus(view.snapshot.rows);
            const selected = request.tree ? descendantsOf(index, [current.native.pid]) : [];
            const members = [current.native, ...selected];
            const authorized = new Map<number, { native: ProcessCensusRow; ownership: ResolvedProcessOwnership }>();
            let failure: string | undefined;
            for (const member of members) {
                const owner = resolvedRow(view, member.pid);
                if (!owner || owner.level === 'unknown' || owner.level === 'not_happier' && member.pid !== current.native.pid) { failure = 'ownership_unavailable'; break; }
                if (!allowedOwner(owner.owner, requester, view.roots)) { failure = 'access_denied'; break; }
                const nativeControl = resolveRawProcessControlRefusal(owner.owner);
                if (nativeControl) { failure = nativeControl; break; }
                if (compareProcessPrincipals(member.principal, current.native.principal) !== 'self') { failure = 'other_principal'; break; }
                if (protectedSet(index, selfPid, { signalExtent: 'process' }).has(member.pid)) { failure = 'protected_process'; break; }
                authorized.set(member.pid, { native: member, ownership: owner });
            }
            if (failure) { outcomes.push(refused(target.ref, failure)); continue; }
            const exact = members.map(member => ({ pid: member.pid, start: member.start }));
            const beforeSignal = input.prepareKill ? await input.prepareKill({ targets: exact, ...execution }) : undefined;
            if (beforeSignal === null) { outcomes.push(refused(target.ref, 'identity_changed')); continue; }
            const lifetimeGuards = beforeSignal ? [beforeSignal] : [];
            const prepared = new Set(exact.map(member => member.pid));
            const authorizeSignal = async () => {
                if (!await isCurrent(execution)) return false;
                for (const guard of lifetimeGuards) if (!await guard()) return false;
                return await isCurrent(execution);
            };
            const authorizeSnapshot: NonNullable<ProcessTreeTerminationInput['authorizeSnapshot']> = async snapshot => {
                if (!await isCurrent(execution)) return false;
                const fresh = await input.ownership.resolveSnapshot(snapshot);
                if (fresh.status !== 'ok') return false;
                for (const { native: member, ownership: expected } of authorized.values()) {
                    const now = nativeRow(fresh, member.pid);
                    if (!now) continue;
                    const actual = resolvedRow(fresh, member.pid);
                    if (!equalProcessStart(now.start, member.start) || !actual || !expected
                        || actual.level !== expected.level || (actual.owner ? processOwnerKey(actual.owner) : null) !== (expected.owner ? processOwnerKey(expected.owner) : null)
                        || !allowedOwner(actual.owner, requester, fresh.roots)) return false;
                }
                const checked = validate(target, fresh, requester, request.tree, request.targets.length, policy);
                if ('outcome' in checked && checked.outcome.outcome !== 'gone_before') return false;
                // The canonical terminator can discover children between rounds. Authorize
                // that same fresh membership, not just the initially selected PID list.
                const freshIndex = indexCensus(snapshot.rows);
                const liveMembers = [...authorized.values()].filter(member => {
                    const now = nativeRow(fresh, member.native.pid);
                    return now && equalProcessStart(now.start, member.native.start);
                }).map(member => member.native.pid);
                const discovered = request.tree ? descendantsOf(freshIndex, liveMembers) : [];
                const protectedRows = protectedSet(freshIndex, selfPid, { signalExtent: 'process' });
                const self = nativeRow(fresh, selfPid);
                for (const member of discovered) {
                    const actual = resolvedRow(fresh, member.pid);
                    if (!actual || actual.level === 'unknown' || actual.level === 'not_happier'
                        || resolveRawProcessControlRefusal(actual.owner)
                        || !allowedOwner(actual.owner, requester, fresh.roots)
                        || !self || compareProcessPrincipals(member.principal, self.principal) !== 'self'
                        || protectedRows.has(member.pid)) return false;
                    authorized.set(member.pid, { native: member, ownership: actual });
                }
                const newRunners = discovered.filter(member => !prepared.has(member.pid)
                    && fresh.roots.some(root => root.owner.kind === 'session' && root.pid === member.pid && equalProcessStart(root.start, member.start)));
                if (newRunners.length) {
                    if (!input.prepareKill) return false;
                    const guard = await input.prepareKill({ targets: newRunners.map(member => ({ pid: member.pid, start: member.start })), ...execution });
                    if (!guard) return false;
                    lifetimeGuards.push(guard);
                    for (const member of newRunners) prepared.add(member.pid);
                }
                return await authorizeSignal();
            };
            try {
                const root = view.roots.find(root => root.pid === current.native.pid && equalProcessStart(root.start, current.native.start)
                    && current.ownership.owner && processOwnerKey(root.owner) === processOwnerKey(current.ownership.owner));
                const helper = current.ownership.owner?.kind === 'happier'
                    && ['voice_worker', 'workspace_sync', 'device_helper'].includes(current.ownership.owner.component ?? '');
                const autorestarting = current.ownership.owner?.kind === 'happier'
                    && ['voice_worker', 'workspace_sync'].includes(current.ownership.owner.component ?? '');
                if (!policy && autorestarting && !root?.stop) { outcomes.push(refused(target.ref, 'lifecycle_unavailable')); continue; }
                if (!policy && !request.tree && (root?.owner.kind === 'terminal'
                    || helper && descendantsOf(index, [current.native.pid]).length > 0)) {
                    outcomes.push(refused(target.ref, 'requires_tree')); continue;
                }
                // Native listener cleanup and retained lifetime owners are not new Actions:
                // dispatch directly after this Action's approval and the same fact checks.
                if (input.terminateDetected && current.ownership.level !== 'not_happier') {
                    const before = await input.ownership.readOwners({ freshness: 'fresh' });
                    if (before.status !== 'ok' || !await authorizeSnapshot(before.snapshot)) { outcomes.push(refused(target.ref, 'expectation_changed')); continue; }
                    const listener = await input.terminateDetected(current.native, { ...execution, tree: request.tree, authorizeSnapshot, authorizeSignal });
                    if (listener) {
                        if (listener.status !== 'succeeded') { outcomes.push(refused(target.ref, listener.reasonCode ?? 'port_release_unverified')); continue; }
                        const after = await input.ownership.readOwners({ freshness: 'fresh' });
                        if (after.status !== 'ok') { outcomes.push(refused(target.ref, 'termination_unverified')); continue; }
                        const survivor = nativeRow(after, current.native.pid);
                        if (root && (survivor ? !equalProcessStart(survivor.start, current.native.start)
                            : !after.snapshot.partial?.some(item => item.pid === current.native.pid))) input.onRootEnded?.(root);
                        if ([...authorized.keys()].some(pid => !nativeRow(after, pid) && after.snapshot.partial?.some(item => item.pid === pid))) {
                            outcomes.push(refused(target.ref, 'termination_unverified')); continue;
                        }
                        const survivingMember = [...authorized.values()].some(member => {
                            const now = nativeRow(after, member.native.pid);
                            return now && equalProcessStart(now.start, member.native.start);
                        });
                        outcomes.push(survivingMember || survivor && equalProcessStart(survivor.start, current.native.start)
                            ? { ref: target.ref, outcome: 'survived', reasonCode: 'termination_unverified' }
                            : { ref: target.ref, outcome: 'ended', freedBytes: [...authorized.values()].reduce((sum, member) => sum + (member.native.memory?.bytes ?? 0), 0) });
                        continue;
                    }
                }
                let lifecycleEnded = new Map<number, number>();
                if (!policy && (root?.stop && (root.owner.kind !== 'session' || request.tree)
                    || root && root.owner.kind === 'session' && request.tree && input.stopOwner
                    || root?.owner.kind === 'terminal' && input.closeTerminal)) {
                    const before = await input.ownership.readOwners({ freshness: 'fresh' });
                    if (before.status !== 'ok' || !await authorizeSnapshot(before.snapshot)) { outcomes.push(refused(target.ref, 'expectation_changed')); continue; }
                    if (helper && !request.tree && descendantsOf(indexCensus(before.snapshot.rows), [current.native.pid]).length > 0) {
                        outcomes.push(refused(target.ref, 'requires_tree')); continue;
                    }
                    const activeRoot = before.roots.find(candidate => candidate.pid === root.pid && equalProcessStart(candidate.start, root.start)
                        && processOwnerKey(candidate.owner) === processOwnerKey(root.owner));
                    if (!activeRoot) { outcomes.push(refused(target.ref, 'expectation_changed')); continue; }
                    if (autorestarting && !activeRoot.stop) { outcomes.push(refused(target.ref, 'lifecycle_unavailable')); continue; }
                    const lifecycle = activeRoot.owner.kind === 'terminal' && input.closeTerminal ? await input.closeTerminal(activeRoot.owner, execution)
                        : input.stopOwner ? await input.stopOwner(activeRoot, execution) : await activeRoot.stop?.();
                    if (lifecycleFailed(lifecycle)) { outcomes.push(refused(target.ref, 'termination_failed')); continue; }
                    const after = await input.ownership.readOwners({ freshness: 'fresh' });
                    if (after.status !== 'ok') { outcomes.push(refused(target.ref, 'termination_unverified')); continue; }
                    lifecycleEnded = endedMemberMemory([...authorized.values()].map(member => member.native), after);
                }
                const role = classifyProcessRole({ command: current.native.argv?.join(' ') ?? current.native.name }).role;
                const stopped = await terminate({ targets: exact, tree: request.tree, policy: policy ? 'stop' : 'kill',
                    rootKind: root?.owner.kind === 'terminal' ? 'pty' : role === 'dev_server' ? 'dev_server' : 'process', authorizeSnapshot, authorizeSignal });
                const nativeOutcome = stopped.outcomes.find(row => row.pid === current.native.pid);
                if (root && (nativeOutcome?.outcome === 'ended' || lifecycleEnded.has(current.native.pid)
                    || nativeOutcome?.outcome === 'gone_before' && stopped.status === 'complete')) input.onRootEnded?.(root);
                const unconfirmed = stopped.status !== 'complete' || stopped.outcomes.some(row => row.outcome === 'refused' || row.outcome === 'survived');
                if (!nativeOutcome) outcomes.push(refused(target.ref, 'termination_unverified'));
                else if (unconfirmed) outcomes.push(nativeOutcome.outcome === 'refused'
                    ? refused(target.ref, nativeOutcome.reason ?? 'termination_unverified')
                    : { ref: target.ref, outcome: 'survived', reasonCode: 'termination_unverified' });
                else {
                    const outcome = lifecycleEnded.has(current.native.pid) && nativeOutcome.outcome === 'gone_before' ? 'ended' : nativeOutcome.outcome;
                    outcomes.push({ ref: target.ref, outcome,
                        ...(outcome === 'ended' ? { freedBytes: stopped.outcomes.reduce((sum, row) => sum + (row.outcome === 'ended' ? row.freedBytes ?? 0
                            : row.outcome === 'gone_before' ? lifecycleEnded.get(row.pid) ?? 0 : 0), 0) } : {}) });
                }
            } catch { outcomes.push(refused(target.ref, 'termination_failed')); }
        }
        return result(outcomes);
    };
    const kill = (request: MachineProcessesKillInputV1, requester: ProcessActionRequester,
        execution: ProcessActionExecution = {}, policy = false) =>
        withPhysicalStopEffect(execution, current => killEffect(request, requester, current, policy));

    return {
        executeKill: (request: MachineProcessesKillInputV1, requester: ProcessActionRequester, execution?: ProcessActionExecution) => kill(request, requester, execution),
        async executeStop(request: MachineProcessesStopInputV1, requester: ProcessActionRequester,
            execution: ProcessActionExecution = {}): Promise<MachineProcessesActionResultV1> {
            return await withPhysicalStopEffect(execution, async execution => {
            const outcomes: Outcome[] = [];
            for (const target of request.targets) {
                if (!await isCurrent(execution)) { outcomes.push(refused(target.ref, 'access_denied')); continue; }
                try {
                    if (!await isCurrent(execution)) { outcomes.push(refused(target.ref, 'access_denied')); continue; }
                    // This fresh observation owns both admission facts and pre-stop
                    // member accounting; a preliminary inventory adds no evidence.
                    const before = await input.ownership.readOwners({ freshness: 'fresh' });
                    if (before.status !== 'ok') { outcomes.push(refused(target.ref, 'ownership_unavailable')); continue; }
                    const fresh = validate(target, before, requester, false, request.targets.length, false);
                    if ('outcome' in fresh) { outcomes.push(fresh.outcome); continue; }
                    const ownershipByPid = new Map(before.rows.map(row => [row.pid, row]));
                    const nativeDescendant = descendantsOf(indexCensus(before.snapshot.rows), [fresh.native.pid])
                        .some(row => resolveRawProcessControlRefusal(ownershipByPid.get(row.pid)?.owner ?? null));
                    if (nativeDescendant) { outcomes.push(refused(target.ref, 'native_service_control_required')); continue; }
                    const activeRoot = before.roots.find(root => root.pid === fresh.native.pid && equalProcessStart(root.start, fresh.native.start)
                        && fresh.ownership.owner && processOwnerKey(root.owner) === processOwnerKey(fresh.ownership.owner));
                    if (!activeRoot || !['session', 'service', 'browser_sidecar'].includes(activeRoot.owner.kind) || !activeRoot.stop && !input.stopOwner) {
                        outcomes.push(refused(target.ref, 'use_kill')); continue;
                    }
                    const ownerKey = processOwnerKey(activeRoot.owner);
                    const admitted = new Map(before.rows.filter(row => row.owner && processOwnerKey(row.owner) === ownerKey
                        && (row.level === 'proven' || row.level === 'likely')).map(row => [row.pid, row]));
                    const members = before.snapshot.rows.filter(row => {
                        const owned = admitted.get(row.pid);
                        return owned && equalProcessStart(owned.start, row.start);
                    });
                    const lifecycle = input.stopOwner ? await input.stopOwner(activeRoot, execution) : await activeRoot.stop?.();
                    if (lifecycleFailed(lifecycle)) { outcomes.push(refused(target.ref, 'termination_failed')); continue; }
                    const after = await input.ownership.readOwners({ freshness: 'fresh' });
                    if (after.status !== 'ok') { outcomes.push(refused(target.ref, 'termination_unverified')); continue; }
                    const survivor = nativeRow(after, fresh.native.pid);
                    if (!survivor && after.snapshot.partial?.some(item => item.pid === fresh.native.pid)) {
                        outcomes.push(refused(target.ref, 'termination_unverified')); continue;
                    }
                    if (survivor && equalProcessStart(survivor.start, fresh.native.start)) {
                        outcomes.push({ ref: target.ref, outcome: 'survived', reasonCode: 'termination_unverified' });
                    } else {
                        input.onRootEnded?.(activeRoot);
                        const ended = endedMemberMemory(members, after);
                        outcomes.push({ ref: target.ref, outcome: 'ended', freedBytes: [...ended.values()].reduce((sum, bytes) => sum + bytes, 0) });
                    }
                } catch { outcomes.push(refused(target.ref, 'termination_failed')); }
            }
            return result(outcomes);
            });
        },
        async cleanUp(request: MachineProcessesCleanUpInputV1, requester: ProcessActionRequester,
            execution: ProcessActionExecution = {}): Promise<MachineProcessesCleanUpResultV1> {
            const confirmed = new Map(input.leftBehind.confirmed().map(item => [item.ref, item]));
            const ended: MachineProcessesCleanUpResultV1['ended'] = [];
            const skipped: MachineProcessesCleanUpResultV1['skipped'] = [];
            for (const ref of request.refs) {
                const item = confirmed.get(ref);
                if (!item) { skipped.push({ ref, reason: 'not_confirmed' }); continue; }
                const response = await kill({ machineId: request.machineId, tree: false,
                    targets: [{ ref, expect: { level: 'left_behind', owner: item.owner } }] }, requester, execution, true);
                const outcome = response.outcomes[0]!;
                if (outcome.outcome === 'ended') ended.push({ ref, freedBytes: outcome.freedBytes ?? 0 });
                else skipped.push({ ref, reason: outcome.reasonCode ?? outcome.outcome });
            }
            return { ended, skipped };
        },
        async startAgain(request: MachineProcessesStartAgainInputV1, requester: ProcessActionRequester,
            execution: ProcessActionExecution = {}): Promise<MachineProcessesStartAgainResultV1> {
            if (!await isCurrent(execution)) return { status: 'refused', reasonCode: 'access_denied' };
            const decoded = decodeProcessRef(request.ref);
            if (!decoded) return { status: 'refused', reasonCode: 'invalid_ref' };
            // Session roots already have exact lifecycle custody. Their no-op
            // needs native identity, not command/environment/resource enrichment.
            let view = await input.ownership.readOwners({ freshness: 'fresh', fields: [] });
            if (view.status !== 'ok') return { status: 'refused', reasonCode: 'ownership_unavailable' };
            let root = view.roots.find(root => root.pid === decoded.pid && equalProcessStart(root.start, decoded.start));
            // A lifecycle source without retained birth may need its native
            // marker to establish the root. Existing exact roots already carry
            // their reviewed restart declaration and need no second census.
            if (!root) {
                view = await input.ownership.readOwners({ freshness: 'fresh' });
                if (view.status !== 'ok') return { status: 'refused', reasonCode: 'ownership_unavailable' };
                root = view.roots.find(root => root.pid === decoded.pid && equalProcessStart(root.start, decoded.start));
            }
            if (!root || !allowedOwner(root.owner, requester, view.roots)) return { status: 'refused', reasonCode: 'access_denied' };
            if (root.owner.kind === 'session') return { status: 'already_wakes_on_next_message' };
            if (root.owner.kind !== 'service' && root.owner.kind !== 'browser_sidecar' || !input.startOwner) return { status: 'refused', reasonCode: 'not_restartable' };
            if (!await isCurrent(execution)) return { status: 'refused', reasonCode: 'access_denied' };
            return input.startOwner(root, execution);
        },
        stopProcess(request: Readonly<{ ref: string; expect: MachineProcessTargetV1['expect']; policy: 'stop'; caller: 'policy' }>) {
            return kill({ machineId: 'policy', tree: false, targets: [{ ref: request.ref, expect: request.expect }] },
                { accountId: 'policy', isCustodian: true }, {}, true);
        },
    };
}
