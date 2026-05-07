import * as React from 'react';
import { shouldShowDesktopUpdateStatus } from './state';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

type DesktopUpdaterStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'installing'
    | 'error'
    | 'dismissed'
    | 'upToDate';

type UpdateMetadata = {
    version: string;
    currentVersion: string;
    notes: string | null;
    pubDate: string | null;
} | null;

const DISMISS_KEY = 'desktop_update_dismissed_version';
const UPDATE_CHECKS_ENABLED_ENV = 'EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED';

function parseOptionalBoolean(raw: string | undefined): boolean | null {
    const normalized = String(raw ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return null;
}

function readDesktopUpdateChecksEnabledOverride(): boolean | null {
    return parseOptionalBoolean(process.env[UPDATE_CHECKS_ENABLED_ENV]);
}

function isDevelopmentBundle(): boolean {
    return (globalThis as { __DEV__?: unknown }).__DEV__ === true;
}

function shouldRunDesktopUpdateChecks(params: {
    isDesktop: boolean;
    isDevelopmentBundle: boolean;
    enabledOverride: boolean | null;
}): boolean {
    if (!params.isDesktop) return false;
    if (params.enabledOverride !== null) return params.enabledOverride;
    return !params.isDevelopmentBundle;
}

function formatDesktopUpdaterErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim().length > 0) {
        return error.trim();
    }
    return 'Update failed';
}

function getDismissedVersion(): string | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISS_KEY) : null;
    } catch {
        return null;
    }
}

function setDismissedVersion(version: string) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(DISMISS_KEY, version);
        }
    } catch {
        // ignore
    }
}

export function useDesktopUpdater(): {
    status: DesktopUpdaterStatus;
    availableVersion: string | null;
    error: string | null;
    dismiss: () => void;
    refresh: () => Promise<void>;
    startInstall: () => Promise<void>;
} {
    // Capture the environment at mount time. In production the desktop/web context is stable, and
    // using a stable flag avoids test flakiness when other suites manipulate `window` concurrently.
    const isDesktop = React.useMemo(() => isTauriDesktop(), []);
    const updateChecksEnabled = React.useMemo(() => shouldRunDesktopUpdateChecks({
        isDesktop,
        isDevelopmentBundle: isDevelopmentBundle(),
        enabledOverride: readDesktopUpdateChecksEnabledOverride(),
    }), [isDesktop]);

    const [status, setStatus] = React.useState<DesktopUpdaterStatus>('idle');
    const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        if (!updateChecksEnabled) {
            return;
        }

        setError(null);
        setStatus('checking');
        try {
            const update = await invokeTauri<UpdateMetadata>('desktop_fetch_update');
            if (!update) {
                setAvailableVersion(null);
                setStatus('upToDate');
                return;
            }

            const dismissedVersion = getDismissedVersion();
            const show = shouldShowDesktopUpdateStatus({
                availableVersion: update.version,
                dismissedVersion
            });

            setAvailableVersion(update.version);
            setStatus(show ? 'available' : 'dismissed');
        } catch (error) {
            setAvailableVersion(null);
            setError(formatDesktopUpdaterErrorMessage(error));
            setStatus('error');
        }
    }, [updateChecksEnabled]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const dismiss = React.useCallback(() => {
        if (availableVersion) {
            setDismissedVersion(availableVersion);
        }
        setStatus('dismissed');
    }, [availableVersion]);

    const startInstall = React.useCallback(async () => {
        if (!updateChecksEnabled) {
            return;
        }
        if (!availableVersion) {
            return;
        }

        setError(null);
        setStatus('installing');
        try {
            const installed = await invokeTauri<boolean>('desktop_install_update');
            if (!installed) {
                setAvailableVersion(null);
                setStatus('upToDate');
            }
        } catch (error: unknown) {
            setError(formatDesktopUpdaterErrorMessage(error));
            setStatus('error');
        }
    }, [availableVersion, updateChecksEnabled]);

    return {
        status,
        availableVersion,
        error,
        dismiss,
        refresh,
        startInstall
    };
}
