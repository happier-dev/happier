import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import type { CapabilityInstallability } from '@/hooks/machine/useCapabilityInstallability';
import { useMachineCapabilityInvokeWithAlerts } from '@/hooks/machine/useMachineCapabilityInvokeWithAlerts';
import { Modal } from '@/modal';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

export type AgentCliInstallItemProps = Readonly<{
    machineId: string | null;
    serverId?: string | null;
    /** Re-checks the owner-scoped target immediately before a confirmed install. */
    resolveExecutionTarget?: () => Readonly<{ machineId: string; serverId?: string | null }> | null;
    capabilityId: Extract<CapabilityId, `cli.${string}`>;
    providerTitle: string;
    installed: boolean | null;
    managedInstalled?: boolean;
    installability?: CapabilityInstallability;
    intent?: 'install' | 'update';
    onManagedUpdateConfirmed?: () => void;
    onInstalled?: () => void;
}>;

function executionTargetsEqual(
    left: Readonly<{ machineId: string; serverId?: string | null }>,
    right: Readonly<{ machineId: string; serverId?: string | null }>,
): boolean {
    return left.machineId === right.machineId && (left.serverId ?? null) === (right.serverId ?? null);
}

export function AgentCliInstallItem(props: AgentCliInstallItemProps) {
    const { theme } = useUnistyles();
    const { isInvoking: isInstalling, invokeWithAlerts } = useMachineCapabilityInvokeWithAlerts();

    const isExplicitUpdate = props.intent === 'update';
    const skipIfInstalled = isExplicitUpdate ? false : props.managedInstalled !== true;
    const title = skipIfInstalled
        ? t('settingsAgents.cliInstaller.installTitle', { provider: props.providerTitle })
        : t('settingsAgents.cliInstaller.reinstallTitle', { provider: props.providerTitle });
    const installabilityKind = props.installability?.kind ?? 'unknown';
    const autoInstallAvailable = installabilityKind !== 'not-installable';
    const subtitle = !autoInstallAvailable
        ? t('settingsAgents.cliInstaller.autoInstallUnavailable')
        : skipIfInstalled
            ? t('settingsAgents.cliInstaller.installSubtitle')
            : t('settingsAgents.cliInstaller.reinstallSubtitle');

    return (
        <Item
            title={title}
            subtitle={subtitle}
            icon={<Icon name="download" size={29} color={theme.colors.text.secondary} />}
            showChevron={false}
            disabled={isInstalling || !props.machineId || !autoInstallAvailable || installabilityKind === 'checking'}
            rightElement={isInstalling ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : undefined}
            onPress={async () => {
                if (!props.machineId) {
                    Modal.alert(t('common.error'), t('settingsAgents.cliInstaller.noMachineSelected'));
                    return;
                }
                if (!autoInstallAvailable || installabilityKind === 'checking') {
                    return;
                }

                const confirmed = await Modal.confirm(
                    skipIfInstalled
                        ? t('settingsAgents.cliInstaller.confirmInstallTitle', { provider: props.providerTitle })
                        : t('settingsAgents.cliInstaller.confirmReinstallTitle', { provider: props.providerTitle }),
                    t('settingsAgents.cliInstaller.confirmBody', { provider: props.providerTitle }),
                    {
                        cancelText: t('common.cancel'),
                        confirmText: skipIfInstalled
                            ? t('settingsAgents.cliInstaller.confirmInstallConfirm')
                            : t('settingsAgents.cliInstaller.confirmReinstallConfirm'),
                        destructive: !skipIfInstalled,
                    },
                );
                if (!confirmed) {
                    return;
                }

                const initialExecutionTarget = {
                    machineId: props.machineId,
                    serverId: props.serverId ?? null,
                };
                const executionTarget = props.resolveExecutionTarget
                    ? props.resolveExecutionTarget()
                    : initialExecutionTarget;
                if (!executionTarget || !executionTargetsEqual(initialExecutionTarget, executionTarget)) {
                    return;
                }
                if (isExplicitUpdate) {
                    props.onManagedUpdateConfirmed?.();
                }

                const result = await invokeWithAlerts({
                    machineId: executionTarget.machineId,
                    request: {
                        id: props.capabilityId,
                        method: 'install',
                        params: {
                            ...(props.intent ? { intent: props.intent } : {}),
                            skipIfInstalled,
                            allowVendorRecipeExecution: true,
                        },
                    },
                    timeoutMs: 5 * 60_000,
                    serverId: executionTarget.serverId,
                    alerts: {
                        errorTitle: t('common.error'),
                        successTitle: t('common.success'),
                        unsupportedMessage: (reason) =>
                            reason === 'not-supported'
                                ? t('settingsAgents.cliInstaller.installNotSupported')
                                : t('settingsAgents.cliInstaller.installFailed'),
                        successMessage: t('settingsAgents.cliInstaller.installed'),
                        successWithLogPath: (logPath) => t('settingsAgents.cliInstaller.logPath', { logPath }),
                    },
                });
                if (result.supported === true && 'response' in result && result.response.ok) {
                    props.onInstalled?.();
                }
            }}
        />
    );
}
