import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SelectionActionBar } from '@/components/ui/selection/SelectionActionBar';
import { useFloatingChromeClearance, usePageBottomSeat, useReportPageBottomBar } from '@/components/ui/layout/useFloatingChromeClearance';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import { SelectionToolbar, type SelectionToolbarAction } from './SelectionToolbar';
import { useAskSelection, type AskSelection, type UseAskSelectionInput } from './useAskSelection';

export type AskSelectionControlsProps = UseAskSelectionInput &
  Readonly<{
    /** Comment opens this surface's own inline composer; omit where the surface has none. */
    commentEnabled?: boolean;
    /** The surface's own Comment for the selected lines (opens its inline composer); implies Comment. */
    onCommentSelection?: (selection: AskSelection) => void;
    /** The phone selection bar took (true) or left (false) the bottom edge, so a page's own bottom bar can step aside. */
    onPhoneBarShownChange?: (shown: boolean) => void;
    testID?: string;
    actionsForSelection?: (selection: AskSelection) => readonly SelectionToolbarAction[] | null;
  }>;

/**
 * The rendered Ask controls for one selection source: the floating toolbar on desktop, the selection
 * bar on a phone. One `useAskSelection` owns the operation; this binds its result to chrome only.
 */
export function AskSelectionControls(
  props: AskSelectionControlsProps,
): React.ReactElement | null {
  const { commentEnabled, onCommentSelection, onPhoneBarShownChange, testID, actionsForSelection, ...input } = props;
  const ask = useAskSelection(input);
  const isPhone = useDeviceType() === 'phone';
  // The phone bar floats over the page like its other bottom bars: above the floating tab bar when one covers it.
  const chromeClearance = useFloatingChromeClearance();
  const selection = ask.selection;
  // The floating toolbar needs a rect to rise from; a native selection made on rows has none, so it takes the bar.
  const phone = isPhone || (Platform.OS !== 'web' && selection !== null && !selection.rect);
  // Once the person asked or commented, the toolbar steps back until the selection changes (lab A2:
  // the selection stays visible, the question is in the composer now).
  const selectionKey = selection
    ? `${selection.key ?? ''}:${selection.startLine}:${selection.endLine}:${selection.text}`
    : null;
  const [actedOnKey, setActedOnKey] = React.useState<string | null>(null);
  React.useEffect(() => { if (selection === null) setActedOnKey(null); }, [selection]);
  const visible =
    props.active !== false &&
    selection !== null &&
    selection.collapsed !== true &&
    selection.text.length > 0 &&
    selectionKey !== actedOnKey;
  // Without a session the operation still has a destination (a side run or a new session), so Ask stays.
  const onAsk = React.useCallback(() => {
    setActedOnKey(selectionKey);
    return ask.ask();
  }, [ask.ask, selectionKey]);
  const onComment = React.useMemo(() => {
    if (onCommentSelection) {
      return () => {
        const current = ask.selection;
        setActedOnKey(selectionKey);
        if (current) onCommentSelection(current);
      };
    }
    if (!commentEnabled || !ask.canComment) return null;
    return () => {
      setActedOnKey(selectionKey);
      return ask.comment();
    };
  }, [ask.canComment, ask.comment, ask.selection, commentEnabled, onCommentSelection, selectionKey]);
  const phoneBarShown = phone && visible;
  const { theme } = useUnistyles();
  // The bar floats, so it yields to the bars the page keeps in flow (the Edit key row with Save, the review bar)
  // and rides above them; it is itself kept by what floats above it (the working capsule).
  const phoneBarBottom = usePageBottomSeat(chromeClearance > 0 ? chromeClearance : theme.space.s16, 'kept');
  const onSeatLayout = useReportPageBottomBar(phoneBarShown, phoneBarBottom, 'stacked');
  React.useEffect(() => {
    if (!onPhoneBarShownChange) return;
    onPhoneBarShownChange(phoneBarShown);
  }, [onPhoneBarShownChange, phoneBarShown]);
  React.useEffect(() => () => onPhoneBarShownChange?.(false), [onPhoneBarShownChange]);
  const menuItems = React.useMemo(() => ask.menuItems.map((item) => ({
    ...item,
    run: () => {
      setActedOnKey(selectionKey);
      return item.run();
    },
  })), [ask.menuItems, selectionKey]);
  const customActions = selection && actionsForSelection?.(selection)?.map((action) => ({ ...action,
    onPress: () => { setActedOnKey(selectionKey); return action.onPress(); } }));
  if (phone) {
    const lineCount = selection
      ? selection.endLine - selection.startLine + 1
      : 0;
    return (
      <View
        pointerEvents="box-none"
        onLayout={onSeatLayout}
        style={[styles.phoneBarHost, { bottom: phoneBarBottom }]}
      >
      <SelectionActionBar
        visible={visible}
        // Surface actions select prose, where a line count means nothing: the bar names the selection instead.
        label={customActions ? t('files.askSelection.toolbarLabel') : t('files.askSelection.lineCount', { count: lineCount })}
        actions={customActions ? [
          ...customActions.map((action) => ({
            id: action.id,
            label: action.label,
            ...(action.primary ? { emphasis: 'primary' as const } : {}),
            onPress: action.onPress,
            testID: `selection-bar-${action.id}`,
            renderIcon: (color: string) => <Icon name={action.icon} size={ICON_SIZE.sm} color={color} />,
          })),
          {
            id: 'copy',
            label: t('files.askSelection.copy'),
            onPress: ask.copy,
            testID: 'selection-bar-copy',
          },
        ] : [
          {
            id: 'ask',
            label: t('files.askSelection.ask'),
            emphasis: 'primary',
            onPress: onAsk,
            testID: 'selection-bar-ask',
            renderIcon: (color) => (
              <Icon name="sparkle" size={16} color={color} />
            ),
          },
          ...(onComment
            ? [
                {
                  id: 'comment',
                  label: t('files.askSelection.comment'),
                  onPress: onComment,
                  testID: 'selection-bar-comment',
                },
              ]
            : []),
          {
            id: 'copy',
            label: t('files.askSelection.copy'),
            onPress: ask.copy,
            testID: 'selection-bar-copy',
          },
          // Other ways to ask are the rare path: on a phone they wait under the bar's ⋯, as behind Ask's chevron on desktop.
          ...menuItems.map((item) => ({
            id: item.id,
            label: item.label,
            placement: 'menu' as const,
            onPress: item.run,
            testID: `selection-bar-${item.id}`,
          })),
        ]}
        dismiss={{
          label: t('common.close'),
          // ✕ puts the bar away until the selection changes, the same step-back as after Ask or Comment.
          onPress: () => setActedOnKey(selectionKey),
          testID: 'selection-bar-dismiss',
        }}
        testID={testID ? `${testID}-bar` : 'selection-bar'}
      />
      </View>
    );
  }
  return (
    <SelectionToolbar
      anchor={visible ? (selection?.rect ?? null) : null}
      onAsk={onAsk}
      askMenuItems={menuItems}
      onComment={onComment}
      onCopy={ask.copy}
      testID={testID}
      actions={customActions}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // The bar takes its host's width, so the host holds the gutters (a bar with its own insets would be page-wide and spill).
  phoneBarHost: {
    position: 'absolute',
    left: theme.space.s16,
    right: theme.space.s16,
  },
}));
