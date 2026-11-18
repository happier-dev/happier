import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { resolveHappierTypeScale } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import {
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { AgentInput } from '@/components/sessions/agentInput';
import { createRecipientMultiSelectActionChip } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import { resolveComposerCardContentInsetX } from '@/components/sessions/agentInput/composerContentInset';
import { resolveAgentInputColumn } from '@/components/sessions/agentInput/layout/agentInputColumn';
import type { RecipientMultiSelectModel } from '@/components/sessions/agentInput/routing/recipientMultiSelectModel';
import {
  readBulkSessionComposerSeed,
  useFrozenBulkSessionTargets,
  type BulkSessionComposerSeed,
} from '@/components/sessions/authoring/bulk/bulkSessionComposerHandoff';
import { useBulkSessionComposer } from '@/components/sessions/authoring/bulk/useBulkSessionComposer';
import { useHydratedBulkSessionAuthoringFacts } from '@/components/sessions/authoring/bulk/useHydratedBulkSessionAuthoringFacts';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { PhonePageBackLine, usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { OutcomeRow } from '@/components/sessions/new/placement/SessionIsolationOutcomeLine';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import type { BulkSessionAuthoringFact } from '@/sync/store/bulkSessionAuthoringFacts';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { ExistingSessionCapabilityDelta, ExistingSessionChangeSet } from '@happier-dev/protocol/sessions/authoring/existingSessionFieldApplication';
import { createUnavailablePluginComposerControlChip } from '@/components/plugins/actions/pluginContributedActionComposerChips';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type { CrossSessionAuthoringControlTarget } from '@/components/sessions/authoring/controls/crossSessionAuthoringFieldControls';
import { findSessionAuthoringAgentTargetOption } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useCrossSessionAuthoringFieldControl } from '@/components/sessions/authoring/controls/useCrossSessionAuthoringFieldControl';
import { useSessionAuthoringEnginePicker } from '@/components/sessions/authoring/controls/useSessionAuthoringEnginePicker';
import { useSessionAuthoringConnectedServicesChip } from '@/components/sessions/authoring/controls/SessionAuthoringConnectedServicesField';
import { useSessionAuthoringCapabilitiesChip } from '@/components/sessions/authoring/controls/SessionAuthoringCapabilitiesField';
import type { SessionAuthoringFieldControlModel } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { createUnavailableComposerControlChip } from '@/components/sessions/agentInput/definitions/createUnavailableComposerControlChip';
import { getConnectedServicesAuthActionChipPlacement } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import { getLinkedFilesActionChipPlacement } from '@/components/sessions/agentInput/definitions/agentInputActionChipPlacements';
import { getCapabilitiesActionChipPlacement } from '@/components/sessions/capabilities/createCapabilitiesActionChip';
import { areSnapshotProjectionsEquivalent } from '@/sync/domains/state/structuralSharing';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

import { useBulkSessionControlTargets } from './BulkSessionControlTargets';
import {
  AGENT_INPUT_FIELD_CONTAINER_PADDING_Y,
  AGENT_INPUT_FIELD_PADDING_Y,
} from '@/components/sessions/agentInput/components/agentInputChromeStyles';

import { BulkSessionResults } from './BulkSessionResults';
import { bulkSwitchCatalogAgentId, describeBulkSkipReason } from './bulkSessionComposePresentation';
import {
  resolveBulkTargetCatalogAgentId,
  useBulkSessionAgentTitles,
  useBulkSessionMachineLabels,
  useBulkSessionTargetNames,
} from './useBulkSessionTargetIdentities';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';

/** The column of the New session page (lab bc §6): the composer and the results share it at every width. */
const COMPOSE_COLUMN_MAX_WIDTH = 760;
/**
 * The lab's composer opens two lines tall (lab bc mixed): a message to several sessions is written, not dashed off.
 * Two of the field's text lines plus the field row's own insets.
 */
const BULK_COMPOSE_INPUT_MIN_HEIGHT =
  resolveHappierTypeScale('reading', Platform.OS).lineHeight * 2 +
  (AGENT_INPUT_FIELD_CONTAINER_PADDING_Y + AGENT_INPUT_FIELD_PADDING_Y) * 2;
const NO_CONTROL_TARGETS: readonly CrossSessionAuthoringControlTarget[] = [];
const noop = () => {};
const NO_AUTOCOMPLETE_KINDS: React.ComponentProps<
  typeof AgentInput
>['autocompleteKinds'] = [];
const NO_AUTOCOMPLETE_SUGGESTIONS: React.ComponentProps<
  typeof AgentInput
>['autocompleteSuggestions'] = async () => [];

/**
 * Bulk compose (BULK-COMPOSE-1117): the existing session composer aimed at the sessions the person picked. The page
 * is the New session composition; chips edit a pending change set, and nothing applies until Send (owner 18:25Z).
 * After Send the same page shows one row per session.
 */
export function BulkSessionComposeRoute() {
  useDestinationPageTitle(t('session.participants.bulk.pageTitle'));
  const params = useLocalSearchParams<{ dataId?: string }>();
  // The handoff is read once: a reload or a stale link lands on the empty state, never on another selection.
  const [seed] = React.useState<BulkSessionComposerSeed | null>(() =>
    typeof params.dataId === 'string'
      ? readBulkSessionComposerSeed(params.dataId)
      : null,
  );
  if (!seed || seed.targets.length === 0) {
    return (
      <EmptyState
        testID="bulk-compose-expired"
        layout="centered"
        title={t('session.participants.bulk.expiredTitle')}
        subtitle={t('session.participants.bulk.expiredBody')}
      />
    );
  }
  return <BulkSessionComposer seed={seed} />;
}

function BulkSessionComposer(
  props: Readonly<{ seed: BulkSessionComposerSeed }>,
) {
  const { width } = useWindowDimensions();
  const phone = isMobileLayoutWidth(width);
  const router = useRouter();
  const navigation = useNavigation();
  const { targets, editToTargets } = useFrozenBulkSessionTargets(
    props.seed.targets,
  );
  const { facts } = useHydratedBulkSessionAuthoringFacts(targets);
  const planningTargets = React.useMemo(
    () =>
      facts.flatMap((fact) =>
        fact.planningTarget ? [fact.planningTarget] : [],
      ),
    [facts],
  );
  const skippedTargets = React.useMemo(
    () =>
      facts
        .filter((fact) => fact.status === 'skipped')
        .map((fact) => ({
          address: fact.address,
          reason: fact.reason ?? 'target_unavailable',
        })),
    [facts],
  );
  const composer = useBulkSessionComposer({
    targets: planningTargets,
    skippedTargets,
    initialText: props.seed.text,
  });
  const [submittedText, setSubmittedText] = React.useState<string | null>(null);

  const names = useBulkSessionTargetNames(targets);
  const targetMachines = React.useMemo(
    () => facts.map((fact) => ({ serverId: fact.address.serverId, machineId: fact.machineId })),
    [facts],
  );
  const machineLabels = useBulkSessionMachineLabels(targetMachines);
  // The targets' Agents, plus each sent switch's from/to Agent on that target's Machine (the results' reason line).
  const targetAgents = React.useMemo(() => {
    const current = facts.map((fact) => ({ agentId: resolveBulkTargetCatalogAgentId(fact.agentTarget), machineId: fact.machineId }));
    const switched = composer.rows.flatMap((row) => {
      const machineId = facts.find((fact) => fact.address.sessionId === row.target.sessionId)?.machineId ?? null;
      return [row.switchedFrom, row.switchedTo].flatMap((agentId) =>
        agentId ? [{ agentId: bulkSwitchCatalogAgentId(agentId), machineId }] : []);
    });
    return switched.length > 0 ? [...current, ...switched] : current;
  }, [facts, composer.rows]);
  const agentTitles = useBulkSessionAgentTitles(targetAgents, facts[0]?.address.serverId ?? null);
  const toModel = useBulkSessionToModel({
    seedTargets: props.seed.targets,
    targets,
    facts,
    names,
    machineLabels,
    agentTitles,
    onChange: editToTargets,
  });
  const toChip = React.useMemo(
    () =>
      createRecipientMultiSelectActionChip({
        isReadOnly: false,
        model: toModel,
      }),
    [toModel],
  );
  // Chips offer only what every target supports, from each target's own canonical controls (BC-C intersection).
  const controlTargets = useBulkSessionControlTargets(facts);
  const mixedLabel = t('session.participants.bulk.mixed');
  const permissionControl = useCrossSessionAuthoringFieldControl({
    field: 'permissionMode',
    targets: controlTargets.targets ?? NO_CONTROL_TARGETS,
    selection: composer.selection,
    agentSwitchingEnabled: composer.agentSwitchingEnabled,
    mixedLabel,
  });
  const engineControl = useCrossSessionAuthoringFieldControl({
    field: 'agentTarget',
    targets: controlTargets.targets ?? NO_CONTROL_TARGETS,
    selection: composer.selection,
    agentSwitchingEnabled: composer.agentSwitchingEnabled,
    mixedLabel,
  });
  const allowedPermissionModes = React.useMemo(
    () =>
      permissionControl.kind === 'options'
        ? permissionControl.options.flatMap((option) =>
            isPermissionMode(option.id) && !option.disabled ? [option.id] : [],
          )
        : null,
    [permissionControl],
  );
  const permissionMode =
    permissionControl.kind === 'options' &&
    isPermissionMode(permissionControl.selectedOptionId) &&
    permissionControl.options.some((option) => option.id === permissionControl.selectedOptionId)
      ? permissionControl.selectedOptionId
      : undefined;
  const setPermissionMode = useEventCallback((mode: PermissionMode) => {
    composer.setSelection({ ...composer.selection, permissionMode: mode });
  });

  const leadFacts = controlTargets.leadFacts;
  const changeEngineFields = useEventCallback(
    (fields: Partial<WorkflowSessionAuthoringSelection>) => {
      composer.setSelection({ ...composer.selection, ...fields });
    },
  );
  const sharedAgentTarget = React.useMemo(() => {
    const first = facts.find(fact => fact.status === 'ready')?.agentTarget;
    if (!first) return null;
    const key = buildBackendTargetKeyV2(first);
    return facts.every(fact => fact.status !== 'ready'
      || (fact.agentTarget && buildBackendTargetKeyV2(fact.agentTarget) === key)) ? first : null;
  }, [facts]);
  // While the targets run different Agents nothing is chosen in the model pane (lab §3b): "Running: Mixed".
  const engineMixedSelection = React.useMemo(
    () => (sharedAgentTarget ? undefined : { label: mixedLabel, applyTiming: t('agentInput.model.applyTimingNextMessage') }),
    [mixedLabel, sharedAgentTarget],
  );
  const enginePicker = useSessionAuthoringEnginePicker({
    values: composer.selection,
    facts: engineControl.kind === 'options' ? leadFacts : undefined,
    engineOptions: engineControl.kind === 'options' ? engineControl.options : undefined,
    disabled: engineControl.kind !== 'options',
    onChangeFields: changeEngineFields,
    mixedSelection: engineMixedSelection,
  });
  const sharedAgentOption = React.useMemo(
    () => findSessionAuthoringAgentTargetOption(leadFacts?.agentTargets, sharedAgentTarget),
    [leadFacts, sharedAgentTarget],
  );
  const sharedBundledAgentId = resolveBundledAgentIdFromContributionIdentity(sharedAgentTarget?.identity);
  const sharedAgentLabel = sharedAgentOption?.label
    ?? (sharedBundledAgentId ? resolveAgentCatalogTitle(sharedBundledAgentId) : mixedLabel);
  const engineLabel = composer.selection.agentTarget
    ? enginePicker.label
    : engineControl.kind === 'options'
      ? (engineControl.options.find(
          (option) => option.id === engineControl.selectedOptionId,
        )?.label ??
        engineControl.unselectedLabel ??
        mixedLabel)
      : sharedAgentLabel;
  const engineAgentType =
    enginePicker.agentId ??
    (composer.selection.agentTarget ? undefined : (sharedAgentOption?.agentId ?? sharedBundledAgentId ?? undefined));
  const engineOpens = engineControl.kind === 'options' && enginePicker.options.length > 0;
  // The row the picker opens on: the pending choice, else the one Agent every target runs; none while they differ.
  const sharedEngineOptionId =
    engineControl.kind === 'options' &&
    engineControl.options.some((option) => option.id === engineControl.selectedOptionId)
      ? engineControl.selectedOptionId
      : null;
  const engineSelectedOptionId = composer.selection.agentTarget
    ? enginePicker.selectedOptionId
    : sharedEngineOptionId;
  const engineUnselected = engineSelectedOptionId === null && (engineOpens || !engineAgentType);
  const [enginePickerOpen, setEnginePickerOpen] = React.useState(false);

  // Runs through and Skills/MCP: the existing chips and popovers (owner 20:25Z), fed by the cross-session model.
  const accountChip = useBulkAccountChip({
    facts,
    targets: controlTargets.targets,
    selection: composer.selection,
    setSelection: composer.setSelection,
    agentSwitchingEnabled: composer.agentSwitchingEnabled,
    mixedLabel,
  });
  const capabilitiesChip = useBulkCapabilitiesChip({
    targets: controlTargets.targets,
    selection: composer.selection,
    setCapabilityItem: composer.setCapabilityItem,
    agentSwitchingEnabled: composer.agentSwitchingEnabled,
    mixedLabel,
  });

  // Attachments and plugin controls are per Session; the + menu names them, disabled, with why (lab bc + menu).
  const pluginLocalize = usePluginLocalizedTextResolver({
    projection: controlTargets.pluginProjection,
  });
  const unavailableChips = React.useMemo(
    () => [
      ...(accountChip ? [accountChip] : []),
      ...(capabilitiesChip ? [capabilitiesChip] : []),
      createAttachmentActionChip({
        onPickFile: noop,
        onPickImage: noop,
        disabledReason: t('session.participants.bulk.attachmentsUnavailable'),
      }),
      // Linked files resolve under one Session's folder; the row stays to say so (lab bc + menu).
      createUnavailableComposerControlChip({
        key: 'bulk-linked-files-unavailable',
        controlId: 'linkedFiles',
        placement: getLinkedFilesActionChipPlacement(),
        reason: t('session.participants.bulk.linkedFilesUnavailable'),
      }),
      ...controlTargets.pluginControls.map((control) =>
        createUnavailablePluginComposerControlChip({
          control,
          localize: pluginLocalize,
          reason: t('session.participants.bulk.pluginUnavailable'),
        }),
      ),
    ],
    [accountChip, capabilitiesChip, controlTargets.pluginControls, pluginLocalize],
  );
  const extraActionChips = React.useMemo(
    () => (toChip ? [toChip, ...unavailableChips] : unavailableChips),
    [toChip, unavailableChips],
  );

  const readyCount = planningTargets.length;
  const send = useEventCallback(() => {
    setSubmittedText(composer.textStore.getPrompt());
    void composer.send();
  });
  const done = useEventCallback(() =>
    safeRouterBack({ router, navigation, fallbackHref: '/' }),
  );
  // A phone page with no native bar carries its own way out (lab: the composer's head line), in both of its states.
  const phoneBack = usePhoneDestinationBack('bulk-compose:back');

  if (composer.rows.length > 0) {
    return (
      <View style={styles.screen}>
      <PhonePageBackLine control={phoneBack} page />
      <BulkSessionResults
        rows={composer.rows}
        text={submittedText}
        submitting={composer.submitting}
        compact={phone}
        onRetry={(target) => {
          void composer.retryFailed(target);
        }}
        onRetryFailed={() => {
          void composer.retryFailed();
        }}
        onDone={done}
        onOpenSession={(href) => router.push(href as never)}
        agentTitles={agentTitles}
      />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
    <PhonePageBackLine control={phoneBack} page />
    <View testID="bulk-compose-screen" style={styles.page}>
      {controlTargets.probes}
      {enginePickerOpen ? enginePicker.readinessDemand : null}
      <View style={styles.spacerTop} />
      <Hero phone={phone} />
      <View style={styles.column}>
        <AgentInput
          value={composer.textStore}
          onChangeText={composer.setText}
          placeholder={t('session.participants.bulk.placeholder')}
          minHeight={BULK_COMPOSE_INPUT_MIN_HEIGHT}
          inputAccessibilityLabel={t('session.participants.bulk.placeholder')}
          submitAccessibilityLabel={t('session.participants.bulk.sendTo', {
            count: readyCount,
          })}
          onSend={send}
          isSendDisabled={!composer.canSend}
          isSending={composer.submitting}
          extraActionChips={extraActionChips}
          agentType={engineAgentType}
          permissionMode={permissionMode}
          allowedPermissionModes={allowedPermissionModes}
          permissionModeUnselectedLabel={mixedLabel}
          // The permission chip is the one place the mode reads; the status row above the card stays empty.
          showStatusPermissionMode={false}
          onPermissionModeChange={
            permissionControl.kind === 'options' ? setPermissionMode : undefined
          }
          engineControls={engineOpens ? 'auto' : 'none'}
          engineLabel={engineLabel}
          agentPickerOptions={engineOpens ? enginePicker.options : undefined}
          agentPickerSelectedOptionId={engineSelectedOptionId}
          engineUnselected={engineUnselected}
          onAgentPickerSelect={enginePicker.onSelect}
          onAgentClick={enginePicker.onAgentClick}
          onAgentPickerVisibilityChange={setEnginePickerOpen}
          voiceAffordance="dictation"
          messageHistory="none"
          promptLibrary="none"
          referenceRecents="none"
          autocompleteKinds={NO_AUTOCOMPLETE_KINDS}
          autocompleteSuggestions={NO_AUTOCOMPLETE_SUGGESTIONS}
        />
        {/* On the card's content edge, not the column's: the sentence reads as the composer's own footnote. */}
        <View style={styles.consequence}>
          <BulkConsequenceLine consequences={composer.consequences} targetCount={readyCount} />
        </View>
      </View>
      <View style={phone ? styles.spacerBottomPhone : styles.spacerBottom} />
    </View>
    </View>
  );
}

function Hero(props: Readonly<{ phone: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.heroRow}>
            <Text
                variant={props.phone ? 'title' : 'display'}
                emphasis="semiBold"
                accessibilityRole="header"
                style={[styles.hero, { color: theme.colors.text.primary }]}
            >
                {t('session.participants.bulk.hero')}
            </Text>
        </View>
    );
}

/** What Send will do, said once under the composer (lab bc consequence line, outcome-line anatomy). */
function BulkConsequenceLine(
  props: Readonly<{
    consequences: ReturnType<typeof useBulkSessionComposer>['consequences'];
    targetCount: number;
  }>,
) {
  const { theme } = useUnistyles();
  const { consequences } = props;
  const settingsChanged = consequences.actions.some(
    (actionId) => actionId !== 'session.message.send',
  );
  const parts = [
    consequences.engineSwitches > 0
      ? t('session.participants.bulk.willSwitch', {
          count: consequences.engineSwitches,
        })
      : null,
    consequences.restarts > 0
      ? t('session.participants.bulk.willRestart', {
          count: consequences.restarts,
        })
      : null,
  ].filter((part): part is string => part !== null);
  const text = settingsChanged ? (
    <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
      <Text
        variant="meta"
        emphasis="medium"
        style={{ color: theme.colors.text.primary }}
      >
        {t('session.participants.bulk.onSend')}
      </Text>{' '}
      {parts.length > 0
        ? parts.join(' · ')
        : t('session.participants.bulk.willApply', {
            count: countSettingsTargets(consequences),
          })}
    </Text>
  ) : props.targetCount === 1 ? (
    t('session.participants.bulk.keepsOwnOne')
  ) : (
    t('session.participants.bulk.keepsOwn')
  );
  return (
    <OutcomeRow
      testID="bulk-compose-consequence"
      glyph="arrows-left-right"
      text={text}
      link={null}
    />
  );
}

function countSettingsTargets(
  consequences: ReturnType<typeof useBulkSessionComposer>['consequences'],
): number {
  return Math.max(
    consequences.messages,
    consequences.engineSwitches,
    consequences.restarts,
    1,
  );
}

type BulkChipInput = Readonly<{
  targets: readonly CrossSessionAuthoringControlTarget[] | null;
  selection: ExistingSessionChangeSet;
  setSelection: (selection: ExistingSessionChangeSet) => void;
  agentSwitchingEnabled: boolean;
  mixedLabel: string;
}>;

/** Why a cross-session control can't be offered, in the + menu's disabled row; null hides the row (nothing to offer). */
function describeBulkControlUnavailable(
  model: SessionAuthoringFieldControlModel,
): string | null {
  if (model.kind !== 'unavailable') return null;
  if (model.reason === 'requires_agent_target')
    return t('session.participants.bulk.engineMixedUnavailable');
  if (model.reason === 'differs_between_targets')
    return t('session.participants.bulk.differsUnavailable');
  return null;
}

const INERT_MCP_CONTEXT = { machineId: '', machineName: null, directory: '', serverId: null } as const;
const INERT_ACCOUNT_CONTEXT = { serverId: null } as const;
const NO_CONNECTED_ACCOUNTS: readonly never[] = [];

/**
 * Runs through: the existing account chip and popover over the targets' shared Agent. It reads the targets' one
 * current route, or says Mixed while they differ; a pick edits the pending change set, applied on Send.
 */
function useBulkAccountChip(
  input: BulkChipInput & Readonly<{ facts: readonly BulkSessionAuthoringFact[] }>,
) {
  const { targets, selection, setSelection, agentSwitchingEnabled, mixedLabel, facts } = input;
  const model = useCrossSessionAuthoringFieldControl({
    field: 'connectedServices',
    targets: targets ?? NO_CONTROL_TARGETS,
    selection,
    agentSwitchingEnabled,
    mixedLabel,
  });
  const current = React.useMemo(() => {
    const ready = facts.filter((fact) => fact.status === 'ready');
    const first = ready[0]?.connectedServices ?? null;
    return {
      value: first,
      mixed: ready.some((fact) => !areSnapshotProjectionsEquivalent(fact.connectedServices ?? null, first)),
    };
  }, [facts]);
  const pending = selection.connectedServices;
  const onChange = useEventCallback((bindings: WorkflowSessionAuthoringSelection['connectedServices']) => {
    setSelection({ ...selection, connectedServices: bindings });
  });
  const available = model.kind === 'connectedServices' ? model : null;
  const chip = useSessionAuthoringConnectedServicesChip({
    agentId: available?.agentId ?? '',
    agentIdentity: available?.agentIdentity ?? null,
    connectedAccounts: available?.connectedAccounts ?? NO_CONNECTED_ACCOUNTS,
    context: available?.context ?? INERT_ACCOUNT_CONTEXT,
    value: pending !== undefined ? pending : current.value,
    pending: pending !== undefined,
    onChange,
    ...(pending === undefined && current.mixed ? { mixedLabel } : {}),
  });
  const reason = targets ? describeBulkControlUnavailable(model) : null;
  return React.useMemo(() => {
    if (available) return chip;
    if (!reason) return null;
    return createUnavailableComposerControlChip({
      key: 'bulk-connected-services-unavailable',
      controlId: 'connectedServices',
      placement: getConnectedServicesAuthActionChipPlacement({ scoped: true }),
      reason,
    });
  }, [available, chip, reason]);
}

/**
 * Skills/MCP: the existing draft sheet, previewed on the targets' one Machine. Offered only while every target
 * holds the same selection there (the cross-session owner decides); otherwise the + menu says why.
 */
function useBulkCapabilitiesChip(
  input: Omit<BulkChipInput, 'setSelection'> & Readonly<{ setCapabilityItem: (delta: ExistingSessionCapabilityDelta) => void }>,
) {
  const { targets, selection, setCapabilityItem, agentSwitchingEnabled, mixedLabel } = input;
  const model = useCrossSessionAuthoringFieldControl({
    field: 'capabilitySelection',
    targets: targets ?? NO_CONTROL_TARGETS,
    selection,
    agentSwitchingEnabled,
    mixedLabel,
  });
  const available = model.kind === 'mcp' ? model : null;
  // Each target's own selection: the sheet reads Mixed where they differ, and an item edit reaches every target
  // while keeping each one's other overrides (applied on Send).
  const selections = React.useMemo(
    () => (targets ?? NO_CONTROL_TARGETS).map((target) => target.values.capabilitySelection),
    [targets],
  );
  const chip = useSessionAuthoringCapabilitiesChip({
    agentId: available?.agentId ?? '',
    context: available?.context ?? INERT_MCP_CONTEXT,
    itemEditing: {
      selections,
      deltas: selection.capabilityDeltas,
      onChange: setCapabilityItem,
    },
  });
  const reason = targets ? describeBulkControlUnavailable(model) : null;
  return React.useMemo(() => {
    if (available) return chip;
    if (!reason) return null;
    return createUnavailableComposerControlChip({
      key: 'bulk-capabilities-unavailable',
      controlId: 'capabilities',
      placement: getCapabilitiesActionChipPlacement({ scoped: true }),
      reason,
    });
  }, [available, chip, reason]);
}

/**
 * The To chip's controlled model: every frozen target, with the ones that can't receive this (archived, can't
 * resume, read only) in a Skipped group with why. Unchecking a target removes it from this compose only.
 */
function useBulkSessionToModel(
  input: Readonly<{
    seedTargets: readonly ActionSessionAddressV1[];
    targets: readonly ActionSessionAddressV1[];
    facts: readonly BulkSessionAuthoringFact[];
    names: readonly string[];
    /** Each fact's Machine name, in fact order. */
    machineLabels: readonly (string | null)[];
    /** Agent titles from the Machine-scoped catalog, by catalog Agent id. */
    agentTitles: ReadonlyMap<string, string>;
    onChange: (next: readonly ActionSessionAddressV1[]) => void;
  }>,
): RecipientMultiSelectModel<ActionSessionAddressV1> {
  const { seedTargets, targets, facts, names, machineLabels, agentTitles, onChange } = input;
  return React.useMemo(() => {
    const nameByKey = new Map(
      targets.map((target, index) => [
        sessionAddressKey(target),
        names[index] ?? target.sessionId,
      ]),
    );
    const factByKey = new Map(
      facts.map((fact) => [sessionAddressKey(fact.address), fact]),
    );
    const machineByKey = new Map(
      facts.map((fact, index) => [sessionAddressKey(fact.address), machineLabels[index] ?? null]),
    );
    const reachable = seedTargets.filter(
      (target) =>
        factByKey.get(sessionAddressKey(target))?.status !== 'skipped',
    );
    const skipped = facts
      .filter((fact) => fact.status === 'skipped')
      .map((fact) => ({
        id: sessionAddressKey(fact.address),
        label:
          nameByKey.get(sessionAddressKey(fact.address)) ??
          fact.address.sessionId,
        reason: describeBulkSkipReason(fact.reason),
      }));
    const selectedCount = targets.filter(
      (target) =>
        factByKey.get(sessionAddressKey(target))?.status !== 'skipped',
    ).length;
    const recipients = targets.filter(
      (target) =>
        factByKey.get(sessionAddressKey(target))?.status !== 'skipped',
    );
    return {
      targets: reachable.map((target) => {
        const fact = factByKey.get(sessionAddressKey(target));
        const catalogAgentId = resolveBulkTargetCatalogAgentId(fact?.agentTarget);
        const machineLabel = machineByKey.get(sessionAddressKey(target)) ?? null;
        // The row says which agent and where it runs, in words ("Codex · devbox", lab bc To list).
        const subtitle = [catalogAgentId ? agentTitles.get(catalogAgentId) ?? null : null, machineLabel]
          .filter((part): part is string => Boolean(part))
          .join(' · ');
        return {
          id: sessionAddressKey(target),
          label: nameByKey.get(sessionAddressKey(target)) ?? target.sessionId,
          recipient: target,
          ...(subtitle ? { subtitle } : {}),
          // The agent mark keeps the leading slot.
          ...(catalogAgentId ? { icon: (
            <SessionAgentCatalogIdentityIcon
              agentId={catalogAgentId}
              machineId={fact?.machineId ?? null}
              serverId={target.serverId}
              size={ICON_SIZE.sm}
            />
          ) } : {}),
        };
      }),
      selectedIds: recipients.map(sessionAddressKey),
      selectedRecipients: recipients,
      removedRecipients: [],
      skipped,
      summaryLabel: t('session.participants.bulk.to', { count: selectedCount }),
      ...(skipped.length > 0
        ? { summaryDetail: t('session.participants.bulk.skippedCount', { count: skipped.length }) }
        : {}),
      toggle(id) {
        const selected = new Set(targets.map(sessionAddressKey));
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        // Keep the seed's order, so a target unchecked and checked again returns to its place.
        onChange(
          seedTargets.filter((target) =>
            selected.has(sessionAddressKey(target)),
          ),
        );
      },
      clear: () => onChange([]),
    };
  }, [agentTitles, facts, machineLabels, names, onChange, seedTargets, targets]);
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    flex: 1,
  },
  page: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: theme.space.s16,
  },
  spacerTop: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: theme.space.s32,
  },
  spacerBottom: {
    // The lab seats the composer in the upper third: more room under it than above the hero.
    flexGrow: 2.6,
    flexShrink: 1,
    flexBasis: 0,
  },
  spacerBottomPhone: {
    height: theme.space.s16,
  },
  heroRow: {
    // No gap of its own: the composer's reserved status row above its card already spaces it from the hero.
    width: '100%',
    maxWidth: COMPOSE_COLUMN_MAX_WIDTH,
  },
  hero: {
    textAlign: 'center',
  },
  // The composer's own column, then the card's content inset (where its chrome-free notices stand): a chip popover
  // hangs on that edge, so the line's glyph never peeks out beside one (BC-D5 N5).
  consequence: {
    paddingHorizontal: resolveAgentInputColumn({ screenWidth: rt.screen.width }).paddingHorizontal
      + resolveComposerCardContentInsetX(theme, rt.screen.width),
  },
  column: {
    width: '100%',
    maxWidth: COMPOSE_COLUMN_MAX_WIDTH,
  },
}));
