import * as React from 'react';


import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { Modal } from '@/modal';
import { useInstallableDepInstall } from '@/components/machines/installables/useInstallableDepInstall';
import { t } from '@/text';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { isInstallableDepUpdateAvailable } from '@/capabilities/installablesUpdateAvailable';
import type { InstallableDepDataLike } from '@/capabilities/installablesRegistry';
import { useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

function formatTimestamp(ms: number): string {
    try {
        return new Date(ms).toLocaleString();
    } catch {
        return String(ms);
    }
}

export type InstallableDepInstallerProps = {
    machineId: string;
    serverId?: string | null;
    enabled: boolean;
    groupTitle: string;
    depId: Extract<CapabilityId, `dep.${string}`>;
    depTitle: string;
    depSubtitle?: string | null;
    depIconName: IconName;
    setupUrl?: string | null;
    depStatus: InstallableDepDataLike | null;
    capabilitiesStatus: 'idle' | 'loading' | 'loaded' | 'error' | 'not-supported';
    extraItems?: React.ReactNode;
    installLabels: { install: string; update: string; reinstall: string };
    installModal: { installTitle: string; updateTitle: string; reinstallTitle: string; description: string };
    refreshStatus: () => void;
    refreshLatestVersion?: () => void;
};

export function InstallableDepInstaller(props: InstallableDepInstallerProps) {
    const { theme } = useUnistyles();
    const { isInstalling, run: runInstall } = useInstallableDepInstall(props);
    // Page sections carry no decorative row icons; the grouped look (new-session wizard) keeps them.
    const page = useListPresentation() === 'page';

    if (!props.enabled) return null;

    const updateAvailable = isInstallableDepUpdateAvailable(props.depStatus);

    const subtitle = (() => {
        if (props.capabilitiesStatus === 'loading') return t('common.loading');
        if (props.capabilitiesStatus === 'not-supported') return t('deps.ui.notAvailableUpdateCli');
        if (props.capabilitiesStatus === 'error') return t('deps.ui.errorRefresh');
        if (props.capabilitiesStatus !== 'loaded') return t('deps.ui.notAvailable');
        if (props.depStatus?.runtimeState === 'downloading') return t('deps.installable.downloading');

        if (props.depStatus?.installed) {
            if (updateAvailable) {
                const installedV = props.depStatus.installedVersion ?? 'unknown';
                const latestV = props.depStatus.latestVersionCheck && props.depStatus.latestVersionCheck.ok
                    ? (props.depStatus.latestVersionCheck.latestVersion ?? 'unknown')
                    : 'unknown';
                return t('deps.ui.installedUpdateAvailable', { installedVersion: installedV, latestVersion: latestV });
            }
            return props.depStatus.installedVersion
                ? t('deps.ui.installedWithVersion', { version: props.depStatus.installedVersion })
                : t('deps.ui.installed');
        }

        return t('deps.ui.notInstalled');
    })();

    const installButtonLabel = props.depStatus?.installed
        ? (updateAvailable ? props.installLabels.update : props.installLabels.reinstall)
        : props.installLabels.install;
    const installActionDisabled = isInstalling || props.capabilitiesStatus !== 'loaded';
    const presentedSubtitle = props.depSubtitle
        ? `${props.depSubtitle} • ${subtitle}`
        : subtitle;

    return (
        <ItemGroup title={props.groupTitle}>
            <Item
                title={props.depTitle}
                subtitle={presentedSubtitle}
                icon={<Icon name={props.depIconName} size={20} color={theme.colors.text.secondary} />}
                showChevron={false}
                onPress={() => (props.refreshLatestVersion ?? props.refreshStatus)()}
            />

            {props.setupUrl ? (
                <Item
                    title={t('common.open')}
                    subtitle={props.setupUrl}
                    icon={page ? undefined : <Icon name="arrow-square-out" size={20} color={theme.colors.text.secondary} />}
                    onPress={() => void openExternalUrl(props.setupUrl!)}
                />
            ) : null}

            {props.extraItems}

            {props.depStatus?.latestVersionCheck && props.depStatus.latestVersionCheck.ok && props.depStatus.latestVersionCheck.latestVersion && (
                <Item
                    title={t('deps.ui.latest')}
                    subtitle={t('deps.ui.latestSubtitle', {
                        version: props.depStatus.latestVersionCheck.latestVersion,
                        tag: props.depStatus.latestVersionCheck.label ?? props.depStatus.sourceKind,
                    })}
                    icon={page ? undefined : <Icon name="cloud-arrow-down" size={20} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            )}

            {props.depStatus?.latestVersionCheck && !props.depStatus.latestVersionCheck.ok && (
                <Item
                    title={t('deps.ui.registryCheck')}
                    subtitle={t('deps.ui.registryCheckFailed', { error: props.depStatus.latestVersionCheck.errorMessage })}
                    icon={page ? undefined : <Icon name="cloud-slash" size={20} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            )}

            <Item
                title={installButtonLabel}
                subtitle={props.installModal.description}
                icon={page ? undefined : <Icon name="download" size={20} color={theme.colors.text.secondary} />}
                disabled={installActionDisabled}
                onPress={() => {
                    if (installActionDisabled) return;
                    void runInstall();
                }}
                rightElement={isInstalling ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : undefined}
            />

            {props.depStatus?.lastInstallLogPath && (
                <Item
                    title={t('deps.ui.lastInstallLog')}
                    subtitle={props.depStatus.lastInstallLogPath}
                    icon={page ? undefined : <Icon name="file-text" size={20} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    onPress={() => Modal.alert(t('deps.ui.installLogTitle'), props.depStatus?.lastInstallLogPath ?? '')}
                />
            )}

            {typeof props.depStatus?.lastBackgroundUpdateCheckAtMs === 'number' && Number.isFinite(props.depStatus.lastBackgroundUpdateCheckAtMs) && (
                <Item
                    title={t('settingsAgents.authentication.lastCheckedTitle')}
                    subtitle={formatTimestamp(props.depStatus.lastBackgroundUpdateCheckAtMs)}
                    icon={page ? undefined : <Icon name="clock" size={20} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            )}
        </ItemGroup>
    );
}
