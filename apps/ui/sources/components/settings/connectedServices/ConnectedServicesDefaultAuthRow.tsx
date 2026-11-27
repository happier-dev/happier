import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { parseQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { connectedAcknowledgementSubjectKeyV1, type QualifiedAcknowledgementSubject } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { ConnectedServicesAccountGroupOption } from '@happier-dev/agents';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ConnectedServicesBindingRow } from './ConnectedServicesBindingRow';
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
import {
    areTeamResourceConnectedServiceSelectionsEqual,
    parseConnectedServicesServiceBinding,
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

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
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    teamNameById?: Readonly<Record<string, string>>;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 | null;
    purposeBindingsWritable?: boolean;
    purposeBindingsLoading?: boolean;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    settings: {
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
    };
    setDefaultAuthSettings: (intent: ConnectedAccountPurposeDefaultsIntent) => Promise<unknown>;
    onOpenConnectedServicesSettings: (serviceId: string, anchor?: PopoverAnchor) => void;
    /**
     * Persisted dismissals of the one-time "adopt this autoSwitch pool" suggestion,
     * keyed by the canonical qualified acknowledgement subject. Suppresses the nudge so it does
     * not nag once the user has chosen to keep the literal profile default.
     */
    dismissedPoolAdoptionSuggestionKeys?: Readonly<Record<string, boolean>>;
    onDismissPoolAdoptionSuggestion?: (subject: Extract<QualifiedAcknowledgementSubject, { kind: 'adoption' }>) => Promise<boolean>;
}>;

const EMPTY_SERVICE_BINDINGS: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> = {};

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

    // The Agent default-authentication owner is the one reader; this row only
    // presents its purpose defaults in the Session's service-keyed shape.
    const persistedBindingsByServiceId = React.useMemo<
        Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>
    >(() => (
        props.agentIdentity && props.purposeBindings
            ? projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
                resolveAgentConnectedAccountPurposeDefaults({
                    purposeBindings: props.purposeBindings,
                    consumer: props.agentIdentity,
                    declarations: props.connectedAccountPurposes,
                }),
            )?.bindingsByServiceId ?? EMPTY_SERVICE_BINDINGS
            : EMPTY_SERVICE_BINDINGS
    ), [props.purposeBindings, props.agentIdentity, props.connectedAccountPurposes]);
    const [bindingsByServiceId, setBindingsByServiceId] = React.useState<
        Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>
    >(persistedBindingsByServiceId);

    const [draft, setDraft] = React.useState<typeof bindingsByServiceId | null>(null);
    React.useEffect(() => {
        if (!props.purposeBindings) {
            setDraft(null);
            setBindingsByServiceId(EMPTY_SERVICE_BINDINGS);
            return;
        }
        if (!draft) setBindingsByServiceId(persistedBindingsByServiceId);
    }, [draft, persistedBindingsByServiceId, props.purposeBindings]);

    const bindingsUnavailableLabel = props.purposeBindings && props.purposeBindingsWritable !== false
        ? undefined
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
        <ConnectedServicesBindingRow
            testID={`settings-connected-services-default-auth-${props.agentId}`}
            title={props.agentTitle}
            description={t('connectedServices.defaultAuth.rowDetail')}
            modalTitle={props.agentTitle}
            modalTestID={`settings-connected-services-default-auth-modal-${props.agentId}`}
            supportedServiceIds={supportedServiceIds}
            profileOptionsByServiceId={profileOptionsByServiceId}
            groupOptionsByServiceId={accountGroupOptionsByServiceId}
            bindingsByServiceId={bindingsByServiceId}
            defaultProfileIdByServiceId={props.settings.connectedServicesDefaultProfileByServiceId}
            accountGroupsEnabled={props.accountGroupsEnabled}
            setBindingForService={setBindingForService}
            onOpenSettings={props.onOpenConnectedServicesSettings}
            teamCredentialResources={props.teamCredentialResources}
            teamCredentialDisplayNames={props.teamCredentialDisplayNames}
            teamCredentialResourceStatusByKey={props.teamCredentialResourceStatusByKey}
            teamNameById={props.teamNameById}
            onRecoverTeamCredentialResource={props.onRecoverTeamCredentialResource}
            fallbackLabel={bindingsUnavailableLabel}
            disabled={!props.purposeBindings || props.purposeBindingsWritable === false}
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

const stylesheet = StyleSheet.create((theme) => ({
    suggestion: {
        marginTop: theme.space.s8,
        marginHorizontal: theme.space.s12,
        padding: theme.space.s12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.elevated,
        gap: theme.space.s10,
    },
    suggestionText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    suggestionActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
    suggestionSecondaryButton: {
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        borderRadius: 8,
    },
    suggestionSecondaryLabel: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    suggestionPrimaryButton: {
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent.blue,
    },
    suggestionPrimaryLabel: {
        fontSize: 13,
        color: theme.colors.button.primary.tint,
    },
}));
