import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { resolveTeamsCreateGuidance } from '@/components/settings/teams/collection/teamsCreateGuidance';
import { teamsCreateRefusalText } from '@/components/settings/teams/collection/teamsCreateGuidanceText';
import { TeamSection } from '@/components/settings/teams/TeamSection';
import { teamsCreatePath } from '@/components/settings/teams/teamsRoutes';
import { TeamInvitationForm } from '@/components/settings/teams/invitations/TeamInvitationCreateScreen';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { NavigationHeaderActions } from '@/components/ui/layout/NavigationHeaderActions';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { useHomeGovernanceEligibilitySnapshots } from '@/hooks/home/useHomeGovernanceEligibilitySnapshots';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import type { HomeAdministrationContext } from './homeAdministrationContext';

export type HomeInvitePeopleDialogProps = CustomModalInjectedProps & Readonly<{
    serverId: string;
    /**
     * Opened from one Team's own page (its Overview or Members): that Team is the only one to
     * invite to, so the dialog renders its invitation form directly instead of asking which Team.
     */
    teamId?: string;
}>;

/**
 * "Invite people" (plan §3.10, R9; lab `hcTeams-I`): the one dialog that Overview, People and Teams
 * all open. A Home admits people only through a Team invitation, so the dialog owns no invitation of
 * its own: it chooses the Team — none to choose when the viewer can invite to exactly one, as on a
 * Personal Home — and renders that Team's invitation form (`TeamInvitationForm`), with the Team's own
 * conditions (`TeamSection`, embedded).
 */
export const HomeInvitePeopleDialog = React.memo(function HomeInvitePeopleDialog(props: HomeInvitePeopleDialogProps) {
    // The Team is fixed for the dialog's lifetime, so the two compositions never swap in place.
    return props.teamId
        ? <TeamInvitePeople serverId={props.serverId} teamId={props.teamId} />
        : <HomeInvitePeopleChooser {...props} />;
});

/** The invitation form of one known Team, with that Team's own conditions (embedded `TeamSection`). */
const TeamInvitePeople = React.memo(function TeamInvitePeople(props: Readonly<{ serverId: string; teamId: string }>) {
    return (
        <ItemList presentation="grouped" style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled" testID="home-invite-people">
            <TeamSection serverId={props.serverId} teamId={props.teamId} presentation="embedded">
                {(context) => <TeamInvitationForm context={context} />}
            </TeamSection>
        </ItemList>
    );
});

const HomeInvitePeopleChooser = React.memo(function HomeInvitePeopleChooser(props: HomeInvitePeopleDialogProps) {
    const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
    const directory = useTeamsDirectory({ scope: 'administered', serverIds });
    // Only active Teams whose projected capabilities back an invitation are offered.
    const teams = React.useMemo(
        () => directory.rows.filter((row) => row.team.archivedAt === null && row.team.capabilities.manageInvitations),
        [directory.rows],
    );
    const governedTeams = directory.rows.filter((row) => row.team.archivedAt === null).length;
    const creation = useTeamCreationOffer(props.serverId, directory.scopes);
    const router = useRouter();
    const { onClose } = props;
    const createTeam = React.useCallback(() => {
        onClose();
        router.push(teamsCreatePath({ administrationServerId: props.serverId }) as never);
    }, [onClose, props.serverId, router]);
    const [chosenTeamId, setChosenTeamId] = React.useState<string | null>(null);
    const selected = teams.length === 1
        ? teams[0]!
        : teams.find((row) => row.address.teamId === chosenTeamId) ?? null;
    const loading = directory.kind === 'loading'
        && directory.rows.length === 0
        && directory.unavailableHomes.every((home) => home.reason === 'loading');
    const failed = !loading && directory.rows.length === 0 && directory.partial;

    return (
        <ItemList presentation="grouped" style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled" testID="home-invite-people">
            {loading ? (
                <ItemGroup>
                    <ItemLoadStateRows testID="home-invite-people-teams-loading" state={{ kind: 'loading' }} rows={1} lines={1} />
                </ItemGroup>
            ) : failed ? (
                <ItemGroup>
                    <ItemLoadStateRows
                        testID="home-invite-people-teams-failed"
                        state={{
                            kind: 'failed',
                            reason: t('homeGovernance.invite.teamsFailed'),
                            onRetry: directory.refresh,
                            homeServerIds: serverIds,
                        }}
                    />
                </ItemGroup>
            ) : teams.length === 0 && governedTeams > 0 ? (
                // The Home has Teams, but a Team's own owners and admins are who invite to it.
                <ItemGroup description={creation.kind === 'can_create'
                    ? t('homeGovernance.invite.notAdministeredBody')
                    : [t('homeGovernance.invite.notAdministeredAskBody'), creation.kind === 'refused' ? creation.reason : null].filter(Boolean).join(' ')}>
                    <Item
                        testID="home-invite-people-not-administered"
                        title={t('homeGovernance.invite.notAdministered')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : teams.length === 0 ? (
                <ItemGroup description={creation.kind === 'can_create'
                    ? t('homeGovernance.invite.noTeamsBody')
                    : [t('homeGovernance.invite.joinByTeam'), creation.kind === 'refused' ? creation.reason : null].filter(Boolean).join(' ')}>
                    <Item
                        testID="home-invite-people-no-teams"
                        title={t('homeGovernance.invite.noTeams')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : teams.length > 1 ? (
                <ItemGroup
                    title={t('homeGovernance.invite.team')}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('homeGovernance.invite.team')}
                >
                    {teams.map((row) => (
                        <Item
                            key={row.address.teamId}
                            testID={`home-invite-people-team:${row.address.teamId}`}
                            title={row.team.name}
                            selected={row.address.teamId === selected?.address.teamId}
                            accessibilityRole="radio"
                            webRole="radio"
                            accessibilityChecked={row.address.teamId === selected?.address.teamId}
                            onPress={() => setChosenTeamId(row.address.teamId)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {teams.length === 0 && !loading && !failed && creation.kind === 'can_create' ? (
                // Nothing to invite to here: the next step is a Team of the viewer's own.
                <ItemGroup surface="none">
                    <SectionButtonRow>
                        <RoundButton
                            testID="home-invite-people-create-team"
                            size="small"
                            title={t('homeGovernance.invite.createTeam')}
                            onPress={createTeam}
                        />
                    </SectionButtonRow>
                </ItemGroup>
            ) : null}

            {selected ? (
                // Keyed by Team: another Team is another invitation, so its draft and bearer never carry over.
                <TeamSection
                    key={selected.address.teamId}
                    serverId={props.serverId}
                    teamId={selected.address.teamId}
                    presentation="embedded"
                >
                    {(context) => <TeamInvitationForm context={context} />}
                </TeamSection>
            ) : null}
        </ItemList>
    );
});

type TeamCreationOffer =
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'can_create' }>
    | Readonly<{ kind: 'refused'; reason: string }>;

/**
 * Whether the viewer can create a Team on this Home, and if not why and who can: the Home's current
 * eligibility answer through the Teams page's own guidance owner, so the dialog never offers a
 * creation the Home would refuse. `unknown` until the Home has answered.
 */
function useTeamCreationOffer(
    serverId: string,
    scopes: ReturnType<typeof useTeamsDirectory>['scopes'],
): TeamCreationOffer {
    const eligibility = useHomeGovernanceEligibilitySnapshots(scopes);
    const snapshot = eligibility.snapshotsByServerId.get(serverId);
    const answer = snapshot?.status === 'ready' && !snapshot.stale && snapshot.data?.teamsEnabled === true ? snapshot.data : null;
    if (!answer) return { kind: 'unknown' };
    if (answer.createTeam) return { kind: 'can_create' };
    const { refusal } = resolveTeamsCreateGuidance({
        homesInView: 1,
        answers: [{ serverId, homeName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId), eligibility: answer }],
    });
    return refusal ? { kind: 'refused', reason: teamsCreateRefusalText(refusal) } : { kind: 'unknown' };
}

/** Shows the dialog; focus goes back to `focusReturnRef` (the action that opened it) when it closes. */
export function presentHomeInvitePeople(input: Readonly<{
    serverId: string;
    /** Invite to this Team (a Team page's own action) rather than choosing among the Home's Teams. */
    teamId?: string;
    focusReturnRef?: FocusReturnRef;
}>): string {
    return Modal.show({
        component: HomeInvitePeopleDialog,
        props: { serverId: input.serverId, ...(input.teamId ? { teamId: input.teamId } : {}) },
        ...(input.focusReturnRef ? { focusReturnRef: input.focusReturnRef } : {}),
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            title: t('homeGovernance.invite.action'),
            subtitle: t('homeGovernance.invite.description'),
            dimensions: { width: 480 },
            testID: 'home-invite-people-dialog',
        },
    });
}

/**
 * Whether this viewer can invite people from the console: Teams are on and the viewer governs this
 * Home's Teams. Which Team, and whether that Team admits an invitation, is the dialog's to say.
 */
export function canInvitePeople(context: HomeAdministrationContext): boolean {
    return context.projection.teamsEnabled && context.projection.capabilities.manageAllTeams;
}

/** The page action that opens the dialog (Overview and People; Teams makes it its primary). */
export const HomeInvitePeopleButton = React.memo(function HomeInvitePeopleButton(props: Readonly<{
    context: HomeAdministrationContext;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    if (!canInvitePeople(props.context)) return null;
    const serverId = props.context.scope.serverId;
    const open = () => { presentHomeInvitePeople({ serverId }); };
    // On a phone the page's action goes to the navigation header, so the Home's name keeps the width.
    if (chromeShowsTitle) {
        return <NavigationHeaderActions primary={{ title: t('homeGovernance.invite.action'), onPress: open, testID: props.testID }} />;
    }
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="secondary"
            title={t('homeGovernance.invite.action')}
            leading={<Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
            onPress={open}
        />
    );
});
