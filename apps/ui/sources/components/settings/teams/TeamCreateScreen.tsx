import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    TEAM_NAME_MAX_LENGTH_V1,
    validateTeamDescriptionV1,
    validateTeamNameV1,
    type TeamLogoSourceV1,
    type TeamSummaryV1,
} from '@happier-dev/protocol/teams';

import type { HomeAccountPickerRowV1 } from '@happier-dev/protocol/home/governance';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { resolveHomeGovernanceViewState } from '@/components/settings/home/governance/homeGovernanceViewState';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { homeAdministrationPoliciesPath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { HOME_TEAMS_POLICY_SETTINGS } from '@/components/settings/home/governance/homeTeamsPolicySettings';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useHomeAccountSearch } from '@/hooks/home/useHomeAccountSearch';
import { useHomeGovernanceEligibilitySnapshots } from '@/hooks/home/useHomeGovernanceEligibilitySnapshots';
import { useHomeGovernanceSnapshot } from '@/hooks/home/useHomeGovernanceSnapshot';
import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useTeamsSettingsAdmission } from '@/hooks/teams/useTeamsSettingsAdmission';
import { randomUUID } from '@/platform/randomUUID';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { refreshHomeGovernanceSnapshot } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { createTeam, setTeamLogo } from '@/sync/ops/teams/teamOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { teamDetailPath, teamsDirectoryPath } from './teamsRoutes';
import { TeamLogoPicker } from './TeamLogoPicker';
import { publishTeamCreateDraftName } from './collection/teamCreateDraftName';

const OWNER_AVATAR_SIZE = 32;

type CommittedTeam = Readonly<{
    team: TeamSummaryV1;
    scope: ServerAccountScope;
    logoSource: TeamLogoSourceV1 | null;
}>;

/**
 * Who the Team's first owner will be, when that is a choice.
 *
 * Ordinary self-service creation has no choice to make: the creator is the
 * owner. It becomes a question only where the Home administers Team creation,
 * and there it must be answered explicitly — an administrator creating a Team
 * for somebody else never becomes a member of it.
 */
const InitialOwnerPicker = React.memo(function InitialOwnerPicker(props: Readonly<{
    scope: ServerAccountScope;
    selected: HomeAccountPickerRowV1 | null;
    onSelect: (account: HomeAccountPickerRowV1) => void;
    /** The administrator can let everyone create Teams instead of naming each first owner. */
    onOpenCreationPolicy: () => void;
}>) {
    const [query, setQuery] = React.useState('');
    const search = useHomeAccountSearch(props.scope, query, true);

    return (
        <>
            <ItemGroup
                title={t('teams.create.initialOwnerLabel')}
                description={t('teams.create.initialOwnerHelp')}
                action={(
                    <SectionActionButton
                        testID="teams-create-open-creation-policy"
                        icon="lock-open"
                        title={t('teams.directory.letEveryoneCreate')}
                        onPress={props.onOpenCreationPolicy}
                    />
                )}
            >
                <SectionContentRow>
                    <CompactSearchField
                        testID="teams-create-owner-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('teams.create.initialOwnerPlaceholder')}
                    />
                </SectionContentRow>
            </ItemGroup>

            {query.trim() && search.searching ? (
                <ItemGroup>
                    <Item testID="teams-create-owner-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
                </ItemGroup>
            ) : query.trim() && search.failure ? (
                <ItemGroup>
                    <Item
                        testID="teams-create-owner-unavailable"
                        title={search.failure.kind === 'unsupported'
                            ? t('homeGovernance.searchUnsupported')
                            : search.failure.kind === 'forbidden'
                                ? t('teams.errors.forbidden')
                                : t('homeGovernance.searchFailed')}
                        mode="info"
                        showChevron={false}
                    />
                    {search.failure.retryable ? (
                        <Item testID="teams-create-owner-retry" title={t('common.retry')} onPress={search.retry} showChevron={false} />
                    ) : null}
                </ItemGroup>
            ) : query.trim() && search.rows.length === 0 ? (
                <ItemGroup>
                    <Item testID="teams-create-owner-empty" title={t('homeGovernance.searchEmpty')} mode="info" showChevron={false} />
                </ItemGroup>
            ) : null}

            {search.rows.length > 0 ? (
                <ItemGroup
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('teams.create.initialOwnerLabel')}
                >
                    {search.rows.map((candidate) => (
                        <Item
                            key={candidate.accountId}
                            testID={`teams-create-owner:${candidate.accountId}`}
                            title={resolveAccountDisplayName({ profile: candidate.profile, accountId: candidate.accountId }).name}
                            subtitle={[
                            resolveAccountDisplayName({ profile: candidate.profile, accountId: candidate.accountId }).hint,
                            candidate.eligible ? null : t('teams.create.initialOwnerIneligible'),
                        ].filter((part): part is string => part !== null).join(' · ') || undefined}
                            selected={props.selected?.accountId === candidate.accountId}
                            accessibilityRole="radio"
                            webRole="radio"
                            accessibilityChecked={props.selected?.accountId === candidate.accountId}
                            // A found-but-ineligible Account stays visible and
                            // unselectable, so it reads as "not eligible" rather
                            // than as "not on this Home".
                            disabled={!candidate.eligible}
                            subtitleLines={0}
                            leftElement={(
                                <Avatar
                                    id={candidate.accountId}
                                    size={OWNER_AVATAR_SIZE}
                                    imageUrl={candidate.profile.avatarUrl}
                                />
                            )}
                            onPress={() => props.onSelect(candidate)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </>
    );
});

/**
 * Creating a Team.
 *
 * One compact form, never a wizard: a name, an optional description, and the
 * Home it is created on. The Home is always shown even when only one is
 * eligible, because a Team belongs to exactly one Home for its whole life and
 * that is not something to discover afterwards.
 */
export const TeamCreateScreen = React.memo(function TeamCreateScreen(props: Readonly<{
    /** Exact Home supplied only by the admitted Home Administration entry. */
    administrationServerId?: string;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const admission = useTeamsSettingsAdmission();
    // Scope resolutions are keyed by the Home's canonical scope id; an entry that
    // names the Home by its device profile id must not wait on a key that never fills.
    const administrationServerId = resolveServerProfileScopeIdForIdentifier(props.administrationServerId) || null;
    const requestedServerIds = React.useMemo(
        () => administrationServerId ? [administrationServerId] : admission.capableServerIds,
        [administrationServerId, admission.capableServerIds],
    );
    const scopeResolutions = useServerCredentialAccountScopeResolutions(requestedServerIds);

    const candidateHomes = React.useMemo(() => {
        const out: Array<Readonly<{ scope: ServerAccountScope; homeName: string }>> = [];
        for (const serverId of requestedServerIds) {
            const resolution = scopeResolutions.get(serverId);
            if (resolution?.kind !== 'bound') continue;
            const profile = getServerProfileById(serverId);
            out.push({
                scope: resolution.scope,
                homeName: resolveHomeDisplayLabel(profile, serverId),
            });
        }
        return out;
    }, [requestedServerIds, scopeResolutions]);

    const ordinaryScopes = React.useMemo(
        () => administrationServerId ? [] : candidateHomes.map((home) => home.scope),
        [administrationServerId, candidateHomes],
    );
    const eligibility = useHomeGovernanceEligibilitySnapshots(ordinaryScopes);
    const homes = React.useMemo(() => administrationServerId
        ? candidateHomes
        : candidateHomes.filter((home) => {
            const snapshot = eligibility.snapshotsByServerId.get(home.scope.serverId);
            return snapshot?.data?.teamsEnabled === true && snapshot.data.createTeam;
        }), [administrationServerId, candidateHomes, eligibility.snapshotsByServerId]);

    const [selectedServerId, setSelectedServerId] = React.useState<string | null>(null);
    const [name, setName] = React.useState('');
    const [description, setDescription] = React.useState('');
    const [initialOwner, setInitialOwner] = React.useState<HomeAccountPickerRowV1 | null>(null);
    const [logoSource, setLogoSource] = React.useState<TeamLogoSourceV1 | null>(null);
    const [committedTeam, setCommittedTeam] = React.useState<CommittedTeam | null>(null);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const nameInputRef = React.useRef<React.ComponentRef<typeof FieldTextInput> | null>(null);
    const descriptionInputRef = React.useRef<React.ComponentRef<typeof FieldTextInput> | null>(null);
    const { theme } = useUnistyles();

    // The collection's draft row is titled as the name is typed, and cleared when the draft closes.
    React.useEffect(() => {
        publishTeamCreateDraftName(name);
    }, [name]);
    React.useEffect(() => () => publishTeamCreateDraftName(''), []);
    const submissionInFlightRef = React.useRef(false);

    // A single eligible Home is preselected but still displayed.
    const effectiveServerId = homes.some((home) => home.scope.serverId === selectedServerId)
        ? selectedServerId
        : homes[0]?.scope.serverId ?? null;
    const selected = homes.find((home) => home.scope.serverId === effectiveServerId) ?? null;
    const { allowSavedNavigation, requestLeave } = useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: committedTeam === null && (name.length > 0 || description.length > 0 || logoSource !== null || initialOwner !== null),
        onLeave: () => {
            if (router.canGoBack()) router.back();
            else router.replace(teamsDirectoryPath() as never);
        },
        tag: 'TeamCreateScreen.beforeRemove',
    });

    const openCreatedTeam = React.useCallback((committed: CommittedTeam) => {
        allowSavedNavigation();
        router.replace(teamDetailPath({
            serverId: committed.scope.serverId,
            teamId: committed.team.id,
        }));
    }, [allowSavedNavigation, router]);

    /**
     * This screen's own deferred-approval host.
     *
     * Every other Team surface inherits one from the Team shell, but a Team
     * being created has no Team to hang it on — and creation is exactly the
     * intent whose answer cannot be recovered by re-reading anything, because
     * the new Team's id exists only in it. The key names the exact Home and
     * Account this submission is addressed to, so switching Homes mid-flight
     * releases the pending request here rather than letting another Home's
     * approval settle this form.
     */
    const approvalScopeKey = selected
        ? `team-create:${selected.scope.serverId}:${selected.scope.accountId}`
        : 'team-create:unbound';
    /**
     * Which of this form's two deferrable intents the pending approval is for.
     *
     * Creation carries its answer on the continuation, because the new Team's id
     * exists only there. Publishing the logo is addressed to a Team that is
     * already committed here, so its approval finishes by landing on that Team.
     */
    const approvalIntentRef = React.useRef<'create' | 'logo' | null>(null);
    const {
        approvalId,
        approvalStatus,
        approvalPending,
        isLoading: approvalLoading,
        error: approvalError,
        requestApproval,
    } = useActionApprovalContinuation({
        scopeKey: approvalScopeKey,
        serverId: selected?.scope.serverId ?? '',
        // The created Team arrives on the continuation, so creation has nothing
        // to refresh. An approved logo publication does: the Team is already
        // committed, and the person is still waiting on this form to finish.
        onExecuted: () => {
            if (approvalIntentRef.current !== 'logo') return;
            approvalIntentRef.current = null;
            if (committedTeam) openCreatedTeam(committedTeam);
        },
    });

    // One retry identity per submission attempt. A transport retry of the same
    // submission reuses it, so a lost response cannot create a second Team; it
    // is regenerated only when the payload the person is submitting changes.
    const requestKey = React.useRef(randomUUID());
    React.useEffect(() => {
        requestKey.current = randomUUID();
    }, [name, description, effectiveServerId, initialOwner?.accountId]);

    /**
     * Ordinary creation consumes only the Home's minimum eligibility answer.
     * The full projection is observed exclusively for an explicit Home
     * Administration entry, because only that flow may choose somebody else as
     * initial owner. The caller-supplied route context grants nothing: the
     * administrative projection remains server-authorized.
     */
    const governanceSnapshot = useHomeGovernanceSnapshot(
        administrationServerId ? selected?.scope ?? null : null,
    );
    const governance = governanceSnapshot?.data ?? null;
    const selectedEligibility = selected
        ? eligibility.snapshotsByServerId.get(selected.scope.serverId) ?? null
        : null;
    const selectedStale = administrationServerId
        ? governanceSnapshot?.stale === true || governanceSnapshot?.status === 'error'
        : selectedEligibility?.stale === true || selectedEligibility?.status === 'error';
    const creationRefused = administrationServerId !== null
        && governance !== null
        && (!governance.teamsEnabled || !governance.capabilities.createTeam);
    // Managed creation names the Team's first owner. The administration entry reads it from
    // the full projection; an ordinary entry from the Home's minimum eligibility answer, so an
    // administrator who opens "New Team" gets the one form the Home will accept.
    const mayNameInitialOwner = administrationServerId !== null
        ? governance !== null
            && governance.capabilities.createTeam
            && governance.capabilities.manageAllTeams
            && governance.policy.teamCreationPolicy === 'managed_only'
        : selectedEligibility?.data?.createTeamForChosenAccount === true;

    // Clearing a stale pick matters: the picked Account exists on one Home only.
    React.useEffect(() => {
        setInitialOwner(null);
        setLogoSource(null);
    }, [effectiveServerId]);

    const nameValidation = validateTeamNameV1(name);
    const descriptionValidation = validateTeamDescriptionV1(description);
    const canSubmit = nameValidation.status === 'ok'
        && descriptionValidation.status === 'ok'
        && selected !== null
        && (administrationServerId === null || governance !== null)
        && !creationRefused
        && !selectedStale
        && (!mayNameInitialOwner || initialOwner !== null)
        && !submitting
        // A deferred creation is already waiting on a person; offering the
        // button again would ask the Home to create a second Team.
        && !approvalPending;

    const uploadLogo = React.useCallback(async (committed: CommittedTeam) => {
        if (!committed.logoSource) return true;
        let logoOutcome: Awaited<ReturnType<typeof setTeamLogo>>;
        try {
            logoOutcome = await setTeamLogo({
                scope: committed.scope,
                address: { serverId: committed.scope.serverId, teamId: committed.team.id },
                image: committed.logoSource,
            });
        } catch (cause) {
            // An explicit UI-approval requirement defers the publication; it is
            // not an upload failure. Registering this exact request through the
            // screen's own approval host is what lets it finish on the Team that
            // is already committed — reporting a failure here instead would
            // offer a Retry that mints a second approval for the same upload.
            if (isTeamActionApprovalPendingError(cause)) {
                approvalIntentRef.current = 'logo';
                requestApproval(cause.registration);
                return false;
            }
            setError(t('teams.logo.failed'));
            return false;
        }
        if (logoOutcome.kind === 'succeeded') {
            openCreatedTeam({ ...committed, team: logoOutcome.team });
            return true;
        }
        setError(logoOutcome.failure.kind === 'outcome_unknown'
            ? t('teams.errors.outcomeUnknown')
            : logoOutcome.failure.kind === 'unreachable'
                ? t('teams.errors.offline')
                : t('teams.logo.failed'));
        return false;
    }, [openCreatedTeam, requestApproval]);

    const submit = React.useCallback(async () => {
        if (submissionInFlightRef.current || approvalPending) return;
        if (!selected || nameValidation.status !== 'ok' || descriptionValidation.status !== 'ok') {
            if (nameValidation.status !== 'ok') nameInputRef.current?.focus();
            else if (descriptionValidation.status !== 'ok') descriptionInputRef.current?.focus();
            return;
        }
        submissionInFlightRef.current = true;
        setSubmitting(true);
        setError(null);
        try {
            if (committedTeam) {
                const uploaded = await uploadLogo(committedTeam);
                if (uploaded && !committedTeam.logoSource) openCreatedTeam(committedTeam);
                return;
            }
            const submittedOwner = mayNameInitialOwner && initialOwner !== null;
            const submission: Omit<CommittedTeam, 'team'> = {
                scope: selected.scope,
                logoSource,
            };
            /**
             * One commitment for the immediate creation and the approved one.
             *
             * A Team created through an approval is the same Team: it is held
             * as the authoritative committed creation, its logo is published to
             * that exact id, and the person is taken to it — never asked to
             * submit the form again, which would create a second Team.
             */
            const commitCreatedTeam = async (team: TeamSummaryV1) => {
                const committed: CommittedTeam = { ...submission, team };
                setCommittedTeam(committed);
                if (!committed.logoSource) {
                    openCreatedTeam(committed);
                    return;
                }
                // Creation is already committed. Keep that authoritative Team and
                // the confirmed local logo source if publication fails; retrying
                // must upload to this ID, never repeat Team creation.
                await uploadLogo(committed);
            };
            const outcome = await createTeam({
                scope: submission.scope,
                name: nameValidation.name,
                description: descriptionValidation.description,
                // Absent means the creator owns it. A named owner is only ever the
                // one an authorized administrator explicitly chose.
                ...(mayNameInitialOwner && initialOwner
                    ? { initialOwnerAccountId: initialOwner.accountId }
                    : {}),
                requestKey: requestKey.current,
                onApprovalSucceeded: async (team) => {
                    // Publishing the logo to the approved Team is real work the
                    // person is waiting on, so it carries the same busy state
                    // an immediate creation does.
                    setSubmitting(true);
                    try {
                        await commitCreatedTeam(team);
                    } finally {
                        setSubmitting(false);
                    }
                },
                onApprovalFailed: (code) => setError(code === 'approval_rejected'
                    ? t('teams.errors.forbidden')
                    : t('teams.errors.generic')),
            });
            if (outcome.kind === 'succeeded') {
                await commitCreatedTeam(outcome.team);
                return;
            }
            // The form is preserved so a rejected submission is never retyped, and
            // the retry identity is kept so a repeat is the same submission.
            // Name and description passed the Home's own validators above, so a Home that
            // still calls the input invalid is refusing the first owner: none was named
            // under managed creation, or the named Account can no longer hold the Team.
            const ownerRefused = outcome.failure.kind === 'invalid' && outcome.failure.code === 'invalid_team_input';
            if (ownerRefused && !submittedOwner) eligibility.refresh();
            setError(outcome.failure.kind === 'forbidden'
                ? t('teams.errors.forbidden')
                : ownerRefused
                    ? (submittedOwner ? t('teams.create.initialOwnerIneligible') : t('teams.create.initialOwnerRequired'))
                : outcome.failure.kind === 'invalid'
                    ? t('teams.errors.invalidName')
                    : outcome.failure.kind === 'outcome_unknown'
                        ? t('teams.create.outcomeUnknown')
                        : outcome.failure.kind === 'unreachable'
                            ? t('teams.errors.offline')
                        : t('teams.errors.generic'));
        } catch (cause) {
            // An explicit UI-approval requirement defers the creation instead of
            // reaching the Home. Registering this exact request is what lets the
            // Team it produces arrive here; without it the submission would end
            // as an unhandled rejection and the person would be left on a form
            // whose Team may or may not exist.
            if (isTeamActionApprovalPendingError(cause)) {
                approvalIntentRef.current = 'create';
                requestApproval(cause.registration);
            } else setError(t('teams.errors.generic'));
        } finally {
            submissionInFlightRef.current = false;
            setSubmitting(false);
        }
    }, [selected, nameValidation, descriptionValidation, mayNameInitialOwner, initialOwner, committedTeam, uploadLogo, logoSource, openCreatedTeam, requestApproval, eligibility, approvalPending]);

    const scopeResolutionPending = requestedServerIds.some((serverId) => {
        const resolution = scopeResolutions.get(serverId);
        return !resolution || resolution.kind === 'resolving';
    });
    const eligibilityLoading = administrationServerId === null
        && candidateHomes.some((home) => {
            const snapshot = eligibility.snapshotsByServerId.get(home.scope.serverId);
            return !snapshot || snapshot.status === 'loading';
        });
    // Until one Home is eligible, a Home whose Teams admission is still being
    // decided has said nothing yet: wait for it rather than guess a refusal.
    const admissionPending = administrationServerId === null
        && homes.length === 0
        && admission.homes.some((home) => home.state === 'unresolved' && home.reason === 'loading');
    const administrationView = administrationServerId !== null && selected !== null
        ? resolveHomeGovernanceViewState(governanceSnapshot)
        : null;
    const administrationLoading = administrationView?.kind === 'unobserved' || administrationView?.kind === 'loading';
    const eligibilityUnavailable = administrationServerId === null
        && homes.length === 0
        && candidateHomes.some((home) => eligibility.snapshotsByServerId.get(home.scope.serverId)?.status === 'error');
    const eligibilityErrors = administrationServerId === null
        ? candidateHomes.flatMap((home) => {
            const error = eligibility.snapshotsByServerId.get(home.scope.serverId)?.error;
            return error ? [error] : [];
        })
        : [];
    const eligibilityRetryable = eligibilityErrors.some((failure) => failure.retryable);
    const eligibilityUnavailableMessage = eligibilityErrors.some((failure) => failure.kind === 'forbidden')
        ? t('teams.errors.forbidden')
        : eligibilityErrors.length > 0 && eligibilityErrors.every((failure) => failure.kind === 'unsupported')
            ? t('teams.unavailable.updateRequired')
            : t('teams.unavailable.offline');
    const administrationUnavailable = administrationView?.kind === 'unavailable';
    const administrationError = administrationView?.kind === 'unavailable' ? administrationView.error : null;
    /** Only a Home that answered "Teams on, creation not yours" is described as administered. */
    const creationAdministeredByHome = administrationServerId === null && candidateHomes.some((home) => {
        const answer = eligibility.snapshotsByServerId.get(home.scope.serverId)?.data;
        return answer?.teamsEnabled === true && !answer.createTeam;
    });
    const teamsTurnedOff = admission.homes.some((home) => home.state === 'disabled')
        || candidateHomes.some((home) => eligibility.snapshotsByServerId.get(home.scope.serverId)?.data?.teamsEnabled === false);

    const discardDraft = requestLeave;
    // One eligible Home is a fact about the draft, named on the header's meta line; a choice between
    // several is a radio group below.
    const singleHome = homes.length === 1 ? homes[0]! : null;
    const draftHeader = (props: Readonly<{ actions?: React.ReactNode; details?: React.ReactNode }> = {}) => (
        <PageHeader
            testID="teams-create-header"
            // The draft's own name heads the page once typed; until then the navigation title says it.
            alwaysShowTitle={name.trim().length > 0}
            title={name.trim() || t('teams.create.title')}
            description={t('teams.directory.emptyBody')}
            leading={(
                <PageHeaderMarkSlot>
                    <Icon name="users" size={22} color={theme.colors.text.secondary} />
                </PageHeaderMarkSlot>
            )}
            details={props.details}
            meta={singleHome ? [{
                key: 'home',
                icon: 'house',
                text: singleHome.homeName,
                testID: `teams-create-home:${singleHome.scope.serverId}`,
            }] : undefined}
            actions={props.actions}
        />
    );
    const conditionPage = (condition: React.ReactNode) => (
        <ItemList>
            {draftHeader()}
            {condition}
        </ItemList>
    );

    if (scopeResolutionPending || admissionPending || eligibilityLoading || administrationLoading) {
        return conditionPage(
            <SurfaceStateCard testID="teams-create-loading" kind="loading" title={t('teams.create.loading')} accessibilitySemantics="status" />,
        );
    }

    if (eligibilityUnavailable) {
        return conditionPage(
            <SurfaceStateCard
                testID="teams-create-unavailable"
                kind="unavailable"
                title={t('teams.unavailable.title')}
                reason={eligibilityUnavailableMessage}
                action={eligibilityRetryable ? { label: t('teams.unavailable.retry'), onPress: eligibility.refresh } : undefined}
                accessibilitySemantics="alert"
            />,
        );
    }

    if (administrationView?.kind === 'setup_required') {
        // An ownerless Home is explained exactly as Home Administration explains it: nobody can
        // create a Team there until an operator assigns the first owner.
        return conditionPage(
            <SurfaceStateCard
                testID="teams-create-setup-required"
                kind="unavailable"
                title={t('homeGovernance.setupRequiredTitle')}
                reason={t('homeGovernance.setupRequiredBody')}
                action={{ label: t('common.refresh'), onPress: () => void refreshHomeGovernanceSnapshot(selected!.scope) }}
                accessibilitySemantics="alert"
            />,
        );
    }

    if (administrationUnavailable) {
        const denied = administrationError?.kind === 'forbidden'
            || administrationError?.kind === 'unauthorized';
        const unsupported = administrationError?.kind === 'unsupported';
        return conditionPage(
            <SurfaceStateCard
                testID="teams-create-unavailable"
                kind="unavailable"
                title={denied ? t('homeGovernance.forbiddenTitle') : t('teams.unavailable.title')}
                reason={denied
                    ? t('teams.errors.forbidden')
                    : unsupported
                        ? t('teams.unavailable.updateRequired')
                        : t('teams.unavailable.offline')}
                action={administrationError?.retryable && selected
                    ? { label: t('teams.unavailable.retry'), onPress: () => void refreshHomeGovernanceSnapshot(selected.scope) }
                    : undefined}
                accessibilitySemantics="alert"
            />,
        );
    }

    if (administrationServerId === null && homes.length === 0 && !creationAdministeredByHome) {
        // No Home is eligible and none said creation is administered: say why Teams is unavailable.
        return conditionPage(
            <SurfaceStateCard
                testID="teams-create-unavailable"
                kind="unavailable"
                title={t('teams.unavailable.title')}
                reason={teamsTurnedOff
                    ? t('teams.unavailable.disabled')
                    : admission.homes.some((home) => home.state === 'unsupported')
                        ? t('teams.unavailable.updateRequired')
                        : t('teams.unavailable.offline')}
                accessibilitySemantics="alert"
            />,
        );
    }

    if (homes.length === 0 || creationRefused) {
        // A Home that administers Team creation explains it rather than showing
        // a mysterious disabled control.
        return conditionPage(
            <SurfaceStateCard
                testID="teams-create-managed-only"
                kind="unavailable"
                title={t('teams.create.managedOnlyTitle')}
                reason={t('teams.create.managedOnlyBody')}
            />,
        );
    }

    const staleRetry = administrationServerId
        ? governanceSnapshot?.error?.retryable === false
            ? undefined
            : governanceSnapshot
                ? () => void refreshHomeGovernanceSnapshot(selected!.scope)
                : undefined
        : eligibility.refresh;

    return (
        <ItemList keyboardAware>
            {draftHeader({
                details: error && committedTeam === null ? (
                    <Text
                        testID="teams-create-error"
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        style={{ color: theme.colors.state.danger.foreground, fontSize: 13, lineHeight: 18 }}
                    >
                        {error}
                    </Text>
                ) : undefined,
                actions: (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        {selectedStale && committedTeam === null ? null : <RoundButton
                            testID="teams-create-submit"
                            size="small"
                            title={committedTeam
                                ? t('teams.logo.retry')
                                : submitting ? t('teams.create.submitting') : t('teams.create.submit')}
                            loading={submitting}
                            disabled={committedTeam
                                ? submitting || approvalPending || committedTeam.logoSource === null
                                : !canSubmit}
                            onPress={() => void submit()}
                        />}
                        {committedTeam === null ? (
                            <PageHeaderMenu
                                testID="teams-create-menu"
                                actions={[{ id: 'discard', title: t('teams.create.discard'), onSelect: discardDraft }]}
                            />
                        ) : null}
                    </View>
                ),
            })}
            {/* A deferred creation is waiting on a person, not stuck. The same
                notice every other Team surface shows says so and leads to the
                request, so the form never looks like it silently did nothing. */}
            {approvalId ? (
                <AttentionBanner
                    testID="teams-create-approval"
                    tone="neutral"
                    title={t('approvals.title')}
                    description={approvalError
                        ? t('approvals.loadError')
                        : approvalLoading || approvalStatus === 'open' || approvalStatus === 'approved' || approvalStatus === 'executing'
                            ? t('approvals.status.open')
                            : undefined}
                    accessibilityLiveRegion={approvalError ? 'assertive' : 'polite'}
                    action={{
                        label: t('approvals.details'),
                        onPress: () => router.push(
                            `/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(selected?.scope.serverId ?? '')}`,
                        ),
                    }}
                />
            ) : null}
            {committedTeam ? (
                // The Team exists; only its logo did not publish. Retry stays the primary action and
                // the Team can be opened without it. A publication waiting on an approval is not a failure.
                <AttentionBanner
                    testID="teams-create-logo-failed"
                    tone={approvalId ? 'neutral' : 'warning'}
                    title={approvalId ? t('approvals.status.open') : t('teams.create.logoFailedBody')}
                    description={error ?? undefined}
                    action={{
                        label: t('common.continue'),
                        onPress: () => openCreatedTeam(committedTeam),
                        disabled: submitting,
                        testID: 'teams-create-continue-without-logo',
                    }}
                />
            ) : committedTeam === null && selectedStale ? (
                <AttentionBanner
                    testID="teams-create-stale"
                    title={t('teams.unavailable.offline')}
                    description={t('teams.stale.label')}
                    action={staleRetry ? { label: t('teams.unavailable.retry'), onPress: staleRetry } : null}
                />
            ) : null}

            <ItemGroup title={t('teams.create.detailsSection')}>
                <Item
                    title={t('teams.create.nameLabel')}
                    subtitle={t('teams.create.duplicateNameNote')}
                    subtitleLines={0}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            ref={nameInputRef}
                            testID="teams-create-name"
                            value={name}
                            onChangeText={setName}
                            placeholder={t('teams.create.namePlaceholder')}
                            accessibilityLabel={t('teams.create.nameLabel')}
                            autoFocus
                            maxLength={TEAM_NAME_MAX_LENGTH_V1}
                            editable={committedTeam === null}
                            returnKeyType="next"
                        />
                    )}
                />
                <Item
                    title={t('teams.create.descriptionLabel')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="teams-create-description"
                            ref={descriptionInputRef}
                            value={description}
                            onChangeText={setDescription}
                            placeholder={t('teams.create.descriptionPlaceholder')}
                            accessibilityLabel={t('teams.create.descriptionLabel')}
                            multiline
                            minLines={2}
                            editable={committedTeam === null}
                            error={descriptionValidation.status !== 'ok' ? t('teams.errors.invalidDescription') : null}
                        />
                    )}
                />
                <TeamLogoPicker
                    identityId={committedTeam?.team.id ?? requestKey.current}
                    testIDPrefix="teams-create"
                    currentLogo={null}
                    selectedSource={committedTeam?.logoSource ?? logoSource}
                    disabled={submitting || selectedStale || committedTeam !== null}
                    onUse={async (source) => {
                        setLogoSource(source);
                        return { kind: 'succeeded' };
                    }}
                />
            </ItemGroup>

            {singleHome ? null : <ItemGroup
                title={t('teams.homeLabel')}
                description={t('teams.create.homeHelp')}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('teams.homeLabel')}
            >
                {homes.map((home) => (
                    <Item
                        key={home.scope.serverId}
                        testID={`teams-create-home:${home.scope.serverId}`}
                        title={home.homeName}
                        selected={home.scope.serverId === (committedTeam?.scope.serverId ?? effectiveServerId)}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={home.scope.serverId === (committedTeam?.scope.serverId ?? effectiveServerId)}
                        disabled={submitting || committedTeam !== null}
                        onPress={() => setSelectedServerId(home.scope.serverId)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>}

            {mayNameInitialOwner && selected && committedTeam === null ? (
                <InitialOwnerPicker
                    // The picked Account belongs to one Home; remounting per
                    // Home keeps the search's own cache from crossing over.
                    key={selected.scope.serverId}
                    scope={selected.scope}
                    selected={initialOwner}
                    onSelect={setInitialOwner}
                    onOpenCreationPolicy={() => router.push(buildSettingHref(
                        homeAdministrationPoliciesPath(selected.scope.serverId),
                        HOME_TEAMS_POLICY_SETTINGS.settings.teamCreationPolicy,
                    ) as never)}
                />
            ) : null}
        </ItemList>
    );
});
