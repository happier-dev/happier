import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { TeamCredentialDeliveryModeV1, TeamCredentialSessionUsePolicyV1, TeamCredentialUsageLimitDefinitionV1 } from '@happier-dev/protocol/teams';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    useTeamCredentialRequestPolicySupport,
    useTeamCredentialResources,
    useTeamCredentialSourceCandidates,
} from '@/hooks/teams/useTeamCredentialResources';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useMachineAdministrationTargetPickerRows } from '@/sync/domains/machines/administration/useTargetSelection';
import { useProviderSettingsTarget, type ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';
import { useTeamCredentialProviderSourceOffers } from '@/hooks/teams/useTeamCredentialProviderSourceOffers';
import { isTeamCredentialProviderSourceOfferCurrent, type TeamCredentialSourceCandidatePresentationV1 } from '@/hooks/teams/composeTeamCredentialProviderSourceOffer';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { createTeamCredentialResource } from '@/sync/ops/teams/teamCredentialOperations';
import { getPreferredLanguage, t } from '@/text';
import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamCredentialDetailPath } from '../teamsRoutes';
import { credentialApprovalFailureMessage, credentialFailureMessage, deliveryModeLabel, limitMetricLabel, limitPeriodLabel, limitSubjectKindLabel, requestProtocolKindLabel, sessionUsePolicyLabel, sourceKindLabel } from './teamCredentialPresentation';
import { TeamCredentialAudiencePicker } from './TeamCredentialAudiencePicker';
import { TeamCredentialSourcePicker } from './TeamCredentialSourcePicker';
import { confirmTeamCredentialDirectDisclosure, confirmTeamCredentialDisclosureWidening, EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT, EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT, narrowTeamCredentialResourceDraftToBrokeredOnly, offeredDeliveryModes, reconcileTeamCredentialPolicyDraftForModelCatalog, TEAM_CREDENTIAL_LIMIT_PERIODS, TEAM_CREDENTIAL_LIMIT_SUBJECT_KINDS, TeamCredentialBrokerPlacementSection, teamCredentialBrokerPlacementDraftLabel, TeamCredentialDeliveryModeChooser, teamCredentialLimitMaximumValid, teamCredentialLimitSubjectSelected, teamCredentialPolicyFromDraft, teamCredentialResourceDraftFingerprint, useTeamCredentialResourceDraft, withAudienceEntry, type TeamCredentialResourceDraft } from './teamCredentialEditorDraft';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import {
    projectTeamCredentialRequestPolicyEditorSupport,
    TeamCredentialRequestPolicyEditorSection,
} from './TeamCredentialRequestPolicyEditorSection';

const NAME_MAX_LENGTH = 120;
const USE_POLICIES: readonly TeamCredentialSessionUsePolicyV1[] = ['personal_allowed', 'team_context_required', 'team_visibility_required'];
const NO_PROVIDER_MACHINES: readonly ProviderSettingsMachineRowV1[] = Object.freeze([]);

type TeamCredentialCreateSourceHint = Readonly<
    { kind: 'connected_account'; pluginId: string; localId: string; accountId: string }
    | { kind: 'connected_pool'; pluginId: string; localId: string; groupId: string }
    | { kind: 'provider_connection'; machineId: string; connectionId: string; credentialSlotId: string; connectionSecurityFingerprint: string }
>;

const CredentialCreator = React.memo(function CredentialCreator(props: Readonly<{ context: TeamSectionContext; sourceHint?: TeamCredentialCreateSourceHint }>) {
    const router = useRouter();
    const navigation = useNavigation();
    const locale = getPreferredLanguage();
    const { context } = props;
    const featureEnabled = useFeatureEnabled('teams.credentialResources', { scopeKind: 'spawn', serverId: context.scope.serverId });
    const projection = useTeamCredentialResources({ scope: context.scope, address: context.address, enabled: featureEnabled });
    const mayOffer = projection.viewer?.offerOwnCredential === true;
    const managesResources = projection.viewer?.manageCredentials === true;
    const providerTarget = useProviderSettingsTarget();
    const machineAdministrationRows = useMachineAdministrationTargetPickerRows();
    // Every computer this Account administers under the selected server
    // identity, not only the one Provider Settings is pointed at: a connection
    // whose credential lives elsewhere is still this creator's to offer, and
    // changing a global preference is not part of this flow.
    const providerMachines = providerTarget.selectedTargetServerMatchesActiveAccount
        && providerTarget.serverId === context.scope.serverId
        ? providerTarget.machineRows
        : NO_PROVIDER_MACHINES;
    const providerConnections = useTeamCredentialProviderSourceOffers({
        enabled: featureEnabled && mayOffer,
        machines: providerMachines,
    });
    const providerSourceOffers = providerConnections.offers;
    const sources = useTeamCredentialSourceCandidates({ scope: context.scope, address: context.address, enabled: featureEnabled && mayOffer, providerSourceOffers });
    const [candidateId, setCandidateId] = React.useState<string | null>(null);
    const [nameEdited, setNameEdited] = React.useState(false);
    const [expanded, setExpanded] = React.useState<string | null>(null);
    // The chooser pages the directory independently of this editor, so a person
    // added from a later page would otherwise lose their name the moment they
    // were chosen.
    const [pickedNames, setPickedNames] = React.useState<ReadonlyMap<string, string>>(() => new Map());
    const [limitSubjectName, setLimitSubjectName] = React.useState<string | null>(null);
    const [limitSubjectMembershipId, setLimitSubjectMembershipId] = React.useState<string | null>(null);
    const [submitting, setSubmitting] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    const targetKey = `${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}`;
    const resourceDraft = useTeamCredentialResourceDraft({ targetKey });
    const {
        name,
        disclosureCeiling: ceiling,
        brokerPlacement: placement,
        sessionUsePolicy: usePolicy,
        audience: { allMembers, groups: groupGrants, members: memberGrants },
        requestPolicy: policyDraft,
        pendingLimit: limitDraft,
    } = resourceDraft.draft;
    const savedLimits = resourceDraft.draft.limits;
    const patchResourceDraft = React.useCallback((patch: Partial<typeof resourceDraft.draft>, _legacyResetsConsent = false) => {
        const update = (current: typeof resourceDraft.draft) => ({ ...current, ...patch });
        resourceDraft.setDraft(update);
    }, [resourceDraft]);
    const setGroupGrants = React.useCallback((next: React.SetStateAction<ReadonlyMap<string, TeamCredentialDeliveryModeV1>>) => {
        resourceDraft.setDraft((current) => ({
            ...current,
            audience: {
                ...current.audience,
                groups: typeof next === 'function' ? next(current.audience.groups) : next,
            },
        }));
    }, [resourceDraft]);
    const setMemberGrants = React.useCallback((next: React.SetStateAction<ReadonlyMap<string, TeamCredentialDeliveryModeV1>>) => {
        resourceDraft.setDraft((current) => ({
            ...current,
            audience: {
                ...current.audience,
                members: typeof next === 'function' ? next(current.audience.members) : next,
            },
        }));
    }, [resourceDraft]);
    const setPolicyDraft = React.useCallback((next: React.SetStateAction<typeof policyDraft>) => {
        resourceDraft.setDraft((current) => ({
            ...current,
            requestPolicy: typeof next === 'function' ? next(current.requestPolicy) : next,
        }));
    }, [resourceDraft]);
    const setLimitDraft = React.useCallback((next: React.SetStateAction<typeof limitDraft>) => {
        resourceDraft.setDraft((current) => ({
            ...current,
            pendingLimit: typeof next === 'function' ? next(current.pendingLimit) : next,
        }));
    }, [resourceDraft]);
    const setSavedLimits = React.useCallback((next: React.SetStateAction<readonly TeamCredentialUsageLimitDefinitionV1[]>) => {
        resourceDraft.setDraft((current) => ({
            ...current,
            limits: typeof next === 'function' ? next(current.limits) : next,
        }));
    }, [resourceDraft]);
    const currentTargetKey = React.useRef(targetKey); currentTargetKey.current = targetKey;
    const requestId = React.useRef(randomUUID());
    const attemptedSourceHintId = React.useRef<string | null>(null);
    const selected = React.useMemo(() => sources.candidates.find(candidate => candidate.selectionId === candidateId) ?? null, [candidateId, sources.candidates]);
    const selectedSource = selected?.candidate.source ?? null;
    // The catalog is read from a computer that actually offers this exact
    // source, so a connection reachable only elsewhere still resolves its
    // models instead of reporting an empty catalog.
    const selectedProviderOffer = selected?.providerSourceOffer ?? null;
    const requestPolicySupport = useTeamCredentialRequestPolicySupport({
        scope: context.scope,
        input: selectedSource === null ? null : {
            scope: 'source_draft',
            teamId: context.address.teamId,
            source: selectedSource,
            brokerPlacement: placement,
        },
        enabled: featureEnabled && managesResources && selectedSource !== null,
    });
    const requestPolicySupportResult = requestPolicySupport.status === 'ready'
        ? requestPolicySupport.result
        : null;
    const requestPolicyEditorProjection = requestPolicySupportResult?.status === 'available'
        ? projectTeamCredentialRequestPolicyEditorSupport({
            models: requestPolicySupportResult.models,
            draft: policyDraft,
        })
        : null;
    const providerPolicyReconciliation = reconcileTeamCredentialPolicyDraftForModelCatalog(
        policyDraft,
        requestPolicySupportResult?.status === 'available'
            ? requestPolicySupportResult.models.map((model) => model.descriptor.id)
            : null,
    );
    const reconciledProviderCatalogKey = React.useRef<string | null>(null);

    React.useEffect(() => {
        setCandidateId(null); resourceDraft.reset(EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT); setNameEdited(false);
        setLimitSubjectName(null); setLimitSubjectMembershipId(null); setSubmitting(false); setNotice(null); setPickedNames(new Map()); requestId.current = randomUUID();
        attemptedSourceHintId.current = null;
    }, [targetKey]);
    React.useEffect(() => {
        currentTargetKey.current = targetKey;
        return () => { if (currentTargetKey.current === targetKey) currentTargetKey.current = ''; };
    }, [targetKey]);
    const retryPayloadKey = teamCredentialResourceDraftFingerprint(resourceDraft.draft);
    React.useEffect(() => { requestId.current = randomUUID(); }, [retryPayloadKey]);
    React.useEffect(() => {
        if (requestPolicySupportResult?.status !== 'available') return;
        const catalogKey = JSON.stringify(requestPolicySupportResult.models.map((model) => [
            model.descriptor.id,
            model.sourceRevision,
            model.application,
        ]));
        if (reconciledProviderCatalogKey.current === catalogKey) return;
        reconciledProviderCatalogKey.current = catalogKey;
        const reconciliation = providerPolicyReconciliation;
        if (reconciliation.invalidatedModelIds.length === 0) return;
        void Modal.confirm(
            t('teams.credentials.requestPolicy.title'),
            `${t('settingsProviders.models.removeConfirmation')} ${reconciliation.invalidatedModelIds.join(' · ')}`,
            {
                confirmText: t('common.continue'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        ).then((confirmed) => {
            if (confirmed) setPolicyDraft(reconciliation.draft);
        });
    }, [locale, providerPolicyReconciliation, requestPolicySupportResult]);
    const chooseSource = React.useCallback(async (candidate: TeamCredentialSourceCandidatePresentationV1) => {
        const nextDraft = {
            ...resourceDraft.draft,
            source: candidate.candidate.source,
            ...(!nameEdited ? { name: candidate.candidate.label } : {}),
        };
        if (!resourceDraft.isDirectDisclosureAcceptedForDraft(nextDraft)
            && !await confirmTeamCredentialDirectDisclosure()) return;
        setCandidateId(candidate.selectionId);
        setNotice(null);
        resourceDraft.setDraft(nextDraft);
        resourceDraft.acceptDirectDisclosureForDraft(nextDraft);
    }, [nameEdited, resourceDraft]);
    React.useEffect(() => {
        if (candidateId !== null || sources.status !== 'ready' || !props.sourceHint) return;
        const hinted = sources.candidates.find((row) => {
            const candidate = row.candidate;
            if (candidate.offeredByResourceId !== null || candidate.source.kind !== props.sourceHint?.kind) return false;
            if (candidate.source.kind === 'connected_account' && props.sourceHint.kind === 'connected_account') {
                return candidate.source.target.account.service.pluginId === props.sourceHint.pluginId
                    && candidate.source.target.account.service.localId === props.sourceHint.localId
                    && candidate.source.target.account.accountId === props.sourceHint.accountId;
            }
            if (candidate.source.kind === 'provider_connection' && props.sourceHint.kind === 'provider_connection') {
                const offer = row.providerSourceOffer;
                return offer !== null
                    && offer.serverId === context.scope.serverId
                    && offer.machineId === props.sourceHint.machineId
                    && offer.connectionId === props.sourceHint.connectionId
                    && offer.credentialSlotId === props.sourceHint.credentialSlotId
                    && offer.connectionSecurityFingerprint === props.sourceHint.connectionSecurityFingerprint;
            }
            return candidate.source.kind === 'connected_pool' && props.sourceHint.kind === 'connected_pool'
                && candidate.source.target.service.pluginId === props.sourceHint.pluginId
                && candidate.source.target.service.localId === props.sourceHint.localId
                && candidate.source.target.groupId === props.sourceHint.groupId;
        });
        if (!hinted || attemptedSourceHintId.current === hinted.selectionId) return;
        attemptedSourceHintId.current = hinted.selectionId;
        void chooseSource(hinted);
    }, [candidateId, chooseSource, context.scope.serverId, props.sourceHint, sources.candidates, sources.status]);
    const discardDraft = React.useCallback(() => {
        resourceDraft.reset(EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT);
        setCandidateId(null); setNameEdited(false); setPickedNames(new Map());
        setExpanded(null); setNotice(null);
    }, [resourceDraft]);
    const { allowSavedNavigation } = useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: resourceDraft.isDirty,
        onDiscard: discardDraft,
        tag: 'TeamCredentialCreateScreen.beforeRemove',
    });
    const busy = submitting || context.approvalPending;
    if (!featureEnabled) return <ItemGroup description={t('teams.credentials.unavailable')}><Item testID="team-credential-create-unavailable" title={t('teams.credentials.create.title')} showChevron={false} /></ItemGroup>;
    // A first credential read that failed is not "still loading": the viewer is
    // null for both, and the source and provider retries further down are
    // unreachable behind this return, so the screen used to spin forever.
    if (projection.viewer === null && projection.error !== null) return <ItemGroup description={credentialFailureMessage(projection.error)}><Item testID="team-credential-create-retry" title={t('teams.unavailable.retry')} onPress={() => void projection.retry()} showChevron={false} /></ItemGroup>;
    if (projection.viewer === null) return <ItemGroup><Item testID="team-credential-create-loading" title={t('teams.credentials.create.title')} loading showChevron={false} /></ItemGroup>;
    if (!mayOffer || (!context.canMutate && !context.approvalPending)) return <ItemGroup description={t('teams.credentials.create.notAllowed')}><Item testID="team-credential-create-forbidden" title={t('teams.denied.title')} showChevron={false} /></ItemGroup>;
    const directExportSupported = selected?.candidate.directExportSupport !== 'unsupported';
    const modes = offeredDeliveryModes({
        disclosureCeiling: directExportSupported ? ceiling : 'brokered_only',
    });
    const chooseMode = async (
        mode: TeamCredentialDeliveryModeV1 | null,
        update: (draft: TeamCredentialResourceDraft, mode: TeamCredentialDeliveryModeV1 | null) => TeamCredentialResourceDraft,
    ) => {
        const nextDraft = update(resourceDraft.draft, mode);
        if (mode !== null && mode !== 'brokered'
            && !resourceDraft.isDirectDisclosureAcceptedForDraft(nextDraft)
            && !await confirmTeamCredentialDirectDisclosure()) return;
        resourceDraft.setDraft(nextDraft);
        if (mode !== null && mode !== 'brokered') resourceDraft.acceptDirectDisclosureForDraft(nextDraft);
        setExpanded(null);
    };
    const chooser = (
        key: string,
        title: string,
        mode: TeamCredentialDeliveryModeV1 | null,
        update: (draft: TeamCredentialResourceDraft, next: TeamCredentialDeliveryModeV1 | null) => TeamCredentialResourceDraft,
    ) => expanded === key ? <TeamCredentialDeliveryModeChooser principalKey={key} principalName={title} modes={modes} current={mode} disabled={busy} onChoose={next => void chooseMode(next, update)} /> : null;
    const requestPolicy = managesResources ? teamCredentialPolicyFromDraft(policyDraft) : null;
    const hasLimit = limitDraft.maximum.trim() !== '';
    const pendingLimit: TeamCredentialUsageLimitDefinitionV1 | null = hasLimit && teamCredentialLimitMaximumValid(limitDraft) && teamCredentialLimitSubjectSelected(limitDraft) ? { ...limitDraft, maximum: limitDraft.maximum.trim(), enabled: true } : null;
    const limitIdentity = (limit: TeamCredentialUsageLimitDefinitionV1) => JSON.stringify([
        limit.subjectKind, limit.subjectId, limit.period, limit.metric,
    ]);
    const grants = [allMembers, ...groupGrants.values(), ...memberGrants.values()].filter((mode): mode is TeamCredentialDeliveryModeV1 => mode !== null);
    const needsBroker = managesResources && grants.some(mode => mode !== 'direct');
    const usageLimits = needsBroker ? [...savedLimits, ...(pendingLimit ? [pendingLimit] : [])] : [];
    const uniqueLimits = new Set(usageLimits.map(limitIdentity)).size === usageLimits.length;
    const ready = selected !== null && name.trim().length > 0 && name.trim().length <= NAME_MAX_LENGTH
        && resourceDraft.directDisclosureAccepted
        && (directExportSupported || grants.every(mode => mode === 'brokered'))
        && (!managesResources || (grants.length > 0 && (!needsBroker || placement !== null)
            && providerPolicyReconciliation.invalidatedModelIds.length === 0
            && (requestPolicy === null || (
                requestPolicySupportResult?.status === 'available'
                && requestPolicyEditorProjection?.storedPolicyUnsupported === false
            ))
            && (!needsBroker || !hasLimit || pendingLimit !== null) && uniqueLimits))
        && !busy;
    const providerCatalogLoading = providerConnections.loading
        && providerSourceOffers.length === 0
        && sources.supportedKinds.includes('provider_connection');
    const missingRequirements = [
        selected === null ? t('teams.credentials.detail.sourceLabel') : null,
        name.trim().length === 0 ? t('teams.credentials.edit.nameLabel') : null,
        managesResources && grants.length === 0 ? t('teams.credentials.detail.access') : null,
        managesResources && needsBroker && placement === null ? t('teams.credentials.detail.brokerLabel') : null,
    ].filter((value): value is string => value !== null);
    const reviewDescription = notice
        ?? (context.approvalPending
            ? t('teams.credentials.approvalPending')
            : !ready && !busy && missingRequirements.length > 0
                ? missingRequirements.join(' · ')
                : undefined);

    return <>
        <ItemGroup title={t('teams.credentials.create.title')} description={sources.supportedKinds.length < 3 ? t('teams.credentials.create.sourceUnsupported') : t('teams.credentials.subtitle')}>
            <TeamCredentialSourcePicker candidates={sources.candidates} selected={selected} disabled={busy} unavailableReason={sources.status === 'loading' || providerCatalogLoading ? t('common.loading') : sources.candidates.length === 0 ? t('teams.credentials.create.sourceEmpty') : null} onSelect={chooseSource} />
        </ItemGroup>
        {sources.error ? <ItemGroup description={credentialFailureMessage(sources.error)}><Item testID="team-credential-create-source-retry" title={t('teams.unavailable.retry')} onPress={() => void sources.reload()} showChevron={false} /></ItemGroup> : null}
        {providerConnections.error && sources.supportedKinds.includes('provider_connection') ? <ItemGroup description={t('teams.credentials.requestPolicy.catalogUnavailable')}><Item testID="team-credential-create-provider-source-retry" title={t('teams.unavailable.retry')} onPress={() => void providerConnections.refresh()} showChevron={false} /></ItemGroup> : null}
        <ItemGroup title={t('teams.credentials.edit.nameLabel')}><Item title={t('teams.credentials.edit.nameLabel')} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="team-credential-create-name" value={name} onChangeText={value => { setNameEdited(true); patchResourceDraft({ name: value }); }} placeholder={t('teams.credentials.edit.namePlaceholder')} accessibilityLabel={t('teams.credentials.edit.nameLabel')} maxLength={NAME_MAX_LENGTH} editable={!busy} />} /></ItemGroup>
        <ItemGroup title={t('teams.credentials.edit.ceilingLabel')} description={t('teams.credentials.edit.ceilingNote')} accessibilityRole="radiogroup" accessibilityLabel={t('teams.credentials.edit.ceilingLabel')}>
            {(['brokered_only', 'direct_allowed'] as const).map(value => <Item key={value} testID={`team-credential-create-ceiling:${value}`} title={value === 'brokered_only' ? t('teams.credentials.edit.ceilingBrokeredOnly') : t('teams.credentials.edit.ceilingDirectAllowed')} accessibilityRole="radio" webRole="radio" selected={ceiling === value} disabled={busy} onPress={async () => { if (value === 'direct_allowed' && ceiling !== value && !await confirmTeamCredentialDisclosureWidening()) return; if (value === 'brokered_only') resourceDraft.setDraft(narrowTeamCredentialResourceDraftToBrokeredOnly); else patchResourceDraft({ disclosureCeiling: value }, true); }} showChevron={false} />)}
        </ItemGroup>
        {managesResources ? <TeamCredentialBrokerPlacementSection
            scope={context.scope}
            testIDPrefix="team-credential-create-broker"
            brokerPresentation={sources.brokerPresentation}
            savedPlacement={null}
            placement={placement}
            disabled={busy}
            onChange={(next) => patchResourceDraft({ brokerPlacement: next }, true)}
        /> : null}
        {managesResources ? <ItemGroup title={t('teams.credentials.audience.title')} description={t('teams.credentials.audience.limitsNote')}>
            <Item testID="team-credential-create-audience-everyone" title={t('teams.credentials.audience.everyone')} detail={allMembers === null ? t('teams.credentials.audience.everyoneOff') : deliveryModeLabel(allMembers)} disabled={busy} onPress={() => setExpanded(expanded === 'everyone' ? null : 'everyone')} showChevron={false} />
            {chooser('everyone', t('teams.credentials.audience.everyone'), allMembers, (draft, next) => ({
                ...draft,
                audience: { ...draft.audience, allMembers: next },
            }))}
            {[...groupGrants.keys()].map(groupId => { const key = `group:${groupId}`; const mode = groupGrants.get(groupId) ?? null; const title = pickedNames.get(`group:${groupId}`) ?? t('teams.credentials.limits.unknownSubject'); return <React.Fragment key={key}><Item testID={`team-credential-create-audience-group:${groupId}`} title={title} detail={mode ? deliveryModeLabel(mode) : t('teams.credentials.audience.none')} disabled={busy} onPress={() => setExpanded(expanded === key ? null : key)} showChevron={false} />{chooser(key, title, mode, (draft, next) => ({ ...draft, audience: { ...draft.audience, groups: withAudienceEntry(draft.audience.groups, groupId, next) } }))}</React.Fragment>; })}
            {[...memberGrants.keys()].map(membershipId => { const key = `member:${membershipId}`; const title = pickedNames.get(`member:${membershipId}`) ?? t('teams.credentials.limits.unknownSubject'); const mode = memberGrants.get(membershipId) ?? null; return <React.Fragment key={key}><Item testID={`team-credential-create-audience-member:${membershipId}`} title={title} detail={mode ? deliveryModeLabel(mode) : t('teams.credentials.audience.none')} disabled={busy} onPress={() => setExpanded(expanded === key ? null : key)} showChevron={false} />{chooser(key, title, mode, (draft, next) => ({ ...draft, audience: { ...draft.audience, members: withAudienceEntry(draft.audience.members, membershipId, next) } }))}</React.Fragment>; })}
            {/* Both directories are paged and neither is searchable inline, so
                reaching someone past the first page is the chooser's job. */}
            <TeamCredentialAudiencePicker testID="team-credential-create-audience-add" scope={context.scope} address={context.address} excludedGroupIds={[...groupGrants.keys()]} excludedMemberIds={[...memberGrants.keys()]} disabled={busy} onChoose={principal => { setPickedNames(names => new Map(names).set(`${principal.kind}:${principal.id}`, principal.name)); if (principal.kind === 'group') setGroupGrants(current => withAudienceEntry(current, principal.id, 'brokered')); else setMemberGrants(current => withAudienceEntry(current, principal.id, 'brokered')); setExpanded(`${principal.kind}:${principal.id}`); }} />
        </ItemGroup> : null}
        {managesResources ? <ItemGroup title={t('teams.credentials.usePolicy.label')} accessibilityRole="radiogroup" accessibilityLabel={t('teams.credentials.usePolicy.label')}>{USE_POLICIES.map(value => <Item key={value} testID={`team-credential-create-use-policy:${value}`} title={sessionUsePolicyLabel(value)} accessibilityRole="radio" webRole="radio" selected={usePolicy === value} disabled={busy} onPress={() => patchResourceDraft({ sessionUsePolicy: value })} showChevron={false} />)}</ItemGroup> : null}
        {managesResources && selectedSource !== null ? requestPolicySupportResult ? (
            <TeamCredentialRequestPolicyEditorSection
                draft={policyDraft}
                setDraft={setPolicyDraft}
                support={requestPolicySupportResult}
                busy={busy}
                testIDPrefix="team-credential-create-policy"
            />
        ) : <ItemGroup description={requestPolicySupport.error
            ? credentialFailureMessage(requestPolicySupport.error)
            : undefined}>
            <Item
                testID={requestPolicySupport.status === 'error'
                    ? 'team-credential-create-policy-support-retry'
                    : 'team-credential-create-policy-support-loading'}
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
        {managesResources ? needsBroker ? <ItemGroup title={t('teams.credentials.limits.title')} description={hasLimit && pendingLimit === null ? t('teams.credentials.limits.maximumInvalid') : t('teams.credentials.limits.overshoot')}>
            {TEAM_CREDENTIAL_LIMIT_SUBJECT_KINDS.map(kind => <Item key={kind} testID={`team-credential-create-limit-subject:${kind}`} title={limitSubjectKindLabel(kind)} selected={limitDraft.subjectKind === kind} disabled={busy} onPress={() => { setLimitSubjectName(null); setLimitSubjectMembershipId(null); setLimitDraft(current => ({ ...current, subjectKind: kind, subjectId: '' })); }} showChevron={false} />)}
            {limitDraft.subjectKind === 'team_group' && limitDraft.subjectId ? <Item testID={`team-credential-create-limit-group:${limitDraft.subjectId}`} title={limitSubjectName ?? t('teams.credentials.limits.unknownSubject')} selected disabled={busy} onPress={() => { setLimitSubjectName(null); setLimitDraft(current => ({ ...current, subjectId: '' })); }} showChevron={false} /> : null}
            {limitDraft.subjectKind === 'team_group' ? <TeamCredentialAudiencePicker scope={context.scope} address={context.address} excludedGroupIds={limitDraft.subjectId ? [limitDraft.subjectId] : []} excludedMemberIds={[]} allowedKinds={['group']} label={t('teams.credentials.limits.subject.group')} disabled={busy} onChoose={principal => { if (principal.kind !== 'group') return; setLimitSubjectName(principal.name); setLimitDraft(current => ({ ...current, subjectId: principal.id })); }} testID="team-credential-create-limit-group-choose" /> : null}
            {limitDraft.subjectKind === 'team_member' && limitDraft.subjectId ? <Item testID={`team-credential-create-limit-member:${limitDraft.subjectId}`} title={limitSubjectName ?? t('teams.credentials.limits.unknownSubject')} selected disabled={busy} onPress={() => { setLimitSubjectName(null); setLimitSubjectMembershipId(null); setLimitDraft(current => ({ ...current, subjectId: '' })); }} showChevron={false} /> : null}
            {limitDraft.subjectKind === 'team_member' ? <TeamCredentialAudiencePicker scope={context.scope} address={context.address} excludedGroupIds={[]} excludedMemberIds={limitSubjectMembershipId ? [limitSubjectMembershipId] : []} allowedKinds={['member']} label={t('teams.credentials.limits.subject.member')} disabled={busy} onChoose={principal => { if (principal.kind !== 'member') return; setLimitSubjectName(principal.name); setLimitSubjectMembershipId(principal.id); setLimitDraft(current => ({ ...current, subjectId: principal.accountId })); }} testID="team-credential-create-limit-member-choose" /> : null}
            <Item testID="team-credential-create-limit-metric:inference_requests" title={limitMetricLabel('inference_requests')} selected disabled={busy} showChevron={false} />
            {TEAM_CREDENTIAL_LIMIT_PERIODS.map(period => <Item key={period} testID={`team-credential-create-limit-period:${period}`} title={limitPeriodLabel(period)} selected={limitDraft.period === period} disabled={busy} onPress={() => setLimitDraft(current => ({ ...current, period }))} showChevron={false} />)}
            <Item title={t('teams.credentials.limits.maximumLabel')} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="team-credential-create-limit-maximum" accessibilityLabel={t('teams.credentials.limits.maximumLabel')} value={limitDraft.maximum} onChangeText={value => setLimitDraft(current => ({ ...current, maximum: value }))} placeholder={t('teams.credentials.limits.maximumPlaceholder')} keyboardType="numeric" editable={!busy} />} />
            {savedLimits.map((limit, index) => <Item key={`${limitIdentity(limit)}:${index}`} testID={`team-credential-create-limit-saved:${index}`} title={`${limitSubjectKindLabel(limit.subjectKind)} · ${limitMetricLabel(limit.metric)}`} detail={`${limit.maximum} · ${limitPeriodLabel(limit.period)}`} destructive disabled={busy} onPress={() => setSavedLimits(current => current.filter((_, candidate) => candidate !== index))} showChevron={false} />)}
            <Item testID="team-credential-create-limit-add" title={t('teams.credentials.limits.add')} disabled={busy || pendingLimit === null || savedLimits.some(limit => limitIdentity(limit) === limitIdentity(pendingLimit))} onPress={() => { if (pendingLimit === null) return; setSavedLimits(current => [...current, pendingLimit]); setLimitDraft(EMPTY_TEAM_CREDENTIAL_LIMIT_DRAFT); setLimitSubjectName(null); setLimitSubjectMembershipId(null); }} showChevron={false} />
        </ItemGroup> : <ItemGroup title={t('teams.credentials.limits.title')} description={t('teams.credentials.limits.directOnly')}>
            <Item title={t('teams.credentials.limits.empty')} disabled showChevron={false} />
        </ItemGroup> : null}
        <ItemGroup title={t('teams.credentials.create.reviewLabel')} description={reviewDescription}>
            <Item testID="team-credential-create-review-source" title={t('teams.credentials.detail.sourceLabel')} detail={selected ? `${selected.candidate.label} · ${sourceKindLabel(selectedSource)}` : t('teams.credentials.create.sourceChoose')} showChevron={false} />
            <Item testID="team-credential-create-review-ceiling" title={t('teams.credentials.edit.ceilingLabel')} detail={ceiling === 'brokered_only' ? t('teams.credentials.edit.ceilingBrokeredOnly') : t('teams.credentials.edit.ceilingDirectAllowed')} showChevron={false} />
            {managesResources ? <><Item testID="team-credential-create-review-broker" title={t('teams.credentials.detail.brokerLabel')} detail={teamCredentialBrokerPlacementDraftLabel({ placement, brokerPresentation: sources.brokerPresentation, pickerRows: machineAdministrationRows })} showChevron={false} />
            <Item testID="team-credential-create-review-use-policy" title={t('teams.credentials.usePolicy.label')} detail={sessionUsePolicyLabel(usePolicy)} showChevron={false} />
            <Item testID="team-credential-create-review-audience" title={t('teams.credentials.detail.access')} detail={grants.length === 0 ? t('teams.credentials.audience.none') : allMembers ? `${t('teams.credentials.audience.everyone')}: ${deliveryModeLabel(allMembers)}` : t('teams.credentials.audience.limitsNote')} showChevron={false} />
            {[...groupGrants].map(([groupId, mode]) => <Item key={`review-group:${groupId}`} title={pickedNames.get(`group:${groupId}`) ?? t('teams.credentials.limits.unknownSubject')} detail={deliveryModeLabel(mode)} showChevron={false} />)}
            {[...memberGrants].map(([membershipId, mode]) => <Item key={`review-member:${membershipId}`} title={pickedNames.get(`member:${membershipId}`) ?? t('teams.credentials.limits.unknownSubject')} detail={deliveryModeLabel(mode)} showChevron={false} />)}
            <Item testID="team-credential-create-review-request-policy" title={t('teams.credentials.requestPolicy.title')} detail={requestPolicy === null ? t('teams.credentials.requestPolicy.protocolsAny') : requestPolicy.allowedProtocolKinds?.map(requestProtocolKindLabel).join(' · ') ?? t('teams.credentials.requestPolicy.protocolsAny')} showChevron={false} />
            {requestPolicy !== null ? <>
                <Item testID="team-credential-create-review-models" title={t('teams.credentials.requestPolicy.modelsLabel')} detail={requestPolicy.allowedModelIds?.join(' · ') ?? t('teams.credentials.requestPolicy.modelsAny')} showChevron={false} />
            </> : null}
            {usageLimits.length === 0 ? <Item testID="team-credential-create-review-limits" title={t('teams.credentials.limits.title')} detail={t('teams.credentials.limits.empty')} showChevron={false} /> : usageLimits.map((limit, index) => <Item key={`review-limit:${limitIdentity(limit)}:${index}`} testID={`team-credential-create-review-limit:${index}`} title={`${limitSubjectKindLabel(limit.subjectKind)} · ${limitMetricLabel(limit.metric)}`} detail={`${limit.maximum} · ${limitPeriodLabel(limit.period)}`} showChevron={false} />)}</> : null}
            <Item testID="team-credential-create-submit" title={t('teams.credentials.create.submit')} loading={busy} disabled={!ready} onPress={async () => {
                // `ready` already excludes an unparseable request policy; restating it here
                // keeps the submitted value the exact policy the review rows described.
                if (!ready || !selected) return; const requestedTargetKey = targetKey; setSubmitting(true); setNotice(null);
                try {
                    if (selectedProviderOffer !== null) { const refreshedOffers = await providerConnections.refresh(); if (!isTeamCredentialProviderSourceOfferCurrent(selectedProviderOffer, refreshedOffers)) { setNotice(t('teams.credentials.directReadiness.state.sourceChanged')); return; } }
                    const outcome = await createTeamCredentialResource({ scope: context.scope, address: context.address, resourceId: requestId.current, displayName: name.trim(), source: selected.candidate.source, disclosureCeiling: ceiling, sessionUsePolicy: managesResources ? usePolicy : 'personal_allowed', brokerPlacement: managesResources ? placement : null, requestPolicy, allMembersDeliveryMode: managesResources ? allMembers : null, groupGrants: managesResources ? [...groupGrants].map(([teamGroupId, deliveryMode]) => ({ teamGroupId, deliveryMode })) : [], memberGrants: managesResources ? [...memberGrants].map(([teamMembershipId, deliveryMode]) => ({ teamMembershipId, deliveryMode })) : [], usageLimits: managesResources ? usageLimits : [], handlers: { onApprovalSucceeded: summary => { if (currentTargetKey.current === requestedTargetKey) { allowSavedNavigation(); router.replace(teamCredentialDetailPath(context.address, summary.id)); } }, onApprovalFailed: code => { if (currentTargetKey.current === requestedTargetKey) setNotice(credentialApprovalFailureMessage(code)); } } });
                    if (currentTargetKey.current !== requestedTargetKey) return; if (outcome.kind === 'succeeded') { allowSavedNavigation(); router.replace(teamCredentialDetailPath(context.address, outcome.value.id)); } else setNotice(credentialFailureMessage(outcome.failure));
                } catch (cause) { if (currentTargetKey.current !== requestedTargetKey) return; if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration); else setNotice(t('teams.errors.generic')); } finally { if (currentTargetKey.current === requestedTargetKey) setSubmitting(false); }
            }} showChevron={false} />
            <Item testID="team-credential-create-cancel" title={t('common.cancel')} disabled={busy} onPress={() => router.back()} showChevron={false} />
        </ItemGroup>
    </>;
});

export const TeamCredentialCreateScreen = React.memo(function TeamCredentialCreateScreen(props: Readonly<{ serverId: string; teamId: string; sourceHint?: TeamCredentialCreateSourceHint }>) {
    return <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.credentials.create.title')} description={t('teams.pages.credentialCreate')}>{context => <CredentialCreator context={context} sourceHint={props.sourceHint} />}</TeamSection>;
});
