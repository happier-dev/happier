import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { TeamCredentialSessionUsePolicyV1 } from '@happier-dev/protocol/teams';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { updateTeamCredentialResource } from '@/sync/ops/teams/teamCredentialOperations';
import {
    useTeamCredentialRequestPolicySupport,
    useTeamCredentialSourceCandidates,
    useTeamCredentialUsageLimits,
} from '@/hooks/teams/useTeamCredentialResources';
import { useProviderSettingsTarget, type ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';
import { useTeamCredentialProviderSourceOffers } from '@/hooks/teams/useTeamCredentialProviderSourceOffers';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import {
    credentialApprovalFailureMessage,
    credentialFailureMessage,
    sessionUsePolicyLabel,
    teamCredentialBrokerPlacementsEqual,
} from './teamCredentialPresentation';
import { useTeamCredentialResourceView } from './useTeamCredentialResourceView';
import {
    EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
    TeamCredentialBrokerPlacementSection,
    confirmTeamCredentialDirectDisclosure,
    confirmTeamCredentialDisclosureWidening,
    narrowTeamCredentialResourceDraftToBrokeredOnly,
    teamCredentialPolicyFromDraft,
    teamCredentialResourceDraftFromSummary,
    teamCredentialUsageLimitDeltaFromDraft,
    useTeamCredentialResourceDraft,
} from './teamCredentialEditorDraft';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { TeamCredentialAudienceEditorSection } from './TeamCredentialAudienceEditorSection';
import { TeamCredentialLimitsEditorSection } from './TeamCredentialLimitsEditorSection';
import {
    projectTeamCredentialRequestPolicyEditorSupport,
    TeamCredentialRequestPolicyEditorSection,
} from './TeamCredentialRequestPolicyEditorSection';
import { TeamCredentialSourcePicker } from './TeamCredentialSourcePicker';

/** The protocol's own closed policy, in the order the plan presents it. */
const USE_POLICIES: readonly TeamCredentialSessionUsePolicyV1[] = Object.freeze([
    'personal_allowed',
    'team_context_required',
    'team_visibility_required',
]);

const NAME_MAX_LENGTH = 120;
const NO_PROVIDER_MACHINES: readonly ProviderSettingsMachineRowV1[] = Object.freeze([]);


/**
 * The one editor for a shared credential's own settings.
 *
 * It is a progressive form rather than a wizard: there is one draft, one save,
 * and every field is a field of the resource rather than a step. Save submits
 * one complete replacement fenced on the revision the draft was started from.
 * The source custodian can replace the exact custodian block; masked Team
 * managers omit it so private source identity is preserved by its owner.
 */
const CredentialEditor = React.memo(function CredentialEditor(props: Readonly<{
    context: TeamSectionContext;
    resourceId: string;
    section?: 'access' | 'request_policy' | 'limits';
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const { context, resourceId } = props;
    const view = useTeamCredentialResourceView({ context, resourceId });
    const resource = view.resource;
    const providerTarget = useProviderSettingsTarget();
    const providerMachines = providerTarget.selectedTargetServerMatchesActiveAccount
        && providerTarget.serverId === context.scope.serverId
        ? providerTarget.machineRows
        : NO_PROVIDER_MACHINES;
    const providerSources = useTeamCredentialProviderSourceOffers({
        enabled: resource?.source != null,
        machines: providerMachines,
    });
    const sourceCandidates = useTeamCredentialSourceCandidates({
        scope: context.scope,
        address: context.address,
        enabled: resource?.source != null,
        providerSourceOffers: providerSources.offers,
    });

    /**
     * The revision the draft was started from. A background refresh must not
     * silently re-fence the save on a newer revision: the point of the fence is
     * that a save which would overwrite somebody else's change is refused.
     */
    const [basis, setBasis] = React.useState<number | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    const targetKey = `${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}:${resourceId}`;
    const resourceDraft = useTeamCredentialResourceDraft({ targetKey });
    const {
        name,
        source,
        disclosureCeiling: ceiling,
        sessionUsePolicy: usePolicy,
        brokerPlacement,
        audience,
        requestPolicy: policyDraft,
        limits: limitDrafts,
    } = resourceDraft.draft;
    const patchResourceDraft = React.useCallback((patch: Partial<typeof resourceDraft.draft>, _legacyResetsConsent = false) => {
        const update = (current: typeof resourceDraft.draft) => ({ ...current, ...patch });
        resourceDraft.setDraft(update);
    }, [resourceDraft]);
    const limits = useTeamCredentialUsageLimits({
        scope: context.scope,
        resourceId,
        resourceRevision: resource?.revision ?? null,
        enabled: view.featureEnabled
            && resource?.capabilities.manageLimits === true,
    });
    /**
     * Whether the draft still points at the saved source and location.
     *
     * One answer, consumed by the model-policy catalog request and by the
     * custodian save payload. They used to disagree: the save submitted the
     * draft source while the catalog always asked about the saved resource, so
     * a replacement was configured against the source it replaced.
     */
    const custodianSourceDraftChanged = source !== null && (
        JSON.stringify(source) !== JSON.stringify(resourceDraft.baseline.source)
        || !teamCredentialBrokerPlacementsEqual(brokerPlacement, resourceDraft.baseline.brokerPlacement)
    );
    const requestPolicySupport = useTeamCredentialRequestPolicySupport({
        scope: context.scope,
        input: resource === null
            ? null
            : custodianSourceDraftChanged && source !== null
                ? {
                    scope: 'source_draft',
                    teamId: context.address.teamId,
                    source,
                    brokerPlacement,
                }
                : { scope: 'resource', resourceId },
        enabled: view.featureEnabled && resource?.capabilities.managePolicy === true,
    });
    const currentTargetKey = React.useRef(targetKey);
    currentTargetKey.current = targetKey;

    React.useEffect(() => {
        setBasis(null);
        resourceDraft.reset(EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT);
        setSaving(false);
        setNotice(null);
    }, [targetKey]);

    // The Home's answer seeds the draft once. Re-seeding on every refresh would
    // reset the fields under someone who is typing in them.
    React.useEffect(() => {
        if (!resource || basis !== null) return;
        if (resource.capabilities.manageLimits && limits.status !== 'ready') return;
        resourceDraft.reset(teamCredentialResourceDraftFromSummary(resource, limits.rows));
        setBasis(resource.revision);
    }, [resource, basis, limits.rows, limits.status]);

    const trimmed = name.trim();
    const nameValid = trimmed.length > 0 && trimmed.length <= NAME_MAX_LENGTH;
    const isDirty = resource !== null && basis !== null && resourceDraft.isDirty;
    const draftChanged = isDirty;
    const discardDraft = React.useCallback(() => {
        if (resource === null) return;
        resourceDraft.reset(teamCredentialResourceDraftFromSummary(resource, limits.rows));
        setNotice(null);
    }, [limits.rows, resource, resourceDraft]);
    const { allowSavedNavigation } = useUnsavedDraftNavigationGuard({
        navigation,
        isDirty,
        onDiscard: discardDraft,
        tag: 'TeamCredentialEditScreen.beforeRemove',
    });

    if (!view.featureEnabled || (view.resolved && resource === null)) {
        return (
            <ItemGroup description={view.featureEnabled
                ? t('teams.credentials.detail.notFound')
                : t('teams.credentials.unavailable')}>
                <Item
                    testID="team-credential-edit-unavailable"
                    title={t('teams.errors.notFound')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (resource === null || basis === null) {
        if (resource !== null && resource.capabilities.manageLimits && limits.status === 'error') {
            return (
                <ItemGroup description={limits.error ? credentialFailureMessage(limits.error) : undefined}>
                    <Item
                        testID="team-credential-edit-limits-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void limits.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        if (view.error) {
            return (
                <ItemGroup description={credentialFailureMessage(view.error)}>
                    <Item
                        testID="team-credential-edit-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item
                    testID="team-credential-edit-loading"
                    title={t('teams.credentials.edit.title')}
                    loading
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const canEdit = resource.capabilities.managePolicy
        || resource.capabilities.manageAudience
        || resource.capabilities.manageLimits
        || resource.capabilities.updateBrokerPlacement
        || resource.capabilities.narrowDisclosure;
    if (!canEdit || !context.mutationsAvailable || context.archived) {
        return (
            <ItemGroup description={t('teams.credentials.forbidden')}>
                <Item
                    testID="team-credential-edit-forbidden"
                    title={t('teams.denied.title')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    // An unresolved approval already carries this draft. Keep the editor and
    // its unsaved values, disabled, rather than letting a second save race it.
    const busy = saving || view.writesSuspended;
    const movedUnderEditor = resource.revision !== basis;
    const sourceCustodian = resource.custodianAccountId === context.scope.accountId && resource.source !== null;
    // The picker names the source this editor would actually save. Matching
    // this resource's own offered candidate first made the display
    // order-dependent: a newly chosen candidate ranked after it kept showing the
    // saved source while Save submitted the new one. The own offer is only the
    // fallback for an untouched draft whose saved source is not itself listed.
    const draftSourceIdentity = JSON.stringify(source);
    const selectedSourceCandidate = sourceCandidates.candidates.find(
        (candidate) => JSON.stringify(candidate.candidate.source) === draftSourceIdentity,
    ) ?? (draftSourceIdentity === JSON.stringify(resourceDraft.baseline.source)
        ? sourceCandidates.candidates.find(
            (candidate) => candidate.candidate.offeredByResourceId === resourceId,
        ) ?? null
        : null);
    const requestPolicy = teamCredentialPolicyFromDraft(policyDraft);
    const requestPolicyChanged = JSON.stringify(policyDraft)
        !== JSON.stringify(resourceDraft.baseline.requestPolicy);
    const requestPolicyEditorProjection = requestPolicySupport.status === 'ready'
        && requestPolicySupport.result?.status === 'available'
        ? projectTeamCredentialRequestPolicyEditorSupport({
            models: requestPolicySupport.result.models,
            draft: policyDraft,
        })
        : null;
    const requestPolicyChangeSupported = !requestPolicyChanged
        || requestPolicy === null
        || (requestPolicySupport.status === 'ready'
            && requestPolicySupport.result?.status === 'available'
            && requestPolicyEditorProjection?.storedPolicyUnsupported === false);
    const usageLimitDelta = teamCredentialUsageLimitDeltaFromDraft(limitDrafts, resourceDraft.baseline.limits);
    const managerFieldsValid = !resource.capabilities.managePolicy
        || (nameValid && requestPolicyChangeSupported);
    const limitsValid = !resource.capabilities.manageLimits || usageLimitDelta !== 'invalid';
    const changed = draftChanged
        && managerFieldsValid
        && limitsValid
        && (resourceDraft.directDisclosureFingerprint === null || resourceDraft.directDisclosureAccepted);
    const custodianFieldsChanged = sourceCustodian && source !== null && (
        custodianSourceDraftChanged
        || ceiling !== resourceDraft.baseline.disclosureCeiling
    );

    return (
        <>
            {props.section === undefined && resource.capabilities.managePolicy ? <ItemGroup title={t('teams.credentials.edit.nameLabel')}>
                <Item title={t('teams.credentials.edit.nameLabel')} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="team-credential-edit-name" value={name} onChangeText={(value) => patchResourceDraft({ name: value })} placeholder={t('teams.credentials.edit.namePlaceholder')} accessibilityLabel={t('teams.credentials.edit.nameLabel')} maxLength={NAME_MAX_LENGTH} editable={!busy} />} />
            </ItemGroup> : null}

            {props.section === undefined && sourceCustodian ? (
                <ItemGroup
                    title={t('teams.credentials.detail.sourceLabel')}
                    description={sourceCandidates.error ? credentialFailureMessage(sourceCandidates.error) : undefined}
                >
                    <TeamCredentialSourcePicker
                        candidates={sourceCandidates.candidates}
                        // Choosing a replacement must be reversible: this
                        // resource's own offer is the source the editor started
                        // from, so it stays pickable while other resources'
                        // offers remain taken.
                        reselectableResourceId={resourceId}
                        selected={selectedSourceCandidate}
                        disabled={busy || sourceCandidates.status === 'loading'}
                        unavailableReason={sourceCandidates.status === 'error' && sourceCandidates.candidates.length === 0
                            ? t('common.unavailable')
                            : null}
                        onSelect={(candidate) => {
                            const nextDraft = { ...resourceDraft.draft, source: candidate.candidate.source };
                            void (async () => {
                                if (!resourceDraft.isDirectDisclosureAcceptedForDraft(nextDraft)
                                    && !await confirmTeamCredentialDirectDisclosure()) return;
                                resourceDraft.setDraft(nextDraft);
                                resourceDraft.acceptDirectDisclosureForDraft(nextDraft);
                                setNotice(null);
                            })();
                        }}
                    />
                    {sourceCandidates.error ? <Item
                        testID="team-credential-edit-source-retry"
                        title={t('common.retry')}
                        disabled={busy || sourceCandidates.status === 'loading'}
                        onPress={() => { void sourceCandidates.reload(); }}
                        showChevron={false}
                    /> : null}
                </ItemGroup>
            ) : null}

            {props.section === undefined && resource.source !== null && resource.capabilities.updateBrokerPlacement ? (
                <TeamCredentialBrokerPlacementSection
                    scope={context.scope}
                    testIDPrefix="team-credential-edit-broker"
                    brokerPresentation={resource.brokerPresentation}
                    savedPlacement={resource.brokerPlacement}
                    placement={brokerPlacement}
                    disabled={busy}
                    onChange={(next) => patchResourceDraft({ brokerPlacement: next }, true)}
                />
            ) : null}

            {props.section === undefined && resource.capabilities.managePolicy ? <ItemGroup
                title={t('teams.credentials.usePolicy.label')}
                description={usePolicy === 'team_visibility_required'
                    ? t('teams.credentials.usePolicy.visibilityNote')
                    : undefined}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('teams.credentials.usePolicy.label')}
            >
                {USE_POLICIES.map((policy) => (
                    <Item
                        key={policy}
                        testID={`team-credential-edit-use-policy:${policy}`}
                        title={sessionUsePolicyLabel(policy)}
                        selected={usePolicy === policy}
                        disabled={busy}
                        onPress={() => patchResourceDraft({ sessionUsePolicy: policy })}
                        showChevron={false}
                    />
                ))}
            </ItemGroup> : null}

            {/* The custodian's own ceiling is a two-option decision whenever the
                Home says they may move it. Narrowing withdraws only the direct
                half of each grant, by the one rule the Home applies; widening
                is confirmed before it is drafted. */}
            {props.section === undefined && (resource.capabilities.narrowDisclosure || resource.capabilities.widenDisclosure) ? <ItemGroup
                title={t('teams.credentials.edit.ceilingLabel')}
                description={t('teams.credentials.edit.ceilingNote')}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('teams.credentials.edit.ceilingLabel')}
            >
                <Item
                    testID="team-credential-edit-ceiling:brokered_only"
                    title={t('teams.credentials.edit.ceilingBrokeredOnly')}
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={ceiling === 'brokered_only'}
                    disabled={busy || !resource.capabilities.narrowDisclosure}
                    onPress={() => resourceDraft.setDraft(narrowTeamCredentialResourceDraftToBrokeredOnly)}
                    showChevron={false}
                />
                <Item
                    testID="team-credential-edit-ceiling:direct_allowed"
                    title={t('teams.credentials.edit.ceilingDirectAllowed')}
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={ceiling === 'direct_allowed'}
                    disabled={busy || !resource.capabilities.widenDisclosure}
                    onPress={() => {
                        if (ceiling === 'direct_allowed') return;
                        void (async () => {
                            if (!await confirmTeamCredentialDisclosureWidening()) return;
                            patchResourceDraft({ disclosureCeiling: 'direct_allowed' });
                        })();
                    }}
                    showChevron={false}
                />
            </ItemGroup> : null}

            {(props.section === undefined || props.section === 'access') && resource.capabilities.manageAudience ? (
                <TeamCredentialAudienceEditorSection
                    context={context}
                    resource={resource}
                    draft={resourceDraft.draft}
                    busy={busy}
                    onRequestDraftChange={(nextDraft) => {
                        if (resourceDraft.isDirectDisclosureAcceptedForDraft(nextDraft)) {
                            resourceDraft.setDraft(nextDraft);
                            return;
                        }
                        void (async () => {
                            if (!await confirmTeamCredentialDirectDisclosure()) return;
                            resourceDraft.setDraft(nextDraft);
                            resourceDraft.acceptDirectDisclosureForDraft(nextDraft);
                        })();
                    }}
                />
            ) : null}

            {(props.section === undefined || props.section === 'request_policy') && resource.capabilities.managePolicy ? (
                <>
                    <TeamCredentialRequestPolicyEditorSection
                        draft={policyDraft}
                        setDraft={(next) => resourceDraft.setDraft((draft) => ({
                            ...draft,
                            requestPolicy: typeof next === 'function' ? next(draft.requestPolicy) : next,
                        }))}
                        support={requestPolicySupport.status === 'ready' && requestPolicySupport.result
                            ? requestPolicySupport.result
                            : { status: 'unavailable', reason: 'model_catalog_unavailable' }}
                        busy={busy}
                    />
                    {requestPolicySupport.status !== 'ready' ? <ItemGroup description={requestPolicySupport.error
                        ? credentialFailureMessage(requestPolicySupport.error)
                        : undefined}>
                    <Item
                        testID={requestPolicySupport.status === 'error'
                            ? 'team-credential-request-policy-support-retry'
                            : 'team-credential-request-policy-support-loading'}
                        title={requestPolicySupport.status === 'error'
                            ? t('teams.unavailable.retry')
                            : t('common.loading')}
                        loading={requestPolicySupport.status === 'loading'}
                        disabled={busy}
                        onPress={requestPolicySupport.status === 'error'
                            ? () => void requestPolicySupport.reload()
                            : undefined}
                        showChevron={false}
                    />
                    </ItemGroup> : null}
                </>
            ) : null}

            {(props.section === undefined || props.section === 'limits') && resource.capabilities.manageLimits ? (
                <TeamCredentialLimitsEditorSection
                    context={context}
                    resource={resource}
                    usageCapabilities={resource.usageCapabilities}
                    draft={resourceDraft.draft}
                    busy={busy}
                    onRequestDraftChange={resourceDraft.setDraft}
                />
            ) : null}

            {/*
              * The save's own outcome belongs to the save, not to a field group
              * a focused route never renders: `notice` used to hang off the name
              * group, which only exists on the full editor for a policy manager,
              * so every refusal of a Focused Access, Request-policy or Limits
              * save was written and never shown.
              */}
            <ItemGroup description={notice ?? (movedUnderEditor
                ? t('teams.credentials.edit.conflict')
                : view.writesSuspended ? t('teams.credentials.approvalPending') : undefined)}>
                <Item
                    testID="team-credential-edit-save"
                    title={t('common.save')}
                    loading={busy}
                    disabled={!changed || busy || movedUnderEditor}
                    onPress={async () => {
                        // The revision fence is a correctness rule, not a
                        // disabled style: a press that arrives from a stale
                        // render must not submit a save that would overwrite
                        // whoever moved the resource.
                        if (!changed || busy || movedUnderEditor) return;
                        const requestedTargetKey = targetKey;
                        setSaving(true);
                        setNotice(null);
                        try {
                            const outcome = await updateTeamCredentialResource({
                                scope: context.scope,
                                address: context.address,
                                resourceId,
                                expectedRevision: basis,
                                replacement: {
                                    enabled: resource.enabled,
                                    displayName: resource.capabilities.managePolicy ? trimmed : resource.displayName,
                                    sessionUsePolicy: resource.capabilities.managePolicy ? usePolicy : resource.sessionUsePolicy,
                                    requestPolicy: resource.capabilities.managePolicy
                                        ? requestPolicy
                                        : resource.requestPolicy,
                                    allMembersDeliveryMode: resource.capabilities.manageAudience
                                        ? audience.allMembers
                                        : resource.allMembersDeliveryMode,
                                    groupGrants: resource.capabilities.manageAudience
                                        ? [...audience.groups].map(([teamGroupId, deliveryMode]) => ({ teamGroupId, deliveryMode }))
                                        : resource.groupGrants,
                                    memberGrants: resource.capabilities.manageAudience
                                        ? [...audience.members].map(([teamMembershipId, deliveryMode]) => ({ teamMembershipId, deliveryMode }))
                                        : resource.memberGrants,
                                    ...(custodianFieldsChanged && source !== null ? {
                                        custodian: {
                                            source,
                                            disclosureCeiling: ceiling,
                                            brokerPlacement,
                                        },
                                    } : {}),
                                    usageLimitDelta: resource.capabilities.manageLimits && usageLimitDelta !== 'invalid'
                                        ? usageLimitDelta
                                        : { upserts: [], deleteIds: [] },
                                },
                                handlers: {
                                    // The approved save already committed on the
                                    // Home, so this editor returns exactly as it
                                    // would have without an approval.
                                    onApprovalSucceeded: () => {
                                        if (currentTargetKey.current !== requestedTargetKey) return;
                                        allowSavedNavigation();
                                        router.back();
                                    },
                                    onApprovalFailed: (code) => {
                                        if (currentTargetKey.current !== requestedTargetKey) return;
                                        setNotice(credentialApprovalFailureMessage(code));
                                    },
                                },
                            });
                            if (currentTargetKey.current !== requestedTargetKey) return;
                            if (outcome.kind === 'succeeded') {
                                allowSavedNavigation();
                                router.back();
                                return;
                            }
                            // The Home named this refusal; the screen shows
                            // the recovery that refusal actually implies.
                            setNotice(credentialFailureMessage(outcome.failure));
                        } catch (cause) {
                            if (currentTargetKey.current !== requestedTargetKey) return;
                            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                            else setNotice(t('teams.errors.generic'));
                        } finally {
                            if (currentTargetKey.current === requestedTargetKey) setSaving(false);
                        }
                    }}
                    showChevron={false}
                />
                {movedUnderEditor ? (
                    <Item
                        testID="team-credential-edit-reload"
                        title={t('teams.unavailable.retry')}
                        disabled={busy}
                        onPress={() => {
                            // Adopting the Home's current values is an explicit
                            // choice, never something a refresh does silently.
                            resourceDraft.reset(teamCredentialResourceDraftFromSummary(resource, limits.rows));
                            setBasis(resource.revision);
                            setNotice(null);
                        }}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>

            {view.error ? (
                <ItemGroup description={credentialFailureMessage(view.error)}>
                    <Item
                        testID="team-credential-edit-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

export const TeamCredentialEditScreen = React.memo(function TeamCredentialEditScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    resourceId: string;
    /** Focused entrypoints mount this same complete editor; no field owns a second save. */
    section?: 'access' | 'request_policy' | 'limits';
}>) {
    const title = props.section === 'access'
        ? t('teams.credentials.audience.title')
        : props.section === 'request_policy'
            ? t('teams.credentials.requestPolicy.title')
            : props.section === 'limits'
                ? t('teams.credentials.limits.title')
                : t('teams.credentials.edit.title');
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={title} description={t('teams.pages.credentialEdit')}>
            {(context) => <CredentialEditor context={context} resourceId={props.resourceId} section={props.section} />}
        </TeamSection>
    );
});
