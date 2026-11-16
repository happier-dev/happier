import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import {
  buildQualifiedPluginContributionKey,
  parseQualifiedPluginContributionKey,
} from '@happier-dev/protocol/plugins/contribution-identity';

import {
  MachineProvisionerPicker,
  type ManagedProvisionerSelection,
} from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { useManagedProvisioners } from '@/components/settings/machines/managed/useManagedProvisioners';
import {
  MANAGED_PROVISIONER_MARK_SIZE,
  ManagedPresetMark,
  ManagedPresetOfferLine,
  useManagedProvisionerPresentation,
} from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ModalBackButton } from '@/modal/components/card/ModalBackButton';
import type { CustomModalInjectedProps } from '@/modal';
import {
  hasOpenedManagedMachinePresetCreationV1,
  isOpenedManagedMachinePresetV1,
} from '@/sync/ops/machines/machinePresetCollectionClient';
import { t } from '@/text';

export type MachineIsolationAddedSandbox = Readonly<{
  provisioner: PluginContributionIdentityV1;
  presetId: string;
}>;

/**
 * Isolation's add flow: the sandbox types this Machine can run locally, through the shared provider picker (its cards
 * keep a type that isn't ready visible with Install or Sign in inline, and a failed check with its reason and Retry),
 * then one of that type's presets, or a new preset authored by the shared configurator. Nothing is created here.
 */
export function MachineIsolationAddSandboxModal(
  props: CustomModalInjectedProps &
    Readonly<{
      serverId: string;
      controller: ManagedControllerV1 | undefined;
      onAdded: (entry: MachineIsolationAddedSandbox) => void;
    }>,
) {
  const [selected, setSelected] =
    React.useState<ManagedProvisionerSelection | null>(null);
  const [authoring, setAuthoring] = React.useState(false);
  const { setChrome, onClose } = props;
  const back = React.useCallback(() => {
    if (authoring) setAuthoring(false);
    else setSelected(null);
  }, [authoring]);
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      title: t('machineDetailPage.isolation.add.title'),
      dimensions: { size: 'lg' },
      phonePresentation: 'sheet',
      bodyScroll: 'auto',
      ...(selected
        ? {
            leading: (
              <ModalBackButton
                testID="machine-isolation-add.back"
                accessibilityLabel={t('machineDetailPage.isolation.add.back')}
                onPress={back}
              />
            ),
          }
        : {}),
    });
  }, [setChrome, selected, back]);
  const add = React.useCallback(
    (presetId: string) => {
      const provisioner = selected
        ? parseQualifiedPluginContributionKey(selected.provisioner)
        : null;
      if (!provisioner) return;
      onClose();
      props.onAdded({
        provisioner: {
          pluginId: provisioner.pluginId,
          localId: provisioner.localId,
        },
        presetId,
      });
    },
    [selected, onClose, props.onAdded],
  );

  if (!selected) {
    return (
      <MachineProvisionerPicker
        serverId={props.serverId}
        controller={props.controller}
        sessionPlacement="controller-local"
        onSelectProvisioner={setSelected}
      />
    );
  }
  if (authoring) {
    return (
      <ManagedMachineConfigurationView
        serverId={selected.serverId}
        provisioner={selected.provisioner}
        presetOnly
        initialController={selected.controller ?? props.controller}
        initialConnectPurpose={selected.connectPurpose}
        onCancel={() => setAuthoring(false)}
        onPresetSaved={(preset) => add(preset.id)}
      />
    );
  }
  return (
    <MachineIsolationPresetChoice
      serverId={props.serverId}
      controller={props.controller}
      provisioner={selected.provisioner}
      onChoose={add}
      onNewPreset={() => setAuthoring(true)}
    />
  );
}

function MachineIsolationPresetChoice(
  props: Readonly<{
    serverId: string;
    controller: ManagedControllerV1 | undefined;
    provisioner: string;
    onChoose: (presetId: string) => void;
    onNewPreset: () => void;
  }>,
) {
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const presets = useMachinePresets(serverIds);
  const state = presets.statesByServerId[props.serverId];
  const catalog = useManagedProvisioners(
    props.serverId,
    undefined,
    props.controller,
    { contributionKey: props.provisioner },
  );
  const provisioner = catalog.provisioners.find(
    (candidate) =>
      buildQualifiedPluginContributionKey(candidate.contribution) ===
      props.provisioner,
  );
  const presentation = useManagedProvisionerPresentation({
    serverId: props.serverId,
    controller: props.controller,
    accountScope: catalog.binding?.scope,
    purpose: 'presentation',
    declarationsOnly: true,
  });
  const providerTitle = provisioner
    ? presentation.localized(
        provisioner.contribution.pluginId,
        provisioner.descriptor.title,
      )
    : '';
  // A preset of this type that runs here: its own launch names the type, and it names no other controller.
  const matching = (presets.presetsByServerId[props.serverId] ?? [])
    .filter(isOpenedManagedMachinePresetV1)
    .filter(hasOpenedManagedMachinePresetCreationV1)
    .filter(
      (preset) =>
        preset.archivedAt === undefined &&
        buildQualifiedPluginContributionKey(preset.launch.provider) ===
          props.provisioner &&
        (!preset.controller ||
          !props.controller ||
          preset.controller.machineId === props.controller.machineId),
    );
  const accountScope = catalog.binding?.scope ?? null;
  return (
    <ItemGroup
      testID="machine-isolation-add.presets"
      title={t('machineDetailPage.isolation.add.choosePreset')}
      description={t(
        'machineDetailPage.isolation.add.choosePresetDescription',
        { provider: providerTitle },
      )}
    >
      {state?.error ? (
        <SurfaceStateCard
          kind="error"
          size="line"
          title={t('machinePresets.loadFailed')}
          diagnosticCode={state.error}
          action={{ label: t('common.retry'), onPress: presets.refresh }}
        />
      ) : matching.length === 0 && state?.loading === false ? (
        <SurfaceStateCard
          kind="empty"
          size="line"
          title={t('machineDetailPage.isolation.add.noPresets', {
            provider: providerTitle,
          })}
        />
      ) : null}
      {matching.map((preset) => (
        <Item
          key={preset.id}
          testID={`machine-isolation-add.preset:${preset.id}`}
          title={preset.name}
          icon={
            <ManagedPresetMark
              serverId={props.serverId}
              accountScope={accountScope}
              preset={preset}
              size={MANAGED_PROVISIONER_MARK_SIZE.row}
            />
          }
          subtitle={
            <ManagedPresetOfferLine
              serverId={props.serverId}
              accountScope={accountScope}
              preset={preset}
            />
          }
          onPress={() => props.onChoose(preset.id)}
        />
      ))}
      <ItemAddRow
        testID="machine-isolation-add.new-preset"
        title={t('machinePresets.newPreset')}
        onPress={props.onNewPreset}
      />
    </ItemGroup>
  );
}
