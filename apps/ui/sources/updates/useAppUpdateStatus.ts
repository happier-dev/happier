import * as React from 'react';
import { Linking, Platform } from 'react-native';

import { desktopUpdater } from '@/desktop/updates/desktopUpdater';
import { useDesktopUpdater } from '@/desktop/updates/useDesktopUpdater';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useNativeUpdate } from '@/hooks/ui/useNativeUpdate';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { buildAppUpdateItem, type AppUpdateItemModel } from './items/buildAppUpdateItem';
import { useWebUiDeploymentFreshness } from './useWebUiDeploymentFreshness';
import { registerAppUpdateActionOwner } from './appUpdateActionRuntime';

export type AppUpdateStatus = Readonly<{
    model: AppUpdateItemModel;
    /** When the app's owner last reported a settled check (ms); `null` when it has none to report. */
    checkedAt: number | null;
    /** Runs the row's action: Update (download), Restart to update, Retry, Reload, open the store. */
    run: () => Promise<void>;
    /** The explicit "Check for updates". */
    checkNow: () => Promise<void>;
    /** "Skip this version" — the desktop app only; keyed to the offered version. */
    skipVersion: (() => void) | null;
}>;

/**
 * The "This app" producer (plan R13 (e)): one classification (`buildAppUpdateItem`) over the app's
 * update owners, each of which is a shared single-flight store — mounting this in several surfaces
 * never starts a second check.
 */
export function useAppUpdateStatus(): AppUpdateStatus {
    const nativeUpdateUrl = useNativeUpdate();
    const desktop = useDesktopUpdater();
    const ota = useUpdates();
    const webUi = useWebUiDeploymentFreshness();
    const otaDownloadProgress = typeof ota.downloadProgress === 'number' ? ota.downloadProgress : null;
    const otaCheckedAt = ota.lastCheckForUpdateTimeSinceRestart?.getTime() ?? null;

    const model = React.useMemo(() => buildAppUpdateItem({
        platformOs: Platform.OS,
        desktopHost: isDesktopHost(),
        title: t('updates.thisAppTitle'),
        native: { updateUrl: nativeUpdateUrl },
        webUiUpdateAvailable: webUi.updateAvailable,
        desktop,
        ota: {
            supported: ota.otaRuntimeSupported,
            isChecking: ota.isChecking,
            isDownloading: ota.isDownloading === true,
            isRestarting: ota.isRestarting,
            downloadProgress: otaDownloadProgress,
            isUpdateAvailable: ota.isUpdateAvailable,
            isUpdatePending: ota.isUpdatePending === true,
            checkFailed: Boolean(ota.checkError),
            downloadFailed: Boolean(ota.downloadError),
            checkedAt: otaCheckedAt,
        },
    }), [desktop, nativeUpdateUrl, ota.checkError, ota.downloadError, ota.isChecking, ota.isDownloading, ota.isRestarting, ota.isUpdateAvailable, ota.isUpdatePending, ota.otaRuntimeSupported, otaCheckedAt, otaDownloadProgress, webUi.updateAvailable]);

    const reloadOta = ota.reloadApp;
    const checkOta = ota.checkForUpdates;
    const reloadWeb = webUi.reload;
    const run = React.useCallback(async () => {
        const { channel, item } = model;
        if (item.action.kind !== 'run') return;
        switch (channel) {
            case 'native-store': {
                if (!nativeUpdateUrl) return;
                if (await Linking.canOpenURL(nativeUpdateUrl)) await Linking.openURL(nativeUpdateUrl);
                return;
            }
            case 'web-ui':
                reloadWeb();
                return;
            case 'ota':
                if (item.action.verb === 'restart') await reloadOta();
                else await checkOta();
                return;
            case 'desktop':
                if (item.action.verb === 'restart') return desktopUpdater.install();
                if (item.action.verb === 'retry') return desktopUpdater.retry();
                return desktopUpdater.download();
            case 'none':
                return;
        }
    }, [checkOta, model, nativeUpdateUrl, reloadOta, reloadWeb]);

    const checkNow = React.useCallback(async () => {
        await Promise.all([desktopUpdater.check({ force: true }), checkOta()]);
    }, [checkOta]);

    const skippable = model.channel === 'desktop' && model.item.state === 'available' && !model.item.skipped;
    const checkedAt = model.channel === 'ota' ? otaCheckedAt : desktop.checkedAt;
    const status = React.useMemo(() => ({
        model,
        checkedAt,
        run,
        checkNow,
        skipVersion: skippable ? desktopUpdater.skipVersion : null,
    }), [checkNow, checkedAt, model, run, skippable]);
    const statusRef = React.useRef(status);
    statusRef.current = status;
    React.useEffect(() => registerAppUpdateActionOwner(() => statusRef.current), []);
    return status;
}
