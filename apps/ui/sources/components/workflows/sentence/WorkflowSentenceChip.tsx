import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PAGE_METRICS,
  HappierComposerChip,
  resolveHappierFocusRingVisible,
} from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * What a sentence chip is (lab round 1116c "Grammar"): `option` a chosen value (bordered), `placeholder` a
 * missing one ("choose a Machine"), `step` one step (filled while selected), `add` a quiet add ("or…",
 * "Add another step", "Workflow options").
 */
export type WorkflowSentenceChipKind =
  | 'option'
  | 'placeholder'
  | 'step'
  | 'add';

export type WorkflowSentenceChipProps = Readonly<{
  kind: WorkflowSentenceChipKind;
  label: string;
  /** The field the chip changes, for its accessible name ("Machine: MacBook Pro"). */
  title?: string;
  icon?: IconName;
  /** A contributed mark (an Agent's brand) instead of a glyph. */
  mark?: React.ReactNode;
  /** A path or an identifier, set in the code face. */
  mono?: boolean;
  /** Selected (a step) or showing its card or menu (an add chip). */
  selected?: boolean;
  open?: boolean;
  /** The value has a problem its status line explains: a warning (dot) or an error border. */
  tone?: 'warning' | 'danger';
  /** A trigger that is turned off reads struck through (lab Q2). */
  struck?: boolean;
  disabled?: boolean;
  hasPopup?: 'menu' | 'dialog' | 'listbox';
  accessibilityHint?: string;
  onPress: () => void;
  anchorRef?: React.Ref<View>;
  testID: string;
}>;

/**
 * One chip of the workflow's sentence: the composer chip's shell at the page's control height. Each owner
 * (the trigger, placement and Result pickers, the step list) draws its trigger with it; the picker and the
 * write stay that owner's.
 */
export const WorkflowSentenceChip = React.memo(function WorkflowSentenceChip(
  props: WorkflowSentenceChipProps,
) {
  const { theme } = useUnistyles();
  const quiet = props.kind === 'add' || props.kind === 'placeholder';
  const filled =
    props.selected === true && (props.kind === 'step' || props.kind === 'add');
  const ink =
    quiet && !filled ? theme.colors.text.tertiary : theme.colors.text.primary;
  const borderColor =
    props.tone === 'danger'
      ? theme.colors.state.danger.foreground
      : props.tone === 'warning'
        ? theme.colors.state.warning.foreground
        : props.open === true
          ? theme.colors.text.primary
          : props.kind === 'option' || filled
            ? theme.colors.border.strong
            : props.kind === 'add'
              ? 'transparent'
              : theme.colors.border.default;
  const glyph =
    props.mark ??
    (props.icon === undefined ? null : (
      <Icon
        name={props.icon}
        size={ICON_SIZE.xs}
        color={
          quiet && !filled
            ? theme.colors.text.tertiary
            : theme.colors.text.secondary
        }
      />
    ));
  return (
    <View ref={props.anchorRef} collapsable={false} style={styles.anchor}>
      <HappierComposerChip
        testID={props.testID}
        accessibilityLabel={
          props.title === undefined
            ? props.label
            : `${props.title}: ${props.label}`
        }
        {...(props.accessibilityHint === undefined
          ? {}
          : { accessibilityHint: props.accessibilityHint })}
        {...(props.hasPopup === undefined ? {} : { hasPopup: props.hasPopup })}
        {...(props.kind === 'step'
          ? { expressesSelection: true, selected: props.selected === true }
          : {})}
        accessibilityState={
          props.hasPopup === undefined
            ? undefined
            : { expanded: props.open === true }
        }
        disabled={props.disabled}
        onPress={props.onPress}
        style={(pressed, focused) => [
          styles.chip,
          { borderColor, borderWidth: props.open === true ? 1.5 : 1 },
          filled ? { backgroundColor: theme.colors.surface.selected } : null,
          pressed ? { backgroundColor: theme.colors.surface.pressed } : null,
          focusRingStyle({
            focused: resolveHappierFocusRingVisible(focused),
            color: theme.colors.border.focus,
          }),
        ]}
      >
        {glyph}
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            props.mono ? styles.mono : null,
            filled && props.kind === 'step' ? styles.selectedLabel : null,
            quiet && !filled ? styles.quietLabel : null,
            { color: props.struck ? theme.colors.text.tertiary : ink },
            props.struck ? styles.struck : null,
          ]}
        >
          {props.label}
        </Text>
        {props.tone === 'warning' ? (
          <View
            style={[
              styles.dot,
              { backgroundColor: theme.colors.state.warning.foreground },
            ]}
          />
        ) : null}
      </HappierComposerChip>
    </View>
  );
});

/** A word of the sentence: copy, never a control. It wraps together with the chip it introduces. */
export function WorkflowSentenceWord(
  props: Readonly<{ children: string; testID?: string }>,
) {
  return (
    <Text testID={props.testID} style={styles.word}>
      {props.children}
    </Text>
  );
}

/** A word and the chip it introduces, kept on one line so no "in" is stranded at a line's end. */
export function WorkflowSentenceUnit(
  props: Readonly<{ word?: string; children: React.ReactNode }>,
) {
  if (props.word === undefined) return <>{props.children}</>;
  return (
    <View style={styles.unit}>
      <WorkflowSentenceWord>{props.word}</WorkflowSentenceWord>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    maxWidth: '100%',
    minWidth: 0,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    height: HAPPIER_PAGE_METRICS.controlHeightPx,
    borderRadius: HAPPIER_PAGE_METRICS.controlHeightPx / 2,
    paddingHorizontal: theme.space.s10,
    maxWidth: '100%',
    minWidth: 0,
  },
  label: {
    ...Typography.variant('body', 'medium'),
    flexShrink: 1,
    minWidth: 0,
  },
  selectedLabel: {
    ...Typography.variant('body', 'semiBold'),
  },
  quietLabel: {
    ...Typography.variant('body'),
  },
  mono: {
    ...Typography.variant('meta'),
    ...Typography.mono(),
  },
  struck: {
    textDecorationLine: 'line-through',
  },
  dot: {
    width: theme.space.s6,
    height: theme.space.s6,
    borderRadius: theme.space.s6 / 2,
  },
  word: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
  unit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    maxWidth: '100%',
    minWidth: 0,
  },
}));
