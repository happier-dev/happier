import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';
import { isSessionFileWindowContext } from '@/components/sessions/files/window/sessionFileWindowRoute';
import { invokeTauri, isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';
import { isLatestVersionCheckDue } from '@/updates/latestVersionCheckFreshness';

import { shouldShowDesktopUpdateStatus } from './state';

/**
 * The desktop app's one update owner (R13 (e), S-3). Every surface — the sidebar pill, the
 * Updates screen, Settings, the tray — subscribes to this store; none of them checks, downloads or
 * installs on its own, so there is one network check, one pending update in the Rust adapter and
 * one answer everybody agrees on.
 *
 * Lifecycle: `idle` (not a desktop build, or checks disabled) → `checking` (the first check only;
 * later checks keep the last answer on screen) → `available` | `upToDate` | `failed` →
 * `downloading` (a real percentage when the server sent a length) → `ready` ("Restart to update")
 * → `installing` (the app restarts). `failed` names the step (`check`, `download`, `install`);
 * the raw updater message is never part of the snapshot.
 *
 * Checks run at launch and when the window regains focus once the last answer is due, through the
 * shared latest-version freshness policy — no poll loop of its own.
 */
export type DesktopUpdaterPhase =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'upToDate'
    | 'failed';

export type DesktopUpdaterFailure = 'check' | 'download' | 'install';

export type DesktopUpdaterSnapshot = Readonly<{
    phase: DesktopUpdaterPhase;
    /** The version on offer (kept through download, ready and a failed download/install). */
    version: string | null;
    currentVersion: string | null;
    /** Whole percent while downloading with a known length; `null` means indeterminate. */
    downloadPercent: number | null;
    failure: DesktopUpdaterFailure | null;
    /** The person chose "Skip this version" for exactly this offered version. */
    skipped: boolean;
    /** A re-check is in flight behind a settled answer. */
    refreshing: boolean;
    /** When the last check settled successfully (ms), for "Checked 2 hours ago". */
    checkedAt: number | null;
}>;

export type DesktopUpdaterStore = Readonly<{
    getSnapshot: () => DesktopUpdaterSnapshot;
    subscribe: (listener: () => void) => () => void;
    /** `force` is the explicit "Check for updates"; otherwise only when the answer is due. */
    check: (options?: Readonly<{ force?: boolean }>) => Promise<void>;
    download: () => Promise<void>;
    /** Installs the downloaded update and restarts the app. */
    install: () => Promise<void>;
    /** Repeats the step that failed. */
    retry: () => Promise<void>;
    skipVersion: () => void;
}>;

type UpdateMetadata = Readonly<{
    version: string;
    currentVersion: string;
    downloaded?: boolean;
}> | null;

type DownloadProgressPayload = Readonly<{ version?: unknown; downloadedBytes?: unknown; totalBytes?: unknown }>;

const DISMISS_KEY = 'desktop_update_dismissed_version';
const UPDATE_CHECKS_ENABLED_ENV = 'EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED';
export const DESKTOP_UPDATE_DOWNLOAD_PROGRESS_EVENT = 'desktop_update_download_progress';

const IDLE: DesktopUpdaterSnapshot = {
    phase: 'idle',
    version: null,
    currentVersion: null,
    downloadPercent: null,
    failure: null,
    skipped: false,
    refreshing: false,
    checkedAt: null,
};

function parseOptionalBoolean(raw: string | undefined): boolean | null {
    const normalized = String(raw ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return null;
}

function resolveUpdateChecksEnabled(): boolean {
    if (!isTauriDesktop()) return false;
    // The pet overlay and file windows are second webviews of the same app; a check from one would
    // replace the one pending update the Rust adapter holds for the main window.
    if (isDesktopPetOverlayWindowContext() || isSessionFileWindowContext()) return false;
    const override = parseOptionalBoolean(process.env[UPDATE_CHECKS_ENABLED_ENV]);
    if (override !== null) return override;
    return (globalThis as { __DEV__?: unknown }).__DEV__ !== true;
}

function readDismissedVersion(): string | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISS_KEY) : null;
    } catch {
        return null;
    }
}

function writeDismissedVersion(version: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(DISMISS_KEY, version);
    } catch {
        // Skipping stays in effect for this app open; it just is not remembered.
    }
}

function isSkipped(version: string | null): boolean {
    return version != null && !shouldShowDesktopUpdateStatus({ availableVersion: version, dismissedVersion: readDismissedVersion() });
}

function readWholePercent(payload: DownloadProgressPayload): number | null {
    const downloaded = typeof payload.downloadedBytes === 'number' ? payload.downloadedBytes : null;
    const total = typeof payload.totalBytes === 'number' ? payload.totalBytes : null;
    if (downloaded == null || total == null || total <= 0) return null;
    return Math.min(100, Math.floor((Math.min(downloaded, total) * 100) / total));
}

type FocusTarget = Readonly<{
    addEventListener?: (name: string, listener: () => void) => void;
}>;

export function createDesktopUpdaterStore(): DesktopUpdaterStore {
    let snapshot: DesktopUpdaterSnapshot = IDLE;
    let enabled: boolean | null = null;
    let started = false;
    let checkInFlight: Promise<void> | null = null;
    let actionInFlight: Promise<void> | null = null;
    let lastAttemptAt: number | null = null;
    let lastAttemptOk = false;
    const listeners = new Set<() => void>();

    const publish = (next: DesktopUpdaterSnapshot) => {
        if (next === snapshot) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const patch = (partial: Partial<DesktopUpdaterSnapshot>) => publish({ ...snapshot, ...partial });

    const isEnabled = () => {
        if (enabled === null) enabled = resolveUpdateChecksEnabled();
        return enabled;
    };

    const runCheck = async (): Promise<void> => {
        const hadAnswer = snapshot.phase !== 'idle' && snapshot.phase !== 'checking';
        patch(hadAnswer ? { refreshing: true } : { phase: 'checking' });
        try {
            const update = await invokeTauri<UpdateMetadata>('desktop_fetch_update');
            lastAttemptAt = Date.now();
            lastAttemptOk = true;
            if (!update) {
                publish({ ...IDLE, phase: 'upToDate', checkedAt: lastAttemptAt });
                return;
            }
            // A running download or a ready package for the same version is not reset by a check.
            const sameVersion = update.version === snapshot.version;
            const keepPhase = sameVersion && (snapshot.phase === 'downloading' || snapshot.phase === 'ready' || snapshot.phase === 'installing');
            publish({
                ...snapshot,
                phase: update.downloaded === true ? 'ready' : keepPhase ? snapshot.phase : 'available',
                version: update.version,
                currentVersion: update.currentVersion,
                downloadPercent: keepPhase ? snapshot.downloadPercent : null,
                failure: null,
                skipped: isSkipped(update.version),
                refreshing: false,
                checkedAt: lastAttemptAt,
            });
        } catch {
            lastAttemptAt = Date.now();
            lastAttemptOk = false;
            // A background re-check that fails keeps the answer already on screen.
            if (hadAnswer && snapshot.phase !== 'failed') {
                patch({ refreshing: false });
                return;
            }
            publish({ ...snapshot, phase: 'failed', failure: 'check', refreshing: false });
        }
    };

    const check = (options?: Readonly<{ force?: boolean }>): Promise<void> => {
        if (!isEnabled()) return Promise.resolve();
        if (checkInFlight) return checkInFlight;
        if (actionInFlight) return Promise.resolve();
        if (options?.force !== true && lastAttemptAt != null
            && !isLatestVersionCheckDue({ checkedAt: lastAttemptAt, ok: lastAttemptOk, now: Date.now() })) {
            return Promise.resolve();
        }
        checkInFlight = runCheck().finally(() => {
            checkInFlight = null;
        });
        return checkInFlight;
    };

    const download = (): Promise<void> => {
        if (!isEnabled() || !snapshot.version || actionInFlight) return actionInFlight ?? Promise.resolve();
        const version = snapshot.version;
        patch({ phase: 'downloading', downloadPercent: null, failure: null });
        actionInFlight = (async () => {
            let unlisten: (() => void) | null = null;
            try {
                unlisten = await listenTauriEvent<DownloadProgressPayload>(DESKTOP_UPDATE_DOWNLOAD_PROGRESS_EVENT, (payload) => {
                    if (snapshot.phase !== 'downloading' || payload.version !== version) return;
                    const percent = readWholePercent(payload);
                    if (percent !== snapshot.downloadPercent) patch({ downloadPercent: percent });
                }).catch(() => null);
                const downloaded = await invokeTauri<boolean>('desktop_download_update');
                if (!downloaded) {
                    // The adapter no longer holds an offer (e.g. the app was reloaded): ask again.
                    publish({ ...snapshot, phase: 'available', downloadPercent: null });
                    unlisten?.();
                    unlisten = null;
                    actionInFlight = null;
                    await check({ force: true });
                    return;
                }
                patch({ phase: 'ready', downloadPercent: null });
            } catch {
                patch({ phase: 'failed', failure: 'download', downloadPercent: null });
            } finally {
                unlisten?.();
            }
        })().finally(() => {
            actionInFlight = null;
        });
        return actionInFlight;
    };

    const install = (): Promise<void> => {
        if (!isEnabled() || actionInFlight) return actionInFlight ?? Promise.resolve();
        patch({ phase: 'installing', failure: null });
        actionInFlight = (async () => {
            try {
                // Resolves only when there was nothing to install; otherwise the app restarts.
                const installed = await invokeTauri<boolean>('desktop_install_update');
                if (!installed) {
                    publish({ ...snapshot, phase: snapshot.version ? 'available' : 'upToDate' });
                }
            } catch {
                patch({ phase: 'failed', failure: 'install' });
            }
        })().finally(() => {
            actionInFlight = null;
        });
        return actionInFlight;
    };

    const retry = (): Promise<void> => {
        if (snapshot.failure === 'install') return install();
        if (snapshot.failure === 'download') return download();
        return check({ force: true });
    };

    const skipVersion = () => {
        if (!snapshot.version) return;
        writeDismissedVersion(snapshot.version);
        patch({ skipped: true });
    };

    const start = () => {
        if (started || !isEnabled()) return;
        started = true;
        const target = (typeof window !== 'undefined' ? window : undefined) as FocusTarget | undefined;
        target?.addEventListener?.('focus', () => {
            void check();
        });
        void check();
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            start();
            return () => {
                listeners.delete(listener);
            };
        },
        check,
        download,
        install,
        retry,
        skipVersion,
    };
}

/** The app's one desktop updater. */
export const desktopUpdater: DesktopUpdaterStore = createDesktopUpdaterStore();
