import * as React from 'react';
import { shouldShowDesktopUpdateBanner } from './state';
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

    const [status, setStatus] = React.useState<DesktopUpdaterStatus>('idle');
    const [availableVersion, setAvailableVersion] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        if (!isDesktop) {
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
            const show = shouldShowDesktopUpdateBanner({
                availableVersion: update.version,
                dismissedVersion
            });

            setAvailableVersion(update.version);
            setStatus(show ? 'available' : 'dismissed');
        } catch (error) {
            console.warn('Failed to check for desktop updates:', error);
            setAvailableVersion(null);
            setStatus('idle');
        }
    }, [isDesktop]);

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
        if (!isDesktop) {
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
        } catch (e: any) {
            setError(String(e?.message || e || 'Update failed'));
            setStatus('error');
        }
    }, [availableVersion, isDesktop]);

    return {
        status,
        availableVersion,
        error,
        dismiss,
        refresh,
        startInstall
    };
}
