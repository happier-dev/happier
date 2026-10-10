import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    HomeAccountSearchResultV1Schema,
    type HomeAccountPickerRowV1,
} from '@happier-dev/protocol/home/governance';
import {
    type SessionHistoryAccessV1,
    type TeamAdmissibleRoleV1,
} from '@happier-dev/protocol/teams';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import {
    isTeamActionApprovalPendingError,
    runTeamAction,
    type HomeDomainFailure,
} from '@/sync/ops/teams/teamActionClient';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { teamMemberDetailPath } from '@/components/settings/teams/teamsRoutes';
import { addTeamMember } from '@/sync/ops/teams/teamMemberOperations';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamRoleLabel } from '../teamLabels';
import { teamMutationFailureLabel, teamReadFailureLabel } from '../teamMutationPresentation';

const ADMISSIBLE_ROLES: readonly TeamAdmissibleRoleV1[] = Object.freeze(['admin', 'member', 'guest']);
const PICKER_AVATAR_SIZE = 32;
const SEARCH_DEBOUNCE_MS = 250;

type MemberSearchState = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    candidates: readonly HomeAccountPickerRowV1[];
    failure?: HomeDomainFailure;
}>;

function roleHelp(role: TeamAdmissibleRoleV1): string {
    switch (role) {
        case 'admin':
            return t('teams.roleHelp.admin');
        case 'member':
            return t('teams.roleHelp.member');
        case 'guest':
            return t('teams.roleHelp.guest');
    }
}

const AddMemberForm = React.memo(function AddMemberForm(props: Readonly<{ context: TeamSectionContext }>) {
    const router = useRouter();
    const { context } = props;
    const [query, setQuery] = React.useState('');
    const [search, setSearch] = React.useState<MemberSearchState>({ status: 'idle', candidates: [] });
    const [searchRetry, setSearchRetry] = React.useState(0);
    const [selected, setSelected] = React.useState<HomeAccountPickerRowV1 | null>(null);
    const [role, setRole] = React.useState<TeamAdmissibleRoleV1>('member');
    // The Team's own default preselects the horizon; the manager still decides.
    const [historyAccess, setHistoryAccess] = React.useState<SessionHistoryAccessV1>(
        context.team.policy.defaultSessionHistoryAccess,
    );
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const serverId = context.scope.serverId;
    const accountId = context.scope.accountId;
    const teamId = context.address.teamId;
    const searchGeneration = React.useRef(0);

    React.useEffect(() => {
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            searchGeneration.current += 1;
            setSearch({ status: 'idle', candidates: [] });
            return;
        }
        const generation = (searchGeneration.current += 1);
        setSearch({ status: 'loading', candidates: [] });
        const timer = setTimeout(() => {
            void (async () => {
                const outcome = await runTeamAction({
                    scope: { serverId, accountId },
                    actionId: 'home.accounts.search',
                    // The Team scope is what makes the picker's `eligible` flag
                    // mean "can join *this* Team"; a Home-wide search could not.
                    input: { query: trimmed, scope: { kind: 'team', teamId } },
                    parse: (value) => HomeAccountSearchResultV1Schema.parse(value),
                });
                if (generation !== searchGeneration.current) return;
                setSearch(outcome.kind === 'succeeded'
                    ? { status: 'ready', candidates: outcome.value.accounts }
                    : { status: 'error', candidates: [], failure: outcome.failure });
            })();
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, searchRetry, serverId, accountId, teamId]);

    const candidates = search.candidates;

    // A guest never receives Team-principal access, so offering it a Team
    // history choice would promise access the role does not carry. The server
    // projects that rule so this screen and the invitation screen share it.
    const historyChoiceAvailable = context.team.admission.historyChoice[role] === 'choice';

    // The visible disabled state follows on the next render; this ref also
    // closes the same-frame double-activation window on fast pointer/touch, the
    // same guard the Group and Home Administration surfaces already use.
    const submitInFlightRef = React.useRef(false);
    /**
     * One settlement for the immediate admission and the approved one.
     *
     * Including existing history is an instruction, not just a stored policy:
     * the journey continues at the created member, where the one preparation
     * operation starts. Replacing this screen keeps Back pointing at the member
     * list instead of at a form that has already been submitted. An admission
     * granted through approval is the same admission and carries the same
     * instruction, so it must not be reduced to "somebody joined, reload".
     */
    const settleAdmission = React.useCallback((
        membership: Readonly<{ id: string }>,
        includeHistory: boolean,
    ) => {
        context.refresh();
        if (includeHistory) {
            router.replace(teamMemberDetailPath(context.address, membership.id, { prepareHistory: true }));
            return;
        }
        router.back();
    }, [context, router]);

    const submit = React.useCallback(async () => {
        if (!selected || submitting || submitInFlightRef.current) return;
        submitInFlightRef.current = true;
        setSubmitting(true);
        setError(null);
        // The admission decision this exact submission carries, captured before
        // the await so a later form edit cannot retarget an approved answer.
        const includeHistory = historyChoiceAvailable && historyAccess === 'all_existing';
        let outcome: Awaited<ReturnType<typeof addTeamMember>>;
        try {
            outcome = await addTeamMember({
                scope: context.scope,
                address: context.address,
                accountId: selected.accountId,
                role,
                historyAccess: historyChoiceAvailable ? historyAccess : 'from_membership',
                onApprovalSucceeded: (membership) => settleAdmission(membership, includeHistory),
                onApprovalFailed: (code) => setError(code === 'approval_rejected'
                    ? t('teams.errors.forbidden')
                    : t('teams.errors.generic')),
            });
        } catch (cause) {
            submitInFlightRef.current = false;
            // The admission was deferred, not lost. Registering this exact
            // request is what lets its approved answer continue the history
            // journey here; settlement never redispatches, because the Home
            // admits the person when the approval is granted.
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
            else setError(t('teams.errors.generic'));
            setSubmitting(false);
            return;
        }
        submitInFlightRef.current = false;
        setSubmitting(false);
        if (outcome.kind === 'succeeded') {
            settleAdmission(outcome.value, includeHistory);
            return;
        }
        // The form is preserved so a rejected submission is not retyped, and the
        // Home's own reason is used rather than a ladder repeated here: a
        // last-owner or managed-source refusal is actionable, and an answer that
        // was lost must not read as "nothing changed" before a second add.
        setError(teamMutationFailureLabel(outcome.failure));
        if (outcome.failure.kind === 'outcome_unknown') context.refresh();
    }, [selected, submitting, context, role, historyAccess, historyChoiceAvailable, settleAdmission]);

    if (!context.team.capabilities.manageMembers) {
        return (
            <ItemGroup>
                <SurfaceStateCard
                    testID="team-member-add-forbidden"
                    kind="denied"
                    size="line"
                    title={t('teams.denied.title')}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            <ItemGroup
                title={t('teams.members.personLabel')}
                accessibilityRole={candidates.length > 0 ? 'radiogroup' : undefined}
                accessibilityLabel={t('teams.members.personLabel')}
            >
                <SectionContentRow>
                    <CompactSearchField
                        testID="team-member-add-search"
                        value={query}
                        onChangeText={(value) => {
                            setQuery(value);
                            setSelected(null);
                        }}
                        placeholder={t('teams.members.personPlaceholder')}
                    />
                </SectionContentRow>
                {candidates.map((candidate) => (
                    <Item
                        key={candidate.accountId}
                        testID={`team-member-add-candidate:${candidate.accountId}`}
                        title={resolveAccountDisplayName({ profile: candidate.profile, accountId: candidate.accountId }).name}
                        subtitle={[
                            resolveAccountDisplayName({ profile: candidate.profile, accountId: candidate.accountId }).hint,
                            candidate.eligible ? null : t('teams.members.ineligible'),
                        ].filter((part): part is string => part !== null).join(' · ') || undefined}
                        selected={selected?.accountId === candidate.accountId}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={selected?.accountId === candidate.accountId}
                        // An ineligible Account stays visible and unselectable
                        // so the manager can see it was found, not missing —
                        // and is told why it cannot be chosen.
                        disabled={!candidate.eligible}
                        leftElement={(
                            <Avatar
                                id={candidate.accountId}
                                size={PICKER_AVATAR_SIZE}
                                imageUrl={candidate.profile.avatarUrl}
                            />
                        )}
                        onPress={() => setSelected(candidate)}
                        showChevron={false}
                    />
                ))}
                {search.status === 'loading' ? (
                    <Item
                        testID="team-member-add-search-loading"
                        title={t('teams.members.personLabel')}
                        loading
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {search.status === 'ready' && candidates.length === 0 ? (
                    <Item
                        testID="team-member-add-search-empty"
                        title={t('teams.members.emptyTitle')}
                        subtitle={t('teams.members.emptyBody')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {search.status === 'error' ? (
                    <Item
                        testID={search.failure?.retryable
                            ? 'team-member-add-search-retry'
                            : 'team-member-add-search-unavailable'}
                        title={search.failure
                            ? teamReadFailureLabel(search.failure)
                            : t('teams.errors.generic')}
                        subtitleLines={0}
                        detail={search.failure?.retryable ? t('teams.unavailable.retry') : undefined}
                        onPress={search.failure?.retryable
                            ? () => setSearchRetry((value) => value + 1)
                            : undefined}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup>
                <SegmentedChoiceItem
                    title={t('teams.members.roleLabel')}
                    options={ADMISSIBLE_ROLES.map((candidate) => ({
                        id: candidate,
                        label: teamRoleLabel(candidate),
                        description: roleHelp(candidate),
                    }))}
                    value={role}
                    onChange={setRole}
                    testIDPrefix="team-member-add-role"
                    subtitleLines={0}
                />
            </ItemGroup>

            {historyChoiceAvailable ? (
                <ItemGroup
                    title={t('teams.history.label')}
                    description={t('teams.history.scopeNote')}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('teams.history.label')}
                >
                    <Item
                        testID="team-member-add-history:from_membership"
                        title={t('teams.history.fromMembershipNamed', { name: context.team.name })}
                        selected={historyAccess === 'from_membership'}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={historyAccess === 'from_membership'}
                        onPress={() => setHistoryAccess('from_membership')}
                        showChevron={false}
                    />
                    <Item
                        testID="team-member-add-history:all_existing"
                        title={t('teams.history.allExistingNamed', { name: context.team.name })}
                        selected={historyAccess === 'all_existing'}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={historyAccess === 'all_existing'}
                        onPress={() => setHistoryAccess('all_existing')}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup surface="none">
                <SectionButtonRow footnote={error} footnoteTone="danger" footnoteTestID="team-member-add-error">
                    <RoundButton
                        testID="team-member-add-submit"
                        size="small"
                        title={t('teams.members.addSubmit')}
                        loading={submitting}
                        disabled={!selected || submitting || !context.canMutate}
                        onPress={() => void submit()}
                    />
                </SectionButtonRow>
            </ItemGroup>
        </>
    );
});

export const TeamMemberAddScreen = React.memo(function TeamMemberAddScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.members.add')}
            description={t('teams.pages.addMember')}
        >
            {(context) => <AddMemberForm context={context} />}
        </TeamSection>
    );
});
