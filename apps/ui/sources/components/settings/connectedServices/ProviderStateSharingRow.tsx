import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { Modal } from '@/modal';
import { getPreferredLanguage, t } from '@/text';
import type { AgentCore } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import type {
    ConnectedServicesProviderConfigSharingModeV1,
    ConnectedServicesProviderStateSharingModeV1,
    ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
import type { ProviderStateSharingSettingsWriter } from './providerStateSharingSettings';

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
    setSettings: ProviderStateSharingSettingsWriter;
}>;

function resolveUnavailableReasonLabel(
    reason: ConnectedServicesProviderStateSharingUnavailableReason | undefined,
): string {
    if (reason === 'dynamic_diagnostics_required') {
        return t('connectedServices.providerStateSharing.unavailable.dynamicDiagnosticsRequired');
    }
    return t('connectedServices.providerStateSharing.unavailable.notImplemented');
}

/** The three configuration-sharing modes as short, always-visible choices with their consequence. */
export function buildProviderConfigModeChoices(): ReadonlyArray<SegmentedChoiceOption<ConnectedServicesProviderConfigSharingModeV1>> {
    return [
        {
            id: 'linked',
            label: t('connectedServicesSettings.configLinkedShort'),
            description: t('connectedServices.providerStateSharing.configLinkedSubtitle'),
        },
        {
            id: 'copied',
            label: t('connectedServicesSettings.configCopiedShort'),
            description: t('connectedServices.providerStateSharing.configCopiedSubtitle'),
        },
        {
            id: 'isolated',
            label: t('connectedServicesSettings.configIsolatedShort'),
            description: t('connectedServices.providerStateSharing.configIsolatedSubtitle'),
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
    const locale = getPreferredLanguage();
    const resolvedCapability = capability ?? UNSUPPORTED_PROVIDER_STATE_SHARING_CAPABILITY;
    const policy = resolveConnectedServicesProviderStateSharingPolicyV1(settings, agentId);
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
        setSettings(current => ({
            ...current,
            byAgentId: {
                ...current.byAgentId,
                [agentId]: {
                    ...(current.byAgentId[agentId] ?? {}),
                    ...(override.configMode ? { configMode: override.configMode } : {}),
                    ...(override.stateMode ? { stateMode: override.stateMode } : {}),
                },
            },
            acknowledgedRisksByAgentId: override.acknowledgeSharedStatePrivacy
                ? {
                    ...current.acknowledgedRisksByAgentId,
                    [agentId]: {
                        ...(current.acknowledgedRisksByAgentId[agentId] ?? {}),
                        sharedStatePrivacy: true,
                    },
                }
                : current.acknowledgedRisksByAgentId,
        }));
    }, [agentId, setSettings]);

    const configModeOptions = React.useMemo(
        () => buildProviderConfigModeChoices()
            .filter((option) => resolvedCapability.config.modes.includes(option.id)),
        [locale, resolvedCapability.config.modes],
    );

    const setConfigMode = React.useCallback((itemId: ConnectedServicesProviderConfigSharingModeV1) => {
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
        locale,
        resolvedCapability.state.sharedStatePrivacyRiskAcknowledgementRequired,
        stateDisabled,
        writeOverride,
    ]);

    return (
        <>
            {configDisabled || configModeOptions.length < 2 ? (
                <Item
                    testID={`connected-services-provider-state-sharing-agent-${agentId}-config`}
                    title={t('connectedServices.providerStateSharing.configTitle')}
                    subtitle={configDisabled
                        ? resolveUnavailableReasonLabel(resolvedCapability.config.unavailableReason)
                        : configModeOptions[0]?.description}
                    disabled={configDisabled}
                    mode="info"
                    showChevron={false}
                />
            ) : (
                <SegmentedChoiceItem<ConnectedServicesProviderConfigSharingModeV1>
                    testID={`connected-services-provider-state-sharing-agent-${agentId}-config`}
                    testIDPrefix={`connected-services-provider-state-sharing-agent-${agentId}-config`}
                    title={t('connectedServices.providerStateSharing.configTitle')}
                    options={configModeOptions}
                    subtitleLines={0}
                    value={policy.configMode}
                    onChange={setConfigMode}
                />
            )}
            <Item
                testID={`connected-services-provider-state-sharing-agent-${agentId}-state`}
                title={t('connectedServices.providerStateSharing.stateTitle')}
                subtitle={
                    stateDisabled
                        ? resolveUnavailableReasonLabel(resolvedCapability.state.unavailableReason)
                        : stateShared
                            ? t('connectedServices.providerStateSharing.stateEnabledSubtitle')
                            : t('connectedServices.providerStateSharing.stateDisabledSubtitle')
                }
                disabled={stateDisabled}
                rightElement={(
                    <Switch
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
