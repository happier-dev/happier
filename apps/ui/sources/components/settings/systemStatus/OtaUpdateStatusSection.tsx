import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useNativeUpdate } from '@/hooks/ui/useNativeUpdate';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

function toErrorMessage(error: unknown): string | null {
    if (error instanceof Error) {
        const message = error.message.trim();
        return message || null;
    }

    if (typeof error === 'string') {
        const message = error.trim();
        return message || null;
    }

    return null;
}

function formatLastChecked(value: Date | undefined): string {
    return value instanceof Date ? value.toLocaleString() : t('status.unknown');
}

function formatDownloadProgress(progress: number | undefined): string | undefined {
    if (typeof progress !== 'number' || !Number.isFinite(progress)) {
        return undefined;
    }

    const clamped = Math.max(0, Math.min(100, Math.round(progress * 100)));
    return `${clamped}%`;
}

export const OtaUpdateStatusSection = React.memo(function OtaUpdateStatusSection() {
    const { theme } = useUnistyles();
    const updateUrl = useNativeUpdate();
    const {
        otaUpdatesEnabled,
        otaRuntimeSupported,
        isChecking,
        isDownloading,
        isRestarting,
        isUpdatePending,
        downloadProgress,
        checkError,
        downloadError,
        lastCheckForUpdateTimeSinceRestart,
        checkForUpdates,
        reloadApp,
    } = useUpdates();

    const errorMessage = toErrorMessage(downloadError) ?? toErrorMessage(checkError);
    const actionSubtitle = errorMessage
        ? <Text style={{ color: theme.colors.text.secondary }}>{errorMessage}</Text>
        : isUpdatePending
            ? t('updateBanner.pressToApply')
            : t('updateBanner.checkNowSubtitle');

    const actionDetail = isDownloading ? formatDownloadProgress(downloadProgress) : undefined;

    const openStoreUpdate = React.useCallback(async () => {
        if (!updateUrl) return;
        const supported = await Linking.canOpenURL(updateUrl);
        if (!supported) return;
        await Linking.openURL(updateUrl);
    }, [updateUrl]);

    const runOtaAction = React.useCallback(() => {
        if (!otaUpdatesEnabled || !otaRuntimeSupported) return;
        if (isUpdatePending) {
            void reloadApp();
            return;
        }
        void checkForUpdates();
    }, [checkForUpdates, isUpdatePending, otaRuntimeSupported, otaUpdatesEnabled, reloadApp]);

    if (!updateUrl && !otaRuntimeSupported) {
        return null;
    }

    return (
        <ItemGroup>
            {updateUrl ? (
                <Item
                    title={t('updateBanner.nativeUpdateAvailable')}
                    subtitle={Platform.OS === 'ios' ? t('updateBanner.tapToUpdateAppStore') : t('updateBanner.tapToUpdatePlayStore')}
                    onPress={openStoreUpdate}
                    icon={<Icon name="download" size={24} color={theme.colors.state.success.foreground} />}
                />
            ) : null}
            {otaRuntimeSupported ? (
                <>
                    <Item
                        title={isUpdatePending ? t('updateBanner.updateAvailable') : t('updateBanner.checkNowTitle')}
                        subtitle={actionSubtitle}
                        detail={actionDetail}
                        onPress={runOtaAction}
                        loading={isUpdatePending ? isRestarting : (isChecking || isDownloading)}
                        disabled={isUpdatePending ? isRestarting : (isChecking || isDownloading)}
                        showChevron={false}
                        icon={<Icon name={isUpdatePending ? 'arrows-clockwise' : 'arrow-clockwise'} size={24} color={theme.colors.accent.indigo} />}
                    />
                    <Item
                        title={t('updateBanner.lastCheckedTitle')}
                        detail={formatLastChecked(lastCheckForUpdateTimeSinceRestart)}
                        mode="info"
                        icon={<Icon name="clock" size={24} color={theme.colors.accent.orange} />}
                    />
                </>
            ) : null}
        </ItemGroup>
    );
});
