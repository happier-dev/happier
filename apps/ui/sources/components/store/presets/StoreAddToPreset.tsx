import * as React from 'react';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { hasOpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';

import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import {
  MachineProvisionerPicker,
  type ManagedProvisionerSelection,
} from '@/components/settings/machines/managed/MachineProvisionerPicker';
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
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

import {
  projectAddToPresetChoices,
  type StorePresetDoorItem,
} from './storePresetDoor';
import { useStorePresets } from './useStorePresets';
import { StorePresetsReadFailure } from './StorePresetsReadFailure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useStoreListingPaneTitle } from '../storeListingPaneTitle';
import { foldOfflineSoftwareTargets, SoftwareMachineMark, softwareMachineFacts, softwareMachineName, useSoftwareMachines } from '../StoreSoftwareTargets';

const NO_SERVERS: readonly string[] = [];
const NEW_PRESET = 'store.preset.new';
const RUN_ON_MACHINE = 'store.preset.runOn:';
const NO_CHOSEN_MACHINES: ReadonlySet<string> = new Set();

/** A preset's one line: what it sets up, in the receipt's own words (the Setup tab says it the same way). */
export function describeStorePreset(preset: OpenedManagedMachinePresetV1): string {
  return describeMachineSetup(preset.setup)
    .map((fact) =>
      t('machinePresets.setup.fact', { label: fact.label, value: fact.value }),
    )
    .join(' · ');
}

/** A saved preset to add the item to, or `null` for a new preset that starts with it. */
export type StorePresetChoice = Readonly<{
  serverId: string;
  preset: OpenedManagedMachinePresetV1 | null;
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
    /**
     * The same item can also run now (a plugin's setup recipe, lab ideas-1118-platform "Use on a machine"): the one
     * control then offers the Account's Machines first, then the presets. Its words come from the caller.
     */
    /** A row's trailing control is small (a setup checklist row); a page's is normal. */
    size?: 'small' | 'normal';
    runNow?: Readonly<{
      title: string;
      machinesTitle: string;
      presetsTitle: string;
      onRun: (machineId: string) => void;
    }>;
  }>,
) {
  const { theme } = useUnistyles();
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
  // Store state only (the reach owner, no daemon reads); offline Machines fold away, as on the listing.
  const softwareMachines = useSoftwareMachines();
  const runOn = props.runNow;
  const machineItems = React.useMemo(
    (): DropdownMenuItem[] => runOn
      ? foldOfflineSoftwareTargets(softwareMachines.targets, NO_CHOSEN_MACHINES).shown.map((entry) => ({
        id: `${RUN_ON_MACHINE}${entry.machine.machineId}`,
        testID: `${props.testID}.machine.${entry.machine.machineId}`,
        title: softwareMachineName(entry.machine),
        subtitle: softwareMachineFacts(entry.machine),
        icon: <SoftwareMachineMark entry={entry} />,
        category: 'machines',
      }))
      : [],
    [props.testID, runOn, softwareMachines.targets],
  );
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      ...machineItems,
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
    [choices, machineItems, props.testID, theme.colors.text.secondary],
  );
  const categoryTitles = React.useMemo(
    () => runOn ? { machines: runOn.machinesTitle, presets: runOn.presetsTitle } : undefined,
    [runOn],
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
          ? items.filter((entry) => entry.id === NEW_PRESET || entry.category === 'machines')
          : items
      }
      {...(categoryTitles ? { categoryTitles } : {})}
      emptyLabel={null}
      // While presets load, the menu says so: "New preset" alone would read as having none (and invite a duplicate).
      header={state?.error ? <StorePresetsReadFailure testID={`${props.testID}.state`} error={state.error} onRetry={presets.refresh} />
        : waiting ? <SurfaceStateCard testID={`${props.testID}.loading`} size="line" kind="loading" title={t('machinePresets.loading')} />
          : undefined}
      separateCategories
      matchTriggerWidth={false}
      onSelect={(id) => {
        setOpen(false);
        if (runOn && id.startsWith(RUN_ON_MACHINE)) {
          runOn.onRun(id.slice(RUN_ON_MACHINE.length));
          return;
        }
        if (id === NEW_PRESET) {
          if (props.serverId) props.onChoose({ serverId: props.serverId, preset: null });
          return;
        }
        const choice = choices.find((entry) => entry.preset.id === id);
        if (choice && !choice.contains) props.onChoose(choice);
      }}
      trigger={({ toggle }) => (
        <RoundButton
          testID={props.testID}
          size={props.size ?? 'normal'}
          display="secondary"
          title={runOn?.title ?? t('capabilities.store.softwarePage.addToPreset')}
          accessibilityHint={t(
            'capabilities.store.softwarePage.addToPresetTitle',
            { name: props.name },
          )}
          disabled={!props.item || (!props.serverId && !runOn)}
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
  if (!preset)
    return <StoreNewPresetHandoff serverId={serverId} item={props.item} onReturn={props.onReturn} />;
  return <StoreSavedPresetHandoff serverId={serverId} preset={preset} item={props.item} onReturn={props.onReturn} />;
}

function StoreSavedPresetHandoff(
  props: Readonly<{
    serverId: string;
    preset: OpenedManagedMachinePresetV1;
    item: StorePresetDoorItem;
    onReturn: () => void;
  }>,
) {
  const { preset, serverId, onReturn } = props;
  useStoreListingPaneTitle(preset.name);
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
  const provisioner = hasOpenedManagedMachinePresetCreationV1(preset)
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

/**
 * "New preset" from the door: the provider picker the Presets page uses, kept in place so the item travels into the
 * new preset's editor already added. Its name is left for the editor to give (the provider's, as Add does).
 */
function StoreNewPresetHandoff(
  props: Readonly<{
    serverId: string;
    item: StorePresetDoorItem;
    onReturn: () => void;
  }>,
) {
  const { item, onReturn } = props;
  useStoreListingPaneTitle(t('capabilities.store.softwarePage.presetsNew'));
  const [selection, setSelection] =
    React.useState<ManagedProvisionerSelection | null>(null);
  const continuation = React.useMemo(
    (): MachinePresetEditContinuation => ({ item, draft: { name: '' }, onReturn }),
    [item, onReturn],
  );
  if (!selection)
    return (
      <ItemList>
        <PageHeader
          title={t('capabilities.store.softwarePage.presetsNew')}
          description={t('machinePresets.empty')}
          actions={
            <RoundButton
              testID="store.preset.new.cancel"
              size="normal"
              display="secondary"
              title={t('common.cancel')}
              onPress={onReturn}
            />
          }
        />
        <MachineProvisionerPicker
          serverId={props.serverId}
          presetOnly
          onSelectProvisioner={setSelection}
        />
      </ItemList>
    );
  return (
    <ManagedMachineConfigurationView
      serverId={selection.serverId}
      provisioner={selection.provisioner}
      {...(selection.controller ? { initialController: selection.controller } : {})}
      {...(selection.connectPurpose ? { initialConnectPurpose: selection.connectPurpose } : {})}
      presetOnly
      presetContinuation={continuation}
    />
  );
}
