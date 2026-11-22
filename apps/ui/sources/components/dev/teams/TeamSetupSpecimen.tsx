import * as React from 'react';
import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { projectSourceOnboardingTaskReferenceV1 } from '@happier-dev/protocol/projects/sources/projectSourceOnboardingTaskV1';

import { HubSetupGridView } from '@/components/hub/HubSetupSection';
import { TeamSetupTile } from '@/components/hub/setup/useTeamSetupItems';
import { UnauthenticatedRouteShell } from '@/components/onboarding/unauthShell';
import { WelcomeActionList, type WelcomeActionAdmission } from '@/components/onboarding/preAuth/WelcomeActionList';
import { TeamSectionPageHeader } from '@/components/settings/teams/TeamSection';
import { TeamNewMembersSourcesView } from '@/components/settings/teams/newMembers/TeamNewMembersSources';
import { TeamInvitationJoinActions, TeamInvitationOffer } from '@/components/teams/entry/TeamInvitationOffer';
import { TeamSetupHeader, TeamSetupPageView } from '@/components/teams/setup/TeamSetupScreen';
import { ItemList } from '@/components/ui/lists/ItemList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { savedSecretShareDisclosureMessage } from '@/components/sharing/secrets/savedSecretShareDisclosure';
import { TeamJoinedContent } from '@/components/teams/join/TeamJoinedContent';
import { buildTeamJoinedSummaryRows, TeamJoinedSummaryView } from '@/components/teams/join/TeamJoinedSummary';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';
import { machineSetupPreparedReviewFixture } from '@/dev/testkit/fixtures/machineSetupReviewFixtures';
import {
  teamCredentialCatalogEntryFixture,
  teamInvitationPreviewFixture,
  teamProjectSourceFixture,
  teamSummaryFixture,
} from '@/dev/testkit/fixtures/teamFixtures';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * Dev-only specimen of plan D's Team setup states, drawn by the real owners over fixtures (nothing is read
 * or written). `?frame=joined` (default): the Joined page with what the Team shares. `?frame=tile`: Home's
 * Get set up with a "Set up for {team}" block. `?frame=disclosure`: the confirmation before sharing a
 * vault reference with a Team. `?frame=invitation`: the open invitation a signed-in invitee sees.
 * `?frame=setup`: "Set up for {team}" with a preset review, three repositories and two shared keys.
 * `?frame=setupDone`: the same page once set up, offering the Team's first task.
 * `?frame=newMembers`: an administrator's "What new members get" Sources and first task (the
 * member-defaults editor reads live settings and is not drawn here). Never linked from product surfaces.
 */
const noop = () => {};
const TEAM = teamSummaryFixture({ id: 'specimen-acme', name: 'Acme' });
/** The Home that holds the Team, named apart from it so the header's facts line reads both. */
const HOME_NAME = 'Acme’s Home';

const SUMMARY_ROWS = buildTeamJoinedSummaryRows({
  teamName: TEAM.name,
  presetName: 'Acme dev box',
  sourceNames: ['acme/web', 'acme/api', 'acme/design-system'],
  kinds: [
    { kind: 'sessions', status: 'available', count: 14 },
    { kind: 'machinePresets', status: 'available', count: 1 },
    { kind: 'projectSources', status: 'available', count: 4 },
    { kind: 'credentials', status: 'available', count: 3 },
  ],
});

const VAULT_REFERENCE = {
  kind: 'external',
  contribution: { pluginId: 'onepassword', contributionId: 'onepassword' },
  account: 'acme.1password.com',
  reference: 'op://Dev/Mapbox/token',
  metadata: { vault: { id: 'dev', name: 'Dev' }, item: { id: 'mapbox', title: 'Mapbox' }, field: { id: 'token', title: 'token' } },
} as unknown as SavedSecretExternalSourceV1;

function JoinedFrame() {
  return (
    <UnauthenticatedRouteShell testID="team-setup-specimen-joined" stepId="admission-complete" onBack={noop}>
      <TeamJoinedContent
        result={{ outcome: 'joined', teamId: TEAM.id }}
        teamName={TEAM.name}
        accountScope={null}
        onOpenTeam={noop}
        setupContinuation={{ label: t('teams.join.setUpForTeam', { team: TEAM.name }), onContinue: noop }}
        summary={<TeamJoinedSummaryView testID="team-setup-specimen-summary" rows={SUMMARY_ROWS} />}
      />
    </UnauthenticatedRouteShell>
  );
}

const HOME_ID = 'specimen-home';
const ADDRESS = { serverId: HOME_ID, teamId: TEAM.id };
const IDLE_ADMISSION: WelcomeActionAdmission = {
  pendingActionId: null,
  run: async (_id, action) => { await action(); },
};

const INVITATION = {
  kind: 'ready' as const,
  preview: teamInvitationPreviewFixture({
    inviterLabel: 'Maya Chen',
    recipientEmailMask: 'l***@acme.dev',
    team: { teamId: TEAM.id, name: TEAM.name },
    home: { serverId: HOME_ID, displayName: HOME_NAME },
  }),
};

function InvitationFrame() {
  return (
    <UnauthenticatedRouteShell testID="team-setup-specimen-invitation" stepId="team-auth-entry:ready" onBack={noop}>
      <TeamInvitationOffer
        testID="team-auth-entry-ready"
        teamId={TEAM.id}
        teamName={TEAM.name}
        logo={null}
        previewState={INVITATION}
        homeLabel="Acme"
        signedIn
        accountLabel="Leo Martin"
        statusLine={null}
        onRetryPreview={noop}
        actions={(
          <WelcomeActionList admission={IDLE_ADMISSION}>
            <TeamInvitationJoinActions
              joinTitle={t('teams.join.joinAction', { team: TEAM.name })}
              onJoin={noop}
              offered
              onUseAnotherAccount={noop}
            />
          </WelcomeActionList>
        )}
      />
    </UnauthenticatedRouteShell>
  );
}

const MACHINE_ID = 'specimen-devbox';
const MACHINE_LABEL = 'leo-mbp';
const SELECTION = createMachineAdministrationTargetSelectionFixture({
  serverId: HOME_ID,
  machines: [{ machineId: MACHINE_ID, displayName: MACHINE_LABEL, homeDir: '/Users/leo' }],
  selectedMachineId: MACHINE_ID,
});
const REPOSITORIES = [
  teamProjectSourceFixture({ id: 'acme-web', name: 'Web', nameWithOwner: 'acme/web', teamId: TEAM.id, firstTask: true }),
  teamProjectSourceFixture({ id: 'acme-api', name: 'API', nameWithOwner: 'acme/api', teamId: TEAM.id }),
  teamProjectSourceFixture({ id: 'acme-design', name: 'Design system', nameWithOwner: 'acme/design-system', teamId: TEAM.id }),
];
const SHARED_KEYS = [
  teamCredentialCatalogEntryFixture({ id: 'key-claude', teamId: TEAM.id, displayName: 'Claude Enterprise' }),
  teamCredentialCatalogEntryFixture({ id: 'key-mapbox', teamId: TEAM.id, displayName: 'Mapbox token' }),
];
const KEY_NAMES = { 'key-claude': 'Claude Enterprise', 'key-mapbox': 'Mapbox token' };
const MACHINE_PLAN = {
  key: 'specimen',
  plan: { target: { serverId: HOME_ID, homeId: 'home', machineId: MACHINE_ID }, machine: machineSetupPreparedReviewFixture({ machineId: MACHINE_ID }), repositories: [] },
  failure: null,
};
const NO_EXCLUSIONS: ReadonlySet<string> = new Set();
const SOURCES_READY = { loading: false, failure: null, onRetry: noop };

/** `setup`: the plan as a returning member sees it after the Team's preset moved on and one clone was found. */
const ADOPTED: ReadonlyMap<string, string> = new Map([['acme-api', '/Users/leo/code/acme-api']]);

function SetupFrame(props: Readonly<{ done?: boolean }>) {
  return (
    <ItemList pageColumn="wide">
      <TeamSetupPageView
        header={<TeamSetupHeader context={{ team: TEAM, address: ADDRESS, homeName: HOME_NAME }} lead />}
        teamName={TEAM.name}
        selection={SELECTION}
        machineId={MACHINE_ID}
        machineLabel={MACHINE_LABEL}
        homeDir="/Users/leo"
        run={props.done ? { kind: 'done', operationId: null, completed: true } : { kind: 'idle' }}
        canRun={!props.done}
        onRun={noop}
        onOpenOperation={noop}
        sources={SOURCES_READY}
        hasPreset
        machinePlan={MACHINE_PLAN}
        repositories={REPOSITORIES}
        repositoryFreeSources={[]}
        excluded={NO_EXCLUSIONS}
        onToggleRepository={noop}
        batch={null}
        sharedKeys={SHARED_KEYS}
        keyDisplayNames={KEY_NAMES}
        firstTask={props.done ? {
          title: 'Fix the flaky cart test',
          markdown: 'Read through acme/web’s checkout flow and fix the flaky “cart keeps its items after sign-in” test. The failing run is linked in #1482.',
          repositoryName: 'acme/web',
          onOpen: noop,
        } : null}
        presetChange={props.done ? null : { revision: 7, onReview: noop }}
        clones={{ onFind: noop, searching: false, folder: '/Users/leo/code', adopted: ADOPTED, failure: null, noneFound: false }}
      />
    </ItemList>
  );
}

const NEW_MEMBER_ROWS = REPOSITORIES.map((source) => ({
  source,
  taskReference: projectSourceOnboardingTaskReferenceV1({ serverId: HOME_ID, source }),
}));

function NewMembersFrame() {
  return (
    <ItemList>
      <TeamSectionPageHeader
        title={t('teams.newMembers.title')}
        description={t('teams.newMembers.description')}
        teamName={TEAM.name}
        homeName={HOME_NAME}
      />
      <TeamNewMembersSourcesView
        teamName={TEAM.name}
        rows={NEW_MEMBER_ROWS}
        loading={false}
        failed={false}
        homeServerId={HOME_ID}
      />
    </ItemList>
  );
}

function TileFrame() {
  const phone = useDeviceType() === 'phone';
  const items = React.useMemo(() => [{
    id: 'team:specimen',
    renderTile: () => (
      <TeamSetupTile
        offer={{ stepId: 'team:specimen', address: { serverId: 'specimen-home', teamId: TEAM.id }, teamName: TEAM.name, logo: null }}
        layout={phone ? 'row' : 'card'}
        onSetUp={noop}
        onDismiss={noop}
      />
    ),
  }], [phone]);
  return <PageFrame><HubSetupGridView items={items} phone={phone} /></PageFrame>;
}

function DisclosureFrame() {
  const open = React.useCallback(() => {
    void Modal.confirm(
      t('secrets.catalog.shareDisclosureTitle'),
      savedSecretShareDisclosureMessage(VAULT_REFERENCE, '1Password'),
      {
        cancelText: t('common.cancel'),
        confirmText: t('secrets.catalog.shareDisclosureConfirm', {
          target: t('secrets.catalog.shareDisclosureTargetCount', { count: 1 }),
        }),
      },
    );
  }, []);
  // The specimen exists to show this dialog, so it opens as the frame mounts.
  React.useEffect(() => { open(); }, [open]);
  return <PageFrame><RoundButton title={t('secrets.catalog.shareDisclosureTitle')} onPress={open} /></PageFrame>;
}

export function TeamSetupSpecimen(props: Readonly<{ frame?: string }>) {
  switch (props.frame) {
    case 'tile': return <TileFrame />;
    case 'disclosure': return <DisclosureFrame />;
    case 'invitation': return <InvitationFrame />;
    case 'setup': return <SetupFrame />;
    case 'setupDone': return <SetupFrame done />;
    case 'newMembers': return <NewMembersFrame />;
    default: return <JoinedFrame />;
  }
}
