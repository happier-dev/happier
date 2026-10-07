import * as React from 'react';

import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { getPreferredLanguage, t } from '@/text';
import { useSettingMutable } from '@/sync/store/hooks';
import {
    ConnectedServicesProviderStateSharingSettingsV1Schema,
    type ConnectedServicesProviderConfigSharingModeV1,
    type ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol/account/settings/connected-services';

import { buildProviderConfigModeChoices, ProviderStateSharingRows } from './ProviderStateSharingRow';
import { CONNECTED_SERVICES_SETTINGS, CONNECTED_SERVICES_SHARING_SETTINGS } from './connectedServicesSettings';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Icon } from '@/components/ui/icons/Icon';

type ProviderConfigMode = ConnectedServicesProviderConfigSharingModeV1;

export type ProviderStateSharingSettingsWriter = (settings: ConnectedServicesProviderStateSharingSettingsV1) => void;

export function resolveProviderStateSharingAgentIds(
    agentIds: readonly AgentId[] = AGENT_IDS,
): readonly AgentId[] {
    return agentIds.filter((agentId) => {
        const capability = getAgentCore(agentId)?.connectedServices?.providerStateSharing;
        return capability?.config.supported === true || capability?.state.supported === true;
    });
}

function resolveConfigModeShortLabel(mode: ProviderConfigMode): string {
    if (mode === 'copied') return t('connectedServicesSettings.configCopiedShort');
    if (mode === 'isolated') return t('connectedServicesSettings.configIsolatedShort');
    return t('connectedServicesSettings.configLinkedShort');
}

function resolveSharedStatePrivacyRiskAgents(
    agentIds: readonly AgentId[],
): Array<{ agentId: AgentId; agentTitle: string }> {
    const entries: Array<{ agentId: AgentId; agentTitle: string }> = [];
    for (const agentId of agentIds) {
        const agentCore = getAgentCore(agentId);
        if (!agentCore) continue;
        const stateCapability = agentCore.connectedServices?.providerStateSharing?.state;
        if (stateCapability?.supported !== true) continue;
        if (!stateCapability.modes.includes('shared')) continue;
        if (stateCapability.sharedStatePrivacyRiskAcknowledgementRequired !== true) continue;
        entries.push({
            agentId,
            agentTitle: t(agentCore.displayNameKey),
        });
    }
    return entries;
}

/**
 * The default configuration and state sharing for connected-account sessions, as one disclosure in
 * the "How accounts are used" section. Its closed state says what is shared; it opens by itself when
 * search leads to one of its rows.
 */
export function ConnectedServicesProviderStateSharingDisclosure(props: Readonly<{
    settings: ConnectedServicesProviderStateSharingSettingsV1;
    setSettings: ProviderStateSharingSettingsWriter;
    onOpenBackendOverrides?: (() => void) | null;
    agentIds?: readonly AgentId[];
    showDivider?: boolean;
}>) {
    const agentIds = props.agentIds ?? resolveProviderStateSharingAgentIds();
    const [expanded, setExpanded] = React.useState(false);
    const locale = getPreferredLanguage();
    const choices = React.useMemo(() => buildProviderConfigModeChoices(), [locale]);
    const stateShared = props.settings.defaults.stateMode === 'shared';

    const setProviderConfigMode = React.useCallback((configMode: ProviderConfigMode) => {
        props.setSettings({
            ...props.settings,
            defaults: {
                ...props.settings.defaults,
                configMode,
            },
        });
    }, [props]);

    const setProviderStateShared = React.useCallback(async (shared: boolean) => {
        const acknowledgedRisksByAgentId = { ...props.settings.acknowledgedRisksByAgentId };
        if (shared) {
            const agentsNeedingAcknowledgement = resolveSharedStatePrivacyRiskAgents(agentIds).filter(
                (entry) => acknowledgedRisksByAgentId[entry.agentId]?.sharedStatePrivacy !== true,
            );
            if (agentsNeedingAcknowledgement.length > 0) {
                const confirmed = await Modal.confirm(
                    t('connectedServices.providerStateSharing.sharedStatePrivacyTitle'),
                    t('connectedServices.providerStateSharing.sharedStatePrivacyBody', {
                        agent: agentsNeedingAcknowledgement.map((entry) => entry.agentTitle).join(', '),
                    }),
                    {
                        confirmText: t('common.continue'),
                        destructive: false,
                    },
                );
                if (!confirmed) return;
                for (const entry of agentsNeedingAcknowledgement) {
                    acknowledgedRisksByAgentId[entry.agentId] = {
                        ...acknowledgedRisksByAgentId[entry.agentId],
                        sharedStatePrivacy: true,
                    };
                }
            }
        }
        props.setSettings({
            ...props.settings,
            defaults: {
                ...props.settings.defaults,
                stateMode: shared ? 'shared' : 'isolated',
            },
            acknowledgedRisksByAgentId,
        });
    }, [agentIds, locale, props]);

    const summary = t('connectedServicesSettings.sharingSummary', {
        config: resolveConfigModeShortLabel(props.settings.defaults.configMode),
        state: stateShared
            ? t('connectedServicesSettings.stateSharedShort')
            : t('connectedServicesSettings.stateIsolatedShort'),
    });

    return (
        <SettingAnchor settings={CONNECTED_SERVICES_SHARING_SETTINGS}><ExpandableItem
            testID="connected-services-provider-state-sharing"
            expanded={expanded}
            onExpandedChange={setExpanded}
            showDivider={props.showDivider}
            header={({ headerProps }) => (
                <SettingAnchor setting={CONNECTED_SERVICES_SETTINGS.settings.sharing}>
                    <Item
                        {...headerProps}
                        testID="connected-services-provider-state-sharing-toggle"
                        title={t(CONNECTED_SERVICES_SETTINGS.settings.sharing.titleKey)}
                        // Closed, the row says what is shared; open, it explains the boundary.
                        subtitle={expanded ? t('connectedServices.providerStateSharing.footer') : summary}
                        subtitleLines={0}
                    />
                </SettingAnchor>
            )}
        >
            <SettingAnchor setting={CONNECTED_SERVICES_SETTINGS.settings.sharingConfig}>
                <SegmentedChoiceItem<ProviderConfigMode>
                    testID="connected-services-provider-state-sharing-config-default"
                    testIDPrefix="connected-services-provider-state-sharing-config-default"
                    title={t(CONNECTED_SERVICES_SETTINGS.settings.sharingConfig.titleKey)}
                    options={choices}
                    subtitleLines={0}
                    value={props.settings.defaults.configMode}
                    onChange={setProviderConfigMode}
                />
            </SettingAnchor>
            <SettingRow
                setting={CONNECTED_SERVICES_SETTINGS.settings.sharingState}
                testID="connected-services-provider-state-sharing-state-default"
                subtitle={stateShared
                    ? t('connectedServices.providerStateSharing.stateEnabledSubtitle')
                    : t('connectedServices.providerStateSharing.stateDisabledSubtitle')}
                rightElement={(
                    <Switch
                        value={stateShared}
                        onValueChange={setProviderStateShared}
                    />
                )}
                showChevron={false}
                onPress={() => setProviderStateShared(!stateShared)}
            />
            {props.onOpenBackendOverrides && agentIds.length > 0 ? (
                <SettingRow
                    setting={CONNECTED_SERVICES_SETTINGS.settings.sharingPerAgent}
                    testID="connected-services-provider-state-sharing-backend-overrides"
                    icon={<Icon name="sliders-horizontal" />}
                    onPress={props.onOpenBackendOverrides}
                />
            ) : null}
        </ExpandableItem></SettingAnchor>
    );
}

export function ConnectedServicesProviderStateSharingBackendGroups(props: Readonly<{
    settings: ConnectedServicesProviderStateSharingSettingsV1;
    setSettings: ProviderStateSharingSettingsWriter;
    agentIds?: readonly AgentId[];
}>) {
    const agentIds = props.agentIds ?? resolveProviderStateSharingAgentIds();

    return (
        <>
            {agentIds.map((agentId) => {
                const agentCore = getAgentCore(agentId);
                if (!agentCore) return null;
                return (
                    <ItemGroup
                        key={agentId}
                        title={t(agentCore.displayNameKey)}
                    >
                        <ProviderStateSharingRows
                            agentId={agentId}
                            agentTitle={t(agentCore.displayNameKey)}
                            capability={agentCore.connectedServices?.providerStateSharing ?? null}
                            settings={props.settings}
                            setSettings={props.setSettings}
                        />
                    </ItemGroup>
                );
            })}
        </>
    );
}

export function ConnectedServicesProviderStateSharingSettingsView() {
    const [providerStateSharingSettings, setProviderStateSharingSettings] =
        useSettingMutable('connectedServicesProviderStateSharingSettingsV1');
    const normalizedProviderStateSharingSettings = React.useMemo(
        () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSettings),
        [providerStateSharingSettings],
    );

    return (
        <ItemList>
            <SettingsPageHeader description={t('connectedServicesSettings.perAgentPurpose')} />
            <ConnectedServicesProviderStateSharingBackendGroups
                settings={normalizedProviderStateSharingSettings}
                setSettings={setProviderStateSharingSettings}
            />
        </ItemList>
    );
}
