import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import {
  ReviewStepV1Schema,
  type ReviewReviewerSelectionV1,
  type ReviewStepV1,
} from '@happier-dev/protocol/reviews/reviewStart';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';

import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { ReviewLabel } from '../ReviewLabel';

/** How the host shows one chosen reviewer: its list row's own mark and name, and a typed readiness warning. */
export type ReviewStartReviewerPresentation = Readonly<{
  name: string;
  mark: React.ReactNode;
  /** The owner's readiness reason ("CodeRabbit needs an API key"), said on the folded step. */
  warning?: string | null;
}>;

export type ReviewStartStepsProps = Readonly<{
  /** The draft steps in `review.start`'s own step shape; Focus may still be empty while authoring. */
  steps: readonly ReviewStepV1[];
  onStepsChange: (next: readonly ReviewStepV1[]) => void;
  presentReviewer: (
    reviewer: ReviewReviewerSelectionV1,
    reviewerIndex: number,
    stepIndex: number,
  ) => ReviewStartReviewerPresentation;
  /** The host's shared Who list (ContextualStartComposerBody) bound to this step's reviewers. */
  renderWho: (stepIndex: number) => React.ReactNode;
  /** The subject is a Session, so the step's reviewers may read its transcript as ordinary input. */
  transcriptAvailable: boolean;
  disabled?: boolean;
}>;

/** Marks a folded step shows before "+N" (Reviews lab round 12, `RV.stepClosed`). */
const FOLDED_MARKS = 3;
const NO_STEP_INDEXES: ReadonlySet<number> = new Set();

function stepTitle(step: ReviewStepV1): string {
  return t(
    step.kind === 'verify'
      ? 'reviewWalkthrough.start.kindVerify'
      : 'reviewWalkthrough.start.kindReview',
  );
}

function withTranscript(
  reviewer: ReviewReviewerSelectionV1,
  include: boolean,
): ReviewReviewerSelectionV1 {
  if (reviewer.kind === 'person') return reviewer;
  const next = Object.assign({}, reviewer);
  if (include) next.includeSessionTranscript = true;
  else delete next.includeSessionTranscript;
  return next;
}

/** One index set after a step is removed: later steps move up by one. */
function withoutIndex(
  indexes: ReadonlySet<number>,
  removed: number,
): ReadonlySet<number> {
  return new Set(
    [...indexes].flatMap((index) =>
      index === removed ? [] : [index > removed ? index - 1 : index],
    ),
  );
}

/**
 * The start sheet's steps (Reviews lab rounds 8–12): each step is a disclosure whose own header toggles it, so
 * opening one never folds another. A folded step reads as one row: its title, what it does, who reviews
 * (their own marks, then "+N") and any readiness warning. "Add a step" adds a step that checks the previous
 * findings and opens it. Every step keeps its own Who list and Focus. Presentation only: the steps are the
 * host's draft in `review.start`'s step schema, and the host owns participant discovery and submission.
 */
export function ReviewStartSteps(props: ReviewStartStepsProps) {
  const { steps, onStepsChange } = props;
  const [open, setOpen] = React.useState<ReadonlySet<number>>(
    () => new Set([0]),
  );
  const [added, setAdded] =
    React.useState<ReadonlySet<number>>(NO_STEP_INDEXES);
  const latest = React.useRef(steps);
  latest.current = steps;

  const toggle = React.useCallback(
    (index: number, expanded: boolean) =>
      setOpen((current) => {
        const next = new Set(current);
        if (expanded) next.add(index);
        else next.delete(index);
        return next;
      }),
    [],
  );
  const updateStep = React.useCallback(
    (index: number, change: (step: ReviewStepV1) => ReviewStepV1) => {
      onStepsChange(
        latest.current.map((step, at) => (at === index ? change(step) : step)),
      );
    },
    [onStepsChange],
  );
  const removeStep = React.useCallback(
    (index: number) => {
      onStepsChange(latest.current.filter((_, at) => at !== index));
      setOpen((current) => withoutIndex(current, index));
      setAdded((current) => withoutIndex(current, index));
    },
    [onStepsChange],
  );
  const addStep = React.useCallback(() => {
    const index = latest.current.length;
    onStepsChange([
      ...latest.current,
      { kind: 'verify', reviewers: [], instructions: '' },
    ]);
    setOpen((current) => new Set([...current, index]));
    setAdded((current) => new Set([...current, index]));
  }, [onStepsChange]);
  const commands = useCurrentUiContextLocalCommands(props.disabled ? [] : [{
    key: 'review.start.steps.add',
    title: t('reviewWalkthrough.start.addStep'),
    description: 'review.start.steps.add — Add a step that checks the previous findings.',
    invoke: addStep,
  }], { unbound: 'local' });

  // The sheet has one left edge (lab `start-sheet`): step and option rows stand on it instead of their own inset.
  return (
    <HappierBodyEdgeContext.Provider value>
    <View testID="review-start-steps">
      {steps.map((step, index) => (
        <ReviewStartStep
          key={index}
          index={index}
          step={step}
          expanded={open.has(index)}
          isNew={added.has(index)}
          onToggle={toggle}
          onUpdate={updateStep}
          onRemove={removeStep}
          presentReviewer={props.presentReviewer}
          renderWho={props.renderWho}
          transcriptAvailable={props.transcriptAvailable}
          disabled={props.disabled === true}
        />
      ))}
      <Item
        testID="review-start-add-step"
        icon={<Icon name="plus" size={ICON_SIZE.sm} />}
        title={t('reviewWalkthrough.start.addStep')}
        subtitle={t('reviewWalkthrough.start.addStepLine', { n: steps.length })}
        onPress={() => { void commands.invoke('review.start.steps.add'); }}
        disabled={props.disabled}
        showChevron={false}
      />
    </View>
    </HappierBodyEdgeContext.Provider>
  );
}

const ReviewStartStep = React.memo(function ReviewStartStep(
  props: Readonly<{
    index: number;
    step: ReviewStepV1;
    expanded: boolean;
    isNew: boolean;
    onToggle: (index: number, expanded: boolean) => void;
    onUpdate: (
      index: number,
      change: (step: ReviewStepV1) => ReviewStepV1,
    ) => void;
    onRemove: (index: number) => void;
    presentReviewer: ReviewStartStepsProps['presentReviewer'];
    renderWho: ReviewStartStepsProps['renderWho'];
    transcriptAvailable: boolean;
    disabled: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { index, step, onToggle, onUpdate, onRemove } = props;
  const testID = `review-start-step:${index}`;
  const verifies = index > 0 && step.kind === 'verify';
  const reviewers = React.useMemo(
    () =>
      step.reviewers.map((reviewer, reviewerIndex) => ({
        key: String(reviewerIndex),
        ...props.presentReviewer(reviewer, reviewerIndex, index),
      })),
    [index, props.presentReviewer, step.reviewers],
  );
  const warning =
    reviewers.find((reviewer) => reviewer.warning)?.warning ?? null;
  // Every reviewer that takes input (engine, Agent, Session) reads the transcript; people read the Review.
  const readers = step.reviewers.filter(
    (reviewer) => reviewer.kind !== 'person',
  );
  const transcriptOn =
    readers.length > 0 &&
    readers.every(
      (reviewer) => reviewer.includeSessionTranscript === true,
    );
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuAnchor = React.useRef<View | null>(null);
  const menuItems = React.useMemo<readonly DropdownMenuItem[]>(
    () => [
      {
        id: 'verify',
        testID: `${testID}:menu:verify`,
        title: t('reviewWalkthrough.start.checksFindingsOf', { n: index }),
        checked: step.kind === 'verify',
      },
      {
        id: 'review',
        testID: `${testID}:menu:review`,
        title: t('reviewWalkthrough.start.reviewsSameChanges'),
        checked: step.kind === 'review',
      },
      {
        id: 'remove',
        testID: `${testID}:menu:remove`,
        title: t('reviewWalkthrough.start.removeStep'),
        destructive: true,
      },
    ],
    [index, step.kind, testID],
  );
  const onMenu = React.useCallback(
    (id: string) => {
      setMenuOpen(false);
      if (id === 'remove') onRemove(index);
      else if (id === 'verify' || id === 'review')
        onUpdate(index, (current) => ({ ...current, kind: id }));
    },
    [index, onRemove, onUpdate],
  );
  const commandPrefix = `review.start.step.${index}`;
  const commands = useCurrentUiContextLocalCommands(props.disabled ? [] : [
    {
      key: `${commandPrefix}.focus`,
      title: t('reviewWalkthrough.start.focus'),
      description: `${commandPrefix}.focus — Set this step's Focus with {value: string}.`,
      invoke: input => {
        if (!isJsonObject(input) || typeof input.value !== 'string') return false;
        const instructions = input.value;
        onUpdate(index, current => ({ ...current, instructions }));
      },
    },
    ...(index > 0 ? [{
      key: `${commandPrefix}.kind`,
      title: t('reviewWalkthrough.start.stepOptions', { n: index + 1 }),
      description: `${commandPrefix}.kind — Choose this step's kind with {value: "review" | "verify"}.`,
      invoke: (input: PluginUiJsonValueV1 | undefined) => {
        if (!isJsonObject(input)) return false;
        const kind = ReviewStepV1Schema.shape.kind.safeParse(input.value);
        if (!kind.success) return false;
        onMenu(kind.data);
      },
    }, {
      key: `${commandPrefix}.remove`,
      title: t('reviewWalkthrough.start.removeStep'),
      description: `${commandPrefix}.remove — Remove this step.`,
      invoke: () => onMenu('remove'),
    }] : []),
    ...(props.transcriptAvailable && readers.length > 0 ? [{
      key: `${commandPrefix}.transcript`,
      title: t('reviewWalkthrough.start.includeTranscript'),
      description: `${commandPrefix}.transcript — Include the Session transcript with {value: boolean}.`,
      invoke: (input: PluginUiJsonValueV1 | undefined) => {
        if (!isJsonObject(input) || typeof input.value !== 'boolean') return false;
        const include = input.value;
        onUpdate(index, current => ({ ...current, reviewers: current.reviewers.map(reviewer => withTranscript(reviewer, include)) }));
      },
    }] : []),
  ], { unbound: 'local' });
  const onExpandedChange = React.useCallback(
    (next: boolean) => onToggle(index, next),
    [index, onToggle],
  );

  const instruction = verifies ? (
    <View style={styles.instruction}>
      <Icon
        name="arrow-right"
        size={ICON_SIZE.xxs}
        color={theme.colors.text.secondary}
      />
      <Text style={styles.line} numberOfLines={1}>
        {t('reviewWalkthrough.start.checksFindingsOf', { n: index })}
      </Text>
    </View>
  ) : null;
  const summary = (
    <View style={styles.summary}>
      <Text style={[styles.line, styles.names]} numberOfLines={1}>
        {reviewers.length > 0
          ? reviewers.map((reviewer) => reviewer.name).join(', ')
          : t('reviewWalkthrough.start.noReviewers')}
      </Text>
      {warning ? (
        <View style={styles.warning}>
          <Icon
            name="warning"
            size={ICON_SIZE.xxs}
            color={theme.colors.state.attention.foreground}
          />
          <Text style={[styles.line, styles.warningText]} numberOfLines={1}>
            {warning}
          </Text>
        </View>
      ) : null}
    </View>
  );
  // Folded marks sit side by side: agent, engine and bot glyphs are bare, so an overlap would run them together.
  const marks =
    reviewers.length > 0 ? (
      <View style={styles.marks}>
        {reviewers.slice(0, FOLDED_MARKS).map((reviewer) => (
          <View key={reviewer.key} style={styles.mark}>{reviewer.mark}</View>
        ))}
        {reviewers.length > FOLDED_MARKS ? (
          <Text style={styles.more}>
            {t('reviewWalkthrough.start.moreReviewers', {
              count: reviewers.length - FOLDED_MARKS,
            })}
          </Text>
        ) : null}
      </View>
    ) : null;
  const menu =
    index > 0 && props.expanded ? (
      <View ref={menuAnchor} collapsable={false}>
        <IconButton
          testID={`${testID}:menu`}
          iconName="dots-three"
          variant="plain"
          size={24}
          accessibilityLabel={t('reviewWalkthrough.start.stepOptions', {
            n: index + 1,
          })}
          disabled={props.disabled}
          onPress={() => setMenuOpen((value) => !value)}
        />
        <DropdownMenu
          testID={`${testID}:menu:list`}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={menuItems}
          onSelect={id => { void commands.invoke(`${commandPrefix}.${id === 'remove' ? 'remove' : 'kind'}`, { value: id }); }}
          popoverAnchorRef={menuAnchor}
          placement="bottom"
          popoverAnchorAlign="end"
          matchTriggerWidth={false}
        />
      </View>
    ) : null;

  return (
    <ExpandableItem
      testID={testID}
      expanded={props.expanded}
      onExpandedChange={onExpandedChange}
      header={({ headerProps, expanded }) => (
        <Item
          {...headerProps}
          testID={`${testID}:header`}
          title={
            <ReviewLabel>
              {t('reviewWalkthrough.start.step', {
                n: index + 1,
                title: stepTitle(step),
              })}
            </ReviewLabel>
          }
          titleQualifier={
            props.isNew ? t('reviewWalkthrough.start.stepNew') : null
          }
          subtitle={
            expanded ? (
              (instruction ?? undefined)
            ) : (
              <View style={styles.folded}>
                {instruction}
                {summary}
              </View>
            )
          }
          rightElement={expanded ? menu : marks}
          keepChevronWithRightElement
        />
      )}
      bodyStyle={styles.body}
    >
      {/* The Who list's menu rows hang their own inset onto the sheet's edge; they are not body-edge rows. */}
      <HappierBodyEdgeContext.Provider value={false}>{props.renderWho(index)}</HappierBodyEdgeContext.Provider>
      <View style={styles.field}>
        <ReviewLabel>
          {t('reviewWalkthrough.start.focus')}
        </ReviewLabel>
        <FieldTextInput
          testID={`${testID}:focus`}
          value={step.instructions}
          onChangeText={value => { void commands.invoke(`${commandPrefix}.focus`, { value }); }}
          placeholder={t(
            verifies
              ? 'reviewWalkthrough.start.focusVerifyPlaceholder'
              : 'reviewWalkthrough.start.focusPlaceholder',
          )}
          accessibilityLabel={t('reviewWalkthrough.start.focus')}
          editable={!props.disabled}
        />
      </View>
      {props.transcriptAvailable && readers.length > 0 ? (
        <Item
          testID={`${testID}:transcript`}
          title={t('reviewWalkthrough.start.includeTranscript')}
          subtitle={t('reviewWalkthrough.start.includeTranscriptLine')}
          accessibilityRole="switch"
          accessibilityChecked={transcriptOn}
          onPress={() => { void commands.invoke(`${commandPrefix}.transcript`, { value: !transcriptOn }); }}
          disabled={props.disabled}
          showChevron={false}
          rightElement={
            <Switch
              value={transcriptOn}
              disabled={props.disabled}
              onValueChange={value => { void commands.invoke(`${commandPrefix}.transcript`, { value }); }}
            />
          }
        />
      ) : null}
    </ExpandableItem>
  );
});

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16, paddingBottom: theme.space.s8 },
  field: { gap: theme.space.s8 },
  folded: { gap: theme.space.s2 },
  instruction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  line: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  names: { flexShrink: 1 },
  warning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexShrink: 0,
  },
  warningText: { color: theme.colors.state.attention.textForeground },
  marks: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  mark: { width: ICON_SIZE.sm, height: ICON_SIZE.sm, alignItems: 'center', justifyContent: 'center' },
  more: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
