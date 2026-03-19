import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import type { CapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { Modal } from '@/modal';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';

export type ProviderCliInstallItemProps = Readonly<{
    machineId: string | null;
    serverId?: string | null;
    capabilityId: Extract<CapabilityId, `cli.${string}`>;
    providerTitle: string;
    installed: boolean | null;
    managedInstalled?: boolean;
    installability?: CapabilityInstallability;
}>;

export function ProviderCliInstallItem(props: ProviderCliInstallItemProps) {
    const { theme } = useUnistyles();
    const { isInvoking: isInstalling, invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();

    const skipIfInstalled = props.managedInstalled !== true;
    const title = skipIfInstalled
        ? t('settingsProviders.cliInstaller.installTitle', { provider: props.providerTitle })
        : t('settingsProviders.cliInstaller.reinstallTitle', { provider: props.providerTitle });
    const installabilityKind = props.installability?.kind ?? 'unknown';
    const autoInstallAvailable = installabilityKind !== 'not-installable';
    const subtitle = !autoInstallAvailable
        ? t('settingsProviders.cliInstaller.autoInstallUnavailable')
        : skipIfInstalled
            ? t('settingsProviders.cliInstaller.installSubtitle')
            : t('settingsProviders.cliInstaller.reinstallSubtitle');

    return (
        <Item
            title={title}
            subtitle={subtitle}
            icon={<Ionicons name="download-outline" size={29} color={theme.colors.textSecondary} />}
            showChevron={false}
            disabled={isInstalling || !props.machineId || !autoInstallAvailable || installabilityKind === 'checking'}
            rightElement={isInstalling ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : undefined}
            onPress={async () => {
                if (!props.machineId) {
                    Modal.alert(t('common.error'), t('settingsProviders.cliInstaller.noMachineSelected'));
                    return;
                }
                if (!autoInstallAvailable || installabilityKind === 'checking') {
                    return;
                }

                const confirmed = await Modal.confirm(
                    skipIfInstalled
                        ? t('settingsProviders.cliInstaller.confirmInstallTitle', { provider: props.providerTitle })
                        : t('settingsProviders.cliInstaller.confirmReinstallTitle', { provider: props.providerTitle }),
                    t('settingsProviders.cliInstaller.confirmBody', { provider: props.providerTitle }),
                    {
                        cancelText: t('common.cancel'),
                        confirmText: skipIfInstalled
                            ? t('settingsProviders.cliInstaller.confirmInstallConfirm')
                            : t('settingsProviders.cliInstaller.confirmReinstallConfirm'),
                        destructive: !skipIfInstalled,
                    },
                );
                if (!confirmed) {
                    return;
                }

                await invokeWithAlerts({
                    machineId: props.machineId,
                    request: {
                        id: props.capabilityId,
                        method: 'install',
                        params: {
                            skipIfInstalled,
                            allowVendorRecipeExecution: true,
                        },
                    },
                    timeoutMs: 5 * 60_000,
                    serverId: props.serverId,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) =>
                            reason === 'not-supported'
                                ? t('settingsProviders.cliInstaller.installNotSupported')
                                : t('settingsProviders.cliInstaller.installFailed'),
                        successMessage: t('settingsProviders.cliInstaller.installed'),
                        successWithLogPath: (logPath) => t('settingsProviders.cliInstaller.logPath', { logPath }),
                    },
                });
            }}
        />
    );
}
