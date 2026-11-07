import * as React from 'react';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import {
  hasManagedMachinePresetCreationV1,
  type ManagedMachinePresetV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { describeMachineSetup } from '@/components/settings/machines/managed/MachineSetupSection';
import {
  ManagedPresetMark,
  MANAGED_PROVISIONER_MARK_SIZE,
} from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import type { MachinePresetEditContinuation } from '@/components/settings/machines/managed/machinePresetEditDraft';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

import {
  projectAddToPresetChoices,
  type StorePresetDoorItem,
} from './storePresetDoor';
import { useStorePresets } from './useStorePresets';

const NO_SERVERS: readonly string[] = [];
const NEW_PRESET = 'store.preset.new';

/** A preset's one line: what it sets up, in the receipt's own words (the Setup tab says it the same way). */
export function describeStorePreset(preset: ManagedMachinePresetV1): string {
  return describeMachineSetup(preset.setup)
    .map((fact) =>
      t('machinePresets.setup.fact', { label: fact.label, value: fact.value }),
    )
    .join(' · ');
}

export type StorePresetChoice = Readonly<{
  serverId: string;
  preset: ManagedMachinePresetV1;
}>;

/**
 * A listing's "Add to a preset…" (lab `p/toSoft`, `p/toApp`): a quiet second button whose menu lists the Account's
 * presets, saying which already set this item up, and a way to start a new one. The presets are read only once the
 * menu has been opened; choosing one hands the item to the one preset editor, which saves nothing until Save.
 */
export function StoreAddToPresetButton(
  props: Readonly<{
    serverId: string | null;
    item: StorePresetDoorItem | null;
    name: string;
    onChoose: (choice: StorePresetChoice) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // Demand is sticky once opened, so reopening the menu shows the held list instead of a fresh wait.
  const [demanded, setDemanded] = React.useState(false);
  const serverIds = React.useMemo(
    () => (demanded && props.serverId ? [props.serverId] : NO_SERVERS),
    [demanded, props.serverId],
  );
  const presets = useStorePresets(serverIds);
  const state = props.serverId
    ? presets.statesByServerId[props.serverId]
    : undefined;
  const choices = React.useMemo(
    () =>
      props.item ? projectAddToPresetChoices(presets.rows, props.item) : [],
    [presets.rows, props.item],
  );
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      ...choices.map((choice) => ({
        id: choice.preset.id,
        testID: `${props.testID}.preset.${choice.preset.id}`,
        title: choice.preset.name,
        subtitle: choice.contains
          ? t('capabilities.store.softwarePage.alreadyInPreset')
          : describeStorePreset(choice.preset) || undefined,
        icon: (
          <ManagedPresetMark
            serverId={choice.serverId}
            preset={choice.preset}
            size={MANAGED_PROVISIONER_MARK_SIZE.row}
          />
        ),
        disabled: choice.contains,
        category: 'presets',
      })),
      {
        id: NEW_PRESET,
        testID: `${props.testID}.new`,
        title: t('capabilities.store.softwarePage.presetsNew'),
        icon: (
          <Icon
            name="plus"
            size={ICON_SIZE.md}
            color={theme.colors.text.secondary}
          />
        ),
        category: 'new',
      },
    ],
    [choices, props.testID, theme.colors.text.secondary],
  );
  const waiting =
    demanded && (!state || (state.loading && state.value == null));
  return (
    <DropdownMenu
      testID={`${props.testID}.menu`}
      open={open}
      onOpenChange={(next) => {
        if (next) setDemanded(true);
        setOpen(next);
      }}
      items={
        waiting || state?.error
          ? items.filter((entry) => entry.id === NEW_PRESET)
          : items
      }
      emptyLabel={null}
      separateCategories
      matchTriggerWidth={false}
      onSelect={(id) => {
        setOpen(false);
        if (id === NEW_PRESET) {
          if (props.serverId)
            router.push(
              `/settings/machines/presets/new?serverId=${encodeURIComponent(props.serverId)}` as never,
            );
          return;
        }
        const choice = choices.find((entry) => entry.preset.id === id);
        if (choice && !choice.contains) props.onChoose(choice);
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID={props.testID}
          size="normal"
          display="secondary"
          title={t('capabilities.store.softwarePage.addToPreset')}
          accessibilityHint={t(
            'capabilities.store.softwarePage.addToPresetTitle',
            { name: props.name },
          )}
          disabled={!props.item || !props.serverId}
          onPress={toggle}
        />
      )}
    />
  );
}

/**
 * The hand-off into the one preset editor (P20): the chosen preset's saved draft plus this item. Entering or
 * cancelling writes nothing; the editor's own Save stores it and returns here.
 */
export function StorePresetEditorHandoff(
  props: Readonly<{
    choice: StorePresetChoice;
    item: StorePresetDoorItem;
    onReturn: () => void;
  }>,
) {
  const { preset, serverId } = props.choice;
  const onReturn = props.onReturn;
  const continuation = React.useMemo(
    (): MachinePresetEditContinuation => ({
      item: props.item,
      draft: {
        name: preset.name,
        ...(preset.setup ? { setup: preset.setup } : {}),
      },
      preset: { id: preset.id, revision: preset.revision },
      onReturn,
    }),
    [preset, props.item, onReturn],
  );
  const provisioner = hasManagedMachinePresetCreationV1(preset)
    ? buildQualifiedPluginContributionKey(preset.launch.provider)
    : '';
  return (
    <ManagedMachineConfigurationView
      serverId={serverId}
      provisioner={provisioner}
      presetId={preset.id}
      presetOnly
      presetContinuation={continuation}
    />
  );
}
