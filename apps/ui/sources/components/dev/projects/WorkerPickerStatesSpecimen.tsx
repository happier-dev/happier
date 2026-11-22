import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ProjectWorkerStatusResultV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';

import {
  createMachineFixture,
  createMachineMetadataFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { useMachineSelectionListModel } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import type { MachineDestinationPlacementFacts } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { SelectionList } from '@/components/ui/selectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { t } from '@/text';

/**
 * Dev-only: the Project work destination list (Move a service, Run a script on a worker) drawn by the
 * real list model and `SelectionList`, with fixed placement facts instead of status reads. It shows
 * your own workers with their load next to Machines another person shares with you, which the picker
 * lists from what Home publishes (whose, online or not) and never reads in the background.
 */
const SERVER_NAME = 'Personal Home';
const NOW = Date.now();
const noop = () => {};
const EMPTY: Machine[] = [];
const SECTION_TITLES = { all: t('projectWorkers.workersSection') };

const machine = (
  id: string,
  name: string,
  platform: string,
  online: boolean,
  shared?: { owner: string; role: 'use' | 'manage' },
): Machine =>
  createMachineFixture({
    id,
    active: online,
    activeAt: online ? NOW : NOW - 4 * 24 * 60 * 60 * 1000,
    metadata: createMachineMetadataFixture({ host: name, displayName: name, platform }),
    ...(shared
      ? {
          isShared: true,
          access: {
            custodian: { accountId: `account-${shared.owner}`, displayName: shared.owner },
            role: shared.role,
            resourceMode: 'plain',
            accessState: 'ready',
          },
        }
      : {}),
  } as Partial<Machine>);

const MACHINES = [
  machine('build-box', 'build-box', 'linux', true),
  machine('studio', 'studio', 'darwin', true),
  machine('bens-worker', 'lima-worker', 'linux', true, { owner: 'Ben', role: 'manage' }),
  machine('bens-mini', 'mac-mini', 'darwin', false, { owner: 'Ben', role: 'use' }),
];
// Answer each fixture's presence through the activity owner, as a Home presence arrival would.
for (const row of MACHINES) publishMachineActivity(row, { active: row.active, activeAt: row.activeAt }, []);

const worker = (serverId: string, machineId: string, running: number): ProjectWorkerStatusResultV1 => ({
  eligible: true,
  candidate: { serverId, machineId },
  load: { kind: 'known', running, queued: 0, accepting: true, runAtMost: 2 },
  explanation: 'eligible',
});

export function WorkerPickerStatesSpecimen() {
  // The signed-in Home supplies the reachability scope, so presence reads exactly as in the real picker.
  const account = useActiveServerAccountScope();
  const serverId = account?.serverId ?? '';
  const groups = React.useMemo(() => serverId ? [{
    serverId, serverName: SERVER_NAME, loading: false, signedOut: false,
    machines: MACHINES.map((row) => ({ ...row, serverId, serverName: SERVER_NAME })),
  }] : [], [serverId]);
  const resolveFacts = React.useCallback((row: Machine): MachineDestinationPlacementFacts => {
    if (row.isShared) return { ownership: 'shared' };
    return { ownership: 'owned', worker: worker(serverId, row.id, row.id === 'studio' ? 1 : 0) };
  }, [serverId]);
  const list = useMachineSelectionListModel<Machine>({
    purpose: 'service-start',
    resolveMachinePlacementFacts: resolveFacts,
    groups,
    selectedMachine: null,
    selectedServerId: serverId || null,
    recentMachines: EMPTY,
    favoriteMachines: EMPTY,
    onSelectMachine: noop,
    onSelectScopedMachine: noop,
    serverId: serverId || null,
    showFavorites: false,
    showRecent: false,
    showSearch: false,
    showCliGlyphs: false,
    autoDetectCliGlyphs: false,
    sectionTitles: SECTION_TITLES,
    testIdPrefix: 'worker-picker-specimen',
  });
  return (
    <View style={styles.stage}>
      <View style={styles.card} testID="worker-picker-specimen">
        <FloatingOverlay
          maxHeight={560}
          surfaceChrome="theme"
          scrollEnabled={false}
        >
          <SelectionList
            testID="worker-picker-specimen-list"
            rootStep={list.rootStep}
            selectedOptionId={null}
            onSelect={noop}
            onRequestClose={noop}
            listAccessibilityLabel={t('projectWorkers.workersSection')}
            maxHeight={560}
            disableTransitions
          />
        </FloatingOverlay>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stage: {
    flex: 1,
    alignItems: 'center',
    padding: theme.space.s16,
    backgroundColor: theme.colors.surface.base,
  },
  card: {
    width: '100%',
    maxWidth: 420,
  },
}));
