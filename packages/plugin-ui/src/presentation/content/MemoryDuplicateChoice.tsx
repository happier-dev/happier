import type { ComponentType, ReactElement } from 'react';
import { Pressable, View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierStyleProp } from '../portableTypes.js';

/** What saving does to the saved fact it resembles. */
export type HappierMemoryDuplicateChoiceKind =
  | 'update'
  | 'replace'
  | 'keep_both';

/** One saved fact like the new one, in the order the caller wants it read (the closest first). */
export type HappierMemoryDuplicateCandidate = Readonly<{
  id: string;
  text: string;
  /** Caller-formatted facts about it (how close, its topic, whether it is an approved decision). */
  meta?: string;
}>;

export type HappierMemoryDuplicateChoiceLabels = Readonly<{
  /** The heading; the caller words it for one or several saved facts. */
  title: string;
  saved: string;
  new: string;
  /** The choice control's accessible name. */
  choice: string;
  options: Readonly<Record<HappierMemoryDuplicateChoiceKind, string>>;
  /** One line saying what the chosen effect does. */
  effects: Readonly<Record<HappierMemoryDuplicateChoiceKind, string>>;
  /** The control that opens the caller's view of a saved fact; shown only with `onViewCandidate`. */
  view?: string;
}>;

export type HappierMemoryDuplicateChoiceTextProps = Readonly<{
  role: 'title' | 'label' | 'text' | 'meta' | 'effect' | 'action';
  /** The saved text the chosen Replace retires. */
  retired?: boolean;
  numberOfLines?: number;
  testID?: string;
  accessibilityRole?: 'header';
  children: string;
}>;

export type HappierMemoryDuplicateChoiceControlProps = Readonly<{
  options: readonly Readonly<{
    id: HappierMemoryDuplicateChoiceKind;
    label: string;
  }>[];
  value: HappierMemoryDuplicateChoiceKind;
  onChange: (value: HappierMemoryDuplicateChoiceKind) => void;
  accessibilityLabel: string;
  disabled: boolean;
  /** Each option's test id is `${testIDPrefix}:${id}`. */
  testIDPrefix: string;
}>;

export type HappierMemoryDuplicateChoiceProps = Readonly<{
  testID: string;
  candidates: readonly HappierMemoryDuplicateCandidate[];
  /** What the person is saving now; the New line follows the draft. */
  newText: string;
  /** The saved fact the effect applies to; `null` means the first. */
  candidateId: string | null;
  onCandidateChange: (id: string) => void;
  choice: HappierMemoryDuplicateChoiceKind;
  onChoiceChange: (choice: HappierMemoryDuplicateChoiceKind) => void;
  /**
   * Opens the caller's own view of a saved fact (its source, approval, history). The caller decides
   * what may be shown and keeps the draft and choice while it is open; viewing never chooses the fact.
   */
  onViewCandidate?: (id: string) => void;
  disabled?: boolean;
  labels: HappierMemoryDuplicateChoiceLabels;
  Text: ComponentType<HappierMemoryDuplicateChoiceTextProps>;
  Choice: ComponentType<HappierMemoryDuplicateChoiceControlProps>;
  /** The grouped comparison's ground (its fill, radius and edge), in the caller's material. */
  style?: HappierStyleProp;
  colors: Readonly<{ chosen: string; hover: string }>;
  radius: number;
  space?: Readonly<Record<'s2' | 's4' | 's8' | 's12', number>>;
}>;

const OPTION_ORDER: readonly HappierMemoryDuplicateChoiceKind[] = [
  'update',
  'replace',
  'keep_both',
];
/** One label column, so the Saved and New texts start on one edge. */
const LABEL_COLUMN_PX = 48;

/**
 * Saving found saved facts like this one before anything was written: one grouped comparison of what
 * is saved and what is new, the explicit effect and one line saying what it does. Replace strikes the
 * saved text it retires. Shared by core and plugins; the caller owns the review, the write and the
 * decision, and this presentation only reports the person's choice.
 */
export function HappierMemoryDuplicateChoice(
  props: HappierMemoryDuplicateChoiceProps,
): ReactElement {
  const { Text, Choice, labels, candidates, choice } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const disabled = props.disabled === true;
  const chosenId = props.candidateId ?? candidates[0]?.id ?? null;
  const view = props.onViewCandidate && labels.view
    ? { open: props.onViewCandidate, label: labels.view } : null;
  // Picking among several saved facts matters only when the effect touches one of them.
  const selectable = candidates.length > 1 && choice !== 'keep_both';
  const row = {
    flexDirection: 'row',
    gap: space.s12,
    paddingVertical: space.s4,
    paddingHorizontal: space.s4,
    borderRadius: props.radius,
  } as const;
  const label = { minWidth: LABEL_COLUMN_PX } as const;
  const body = { flex: 1, minWidth: 0, gap: space.s2 } as const;
  return (
    <View
      testID={props.testID}
      style={[{ gap: space.s8 }, props.style]}
      accessibilityLiveRegion="polite"
    >
      <View style={{ paddingHorizontal: space.s4 }}>
        <Text role="title" accessibilityRole="header">
          {labels.title}
        </Text>
      </View>
      <View
        style={{ gap: space.s2 }}
        accessibilityRole={selectable ? 'radiogroup' : undefined}
      >
        {candidates.map((candidate, index) => {
          const chosen = candidate.id === chosenId;
          return (
            <Pressable
              key={candidate.id}
              testID={`${props.testID}.candidate.${candidate.id}`}
              style={({
                hovered,
                pressed,
              }: Readonly<{ hovered?: boolean; pressed: boolean }>) => [
                row,
                selectable && chosen
                  ? { backgroundColor: props.colors.chosen }
                  : null,
                selectable && !chosen && (hovered || pressed)
                  ? { backgroundColor: props.colors.hover }
                  : null,
              ]}
              disabled={!selectable || disabled}
              onPress={
                selectable
                  ? () => props.onCandidateChange(candidate.id)
                  : undefined
              }
              accessibilityRole={selectable ? 'radio' : undefined}
              // `aria-*` reaches web and native alike; RN Web drops the deprecated accessibilityState.
              aria-checked={selectable ? chosen : undefined}
              aria-disabled={selectable ? disabled : undefined}
            >
              <View style={label}>
                <Text role="label">{index === 0 ? labels.saved : ''}</Text>
              </View>
              <View style={body}>
                <Text
                  testID={`${props.testID}.candidate.${candidate.id}.text`}
                  role="text"
                  retired={choice === 'replace' && chosen}
                  numberOfLines={3}
                >
                  {candidate.text}
                </Text>
                {candidate.meta || view ? (
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.s8 }}>
                    {candidate.meta ? (
                      <View style={{ flexShrink: 1, minWidth: 0 }}>
                        <Text role="meta" numberOfLines={1}>
                          {candidate.meta}
                        </Text>
                      </View>
                    ) : null}
                    {view ? (
                      <HappierPressable
                        testID={`${props.testID}.candidate.${candidate.id}.view`}
                        accessibilityRole="button"
                        // Inside a selectable row: the link reaches only into the row's own gaps (half the body gap above,
                        // the row padding below and beside), never into the text that selects the row.
                        hitReach={{ top: space.s2 / 2, bottom: space.s4, left: space.s8 / 2, right: space.s4 }}
                        onPress={() => view.open(candidate.id)}
                      >
                        <Text role="action">{view.label}</Text>
                      </HappierPressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        <View style={row}>
          <View style={label}>
            <Text role="label">{labels.new}</Text>
          </View>
          <View style={body}>
            <Text testID={`${props.testID}.new`} role="text" numberOfLines={3}>
              {props.newText.trim()}
            </Text>
          </View>
        </View>
      </View>
      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: space.s4,
          paddingTop: space.s4,
        }}
      >
        <Choice
          options={OPTION_ORDER.map((id) => ({
            id,
            label: labels.options[id],
          }))}
          value={choice}
          onChange={props.onChoiceChange}
          accessibilityLabel={labels.choice}
          disabled={disabled}
          testIDPrefix={`${props.testID}.choice`}
        />
      </View>
      <View style={{ paddingHorizontal: space.s4 }}>
        <Text testID={`${props.testID}.effect`} role="effect">
          {labels.effects[choice]}
        </Text>
      </View>
    </View>
  );
}
