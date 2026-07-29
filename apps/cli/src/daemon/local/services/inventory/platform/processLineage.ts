import type { LocalServiceProcessFact } from '../provenance';

export type LocalServiceProcessFactReader = (
    pids: readonly number[],
) => Promise<ReadonlyMap<number, LocalServiceProcessFact>>;

export type LocalServiceProcessLineageReadFailure = Readonly<{
    pids: readonly number[];
    error: unknown;
}>;

export type CollectLocalServiceProcessLineageFactsInput = Readonly<{
    seedPids: readonly number[];
    seedProcesses?: ReadonlyMap<number, LocalServiceProcessFact>;
    maxDepth: number;
    readProcessFacts: LocalServiceProcessFactReader;
    onReadFailure?: (failure: LocalServiceProcessLineageReadFailure) => void;
}>;

function normalizePids(pids: readonly number[]): number[] {
    return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function mergeProcessFact(
    current: LocalServiceProcessFact | undefined,
    next: LocalServiceProcessFact,
): LocalServiceProcessFact {
    if (!current) return next;
    const ppid = next.ppid ?? current.ppid;
    const processStartTimeMs = next.processStartTimeMs ?? current.processStartTimeMs;
    const executablePath = next.executablePath ?? current.executablePath;
    const cwd = next.cwd ?? current.cwd;
    return {
        pid: current.pid,
        ...(ppid ? { ppid } : {}),
        ...(typeof processStartTimeMs === 'number' ? { processStartTimeMs } : {}),
        command: next.command && next.command !== 'unknown' ? next.command : current.command,
        ...(executablePath ? { executablePath } : {}),
        ...(cwd ? { cwd } : {}),
    };
}

export function mergeLocalServiceProcessFactMaps(
    base: ReadonlyMap<number, LocalServiceProcessFact>,
    overlay: ReadonlyMap<number, LocalServiceProcessFact>,
): ReadonlyMap<number, LocalServiceProcessFact> {
    const merged = new Map(base);
    for (const [pid, fact] of overlay) {
        merged.set(pid, mergeProcessFact(merged.get(pid), fact));
    }
    return merged;
}

export async function collectLocalServiceProcessLineageFacts(
    input: CollectLocalServiceProcessLineageFactsInput,
): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    let processes = new Map(input.seedProcesses ?? []);
    const queried = new Set<number>();
    let frontier = normalizePids(input.seedPids);
    const maxDepth = Math.max(0, Math.trunc(input.maxDepth));

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
        const pidsToRead = frontier.filter((pid) => !queried.has(pid));
        for (const pid of pidsToRead) {
            queried.add(pid);
        }

        if (pidsToRead.length > 0) {
            try {
                processes = new Map(mergeLocalServiceProcessFactMaps(
                    processes,
                    await input.readProcessFacts(pidsToRead),
                ));
            } catch (error) {
                input.onReadFailure?.({ pids: pidsToRead, error });
                break;
            }
        }

        frontier = normalizePids(frontier
            .map((pid) => processes.get(pid)?.ppid)
            .filter((pid): pid is number => typeof pid === 'number' && !queried.has(pid)));
    }

    return processes;
}
