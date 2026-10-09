// One process-tree algorithm for CLI callers and the standalone terminal launcher.
// The factory admits genuine OS adapters; the launcher resolves its shipped dependency closure.
async function taskkillWindowsProcessTree(input, windowsSystemToolCommand, execFileWithDeadline) {
    const args = ['/PID', String(input.pid), '/T', ...(input.force ? ['/F'] : [])];
    const run = input.execFile ?? execFileWithDeadline;
    try {
        // The containing teardown owns the budget. Force-stop the tool itself when it
        // stalls so its late /T cannot race cleanup after this operation has returned.
        await run(windowsSystemToolCommand('taskkill.exe'), args, {
            timeout: input.timeoutMs,
            terminateOnAbort: async (child) => { child.kill('SIGKILL'); },
        });
    } catch (error) {
        // Exit 128 is the only benign, idempotent result; localized text cannot establish it.
        if (error?.code === 128 && error?.killed !== true) return;
        throw error;
    }
}

function createProcessTreeOwner({ psList, execFileWithDeadline, isPidPresent, probeProcessGroupLiveness, taskkillWindowsProcessTree }) {
    const DESCENDANT_DISCOVERY_TIMEOUT_MS = 150;
    const DESCENDANT_DISCOVERY_INTERVAL_MS = 25;
    const DIRECT_CHILD_COMMAND_TIMEOUT_MS = 500;
    async function readDescendantPids(rootPid, timeoutMs) {
        const timedOut = Symbol('descendant-discovery-timeout');
        let timer = null;
        const processes = await Promise.race([
            psList(),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(timedOut), Math.max(1, timeoutMs));
                timer.unref?.();
            }),
        ]).finally(() => {
            if (timer)
                clearTimeout(timer);
        });
        if (processes === timedOut)
            return null;
        const childrenByParent = new Map();
        for (const p of processes) {
            if (typeof p.pid !== 'number' || typeof p.ppid !== 'number')
                continue;
            const list = childrenByParent.get(p.ppid) ?? [];
            list.push(p.pid);
            childrenByParent.set(p.ppid, list);
        }
        const out = [];
        const seen = new Set();
        const visit = (pid) => {
            const kids = childrenByParent.get(pid) ?? [];
            for (const childPid of kids) {
                if (seen.has(childPid))
                    continue;
                seen.add(childPid);
                visit(childPid);
                out.push(childPid);
            }
        };
        visit(rootPid);
        return out;
    }
    async function resolveDescendantPids(rootPid, onUnverifiedDiscovery) {
        const descendants = new Set();
        const startedAt = Date.now();
        while (Date.now() - startedAt < DESCENDANT_DISCOVERY_TIMEOUT_MS) {
            const remainingMs = DESCENDANT_DISCOVERY_TIMEOUT_MS - (Date.now() - startedAt);
            const current = await readDescendantPids(rootPid, remainingMs);
            if (current === null) {
                onUnverifiedDiscovery();
                break;
            }
            for (const pid of current)
                descendants.add(pid);
            if (descendants.size > 0)
                break;
            await new Promise((resolve) => setTimeout(resolve, DESCENDANT_DISCOVERY_INTERVAL_MS));
        }
        return Array.from(descendants);
    }
    function bestEffortKillPid(pid, signal) {
        try {
            process.kill(pid, signal);
        }
        catch {
            // ignore
        }
    }
    async function bestEffortSignalDirectChildren(parentPid, signal) {
        if (process.platform === 'win32')
            return;
        const signalName = signal.replace(/^SIG/, '');
        // Signal-only: nothing reads this command's output, and `pkill` exits 1 when nothing matched.
        await execFileWithDeadline('pkill', [`-${signalName}`, '-P', String(parentPid)], {
            timeout: DIRECT_CHILD_COMMAND_TIMEOUT_MS,
        }).catch(() => { });
    }
    async function bestEffortReadDirectChildPids(parentPid, onUnverifiedDiscovery) {
        if (process.platform === 'win32')
            return [];
        // The deadline is owned here rather than by `child_process`, whose `timeout` destroys a
        // finished `pgrep`'s buffered pid list and still reports success. That empty list is read below
        // as "this process has no direct children", and the kill walks past them — leaving the user's
        // agent subprocesses running after their session was terminated.
        //
        // `pgrep` exits 1 when nothing matched. Other failures may retain useful partial
        // output, but an unavailable command is not proof that there are no direct children.
        const stdout = await execFileWithDeadline('pgrep', ['-P', String(parentPid)], {
            timeout: DIRECT_CHILD_COMMAND_TIMEOUT_MS,
        }).then((result) => String(result.stdout ?? ''), (error) => {
            if (error?.code !== 1) onUnverifiedDiscovery();
            return String(error?.stdout ?? '');
        });
        const childPids = stdout
            .split(/\s+/)
            .map((value) => Number.parseInt(value, 10))
            .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== parentPid);
        return Array.from(new Set(childPids));
    }
    function bestEffortKillProcessGroup(groupLeaderPid, signal) {
        if (process.platform === 'win32')
            return;
        try {
            process.kill(-groupLeaderPid, signal);
        }
        catch {
            // ignore
        }
    }
    async function waitForAllGone(pids, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (pids.every((pid) => !isPidPresent(pid)))
                return;
            await new Promise((r) => setTimeout(r, 25));
        }
    }
    async function waitForProcessGroupGone(groupLeaderPid, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (probeProcessGroupLiveness(groupLeaderPid) === 'absent')
                return true;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return probeProcessGroupLiveness(groupLeaderPid) === 'absent';
    }
    function terminationIncomplete() {
        return Object.assign(new Error('Process-tree termination could not be verified'), { code: 'plugin_exec_termination_incomplete' });
    }
    async function killProcessTree(proc, opts) {
        const pid = proc.pid;
        if (!pid)
            return;
        const graceMs = Math.max(1, opts?.graceMs ?? 1000);
        const rootIsTerminal = ((proc.exitCode !== null && proc.exitCode !== undefined)
            || (proc.signalCode !== null && proc.signalCode !== undefined));
        if (rootIsTerminal && !opts?.ownedProcessGroup && isPidPresent(pid)) {
            // Without an explicit group-custody fact, a terminal root's numeric PID
            // may already name a replacement. Preserve the existing fail-closed rule;
            // managed SVC09 passes its owned group fact explicitly below.
            throw terminationIncomplete();
        }
        const shouldSignalProcessGroup = process.platform !== 'win32'
            && (!rootIsTerminal || opts?.ownedProcessGroup === true)
            && probeProcessGroupLiveness(pid) !== 'absent';
        let censusVerified = true;
        let directChildrenVerified = process.platform !== 'win32';
        // Capture escaped descendants BEFORE any signal can kill their parent
        // and reparent them. The owned group still covers same-group late forks;
        // group absence alone cannot prove that an escaped child was stopped.
        const [descendants, directChildren] = await Promise.all([
            resolveDescendantPids(pid, () => { censusVerified = false; }).catch(() => {
                censusVerified = false;
                return [];
            }),
            process.platform === 'win32' ? Promise.resolve([])
                : bestEffortReadDirectChildPids(pid, () => { directChildrenVerified = false; }),
        ]);
        if (shouldSignalProcessGroup)
            bestEffortKillProcessGroup(pid, 'SIGTERM');
        if (process.platform !== 'win32') {
            await bestEffortSignalDirectChildren(pid, 'SIGTERM');
        }
        const all = Array.from(new Set([...descendants, ...directChildren, pid]));
        if (process.platform === 'win32') {
            const terminateWindowsTree = opts?.terminateWindowsTree ?? taskkillWindowsProcessTree;
            let windowsTreeVerified = false;
            const gracefulDeadline = Date.now() + graceMs;
            try {
                await terminateWindowsTree({ pid, force: false, timeoutMs: graceMs });
                windowsTreeVerified = true;
            }
            catch {
                for (const targetPid of all)
                    bestEffortKillPid(targetPid, 'SIGTERM');
            }
            await waitForAllGone(all, Math.max(0, gracefulDeadline - Date.now()));
            const remaining = all.filter((targetPid) => isPidPresent(targetPid));
            if (remaining.length === 0) {
                if (!censusVerified && !windowsTreeVerified) throw terminationIncomplete();
                return;
            }
            const forceMs = Math.min(250, graceMs);
            const forceDeadline = Date.now() + forceMs;
            try {
                await terminateWindowsTree({ pid, force: true, timeoutMs: forceMs });
                windowsTreeVerified = true;
            }
            catch {
                for (const targetPid of remaining)
                    bestEffortKillPid(targetPid, 'SIGKILL');
            }
            await waitForAllGone(remaining, Math.max(0, forceDeadline - Date.now()));
            if (remaining.some((targetPid) => isPidPresent(targetPid)) || (!censusVerified && !windowsTreeVerified)) {
                throw terminationIncomplete();
            }
            return;
        }
        for (const targetPid of all) {
            if (targetPid !== pid)
                await bestEffortSignalDirectChildren(targetPid, 'SIGTERM');
        }
        for (const targetPid of all)
            bestEffortKillPid(targetPid, 'SIGTERM');
        await waitForAllGone(all, graceMs);
        const remaining = all.filter((p) => isPidPresent(p));
        if (remaining.length === 0 && !shouldSignalProcessGroup) {
            if (!censusVerified && !directChildrenVerified) throw terminationIncomplete();
            return;
        }
        if (shouldSignalProcessGroup) {
            bestEffortKillProcessGroup(pid, 'SIGTERM');
            await new Promise((resolve) => setTimeout(resolve, Math.min(100, graceMs)));
            bestEffortKillProcessGroup(pid, 'SIGKILL');
            if (!await waitForProcessGroupGone(pid, Math.min(250, graceMs))) {
                throw terminationIncomplete();
            }
        }
        if (remaining.length === 0)
            return;
        for (const targetPid of remaining)
            await bestEffortSignalDirectChildren(targetPid, 'SIGKILL');
        for (const targetPid of remaining)
            bestEffortKillPid(targetPid, 'SIGKILL');
        await waitForAllGone(remaining, Math.min(250, graceMs));
        if (remaining.some((targetPid) => isPidPresent(targetPid))
            || (!censusVerified && !directChildrenVerified && !shouldSignalProcessGroup)) {
            throw terminationIncomplete();
        }
    }
    return { killProcessTree };
}

async function killProcessTree(proc, opts) {
    if (!proc.pid) return;
    const [processTools, processes] = await Promise.all([
        import('@happier-dev/cli-common/process'),
        import('ps-list'),
    ]);
    const owner = createProcessTreeOwner({
        ...processTools,
        psList: processes.default,
        taskkillWindowsProcessTree: (input) => taskkillWindowsProcessTree(input, processTools.windowsSystemToolCommand, processTools.execFileWithDeadline),
    });
    await owner.killProcessTree(proc, opts);
}

module.exports = { createProcessTreeOwner, killProcessTree, taskkillWindowsProcessTree };
