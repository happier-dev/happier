import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import type { CapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { Modal } from '@/modal';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

export type ProviderCliInstallItemProps = Readonly<{
    machineId: string | null;
    serverId?: string | null;
    capabilityId: Extract<CapabilityId, `cli.${string}`>;
    providerTitle: string;
    installed: boolean | null;
    installability?: CapabilityInstallability;
}>;

export function ProviderCliInstallItem(props: ProviderCliInstallItemProps) {
    const { theme } = useUnistyles();
    const { isInvoking: isInstalling, invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();

    const skipIfInstalled = props.installed !== true;
    const title = skipIfInstalled ? `Install ${props.providerTitle} CLI` : `Reinstall ${props.providerTitle} CLI`;
    const installabilityKind = props.installability?.kind ?? 'unknown';
    const autoInstallAvailable = installabilityKind !== 'not-installable';
    const subtitle = !autoInstallAvailable
        ? 'Auto-install is not available for this machine.'
        : skipIfInstalled
            ? 'Installs the provider CLI on the selected machine (best-effort).'
            : 'Re-runs the provider installer even if the CLI is already present.';

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
                    Modal.alert('Error', 'No machine selected.');
                    return;
                }
                if (!autoInstallAvailable || installabilityKind === 'checking') {
                    return;
                }

                await invokeWithAlerts({
                    machineId: props.machineId,
                    request: {
                        id: props.capabilityId,
                        method: 'install',
                        params: { skipIfInstalled },
                    },
                    timeoutMs: 5 * 60_000,
                    serverId: props.serverId,
                    alerts: {
                        errorTitle: 'Error',
                        successTitle: 'Success',
                        unsupportedMessage: (reason) =>
                            reason === 'not-supported' ? 'Install not supported on this machine.' : 'Install failed.',
                        successMessage: 'Installed.',
                        successWithLogPath: (logPath) => `Log: ${logPath}`,
                    },
                });
            }}
        />
    );
}
