import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  WorkflowDefinitionCaptureRequestV1,
  WorkflowDefinitionCaptureResultV1,
} from '@happier-dev/protocol/workflows/actionsV1';
import { workflowInputTitle } from '@happier-dev/protocol/workflows/workflowV1';

import { useExecutableParticipantLabel } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { ExecutableParticipantPickerBody } from '@/components/sessions/authoring/ExecutableParticipantPickerBody';
import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import {
  ExpandableItem,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { useInlineLevelFocusReturn } from '@/keyboard/focusReturn';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { projectWorkflowFlow } from '@/components/workflows/flow/workflowFlowProjection';
import { listWorkflowPersonInputs, resolveWorkflowBuiltinInputPresentation } from '@/components/workflows/presentation/workflowBuiltinInputPresentation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { DiscussionSheetHeader } from './DiscussionInviteSheet';
import type { useDiscussionWorkflowCapture } from './useDiscussionWorkflowCapture';

/** A committed message the person can build a pattern from, as the thread shows it. */
export type DiscussionPatternCaptureMessage = Readonly<{
  id: string;
  author: string;
  text: string;
}>;

type Capture = ReturnType<typeof useDiscussionWorkflowCapture>;
type CaptureStep = WorkflowDefinitionCaptureResultV1['steps'][number];
type CaptureChoice = NonNullable<
  WorkflowDefinitionCaptureRequestV1['choices']
>[number];
type CaptureRole = CaptureChoice['role'];
type UnresolvedReason =
  WorkflowDefinitionCaptureResultV1['unresolved'][number]['reason'];

const PANEL_WIDTH = 440;

/**
 * Save as pattern (lab T4s/Sp): from the Discussion's ⋯, choose the messages, review the steps built from
 * them (what each uses, who answers, what is asked each run), then open the unsaved draft in the Workflow
 * editor. The capture hook owns every read and the handoff; nothing here saves, starts or builds a graph.
 */
export function DiscussionPatternCapturePanel(
  props: Readonly<{
    capture: Capture;
    anchorRef: React.RefObject<View | null>;
    discussionTitle: string;
    messages: readonly DiscussionPatternCaptureMessage[];
    accountLifetime: ServerAccountScopeLifetime;
  }>,
) {
  const { capture } = props;
  const { state } = capture;
  const open = state.status !== 'closed';
  const choosing = state.status === 'selection';
  const [chosen, setChosen] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The name starts as the Discussion's title: an editable, prefilled value, never a placeholder.
  const [typedName, setName] = React.useState<string | null>(null);
  const name = typedName ?? props.discussionTitle;
  // Choosing again starts from what was built last time; a fresh open starts empty.
  const requestIds = state.request?.messageIds;
  React.useEffect(() => {
    if (choosing && requestIds?.length) setChosen(new Set(requestIds));
  }, [choosing, requestIds]);
  const reviewed = React.useRef<readonly string[]>([]);
  if (state.request?.messageIds.length)
    reviewed.current = state.request.messageIds;

  const toggle = React.useCallback(
    (id: string) =>
      setChosen((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const reviewChosen = React.useCallback(() => {
    const ids = props.messages
      .filter((message) => chosen.has(message.id))
      .map((message) => message.id);
    if (ids.length)
      void capture.review({ messageIds: ids, choices: undefined });
  }, [capture, chosen, props.messages]);
  const chooseAgain = React.useCallback(() => {
    setChosen(new Set(reviewed.current));
    void capture.review({ messageIds: [] });
  }, [capture]);
  const choose = React.useCallback(
    (step: CaptureStep, patch: Partial<Omit<CaptureChoice, 'messageId'>>) => {
      const current = state.request?.choices ?? [];
      const base = current.find(
        (choice) => choice.messageId === step.messageId,
      ) ?? { messageId: step.messageId, role: step.role };
      void capture.review({
        choices: [
          ...current.filter((choice) => choice.messageId !== step.messageId),
          { ...base, ...patch },
        ],
      });
    },
    [capture, state.request?.choices],
  );
  const openEditor = React.useCallback(() => {
    capture.openEditor({ name: name.trim() || props.discussionTitle });
    capture.close();
  }, [capture, name, props.discussionTitle]);

  if (!open) return null;
  const draft = state.draft;
  const footer = (
    <RoundButtonSizeScope size="small" presentation="uniform">
      <View style={styles.footer}>
        <RoundButton
          testID="discussion-pattern-capture-cancel"
          size="small"
          display="inverted"
          title={t('common.cancel')}
          onPress={capture.close}
        />
        <View style={styles.footerEnd}>
          {choosing ? (
            <RoundButton
              testID="discussion-pattern-capture-review"
              size="small"
              title={t('workflows.start.capture.reviewSteps')}
              disabled={chosen.size === 0}
              onPress={reviewChosen}
            />
          ) : (
            <RoundButton
              testID="discussion-pattern-capture-open-editor"
              size="small"
              title={t('workflows.start.capture.openInEditor')}
              disabled={!capture.canOpenEditor}
              loading={state.status === 'loading'}
              onPress={openEditor}
            />
          )}
        </View>
      </View>
    </RoundButtonSizeScope>
  );

  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      placement="bottom"
      gap={6}
      maxHeightCap={720}
      maxWidthCap={PANEL_WIDTH}
      fit="shift"
      phonePresentation="sheet"
      sheetHeader="none"
      accessibilityLabel={t('workflows.start.capture.title')}
      onRequestClose={capture.close}
      backdrop={{ enabled: false }}
      portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
    >
      {({ maxHeight }) => (
        <FloatingOverlay
          maxHeight={maxHeight}
          surfaceChrome="theme"
          scrollEnabled
          keyboardShouldPersistTaps="handled"
          header={
            <View style={styles.header}>
              <DiscussionSheetHeader
                icon="bookmark"
                title={t('workflows.start.capture.title')}
                subtitle={t('workflows.start.capture.subtitle', {
                  title: props.discussionTitle,
                })}
              />
            </View>
          }
          footer={footer}
        >
          <View testID="discussion-pattern-capture" style={styles.body}>
            {choosing ? (
              <ChooseMessages
                messages={props.messages}
                chosen={chosen}
                onToggle={toggle}
              />
            ) : (
              <Review
                capture={capture}
                draft={draft}
                name={name}
                onNameChange={setName}
                onChooseAgain={chooseAgain}
                onChoose={choose}
                accountLifetime={props.accountLifetime}
              />
            )}
          </View>
        </FloatingOverlay>
      )}
    </Popover>
  );
}

function ChooseMessages(
  props: Readonly<{
    messages: readonly DiscussionPatternCaptureMessage[];
    chosen: ReadonlySet<string>;
    onToggle: (id: string) => void;
  }>,
) {
  if (props.messages.length === 0) {
    return (
      <SurfaceStateCard
        testID="discussion-pattern-capture-empty"
        size="line"
        layout="inline"
        kind="empty"
        title={t('workflows.start.capture.emptyTitle')}
        reason={t('workflows.start.capture.emptyBody')}
      />
    );
  }
  return (
    <View>
      <CollectionListGroupLabel
        first
        presentation="menu"
        title={t('workflows.start.capture.chooseTitle')}
        trailing={
          props.chosen.size > 0 ? (
            <Text style={styles.count}>
              {t('workflows.start.capture.chosenCount', {
                count: props.chosen.size,
              })}
            </Text>
          ) : undefined
        }
      />
      <Text style={styles.description}>
        {t('workflows.start.capture.chooseDescription')}
      </Text>
      {props.messages.map((message) => {
        const selected = props.chosen.has(message.id);
        return (
          <Item
            key={message.id}
            testID={`discussion-pattern-capture-message:${message.id}`}
            density="compact"
            rowRole="menu"
            showChevron={false}
            showDivider={false}
            selected={selected}
            accessibilityRole="checkbox"
            accessibilityChecked={selected}
            leftElement={
              <Icon
                name={selected ? 'check-square' : 'square'}
                size={ICON_SIZE.sm}
              />
            }
            title={message.author}
            subtitle={message.text}
            subtitleLines={2}
            onPress={() => props.onToggle(message.id)}
          />
        );
      })}
    </View>
  );
}

function Review(
  props: Readonly<{
    capture: Capture;
    draft: WorkflowDefinitionCaptureResultV1 | null;
    name: string;
    onNameChange: (name: string) => void;
    onChooseAgain: () => void;
    onChoose: (
      step: CaptureStep,
      patch: Partial<Omit<CaptureChoice, 'messageId'>>,
    ) => void;
    accountLifetime: ServerAccountScopeLifetime;
  }>,
) {
  const { state } = props.capture;
  const draft = props.draft;
  const language = usePreferredLanguage();
  const definition = draft?.definition;
  // The ordinary Flow owner reads the exact draft that editor intake and Save consume.
  // Message roles below exist only to repair an unresolved source selection.
  const flow = React.useMemo(() => definition ? projectWorkflowFlow(definition) : null, [definition, language]);
  const inputPresentation = resolveWorkflowBuiltinInputPresentation(draft?.provenance.workflow?.source.ref);
  const inputs = definition ? listWorkflowPersonInputs(definition.inputs) : [];
  const numbers = React.useMemo(() => {
    const map = new Map<string, number>();
    if (draft?.definition) return map;
    draft?.steps
      .filter((step) => step.role !== 'exclude')
      .forEach((step, index) => map.set(step.messageId, index + 1));
    return map;
  }, [draft]);
  const unresolved = React.useMemo(() => {
    const map = new Map<string, UnresolvedReason[]>();
    for (const item of draft?.unresolved ?? [])
      map.set(item.messageId, [
        ...(map.get(item.messageId) ?? []),
        item.reason,
      ]);
    return map;
  }, [draft]);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isExpanded = (id: string) => expanded.has(id) || unresolved.has(id);
  const toggle = (id: string, next: boolean) =>
    setExpanded((previous) => {
      const copy = new Set(previous);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  const problem =
    state.status === 'failed'
      ? resolveWorkflowProblemPresentation(state.error)
      : null;
  const kept = draft?.definition ? [] : draft?.steps.filter((step) => step.role !== 'exclude') ?? [];
  const sourceCount =
    draft?.provenance.messages.length ?? state.request?.messageIds.length ?? 0;

  return (
    <View style={styles.review}>
      <FieldItem label={t('workflows.start.capture.name')} style={styles.inset}>
        <FieldTextInput
          testID="discussion-pattern-capture-name"
          accessibilityLabel={t('workflows.start.capture.name')}
          value={props.name}
          selectTextOnFocus
          onChangeText={props.onNameChange}
        />
      </FieldItem>
      {problem ? (
        <SurfaceStateCard
          testID="discussion-pattern-capture-failed"
          size="line"
          layout="inline"
          kind="error"
          accessibilitySemantics="alert"
          title={t('workflows.start.capture.failedTitle')}
          reason={problem.message}
          action={{
            label: t('workflows.start.retry.action'),
            onPress: () => void props.capture.review(),
          }}
        />
      ) : null}
      {draft?.status === 'needs_review' && state.status === 'review' ? (
        <SurfaceStateCard
          testID="discussion-pattern-capture-needs-review"
          size="line"
          layout="inline"
          kind="warning"
          accessibilitySemantics="status"
          title={t('workflows.start.capture.needsReview', {
            count: unresolved.size,
          })}
        />
      ) : null}
      <View>
        <CollectionListGroupLabel
          presentation="menu"
          title={t('workflows.start.capture.stepsTitle')}
          trailing={
            <TextLinkButton
              testID="discussion-pattern-capture-change"
              size="meta"
              label={t('workflows.start.capture.changeMessages')}
              onPress={props.onChooseAgain}
            />
          }
        />
        {state.status === 'loading' ? (
          <SurfaceStateCard
            testID="discussion-pattern-capture-loading"
            size="line"
            layout="inline"
            kind="loading"
            accessibilitySemantics="status"
            title={t('workflows.start.capture.building')}
          />
        ) : null}
        {draft ? (
          <ItemGroup
            header="none"
            surface="sheet"
            style={state.status === 'loading' ? styles.stale : undefined}
          >
            {flow ? flow.nodes.map((node, index) => (
              <Item
                key={node.nodeId}
                testID={`discussion-pattern-capture-step:${node.nodeId}`}
                density="compact"
                title={node.label}
                subtitle={node.labelDetail}
                showChevron={false}
                showDivider={index < flow.nodes.length - 1}
                leftElement={<Text style={styles.number}>{node.stepOrdinal ?? '–'}</Text>}
              />
            )) : draft.steps.map((step, index) => (
              <CaptureStepRow
                key={step.messageId}
                step={step}
                number={numbers.get(step.messageId) ?? null}
                numbers={numbers}
                earlier={draft.steps
                  .slice(0, index)
                  .filter((earlier) => earlier.role !== 'exclude')}
                reasons={unresolved.get(step.messageId) ?? []}
                expanded={isExpanded(step.messageId)}
                onExpandedChange={(next) => toggle(step.messageId, next)}
                last={index === draft.steps.length - 1}
                disabled={state.status === 'loading'}
                onChoose={(patch) => {
                  // A row the person is settling stays open once its reason clears.
                  toggle(step.messageId, true);
                  props.onChoose(step, patch);
                }}
                accountLifetime={props.accountLifetime}
              />
            ))}
          </ItemGroup>
        ) : null}
      </View>
      {draft ? (
        <View>
          <CollectionListGroupLabel
            presentation="menu"
            title={t('workflows.start.capture.askedTitle')}
          />
          <View testID="discussion-pattern-capture-asked" style={styles.chips}>
            {definition ? inputs.map((input) => {
              const title = workflowInputTitle(input, inputPresentation?.[input.name]
                ?? (input.name === 'participants' ? { title: t('workflows.builtins.patternInputs.participants') } : undefined));
              const chip = { name: input.name, title, perRun: input.required,
                onToggle: !draft.provenance.workflow && state.status === 'review'
                  ? () => void props.capture.setInputPerRun(input.name, !input.required) : undefined };
              return input.inputType && 'hostType' in input.inputType && input.inputType.hostType === 'agentParticipant'
                ? <CaptureParticipantInputChip key={input.name} {...chip}
                    value={draft.inputs[input.name] ?? input.default} serverId={props.accountLifetime.scope.serverId} />
                : <CaptureInputChip key={input.name} {...chip} />;
            }) : kept.map((step) => (
              <SelectionListFilterChip
                key={step.messageId}
                filter={{
                  id: `ask:${step.messageId}`,
                  testID: `discussion-pattern-capture-ask:${step.messageId}`,
                  label: t('workflows.start.capture.askEachRun'),
                  valueLabel: stepInputLabel(step, numbers.get(step.messageId) ?? 0),
                  icon: <Icon name={step.role === 'step' ? 'users' : 'chat-circle'} size={ICON_SIZE.xs} />,
                  selected: step.perRun,
                  onToggle: () => {
                    if (state.status !== 'loading')
                      props.onChoose(step, { perRun: !step.perRun });
                  },
                }}
              />
            ))}
          </View>
          {(definition ? inputs.length > 0 : kept.some((step) => step.perRun)) ? null : (
            <Text style={styles.description}>
              {t('workflows.start.capture.askedNone')}
            </Text>
          )}
        </View>
      ) : null}
      <View style={styles.note}>
        <Icon name="lock" size={ICON_SIZE.xs} />
        <Text style={styles.noteText}>
          {t('workflows.start.capture.privacy', { count: sourceCount })}
        </Text>
      </View>
    </View>
  );
}

type CaptureInputChipProps = Readonly<{
  name: string; title: string; perRun: boolean; valueLabel?: string; onToggle?: () => void;
}>;

function CaptureInputChip(props: CaptureInputChipProps) {
  return <SelectionListFilterChip filter={{
    id: `ask:${props.name}`, testID: `discussion-pattern-capture-ask:${props.name}`,
    label: t('workflows.start.capture.askEachRun'), valueLabel: props.title,
    valueQualifier: props.valueLabel, selected: props.perRun, onToggle: props.onToggle,
  }} />;
}

function CaptureParticipantInputChip(props: CaptureInputChipProps & Readonly<{ value: unknown; serverId: string }>) {
  const label = useExecutableParticipantLabel(props.value, props.serverId);
  return <CaptureInputChip {...props} valueLabel={label} />;
}

function stepInputLabel(step: CaptureStep, number: number): string {
  if (step.role === 'step')
    return t('workflows.start.capture.agentFor', { number });
  return step.inputName === 'question'
    ? t('workflows.start.capture.question')
    : t('workflows.start.capture.context', { number });
}

function CaptureStepRow(
  props: Readonly<{
    step: CaptureStep;
    number: number | null;
    numbers: ReadonlyMap<string, number>;
    earlier: readonly CaptureStep[];
    reasons: readonly UnresolvedReason[];
    expanded: boolean;
    onExpandedChange: (next: boolean) => void;
    last: boolean;
    disabled: boolean;
    onChoose: (patch: Partial<Omit<CaptureChoice, 'messageId'>>) => void;
    accountLifetime: ServerAccountScopeLifetime;
  }>,
) {
  const { theme } = useUnistyles();
  const { step } = props;
  const participant = useExecutableParticipantLabel(
    step.participant,
    props.accountLifetime.scope.serverId,
  );
  const uses = step.dependsOnMessageIds
    .map((id) => props.numbers.get(id))
    .filter((value): value is number => value !== undefined);
  const title =
    step.role === 'exclude'
      ? t('workflows.start.capture.leftOut')
      : step.role === 'step'
        ? participant
          ? t('workflows.start.capture.answers', { name: participant })
          : t('workflows.start.capture.someoneAnswers')
        : stepInputLabel(step, props.number ?? 0);
  const excerpt =
    step.text.trim() ||
    t('session.collaboration.discussion.contentUnavailable');
  const subtitle =
    uses.length > 0 && step.role !== 'exclude'
      ? `${t('workflows.start.capture.uses', { steps: uses.join(', ') })} · ${excerpt}`
      : excerpt;
  const [browsingParticipants, setBrowsingParticipants] = React.useState(false);
  // Back (or a choice) returns focus to the Who answers row the picker replaced.
  const participantFocus = useInlineLevelFocusReturn(browsingParticipants);
  const toggleUse = (id: string) => {
    const next = step.dependsOnMessageIds.includes(id)
      ? step.dependsOnMessageIds.filter((value) => value !== id)
      : [...step.dependsOnMessageIds, id];
    props.onChoose({ dependsOnMessageIds: next });
  };
  const attention = props.reasons.length > 0;
  return (
    <ExpandableItem
      testID={`discussion-pattern-capture-step:${step.messageId}`}
      expanded={props.expanded}
      onExpandedChange={props.onExpandedChange}
      showDivider={!props.last}
      header={({ headerProps }) => (
        <Item
          {...headerProps}
          testID={`discussion-pattern-capture-step:${step.messageId}:header`}
          density="compact"
          leftElement={
            <Text
              style={[
                styles.number,
                step.role === 'exclude' ? styles.muted : null,
              ]}
            >
              {props.number ?? '–'}
            </Text>
          }
          title={title}
          titleLines={1}
          subtitle={
            attention ? (
              <Text style={styles.attention}>
                {reasonCopy(props.reasons[0]!)}
              </Text>
            ) : (
              subtitle
            )
          }
          subtitleLines={attention ? 0 : 1}
          keepChevronWithRightElement
          rightElement={
            step.role === 'step' && step.perRun ? (
              <StatusPill
                testID={`discussion-pattern-capture-step-input:${step.messageId}`}
                variant="neutral"
                shape="capsule"
                hideDot
                labelVariant="phrase"
                label={stepInputLabel(step, props.number ?? 0)}
              />
            ) : undefined
          }
          accessibilityLabel={`${props.number ?? ''} ${title}. ${attention ? props.reasons.map(reasonCopy).join(' ') : subtitle}`}
        />
      )}
    >
      <View style={styles.stepBody}>
        {browsingParticipants ? <ExecutableParticipantPickerBody
          accountLifetime={props.accountLifetime}
          backRef={participantFocus.attachEntry}
          multiple={false}
          selected={step.participant}
          onResolve={picked => {
            setBrowsingParticipants(false);
            if (picked && 'kind' in picked && props.accountLifetime.isCurrent()) props.onChoose({ participant: picked });
          }}
        /> : <>
        {props.reasons.length > 1
          ? props.reasons.slice(1).map((reason) => (
              <Text key={reason} style={styles.attention}>
                {reasonCopy(reason)}
              </Text>
            ))
          : null}
        {attention ? (
          <Text style={styles.excerpt} numberOfLines={3}>
            {excerpt}
          </Text>
        ) : null}
        <SegmentedChoiceItem<CaptureRole>
          testIDPrefix={`discussion-pattern-capture-role:${step.messageId}`}
          title={t('workflows.start.capture.usedAs')}
          density="compact"
          disabled={props.disabled}
          options={[
            { id: 'input', label: t('workflows.start.capture.roleInput') },
            { id: 'step', label: t('workflows.start.capture.roleStep') },
            { id: 'exclude', label: t('workflows.start.capture.roleExclude') },
          ]}
          value={step.role}
          onChange={(role) => props.onChoose({ role })}
        />
        {step.role !== 'exclude' && props.earlier.length > 0 ? (
          <View>
            <Text style={styles.subLabel}>
              {t('workflows.start.capture.usesLabel')}
            </Text>
            {props.earlier.map((earlier) => {
              const checked = step.dependsOnMessageIds.includes(
                earlier.messageId,
              );
              const number = props.numbers.get(earlier.messageId) ?? 0;
              return (
                <Item
                  key={earlier.messageId}
                  testID={`discussion-pattern-capture-use:${step.messageId}:${earlier.messageId}`}
                  density="tight"
                  rowRole="menu"
                  showChevron={false}
                  showDivider={false}
                  disabled={props.disabled}
                  accessibilityRole="checkbox"
                  accessibilityChecked={checked}
                  leftElement={
                    <Icon
                      name={checked ? 'check-square' : 'square'}
                      size={ICON_SIZE.sm}
                      color={
                        checked
                          ? theme.colors.text.primary
                          : theme.colors.text.secondary
                      }
                    />
                  }
                  title={`${number} · ${earlier.text.trim() || stepInputLabel(earlier, number)}`}
                  titleLines={1}
                  onPress={() => toggleUse(earlier.messageId)}
                />
              );
            })}
          </View>
        ) : null}
        {step.role === 'step' ? (
          <Item
            testID={`discussion-pattern-capture-participant:${step.messageId}`}
            pressableRef={participantFocus.attachOrigin}
            density="compact"
            title={t('workflows.start.capture.whoAnswers')}
            detail={
              participant ?? t('workflows.start.capture.chooseParticipant')
            }
            disabled={props.disabled}
            onPress={() => setBrowsingParticipants(true)}
          />
        ) : null}
        {step.role !== 'exclude' ? (
          <Item
            testID={`discussion-pattern-capture-per-run:${step.messageId}`}
            density="compact"
            title={t('workflows.start.capture.askEachRun')}
            showChevron={false}
            subtitle={
              step.perRun
                ? t('workflows.start.capture.askEachRunOn')
                : t('workflows.start.capture.askEachRunOff')
            }
            rightElement={
              <Switch
                value={step.perRun}
                disabled={props.disabled}
                onValueChange={(perRun) => props.onChoose({ perRun })}
                accessibilityLabel={t('workflows.start.capture.askEachRun')}
              />
            }
          />
        ) : null}
        </>}
      </View>
    </ExpandableItem>
  );
}

function reasonCopy(reason: UnresolvedReason): string {
  return t(`workflows.start.capture.reasons.${reason}`);
}

const styles = StyleSheet.create((theme) => ({
  header: { paddingTop: theme.space.s8 },
  body: { paddingBottom: theme.space.s8 },
  // Text and fields start on the menu rows' text edge, under the section labels.
  inset: { paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx },
  review: { gap: theme.space.s12 },
  stale: { opacity: 0.6 },
  stepBody: {
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s8,
    gap: theme.space.s4,
  },
  description: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s6,
  },
  excerpt: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
  },
  subLabel: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
    paddingTop: theme.space.s6,
    paddingHorizontal: theme.space.s4,
  },
  count: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  number: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
    minWidth: MENU_ROW_METRICS.iconBoxSizePx,
    textAlign: 'center',
  },
  muted: { color: theme.colors.text.tertiary },
  attention: {
    ...Typography.variant('meta'),
    color: theme.colors.state.attention.textForeground,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
  },
  noteText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flex: 1,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
  },
  footerEnd: { marginLeft: 'auto' },
}));
