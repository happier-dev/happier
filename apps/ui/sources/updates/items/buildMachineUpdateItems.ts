import type { CliUpdateFacts } from '@happier-dev/protocol';

import { getInstallableDepUpdateAvailability } from '@/capabilities/installablesUpdateAvailable';
import { t } from '@/text';
import type { InstallableDepDataLike } from '@/capabilities/installablesRegistry';

import {
    buildUpdateItemId,
    isNewerVersion,
    type UpdateItem,
    type UpdateItemAction,
    type UpdateItemState,
    type UpdateItemStep,
    type UpdateSubject,
} from './updateItem';

/**
 * What the row's executor says about its own run: the shared CLI-update action, the machine
 * capability invoke in flight, or the remote system-task start. Never a UI-kept "is updating" flag.
 */
export type UpdateRunObservation = Readonly<{
    running: boolean;
    step: UpdateItemStep;
    /** One sentence from the executor's failure code; `null` when the last run did not fail. */
    errorMessage: string | null;
    /** The failed run's log file on its machine, when the executor reported one. */
    logPath?: string | null;
    /** The last run found the tool already current (nothing to install). */
    alreadyCurrent?: boolean;
}>;

/** The command that updates a Happier CLI whose daemon predates K5 facts (0.2 `self update` is POSIX-only). */
const LEGACY_CLI_UPDATE_COMMAND = 'happier self update';

function baseItem(params: Readonly<{
    machineId: string;
    subject: UpdateSubject;
    title: string;
    currentVersion: string | null;
    latestVersion: string | null;
}>): UpdateItem {
    return {
        id: buildUpdateItemId(params.machineId, params.subject),
        subject: params.subject,
        machineId: params.machineId,
        title: params.title,
        currentVersion: params.currentVersion,
        latestVersion: params.latestVersion,
        state: 'unknown',
        progressPercent: null,
        step: null,
        managedBy: 'happier',
        action: { kind: 'none' },
        failure: null,
        skipped: false,
    };
}

function versionState(current: string | null, latest: string | null): UpdateItemState {
    if (!latest || !current) return 'unknown';
    const newer = isNewerVersion(current, latest);
    if (newer === null) return 'unknown';
    return newer ? 'available' : 'upToDate';
}

/**
 * The shared shape of every executor-backed row: offline freezes the row, a run in flight is
 * `running`, a failure offers Retry, a newer version offers Update, and a row the app may not
 * update names the person's own way (`manual`).
 */
function resolveRow(item: UpdateItem, params: Readonly<{
    online: boolean;
    task: UpdateRunObservation;
    canRun: boolean;
    manual: UpdateItemAction | null;
    /** A row whose owner has its own "newer?" predicate passes that answer instead. */
    state?: UpdateItemState;
}>): UpdateItem {
    const version = params.state ?? versionState(item.currentVersion, item.latestVersion);
    // An older cached answer can establish a known upgrade, but cannot prove nothing newer exists.
    const state = item.cachedRelease && version === 'upToDate' ? 'unknown' : version;
    if (!params.online) {
        return { ...item, state: 'offline', action: { kind: 'none' } };
    }
    if (params.task.running) {
        return { ...item, state: 'running', step: params.task.step, action: { kind: 'none' } };
    }
    if (params.task.errorMessage && params.canRun) {
        return {
            ...item,
            state: 'failed',
            failure: { kind: 'message', message: params.task.errorMessage },
            action: { kind: 'run', verb: 'retry' },
            logPath: params.task.logPath ?? null,
        };
    }
    if (params.task.alreadyCurrent) {
        // The machine itself just said so; a cached latest version cannot override it.
        return { ...item, state: 'upToDate', alreadyCurrent: true };
    }
    if (params.manual) {
        return { ...item, state, managedBy: 'user', action: state === 'available' || state === 'unknown' ? params.manual : { kind: 'none' } };
    }
    if (state === 'available' && params.canRun) {
        return { ...item, state, action: { kind: 'run', verb: 'update' } };
    }
    return { ...item, state };
}

export function buildThisComputerCliUpdateItem(params: Readonly<{
    machineId: string;
    title: string;
    /** This computer's inspection (`cli.update` + provenance); `null` while nothing has answered. */
    facts: Readonly<{ currentVersion: string | null; latestVersion: string | null; managed: boolean | null; updateCommand: string | null; channel?: string | null }> | null;
    task: UpdateRunObservation;
}>): UpdateItem | null {
    if (!params.facts) return null;
    const item: UpdateItem = {
        ...baseItem({
            machineId: params.machineId,
            subject: { kind: 'happier-cli' },
            title: params.title,
            currentVersion: params.facts.currentVersion,
            latestVersion: params.facts.latestVersion,
        }),
        cachedRelease: { channel: params.facts.channel ?? null },
    };
    const managed = params.facts.managed === true;
    return resolveRow(item, {
        online: true,
        task: params.task,
        canRun: managed,
        manual: managed ? null : { kind: 'manual', command: params.facts.updateCommand },
    });
}

export function buildRemoteCliUpdateItem(params: Readonly<{
    machineId: string;
    title: string;
    online: boolean;
    platform: string | null;
    /** `happyCliVersion` from machine metadata — every released daemon writes it. */
    happyCliVersion: string | null;
    /** K5 facts from machine metadata; `null` for daemons that predate them. */
    facts: CliUpdateFacts | null;
    /**
     * The daemon lists `cli.update.v1` in its `tool.systemTasks` kinds (presence = capability);
     * `null` while no detect is cached. Only a known `false` withholds the action.
     */
    remoteUpdateAdvertised: boolean | null;
    task: UpdateRunObservation;
}>): UpdateItem {
    const facts = params.facts;
    const currentVersion = facts?.currentVersion ?? params.happyCliVersion;
    const item: UpdateItem = {
        ...baseItem({
            machineId: params.machineId,
            subject: { kind: 'happier-cli' },
            title: params.title,
            currentVersion,
            latestVersion: facts?.latestVersion ?? null,
        }),
        cachedRelease: { channel: facts?.channel ?? null },
    };

    if (!facts) {
        // An older daemon: its version, and the command that updates it — never "up to date".
        const command = params.platform === 'win32' ? null : LEGACY_CLI_UPDATE_COMMAND;
        if (!params.online) return { ...item, state: 'offline' };
        return { ...item, state: 'unknown', managedBy: 'happier', action: { kind: 'manual', command } };
    }

    const canRun = facts.installSource === 'managed' && facts.canUpdateRemotely && params.remoteUpdateAdvertised !== false;
    const manual: UpdateItemAction = { kind: 'manual', command: facts.updateCommand };
    const retryAction: UpdateItemAction = canRun ? { kind: 'run', verb: 'retry' } : manual;
    const last = facts.lastUpdate;
    if (params.online && !params.task.running && last) {
        if (last.outcome === 'pendingReconnect' && last.targetVersion !== currentVersion) {
            // Installed and restarting there: waiting to reconnect is not failure.
            return { ...item, state: 'running', step: 'reconnecting' };
        }
        if (last.outcome === 'rolledBack' && currentVersion && last.targetVersion) {
            return {
                ...item,
                state: 'failed',
                failure: { kind: 'rolledBack', kept: currentVersion, target: last.targetVersion },
                action: retryAction,
            };
        }
        if (last.outcome === 'failed') {
            return {
                ...item,
                state: 'failed',
                // `targetVersion: null` — no release was resolved, so nothing was activated.
                failure: {
                    kind: 'message',
                    message: last.targetVersion == null
                        ? t('updates.row.couldNotStart', { message: last.message ?? t('updates.row.failedGeneric') })
                        : last.message ?? t('updates.row.failedGeneric'),
                },
                action: retryAction,
            };
        }
    }

    const resolved = resolveRow(item, { online: params.online, task: params.task, canRun, manual: canRun ? null : manual });
    const updateCompleted = params.online && !params.task.running
        && (last?.outcome === 'pendingReconnect' || last?.outcome === 'succeeded')
        && last.targetVersion === currentVersion;
    // A managed CLI the app cannot reach remotely is still Happier's own: only the action differs.
    return { ...resolved, updateCompleted, managedBy: facts.installSource === 'managed' ? 'happier' : resolved.managedBy };
}

type AgentCliUpdateData = Readonly<{
    available?: unknown;
    version?: unknown;
    latestVersion?: unknown;
    installSource?: unknown;
    updateSupported?: unknown;
    updateCommand?: unknown;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * An agent CLI on a machine, from its `cli.<agentId>` detect. K6 adds `latestVersion`,
 * `installSource`, `updateSupported` and `updateCommand`; without them the row shows the version
 * and claims nothing.
 */
export function buildAgentCliUpdateItem(params: Readonly<{
    machineId: string;
    agentId: string;
    title: string;
    online: boolean;
    data: AgentCliUpdateData | null;
    task: UpdateRunObservation;
}>): UpdateItem | null {
    const data = params.data;
    if (!data || data.available !== true) return null;
    const item = baseItem({
        machineId: params.machineId,
        subject: { kind: 'agent-cli', agentId: params.agentId },
        title: params.title,
        currentVersion: readString(data.version),
        latestVersion: readString(data.latestVersion),
    });
    // K6 old-daemon rule: Update only when the daemon says `updateSupported: true` — an older one
    // ignores the update intent and would run a plain install beside the person's own CLI.
    const updateSupported = data.updateSupported === true;
    const installSource = readString(data.installSource);
    const command = readString(data.updateCommand);
    const userManaged = !updateSupported && ((installSource != null && installSource !== 'managed') || command != null);
    return resolveRow(item, {
        online: params.online,
        task: params.task,
        canRun: updateSupported,
        manual: userManaged ? { kind: 'manual', command } : null,
    });
}

/** An agent CLI or helper whose detect errored on that machine: listed, versionless, "Couldn't check". */
export function buildProbeFailedItem(params: Readonly<{
    machineId: string;
    subject: Extract<UpdateItem['subject'], { kind: 'agent-cli' | 'installable' }>;
    title: string;
    online: boolean;
}>): UpdateItem {
    const item = baseItem({
        machineId: params.machineId,
        subject: params.subject,
        title: params.title,
        currentVersion: null,
        latestVersion: null,
    });
    return params.online ? { ...item, state: 'unknown', failure: { kind: 'latestUnknown' } } : { ...item, state: 'offline' };
}

/** A helper installable (GitHub CLI, codex-acp, …) from the installables registry's detect data. */
export function buildInstallableUpdateItem(params: Readonly<{
    machineId: string;
    installableKey: string;
    title: string;
    online: boolean;
    data: InstallableDepDataLike | null;
    task: UpdateRunObservation;
}>): UpdateItem | null {
    const data = params.data;
    if (!data?.installed) return null;
    const check = data.latestVersionCheck;
    const latestVersion = check && check.ok ? check.latestVersion : null;
    const item = baseItem({
        machineId: params.machineId,
        subject: { kind: 'installable', key: params.installableKey },
        title: params.title,
        currentVersion: data.installedVersion,
        latestVersion,
    });
    // One predicate decides "a newer helper exists": the installables owner's own.
    const updateAvailable = getInstallableDepUpdateAvailability(data);
    const resolved = resolveRow(item, {
        online: params.online,
        task: params.task,
        canRun: true,
        manual: null,
        state: updateAvailable === null ? 'unknown' : updateAvailable ? 'available' : 'upToDate',
    });
    if (resolved.state === 'unknown' && check && !check.ok) {
        return { ...resolved, failure: { kind: 'latestUnknown' } };
    }
    return resolved;
}
