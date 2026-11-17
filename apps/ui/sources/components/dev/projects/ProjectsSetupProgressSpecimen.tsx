import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { ProjectsTreeList } from '@/components/projects/ProjectsTree';
import type { ProjectsTreeRow } from '@/components/projects/projectsTreeRows';
import { Text } from '@/components/ui/text/Text';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import {
  useActiveServerAccountScope,
  useAllMachines,
} from '@/sync/domains/state/storage';

const OPERATION = 'projects-setup-progress-specimen';

/**
 * Dev-only: the Projects column's ambient setup progress (lab L3 projects) through the real `ProjectsTreeList`. acme/web
 * names its Source and has a checkout on one of this Home's Machines, and a running Project Open for that Source sits in
 * the real operation store, so its row end is what `ProjectsTreeRowAttention` derives from that run. The person's own
 * Projects are quiet. Nothing here sends an Action.
 */
export function ProjectsSetupProgressSpecimen() {
  const scope = useActiveServerAccountScope();
  const machineId = useAllMachines(
    (machines) =>
      (machines.find((machine) => !machine.active) ?? machines[0])?.id ?? null,
  );
  React.useEffect(() => {
    if (!scope || !machineId) return;
    const now = Date.now();
    const snapshot = {
      version: 1,
      operationId: OPERATION,
      revision: Math.floor(now / 1000),
      actionId: 'projects.open',
      state: 'running',
      scope: { accountId: scope.accountId, machineId },
      title: 'Open acme/web',
      createdAt: now - 40_000,
      startedAt: now - 39_000,
      cancellation: 'unsupported',
      domainRef: { kind: 'projectOpen', sourceId: 'acme-web-specimen' },
    } as ActionOperationSnapshotV1;
    actionOperationStore.mergeSnapshots({
      serverId: scope.serverId,
      snapshots: [snapshot],
    });
  }, [machineId, scope]);
  const rows = React.useMemo((): readonly ProjectsTreeRow[] | null => {
    if (!scope || !machineId) return null;
    const row = (
      key: string,
      title: string,
      team: string | null,
    ): ProjectsTreeRow => ({
      key,
      level: 0,
      kind: 'project',
      title,
      titleQualifier: team,
      glyph: 'project',
      expandable: true,
      expanded: false,
      attention: null,
      selected: key === 'happier',
    });
    return [
      {
        ...row('acme-web', 'acme/web', 'Acme'),
        machineId,
        source: {
          serverId: scope.serverId,
          source: {
            id: 'acme-web-specimen',
            revision: 1,
            name: 'acme/web',
            audience: [],
            createdByAccountId: scope.accountId,
          },
        },
      },
      row('acme-api', 'acme/api', 'Acme'),
      row('acme-design', 'acme/design-system', 'Acme'),
      row('happier', 'happier', null),
      row('website', 'website', null),
      row('dotfiles', 'dotfiles', null),
    ];
  }, [machineId, scope]);
  return rows ? (
    <View style={styles.column}>
      <ProjectsTreeList
        testID="projects-setup-progress-specimen"
        rows={rows}
        onToggle={() => undefined}
        onOpenRef={() => undefined}
      />
    </View>
  ) : (
    <Text>Sign in to a Home with a Machine to see the column.</Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The Projects column's width in the lab's desk.
  column: {
    width: 340,
    height: 560,
    backgroundColor: theme.colors.surface.base,
  },
}));
