import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

export type SelectionToolbarMenuItem = Readonly<{
  id: string;
  label: string;
  run: () => unknown;
}>;

export type SelectionToolbarAction = Readonly<{
  id: string;
  label: string;
  icon: IconName;
  /** The surface's main action: the one the selection's Ask shortcut runs, so its key is shown beside it. */
  primary?: boolean;
  onPress: () => unknown;
}>;

export type SelectionToolbarProps = Readonly<{
  /** Window rect of the selection's start; the toolbar grows from it. Null hides the toolbar. */
  anchor: Rect | null;
  /** Absent when no target can receive the question (Ask is hidden, Comment/Copy remain). */
  onAsk?: (() => unknown) | null;
  /** Other ways to ask (Ask in a side run); drawn behind the chevron beside Ask. */
  askMenuItems?: readonly SelectionToolbarMenuItem[];
  /** Absent for unanchored sources (terminal, transcript, rendered Markdown). */
  onComment?: (() => unknown) | null;
  onCopy: () => unknown;
  testID?: string;
  /** Surface-owned actions replace Ask and Comment; Copy keeps its place after them. */
  actions?: readonly SelectionToolbarAction[] | null;
}>;

/**
 * The floating toolbar over a text selection in code, diffs, Markdown, the terminal and transcript code
 * (lab AS1 A1: `Ask ⌘I · Comment · Copy`). It owns chrome only; the selection, the draft and the
 * destination stay with `useAskSelection`. Non-modal: the selection and the page stay interactive.
 */
/** One row of menu-row items: the toolbar needs this much room on its side of the selection. */
const TOOLBAR_HEIGHT_CAP_PX = MENU_ROW_METRICS.minHeightPx * 2;

export function SelectionToolbar(
  props: SelectionToolbarProps,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const shortcut = useKeyboardShortcutLabel('editor.selection.ask');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const anchor = props.anchor;
  const popoverAnchor = React.useMemo(
    () =>
      anchor
        ? {
            kind: 'rect' as const,
            // The selection's start: the toolbar rises from the top-left of its first line.
            rect: { left: anchor.x, top: anchor.y, width: 1, height: 1 },
            coordinateSpace: 'window' as const,
          }
        : null,
    [anchor?.x, anchor?.y],
  );
  if (!popoverAnchor) return null;
  const askMenuItems = props.askMenuItems ?? [];
  const glyph = (name: IconName) => (
    <Icon
      name={name}
      size={MENU_ROW_METRICS.iconGlyphSizePx}
      color={theme.colors.text.secondary}
    />
  );
  return (
    <Popover
      open
      anchor={popoverAnchor}
      backdrop={false}
      boundaryRef={null}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
        sizeToContent: true,
      }}
      placement="top"
      flip
      maxHeightCap={TOOLBAR_HEIGHT_CAP_PX}
      placementMinSpace={TOOLBAR_HEIGHT_CAP_PX}
      gap={6}
      minWidth={0}
    >
      {() => (
        <FloatingOverlay
          scrollEnabled={false}
          maxHeight={TOOLBAR_HEIGHT_CAP_PX}
        >
          <View
            style={styles.row}
            accessibilityRole="toolbar"
            accessibilityLabel={t('files.askSelection.toolbarLabel')}
            testID={props.testID ?? 'selection-toolbar'}
          >
            {props.actions ? props.actions.map((action) => (
              <SelectionToolbarItem
                key={action.id}
                label={action.label}
                icon={glyph(action.icon)}
                shortcut={action.primary ? shortcut : undefined}
                onPress={action.onPress}
                testID={`selection-toolbar-${action.id}`}
              />
            )) : <>
            {props.onAsk ? (
              <View style={styles.askGroup}>
                <SelectionToolbarItem
                  label={t('files.askSelection.ask')}
                  icon={glyph('sparkle')}
                  shortcut={shortcut}
                  onPress={props.onAsk}
                  testID="selection-toolbar-ask"
                  joinedEnd={askMenuItems.length > 0}
                />
                {askMenuItems.length > 0 ? (
                  <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={askMenuItems.map((item) => ({
                      id: item.id,
                      title: item.label,
                      testID: `selection-toolbar-menu-${item.id}`,
                    }))}
                    onSelect={(id) => {
                      setMenuOpen(false);
                      void askMenuItems.find((item) => item.id === id)?.run();
                    }}
                    matchTriggerWidth={false}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => (
                      <SelectionToolbarItem
                        accessibilityLabel={t(
                          'files.askSelection.moreWaysToAsk',
                        )}
                        icon={glyph('caret-down')}
                        onPress={toggle}
                        testID="selection-toolbar-ask-menu"
                        joinedStart
                      />
                    )}
                  />
                ) : null}
              </View>
            ) : null}
            {props.onComment ? (
              <SelectionToolbarItem
                label={t('files.askSelection.comment')}
                icon={glyph('chat')}
                onPress={props.onComment}
                testID="selection-toolbar-comment"
              />
            ) : null}
            </>}
            {props.actions?.length || props.onAsk || props.onComment ? (
              <View style={styles.separator} />
            ) : null}
            <SelectionToolbarItem
              label={t('files.askSelection.copy')}
              icon={glyph('copy')}
              onPress={props.onCopy}
              testID="selection-toolbar-copy"
            />
          </View>
        </FloatingOverlay>
      )}
    </Popover>
  );
}

function SelectionToolbarItem(
  props: Readonly<{
    label?: string;
    accessibilityLabel?: string;
    icon: React.ReactNode;
    shortcut?: string;
    onPress: () => unknown;
    testID: string;
    joinedStart?: boolean;
    joinedEnd?: boolean;
  }>,
) {
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={() => {
        void props.onPress();
      }}
      style={({ hovered, pressed }) => [
        styles.item,
        props.label ? null : styles.iconItem,
        props.joinedStart ? styles.joinedStart : null,
        props.joinedEnd ? styles.joinedEnd : null,
        pressed ? styles.pressed : hovered ? styles.hovered : null,
      ]}
    >
      <View pointerEvents="none">{props.icon}</View>
      {props.label ? (
        <Text
          variant="label"
          emphasis="medium"
          style={styles.label}
          numberOfLines={1}
        >
          {props.label}
        </Text>
      ) : null}
      {props.shortcut ? (
        <Text variant="meta" style={styles.shortcut} numberOfLines={1}>
          {props.shortcut}
        </Text>
      ) : null}
    </HappierPressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: MENU_ROW_METRICS.insetPx,
    gap: theme.space.s2,
  },
  askGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: MENU_ROW_METRICS.minHeightPx - MENU_ROW_METRICS.insetPx,
    paddingHorizontal: theme.space.s10,
    borderRadius: MENU_ROW_METRICS.radiusPx,
  },
  iconItem: {
    paddingHorizontal: theme.space.s6,
  },
  joinedStart: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
  },
  joinedEnd: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    paddingRight: theme.space.s6,
  },
  hovered: {
    backgroundColor: theme.colors.surface.pressed,
  },
  pressed: {
    backgroundColor: theme.colors.surface.selected,
  },
  label: {
    color: theme.colors.text.primary,
  },
  shortcut: {
    color: theme.colors.text.tertiary,
    ...Typography.mono(),
  },
  separator: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: theme.space.s6,
    marginHorizontal: theme.space.s2,
    backgroundColor: theme.colors.border.subtle,
  },
}));
