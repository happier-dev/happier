import { compareVersionsOrNull } from '@/utils/system/versionUtils';

/**
 * K7 — the UI-only update projection. One row per updatable thing, built from the owners that
 * already decide it (the app-update owner, this computer's inspection, machine metadata and the
 * machine capability detect). Never persisted and never a second decision-maker: every field is
 * read from its producer, and an absent fact degrades that one row.
 */
export type UpdateSubject =
    | Readonly<{ kind: 'app' }>
    | Readonly<{ kind: 'happier-cli' }>
    | Readonly<{ kind: 'agent-cli'; agentId: string }>
    | Readonly<{ kind: 'installable'; key: string }>;

/**
 * - `unchecked`: the applicable update owner has not checked yet.
 * - `checking`: the first answer has not arrived; nothing is known yet.
 * - `upToDate`: the producer proved the latest version runs.
 * - `available` / `required`: a newer version exists (`required`: this one no longer works).
 * - `running`: the producer reports an update in flight.
 * - `ready`: downloaded; only a restart is left (the app).
 * - `failed`: the last attempt did not finish; the row offers Retry when the executor can.
 * - `unknown`: the latest version is not known (older software, a failed lookup) — never shown as
 *   "up to date".
 * - `offline`: the machine is not connected; last-known versions only.
 */
export type UpdateItemState =
    | 'unchecked'
    | 'checking'
    | 'upToDate'
    | 'available'
    | 'required'
    | 'running'
    | 'ready'
    | 'failed'
    | 'unknown'
    | 'offline';

/** What the row's action button does. `none` rows have no button. */
export type UpdateItemActionKind = 'update' | 'retry' | 'restart' | 'reload' | 'store';

export type UpdateItemAction =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'run'; verb: UpdateItemActionKind }>
    /** The app cannot update it; the person can. `command` is shown only when its owner names one. */
    | Readonly<{ kind: 'manual'; command: string | null }>;

/** Which step is running, when the producer says, for the row's one-line status. */
/** `reconnecting`: installed on another machine, waiting for it to come back (K5 `pendingReconnect`). */
export type UpdateItemStep = 'downloading' | 'installing' | 'restarting' | 'restartingService' | 'reconnecting' | null;

/** Why the last attempt did not finish, as a key the row maps to one sentence. */
export type UpdateItemFailure =
    | Readonly<{ kind: 'appCheck' }>
    | Readonly<{ kind: 'appDownload' }>
    | Readonly<{ kind: 'appInstall' }>
    | Readonly<{ kind: 'message'; message: string }>
    | Readonly<{ kind: 'rolledBack'; kept: string; target: string }>
    | Readonly<{ kind: 'latestUnknown' }>;

export type UpdateItem = Readonly<{
    /** Stable across refreshes: `${machineKey}:${subject}`. */
    id: string;
    subject: UpdateSubject;
    /** `null` for this app; otherwise the machine the row lives on. */
    machineId: string | null;
    title: string;
    currentVersion: string | null;
    latestVersion: string | null;
    /** A cached release lookup is not refreshed by the Updates capability request. */
    cachedRelease?: Readonly<{ channel: string | null }>;
    /** The remote runtime reports the update target running; independent of release-check freshness. */
    updateCompleted?: boolean;
    state: UpdateItemState;
    /** Whole percent, only when the producer reports a real fraction. */
    progressPercent: number | null;
    step: UpdateItemStep;
    /** `user`: installed outside Happier ("Installed by you"); the app never offers to replace it. */
    managedBy: 'happier' | 'user';
    action: UpdateItemAction;
    failure: UpdateItemFailure | null;
    /** The person skipped exactly this version (the desktop app only). */
    skipped: boolean;
    /** The failed run's own log on its machine (the screen's "View log"); absent otherwise. */
    logPath?: string | null;
    /** The last update found it already current ("Already up to date"). */
    alreadyCurrent?: boolean;
}>;

/** Counted by the pill and included in "Update all": a supported, authorized update for a newer version. */
export function isUpdateItemActionable(item: UpdateItem): boolean {
    return (item.state === 'available' || item.state === 'required')
        && item.action.kind === 'run'
        && !item.skipped;
}

/** `null` means the versions cannot be ordered; an opaque vendor version never proves up-to-date. */
export function isNewerVersion(current: string | null, latest: string | null): boolean | null {
    if (!current || !latest) return null;
    const comparison = compareVersionsOrNull(current, latest);
    return comparison === null ? null : comparison < 0;
}

export function buildUpdateItemId(machineKey: string, subject: UpdateSubject): string {
    switch (subject.kind) {
        case 'app':
            return 'app';
        case 'happier-cli':
            return `${machineKey}:happier-cli`;
        case 'agent-cli':
            return `${machineKey}:agent:${subject.agentId}`;
        case 'installable':
            return `${machineKey}:installable:${subject.key}`;
    }
}
