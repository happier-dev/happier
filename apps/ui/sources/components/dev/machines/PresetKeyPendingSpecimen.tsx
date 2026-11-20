import * as React from 'react';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { buildManagedMachineSelectionOffers } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';
import { describeManagedPresetKeyPending } from '@/components/settings/machines/managed/managedNativeFailurePresentation';
import { MachinePresetsPage } from '@/components/settings/machines/presets/MachinePresetsIndex';
import type {
  MachinePresetCollectionRow,
  MachinePresetCollectionSection,
} from '@/components/settings/machines/collection/machineCollectionModel';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { MACHINE_PRESET_TEAM_KEY_PENDING } from '@/sync/domains/machines/presets/machinePresetReadFailure';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { t } from '@/text';

const SERVER_ID = 'specimen-home';
const HOME_ID = 'specimen-home-identity';
const LAUNCH = Object.freeze({
  provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
  schemaVersion: 1,
  name: 'Guest',
  choices: { cores: 4 },
});

function openedPreset(
  id: string,
  name: string,
): ManagedMachinePresetListEntryV1 {
  return createPlainManagedMachinePresetFixture({
    id,
    homeId: HOME_ID,
    revision: 2,
    name,
    owner: { kind: 'account', accountId: 'specimen-account' },
    launch: LAUNCH,
  }).opened;
}

/** A Team preset this Account may see but cannot open yet: its key hasn't been delivered (TH-VISUAL-ACCEPT-17). */
function keyPendingPreset(): ManagedMachinePresetListEntryV1 {
  const {
    content: _content,
    recipients: _recipients,
    ...metadata
  } = createPlainManagedMachinePresetFixture({
    id: 'shared-gpu',
    homeId: HOME_ID,
    revision: 1,
    name: 'Unread',
    owner: { kind: 'team', teamId: 'team-studio' },
    launch: LAUNCH,
  });
  return {
    ...metadata,
    kind: 'private_content_unavailable',
    reason: MACHINE_PRESET_TEAM_KEY_PENDING,
  };
}

const PRESETS: readonly ManagedMachinePresetListEntryV1[] = [
  openedPreset('build-box', 'Build box'),
  keyPendingPreset(),
  openedPreset('docs-preview', 'Docs preview'),
];

function row(
  preset: ManagedMachinePresetListEntryV1,
  title: string,
  audience: string,
): MachinePresetCollectionRow {
  return {
    kind: 'preset',
    presetId: preset.id,
    serverId: SERVER_ID,
    title,
    preset,
    audience,
    ...(preset.owner.kind === 'team' ? { teamName: 'Studio' } : {}),
  };
}

const SECTIONS: readonly MachinePresetCollectionSection[] = [
  {
    key: SERVER_ID,
    serverId: SERVER_ID,
    title: null,
    status: 'online',
    archivedRows: [],
    rows: [
      row(PRESETS[0]!, 'Build box', 'Yours'),
      row(PRESETS[1]!, 'Unread', 'Studio'),
      row(PRESETS[2]!, 'Docs preview', 'Yours'),
    ],
  },
];

const MACHINES = [
  createMachineFixture({
    id: 'devbox',
    metadata: createMachineMetadataFixture({ host: 'devbox', displayName: 'devbox', platform: 'linux' }),
    active: true,
  }),
  createMachineFixture({
    id: 'macbook',
    metadata: createMachineMetadataFixture({ host: 'macbook', displayName: 'MacBook Pro' }),
    active: true,
  }),
];

/**
 * Dev-only: the "preset waiting for its key" state on its two list surfaces, mounted through their real owners.
 * `?surface=table` (default) is Machines → Presets; `?surface=picker` is the New Session machine list.
 */
export function PresetKeyPendingSpecimen(
  props: Readonly<{ surface: 'table' | 'picker' }>,
) {
  const offers = React.useMemo(
    () =>
      buildManagedMachineSelectionOffers({
        homeId: HOME_ID,
        presets: PRESETS,
        oneOffTitle: t('managedMachines.picker.oneOff'),
        oneOffSubtitle: t('managedMachines.picker.oneOffHelp'),
        describeUnopened: (preset) =>
          describeManagedPresetKeyPending(preset.reason),
        onConfigure: () => {},
      }),
    [],
  );
  if (props.surface === 'table') {
    return (
      <MachinePresetsPage
        sections={SECTIONS}
        grouped={false}
        activeServerId={SERVER_ID}
        inUseByKey={new Map()}
      />
    );
  }
  return (
    <ItemList pageColumn="wide">
      <PageHeader title={t('newSession.managedMachine.title')} />
      <MachineSelector
        presentation="list"
        machines={MACHINES}
        selectedMachine={null}
        managedMachines={offers}
        onSelect={() => {}}
        showSearch
        testIdPrefix="preset-key-pending"
      />
    </ItemList>
  );
}
