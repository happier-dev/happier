import { isUpdateItemActionable, type UpdateItem } from './updateItem';

/**
 * What the always-mounted entries (sidebar pill, collapsed rail, phone header, Settings row, tray)
 * show. Computed from the same items the Updates surface lists, so the summary and the detail can
 * never disagree about what counts.
 *
 * `phase` picks the pill (hidden at `none`); `status` is the Settings row's sentence, where zero
 * actionable is only "up to date" when every row proved it — an offline machine or a failed check
 * says so instead.
 */
/** `completed`: an update finished since Updates was last opened (the pill says "Updated" until then). */
export type UpdatesSummaryPhase = 'none' | 'available' | 'running' | 'ready' | 'failed' | 'required' | 'completed';

/**
 * Completions not yet seen (`machineUpdateRuns`): `done` finished on its executor's word and was
 * re-read; `pendingRemote` counts only once its row reports the new version.
 */
export type UnseenUpdateCompletions = ReadonlyMap<string, 'done' | 'pendingRemote'>;
/** `unchecked`: an online machine's tools have not been asked yet — "No known updates", not "up to date". */
export type UpdatesSummaryStatus = UpdatesSummaryPhase | 'upToDate' | 'unknown' | 'unchecked' | 'offline' | 'checking';

export type UpdatesSummary = Readonly<{
    actionableCount: number;
    /** Rows whose last attempt did not finish (each offers Retry where its executor can). */
    failedCount: number;
    /** Rows with an update in flight (including a remote machine reconnecting). */
    runningCount: number;
    phase: UpdatesSummaryPhase;
    status: UpdatesSummaryStatus;
    visible: boolean;
}>;

export function buildUpdatesSummary(
    items: readonly UpdateItem[],
    completions: UnseenUpdateCompletions = new Map(),
    coverage: Readonly<{ uncheckedMachineCount: number }> = { uncheckedMachineCount: 0 },
): UpdatesSummary {
    let actionableCount = 0;
    let required = false;
    let runningCount = 0;
    let failedCount = 0;
    let ready = false;
    let unknown = false;
    let offline = false;
    let checking = false;
    let unchecked = coverage.uncheckedMachineCount > 0;
    let completed = false;
    for (const item of items) {
        if (isUpdateItemActionable(item)) actionableCount += 1;
        if (item.state === 'required' && item.action.kind === 'run') required = true;
        if (item.state === 'running') runningCount += 1;
        if (item.state === 'failed') failedCount += 1;
        if (item.state === 'ready') ready = true;
        if (item.state === 'unknown') unknown = true;
        if (item.state === 'offline') offline = true;
        if (item.state === 'checking') checking = true;
        if (item.state === 'unchecked') unchecked = true;
        const completion = completions.get(item.id);
        if (completion === 'done' || (completion === 'pendingRemote' && item.updateCompleted === true)) completed = true;
    }

    // One ranking for every entry (pill, header, Settings, tray): what needs the person first —
    // a required update, then an update that did not finish, then updates to take; "Updating…"
    // only when nothing else is waiting on them, and the restart last.
    const phase: UpdatesSummaryPhase = required
        ? 'required'
        : failedCount > 0
            ? 'failed'
            : actionableCount > 0
                ? 'available'
                : runningCount > 0
                    ? 'running'
                    : ready
                        ? 'ready'
                        : completed
                            ? 'completed'
                            : 'none';
    const status: UpdatesSummaryStatus = phase !== 'none' && phase !== 'completed'
        ? phase
        : checking
            ? 'checking'
            : unchecked
                ? 'unchecked'
                : unknown
                    ? 'unknown'
                    : offline
                        ? 'offline'
                        : 'upToDate';
    return { actionableCount, failedCount, runningCount, phase, status, visible: phase !== 'none' };
}

const SUBJECT_ORDER: Readonly<Record<UpdateItem['subject']['kind'], number>> = {
    installable: 0,
    'agent-cli': 1,
    // The Happier CLI restarts the daemon every other remote update travels through: last.
    'happier-cli': 2,
    app: 3,
};

export type UpdateAllPlan = Readonly<{
    /** Sequential per machine, machines run concurrently. */
    machines: ReadonlyArray<Readonly<{ machineId: string; itemIds: readonly string[] }>>;
    /** The app downloads with the batch; its restart is always the person's choice. */
    appItemId: string | null;
    total: number;
}>;

/** R13 (e) / spec §4.2 — only supported, authorized updates; per machine helpers → agents → CLI. */
export function planUpdateAll(items: readonly UpdateItem[]): UpdateAllPlan {
    const byMachine = new Map<string, UpdateItem[]>();
    let appItemId: string | null = null;
    for (const item of items) {
        if (!isUpdateItemActionable(item)) continue;
        if (item.subject.kind === 'app' || item.machineId == null) {
            appItemId = item.id;
            continue;
        }
        const list = byMachine.get(item.machineId) ?? [];
        list.push(item);
        byMachine.set(item.machineId, list);
    }
    const machines = [...byMachine.entries()].map(([machineId, list]) => ({
        machineId,
        itemIds: [...list]
            .sort((a, b) => SUBJECT_ORDER[a.subject.kind] - SUBJECT_ORDER[b.subject.kind])
            .map((item) => item.id),
    }));
    const total = machines.reduce((sum, machine) => sum + machine.itemIds.length, 0) + (appItemId ? 1 : 0);
    return { machines, appItemId, total };
}

/** Field-by-field, so no field can be forgotten when the summary's identity is reused. */
export function isSameUpdatesSummary(a: UpdatesSummary, b: UpdatesSummary): boolean {
    const keys = Object.keys(a) as Array<keyof UpdatesSummary>;
    return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
