import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  ReviewReviewerSelectionV1,
  ReviewStepV1,
} from '@happier-dev/protocol/reviews/reviewStart';

import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
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

import { ReviewStartLabel } from './ReviewStartLabel';

/** How the host shows one chosen reviewer: its list row's own mark and name, and a typed readiness warning. */
export type ReviewStartReviewerPresentation = Readonly<{
  name: string;
  mark: React.ReactNode;
  /** A person's avatar takes the stack's separating ring; agent, session, bot and engine marks stay bare. */
  avatar?: boolean;
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
  /** The subject is a Session, so engine reviewers may read its transcript (P01 selected input). */
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
  if (reviewer.kind !== 'engine') return reviewer;
  if (include) return { ...reviewer, includeSessionTranscript: true };
  const { includeSessionTranscript: _dropped, ...rest } = reviewer;
  return rest;
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

  return (
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
        onPress={addStep}
        disabled={props.disabled}
        showChevron={false}
      />
    </View>
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
  const engines = step.reviewers.filter(
    (reviewer) => reviewer.kind === 'engine',
  );
  const transcriptOn =
    engines.length > 0 &&
    engines.every(
      (reviewer) =>
        reviewer.kind === 'engine' &&
        reviewer.includeSessionTranscript === true,
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
  const marks =
    reviewers.length > 0 ? (
      <View style={styles.marks}>
        <AvatarStack
          size={ICON_SIZE.sm}
          entries={reviewers.slice(0, FOLDED_MARKS).map((reviewer) => ({
            key: reviewer.key,
            content: reviewer.mark,
            avatar: reviewer.avatar === true,
          }))}
        />
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
          onSelect={onMenu}
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
            <ReviewStartLabel>
              {t('reviewWalkthrough.start.step', {
                n: index + 1,
                title: stepTitle(step),
              })}
            </ReviewStartLabel>
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
      {props.renderWho(index)}
      <View style={styles.field}>
        <ReviewStartLabel>
          {t('reviewWalkthrough.start.focus')}
        </ReviewStartLabel>
        <FieldTextInput
          testID={`${testID}:focus`}
          value={step.instructions}
          onChangeText={(text) =>
            onUpdate(index, (current) => ({ ...current, instructions: text }))
          }
          placeholder={t(
            verifies
              ? 'reviewWalkthrough.start.focusVerifyPlaceholder'
              : 'reviewWalkthrough.start.focusPlaceholder',
          )}
          accessibilityLabel={t('reviewWalkthrough.start.focus')}
          editable={!props.disabled}
        />
      </View>
      {props.transcriptAvailable && engines.length > 0 ? (
        <Item
          testID={`${testID}:transcript`}
          title={t('reviewWalkthrough.start.includeTranscript')}
          subtitle={t('reviewWalkthrough.start.includeTranscriptLine')}
          accessibilityRole="switch"
          accessibilityChecked={transcriptOn}
          onPress={() =>
            onUpdate(index, (current) => ({
              ...current,
              reviewers: current.reviewers.map((reviewer) =>
                withTranscript(reviewer, !transcriptOn),
              ),
            }))
          }
          disabled={props.disabled}
          showChevron={false}
          rightElement={
            <Switch
              value={transcriptOn}
              disabled={props.disabled}
              onValueChange={(include) =>
                onUpdate(index, (current) => ({
                  ...current,
                  reviewers: current.reviewers.map((reviewer) =>
                    withTranscript(reviewer, include),
                  ),
                }))
              }
            />
          }
        />
      ) : null}
    </ExpandableItem>
  );
});

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16, paddingBottom: theme.space.s16 },
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
  more: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
