import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    ConnectedServiceBindingsV1Schema,
    readConnectedServicesDefaultAuthSettings,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
    type ConnectedServicesDefaultAuthByAgentIdV1,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { useConnectedServiceAuthGroupsQuery } from '@/hooks/server/connectedServices/useConnectedServiceAuthGroupsQuery';
import { useActionSettingsNarrowLayout } from '@/components/settings/actions/useActionSettingsNarrowLayout';
import { t } from '@/text';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    resolveAgentSupportedConnectedServiceIds,
    type ConnectedServicesAccountGroupOption,
    type NewSessionConnectedServiceProjection,
    type NewSessionConnectedServicesAgentCore,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import type { ConnectedServicesSelectionOptionAvailability } from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import { Icon } from '@/components/ui/icons/Icon';
import {
    resolveConnectedServicesAuthLabel,
    type ConnectedServicesAuthWarningCode,
    resolveConnectedServicesAuthWarningTranslationKey,
} from './model/resolveConnectedServicesAuthLabel';

export type ConnectedServicesDefaultAuthRowProps = Readonly<{
    agentId: string;
    agentTitle: string;
    agentCore: NewSessionConnectedServicesAgentCore;
    connectedServicesEnabled: boolean;
    accountGroupsEnabled: boolean;
    accountProfileConnectedServicesV2: ReadonlyArray<NewSessionConnectedServiceProjection>;
    settings: {
        connectedServicesProfileLabelByKey: Record<string, string | undefined>;
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
        connectedServicesDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
        connectedServicesAdditionalDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
    };
    setDefaultAuthSettings: (next: ConnectedServicesDefaultAuthByAgentIdV1) => void;
    onOpenConnectedServiceSettings: (serviceId: string) => void;
    onReconnectConnectedServiceProfile?: (serviceId: string, profileId: string) => void;
    /**
     * Persisted dismissals of the one-time "adopt this autoSwitch pool" suggestion,
     * keyed by `${agentId}:${serviceId}:${groupId}`. Suppresses the nudge so it does
     * not nag once the user has chosen to keep the literal profile default.
     */
    dismissedPoolAdoptionSuggestionKeys?: Readonly<Record<string, boolean>>;
    onDismissPoolAdoptionSuggestion?: (key: string) => void;
}>;

const EMPTY_SERVICE_BINDINGS: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> = {};
const DEFAULT_AUTH_PICKER_MAX_HEIGHT = 520;

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

type PoolAdoptionSuggestion = Readonly<{
    key: string;
    serviceId: string;
    groupId: string;
    groupLabel: string;
}>;

/**
 * A profile-default is a candidate for pool adoption when the exact stored profile is a
 * member of a READY autoSwitch pool for the same service. This is the ONLY pool-awareness
 * used here: it drives a visible suggestion, never a silent resolution-time rewrite.
 */
function resolveReadyAutoSwitchPoolForProfile(params: Readonly<{
    binding: ConnectedServicesServiceBinding | undefined;
    groupOptions: ReadonlyArray<ConnectedServicesAccountGroupOption>;
}>): ConnectedServicesAccountGroupOption | null {
    const binding = params.binding;
    if (!binding || binding.source !== 'connected' || binding.selection !== 'profile') return null;
    const profileId = typeof binding.profileId === 'string' ? binding.profileId.trim() : '';
    if (!profileId) return null;
    for (const group of params.groupOptions) {
        if (group.autoSwitch !== true) continue;
        if (group.status !== 'ready') continue;
        if (!(group.memberProfileIds ?? []).includes(profileId)) continue;
        return group;
    }
    return null;
}

export function ConnectedServicesDefaultAuthRow(props: ConnectedServicesDefaultAuthRowProps) {
    const { theme } = useUnistyles();
    const narrowLayout = useActionSettingsNarrowLayout();
    const [locallyDismissedKeys, setLocallyDismissedKeys] = React.useState<Readonly<Record<string, boolean>>>({});

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

    const defaultAuthSettings = React.useMemo(() => readConnectedServicesDefaultAuthSettings(props.settings), [
        props.settings.connectedServicesDefaultAuthByAgentIdV1,
        props.settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    ]);
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
    const warningLabel = resolveDefaultAuthWarningLabel(warningCode);

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

    const resolveOptionAvailability = React.useCallback((availabilityParams: Readonly<{
        serviceId: string;
        optionId: string;
    }>): ConnectedServicesSelectionOptionAvailability => {
        const state = authLabelModel.serviceStatesById[availabilityParams.serviceId];
        if (
            state?.warningCode
            && availabilityParams.optionId === `connected-service:${encodeURIComponent(availabilityParams.serviceId)}:native`
        ) {
            return {
                subtitle: resolveDefaultAuthWarningLabel(state.warningCode),
            };
        }
        return {};
    }, [authLabelModel.serviceStatesById]);

    const openPicker = React.useCallback(() => {
        Modal.show({
            component: ConnectedServicesDefaultAuthPickerModalContent,
            props: {
                supportedServiceIds,
                profileOptionsByServiceId,
                accountGroupOptionsByServiceId,
                bindingsByServiceId,
                setBindingForService,
                defaultProfileIdByServiceId: props.settings.connectedServicesDefaultProfileByServiceId,
                resolveOptionAvailability,
                onReconnectProfile: props.onReconnectConnectedServiceProfile,
                onOpenSettings: props.onOpenConnectedServiceSettings,
            },
            chrome: {
                kind: 'card',
                title: props.agentTitle,
                testID: `settings-connected-services-default-auth-modal-${props.agentId}`,
                layout: 'fill',
                bodyScroll: 'none',
            },
            closeOnBackdrop: true,
        });
    }, [
        accountGroupOptionsByServiceId,
        bindingsByServiceId,
        profileOptionsByServiceId,
        props.agentId,
        props.agentTitle,
        props.onOpenConnectedServiceSettings,
        props.onReconnectConnectedServiceProfile,
        props.settings.connectedServicesDefaultProfileByServiceId,
        resolveOptionAvailability,
        setBindingForService,
        supportedServiceIds,
    ]);

    const acceptPoolSuggestion = React.useCallback((suggestion: PoolAdoptionSuggestion) => {
        setBindingForService(suggestion.serviceId, {
            source: 'connected',
            selection: 'group',
            groupId: suggestion.groupId,
        });
    }, [setBindingForService]);

    const dismissPoolSuggestion = React.useCallback((suggestion: PoolAdoptionSuggestion) => {
        setLocallyDismissedKeys((prev) => ({ ...prev, [suggestion.key]: true }));
        props.onDismissPoolAdoptionSuggestion?.(suggestion.key);
    }, [props.onDismissPoolAdoptionSuggestion]);

    if (supportedServiceIds.length === 0) return null;

    return (
        <>
            <Item
                testID={`settings-connected-services-default-auth-${props.agentId}`}
                title={props.agentTitle}
                icon={<Icon name="key" size={20} color={theme.colors.accent.blue} />}
                // On a compact (mobile) layout the selected auth value is too long to sit in
                // the row's right detail next to the title, so surface it in the subtitle and
                // drop the detail. The wide layout keeps it on the right.
                subtitle={narrowLayout
                    ? (warningLabel ?? authLabelModel.label)
                    : (warningLabel ?? t('connectedServices.defaultAuth.rowDetail'))}
                detail={narrowLayout ? undefined : authLabelModel.label}
                showChevron={true}
                onPress={openPicker}
            />
            {props.accountGroupsEnabled && supportedServiceIds.map((serviceId) => {
                const binding = bindingsByServiceId[serviceId];
                const projection = props.accountProfileConnectedServicesV2.find((entry) => entry.serviceId === serviceId);
                if (binding?.source !== 'connected' || binding.selection !== 'profile' || !projection) return null;
                if (!Array.isArray(projection.groups) || projection.groups.length === 0) return null;
                return (
                    <ConnectedServicesPoolAdoptionSuggestion
                        key={serviceId}
                        agentId={props.agentId}
                        serviceId={serviceId}
                        projection={projection}
                        binding={binding}
                        dismissedKeys={props.dismissedPoolAdoptionSuggestionKeys}
                        locallyDismissedKeys={locallyDismissedKeys}
                        onAccept={acceptPoolSuggestion}
                        onDismiss={dismissPoolSuggestion}
                    />
                );
            })}
        </>
    );
}

// Policy is demanded only by the visible adoption candidate; pickers keep using the
// lightweight profile projection and do not issue an extra group read.
function ConnectedServicesPoolAdoptionSuggestion(props: Readonly<{
    agentId: string;
    serviceId: ConnectedServiceId;
    projection: NewSessionConnectedServiceProjection;
    binding: ConnectedServicesServiceBinding;
    dismissedKeys?: Readonly<Record<string, boolean>>;
    locallyDismissedKeys: Readonly<Record<string, boolean>>;
    onAccept: (suggestion: PoolAdoptionSuggestion) => void;
    onDismiss: (suggestion: PoolAdoptionSuggestion) => void;
}>) {
    const styles = stylesheet;
    const { groups, loadStatus } = useConnectedServiceAuthGroupsQuery({
        serviceId: props.serviceId,
        enabled: true,
        serviceProjectionSignature: JSON.stringify(props.projection.groups),
    });
    const options = React.useMemo(() => buildConnectedServiceAccountGroupOptionsByServiceId({
        accountGroupsFeatureEnabled: true,
        accountProfileConnectedServicesV2: [props.projection],
        supportedConnectedServiceIds: [props.serviceId],
        accountGroupsByServiceId: loadStatus === 'loaded' || loadStatus === 'refreshing'
            ? { [props.serviceId]: groups }
            : undefined,
    }), [groups, loadStatus, props.projection, props.serviceId]);
    const group = resolveReadyAutoSwitchPoolForProfile({
        binding: props.binding,
        groupOptions: options[props.serviceId] ?? [],
    });
    if (!group) return null;
    const key = `${props.agentId}:${props.serviceId}:${group.groupId}`;
    if (props.dismissedKeys?.[key] || props.locallyDismissedKeys[key]) return null;
    const suggestion: PoolAdoptionSuggestion = {
        key, serviceId: props.serviceId, groupId: group.groupId, groupLabel: group.label,
    };
    return (
        <View
            testID={`settings-connected-services-pool-adoption-suggestion-${props.agentId}-${suggestion.serviceId}`}
            style={styles.suggestion}
        >
            <Text style={styles.suggestionText}>
                {t('connectedServices.defaultAuth.poolSuggestion.body', { pool: suggestion.groupLabel })}
            </Text>
            <View style={styles.suggestionActions}>
                <Pressable
                    testID={`settings-connected-services-pool-adoption-suggestion-${props.agentId}-${suggestion.serviceId}-dismiss`}
                    accessibilityRole="button"
                    accessibilityLabel={t('connectedServices.defaultAuth.poolSuggestion.dismiss')}
                    onPress={() => props.onDismiss(suggestion)}
                    style={styles.suggestionSecondaryButton}
                >
                    <Text style={styles.suggestionSecondaryLabel}>
                        {t('connectedServices.defaultAuth.poolSuggestion.dismiss')}
                    </Text>
                </Pressable>
                <Pressable
                    testID={`settings-connected-services-pool-adoption-suggestion-${props.agentId}-${suggestion.serviceId}-accept`}
                    accessibilityRole="button"
                    accessibilityLabel={t('connectedServices.defaultAuth.poolSuggestion.accept')}
                    onPress={() => props.onAccept(suggestion)}
                    style={styles.suggestionPrimaryButton}
                >
                    <Text style={styles.suggestionPrimaryLabel}>
                        {t('connectedServices.defaultAuth.poolSuggestion.accept')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

type ConnectedServicesDefaultAuthPickerModalContentProps = Readonly<{
    onClose: () => void;
}> & Omit<
    React.ComponentProps<typeof NewSessionConnectedServicesSelectionContent>,
    'requestClose' | 'maxHeight'
>;

function ConnectedServicesDefaultAuthPickerModalContent(
    props: ConnectedServicesDefaultAuthPickerModalContentProps,
) {
    const { onClose, ...contentProps } = props;
    return (
        <NewSessionConnectedServicesSelectionContent
            {...contentProps}
            requestClose={onClose}
            maxHeight={DEFAULT_AUTH_PICKER_MAX_HEIGHT}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    suggestion: {
        marginTop: 8,
        marginHorizontal: 12,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.elevated,
        gap: 10,
    },
    suggestionText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    suggestionActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
    suggestionSecondaryButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
    },
    suggestionSecondaryLabel: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    suggestionPrimaryButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent.blue,
    },
    suggestionPrimaryLabel: {
        fontSize: 13,
        color: theme.colors.button.primary.tint,
    },
}));
