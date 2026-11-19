import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type {
  ImageMarkColorV1,
  ImageMarkV1,
} from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { InlineTextField } from '@/components/ui/text/InlineTextField';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { ImageAnnotator } from './annotatorStore';
import { MARK_COLORS, MARK_NUMERAL_COLOR } from './markGeometry';
import { useImageAnnotatorState } from './useImageAnnotator';

/** One numbered step as the list shows it: its number is the picture's (`stepNumbers` order), its note optional. */
export type AnnotatorStepRow = Readonly<{
  id: string;
  number: number;
  note: string;
  color: ImageMarkColorV1;
}>;

const NO_STEPS: readonly AnnotatorStepRow[] = Object.freeze([]);

/** Steps in document order, numbered from one, the same order the canvas and the flattened picture use. */
export function readAnnotatorStepRows(
  marks: readonly ImageMarkV1[],
): readonly AnnotatorStepRow[] {
  const rows: AnnotatorStepRow[] = [];
  for (const mark of marks) {
    if (mark.kind === 'step')
      rows.push({
        id: mark.id,
        number: rows.length + 1,
        note: mark.note ?? '',
        color: mark.color,
      });
  }
  return rows.length > 0 ? rows : NO_STEPS;
}

/**
 * Whether the steps list shows: a picture with numbered steps, or the step tool in hand (its empty list says what
 * a tap does). Hosts reserve the list's room from the moment the tool is chosen, so the picture never moves
 * under the first tap.
 */
export function useAnnotatorShowsSteps(annotator: ImageAnnotator | null): boolean {
  return React.useSyncExternalStore(annotator?.store.subscribe ?? NO_SUBSCRIPTION, () => {
    const state = annotator?.store.getState();
    return state !== undefined && (state.tool === 'step' || state.document.marks.some((mark) => mark.kind === 'step'));
  });
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * The numbered comments of one picture (lab `comments`): every step mark, in order, with its optional note. A
 * step without a note is a bare number beside an empty field. The note is part of the step mark, so it travels
 * with the marks through undo, redo, the draft and the headless `media.annotation.apply` Action; a note commits
 * once per edit (Enter or leaving the field), never per keystroke. `panel` is the side panel (title, rows on
 * hairlines, the hint); `list` is the bare rows a phone or the Capture window sets under the picture.
 */
export function AnnotatorSteps(
  props: Readonly<{
    annotator: ImageAnnotator;
    presentation: 'panel' | 'list';
    /** The host's inset around the list, applied only when there are steps to show. */
    style?: StyleProp<ViewStyle>;
  }>,
) {
  const { annotator, presentation } = props;
  const marks = useImageAnnotatorState(
    annotator,
    (state) => state.document.marks,
  );
  const selection = useImageAnnotatorState(
    annotator,
    (state) => state.selection,
  );
  const stepTool = useImageAnnotatorState(annotator, (state) => state.tool === 'step');
  const rows = React.useMemo(() => readAnnotatorStepRows(marks), [marks]);
  if (rows.length === 0 && !stepTool) return null;
  const panel = presentation === 'panel';
  return (
    <View style={[styles.root, props.style]} testID="annotator-steps">
      {panel ? (
        <View style={styles.header}>
          <Text variant="body" emphasis="semiBold" style={styles.title}>
            {t('files.annotate.steps')}
          </Text>
          <Text variant="body" style={styles.count}>
            {String(rows.length)}
          </Text>
        </View>
      ) : null}
      <View style={panel ? styles.panelRows : styles.listRows}>
        {rows.map((row, index) => (
          <AnnotatorStepItem
            key={row.id}
            annotator={annotator}
            row={row}
            selected={row.id === selection}
            divided={panel && index > 0}
            compact={!panel}
          />
        ))}
      </View>
      {panel || rows.length === 0 ? (
        <Text variant="meta" style={panel ? styles.hint : styles.listHint}>
          {t('files.annotate.stepsHint')}
        </Text>
      ) : null}
    </View>
  );
}

const AnnotatorStepItem = React.memo(function AnnotatorStepItem(
  props: Readonly<{
    annotator: ImageAnnotator;
    row: AnnotatorStepRow;
    selected: boolean;
    divided: boolean;
    compact: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { annotator, row } = props;
  const [draft, setDraft] = React.useState(row.note);
  const [focused, setFocused] = React.useState(false);
  // Typing in a note must not reach the canvas: tool letters and Delete belong to the field while it has focus.
  const canvasFocusBefore = React.useRef(false);
  React.useEffect(() => {
    if (!focused) setDraft(row.note);
  }, [focused, row.note]);
  const commit = React.useCallback(() => {
    const mark = annotator.store
      .getState()
      .document.marks.find((candidate) => candidate.id === row.id);
    if (!mark || mark.kind !== 'step') return;
    const note = draft.trim();
    if (note === (mark.note ?? '')) return;
    const { note: _previous, ...bare } = mark;
    annotator.apply(
      [{ kind: 'mark.update', mark: note ? { ...bare, note } : bare }],
      row.id,
    );
  }, [annotator, draft, row.id]);
  const empty = draft.length === 0;
  return (
    <View
      style={[
        styles.item,
        props.compact ? styles.itemCompact : null,
        props.divided
          ? {
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.colors.border.default,
            }
          : null,
        props.selected
          ? { backgroundColor: theme.colors.surface.selected }
          : null,
      ]}
    >
      <HappierPressable
        accessibilityRole="button"
        accessibilityLabel={t('files.annotate.selectStep', {
          number: row.number,
        })}
        onPress={() => annotator.select(row.id)}
        style={[styles.badge, { backgroundColor: MARK_COLORS[row.color] }]}
        testID={`annotator-step-${row.number}`}
      >
        <Text variant="micro" emphasis="semiBold" style={styles.badgeNumber}>
          {String(row.number)}
        </Text>
      </HappierPressable>
      <View
        style={[
          styles.field,
          empty
            ? {
                // An ink tint reads as a field on light and dark glass and paper alike.
                backgroundColor: theme.colors.surface.hover,
                borderColor: theme.colors.border.default,
              }
            : null,
        ]}
      >
        <InlineTextField
          editor={{
            value: draft,
            placeholder: '',
            accessibilityLabel: t('files.annotate.stepNote', {
              number: row.number,
            }),
            onChangeText: setDraft,
            onCommit: () => {
              commit();
              setFocused(false);
              annotator.setCanvasFocused(canvasFocusBefore.current);
            },
            onFocus: () => {
              canvasFocusBefore.current =
                annotator.store.getState().canvasFocused;
              annotator.setCanvasFocused(false);
              annotator.select(row.id);
              setFocused(true);
            },
            testID: `annotator-step-note-${row.number}`,
          }}
          style={[styles.note, { color: theme.colors.text.primary }]}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s16,
  },
  title: {
    color: theme.colors.text.primary,
  },
  count: {
    color: theme.colors.text.tertiary,
  },
  panelRows: {
    paddingHorizontal: theme.space.s8,
  },
  listRows: {
    gap: theme.space.s4,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s8,
    paddingVertical: theme.space.s8,
    borderRadius: theme.borderRadius.md,
  },
  itemCompact: {
    paddingHorizontal: 0,
    paddingVertical: theme.space.s2,
  },
  badge: {
    width: theme.space.s20,
    height: theme.space.s20,
    borderRadius: theme.space.s20 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: theme.space.s2,
  },
  badgeNumber: {
    color: MARK_NUMERAL_COLOR,
  },
  field: {
    flex: 1,
    minHeight: theme.space.s24,
    borderRadius: theme.borderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    paddingHorizontal: theme.space.s6,
    paddingVertical: theme.space.s2,
    justifyContent: 'center',
  },
  note: {
    ...Typography.variant('body'),
    padding: 0,
  },
  listHint: {
    color: theme.colors.text.tertiary,
  },
  hint: {
    color: theme.colors.text.tertiary,
    marginHorizontal: theme.space.s16,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
}));
