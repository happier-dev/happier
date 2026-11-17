import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { TeamSharedResourcesSummaryV1Schema, type TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';

import { TeamSharedResourcesView } from '@/components/settings/teams/TeamSharedResourcesSection';
import { ItemList } from '@/components/ui/lists/ItemList';

/**
 * Dev-only: the Team overview's "Shared with this Team" section (lab L12) in each summary state through
 * the real view. Counts mirror the lab overview: what Acme's members shared, one kind its owner could
 * not count. Rows open nothing here.
 */
const OVERVIEW = TeamSharedResourcesSummaryV1Schema.parse({ teamId: 'team-acme', kinds: [
  { kind: 'machines', status: 'available', count: 4 },
  { kind: 'machinePools', status: 'available', count: 1 },
  { kind: 'projectSources', status: 'available', count: 6 },
  { kind: 'sessions', status: 'available', count: 12 },
  { kind: 'credentials', status: 'available', count: 3 },
  { kind: 'savedSecrets', status: 'available', count: 2 },
  { kind: 'projectDocuments', status: 'available', count: 9 },
  { kind: 'workflows', status: 'available', count: 2 },
  { kind: 'prompts', status: 'available', count: 0 },
  { kind: 'discussions', status: 'unavailable', count: null, reason: 'discussions_unavailable' },
] }).kinds;
const NO_KINDS: readonly TeamSharedResourceSummaryRowV1[] = [];

export function TeamSharedSpecimen(props: Readonly<{ state: string | null }>) {
  const state = props.state ?? 'overview';
  const summary = React.useMemo(() => ({
    status: state === 'loading' ? 'loading' as const : state === 'failed' ? 'error' as const : 'ready' as const,
    kinds: state === 'overview' ? OVERVIEW : state === 'unknown' ? OVERVIEW.filter(row => row.kind === 'discussions' || row.kind === 'machines') : NO_KINDS,
    error: null,
    reload: async () => {},
  }), [state]);
  return (
    <View style={styles.root}>
      <View style={styles.frame}>
        <ItemList testID="team-shared-specimen">
          <TeamSharedResourcesView teamName="Acme" serverId="server-specimen" summary={summary}
            destinationOf={() => '/dev/team-shared'} onOpen={() => {}} />
        </ItemList>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, alignItems: 'center', backgroundColor: theme.colors.surface.base },
  frame: { flex: 1, width: '100%', maxWidth: 1440 },
}));
