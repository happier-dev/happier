import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatRecoveryKey } from '@happier-dev/protocol/auth/recoveryKey';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The printed key's groups (every recovery key is 32 bytes), so the cells match the key the person saved. */
const PRINTED_GROUPS = formatRecoveryKey(new Uint8Array(32)).split('-');
const GROUP_SIZE = PRINTED_GROUPS[0]!.length;
const KEY_CHARACTERS = PRINTED_GROUPS.join('').length;
/** The placeholder a blank cell shows (lab direction A key cells). */
const BLANK = '·';
/** Cells inside one group (lab direction A key cells). */
const CELL_GAP_PX = 3;
/** At most four groups a row: the printed key in three rows. Six a row (two rows) reads as a wall (owner, 2026-11-27). */
const MAX_GROUPS_PER_ROW = 4;
/** The narrowest cell whose mono character still reads, with air inside its border. */
const MIN_CELL_WIDTH_PX = 16;
/** The lab's cell: the key never grows past it however wide its column is. */
const MAX_CELL_WIDTH_PX = 22;
/** The lab cell's proportion (22 × 32), kept as the cell narrows. */
const CELL_HEIGHT_PER_WIDTH = 32 / 22;

type RecoveryKeyGrid = Readonly<{ groupsPerRow: number; cellWidthPx: number; cellHeightPx: number }>;

/**
 * The key's layout for the column it stands in: the most groups a row (at most four) whose cells stay readable,
 * the cells as wide as that row allows up to the lab's size. A 420 px field column takes four groups a row (three
 * rows), a phone three, a very narrow phone two. An unmeasured column takes the widest layout.
 */
function recoveryKeyGridFor(columnWidthPx: number | null, groupGapPx: number): RecoveryKeyGrid {
  const cellWidthFor = (groups: number) => columnWidthPx === null
    ? MIN_CELL_WIDTH_PX
    : Math.min(MAX_CELL_WIDTH_PX, Math.floor(
      (columnWidthPx - (groups - 1) * groupGapPx - groups * (GROUP_SIZE - 1) * CELL_GAP_PX) / (groups * GROUP_SIZE),
    ));
  let groupsPerRow = MAX_GROUPS_PER_ROW;
  while (groupsPerRow > 1 && cellWidthFor(groupsPerRow) < MIN_CELL_WIDTH_PX) groupsPerRow -= 1;
  const cellWidthPx = Math.max(MIN_CELL_WIDTH_PX, cellWidthFor(groupsPerRow));
  return { groupsPerRow, cellWidthPx, cellHeightPx: Math.round(cellWidthPx * CELL_HEIGHT_PER_WIDTH) };
}

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
  testID?: string;
  accessibilityLabel: string;
  accessibilityLabelledBy?: string;
  accessibilityDescribedBy?: string;
}>;

/**
 * The recovery key drawn as the printed key's cells (lab direction A "Your recovery key"): one character per cell in
 * the saved key's groups, so a pasted or typed key can be checked against the paper at a glance. One text input lies
 * over the cells and takes the typing, the paste and the screen reader; the cells only draw its value. The key fills
 * the width it is given and lays itself out by that measured width ({@link recoveryKeyGridFor}), read before the
 * first paint so it never re-flows on arrival; its cells keep their size through focus and typing.
 */
export const RecoveryKeyCells = React.forwardRef<
  React.ElementRef<typeof TextInput>,
  RecoveryKeyCellsProps
>(function RecoveryKeyCells(props, ref) {
  const { theme } = useUnistyles();
  const [focused, setFocused] = React.useState(false);
  const columnRef = React.useRef<View>(null);
  const [columnWidth, setColumnWidth] = React.useState<number | null>(null);
  const takeColumnWidth = React.useCallback((width: number | null | undefined) => {
    const visible = readHappierVisibleLayoutWidth(width ?? 0);
    if (visible === null) return;
    const next = Math.floor(visible);
    setColumnWidth((current) => (current === next ? current : next));
  }, []);
  // The layout width (untransformed, so a step's entrance scale does not shrink the key), before the first paint:
  // a DOM element on web, a React Native element on native.
  React.useLayoutEffect(() => {
    takeColumnWidth((columnRef.current as unknown as { offsetWidth?: number } | null)?.offsetWidth);
  }, [takeColumnWidth]);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    takeColumnWidth(event.nativeEvent.layout.width);
  }, [takeColumnWidth]);
  const grid = recoveryKeyGridFor(columnWidth, theme.space.s12);
  const cellSize = { width: grid.cellWidthPx, height: grid.cellHeightPx };
  const characters = Array.from((props.shown ?? props.value).replace(/[\s-]/gu, ''));
  // The printed key's groups (its last one short); a longer paste keeps every character visible.
  const cellCount = Math.max(KEY_CHARACTERS, characters.length);
  const groups: number[][] = [];
  for (let start = 0; start < cellCount; start += GROUP_SIZE) {
    groups.push(Array.from({ length: Math.min(GROUP_SIZE, cellCount - start) }, (_, offset) => start + offset));
  }
  const rows: number[][][] = [];
  for (let index = 0; index < groups.length; index += grid.groupsPerRow) {
    rows.push(groups.slice(index, index + grid.groupsPerRow));
  }
  const nextIndex = characters.length;

  return (
    <View ref={columnRef} style={styles.root} onLayout={onLayout}>
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
                        cellSize,
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

const styles = StyleSheet.create((theme) => ({
  root: {
    width: '100%',
    position: 'relative',
  },
  grid: {
    alignSelf: 'center',
    gap: theme.space.s10,
  },
  row: {
    flexDirection: 'row',
    gap: theme.space.s12,
  },
  group: {
    flexDirection: 'row',
    gap: CELL_GAP_PX,
  },
  cell: {
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
