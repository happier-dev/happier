import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

export type ProviderCliInstallItemProps = Readonly<{
    machineId: string | null;
    serverId?: string | null;
    capabilityId: Extract<CapabilityId, `cli.${string}`>;
    providerTitle: string;
    installed: boolean | null;
}>;

export function ProviderCliInstallItem(props: ProviderCliInstallItemProps) {
    const { theme } = useUnistyles();
    const [isInstalling, setIsInstalling] = React.useState(false);

    const skipIfInstalled = props.installed !== true;
    const title = skipIfInstalled ? `Install ${props.providerTitle} CLI` : `Reinstall ${props.providerTitle} CLI`;
    const subtitle = skipIfInstalled
        ? 'Installs the provider CLI on the selected machine (best-effort).'
        : 'Re-runs the provider installer even if the CLI is already present.';

    return (
        <Item
            title={title}
            subtitle={subtitle}
            icon={<Ionicons name="download-outline" size={29} color={theme.colors.textSecondary} />}
            showChevron={false}
            disabled={isInstalling || !props.machineId}
            rightElement={isInstalling ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : undefined}
            onPress={async () => {
                if (!props.machineId) {
                    Modal.alert('Error', 'No machine selected.');
                    return;
                }

                setIsInstalling(true);
                try {
                    const invoke = await machineCapabilitiesInvoke(
                        props.machineId,
                        {
                            id: props.capabilityId,
                            method: 'install',
                            params: { skipIfInstalled },
                        },
                        { timeoutMs: 5 * 60_000, serverId: props.serverId },
                    );

                    if (!invoke.supported) {
                        Modal.alert('Error', invoke.reason === 'not-supported' ? 'Install not supported on this machine.' : 'Install failed.');
                        return;
                    }

                    if (!invoke.response.ok) {
                        Modal.alert('Error', invoke.response.error.message);
                        return;
                    }

                    const logPath = (invoke.response.result as any)?.logPath;
                    Modal.alert('Success', typeof logPath === 'string' ? `Log: ${logPath}` : 'Installed.');
                } catch (e) {
                    Modal.alert('Error', e instanceof Error ? e.message : 'Install failed.');
                } finally {
                    setIsInstalling(false);
                }
            }}
        />
    );
}

