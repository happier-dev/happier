import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/store/hooks';
import {
    ConnectedServicesProviderStateSharingSettingsV1Schema,
    type ConnectedServicesProviderConfigSharingModeV1,
    type ConnectedServicesProviderStateSharingSettingsV1,
} from '@happier-dev/protocol';

import { ProviderStateSharingRows } from './ProviderStateSharingRow';

type ProviderConfigMode = ConnectedServicesProviderConfigSharingModeV1;

export type ProviderStateSharingSettingsWriter = (settings: ConnectedServicesProviderStateSharingSettingsV1) => void;

export function resolveProviderStateSharingAgentIds(
    agentIds: readonly AgentId[] = AGENT_IDS,
): readonly AgentId[] {
    return agentIds.filter((agentId) => {
        const capability = getAgentCore(agentId).connectedServices?.providerStateSharing;
        return capability?.config.supported === true || capability?.state.supported === true;
    });
}

function buildProviderConfigModeOptions(params: Readonly<{
    colors: Readonly<{
        blue: string;
        indigo: string;
        secondary: string;
    }>;
}>): readonly DropdownMenuItem[] {
    return [
        {
            id: 'linked',
            title: t('connectedServices.providerStateSharing.configLinkedTitle'),
            subtitle: t('connectedServices.providerStateSharing.configLinkedSubtitle'),
            icon: <Ionicons name="link-outline" size={22} color={params.colors.blue} />,
        },
        {
            id: 'copied',
            title: t('connectedServices.providerStateSharing.configCopiedTitle'),
            subtitle: t('connectedServices.providerStateSharing.configCopiedSubtitle'),
            icon: <Ionicons name="copy-outline" size={22} color={params.colors.indigo} />,
        },
        {
            id: 'isolated',
            title: t('connectedServices.providerStateSharing.configIsolatedTitle'),
            subtitle: t('connectedServices.providerStateSharing.configIsolatedSubtitle'),
            icon: <Ionicons name="lock-closed-outline" size={22} color={params.colors.secondary} />,
        },
    ];
}

function resolveSharedStatePrivacyRiskAgents(
    agentIds: readonly AgentId[],
): Array<{ agentId: AgentId; agentTitle: string }> {
    const entries: Array<{ agentId: AgentId; agentTitle: string }> = [];
    for (const agentId of agentIds) {
        const agentCore = getAgentCore(agentId);
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

export function ConnectedServicesProviderStateSharingDefaultsGroup(props: Readonly<{
    settings: ConnectedServicesProviderStateSharingSettingsV1;
    setSettings: ProviderStateSharingSettingsWriter;
    onOpenBackendOverrides?: (() => void) | null;
    agentIds?: readonly AgentId[];
}>) {
    const { theme } = useUnistyles();
    const agentIds = props.agentIds ?? resolveProviderStateSharingAgentIds();
    const [openProviderConfigModeMenu, setOpenProviderConfigModeMenu] = React.useState(false);
    const providerConfigModeOptions = React.useMemo(() => buildProviderConfigModeOptions({
        colors: {
            blue: theme.colors.accent.blue,
            indigo: theme.colors.accent.indigo,
            secondary: theme.colors.text.secondary,
        },
    }), [theme.colors.accent.blue, theme.colors.accent.indigo, theme.colors.text.secondary]);

    const setProviderConfigMode = React.useCallback((configMode: ProviderConfigMode) => {
        props.setSettings({
            ...props.settings,
            defaults: {
                ...props.settings.defaults,
                configMode,
            },
        });
    }, [props]);

    const handleProviderConfigModeSelect = React.useCallback((itemId: string) => {
        if (itemId !== 'linked' && itemId !== 'copied' && itemId !== 'isolated') return;
        setProviderConfigMode(itemId);
    }, [setProviderConfigMode]);

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
    }, [agentIds, props]);

    return (
        <ItemGroup
            title={t('connectedServices.providerStateSharing.title')}
            footer={t('connectedServices.providerStateSharing.footer')}
        >
            <DropdownMenu
                open={openProviderConfigModeMenu}
                onOpenChange={setOpenProviderConfigModeMenu}
                variant="selectable"
                search={false}
                selectedId={props.settings.defaults.configMode}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                itemTrigger={{
                    title: t('connectedServices.providerStateSharing.configTitle'),
                    icon: <Ionicons name="settings-outline" size={22} color={theme.colors.accent.blue} />,
                    showSelectedSubtitle: true,
                    itemProps: { testID: 'connected-services-provider-state-sharing-config-default' },
                }}
                items={providerConfigModeOptions}
                onSelect={handleProviderConfigModeSelect}
            />
            <Item
                testID="connected-services-provider-state-sharing-state-default"
                title={t('connectedServices.providerStateSharing.stateTitle')}
                subtitle={
                    props.settings.defaults.stateMode === 'shared'
                        ? t('connectedServices.providerStateSharing.stateEnabledSubtitle')
                        : t('connectedServices.providerStateSharing.stateDisabledSubtitle')
                }
                icon={<Ionicons name="albums-outline" size={22} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        compact
                        value={props.settings.defaults.stateMode === 'shared'}
                        onValueChange={setProviderStateShared}
                    />
                )}
                showChevron={false}
                onPress={() => setProviderStateShared(props.settings.defaults.stateMode !== 'shared')}
            />
            {props.onOpenBackendOverrides && agentIds.length > 0 ? (
                <Item
                    testID="connected-services-provider-state-sharing-backend-overrides"
                    title={t('connectedServices.providerStateSharing.title')}
                    subtitle={t('connectedServices.providerStateSharing.footer')}
                    icon={<Ionicons name="options-outline" size={22} color={theme.colors.text.secondary} />}
                    onPress={props.onOpenBackendOverrides}
                />
            ) : null}
        </ItemGroup>
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
            <ConnectedServicesProviderStateSharingBackendGroups
                settings={normalizedProviderStateSharingSettings}
                setSettings={setProviderStateSharingSettings}
            />
        </ItemList>
    );
}
