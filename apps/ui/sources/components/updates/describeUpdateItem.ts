import { Platform } from 'react-native';

import type { UpdateItem } from '@/updates/items/updateItem';
import { t } from '@/text';

export type UpdateItemPresentation = Readonly<{
    /** One status line under the title (versions, step, or the one failure sentence). */
    subtitle: string;
    /** Screen-only second line: the command the person runs, when the owner names one. */
    command: string | null;
    /** The action button's visible label, `null` when the row has no button. */
    actionLabel: string | null;
    /** The widest label this row kind can show, laid out invisibly so swaps never move the title. */
    sizingLabel: string;
    /** A quiet fact about what the action does, never a question (sessions reconnect after it). */
    note: string | null;
}>;

function versionLine(item: UpdateItem): string | null {
    if (item.currentVersion && item.latestVersion && item.currentVersion !== item.latestVersion) {
        return t('updates.row.versionChange', { from: item.currentVersion, to: item.latestVersion });
    }
    if (item.latestVersion && !item.currentVersion) return t('updates.row.available', { version: item.latestVersion });
    return item.currentVersion ?? item.latestVersion;
}

function describeFailure(item: UpdateItem): string {
    const failure = item.failure;
    if (!failure) return t('updates.row.failedGeneric');
    switch (failure.kind) {
        case 'appCheck':
            return t('updates.row.appCheckFailed');
        case 'appDownload':
            return t('updates.row.appDownloadFailed');
        case 'appInstall':
            return t('updates.row.appInstallFailed');
        case 'message':
            return failure.message;
        case 'rolledBack':
            return t('updates.row.rolledBack', { kept: failure.kept, target: failure.target });
        case 'latestUnknown':
            return t('updates.row.latestUnknown');
    }
}

function describeStatus(item: UpdateItem): string {
    const versions = versionLine(item);
    const isApp = item.subject.kind === 'app';
    switch (item.state) {
        case 'unchecked':
            return t('updates.summary.notCheckedYet');
        case 'checking':
            return t('updates.row.checking');
        case 'upToDate':
            if (item.alreadyCurrent) return t('updates.row.alreadyCurrent');
            return item.currentVersion ? t('updates.row.upToDateVersion', { version: item.currentVersion }) : t('updates.summary.upToDate');
        case 'available':
            if (item.skipped && item.latestVersion) return t('updates.row.skipped', { version: item.latestVersion });
            if (isApp && !versions) return Platform.OS === 'web' ? t('updates.row.webNewBuild') : t('updates.row.ready');
            if (item.managedBy === 'user') return [t('updates.row.installedByYou'), versions].filter(Boolean).join(' · ');
            return versions ?? t('updates.row.ready');
        case 'required':
            return isApp ? t('updates.row.requiredApp') : (versions ?? t('updates.summary.required'));
        case 'running':
            if (item.step === 'downloading') {
                return item.latestVersion ? t('updates.row.downloading', { version: item.latestVersion }) : t('updates.row.downloadingUpdate');
            }
            if (item.step === 'restarting') return t('updates.row.restarting');
            if (item.step === 'restartingService') return t('updates.row.restartingService');
            if (item.step === 'reconnecting') return t('updates.row.waitingReconnect');
            return item.latestVersion ? t('updates.row.updatingTo', { version: item.latestVersion }) : t('updates.row.updating');
        case 'ready':
            return item.latestVersion ? t('updates.row.readyVersion', { version: item.latestVersion }) : t('updates.row.ready');
        case 'failed':
            return describeFailure(item);
        case 'unknown':
            if (item.failure) return [item.currentVersion, describeFailure(item)].filter(Boolean).join(' · ');
            if (item.managedBy === 'user') return [t('updates.row.installedByYou'), item.currentVersion].filter(Boolean).join(' · ');
            return item.currentVersion ?? t('updates.row.latestUnknown');
        case 'offline':
            return [versions, t('updates.row.offline')].filter(Boolean).join(' · ');
    }
}

function describeActionLabel(item: UpdateItem): string | null {
    if (item.action.kind !== 'run') return null;
    switch (item.action.verb) {
        case 'update':
            return t('updates.action.update');
        case 'retry':
            return t('common.retry');
        case 'restart':
            return t('updates.action.restart');
        case 'reload':
            return t('updates.action.reload');
        case 'store':
            return Platform.OS === 'ios' ? t('updates.action.storeIos') : t('updates.action.storeAndroid');
    }
}

/**
 * The one place a row's words come from; the row itself only lays them out. `sessionsRunning`: the
 * row's machine has sessions running now.
 */
export function describeUpdateItem(item: UpdateItem, context: Readonly<{ sessionsRunning?: boolean }> = {}): UpdateItemPresentation {
    const actionLabel = describeActionLabel(item);
    const command = item.action.kind === 'manual' ? item.action.command : null;
    const status = item.action.kind === 'manual' && !command && item.state !== 'upToDate'
        ? [describeStatus(item), t('updates.row.updateItYourWay')].join(' · ')
        : describeStatus(item);
    const cachedRelease = item.cachedRelease;
    const subtitle = cachedRelease
        ? [status, cachedRelease.channel
            ? t('updates.row.cachedReleaseChannel', { channel: cachedRelease.channel })
            : t('updates.row.cachedRelease')].join(' · ')
        : status;
    const sizingLabel = item.subject.kind === 'app'
        ? t('updates.action.restart')
        : t('updates.action.update').length >= t('common.retry').length ? t('updates.action.update') : t('common.retry');
    // Another machine's Happier CLI update restarts its background service; its sessions reconnect.
    const note = item.subject.kind === 'happier-cli' && item.action.kind === 'manual'
        ? t('updates.row.manualUpdateInterruptsSessions')
        : context.sessionsRunning === true && item.subject.kind === 'happier-cli' && item.action.kind === 'run'
            ? t('updates.row.restartsService')
            : null;
    return { subtitle, command, actionLabel, sizingLabel, note };
}
