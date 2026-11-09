import { resolveProcessOwnership } from './ownership/resolveProcessOwnership';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot, type ProcessOwnerRef, type ResolvedProcessOwnership } from './ownership/types';
import type { createProcessOwnershipRuntime } from './ownership/processOwnershipRuntime';
import { captureProcessTree, createProcessTreeTerminator, type ProcessTreeTerminationResult } from '@/processes/terminate/terminateProcessTree';
import type { ProcessCensusSnapshot, ProcessStartIdentity } from '@/processes/census/processCensus';
import { logger } from '@/ui/logger';
import { descendantsOf, indexCensus, membersOfCgroup, membersOfJob } from '@/processes/tree/processTree';
import type { SessionStopProcessFailure } from '@happier-dev/protocol/sessionStop';

export type OwnerRemainderCapture = Readonly<{
    roots: readonly HappierProcessRoot[];
    ownership: readonly ResolvedProcessOwnership[];
    scope?: 'owner' | 'subtree';
    processFailure?: SessionStopProcessFailure;
}>;
export type OwnerRemainderResult = Readonly<{
    status: 'complete' | 'incomplete' | 'unavailable';
    outcomes: ProcessTreeTerminationResult['outcomes'];
    processFailure?: SessionStopProcessFailure;
}>;
export type OwnerRemainderPort = Readonly<{
    capture(owner: ProcessOwnerRef): Promise<OwnerRemainderCapture | undefined>;
    captureTree(owner: ProcessOwnerRef, root: Readonly<{ pid: number; start?: ProcessStartIdentity }>): Promise<OwnerRemainderCapture | undefined>;
    end(owner: ProcessOwnerRef, captured?: OwnerRemainderCapture): Promise<OwnerRemainderResult>;
    /** Terminal close leaves nohup survivors alive, retaining evidence for LeftBehind. */
    observeEnd(owner: ProcessOwnerRef, captured?: OwnerRemainderCapture): Promise<OwnerRemainderResult>;
}>;

/** The daemon lifecycle consumes its existing census/root owner; this keeps no registry or sampler. */
export function createEndOwnerRemainder(input: Readonly<{
    processOwnershipRuntime: ReturnType<typeof createProcessOwnershipRuntime>;
    daemonScopeKey: string;
    platform?: NodeJS.Platform;
    firstPass(owner: ProcessOwnerRef): void | Promise<void>;
    retainEndedRoots?(roots: readonly HappierProcessRoot[]): void;
    /** OS boundary used by the canonical terminator, not a replacement ownership/signal path. */
    systemBoundary?: Parameters<typeof createProcessTreeTerminator>[0];
}>): OwnerRemainderPort {
    const terminate = createProcessTreeTerminator(input.systemBoundary);
    const reportUnavailable = (phase: SessionStopProcessFailure['phase'], reason: string): SessionStopProcessFailure => {
        const failure = { phase, reason };
        logger.infoFile('[process-remainder] Native owner observation unavailable',
            { code: 'process_owner_observation_unavailable', ...failure });
        return failure;
    };
    const unavailableCapture = (phase: SessionStopProcessFailure['phase'], reason: string): OwnerRemainderCapture =>
        ({ roots: [], ownership: [], processFailure: reportUnavailable(phase, reason) });
    function mergeCapturedRoots(current: readonly HappierProcessRoot[], captured: readonly HappierProcessRoot[], key: string) {
        const roots = [...current];
        for (const root of captured) {
            const index = roots.findIndex(candidate => candidate.pid === root.pid && equalProcessStart(candidate.start, root.start)
                && processOwnerKey(candidate.owner) === key);
            if (index < 0) roots.push(root);
            // Once the native root exits its current projection cannot read its
            // fence again. Keep the exact pre-exit witness for cleanup and rows.
            else roots[index] = { ...root, ...roots[index], containment: roots[index]!.containment ?? root.containment };
        }
        return roots;
    }
    function endedRoots(current: readonly HappierProcessRoot[], key: string, captured?: OwnerRemainderCapture) {
        const roots = mergeCapturedRoots(current, captured?.roots ?? [], key);
        const endedAtMs = Date.now();
        const ended = roots.filter(root => processOwnerKey(root.owner) === key)
            .map(root => ({ ...root, live: false, endedAtMs: root.endedAtMs ?? endedAtMs }));
        input.retainEndedRoots?.(ended);
        return { roots, ended };
    }
    async function firstPass(owner: ProcessOwnerRef) {
        await Promise.resolve().then(() => input.firstPass(owner)).catch(() => {
            logger.infoFile('[process-remainder] Left-behind observation unavailable', { code: 'left_behind_observation_unavailable' });
        });
    }
    function liveCapturedTreePids(owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[], snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>,
        targets: readonly Readonly<{ pid: number; start: ProcessStartIdentity }>[]) {
        const index = indexCensus(snapshot.rows);
        const live = roots.filter(root => {
            // A wrapper's reported worker and its Session-owned Runs share the
            // retiring lifetime. Only a different lifecycle protects a subtree.
            if (processOwnerKey(root.owner) === processOwnerKey(owner)
                || owner.kind === 'session' && root.owner.kind === 'run' && root.owner.sessionId === owner.sessionId) return false;
            const row = index.byPid.get(root.pid);
            return root.live && row && row.state !== 'zombie' && equalProcessStart(row.start, root.start)
                && targets.some(target => target.pid === root.pid && equalProcessStart(target.start, root.start));
        });
        return new Set([...live.map(root => root.pid), ...descendantsOf(index, live.map(root => root.pid)).map(row => row.pid)]);
    }
    return {
        async capture(owner) {
            const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
            if (view.status !== 'ok') return unavailableCapture('ownership_view', view.reason);
            const key = processOwnerKey(owner);
            return { roots: view.roots.filter(root => processOwnerKey(root.owner) === key),
                ownership: view.rows.filter(row => row.owner && processOwnerKey(row.owner) === key) };
        },
        async captureTree(owner, root) {
            const capture = await captureProcessTree(root);
            if (capture.status !== 'ok') return unavailableCapture('tree_capture', capture.reason);
            const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
            if (view.status !== 'ok') return unavailableCapture('ownership_view', view.reason);
            // Aliases of the retiring owner are one lifetime. Independently tracked
            // descendant roots and their subtrees keep their own lifecycle.
            const independent = liveCapturedTreePids(owner, view.roots, view.snapshot,
                capture.capturedTargets.filter(target => target.pid !== root.pid));
            const index = indexCensus(view.snapshot.rows);
            const key = processOwnerKey(owner);
            const starts = new Map(capture.capturedTargets.map(target => [target.pid, target.start]));
            const sources = new Map(view.roots.filter(candidate => processOwnerKey(candidate.owner) === key
                && starts.has(candidate.pid) && equalProcessStart(starts.get(candidate.pid)!, candidate.start))
                .map(candidate => [candidate.pid, candidate]));
            const owned = new Map(view.rows.filter(row => row.owner && processOwnerKey(row.owner) === key)
                .map(row => [row.pid, row]));
            // A generic daemon-owned subtree has no authority over shared-tag
            // peers. Logical evidence is retained only for a matched lifecycle root.
            return { scope: 'subtree', ownership: sources.size ? [...owned.values()] : [], roots: capture.capturedTargets.filter(target => !independent.has(target.pid)).map(target => {
                const candidate = sources.get(target.pid);
                const source = candidate && equalProcessStart(candidate.start, target.start) ? candidate : undefined;
                const containment = source?.containment;
                const members = containment?.kind === 'linux_unit' ? membersOfCgroup(index, containment.prefix)
                    : containment?.kind === 'windows_job' ? membersOfJob(index, containment.name) : [];
                const protectedPids = members.length ? liveCapturedTreePids(owner, view.roots, view.snapshot, members) : independent;
                // A witnessed root alone cannot authorize its shared daemon fence.
                // Every member must belong to this retiring physical/lifecycle tree.
                const exclusive = members.length > 0 && members.every(member => !protectedPids.has(member.pid)
                    && (starts.has(member.pid) && equalProcessStart(starts.get(member.pid)!, member.start)
                        || owned.get(member.pid)?.level === 'proven'
                            && owned.get(member.pid)!.evidence.some(evidence => evidence.kind === 'fence' && evidence.state === 'met')));
                return { ...source, owner, ...target, live: true, ownerCreatedAtMs: source?.ownerCreatedAtMs ?? capture.capturedAtMs,
                    ownerCreatedStartTimeMs: source?.ownerCreatedStartTimeMs ?? target.start.startTimeMs,
                    containment: exclusive ? containment : undefined };
            }) };
        },
        async observeEnd(owner, captured) {
            try {
                const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                const processFailure = view.status !== 'ok' ? reportUnavailable('ownership_view', view.reason) : captured?.processFailure;
                const key = processOwnerKey(owner);
                if (captured?.scope === 'subtree') {
                    // These exact native generations ended with their own spawner;
                    // the shared daemon owner and its unrelated peers remain live.
                    endedRoots([], key, captured);
                    return { status: processFailure ? 'unavailable' : 'complete', outcomes: [], ...(processFailure ? { processFailure } : {}) };
                }
                if (view.status === 'ok' && view.roots.some(root => root.live && processOwnerKey(root.owner) === key
                    && view.snapshot.rows.some(row => row.pid === root.pid && row.state !== 'zombie' && equalProcessStart(row.start, root.start)))) {
                    return { status: 'complete', outcomes: [] };
                }
                endedRoots(view.status === 'ok' ? view.roots : [], key, captured);
                return { status: processFailure ? 'unavailable' : 'complete', outcomes: [], ...(processFailure ? { processFailure } : {}) };
            } finally { await firstPass(owner); }
        },
        async end(owner, captured) {
            let departedCapturedTreeWithoutOtherMembers = false;
            let treeResult: OwnerRemainderResult | undefined;
            const withTreeResult = (result: OwnerRemainderResult): OwnerRemainderResult => {
                // A later logical census cannot reconstruct ancestry missed at
                // capture. Retain that uncertainty without retaining a dead runner.
                if (captured?.processFailure) result = { ...result, status: 'unavailable', processFailure: captured.processFailure };
                if (!treeResult) return result;
                const outcomes = new Map(treeResult.outcomes.map(outcome => [outcome.pid, outcome]));
                const updated = new Set(result.outcomes.map(outcome => outcome.pid));
                for (const outcome of result.outcomes) {
                    const earlier = outcomes.get(outcome.pid);
                    if (!earlier || outcome.outcome !== 'gone_before' || earlier.outcome === 'refused' || earlier.outcome === 'survived') {
                        outcomes.set(outcome.pid, outcome);
                    }
                }
                const unresolvedUnavailable = treeResult.status === 'unavailable' && (treeResult.outcomes.length === 0
                    || treeResult.outcomes.some(outcome => outcome.outcome === 'refused' && !updated.has(outcome.pid)));
                return { status: result.status === 'unavailable' || unresolvedUnavailable ? 'unavailable'
                    : result.status === 'incomplete' || [...outcomes.values()].some(outcome => outcome.outcome === 'refused' || outcome.outcome === 'survived')
                        ? 'incomplete' : 'complete', outcomes: [...outcomes.values()],
                    ...(result.processFailure ?? treeResult.processFailure ? { processFailure: result.processFailure ?? treeResult.processFailure } : {}) };
            };
            try {
                let view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                if (view.status !== 'ok') return withTreeResult({ status: 'unavailable', outcomes: [],
                    processFailure: reportUnavailable('ownership_view', view.reason) });
                const key = processOwnerKey(owner);
                if (captured?.scope === 'subtree') {
                    const live = liveCapturedTreePids(owner, view.roots, view.snapshot, captured.roots);
                    const targets = captured.roots.filter(target => !live.has(target.pid));
                    // An exact pre-exit tree is physical custody, including
                    // Run-tagged descendants. Logical owner projection cannot
                    // erase it after reparenting, or transfer it to a new PID.
                    endedRoots([], key, { ...captured, roots: targets });
                    const results: ProcessTreeTerminationResult[] = [];
                    // A reowned member protects only its own tree, never the
                    // other captured targets. Preserve descendants-first order.
                    for (const target of [...targets].reverse()) {
                        const observed = view.snapshot.rows.find(row => row.pid === target.pid);
                        if ((!observed && !view.snapshot.partial?.some(row => row.pid === target.pid))
                            || observed?.state === 'zombie' && equalProcessStart(observed.start, target.start)) {
                            // This fresh census already proves the captured generation
                            // departed. Re-reading the entire machine for each dead
                            // child delays both Stop and the waiting replacement.
                            results.push({ status: 'complete', outcomes: [{ pid: target.pid, outcome: 'gone_before' }] });
                            continue;
                        }
                        results.push(await terminate({ targets: [{ pid: target.pid, start: target.start }], tree: false,
                            async authorizeSignal() {
                                const current = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                                return current.status === 'ok' && !liveCapturedTreePids(owner, current.roots, current.snapshot, captured.roots).has(target.pid);
                            },
                            async authorizeSnapshot(snapshot) {
                                const current = await input.processOwnershipRuntime.resolveSnapshot(snapshot, undefined, { requesterAttribution: 'retained' });
                                return current.status === 'ok' && !liveCapturedTreePids(owner, current.roots, snapshot, captured.roots).has(target.pid);
                            },
                        }));
                    }
                    const capturedStarts = new Map(targets.map(target => [target.pid, target.start]));
                    // The fresh view already observed this entire tree gone. A
                    // second machine inventory has no survivor to confirm unless
                    // another observed member belongs to this retiring owner.
                    // Mutating, incomplete and unreadable cleanup still resample.
                    departedCapturedTreeWithoutOtherMembers = results.every(result => result.status === 'complete'
                        && result.outcomes.every(outcome => outcome.outcome === 'gone_before'))
                        && !view.rows.some(row => {
                            if (!row.owner || processOwnerKey(row.owner) !== key) return false;
                            const start = capturedStarts.get(row.pid);
                            return !start || !equalProcessStart(row.start, start);
                        });
                    treeResult = { status: results.some(result => result.status === 'unavailable') ? 'unavailable'
                        : results.some(result => result.status === 'incomplete') ? 'incomplete' : 'complete',
                        outcomes: results.flatMap(result => result.outcomes) };
                    const outlyingEvidence = captured.ownership.some(row => !capturedStarts.has(row.pid)
                        && row.level !== 'unknown' && row.evidence.some(evidence => evidence.state === 'met'
                            && (evidence.kind === 'marker' || evidence.kind === 'parent_chain')));
                    if (!captured.roots.some(root => root.containment) && !outlyingEvidence) return withTreeResult(treeResult);
                    // Detached, empty-environment members can leave the tree before
                    // capture. The same owner/fence terminator still owns their end,
                    // including fresh members forked during its gentle/force rounds.
                    departedCapturedTreeWithoutOtherMembers = false;
                    view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                    if (view.status !== 'ok') return withTreeResult({ status: 'unavailable', outcomes: [],
                        processFailure: reportUnavailable('ownership_view', view.reason) });
                }
                // A resumed owner reowns its tagged processes. An older exit cannot retire it.
                const liveOwner = view.roots.some(root => root.live && processOwnerKey(root.owner) === key
                    && view.snapshot.rows.some(row => row.pid === root.pid && row.state !== 'zombie' && equalProcessStart(row.start, root.start)));
                if (liveOwner) return withTreeResult({ status: 'complete', outcomes: [] });
                const { roots, ended } = endedRoots(view.roots, key, captured);
                const ownership = resolveProcessOwnership({ snapshot: view.snapshot,
                    roots: [...roots.filter(root => processOwnerKey(root.owner) !== key), ...ended],
                    daemonPrincipal: view.snapshot.rows.find(row => row.pid === process.pid)?.principal ?? null,
                    daemonScopeKey: input.daemonScopeKey, platform: input.platform,
                    capturedOwnership: captured?.ownership });
                const attributedRows = ownership.filter(row => row.owner && processOwnerKey(row.owner) === key);
                const independent = liveCapturedTreePids(owner, view.roots, view.snapshot, attributedRows);
                const ownedRows = attributedRows.filter(row => !independent.has(row.pid));
                // Group/port-only evidence is a hint for the daemon's two-pass tracker, never kill authority.
                const targets = ownedRows.filter(row => row.level !== 'unknown' && row.evidence.some(evidence =>
                    evidence.state === 'met' && ['fence', 'parent_chain', 'marker'].includes(evidence.kind)));
                const fences = new Map<string, NonNullable<Parameters<typeof terminate>[0]['containment']>>();
                for (const root of ended) {
                    if (root.containment?.kind === 'linux_unit') fences.set(`linux:${root.containment.prefix}`,
                        { kind: 'linux_unit', prefix: root.containment.prefix });
                    else if (root.containment?.kind === 'windows_job') fences.set(`windows:${root.containment.name}`, root.containment);
                }
                const containment = fences.size === 1 ? fences.values().next().value : undefined;
                const censusIndex = indexCensus(view.snapshot.rows);
                const members = containment?.kind === 'linux_unit' ? membersOfCgroup(censusIndex, containment.prefix)
                    : containment?.kind === 'windows_job' ? membersOfJob(censusIndex, containment.name) : [];
                // Preserve whole-fence cleanup only when every fresh member belongs to this owner;
                // a swapped live owner in an old physical fence is an exact-identity sweep instead.
                const exclusiveContainment = containment && members.every(member => targets.some(target =>
                    target.pid === member.pid && equalProcessStart(target.start, member.start))) ? containment : undefined;
                // This fresh view proves nothing remains to signal: the terminator's
                // rounds would re-read the whole machine to change nothing. A Windows
                // Job's members appear only in the terminator's verified Job read.
                if (targets.length === 0 && members.length === 0 && containment?.kind !== 'windows_job'
                    && !(containment && view.snapshot.partial?.some(row => row.missing.includes('cgroup')))) {
                    return withTreeResult({ status: ownedRows.length > 0 ? 'incomplete' : 'complete', outcomes: [] });
                }
                let authorizedSnapshot = view.snapshot;
                const authorize = async (snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>) => {
                    const current = await input.processOwnershipRuntime.resolveSnapshot(snapshot, undefined, { requesterAttribution: 'retained' });
                    if (current.status !== 'ok') return false;
                    if (current.roots.some(root => root.live && processOwnerKey(root.owner) === key
                        && snapshot.rows.some(row => row.pid === root.pid && row.state !== 'zombie' && equalProcessStart(row.start, root.start)))) return false;
                    // Current live/resumed roots retain precedence over captured ended facts.
                    const known = mergeCapturedRoots(current.roots, ended, key);
                    const ownership = resolveProcessOwnership({ snapshot, roots: known,
                        daemonPrincipal: snapshot.rows.find(row => row.pid === process.pid)?.principal ?? null,
                        daemonScopeKey: input.daemonScopeKey, platform: input.platform, capturedOwnership: captured?.ownership });
                    const index = indexCensus(snapshot.rows);
                    const freshMembers = exclusiveContainment?.kind === 'linux_unit' ? membersOfCgroup(index, exclusiveContainment.prefix)
                        : exclusiveContainment?.kind === 'windows_job' ? membersOfJob(index, exclusiveContainment.name)
                        : snapshot.rows.filter(row => targets.some(target => row.pid === target.pid && equalProcessStart(row.start, target.start)));
                    const protectedPids = liveCapturedTreePids(owner, current.roots, snapshot, freshMembers);
                    // Positive zombie state already proves exit; ownership
                    // enrichment may disappear before the kernel reaps it.
                    return freshMembers.every(member => !protectedPids.has(member.pid) && (member.state === 'zombie' || ownership.some(row => row.pid === member.pid
                        && equalProcessStart(row.start, member.start) && row.ownerEnded && row.owner
                        && processOwnerKey(row.owner) === key && row.level !== 'unknown'
                        && row.evidence.some(evidence => evidence.state === 'met' && ['fence', 'parent_chain', 'marker'].includes(evidence.kind)))));
                };
                const result = await terminate({ targets: targets.map(row => ({ pid: row.pid, start: row.start })), tree: false,
                    ...(exclusiveContainment ? { containment: exclusiveContainment } : {}),
                    async authorizeSnapshot(snapshot) {
                        authorizedSnapshot = snapshot;
                        return authorize(snapshot);
                    },
                    // The terminator just rechecked native identity. Re-read the
                    // lifecycle roots too, without another machine census per PID.
                    authorizeSignal: () => authorize(authorizedSnapshot),
                });
                const incomplete = ownedRows.length > targets.length || result.outcomes.some(row => row.outcome === 'refused' || row.outcome === 'survived');
                return withTreeResult({ status: result.status === 'unavailable' ? 'unavailable' : incomplete || result.status === 'incomplete' ? 'incomplete' : 'complete', outcomes: result.outcomes });
            } finally {
                if (!departedCapturedTreeWithoutOtherMembers) await firstPass(owner);
            }
        },
    };
}
