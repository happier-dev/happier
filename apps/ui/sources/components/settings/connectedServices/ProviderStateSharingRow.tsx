import * as React from 'react';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { CONNECTED_SERVICES_SETTINGS } from './connectedServicesSettings';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { getPreferredLanguage, t } from '@/text';
import type { AgentCore } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import type {
    ConnectedServicesProviderConfigSharingModeV1,
    ConnectedServicesProviderStateSharingModeV1,
    ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol/account/settings/connected-services';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';

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
    capability,
    settings,
}: ProviderStateSharingRowsProps) {
    const { setSetting } = useSettingActionFeedback();
    const locale = getPreferredLanguage();
    const resolvedCapability = capability ?? UNSUPPORTED_PROVIDER_STATE_SHARING_CAPABILITY;
    const policy = resolveConnectedServicesProviderStateSharingPolicyV1(settings, agentId);
    const configDisabled = !resolvedCapability.config.supported;
    const stateDisabled = !resolvedCapability.state.supported || !resolvedCapability.state.modes.includes('shared');
    const stateShared = policy.stateMode === 'shared' && !stateDisabled;

    const writeOverride = React.useCallback(async (override: Readonly<{
        configMode?: ConnectedServicesProviderConfigSharingModeV1;
        stateMode?: ConnectedServicesProviderStateSharingModeV1;
    }>) => {
        await setSetting(CONNECTED_SERVICES_SETTINGS.settings.sharingPerAgent, { agentId, ...override });
    }, [agentId, setSetting]);

    const configModeOptions = React.useMemo(
        () => buildProviderConfigModeChoices()
            .filter((option) => resolvedCapability.config.modes.includes(option.id)),
        [locale, resolvedCapability.config.modes],
    );

    const setConfigMode = React.useCallback((itemId: ConnectedServicesProviderConfigSharingModeV1) => {
        if (configDisabled) return;
        if (itemId !== 'linked' && itemId !== 'copied' && itemId !== 'isolated') return;
        if (!resolvedCapability.config.modes.includes(itemId)) return;
        void writeOverride({ configMode: itemId });
    }, [configDisabled, resolvedCapability.config.modes, writeOverride]);

    const setStateShared = React.useCallback(async (shared: boolean) => {
        if (stateDisabled) return;
        await writeOverride({
            stateMode: shared ? 'shared' : 'isolated',
        });
    }, [
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
