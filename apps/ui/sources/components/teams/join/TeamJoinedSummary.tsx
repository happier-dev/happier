import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';

import {
  useTeamSetupResources,
  type TeamSetupResourceContext,
} from '@/components/teams/setup/useTeamSetupResources';
import { TEAM_SHARED_KIND_PRESENTATION } from '@/components/settings/teams/shared/teamSharedKindPresentation';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

type SummaryKind =
  | 'sessions'
  | 'machinePresets'
  | 'projectSources'
  | 'credentials';
const SUMMARY_KINDS: readonly SummaryKind[] = [
  'sessions',
  'machinePresets',
  'projectSources',
  'credentials',
];
const ICONS: Record<SummaryKind, IconName> = {
  sessions: 'chat-circle',
  machinePresets: 'file-text',
  projectSources: 'git-branch',
  credentials: 'key',
};
const NAMED_SOURCES = 3;
/** The kind's name alone, for a row whose owner could not count it. */
const UNAVAILABLE_TITLE: Record<SummaryKind, () => string> = {
  sessions: () => t('teams.join.summary.sessionsUnavailable'),
  machinePresets: () => t('teams.join.summary.machinePresetsUnavailable'),
  projectSources: () => t(TEAM_SHARED_KIND_PRESENTATION.projectSources.title),
  credentials: () => t('teams.join.summary.credentialsUnavailable'),
};

function findKind(
  kinds: readonly TeamSharedResourceSummaryRowV1[],
  kind: SummaryKind,
) {
  return kinds.find((row) => row.kind === kind) ?? null;
}

/**
 * "What you get" after joining (plan D, L1 Joined): what the Team already shares with this member,
 * read from F's summary projection after admission. A kind the Team shares nothing of is left out;
 * a kind its owner could not read says so in its row rather than disappearing. The Machine setup is
 * named once its own owner opens it, and the Project Sources by their names.
 */
export const TeamJoinedSummary = React.memo(function TeamJoinedSummary(
  props: Readonly<{
    testID: string;
    context: TeamSetupResourceContext;
  }>,
) {
  const { theme } = useUnistyles();
  const resources = useTeamSetupResources(props.context);
  const { kinds, status } = resources.sharedResources;
  const presetName =
    resources.preset?.state.value && 'name' in resources.preset.state.value
      ? String(resources.preset.state.value.name)
      : null;
  const sourceNames = React.useMemo(
    () =>
      resources.sources.state.rows
        .slice(0, NAMED_SOURCES)
        .map((source) => source.name),
    [resources.sources.state.rows],
  );

  const rows = SUMMARY_KINDS.flatMap<Readonly<{
    kind: SummaryKind; title: string; detail: string | null; count?: number;
  }>>((kind) => {
    const row = findKind(kinds, kind);
    if (!row) return [];
    if (row.status === 'unavailable') {
      return [
        {
          kind,
          title: UNAVAILABLE_TITLE[kind](),
          detail: t('teams.join.summary.unavailable'),
        },
      ];
    }
    if (row.count === 0) return [];
    switch (kind) {
      case 'sessions':
        return [
          {
            kind,
            title: t('teams.join.summary.sessions', { count: row.count }),
            detail: t('teams.join.summary.sessionsDetail'),
          },
        ];
      case 'machinePresets':
        return [
          {
            kind,
            title:
              presetName ??
              t('teams.join.summary.presets', { count: row.count }),
            detail: t('teams.join.summary.presetsDetail'),
          },
        ];
      case 'projectSources': {
        const named = sourceNames.join(', ');
        const detail =
          named && row.count > sourceNames.length ? `${named}, …` : named;
        return [
          {
            kind,
            title: t(TEAM_SHARED_KIND_PRESENTATION.projectSources.title),
            detail: detail || null,
            count: row.count,
          },
        ];
      }
      case 'credentials':
        return [
          {
            kind,
            title: t('teams.join.summary.keys', { count: row.count }),
            detail: t('teams.join.summary.keysDetail', {
              team: props.context.team.name,
            }),
          },
        ];
    }
  });

  // The summary is shown whole once it answers, never row by row: one height change, not five.
  if (status !== 'ready' || rows.length === 0) return null;
  return (
    <ItemGroup
      testID={props.testID}
      surface="none"
      title={t('teams.join.summary.title')}
    >
      {rows.map((row) => (
        <Item
          key={row.kind}
          testID={`${props.testID}-${row.kind}`}
          density="tight"
          icon={
            <Icon
              name={ICONS[row.kind]}
              size={18}
              color={theme.colors.text.secondary}
            />
          }
          title={row.title}
          subtitle={row.detail ?? undefined}
          detail={row.count === undefined ? undefined : String(row.count)}
          showChevron={false}
        />
      ))}
    </ItemGroup>
  );
});

/**
 * The Joined page knows only the admitted Team's address; the Team's own binding supplies its
 * summary record. Nothing renders until the exact Home/Account that admitted the person is bound
 * and is the one whose demand lifetime is active, so no read is issued for another Account.
 */
export function TeamJoinedSummaryForTeam(props: Readonly<{
  testID: string;
  serverId: string;
  teamId: string;
}>) {
  const binding = useTeamBinding(props.serverId, props.teamId);
  const lifetime = useActiveServerAccountScopeLifetime();
  if (binding.kind !== 'bound' || binding.state.kind !== 'ready' || !lifetime) return null;
  if (!areServerAccountScopesEqual(lifetime.scope, binding.scope)) return null;
  return (
    <TeamJoinedSummary
      testID={props.testID}
      context={{ scope: binding.scope, address: binding.address, team: binding.state.team, lifetime }}
    />
  );
}
