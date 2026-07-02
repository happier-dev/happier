import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import {
    ConnectedServiceBindingsV1Schema,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
    type ConnectedServicesDefaultAuthByAgentIdV1,
} from '@happier-dev/protocol';
import type { AgentCore } from '@happier-dev/agents';

import type {
    ConnectedServicesSelectionOptionAvailability,
} from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import {
    buildNewSessionConnectedServicesSelectionListModel,
} from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    resolveAgentSupportedConnectedServiceIds,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import {
    resolveConnectedServicesAuthLabel,
    type ConnectedServicesAuthWarningCode,
    resolveConnectedServicesAuthWarningTranslationKey,
} from './model/resolveConnectedServicesAuthLabel';

export type ConnectedServicesDefaultAuthRowProps = Readonly<{
    agentId: string;
    agentTitle: string;
    agentCore: Pick<AgentCore, 'connectedServices'>;
    connectedServicesEnabled: boolean;
    accountGroupsEnabled: boolean;
    accountProfileConnectedServicesV2: ReadonlyArray<{ serviceId: ConnectedServiceId; profiles?: ReadonlyArray<any>; groups?: unknown }>;
    settings: {
        connectedServicesProfileLabelByKey: Record<string, string | undefined>;
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
        connectedServicesDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
    };
    setDefaultAuthSettings: (next: ConnectedServicesDefaultAuthByAgentIdV1) => void;
    onOpenConnectedServicesSettings: (serviceId: string) => void;
}>;

const EMPTY_DEFAULT_AUTH_SETTINGS: ConnectedServicesDefaultAuthByAgentIdV1 = {
    v: 1,
    bindingsByAgentId: {},
};
const EMPTY_SERVICE_BINDINGS: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> = {};

function buildNextDefaultAuthSettings(params: Readonly<{
    agentId: string;
    current: ConnectedServicesDefaultAuthByAgentIdV1;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
}>): ConnectedServicesDefaultAuthByAgentIdV1 {
    const normalizedBindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
    for (const [serviceId, binding] of Object.entries(params.bindingsByServiceId)) {
        if (!binding) continue;
        if (binding.source === 'native') {
            normalizedBindingsByServiceId[serviceId] = { source: 'native' };
            continue;
        }
        if (binding.selection === 'group') {
            const groupId = typeof binding.groupId === 'string' ? binding.groupId.trim() : '';
            if (!groupId) continue;
            normalizedBindingsByServiceId[serviceId] = {
                source: 'connected',
                selection: 'group',
                groupId,
            };
            continue;
        }
        const profileId = typeof binding.profileId === 'string' ? binding.profileId.trim() : '';
        if (!profileId) continue;
        normalizedBindingsByServiceId[serviceId] = {
            source: 'connected',
            selection: 'profile',
            profileId,
        };
    }
    const hasConnectedBinding = Object.values(normalizedBindingsByServiceId).some((binding) => binding.source === 'connected');
    const bindingsByAgentId: Record<string, ConnectedServiceBindingsV1> = {
        ...params.current.bindingsByAgentId,
    };

    if (hasConnectedBinding) {
        bindingsByAgentId[params.agentId] = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: normalizedBindingsByServiceId,
        });
    } else {
        delete bindingsByAgentId[params.agentId];
    }

    return {
        v: 1,
        bindingsByAgentId,
    };
}

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
    const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
    return key ? t(key) : undefined;
}

export function ConnectedServicesDefaultAuthRow(props: ConnectedServicesDefaultAuthRowProps) {
    const { theme } = useUnistyles();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const supportedServiceIds = React.useMemo(() => resolveAgentSupportedConnectedServiceIds({
        connectedServicesFeatureEnabled: props.connectedServicesEnabled,
        agentCore: props.agentCore,
    }), [props.agentCore, props.connectedServicesEnabled]);

    const profileOptionsByServiceId = React.useMemo(() => buildConnectedServiceProfileOptionsByServiceId({
        accountProfileConnectedServicesV2: props.accountProfileConnectedServicesV2,
        agentCore: props.agentCore,
        supportedConnectedServiceIds: supportedServiceIds,
        labelsByKey: props.settings.connectedServicesProfileLabelByKey,
    }), [
        props.accountProfileConnectedServicesV2,
        props.agentCore,
        props.settings.connectedServicesProfileLabelByKey,
        supportedServiceIds,
    ]);

    const accountGroupOptionsByServiceId = React.useMemo(() => buildConnectedServiceAccountGroupOptionsByServiceId({
        accountGroupsFeatureEnabled: props.accountGroupsEnabled,
        accountProfileConnectedServicesV2: props.accountProfileConnectedServicesV2,
        supportedConnectedServiceIds: supportedServiceIds,
    }), [
        props.accountGroupsEnabled,
        props.accountProfileConnectedServicesV2,
        supportedServiceIds,
    ]);

    const defaultAuthSettings = props.settings.connectedServicesDefaultAuthByAgentIdV1 ?? EMPTY_DEFAULT_AUTH_SETTINGS;
    const persistedBindingsByServiceId = defaultAuthSettings.bindingsByAgentId[props.agentId]?.bindingsByServiceId ?? EMPTY_SERVICE_BINDINGS;
    const [bindingsByServiceId, setBindingsByServiceId] = React.useState<
        Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>
    >(persistedBindingsByServiceId);

    React.useEffect(() => {
        setBindingsByServiceId(persistedBindingsByServiceId);
    }, [persistedBindingsByServiceId]);

    const authLabelModel = resolveConnectedServicesAuthLabel({
        supportedServiceIds,
        bindingsByServiceId,
        profileOptionsByServiceId,
        accountGroupOptionsByServiceId,
        accountGroupsEnabled: props.accountGroupsEnabled,
        defaultProfileIdByServiceId: props.settings.connectedServicesDefaultProfileByServiceId,
        resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
        nativeLabel: t('connectedServices.authChip.nativeLabel'),
        formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
    });
    const warningCode = authLabelModel.warningCodes[0];

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
        const nextBindingsByServiceId: Record<string, ConnectedServicesServiceBinding | undefined> = {
            ...bindingsByServiceId,
            [serviceId]: binding,
        };
        setBindingsByServiceId(nextBindingsByServiceId);
        props.setDefaultAuthSettings(buildNextDefaultAuthSettings({
            agentId: props.agentId,
            current: defaultAuthSettings,
            bindingsByServiceId: nextBindingsByServiceId,
        }));
    }, [
        bindingsByServiceId,
        defaultAuthSettings,
        props.agentId,
        props.setDefaultAuthSettings,
    ]);

    const selectionModel = React.useMemo(() => buildNewSessionConnectedServicesSelectionListModel({
        supportedServiceIds,
        profileOptionsByServiceId,
        groupOptionsByServiceId: accountGroupOptionsByServiceId,
        bindingsByServiceId,
        defaultProfileIdByServiceId: props.settings.connectedServicesDefaultProfileByServiceId,
        quotaBadgesByKey: {},
        setBindingForService,
        onOpenSettings: props.onOpenConnectedServicesSettings,
        translate: t,
        resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
        renderSelectionIcon: ({ selected, variant }) => (
            <Ionicons
                name={selected ? 'checkmark-circle' : variant === 'warning' ? 'alert-circle-outline' : 'ellipse-outline'}
                size={22}
                color={selected ? theme.colors.accent.blue : theme.colors.text.secondary}
            />
        ),
        renderSettingsIcon: () => (
            <Ionicons name="settings-outline" size={22} color={theme.colors.text.secondary} />
        ),
        renderQuotaBadges: () => null,
        renderNeedsReauthPill: () => null,
        resolveOptionAvailability: ({ serviceId, optionId }) => {
            const state = authLabelModel.serviceStatesById[serviceId];
            if (
                state?.warningCode
                && optionId === `connected-service:${encodeURIComponent(serviceId)}:native`
            ) {
                return {
                    subtitle: resolveDefaultAuthWarningLabel(state.warningCode),
                };
            }
            return {};
        },
    }), [
        accountGroupOptionsByServiceId,
        authLabelModel.serviceStatesById,
        bindingsByServiceId,
        profileOptionsByServiceId,
        props.onOpenConnectedServicesSettings,
        props.settings.connectedServicesDefaultProfileByServiceId,
        setBindingForService,
        supportedServiceIds,
        theme.colors.accent.blue,
        theme.colors.text.secondary,
    ]);

    const dropdownItems = React.useMemo((): DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [];
        for (const section of selectionModel.rootStep.sections) {
            if (section.kind !== 'static') continue;
            for (const option of section.options) {
                items.push({
                    id: option.id,
                    title: option.label,
                    subtitle: option.subtitle,
                    category: section.title,
                    icon: option.icon,
                    disabled: option.disabled,
                });
            }
        }
        return items;
    }, [selectionModel.rootStep.sections]);

    const handleSelect = React.useCallback((itemId: string) => {
        const option = selectionModel.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .find((candidate) => candidate.id === itemId);
        option?.onSelect?.();
        setMenuOpen(false);
    }, [selectionModel.rootStep.sections]);

    if (supportedServiceIds.length === 0) return null;

    return (
        <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            variant="selectable"
            search={false}
            selectedId={selectionModel.selectedOptionId}
            showCategoryTitles={supportedServiceIds.length > 1}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: props.agentTitle,
                subtitle: resolveDefaultAuthWarningLabel(warningCode) ?? t('connectedServices.defaultAuth.rowDetail'),
                icon: <Ionicons name="key-outline" size={22} color={theme.colors.accent.blue} />,
                showSelectedSubtitle: false,
                detailFormatter: () => authLabelModel.label,
                itemProps: {
                    testID: `settings-connected-services-default-auth-${props.agentId}`,
                },
            }}
            items={dropdownItems}
            onSelect={handleSelect}
        />
    );
}
