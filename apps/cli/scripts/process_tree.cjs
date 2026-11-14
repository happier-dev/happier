// One identity-safe process-tree owner for CLI callers and the standalone terminal launcher.
async function taskkillWindowsProcessTree(input, windowsSystemToolCommand, execFileWithDeadline) {
    const args = ['/PID', String(input.pid), ...(input.tree === false ? [] : ['/T']), ...(input.force ? ['/F'] : [])];
    try {
        await (input.execFile ?? execFileWithDeadline)(windowsSystemToolCommand('taskkill.exe'), args, {
            timeout: input.timeoutMs,
            terminateOnAbort: async child => { child.kill('SIGKILL'); },
        });
    } catch (error) {
        if (error?.code === 128 && error?.killed !== true) return;
        throw error;
    }
}

function createProcessTreeOwner({ readProcessCensus, indexCensus, descendantsOf, protectedSet,
    membersOfCgroup, membersOfJob, membersOfPgid, probeProcessGroupLiveness, taskkillWindowsProcessTree, terminateWindowsJob,
    platform, windowsJobTerminationBudgetMs, kill = (pid, signal) => process.kill(pid, signal),
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const sameStart = (left, right) => Number.isFinite(left?.startTimeMs) && left.startTimeMs === right?.startTimeMs
        && (!left.native || !right.native || left.native === right.native);
    const samePrincipal = (left, right) => left && right && left.kind === right.kind && left.value === right.value;
    const present = row => row && row.state !== 'zombie';
    const incomplete = result => Object.assign(new Error('Process-tree termination could not be verified'), {
        code: 'plugin_exec_termination_incomplete', result,
    });
    async function census(containment, targetPids, fields, includeDescendants = false, onUnavailable) {
        try {
            const snapshot = await readProcessCensus({ freshness: 'fresh', scope: 'all',
                ...(fields === undefined ? {} : { fields }),
                ...(targetPids === undefined ? {} : { pids: Array.isArray(targetPids) ? targetPids : [targetPids], includeAncestors: true, includeDescendants }),
                ...(containment?.kind === 'windows_job' ? { verifiedJobNames: [containment.name] } : {}) });
            if (snapshot.status !== 'ok') { onUnavailable?.(snapshot.reason); return null; }
            if (new Set(snapshot.rows.map(row => row.pid)).size !== snapshot.rows.length) {
                onUnavailable?.('duplicate_process_identity'); return null;
            }
            if (containment?.kind === 'windows_job') {
                const job = snapshot.jobObservations?.find(job => job.name === containment.name);
                if (!job || job.state === 'unavailable' || (job.state === 'live'
                    && (!job.pids || job.pids.some(pid => !snapshot.rows.some(row => row.pid === pid))))) return null;
            }
            return { snapshot, index: indexCensus(snapshot.rows) };
        } catch { onUnavailable?.('read_failed'); return null; }
    }
    function refusal(table, expected) {
        if (table.authorityRefused) return 'containment_authority_changed';
        const row = table.index.byPid.get(expected.pid);
        if (!row) return table.snapshot.partial?.some(item => item.pid === expected.pid) ? 'identity_unavailable' : null;
        if (!sameStart(expected.start, row.start)) return 'identity_changed';
        if (!samePrincipal(row.principal, table.index.byPid.get(process.pid)?.principal)) return 'principal_unavailable';
        if (protectedSet(table.index, process.pid, { signalExtent: 'process' }).has(row.pid)) return 'protected_process';
        return null;
    }
    async function captureTargets(root) {
        // Capture retains native identities and ancestry only. Commands, credentials,
        // containment and metrics are demanded separately by their actual consumers.
        let failureReason = 'census_unavailable';
        const table = await census(undefined, [root.pid], [], true, reason => { failureReason = reason; });
        if (!table) return { status: 'unavailable', reason: failureReason };
        const row = table.index.byPid.get(root.pid);
        if (!present(row)) return { status: 'refused', reason: 'root_missing' };
        const expected = { pid: root.pid, start: root.start ?? row.start };
        const reason = refusal(table, expected);
        if (reason) return { status: 'refused', reason };
        const rows = [row, ...descendantsOf(table.index, [root.pid])].filter(present);
        // Retaining observed descendants grants no signal authority. An isolated
        // native child can have a different UID/SID; the terminator still checks
        // each target's current principal and generation immediately before effect.
        return { status: 'ok', capturedAtMs: table.snapshot.capturedAtMs,
            capturedTargets: rows.map(member => ({ pid: member.pid, start: member.start })) };
    }
    async function terminateTargets(input, options = {}) {
        let signalAuthorityRefused = false;
        const captured = new Map();
        const read = async () => {
            // Ordinary teardown consumes identity/ancestry plus memory accounting,
            // not every process's command or environment. Policy callbacks still
            // receive the full fresh observations they use to authorize cleanup.
            // Explicit fences can contain reparented peers; policy callbacks
            // consume full ownership evidence. Ordinary trees need only current
            // roots, retained generations (even after reparenting), and children.
            const pids = input.containment || input.authorizeSnapshot ? undefined
                : [...new Set([...(input.targets ?? []).map(target => target.pid), ...captured.keys()])];
            const table = await census(input.containment, pids, input.authorizeSnapshot ? undefined
                : ['memory', ...(input.containment?.kind === 'linux_unit' ? ['cgroup'] : [])],
                input.tree !== false || input.captureDescendants === true);
            return table;
        };
        const authorizeSignal = async () => {
            if (!input.authorizeSignal) return true;
            let current = false;
            try { current = await input.authorizeSignal(); } catch {}
            signalAuthorityRefused ||= !current;
            return current;
        };
        // Preserve the existing listener and ordinary-tree budgets at their canonical owner.
        const graceMs = Math.max(1, options.graceMs ?? input.graceMs
            ?? (input.rootKind === 'service' || input.rootKind === 'dev_server' ? 4000 : 1000));
        const first = await read();
        const requested = input.targets ?? [];
        if (!first) return { status: 'unavailable', outcomes: requested.map(target => ({ pid: target.pid, outcome: 'refused', reason: 'census_unavailable' })) };
        const continuation = new Map();
        const outcomes = new Map();
        let verificationUnavailable = false;
        for (const target of requested) {
            const root = first.index.byPid.get(target.pid);
            if (!root) {
                const missing = first.snapshot.partial?.some(item => item.pid === target.pid);
                outcomes.set(target.pid, { pid: target.pid, outcome: missing ? 'refused' : 'gone_before', ...(missing ? { reason: 'identity_unavailable' } : {}) });
                continue;
            }
            const expected = { pid: target.pid, start: target.start ?? root.start };
            const reason = refusal(first, expected);
            if (reason) { outcomes.set(target.pid, { pid: target.pid, outcome: 'refused', reason }); continue; }
            if (!present(root)) { outcomes.set(target.pid, { pid: target.pid, outcome: 'gone_before' }); continue; }
            captured.set(root.pid, root);
            if (input.captureDescendants) {
                continuation.set(root.pid, { pid: root.pid, start: root.start });
                for (const row of descendantsOf(first.index, [root.pid])) {
                    const childReason = refusal(first, row);
                    if (childReason) outcomes.set(row.pid, { pid: row.pid, outcome: 'refused', reason: childReason });
                    else if (present(row)) continuation.set(row.pid, { pid: row.pid, start: row.start });
                }
            }
            if (input.tree !== false) {
                for (const row of descendantsOf(first.index, [root.pid])) {
                    const childReason = refusal(first, row);
                    if (childReason) outcomes.set(row.pid, { pid: row.pid, outcome: 'refused', reason: childReason });
                    else if (present(row)) captured.set(row.pid, row);
                }
            }
        }
        function addMembers(table) {
            if (table.authorityRefused) {
                for (const row of captured.values()) if (!outcomes.has(row.pid)) outcomes.set(row.pid,
                    { pid: row.pid, outcome: 'refused', reason: 'containment_authority_changed' });
                return;
            }
            // A vacated or recycled numeric root never grants authority to new children.
            const liveRoots = [...captured.values()].filter(row => !outcomes.has(row.pid)
                && present(table.index.byPid.get(row.pid)) && !refusal(table, row));
            const discovered = input.tree === false ? [] : [...descendantsOf(table.index, liveRoots.map(row => row.pid))];
            // Explicit containment is independently established by the lifecycle owner,
            // unlike a numeric PID whose vanished generation grants no discovery authority.
            if (input.containment?.kind === 'linux_unit') discovered.push(...membersOfCgroup(table.index, input.containment.prefix));
            if (input.containment?.kind === 'windows_job') discovered.push(...membersOfJob(table.index, input.containment.name));
            for (const row of discovered) {
                if (captured.has(row.pid) || outcomes.has(row.pid) || !present(row)) continue;
                const reason = refusal(table, row);
                if (reason) outcomes.set(row.pid, { pid: row.pid, outcome: 'refused', reason });
                else captured.set(row.pid, row);
            }
        }
        async function authorizeTable(table) {
            if (!input.authorizeSnapshot) return;
            try { table.authorityRefused = !await input.authorizeSnapshot(table.snapshot,
                [...captured.values()].map(row => ({ pid: row.pid, start: row.start }))); }
            catch { table.authorityRefused = true; }
            if (table.authorityRefused) addMembers(table);
        }
        if (input.authorizeSnapshot) {
            addMembers(first);
            await authorizeTable(first);
            // No signal has been sent, so an initial policy refusal has no
            // physical exit to wait for under the existing termination grace.
            if (first.authorityRefused) return { status: 'incomplete', outcomes: [...outcomes.values()],
                ...(input.captureDescendants ? { capturedTargets: [...continuation.values()] } : {}) };
        }
        const signalFor = options.firstSignal ?? input.firstSignal ?? (input.policy === 'kill' ? 'SIGKILL' : input.rootKind === 'pty' ? 'SIGHUP'
            : input.rootKind === 'service' || input.rootKind === 'dev_server' ? 'SIGINT' : 'SIGTERM');
        async function signalRound(signal, timeoutMs) {
            const table = await read();
            if (!table) {
                verificationUnavailable = true;
                for (const row of captured.values()) if (!outcomes.has(row.pid)) outcomes.set(row.pid, { pid: row.pid, outcome: 'refused', reason: 'census_unavailable' });
                return;
            }
            addMembers(table);
            await authorizeTable(table);
            const eligible = new Map();
            for (const expected of captured.values()) {
                if (outcomes.has(expected.pid)) continue;
                const reason = refusal(table, expected);
                if (reason) { outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused', reason }); continue; }
                if (present(table.index.byPid.get(expected.pid))) eligible.set(expected.pid, table.index.byPid.get(expected.pid));
            }
            const roots = [...eligible.values()].filter(row => !eligible.has(row.ppid));
            const ordered = input.tree === false ? [...eligible.values()].reverse()
                : [...roots, ...descendantsOf(table.index, roots.map(row => row.pid))]
                    .filter(row => eligible.has(row.pid));
            const windows = (platform ?? process.platform) === 'win32';
            const covered = new Set();
            // Trees stop a waiting shell before releasing its child; explicit
            // remainder targets retain their descendants-first order.
            // Each effect still needs the target's current native identity:
            // an admitted table cannot authorize a subsequently reused PID.
            for (const expected of ordered) {
                if (covered.has(expected.pid)) continue;
                const fresh = await census(undefined, expected.pid, [], windows && input.tree !== false);
                if (!fresh) {
                    verificationUnavailable = true;
                    outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused', reason: 'census_unavailable' });
                    continue;
                }
                const reason = refusal(fresh, expected);
                if (reason) { outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused', reason }); continue; }
                if (!present(fresh.index.byPid.get(expected.pid))) continue;
                if (!await authorizeSignal()) {
                    outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused', reason: 'containment_authority_changed' });
                    continue;
                }
                try {
                    if (windows) {
                        const descendants = input.tree === false ? [] : descendantsOf(fresh.index, [expected.pid]);
                        const tree = input.tree !== false && descendants.every(row => eligible.has(row.pid)
                            && !refusal(fresh, eligible.get(row.pid)));
                        // taskkill owns Windows tree ordering. Do not separately
                        // kill children after a headless root's gentle failure.
                        if (tree) for (const row of descendants) covered.add(row.pid);
                        await (options.terminateWindowsTree ?? taskkillWindowsProcessTree)({ pid: expected.pid, tree, force: signal === 'SIGKILL', timeoutMs });
                    } else kill(expected.pid, signal);
                } catch (error) {
                    const permissionDenied = error?.code === 'EPERM' || error?.code === 'EACCES';
                    // Headless Windows processes cannot accept taskkill's gentle request.
                    // Keep that generation eligible for the independently rechecked force round.
                    if (error?.code !== 'ESRCH' && (permissionDenied || signal === 'SIGKILL')) {
                        outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused',
                            reason: permissionDenied ? 'permission_denied' : 'signal_failed' });
                    }
                }
            }
        }
        async function verify() {
            const table = await read();
            if (!table) { verificationUnavailable = true; return false; }
            addMembers(table);
            await authorizeTable(table);
            for (const expected of captured.values()) {
                const previous = outcomes.get(expected.pid);
                if (previous && (previous.outcome !== 'refused' || previous.reason !== 'containment_authority_changed')) continue;
                // Loss of signal authority is not liveness evidence. Keep observing
                // within the existing grace, without signaling a refused member again.
                if (previous) {
                    const row = table.index.byPid.get(expected.pid);
                    if (!table.authorityRefused && (row ? row.state === 'zombie' && sameStart(expected.start, row.start)
                        : !table.snapshot.partial?.some(item => item.pid === expected.pid))) {
                        outcomes.set(expected.pid, { pid: expected.pid, outcome: 'ended',
                            ...(expected.memory ? { freedBytes: expected.memory.bytes } : {}) });
                    }
                    continue;
                }
                const reason = refusal(table, expected);
                if (reason) outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused', reason });
                else if (!present(table.index.byPid.get(expected.pid))) outcomes.set(expected.pid, {
                    pid: expected.pid, outcome: 'ended', ...(expected.memory ? { freedBytes: expected.memory.bytes } : {}),
                });
            }
            return [...captured.keys()].every(pid => {
                const outcome = outcomes.get(pid);
                return outcome && !(outcome.outcome === 'refused' && outcome.reason === 'containment_authority_changed');
            });
        }
        const nativeJobKill = input.policy === 'kill' && (platform ?? process.platform) === 'win32'
            && input.containment?.kind === 'windows_job';
        if (nativeJobKill) {
            // Existing verified custody stops use the native Job's own budget, not
            // a second gentle/force sequence. Fresh identities protect every member.
            addMembers(first);
            const fresh = await read();
            if (!fresh) verificationUnavailable = true;
            else {
                addMembers(fresh);
                await authorizeTable(fresh);
                const members = membersOfJob(fresh.index, input.containment.name);
                if (!fresh.authorityRefused && members.length && ![...outcomes.values()].some(row => row.outcome === 'refused')
                    && members.every(row => captured.has(row.pid) && !refusal(fresh, captured.get(row.pid))) && await authorizeSignal()) {
                    await terminateWindowsJob?.({ jobName: input.containment.name,
                        timeoutMs: windowsJobTerminationBudgetMs }).catch(() => undefined);
                }
            }
            await verify();
        } else {
            await signalRound(signalFor, graceMs);
            const gracefulDeadline = Date.now() + graceMs;
            if (input.waitForExit !== false) {
                while (!await verify() && Date.now() < gracefulDeadline) await wait(Math.min(25, Math.max(0, gracefulDeadline - Date.now())));
            }
            if (input.waitForExit !== false && [...captured.keys()].some(pid => !outcomes.has(pid))) {
                const forceMs = Math.min(250, graceMs);
                if ((platform ?? process.platform) === 'win32' && input.containment?.kind === 'windows_job' && terminateWindowsJob) {
                    const fresh = await read();
                    if (fresh) {
                        addMembers(fresh);
                        await authorizeTable(fresh);
                        const members = membersOfJob(fresh.index, input.containment.name);
                        if (!fresh.authorityRefused && members.length && members.every(row => captured.has(row.pid) && !refusal(fresh, captured.get(row.pid))) && await authorizeSignal()) {
                            await terminateWindowsJob({ jobName: input.containment.name, timeoutMs: forceMs }).catch(() => undefined);
                        }
                    }
                }
                await signalRound('SIGKILL', forceMs);
                const forceDeadline = Date.now() + forceMs;
                while (!await verify() && Date.now() < forceDeadline) await wait(Math.min(25, Math.max(0, forceDeadline - Date.now())));
            }
        }
        const final = await read();
        if (!final) verificationUnavailable = true;
        else await authorizeTable(final);
        for (const expected of captured.values()) {
            const previous = outcomes.get(expected.pid);
            if (previous) {
                // Procfs may lose status/start while a signalled generation exits.
                // Never signal that unreadable row; the final fresh observation
                // can still prove this previously authorized identity is now absent.
                if (!verificationUnavailable && !signalAuthorityRefused && final && !final.authorityRefused
                    && previous.outcome === 'refused'
                    && ['principal_unavailable', 'identity_unavailable', 'containment_authority_changed'].includes(previous.reason)
                    && (final.index.byPid.has(expected.pid)
                        ? final.index.byPid.get(expected.pid).state === 'zombie' && sameStart(expected.start, final.index.byPid.get(expected.pid).start)
                        : !final.snapshot.partial?.some(item => item.pid === expected.pid))) {
                    outcomes.set(expected.pid, { pid: expected.pid, outcome: 'ended',
                        ...(expected.memory ? { freedBytes: expected.memory.bytes } : {}) });
                }
                continue;
            }
            if (!final) outcomes.set(expected.pid, { pid: expected.pid, outcome: 'refused', reason: 'verification_unavailable' });
            else {
                const reason = refusal(final, expected);
                outcomes.set(expected.pid, reason ? { pid: expected.pid, outcome: 'refused', reason }
                    : present(final.index.byPid.get(expected.pid)) ? { pid: expected.pid, outcome: 'survived' }
                    : { pid: expected.pid, outcome: 'ended', ...(expected.memory ? { freedBytes: expected.memory.bytes } : {}) });
            }
        }
        const resultOutcomes = [...outcomes.values()];
        return { status: verificationUnavailable ? 'unavailable'
            : signalAuthorityRefused || final?.authorityRefused || resultOutcomes.some(row => row.outcome === 'refused' || row.outcome === 'survived') ? 'incomplete' : 'complete', outcomes: resultOutcomes,
            ...(input.captureDescendants ? { capturedTargets: [...continuation.values()] } : {}) };
    }
    async function terminateProcessTree(proc, options) {
        if (!proc.pid) return;
        if ((proc.exitCode !== null && proc.exitCode !== undefined) || (proc.signalCode !== null && proc.signalCode !== undefined)) {
            // Group members can only be found by a census of every process. ESRCH for
            // the group proves none exists (a later group with this number is another
            // group), so the whole-machine read is needed only when that is unproven.
            const groupUnproven = options?.ownedProcessGroup && probeProcessGroupLiveness?.(proc.pid) !== 'absent';
            const table = await census(undefined, groupUnproven ? undefined : [proc.pid], []);
            if (!table || present(table.index.byPid.get(proc.pid))) throw incomplete({ outcomes: [{ pid: proc.pid, outcome: 'refused', reason: 'identity_changed' }] });
            if (groupUnproven && membersOfPgid(table.index, proc.pid).some(present)) {
                throw incomplete({ outcomes: [{ pid: proc.pid, outcome: 'refused', reason: 'root_missing' }] });
            }
            return;
        }
        const result = await terminateTargets({ targets: [{ pid: proc.pid, start: proc.start }], tree: options?.tree !== false }, options);
        if (result.status !== 'complete') throw incomplete(result);
    }
    return { terminateProcessTree, terminateTargets, captureTargets };
}

async function terminateProcessTree(proc, options) {
    if (!proc.pid) return;
    const [processTools, processes] = await Promise.all([import('@happier-dev/cli-common/process'), import('#process-census')]);
    const owner = createProcessTreeOwner({ ...processTools, ...processes,
        taskkillWindowsProcessTree: input => taskkillWindowsProcessTree(input, processTools.windowsSystemToolCommand, processTools.execFileWithDeadline),
    });
    await owner.terminateProcessTree(proc, options);
}

module.exports = { createProcessTreeOwner, terminateProcessTree, taskkillWindowsProcessTree };
