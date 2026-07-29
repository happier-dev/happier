/**
 * Deterministic terminal-to-port registration store.
 *
 * The daemon PTY session manager registers the pids it spawns here on spawn and
 * removes them on close/exit/reap. The local-services scanner consults this store
 * during normalization so a listener whose pid (or recovered lineage pid) was spawned
 * by a known terminal gets a high-confidence workspace stamp plus its originating
 * session attribution — independent of whether the listener's own cwd resolves.
 *
 * Two lifecycle invariants validated against the reference terminal manager:
 *  - replace-by-`terminalKey` on register: a relaunched service overwrites the stale
 *    pid set for its terminal instead of unioning/duplicating it.
 *  - identity-checked `unregister`: a record is removed only when the caller's run
 *    identity (`terminalId`) still owns it, so a late exit from an OLDER run cannot
 *    evict a NEWER run that re-claimed the same `terminalKey` (via restart()).
 *
 * This is a daemon-internal correlation input only. It never accepts pid/workspace
 * from a UI/plugin/RPC caller and never exposes raw pid/port authority.
 */

export type TerminalProcessRegistration = Readonly<{
    workspacePath: string;
    sessionId?: string;
    terminalId: string;
}>;

type StoredRecord = {
    terminalKey: string;
    terminalId: string;
    workspacePath: string;
    sessionId?: string;
    pids: ReadonlySet<number>;
};

export type RegisterTerminalProcessesInput = Readonly<{
    terminalKey: string;
    workspacePath: string;
    pids: readonly number[];
    terminalId: string;
    sessionId?: string;
}>;

export type UnregisterTerminalInput = Readonly<{
    terminalKey: string;
    terminalId: string;
}>;

export type TerminalProcessRegistry = Readonly<{
    registerTerminalProcesses(input: RegisterTerminalProcessesInput): void;
    unregister(input: UnregisterTerminalInput): void;
    lookupByPid(pid: number): TerminalProcessRegistration | null;
}>;

function normalizePids(pids: readonly number[]): Set<number> {
    const out = new Set<number>();
    for (const pid of pids) {
        if (Number.isInteger(pid) && pid > 0) {
            out.add(pid);
        }
    }
    return out;
}

export function createTerminalProcessRegistry(): TerminalProcessRegistry {
    const recordsByKey = new Map<string, StoredRecord>();
    const keyByPid = new Map<number, string>();

    const dropPidsFromIndex = (record: StoredRecord): void => {
        for (const pid of record.pids) {
            if (keyByPid.get(pid) === record.terminalKey) {
                keyByPid.delete(pid);
            }
        }
    };

    return {
        registerTerminalProcesses(input) {
            const existing = recordsByKey.get(input.terminalKey);
            // Replace-by-terminalKey: drop the prior pid set before indexing the new one.
            if (existing) {
                dropPidsFromIndex(existing);
            }
            const pids = normalizePids(input.pids);
            const record: StoredRecord = {
                terminalKey: input.terminalKey,
                terminalId: input.terminalId,
                workspacePath: input.workspacePath,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                pids,
            };
            recordsByKey.set(input.terminalKey, record);
            for (const pid of pids) {
                keyByPid.set(pid, input.terminalKey);
            }
        },
        unregister(input) {
            const existing = recordsByKey.get(input.terminalKey);
            // Identity-checked: only the owning run may remove its record.
            if (!existing || existing.terminalId !== input.terminalId) {
                return;
            }
            dropPidsFromIndex(existing);
            recordsByKey.delete(input.terminalKey);
        },
        lookupByPid(pid) {
            const terminalKey = keyByPid.get(pid);
            if (terminalKey === undefined) return null;
            const record = recordsByKey.get(terminalKey);
            if (!record) return null;
            return {
                workspacePath: record.workspacePath,
                ...(record.sessionId ? { sessionId: record.sessionId } : {}),
                terminalId: record.terminalId,
            };
        },
    };
}

/**
 * Daemon-process shared singleton. The PTY session manager and the local-services
 * inventory runtime run in the same daemon process, so a single in-memory store is
 * the canonical shared state (no IPC/disk). Tests inject a fresh instance directly;
 * product code defaults to this shared one.
 */
let sharedRegistry: TerminalProcessRegistry | null = null;

export function getSharedTerminalProcessRegistry(): TerminalProcessRegistry {
    sharedRegistry ??= createTerminalProcessRegistry();
    return sharedRegistry;
}
