import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { AgentCore } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import type {
    ConnectedServicesProviderConfigSharingModeV1,
    ConnectedServicesProviderStateSharingModeV1,
    ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol';

const UNSUPPORTED_PROVIDER_STATE_SHARING_CAPABILITY: ConnectedServicesProviderStateSharingCapability = {
    config: {
        supported: false,
        modes: ['isolated'],
        unavailableReason: 'not_implemented',
    },
    state: {
        supported: false,
        modes: ['isolated'],
        unavailableReason: 'not_implemented',
    },
};

type ConnectedServicesProviderStateSharingCapability = NonNullable<
    NonNullable<AgentCore['connectedServices']>['providerStateSharing']
>;
type ConnectedServicesProviderStateSharingUnavailableReason = NonNullable<
    | ConnectedServicesProviderStateSharingCapability['config']['unavailableReason']
    | ConnectedServicesProviderStateSharingCapability['state']['unavailableReason']
>;

type ProviderStateSharingRowsProps = Readonly<{
    agentId: AgentId;
    agentTitle: string;
    capability?: ConnectedServicesProviderStateSharingCapability | null;
    settings: ConnectedServicesProviderStateSharingSettingsV1;
    setSettings: (settings: ConnectedServicesProviderStateSharingSettingsV1) => void;
}>;

function resolveUnavailableReasonLabel(
    reason: ConnectedServicesProviderStateSharingUnavailableReason | undefined,
): string {
    if (reason === 'dynamic_diagnostics_required') {
        return t('connectedServices.providerStateSharing.unavailable.dynamicDiagnosticsRequired');
    }
    return t('connectedServices.providerStateSharing.unavailable.notImplemented');
}

function buildConfigModeOptions(params: Readonly<{
    supportedModes: ReadonlyArray<ConnectedServicesProviderConfigSharingModeV1>;
    colors: Readonly<{
        blue: string;
        indigo: string;
        secondary: string;
    }>;
}>): readonly DropdownMenuItem[] {
    const supportedModes = new Set(params.supportedModes);
    return [
        {
            id: 'linked',
            title: t('connectedServices.providerStateSharing.configLinkedTitle'),
            subtitle: t('connectedServices.providerStateSharing.configLinkedSubtitle'),
            icon: <Ionicons name="link-outline" size={22} color={params.colors.blue} />,
            disabled: !supportedModes.has('linked'),
        },
        {
            id: 'copied',
            title: t('connectedServices.providerStateSharing.configCopiedTitle'),
            subtitle: t('connectedServices.providerStateSharing.configCopiedSubtitle'),
            icon: <Ionicons name="copy-outline" size={22} color={params.colors.indigo} />,
            disabled: !supportedModes.has('copied'),
        },
        {
            id: 'isolated',
            title: t('connectedServices.providerStateSharing.configIsolatedTitle'),
            subtitle: t('connectedServices.providerStateSharing.configIsolatedSubtitle'),
            icon: <Ionicons name="lock-closed-outline" size={22} color={params.colors.secondary} />,
            disabled: !supportedModes.has('isolated'),
        },
    ];
}

export function ProviderStateSharingRows({
    agentId,
    agentTitle,
    capability,
    settings,
    setSettings,
}: ProviderStateSharingRowsProps) {
    const { theme } = useUnistyles();
    const resolvedCapability = capability ?? UNSUPPORTED_PROVIDER_STATE_SHARING_CAPABILITY;
    const policy = resolveConnectedServicesProviderStateSharingPolicyV1(settings, agentId);
    const [configMenuOpen, setConfigMenuOpen] = React.useState(false);
    const configDisabled = !resolvedCapability.config.supported;
    const stateDisabled = !resolvedCapability.state.supported || !resolvedCapability.state.modes.includes('shared');
    const stateShared = policy.stateMode === 'shared' && !stateDisabled;
    const acknowledgedSharedStatePrivacy =
        settings.acknowledgedRisksByAgentId[agentId]?.sharedStatePrivacy === true;

    const writeOverride = React.useCallback((override: Readonly<{
        configMode?: ConnectedServicesProviderConfigSharingModeV1;
        stateMode?: ConnectedServicesProviderStateSharingModeV1;
        acknowledgeSharedStatePrivacy?: boolean;
    }>) => {
        setSettings({
            ...settings,
            byAgentId: {
                ...settings.byAgentId,
                [agentId]: {
                    ...(settings.byAgentId[agentId] ?? {}),
                    ...(override.configMode ? { configMode: override.configMode } : {}),
                    ...(override.stateMode ? { stateMode: override.stateMode } : {}),
                },
            },
            acknowledgedRisksByAgentId: override.acknowledgeSharedStatePrivacy
                ? {
                    ...settings.acknowledgedRisksByAgentId,
                    [agentId]: {
                        ...(settings.acknowledgedRisksByAgentId[agentId] ?? {}),
                        sharedStatePrivacy: true,
                    },
                }
                : settings.acknowledgedRisksByAgentId,
        });
    }, [agentId, setSettings, settings]);

    const configModeOptions = React.useMemo(
        () => buildConfigModeOptions({
            supportedModes: resolvedCapability.config.modes,
            colors: {
                blue: theme.colors.accent.blue,
                indigo: theme.colors.accent.indigo,
                secondary: theme.colors.text.secondary,
            },
        }),
        [
            resolvedCapability.config.modes,
            theme.colors.accent.blue,
            theme.colors.accent.indigo,
            theme.colors.text.secondary,
        ],
    );

    const setConfigMode = React.useCallback((itemId: string) => {
        if (configDisabled) return;
        if (itemId !== 'linked' && itemId !== 'copied' && itemId !== 'isolated') return;
        if (!resolvedCapability.config.modes.includes(itemId)) return;
        writeOverride({ configMode: itemId });
    }, [configDisabled, resolvedCapability.config.modes, writeOverride]);

    const setStateShared = React.useCallback(async (shared: boolean) => {
        if (stateDisabled) return;
        if (
            shared
            && resolvedCapability.state.sharedStatePrivacyRiskAcknowledgementRequired === true
            && !acknowledgedSharedStatePrivacy
        ) {
            const confirmed = await Modal.confirm(
                t('connectedServices.providerStateSharing.sharedStatePrivacyTitle'),
                t('connectedServices.providerStateSharing.sharedStatePrivacyBody', { agent: agentTitle }),
            );
            if (!confirmed) return;
        }
        writeOverride({
            stateMode: shared ? 'shared' : 'isolated',
            acknowledgeSharedStatePrivacy:
                shared && resolvedCapability.state.sharedStatePrivacyRiskAcknowledgementRequired === true,
        });
    }, [
        acknowledgedSharedStatePrivacy,
        agentTitle,
        resolvedCapability.state.sharedStatePrivacyRiskAcknowledgementRequired,
        stateDisabled,
        writeOverride,
    ]);

    return (
        <>
            <DropdownMenu
                open={configMenuOpen}
                onOpenChange={setConfigMenuOpen}
                variant="selectable"
                search={false}
                selectedId={policy.configMode}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                itemTrigger={{
                    title: t('connectedServices.providerStateSharing.agentConfigTitle', { agent: agentTitle }),
                    subtitle: configDisabled
                        ? resolveUnavailableReasonLabel(resolvedCapability.config.unavailableReason)
                        : undefined,
                    icon: <Ionicons name="settings-outline" size={22} color={theme.colors.accent.blue} />,
                    showSelectedSubtitle: !configDisabled,
                    itemProps: {
                        testID: `connected-services-provider-state-sharing-agent-${agentId}-config`,
                        disabled: configDisabled,
                    },
                }}
                items={configModeOptions}
                onSelect={setConfigMode}
            />
            <Item
                testID={`connected-services-provider-state-sharing-agent-${agentId}-state`}
                title={t('connectedServices.providerStateSharing.agentStateTitle', { agent: agentTitle })}
                subtitle={
                    stateDisabled
                        ? resolveUnavailableReasonLabel(resolvedCapability.state.unavailableReason)
                        : stateShared
                            ? t('connectedServices.providerStateSharing.stateEnabledSubtitle')
                            : t('connectedServices.providerStateSharing.stateDisabledSubtitle')
                }
                icon={<Ionicons name="albums-outline" size={22} color={theme.colors.accent.blue} />}
                disabled={stateDisabled}
                rightElement={(
                    <Switch
                        compact
                        disabled={stateDisabled}
                        value={stateShared}
                        onValueChange={setStateShared}
                    />
                )}
                showChevron={false}
                onPress={() => {
                    void setStateShared(!stateShared);
                }}
            />
        </>
    );
}
