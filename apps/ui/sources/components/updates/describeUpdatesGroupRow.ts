import { t } from '@/text';
import { partitionMachineFleetPresence } from '@/sync/domains/machines/reachability/machineReachability';
import { planUpdateAll } from '@/updates/items/buildUpdatesSummary';
import { isNewerVersion, type UpdateItem } from '@/updates/items/updateItem';
import type { UpdatesGroup } from '@/updates/useUpdatesContentModel';
import { formatLastSeen as formatLastSeenDefault } from '@/utils/sessions/sessionUtils';

import { describeUpdateItem } from './describeUpdateItem';

/** How the row's status line is marked: a dot, or a warning glyph for `attention`. */
export type UpdatesGroupRowTone = 'ok' | 'info' | 'pending' | 'attention' | 'off' | 'neutral';

export type UpdatesGroupRowAction =
    /** Exactly one thing on the machine can be run: run that item (its own verb: Update, Retry, Restart…). */
    | Readonly<{ kind: 'item'; item: UpdateItem; label: string }>
    /** Several updates wait on the machine: update them all, in the owner's per-machine order. */
    | Readonly<{ kind: 'group'; label: string }>;

export type UpdatesGroupRow = Readonly<{
    title: string;
    status: string;
    tone: UpdatesGroupRowTone;
    action: UpdatesGroupRowAction | null;
}>;

/** A group's name, the same on the page's section titles and the popover's rows. */
export function updatesGroupTitle(group: UpdatesGroup): string {
    if (group.kind === 'app') return t('updates.sections.thisApp');
    if (group.machineName) return group.machineName;
    return group.kind === 'thisComputer' ? t('updates.sections.thisComputer') : t('updates.sections.machine');
}

/** "Codex · 0.2.12 → 0.2.14": the one item's own words, named, when it is the only thing to say. */
function namedItemStatus(item: UpdateItem): string {
    return `${item.title} · ${describeUpdateItem(item).subtitle}`;
}

function runnableAction(item: UpdateItem): UpdatesGroupRowAction | null {
    const label = describeUpdateItem(item).actionLabel;
    return label && item.action.kind === 'run' ? { kind: 'item', item, label } : null;
}

/**
 * The Updates popover's one row per machine (and one for this app): its name, one status line and
 * at most one action. Every fact is the updates owner's (`UpdatesGroup`, `describeUpdateItem`,
 * `planUpdateAll`); this only chooses what one line says. Precedence follows what the person can do
 * next: offline (nothing), in flight (wait), failed (retry), waiting updates (update), ready
 * (restart), then quiet states.
 */
export function describeUpdatesGroupRow(
    group: UpdatesGroup,
    options: Readonly<{ formatLastSeen?: (at: number) => string; sessionsRunningOn?: ReadonlySet<string> }> = {},
): UpdatesGroupRow {
    const title = updatesGroupTitle(group);
    const formatLastSeen = options.formatLastSeen ?? ((at: number) => formatLastSeenDefault(at));
    const withSessionNote = (status: string, items: readonly UpdateItem[]) => {
        for (const item of items) {
            const { note } = describeUpdateItem(item, {
                sessionsRunning: item.machineId != null && options.sessionsRunningOn?.has(item.machineId) === true,
            });
            if (note) return `${status} · ${note}`;
        }
        return status;
    };

    if (group.online === null) {
        return { title, status: t('updates.settingsSubtitle.unknown'), tone: 'neutral', action: null };
    }
    if (!group.online) {
        const status = group.lastSeenAt != null
            ? `${t('updates.offline')} · ${t('status.lastSeen', { time: formatLastSeen(group.lastSeenAt) })}`
            : t('updates.offline');
        return { title, status, tone: 'off', action: null };
    }

    const running = group.items.filter((item) => item.state === 'running');
    if (running.length > 0) {
        return {
            title,
            status: running.length === 1 ? namedItemStatus(running[0]!) : t('updates.summary.updating'),
            tone: 'pending',
            action: null,
        };
    }

    const failed = group.items.filter((item) => item.state === 'failed');
    if (failed.length > 0) {
        return {
            title,
            status: failed.length === 1 ? withSessionNote(namedItemStatus(failed[0]!), failed) : t('updates.summary.failedCount', { count: failed.length }),
            tone: 'attention',
            action: failed.length === 1 ? runnableAction(failed[0]!) : null,
        };
    }

    const plan = planUpdateAll(group.items);
    if (plan.total > 0) {
        const waiting = group.items.filter((item) => plan.appItemId === item.id || plan.machines.some((machine) => machine.itemIds.includes(item.id)));
        const required = waiting.some((item) => item.state === 'required');
        if (waiting.length === 1) {
            return { title, status: withSessionNote(namedItemStatus(waiting[0]!), waiting), tone: required ? 'attention' : 'info', action: runnableAction(waiting[0]!) };
        }
        return {
            title,
            status: withSessionNote(t('updates.summary.available', { count: waiting.length }), waiting),
            tone: required ? 'attention' : 'info',
            action: { kind: 'group', label: t('updates.action.update') },
        };
    }

    const ready = group.items.find((item) => item.state === 'ready');
    if (ready) return { title, status: withSessionNote(namedItemStatus(ready), [ready]), tone: 'info', action: runnableAction(ready) };

    if (group.items.some((item) => item.state === 'checking')) {
        return { title, status: t('updates.row.checking'), tone: 'pending', action: null };
    }
    const unknown = group.items.filter((item) => item.state === 'unknown');
    if (unknown.length > 0) {
        const item = unknown.length === 1 ? unknown[0] : null;
        return { title, status: item?.cachedRelease ? namedItemStatus(item) : t('updates.settingsSubtitle.unknown'), tone: 'neutral', action: null };
    }
    if (group.items.some((item) => item.state === 'unchecked')) {
        return { title, status: t('updates.summary.notCheckedYet'), tone: 'neutral', action: null };
    }
    return { title, status: t('updates.settingsSubtitle.upToDate'), tone: 'ok', action: null };
}

/** Nothing to do on this machine now: no update to run or install, nothing failed or in flight. */
function isQuietMachineGroup(group: UpdatesGroup): boolean {
    return group.items.every((item) => {
        if (item.state === 'running' || item.state === 'failed' || item.state === 'ready' || item.state === 'checking') return false;
        if ((item.state === 'unknown' || item.state === 'unchecked')
            && (item.action.kind === 'manual' || item.subject.kind === 'happier-cli')) return false;
        if ((item.state === 'available' || item.state === 'required') && !item.skipped) {
            // An update Happier runs, or a newer version the person installs themselves, is something to do.
            if (item.action.kind === 'run') return false;
            if (item.action.kind === 'manual' && isNewerVersion(item.currentVersion, item.latestVersion)) return false;
        }
        return true;
    });
}

/**
 * The Updates page's sections: this app, this computer and every reachable machine with something to
 * do each get a section of rows. Reachable machines with nothing to do, and machines that are offline,
 * each share one quiet place instead of one identical section per machine. Order is kept (the owner's
 * fixed order) so nothing jumps.
 */
export function partitionUpdatesPageGroups(groups: readonly UpdatesGroup[]): Readonly<{
    sections: readonly UpdatesGroup[];
    quiet: readonly UpdatesGroup[];
    offline: readonly UpdatesGroup[];
}> {
    const sections: UpdatesGroup[] = [];
    const quiet: UpdatesGroup[] = [];
    const fleet = partitionMachineFleetPresence(groups, group => group.kind === 'machine' ? group.fleetPresence : null);
    const offline = fleet.offline;
    const offlineGroups = new Set(offline);
    const onlineGroups = new Set(fleet.online);
    for (const group of groups) {
        if (offlineGroups.has(group)) continue;
        else if (onlineGroups.has(group) && isQuietMachineGroup(group)) quiet.push(group);
        else sections.push(group);
    }
    return { sections, quiet, offline };
}

/**
 * Within one machine's section: tools whose newer version could not be checked, with nothing the
 * person can do about it, share one cause. Two or more of them fold into one row that opens to the
 * list; the Happier CLI, anything actionable (retry, a manual command) and a single unchecked tool stay rows.
 */
export function partitionUncheckedItems(items: readonly UpdateItem[]): Readonly<{
    rows: readonly UpdateItem[];
    unchecked: readonly UpdateItem[];
}> {
    const unchecked = items.filter((item) => item.subject.kind !== 'happier-cli' && item.state === 'unknown' && item.action.kind === 'none');
    if (unchecked.length < 2) return { rows: items, unchecked: [] };
    return { rows: items.filter((item) => !unchecked.includes(item)), unchecked };
}
