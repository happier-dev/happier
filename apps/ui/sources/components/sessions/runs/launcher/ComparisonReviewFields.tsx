import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_MENU_ROW_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import {
  SelectionList,
  type SelectionListStep,
} from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ReviewWalkthroughPlan } from '@/sync/domains/reviews/reviewWalkthroughPlan';
import { t } from '@/text';

export type ComparisonReviewFieldsProps = Readonly<{
  scopeLabel: string;
  scopeDetail?: string | null;
  plan: ReviewWalkthroughPlan;
  walkthrough: boolean;
  onToggleWalkthrough: () => void;
  onSelectNarrator: (engineId: string) => void;
  error?: string | null;
  onRetry?: () => void;
}>;

/**
 * The captured changes, said once under the lead (lab flRun `compare`). They are a fact of this start,
 * not a choice, so they read as a line rather than a control; the inventory failure sits with them.
 */
export function ComparisonReviewScope(
  props: Pick<
    ComparisonReviewFieldsProps,
    'scopeLabel' | 'scopeDetail' | 'error' | 'onRetry'
  >,
) {
  const { theme } = useUnistyles();
  return (
    <>
      <View
        testID="start-review-changes"
        accessible
        accessibilityLabel={[
          t('reviewWalkthrough.dialog.changes'),
          props.scopeLabel,
          props.scopeDetail,
        ]
          .filter(Boolean)
          .join(', ')}
        style={styles.changes}
      >
        <Icon
          name="git-diff"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text style={styles.scope} numberOfLines={1}>
          {props.scopeLabel}
        </Text>
        {props.scopeDetail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {props.scopeDetail}
          </Text>
        ) : null}
      </View>
      {props.error ? (
        <SurfaceStateCard
          size="line"
          kind="error"
          title={props.error}
          action={
            props.onRetry
              ? { label: t('common.retry'), onPress: props.onRetry }
              : undefined
          }
        />
      ) : null}
    </>
  );
}

/** The walkthrough chip's question (lab flRun `compare`): a walkthrough after the findings, and who writes it. */
export function ComparisonWalkthroughChoice(
  props: Pick<
    ComparisonReviewFieldsProps,
    'plan' | 'walkthrough' | 'onToggleWalkthrough' | 'onSelectNarrator'
  >,
) {
  const { theme } = useUnistyles();
  const narrator = props.plan.narrator;
  const narratorWhy =
    narrator?.reason === 'findings_only'
      ? t('reviewWalkthrough.dialog.narratorFindingsOnly', {
          engine: props.plan.selected[0]?.label ?? '',
        })
      : t('reviewWalkthrough.dialog.narratorSeveral', {
          count: props.plan.selected.length,
        });
  const footer =
    props.plan.footer?.kind === 'reviewer_then_narrator'
      ? t('reviewWalkthrough.dialog.footerHandover', {
          reviewer: props.plan.footer.reviewer,
          narrator: props.plan.footer.narrator,
        })
      : props.plan.footer?.kind === 'review_then_walkthrough'
        ? t('reviewWalkthrough.dialog.footerReviewThenWalkthrough')
        : null;
  const { onSelectNarrator } = props;
  const narratorStep = React.useMemo<SelectionListStep | null>(
    () =>
      narrator?.candidates.length
        ? {
            id: 'start-review-narrator',
            sections: [
              {
                kind: 'static',
                id: 'narrators',
                options: narrator.candidates.map((engine) => ({
                  id: engine.engineId,
                  testID: `start-review-narrator:${engine.engineId}`,
                  label: engine.label,
                  ...(engine.description
                    ? { subtitle: engine.description }
                    : {}),
                  onSelect: () => onSelectNarrator(engine.engineId),
                })),
              },
            ],
          }
        : null,
    [narrator?.candidates, onSelectNarrator],
  );
  return (
    <View testID="comparison-review-fields" style={styles.body}>
      <HappierPressable
        testID="start-review-walkthrough"
        accessibilityRole="checkbox"
        checked={props.walkthrough}
        accessibilityLabel={t('reviewWalkthrough.dialog.alsoWalkthrough')}
        accessibilityHint={t('reviewWalkthrough.dialog.alsoWalkthroughBody')}
        onPress={props.onToggleWalkthrough}
        style={(state) => [
          styles.choice,
          state.pressed ? styles.pressed : null,
          focusRingStyle({
            focused: state.focused,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        <SelectionCheckGlyph
          state={props.walkthrough ? 'checked' : 'unchecked'}
        />
        <View style={styles.field}>
          <Text style={styles.scope}>
            {t('reviewWalkthrough.dialog.alsoWalkthrough')}
          </Text>
          <Text style={styles.detail}>
            {t('reviewWalkthrough.dialog.alsoWalkthroughBody')}
          </Text>
        </View>
      </HappierPressable>
      {props.walkthrough && narrator ? (
        <View testID="start-review-narrator-row" style={styles.field}>
          <Text style={styles.label}>
            {t('reviewWalkthrough.dialog.narrator')}
          </Text>
          <Text style={styles.detail}>
            {narratorStep
              ? narratorWhy
              : t('reviewWalkthrough.dialog.noNarrator')}
          </Text>
          {narratorStep ? (
            <View style={styles.hang}>
              <SelectionList
                testID="start-review-narrator"
                rootStep={narratorStep}
                selection={{ kind: 'single', selectedId: narrator.engineId }}
                onSelect={() => undefined}
                onRequestClose={() => undefined}
                listAccessibilityLabel={t('reviewWalkthrough.dialog.narrator')}
                selectionMark="check"
                surface="none"
                disableTransitions
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {footer ? (
        <Text testID="start-review-footer" style={styles.detail}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12 },
  field: { flexShrink: 1, gap: theme.space.s4 },
  label: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  changes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  scope: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  detail: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s8,
  },
  pressed: { backgroundColor: theme.colors.surface.pressed },
  // Menu rows hang their own inset so their titles share the form's edge (ContextualStartComposer `hang`).
  hang: { marginHorizontal: -HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx },
}));
