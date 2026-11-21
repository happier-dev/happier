import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_MENU_ROW_METRICS, HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import type { ReviewChangeType } from '@happier-dev/protocol/reviews/reviewStart';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  SelectionList,
  type SelectionListStep,
} from '@/components/ui/selectionList';
import { t } from '@/text';

import { ReviewLabel } from '../ReviewLabel';

/** Each change area `review.start` can review, in the words of the Review start (lab `start-sheet`, "What to review"). */
const SUBJECT_COPY = {
  uncommitted: {
    icon: 'git-diff',
    title: 'reviewWalkthrough.start.subjectPending',
    line: 'reviewWalkthrough.start.subjectPendingLine',
  },
  committed: {
    icon: 'stack',
    title: 'reviewWalkthrough.start.subjectStaged',
    line: 'reviewWalkthrough.start.subjectStagedLine',
  },
  all: {
    icon: 'files',
    title: 'reviewWalkthrough.start.subjectAll',
    line: 'reviewWalkthrough.start.subjectAllLine',
  },
} as const satisfies Record<
  ReviewChangeType,
  Readonly<{ icon: string; title: string; line: string }>
>;

export type ReviewStartSubjectProps = Readonly<{
  /** The change areas the start offers, in the order its action spec lists them. */
  options: readonly ReviewChangeType[];
  value: ReviewChangeType;
  onChange: (value: ReviewChangeType) => void;
  /** The chosen area's own facts (branch, changed files), said on its row. */
  detail?: string | null;
  /** The base the chosen area is compared with, when the action asks for one. */
  children?: React.ReactNode;
  disabled?: boolean;
}>;

/**
 * "What to review", first in the start sheet: one row per change area, the chosen one ticked. Presentation
 * only; the host owns the draft field it writes.
 */
export function ReviewStartSubject(props: ReviewStartSubjectProps) {
  const { onChange, disabled } = props;
  const rootStep = React.useMemo<SelectionListStep>(
    () => ({
      id: 'review-start-subject',
      sections: [
        {
          kind: 'static',
          id: 'subjects',
          options: props.options.map((value) => ({
            id: value,
            testID: `review-start-subject:${value}`,
            label: t(SUBJECT_COPY[value].title),
            subtitle:
              value === props.value && props.detail
                ? props.detail
                : t(SUBJECT_COPY[value].line),
            icon: <Icon name={SUBJECT_COPY[value].icon} size={ICON_SIZE.sm} />,
            ...(disabled ? { disabled: true } : {}),
            onSelect: () => onChange(value),
          })),
        },
      ],
    }),
    [disabled, onChange, props.detail, props.options, props.value],
  );
  return (
    <View testID="review-start-subject" style={styles.root}>
      <ReviewLabel role="header">{t('agentStart.chips.scope')}</ReviewLabel>
      <View style={styles.hang}>
        <SelectionList
          testID="review-start-subject-list"
          rootStep={rootStep}
          selection={{ kind: 'single', selectedId: props.value }}
          onSelect={() => undefined}
          onRequestClose={() => undefined}
          listAccessibilityLabel={t('agentStart.chips.scope')}
          selectionMark="check"
          surface="none"
          disableTransitions
        />
      </View>
      {/* The base fields stand on the sheet's one edge with the steps and options below. */}
      <HappierBodyEdgeContext.Provider value>{props.children}</HappierBodyEdgeContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.space.s8, paddingBottom: theme.space.s12 },
  // Menu rows hang their own inset so their titles share the form's one edge (ContextualStartComposer `hang`).
  hang: { marginHorizontal: -HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx },
}));
