import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatRecoveryKey } from '@happier-dev/protocol/auth/recoveryKey';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The printed key's groups (every recovery key is 32 bytes), so the cells match the key the person saved. */
const PRINTED_GROUPS = formatRecoveryKey(new Uint8Array(32)).split('-');
const GROUP_SIZE = PRINTED_GROUPS[0]!.length;
const KEY_CHARACTERS = PRINTED_GROUPS.join('').length;
/** The placeholder a blank cell shows (lab direction A key cells). */
const BLANK = '·';

export type RecoveryKeyCellsProps = Readonly<{
  value: string;
  /** What the cells draw for the value: the value itself, or its masked form until the person shows it. */
  shown?: string;
  /** The input's own masking (web `type=password`), kept while the key is hidden. */
  secureTextEntry?: boolean;
  onChangeText: (value: string) => void;
  onSubmitEditing?: () => void;
  invalid?: boolean;
  autoFocus?: boolean;
  /** Groups per row: three on a computer, two on a phone (lab direction A). */
  groupsPerRow: number;
  testID?: string;
  accessibilityLabel: string;
  accessibilityLabelledBy?: string;
  accessibilityDescribedBy?: string;
}>;

/**
 * The recovery key drawn as the printed key's cells (lab direction A "Your recovery key"): one character per cell in
 * the saved key's groups, so a pasted or typed key can be checked against the paper at a glance. One text input lies
 * over the cells and takes the typing, the paste and the screen reader; the cells only draw its value.
 */
export const RecoveryKeyCells = React.forwardRef<
  React.ElementRef<typeof TextInput>,
  RecoveryKeyCellsProps
>(function RecoveryKeyCells(props, ref) {
  const { theme } = useUnistyles();
  const [focused, setFocused] = React.useState(false);
  const characters = Array.from((props.shown ?? props.value).replace(/[\s-]/gu, ''));
  // The printed key's groups (its last one short); a longer paste keeps every character visible.
  const cellCount = Math.max(KEY_CHARACTERS, characters.length);
  const groups: number[][] = [];
  for (let start = 0; start < cellCount; start += GROUP_SIZE) {
    groups.push(Array.from({ length: Math.min(GROUP_SIZE, cellCount - start) }, (_, offset) => start + offset));
  }
  const rows: number[][][] = [];
  for (let index = 0; index < groups.length; index += props.groupsPerRow) {
    rows.push(groups.slice(index, index + props.groupsPerRow));
  }
  const nextIndex = characters.length;

  return (
    <View style={styles.root}>
      <View
        style={styles.grid}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.row}>
            {row.map((group, groupIndex) => (
              <View key={groupIndex} style={styles.group}>
                {group.map((cellIndex) => {
                  const character = characters[cellIndex];
                  const next = focused && cellIndex === nextIndex;
                  return (
                    <View
                      key={cellIndex}
                      style={[
                        styles.cell,
                        {
                          backgroundColor: theme.colors.surface.base,
                          borderColor: next
                            ? theme.colors.text.primary
                            : props.invalid
                              ? theme.colors.state.danger.textForeground
                              : theme.colors.border.default,
                        },
                        next ? styles.cellNext : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.character,
                          {
                            color: character
                              ? theme.colors.text.primary
                              : theme.colors.text.disabled,
                          },
                        ]}
                      >
                        {character ?? BLANK}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        ))}
      </View>
      <TextInput
        ref={ref}
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityLabelledBy={props.accessibilityLabelledBy}
        aria-describedby={
          Platform.OS === 'web' ? props.accessibilityDescribedBy : undefined
        }
        aria-invalid={props.invalid || undefined}
        value={props.value}
        onChangeText={props.onChangeText}
        onSubmitEditing={props.onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={props.autoFocus}
        secureTextEntry={props.secureTextEntry}
        multiline={false}
        // Enter submits and keeps the key focused, so a refused key can be corrected at once.
        blurOnSubmit={!props.onSubmitEditing}
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="go"
        caretHidden
        contextMenuHidden={false}
        style={styles.input}
      />
    </View>
  );
});

const CELL_WIDTH = 22;
const CELL_HEIGHT = 32;

const styles = StyleSheet.create((theme) => ({
  root: {
    alignSelf: 'center',
    position: 'relative',
  },
  grid: {
    gap: theme.space.s10,
  },
  row: {
    flexDirection: 'row',
    gap: theme.space.s12,
  },
  group: {
    flexDirection: 'row',
    gap: 3,
  },
  cell: {
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellNext: {
    borderWidth: 1.5,
  },
  character: {
    ...Typography.variant('heading'),
    ...Typography.mono(),
  },
  // The input covers the cells so a press anywhere on the key focuses it; its own text and caret stay invisible.
  input: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0,
  },
}));
