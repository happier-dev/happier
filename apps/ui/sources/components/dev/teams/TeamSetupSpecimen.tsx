import * as React from 'react';
import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { HubSetupGridView } from '@/components/hub/HubSetupSection';
import { TeamSetupTile } from '@/components/hub/setup/useTeamSetupItems';
import { UnauthenticatedRouteShell } from '@/components/onboarding/unauthShell';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { savedSecretShareDisclosureMessage } from '@/components/sharing/secrets/savedSecretShareDisclosure';
import { TeamJoinedContent } from '@/components/teams/join/TeamJoinedContent';
import { buildTeamJoinedSummaryRows, TeamJoinedSummaryView } from '@/components/teams/join/TeamJoinedSummary';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * Dev-only specimen of plan D's Team setup states, drawn by the real owners over fixtures (nothing is read
 * or written). `?frame=joined` (default): the Joined page with what the Team shares. `?frame=tile`: Home's
 * Get set up with a "Set up for {team}" block. `?frame=disclosure`: the confirmation before sharing a
 * vault reference with a Team. Never linked from product surfaces.
 */
const noop = () => {};
const TEAM = teamSummaryFixture({ id: 'specimen-acme', name: 'Acme' });

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
    default: return <JoinedFrame />;
  }
}
