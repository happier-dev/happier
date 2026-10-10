import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { connectedAcknowledgementSubjectKeyV1, type QualifiedAcknowledgementSubject } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults, type ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { ConnectedServicesAccountGroupOption } from '@happier-dev/agents';

import type {
    ConnectedServicesSelectionOptionAvailability,
} from '@/components/sessions/new/components/buildNewSessionConnectedServicesSelectionListModel';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { useActionSettingsNarrowLayout } from '@/components/settings/actions/useActionSettingsNarrowLayout';
import { getPreferredLanguage, t } from '@/text';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import type { ConnectedAccountPurposeDefaultsIntent } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import {
    applyProjectedCredentialKindRestrictions,
    buildQualifiedConnectedAccountGroupOptionsByServiceId,
    buildQualifiedConnectedAccountProfileOptionsByServiceId,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import {
    resolveQualifiedConnectedAccountServiceKey,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    areTeamResourceConnectedServiceSelectionsEqual,
    parseConnectedServicesServiceBinding,
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
    resolveConnectedServiceDisplayName,
    resolveQualifiedConnectedServiceRegistryDisplayName,
} from './model/resolveConnectedServiceDisplayName';
import {
    resolveConnectedServicesAuthLabel,
    type ConnectedServicesAuthWarningCode,
    resolveConnectedServicesAuthWarningTranslationKey,
} from './model/resolveConnectedServicesAuthLabel';

export type ConnectedServicesDefaultAuthRowProps = Readonly<{
    /** The search declaration this row answers for (the first agent row carries it). */
    setting?: SettingRef;
    /** Canonical Agent routing id; it keys only the released service-keyed defaults. */
    agentId: string;
    machineId?: string;
    /** The Agent's contribution identity: the consumer that keys its purpose defaults. */
    agentIdentity: PluginContributionIdentityV1 | null;
    agentTitle: string;
    connectedAccountPurposes: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    connectedAccountServiceKeys?: readonly string[];
    /**
     * Declared Connected Account service keys for this Agent. Current callers
     * pass canonical qualified keys from the authoritative machine Agent
     * catalog projection; released bundled scalar declarations are also
     * accepted and translated only through the generated built-in mapping.
     */
    connectedAccountsV4?: ReadonlyArray<AccountProfile['connectedAccountsV4'][number]>;
    connectedAccountGroupsV4?: ReadonlyArray<AccountProfile['connectedAccountGroupsV4'][number]>;
    accountGroupsEnabled: boolean;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById?: Readonly<Record<string, string>>;
    currentTeamCredentialResourceKeys?: ReadonlySet<string>;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 | null;
    purposeBindingsWritable?: boolean;
    purposeBindingsLoading?: boolean;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    settings: {
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
        connectedServicesDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
        connectedServicesAdditionalDefaultAuthByAgentIdV1?: ConnectedServicesDefaultAuthByAgentIdV1;
    };
    setDefaultAuthSettings: (intent: ConnectedAccountPurposeDefaultsIntent) => Promise<unknown>;
    onOpenConnectedServicesSettings: (serviceId: string) => void;
    /**
     * Persisted dismissals of the one-time "adopt this autoSwitch pool" suggestion,
     * keyed by the canonical qualified acknowledgement subject. Suppresses the nudge so it does
     * not nag once the user has chosen to keep the literal profile default.
     */
    dismissedPoolAdoptionSuggestionKeys?: Readonly<Record<string, boolean>>;
    onDismissPoolAdoptionSuggestion?: (subject: Extract<QualifiedAcknowledgementSubject, { kind: 'adoption' }>) => Promise<boolean>;
}>;

const EMPTY_SERVICE_BINDINGS: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> = {};
const DEFAULT_AUTH_PICKER_MAX_HEIGHT = 520;

function resolveDefaultAuthWarningLabel(warningCode: ConnectedServicesAuthWarningCode | undefined): string | undefined {
    const key = resolveConnectedServicesAuthWarningTranslationKey(warningCode);
    return key ? t(key) : undefined;
}

type PoolAdoptionSuggestion = Readonly<{
    key: string;
    subject: Extract<QualifiedAcknowledgementSubject, { kind: 'adoption' }>;
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
    const binding = parseConnectedServicesServiceBinding(params.binding);
    if (!binding || binding.source !== 'connected' || binding.selection === 'group') return null;
    const profileId = typeof binding.profileId === 'string' ? binding.profileId.trim() : '';
    if (!profileId) return null;
    for (const group of params.groupOptions) {
        if (!group.autoSwitch) continue;
        if (group.status !== 'ready') continue;
        if (!(group.memberProfileIds ?? []).includes(profileId)) continue;
        return group;
    }
    return null;
}

export function ConnectedServicesDefaultAuthRow(props: ConnectedServicesDefaultAuthRowProps) {
    const styles = stylesheet;
    const { present } = useConnectedAccountIdentityPrivacy();
    const locale = getPreferredLanguage();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const narrowLayout = useActionSettingsNarrowLayout();

    const supportedServiceIds = React.useMemo<string[]>(() => {
        const unique: string[] = [];
        for (const serviceId of props.connectedAccountServiceKeys ?? []) {
            const qualified = resolveQualifiedConnectedAccountServiceKey(serviceId);
            if (qualified && !unique.includes(qualified)) unique.push(qualified);
        }
        return unique;
    }, [props.connectedAccountServiceKeys]);

    const profileOptionsByServiceId = React.useMemo(() => applyProjectedCredentialKindRestrictions({
        optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: props.connectedAccountsV4 ?? [],
            supportedServiceIds: supportedServiceIds,
            labelsByKey: props.labelsByKey,
            presentIdentity: present,
        }),
        connectedAccounts: props.connectedAccountPurposes,
    }), [
        props.connectedAccountsV4,
        props.connectedAccountPurposes,
        props.labelsByKey,
        supportedServiceIds,
        present,
    ]);

    const accountGroupOptionsByServiceId = React.useMemo(() => buildQualifiedConnectedAccountGroupOptionsByServiceId({
        groups: props.connectedAccountGroupsV4 ?? [],
        supportedServiceIds: supportedServiceIds,
        labelsByKey: props.labelsByKey,
    }), [
        props.connectedAccountGroupsV4,
        props.labelsByKey,
        supportedServiceIds,
    ]);

    const defaultAuthSettings = React.useMemo(() => ({
        connectedServicesDefaultAuthByAgentIdV1: props.settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: props.settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    }), [
        props.settings.connectedServicesDefaultAuthByAgentIdV1,
        props.settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    ]);
    // The Agent default-authentication owner is the one reader; this row only
    // presents its purpose defaults in the Session's service-keyed shape.
    const persistedBindingsByServiceId = React.useMemo<
        Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>
    >(() => (
        props.agentIdentity && props.purposeBindings
            ? projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
                resolveAgentConnectedAccountPurposeDefaults({
                    settings: defaultAuthSettings,
                    purposeBindings: props.purposeBindings,
                    agentId: props.agentId,
                    consumer: props.agentIdentity,
                    declarations: props.connectedAccountPurposes,
                }),
            )?.bindingsByServiceId ?? EMPTY_SERVICE_BINDINGS
            : EMPTY_SERVICE_BINDINGS
    ), [defaultAuthSettings, props.purposeBindings, props.agentId, props.agentIdentity, props.connectedAccountPurposes]);
    const [bindingsByServiceId, setBindingsByServiceId] = React.useState<
        Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>
    >(persistedBindingsByServiceId);

    const [draft, setDraft] = React.useState<typeof bindingsByServiceId | null>(null);
    const pickerModalIdRef = React.useRef<string | null>(null);
    const closePicker = React.useCallback(() => {
        if (!pickerModalIdRef.current) return;
        Modal.hide(pickerModalIdRef.current);
        pickerModalIdRef.current = null;
    }, []);
    React.useEffect(() => closePicker, [closePicker]);
    React.useEffect(() => {
        if (!props.purposeBindings || props.purposeBindingsWritable === false) closePicker();
    }, [closePicker, props.purposeBindings, props.purposeBindingsWritable]);
    React.useEffect(() => {
        if (!props.purposeBindings) {
            setDraft(null);
            setBindingsByServiceId(EMPTY_SERVICE_BINDINGS);
            return;
        }
        if (!draft) setBindingsByServiceId(persistedBindingsByServiceId);
    }, [draft, persistedBindingsByServiceId, props.purposeBindings]);

    const authLabelModel = resolveConnectedServicesAuthLabel({
        supportedServiceIds,
        bindingsByServiceId,
        profileOptionsByServiceId,
        accountGroupOptionsByServiceId,
        accountGroupsEnabled: props.accountGroupsEnabled,
        defaultProfileIdByServiceId: props.settings.connectedServicesDefaultProfileByServiceId,
        resolveServiceTitle: (serviceId) => {
            const service = parseQualifiedPluginContributionKey(serviceId);
            return service
                ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
                : resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t);
        },
        nativeLabel: t('connectedServices.authChip.nativeLabel'),
        formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
    });
    const warningCode = authLabelModel.warningCodes[0];
    const warningLabel = props.purposeBindings ? resolveDefaultAuthWarningLabel(warningCode) : undefined;
    const authLabel = props.purposeBindings && (props.purposeBindingsWritable !== false || authLabelModel.connectedCount > 0) ? authLabelModel.label
        : t(props.purposeBindingsLoading ? 'common.loading' : 'common.unavailable');

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
        const nextBindingsByServiceId: Record<string, ConnectedServicesServiceBinding | undefined> = {
            ...bindingsByServiceId,
            [serviceId]: binding,
        };
        const identity = props.agentIdentity;
        if (!identity || !props.purposeBindings || props.purposeBindingsWritable === false) return;
        const selection = parseConnectedServicesServiceBinding(binding);
        if (!selection) return;
        const teamId = selection.source === 'team_resource'
            ? (props.teamCredentialResources ?? []).find((candidate) => (
                candidate.id === selection.resourceId
                && candidate.connectedServiceSelections.some((offered) => (
                    areTeamResourceConnectedServiceSelectionsEqual(offered, selection)
                ))
            ))?.teamId
            : undefined;
        const groupId = selection.source === 'connected' ? selection.groupId?.trim() ?? '' : '';
        const profileId = selection.source === 'connected' ? selection.profileId?.trim() ?? '' : '';
        const service = parseQualifiedPluginContributionKey(serviceId);
        if (!service) return;
        const intent: ConnectedAccountPurposeDefaultsIntent = { kind: 'service', input: {
            agentId: props.agentId,
            ...(props.machineId ? { machineId: props.machineId } : {}),
            service,
            selection: selection.source !== 'connected'
                ? selection
                : selection.selection === 'group' && groupId
                    ? { source: 'connected', selection: 'group', groupId }
                    : selection.selection !== 'group' && profileId
                        ? { source: 'connected', selection: 'profile', profileId }
                        // A connected pick without an exact Account/Pool stores no default.
                        : { source: 'native' },
            ...(teamId ? { teamId } : {}),
        } };
        setDraft(nextBindingsByServiceId);
        setBindingsByServiceId(nextBindingsByServiceId);
        void props.setDefaultAuthSettings(intent).then(() => {
            setDraft(current => current === nextBindingsByServiceId ? null : current);
        }).catch(() => Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable')));
    }, [
        bindingsByServiceId,
        props.purposeBindings,
        props.purposeBindingsWritable,
        props.agentId,
        props.machineId,
        props.agentIdentity,
        props.connectedAccountPurposes,
        props.setDefaultAuthSettings,
        props.teamCredentialResources,
    ]);

    const resolveOptionAvailability = React.useCallback((availabilityParams: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
    }>): ConnectedServicesSelectionOptionAvailability => {
        const state = authLabelModel.serviceStatesById[availabilityParams.serviceId];
        // The shared selection builder owns Team resource currentness and
        // recovery. Keeping a second decision here would disable the repair
        // action that the Settings parent already supplies.
        if (
            state?.warningCode
            && availabilityParams.optionId === `connected-service:${encodeURIComponent(availabilityParams.serviceId)}:native`
        ) {
            return {
                subtitle: resolveDefaultAuthWarningLabel(state.warningCode),
            };
        }
        return {};
    }, [
        authLabelModel.serviceStatesById,
        locale,
    ]);

    const openPicker = React.useCallback(() => {
        if (!props.purposeBindings || props.purposeBindingsWritable === false) return;
        closePicker();
        pickerModalIdRef.current = Modal.show({
            component: ConnectedServicesDefaultAuthPickerModalContent,
            props: {
                supportedServiceIds,
                profileOptionsByServiceId,
                groupOptionsByServiceId: accountGroupOptionsByServiceId,
                bindingsByServiceId,
                teamCredentialResources: props.teamCredentialResources,
                teamCredentialResourceCurrentKeys: props.currentTeamCredentialResourceKeys,
                teamNameById: props.teamNameById,
                onRecoverTeamCredentialResource: props.onRecoverTeamCredentialResource,
                setBindingForService,
                defaultProfileIdByServiceId: props.settings.connectedServicesDefaultProfileByServiceId,
                resolveOptionAvailability,
                onOpenSettings: props.onOpenConnectedServicesSettings,
            },
            chrome: {
                kind: 'card',
                title: props.agentTitle,
                testID: `settings-connected-services-default-auth-modal-${props.agentId}`,
                scrollHost: 'body',
                bodyScroll: 'none',
            },
            closeOnBackdrop: true,
        });
    }, [
        accountGroupOptionsByServiceId,
        bindingsByServiceId,
        closePicker,
        profileOptionsByServiceId,
        props.agentId,
        props.agentTitle,
        props.purposeBindings,
        props.purposeBindingsWritable,
        props.onOpenConnectedServicesSettings,
        props.onRecoverTeamCredentialResource,
        props.currentTeamCredentialResourceKeys,
        props.settings.connectedServicesDefaultProfileByServiceId,
        props.teamCredentialResources,
        props.teamNameById,
        resolveOptionAvailability,
        setBindingForService,
        supportedServiceIds,
    ]);

    const poolAdoptionSuggestions = React.useMemo((): ReadonlyArray<PoolAdoptionSuggestion> => {
        if (!props.agentIdentity || !props.purposeBindings) return [];
        const suggestions: PoolAdoptionSuggestion[] = [];
        for (const serviceId of supportedServiceIds) {
            const group = resolveReadyAutoSwitchPoolForProfile({
                binding: bindingsByServiceId[serviceId],
                groupOptions: accountGroupOptionsByServiceId[serviceId] ?? [],
            });
            if (!group) continue;
            const service = parseQualifiedPluginContributionKey(serviceId);
            if (!service) continue;
            const subject = { kind: 'adoption' as const, agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: props.agentIdentity }),
                service, groupId: group.groupId };
            const key = connectedAcknowledgementSubjectKeyV1(subject);
            if (props.dismissedPoolAdoptionSuggestionKeys?.[key] === true) continue;
            suggestions.push({ key, subject, serviceId, groupId: group.groupId, groupLabel: group.label });
        }
        return suggestions;
    }, [
        accountGroupOptionsByServiceId,
        bindingsByServiceId,
        props.agentIdentity,
        props.purposeBindings,
        props.dismissedPoolAdoptionSuggestionKeys,
        supportedServiceIds,
    ]);

    const acceptPoolSuggestion = React.useCallback((suggestion: PoolAdoptionSuggestion) => {
        // Writes the STORED default to the pool via the same canonical mutation as the
        // picker — the LITERAL default becomes the pool; no resolution-time rewrite exists.
        setBindingForService(suggestion.serviceId, {
            source: 'connected',
            selection: 'group',
            groupId: suggestion.groupId,
        });
    }, [setBindingForService]);

    const dismissPoolSuggestion = React.useCallback(async (suggestion: PoolAdoptionSuggestion) => {
        await props.onDismissPoolAdoptionSuggestion?.(suggestion.subject);
    }, [props.onDismissPoolAdoptionSuggestion]);

    if (supportedServiceIds.length === 0) return null;

    const row = (
        <Item
            testID={`settings-connected-services-default-auth-${props.agentId}`}
            title={props.agentTitle}
            // On a compact (mobile) layout the selected auth value is too long to sit in
            // the row's right detail next to the title, so surface it in the subtitle and
            // drop the detail. The wide layout keeps it on the right.
            subtitle={narrowLayout
                ? (warningLabel ?? authLabel)
                : (warningLabel ?? t('connectedServices.defaultAuth.rowDetail'))}
            detail={narrowLayout ? undefined : authLabel}
            disabled={!props.purposeBindings || props.purposeBindingsWritable === false}
            showChevron={true}
            onPress={openPicker}
        />
    );

    return (
        <>
            {props.setting ? <SettingAnchor setting={props.setting}>{row}</SettingAnchor> : row}
            {poolAdoptionSuggestions.map((suggestion) => (
                <View
                    key={suggestion.key}
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
                            onPress={() => dismissPoolSuggestion(suggestion)}
                            style={styles.suggestionSecondaryButton}
                        >
                            <Text style={styles.suggestionSecondaryLabel}>
                                {t('connectedServices.defaultAuth.poolSuggestion.dismiss')}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID={`settings-connected-services-pool-adoption-suggestion-${props.agentId}-${suggestion.serviceId}-accept`}
                            disabled={!props.purposeBindings || props.purposeBindingsWritable === false}
                            accessibilityRole="button"
                            accessibilityLabel={t('connectedServices.defaultAuth.poolSuggestion.accept')}
                            onPress={() => acceptPoolSuggestion(suggestion)}
                            style={styles.suggestionPrimaryButton}
                        >
                            <Text style={styles.suggestionPrimaryLabel}>
                                {t('connectedServices.defaultAuth.poolSuggestion.accept')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            ))}
        </>
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
    const { onClose, onOpenSettings, ...contentProps } = props;
    const handleOpenSettings = React.useCallback((serviceId: string) => {
        onClose();
        onOpenSettings(serviceId);
    }, [onClose, onOpenSettings]);

    return (
        <NewSessionConnectedServicesSelectionContent
            {...contentProps}
            onOpenSettings={handleOpenSettings}
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
