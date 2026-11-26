import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';

import {
  useTeamSetupResourceSummary,
  type TeamSetupResourceContext,
} from '@/components/teams/setup/useTeamSetupResources';
import { TEAM_SHARED_KIND_PRESENTATION } from '@/components/settings/teams/shared/teamSharedKindPresentation';
import { TeamReadFailureRows } from '@/components/settings/teams/TeamReadFailureRows';
import { TeamSetupOtherAccountNotice } from '@/components/teams/setup/TeamSetupOtherAccountNotice';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
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
export type TeamJoinedSummaryRow = Readonly<{ kind: SummaryKind; title: string; detail: string | null }>;

/** What the Team already shares, as rows: a kind it shares nothing of is left out; one its owner could not read says so. */
export function buildTeamJoinedSummaryRows(input: Readonly<{
  kinds: readonly TeamSharedResourceSummaryRowV1[];
  presetName: string | null;
  sourceNames: readonly string[];
  teamName: string;
}>): readonly TeamJoinedSummaryRow[] {
  return SUMMARY_KINDS.flatMap((kind): TeamJoinedSummaryRow[] => {
    const row = findKind(input.kinds, kind);
    if (!row) return [];
    if (row.status === 'unavailable') {
      return [{ kind, title: UNAVAILABLE_TITLE[kind](), detail: t('teams.join.summary.unavailable') }];
    }
    if (row.count === 0) return [];
    switch (kind) {
      case 'sessions':
        return [{ kind, title: t('teams.join.summary.sessions', { count: row.count }), detail: t('teams.join.summary.sessionsDetail') }];
      case 'machinePresets':
        return [{ kind, title: input.presetName ?? t('teams.join.summary.presets', { count: row.count }), detail: t('teams.join.summary.presetsDetail') }];
      case 'projectSources': {
        const named = input.sourceNames.join(', ');
        const detail = named && row.count > input.sourceNames.length ? `${named}, …` : named;
        return [{ kind, title: t('teams.join.summary.projectSources', { count: row.count }), detail: detail || null }];
      }
      case 'credentials':
        return [{ kind, title: t('teams.join.summary.keys', { count: row.count }), detail: t('teams.join.summary.keysDetail', { team: input.teamName }) }];
    }
  });
}

const NO_ROWS: readonly TeamJoinedSummaryRow[] = Object.freeze([]);

/**
 * The rows drawn as one quiet group between the name field and the way on. When a setup read could not answer,
 * its owner's typed state stands in the group's place, so the name field and both ways on keep where they are.
 */
export const TeamJoinedSummaryView = React.memo(function TeamJoinedSummaryView(props: Readonly<{
  testID: string;
  rows: readonly TeamJoinedSummaryRow[];
  /** What could not be read, said by its owner (plan D L1: a typed unavailable state, never nothing). */
  condition?: React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  if (props.rows.length === 0 && !props.condition) return null;
  return (
    // The Joined column owns its padding: in a contained scope the section's title and its rows' marks keep
    // that column's edge, the one the heading, hairline and primary stand on (lab L1-joinedP).
    <ListPresentationProvider value="page" pageInsets="contained">
    <ItemGroup testID={props.testID} surface="none" constrainToContentWidth={false} title={t('teams.join.summary.title')}>
      {props.condition}
      {props.rows.map((row) => (
        <Item
          key={row.kind}
          testID={`${props.testID}-${row.kind}`}
          icon={<Icon name={ICONS[row.kind]} size={20} color={theme.colors.text.secondary} />}
          title={row.title}
          subtitle={row.detail ?? undefined}
          showChevron={false}
          // A short list read at a glance (lab L1-joinedP): rows stand apart by rhythm, not hairlines.
          showDivider={false}
        />
      ))}
    </ItemGroup>
    </ListPresentationProvider>
  );
});

type JoinedReadFailure = Readonly<{
  failure: HomeDomainFailure<string> | ScopedSnapshotError;
  retry: () => void | Promise<unknown>;
  address: TeamAddress;
}>;

/**
 * A failed read keeps its place while it is asked again, so Retry never leaves a gap that the next answer
 * fills back in. A new answer (rows or another failure) replaces it; a settled state without one clears it.
 */
function useHeldWhileAskingAgain<T>(value: T | null, askingAgain: boolean): T | null {
  const held = React.useRef<T | null>(null);
  if (value !== null) held.current = value;
  else if (!askingAgain) held.current = null;
  return value ?? held.current;
}

function JoinedReadFailure(props: Readonly<{ testID: string; read: JoinedReadFailure }>) {
  return (
    <TeamReadFailureRows testID={props.testID} failure={props.read.failure} onRetry={props.read.retry}
      address={props.read.address} serverId={props.read.address.serverId} />
  );
}

export const TeamJoinedSummary = React.memo(function TeamJoinedSummary(
  props: Readonly<{
    testID: string;
    context: TeamSetupResourceContext;
  }>,
) {
  const resources = useTeamSetupResourceSummary(props.context);
  const { kinds, status, error, reload } = resources.sharedResources;
  const presetName =
    resources.preset?.state.value && 'name' in resources.preset.state.value
      ? String(resources.preset.state.value.name)
      : null;
  const sourceRows = resources.sources.state.rows;
  const rows = React.useMemo(() => buildTeamJoinedSummaryRows({
    kinds, presetName, teamName: props.context.team.name,
    sourceNames: sourceRows.slice(0, NAMED_SOURCES).map((source) => source.name),
  }), [kinds, presetName, props.context.team.name, sourceRows]);
  const { address } = props.context;
  const failed = React.useMemo(() => status === 'error' && error ? { failure: error, retry: reload, address } : null,
    [address, error, reload, status]);
  const read = useHeldWhileAskingAgain(failed, status === 'loading');
  // Keep the Home owner's retained rows at the same height while it refreshes them; the summary otherwise
  // appears whole once it answers, as one height change.
  if (!read && status !== 'ready' && status !== 'refreshing') return null;
  return (
    <TeamJoinedSummaryView testID={props.testID} rows={rows}
      condition={read ? <JoinedReadFailure testID={`${props.testID}-failed`} read={read} /> : undefined} />
  );
});

/**
 * The Joined page knows only the admitted Team's address; the Team's own binding supplies its
 * summary record. No read is issued until the exact Home/Account that admitted the person is the one
 * whose demand lifetime is active. While another Account is active, or the Team read itself is refused,
 * the summary's place says so with that owner's typed state; the name and Open Team never wait on it.
 */
export function TeamJoinedSummaryForTeam(props: Readonly<{
  testID: string;
  scope: ServerAccountScope;
  teamId: string;
}>) {
  const lifetime = useActiveServerAccountScopeLifetime();
  const admittedLifetime = lifetime && areServerAccountScopesEqual(lifetime.scope, props.scope) ? lifetime : null;
  const binding = useTeamBinding(admittedLifetime ? props.scope.serverId : '', props.teamId);
  const bound = binding.kind === 'bound' ? binding : null;
  const refused = React.useMemo(() => bound?.state.kind === 'unavailable'
    ? { failure: bound.state.error, retry: bound.refresh, address: bound.address } : null, [bound]);
  const teamRead = useHeldWhileAskingAgain(refused, binding.kind === 'resolving'
    || bound?.state.kind === 'loading' || bound?.state.kind === 'unobserved');
  // Another Account is active, or this Home's credential is now another Account's: the setup is not this one's to read.
  if ((lifetime && !admittedLifetime) || (bound && !areServerAccountScopesEqual(props.scope, bound.scope))) {
    return <TeamJoinedSummaryView testID={props.testID} rows={NO_ROWS}
      condition={<TeamSetupOtherAccountNotice testID={`${props.testID}-other-account`} />} />;
  }
  if (teamRead) {
    return <TeamJoinedSummaryView testID={props.testID} rows={NO_ROWS}
      condition={<JoinedReadFailure testID={`${props.testID}-failed`} read={teamRead} />} />;
  }
  if (!bound || bound.state.kind !== 'ready' || !admittedLifetime) return null;
  return (
    <TeamJoinedSummary
      testID={props.testID}
      context={{ scope: bound.scope, address: bound.address, team: bound.state.team, lifetime: admittedLifetime }}
    />
  );
}
