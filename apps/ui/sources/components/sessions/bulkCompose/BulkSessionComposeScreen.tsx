import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { resolveHappierTypeScale } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';

import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import {
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { isBundledAgentId } from '@/agents/registry/registryCore';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { AgentInput } from '@/components/sessions/agentInput';
import { createRecipientMultiSelectActionChip } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import type { RecipientMultiSelectModel } from '@/components/sessions/agentInput/routing/recipientMultiSelectModel';
import {
  readBulkSessionComposerSeed,
  useFrozenBulkSessionTargets,
  type BulkSessionComposerSeed,
} from '@/components/sessions/authoring/bulk/bulkSessionComposerHandoff';
import { useBulkSessionComposer } from '@/components/sessions/authoring/bulk/useBulkSessionComposer';
import { useHydratedBulkSessionAuthoringFacts } from '@/components/sessions/authoring/bulk/useHydratedBulkSessionAuthoringFacts';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
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
import { createUnavailablePluginComposerControlChip } from '@/components/plugins/actions/pluginContributedActionComposerChips';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import type { CrossSessionAuthoringControlTarget } from '@/components/sessions/authoring/controls/crossSessionAuthoringFieldControls';
import { useCrossSessionAuthoringFieldControl } from '@/components/sessions/authoring/controls/useCrossSessionAuthoringFieldControl';
import { useSessionAuthoringEnginePicker } from '@/components/sessions/authoring/controls/useSessionAuthoringEnginePicker';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

import { useBulkSessionControlTargets } from './BulkSessionControlTargets';
import {
  AGENT_INPUT_FIELD_CONTAINER_PADDING_Y,
  AGENT_INPUT_FIELD_PADDING_Y,
} from '@/components/sessions/agentInput/components/agentInputChromeStyles';

import { BulkSessionResults } from './BulkSessionResults';
import { describeBulkSkipReason } from './bulkSessionComposePresentation';
import { useBulkSessionTargetNames } from './useBulkSessionTargetIdentities';

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
  const toModel = useBulkSessionToModel({
    seedTargets: props.seed.targets,
    targets,
    facts,
    names,
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

  // The engine picker is the shipped one, with rows narrowed to the Agents every target's Machine offers.
  const engineOptionIds = React.useMemo(
    () =>
      engineControl.kind === 'options'
        ? new Set(engineControl.options.map((option) => option.id))
        : null,
    [engineControl],
  );
  const leadFacts = controlTargets.leadFacts;
  const enginePickerFacts = React.useMemo(
    () =>
      leadFacts && engineOptionIds
        ? {
            ...leadFacts,
            agentTargets: (leadFacts.agentTargets ?? []).filter((option) =>
              engineOptionIds.has(option.id),
            ),
          }
        : undefined,
    [engineOptionIds, leadFacts],
  );
  const changeEngineFields = useEventCallback(
    (fields: Partial<WorkflowSessionAuthoringSelection>) => {
      composer.setSelection({ ...composer.selection, ...fields });
    },
  );
  const enginePicker = useSessionAuthoringEnginePicker({
    values: composer.selection,
    facts: enginePickerFacts,
    disabled: engineControl.kind !== 'options',
    onChangeFields: changeEngineFields,
  });
  const sharedAgentType = React.useMemo(
    () =>
      readSharedValue(facts, (fact) => fact.agentTarget?.identity.localId ?? null),
    [facts],
  );
  const engineLabel = composer.selection.agentTarget
    ? enginePicker.label
    : engineControl.kind === 'options'
      ? (engineControl.options.find(
          (option) => option.id === engineControl.selectedOptionId,
        )?.label ??
        engineControl.unselectedLabel ??
        mixedLabel)
      : sharedAgentType && isBundledAgentId(sharedAgentType)
        ? resolveAgentCatalogTitle(sharedAgentType)
        : mixedLabel;
  const engineAgentType =
    enginePicker.agentId ??
    (composer.selection.agentTarget ? undefined : (sharedAgentType ?? undefined));
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
  const engineUnselected = engineSelectedOptionId === null && !engineAgentType;
  const [enginePickerOpen, setEnginePickerOpen] = React.useState(false);

  // Attachments and plugin controls are per Session; the + menu names them, disabled, with why (lab bc + menu).
  const pluginLocalize = usePluginLocalizedTextResolver({
    projection: controlTargets.pluginProjection,
  });
  const unavailableChips = React.useMemo(
    () => [
      createAttachmentActionChip({
        onPickFile: noop,
        onPickImage: noop,
        disabledReason: t('session.participants.bulk.attachmentsUnavailable'),
      }),
      ...controlTargets.pluginControls.map((control) =>
        createUnavailablePluginComposerControlChip({
          control,
          localize: pluginLocalize,
          reason: t('session.participants.bulk.pluginUnavailable'),
        }),
      ),
    ],
    [controlTargets.pluginControls, pluginLocalize],
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

  if (composer.rows.length > 0) {
    return (
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
      />
    );
  }

  return (
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
        {/* On the card's edge, not the column's: the sentence reads as the composer's own footnote. */}
        <View style={styles.consequence}>
          <BulkConsequenceLine consequences={composer.consequences} />
        </View>
      </View>
      <View style={phone ? styles.spacerBottomPhone : styles.spacerBottom} />
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

function readSharedValue<T>(
  facts: readonly BulkSessionAuthoringFact[],
  read: (fact: BulkSessionAuthoringFact) => T | null,
): T | null {
  const ready = facts.filter((fact) => fact.status === 'ready');
  if (ready.length === 0) return null;
  const first = read(ready[0]!);
  return ready.every((fact) => read(fact) === first) ? first : null;
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
    onChange: (next: readonly ActionSessionAddressV1[]) => void;
  }>,
): RecipientMultiSelectModel<ActionSessionAddressV1> {
  const { seedTargets, targets, facts, names, onChange } = input;
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
        const agentType = factByKey.get(sessionAddressKey(target))?.agentTarget?.identity.localId ?? null;
        return {
          id: sessionAddressKey(target),
          label: nameByKey.get(sessionAddressKey(target)) ?? target.sessionId,
          recipient: target,
          // The agent mark keeps the leading slot (lab bc To list); the row says which agent in words too.
          ...(agentType && isBundledAgentId(agentType)
            ? { subtitle: resolveAgentCatalogTitle(agentType), icon: <AgentIcon agentId={agentType} size={ICON_SIZE.sm} /> }
            : {}),
        };
      }),
      selectedIds: recipients.map(sessionAddressKey),
      selectedRecipients: recipients,
      removedRecipients: [],
      skipped,
      summaryLabel:
        skipped.length > 0
          ? t('session.participants.bulk.toWithSkipped', {
              count: selectedCount,
              skipped: skipped.length,
            })
          : t('session.participants.bulk.to', { count: selectedCount }),
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
  }, [facts, names, onChange, seedTargets, targets]);
}

const styles = StyleSheet.create((theme) => ({
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
  consequence: {
    paddingHorizontal: theme.space.s16,
  },
  column: {
    width: '100%',
    maxWidth: COMPOSE_COLUMN_MAX_WIDTH,
  },
}));
