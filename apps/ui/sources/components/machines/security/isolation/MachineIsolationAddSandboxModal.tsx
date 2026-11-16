import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import {
  buildQualifiedPluginContributionKey,
  parseQualifiedPluginContributionKey,
} from '@happier-dev/protocol/plugins/contribution-identity';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import {
  type ManagedProvisionerSelection,
  useMachineProvisionerCatalog,
} from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { MachineProvisionerSectionsSkeleton } from '@/components/settings/machines/managed/MachineProvisionerSections';
import type { ManagedProvisionerCard } from '@/components/settings/machines/managed/managedMachineDisplay';
import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import {
  MANAGED_PROVISIONER_MARK_SIZE,
  ManagedPresetMark,
  ManagedPresetOfferLine,
  ManagedProvisionerRepairFailureNotice,
} from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SetupSteps, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { LeadSentence } from '@/components/ui/text/LeadSentence';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal';
import {
  hasOpenedManagedMachinePresetCreationV1,
  isOpenedManagedMachinePresetV1,
} from '@/sync/ops/machines/machinePresetCollectionClient';
import { t } from '@/text';

import type { MachineIsolationWorkKind } from './machineIsolationChoices';

export type MachineIsolationAddedSandbox = Readonly<{
  provisioner: PluginContributionIdentityV1;
  presetId: string;
}>;

type Step = 'kind' | 'setup' | 'preset' | 'author';
const STEPS = ['kind', 'setup', 'preset'] as const;
const NO_PRESETS: readonly never[] = Object.freeze([]);

/**
 * Add a sandbox (lab machine-sandboxes-1115 `setup-kind`, J2): Kind → Set up → Preset in one sheet. The kinds are
 * the provider catalog's own cards for this Machine (their readiness, install or sign-in step and failure come from
 * that one owner); a kind that needs setup runs its own repair step here, then the preset is one of that type's
 * presets or a new one from the shared configurator. Nothing is created until work starts.
 */
export function MachineIsolationAddSandboxModal(
  props: CustomModalInjectedProps &
    Readonly<{
      serverId: string;
      controller: ManagedControllerV1 | undefined;
      machineName: string;
      useFor?: MachineIsolationWorkKind;
      onAdded: (entry: MachineIsolationAddedSandbox) => void;
    }>,
) {
  const [step, setStep] = React.useState<Step>('kind');
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<ManagedProvisionerSelection | null>(null);
  const [presetId, setPresetId] = React.useState<string | null>(null);
  const onSelectProvisioner = React.useCallback((next: ManagedProvisionerSelection) => {
    setSelection(next);
    setPresetId(null);
    setStep('preset');
  }, []);
  const catalog = useMachineProvisionerCatalog({
    serverId: props.serverId,
    controller: props.controller,
    sessionPlacement: 'controller-local',
    onSelectProvisioner,
  });
  // A kind this Machine can't run, or that nothing here can set up (no install or sign-in step), is shown apart.
  const runsHere = (card: ManagedProvisionerCard) =>
    card.action.kind !== 'handoff' && !(card.action.kind === 'choose' && card.action.disabled);
  const here = catalog.cards.filter(runsHere);
  const elsewhere = catalog.cards.filter((card) => !runsHere(card));
  // The first kind that can be chosen now is picked to start with, as the lab's sheet opens.
  const picked =
    catalog.cards.find((card) => card.id === pickedId) ??
    here.find((card) => card.action.kind === 'choose' && !card.action.disabled) ??
    // None ready yet: the first that sets up here, so Continue always leads somewhere (its Set up step).
    here[0] ??
    null;
  const pickedReady = picked?.action.kind === 'choose' && !picked.action.disabled;

  const { setChrome, onClose } = props;
  const add = React.useCallback(
    (chosen: string) => {
      const provisioner = selection ? parseQualifiedPluginContributionKey(selection.provisioner) : null;
      if (!provisioner) return;
      onClose();
      props.onAdded({ provisioner: { pluginId: provisioner.pluginId, localId: provisioner.localId }, presetId: chosen });
    },
    [selection, onClose, props.onAdded],
  );
  const back = React.useCallback(() => {
    setStep((current) => (current === 'author' ? 'preset' : 'kind'));
  }, []);
  const proceed = React.useCallback(() => {
    if (!picked) return;
    if (pickedReady) picked.action.onPress();
    else setStep('setup');
  }, [picked, pickedReady]);

  const footer =
    step === 'author' ? undefined : (
      // The note leads; the way out (Cancel, or Back one step in) and the step's primary stand together on the right,
      // so the title never moves for a Back in the head.
      <ModalCardFooterActions note={t('machineDetailPage.isolation.add.footerNote')}>
        <RoundButton
          testID={step === 'kind' ? 'machine-isolation-add.cancel' : 'machine-isolation-add.back'}
          size="normal"
          display="secondary"
          title={step === 'kind' ? t('common.cancel') : t('common.back')}
          onPress={step === 'kind' ? onClose : back}
        />
        {step === 'kind' ? (
          <RoundButton
            testID="machine-isolation-add.continue"
            size="normal"
            title={t('common.continue')}
            disabled={!picked || (picked.action.kind === 'choose' && picked.action.disabled === true)}
            onPress={proceed}
          />
        ) : step === 'setup' && picked ? (
          // Its own next step: Continue once ready, else the kind's install or sign-in, else check it again.
          <RoundButton
            testID="machine-isolation-add.setup-action"
            size="normal"
            title={
              pickedReady
                ? t('common.continue')
                : picked.action.kind === 'choose'
                  ? t('machinePresets.setup.tab.checkAgain')
                  : picked.action.label
            }
            onPress={!pickedReady && picked.action.kind === 'choose' ? catalog.catalog.refresh : picked.action.onPress}
          />
        ) : (
          <RoundButton
            testID="machine-isolation-add.confirm"
            size="normal"
            title={t('machineDetailPage.isolation.add.addAndUse')}
            disabled={!presetId}
            onPress={() => {
              if (presetId) add(presetId);
            }}
          />
        )}
      </ModalCardFooterActions>
    );
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      title: t('machineDetailPage.isolation.add.titleOn', { machine: props.machineName }),
      // The title names the Machine; the context line says what the sheet was opened for, from every door.
      subtitle: props.useFor ? t(`machineDetailPage.isolation.add.forWork.${props.useFor}`) : t('machineDetailPage.isolation.add.forAnyWork'),
      subtitleLines: 1 as const,
      dimensions: { width: HAPPIER_PAGE_METRICS.columnMaxWidthPx.reading, maxHeightRatio: 0.9 },
      phonePresentation: 'sheet',
      scrollHost: 'bounded',
      // One screen from Kind to Preset: the card keeps its tallest height across steps instead of re-fitting each.
      screenKey: step === 'author' ? 'author' : 'add',
      bodyScroll: 'auto',
      footer,
    });
  });

  if (step === 'author' && selection) {
    return (
      <ManagedMachineConfigurationView
        serverId={selection.serverId}
        provisioner={selection.provisioner}
        presetOnly
        initialController={selection.controller ?? props.controller}
        initialConnectPurpose={selection.connectPurpose}
        onCancel={() => setStep('preset')}
        onPresetSaved={(preset) => add(preset.id)}
      />
    );
  }

  const strip: SetupStep[] = STEPS.map((key, index) => {
    const at = STEPS.indexOf(step === 'author' ? 'preset' : step);
    // A ready kind needs no setup: its step reads as done once the sheet is past the kind.
    return {
      key,
      testID: `machine-isolation-add.step:${key}`,
      title: t(`machineDetailPage.isolation.add.steps.${key}`),
      state: index < at ? 'done' : index === at ? 'current' : 'upcoming',
    };
  });

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="machine-isolation-add" style={styles.body}>
        <View style={styles.strip}>
          <SetupSteps variant="strip" steps={strip} testID="machine-isolation-add.steps" />
        </View>
        <View style={styles.content}>
          {step === 'kind' ? (
            <MachineIsolationKindStep
              machineName={props.machineName}
              catalog={catalog}
              here={here}
              elsewhere={elsewhere}
              pickedId={picked?.id ?? null}
              onPick={setPickedId}
            />
          ) : step === 'setup' && picked ? (
            <MachineIsolationSetupStep machineName={props.machineName} card={picked} />
          ) : selection ? (
            <MachineIsolationPresetStep
              serverId={props.serverId}
              controller={props.controller}
              provisioner={selection.provisioner}
              accountScope={catalog.catalog.binding?.scope ?? null}
              providerTitle={picked?.title ?? ''}
              chosenId={presetId}
              onChoose={setPresetId}
              onNewPreset={() => setStep('author')}
            />
          ) : null}
        </View>
      </View>
    </ListPresentationProvider>
  );
}

function MachineIsolationKindStep(
  props: Readonly<{
    machineName: string;
    catalog: ReturnType<typeof useMachineProvisionerCatalog>;
    here: readonly ManagedProvisionerCard[];
    elsewhere: readonly ManagedProvisionerCard[];
    pickedId: string | null;
    onPick: (id: string) => void;
  }>,
) {
  const { catalog } = props;
  const lead = (
    <LeadSentence
      statement={t('machineDetailPage.isolation.add.kindStatement')}
      detail={t('machineDetailPage.isolation.add.kindDetail', { machine: props.machineName })}
    />
  );
  // The whole catalog failed: one line with its Retry, in the same sheet, under the same lead.
  if (!catalog.shown && catalog.catalog.error) {
    return (
      <>
        {lead}
        <SurfaceStateCard
          testID="machine-isolation-add.unavailable"
          kind="error"
          title={t('machineDetailPage.isolation.add.kindsUnavailable', { machine: props.machineName })}
          diagnosticCode={catalog.catalog.error}
          action={{ label: t('common.retry'), onPress: catalog.catalog.refresh }}
        />
      </>
    );
  }
  if (catalog.reading || !catalog.shown) {
    return (
      <>
        {lead}
        {catalog.reading ? (
          <MachineProvisionerSectionsSkeleton compact testID="machine-isolation-add.loading" />
        ) : (
          catalog.scopeState
        )}
      </>
    );
  }
  const row = (card: ManagedProvisionerCard, available: boolean) => {
    const picked = card.id === props.pickedId;
    const selectable = available && !(card.action.kind === 'choose' && card.action.disabled === true);
    return (
      <Item
        key={card.id}
        testID={`machine-isolation-add.kind:${card.id}`}
        title={card.title}
        subtitle={card.description || undefined}
        icon={card.mark(MANAGED_PROVISIONER_MARK_SIZE.row)}
        detail={card.status.label || undefined}
        selected={picked}
        disabled={!selectable}
        showChevron={false}
        accessibilityRole="radio"
        accessibilityChecked={picked}
        rightElement={picked ? <PickedMark /> : undefined}
        onPress={selectable ? () => props.onPick(card.id) : undefined}
      />
    );
  };
  return (
    <>
      {lead}
      {catalog.scopeState}
      {catalog.approval.approvalId ? (
        <AttentionBanner
          testID="machine-isolation-add.approval"
          title={t('approvals.title')}
          description={t('approvals.status.open')}
        />
      ) : null}
      {props.here.length > 0 ? (
        <ItemGroup
          testID="machine-isolation-add.kinds"
          title={t('machineDetailPage.isolation.add.setsUpOn', { machine: props.machineName })}
          accessibilityRole="radiogroup"
        >
          {props.here.map((card) => row(card, true))}
        </ItemGroup>
      ) : null}
      {props.elsewhere.length > 0 ? (
        <ItemGroup testID="machine-isolation-add.elsewhere" title={t('machineDetailPage.isolation.add.notHere')}>
          {props.elsewhere.map((card) => row(card, false))}
        </ItemGroup>
      ) : null}
    </>
  );
}

function PickedMark() {
  const { theme } = useUnistyles();
  return <Icon name="check" size={16} color={theme.colors.text.primary} />;
}

function MachineIsolationSetupStep(props: Readonly<{ machineName: string; card: ManagedProvisionerCard }>) {
  const { card } = props;
  const ready = card.action.kind === 'choose' && !card.action.disabled;
  return (
    <>
      <LeadSentence
        statement={
          ready
            ? t('machineDetailPage.isolation.add.setupReady', { kind: card.title })
            : t('machineDetailPage.isolation.add.setupStatement', { kind: card.title })
        }
        detail={ready ? null : t('machineDetailPage.isolation.add.setupDetail', { machine: props.machineName })}
      />
      <ItemGroup testID="machine-isolation-add.setup" title={card.title}>
        <Item
          testID={`machine-isolation-add.setup:${card.id}`}
          title={card.status.label}
          subtitle={card.description || undefined}
          icon={card.mark(MANAGED_PROVISIONER_MARK_SIZE.row)}
          showChevron={false}
          mode="info"
        />
      </ItemGroup>
      {card.repairFailure ? (
        <ManagedProvisionerRepairFailureNotice failure={card.repairFailure} testID="machine-isolation-add.setup-failure" />
      ) : null}
    </>
  );
}

function MachineIsolationPresetStep(
  props: Readonly<{
    serverId: string;
    controller: ManagedControllerV1 | undefined;
    provisioner: string;
    accountScope: Parameters<typeof ManagedPresetMark>[0]['accountScope'];
    providerTitle: string;
    chosenId: string | null;
    onChoose: (presetId: string) => void;
    onNewPreset: () => void;
  }>,
) {
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const presets = useMachinePresets(serverIds);
  const state = presets.statesByServerId[props.serverId];
  // A preset of this type that runs here: its own launch names the type, and it names no other controller.
  const matching = (presets.presetsByServerId[props.serverId] ?? NO_PRESETS)
    .filter(isOpenedManagedMachinePresetV1)
    .filter(hasOpenedManagedMachinePresetCreationV1)
    .filter(
      (preset) =>
        preset.archivedAt === undefined &&
        buildQualifiedPluginContributionKey(preset.launch.provider) === props.provisioner &&
        (!preset.controller || !props.controller || preset.controller.machineId === props.controller.machineId),
    );
  // The first preset of this type starts chosen, as the kind did, so the primary is ready.
  const firstId = matching[0]?.id ?? null;
  const { chosenId, onChoose } = props;
  React.useEffect(() => {
    if (chosenId === null && firstId !== null) onChoose(firstId);
  }, [chosenId, firstId, onChoose]);
  return (
    <>
      <LeadSentence
        statement={t('machineDetailPage.isolation.add.presetStatement')}
        detail={t('machineDetailPage.isolation.add.presetDetail', { provider: props.providerTitle })}
      />
      {state?.error ? (
        <SurfaceStateCard
          kind="error"
          size="line"
          title={t('machinePresets.loadFailed')}
          diagnosticCode={state.error}
          action={{ label: t('common.retry'), onPress: presets.refresh }}
        />
      ) : null}
      <ItemGroup
        testID="machine-isolation-add.presets"
        title={t('machineDetailPage.isolation.add.choosePreset')}
        accessibilityRole="radiogroup"
      >
        {matching.length === 0 && state?.loading === false && !state.error ? (
          <Text variant="meta" style={styles.none}>
            {t('machineDetailPage.isolation.add.noPresets', { provider: props.providerTitle })}
          </Text>
        ) : null}
        {matching.map((preset) => {
          const chosen = preset.id === props.chosenId;
          return (
            <Item
              key={preset.id}
              testID={`machine-isolation-add.preset:${preset.id}`}
              title={preset.name}
              icon={
                <ManagedPresetMark
                  serverId={props.serverId}
                  accountScope={props.accountScope}
                  preset={preset}
                  size={MANAGED_PROVISIONER_MARK_SIZE.row}
                />
              }
              subtitle={<ManagedPresetOfferLine serverId={props.serverId} accountScope={props.accountScope} preset={preset} />}
              selected={chosen}
              showChevron={false}
              accessibilityRole="radio"
              accessibilityChecked={chosen}
              rightElement={chosen ? <PickedMark /> : undefined}
              onPress={() => props.onChoose(preset.id)}
            />
          );
        })}
        <ItemAddRow
          testID="machine-isolation-add.new-preset"
          title={t('machinePresets.newPreset')}
          onPress={props.onNewPreset}
        />
      </ItemGroup>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingBottom: theme.space.s16,
  },
  // The strip stands in the title block's band, its hairline below; the first sentence starts one inset under it.
  strip: {
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    paddingBottom: HAPPIER_PAGE_METRICS.cardPaddingPx,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.divider,
  },
  // Each section keeps its own gap above its title; the lead and the line under it sit one step apart.
  content: {
    gap: theme.space.s8,
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    paddingTop: HAPPIER_PAGE_METRICS.sheetInsetPx,
  },
  none: {
    color: theme.colors.text.secondary,
    paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx,
    paddingVertical: theme.space.s12,
  },
}));
