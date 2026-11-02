import { withShortcut } from '@/keyboard/withShortcut';
import { HAPPIER_ICON_BUTTON_SIZE, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { SidebarCollapseIcon } from '@/components/navigation/shell/SidebarIcons';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { usePaneRegion } from '../paneRegionContext';
import { usePaneMainColumn } from './usePaneMainColumn';

/** Whether a header in this column draws the hide control (the main column's own header only). */
export function usePaneMainHideAvailable(): boolean {
    const main = usePaneMainColumn();
    const region = usePaneRegion();
    return main !== null && main.canHide && !main.hidden && region === 'main';
}

/** Whether a hidden main column's restore chip has something to show. */
export function usePaneMainRestoreChipVisible(): boolean {
    const main = usePaneMainColumn();
    return main !== null && main.hidden && main.identity.name.length > 0;
}

/**
 * "Hide session / project / workflow / <page>" (lab ade-shell H1/HB, DIRECTION decision 2): the one
 * control for the visible state, drawn by each host in its main column's own header. It renders
 * nothing outside a pane host, where the host offers no hide, or while the column is already hidden
 * (the restore chip is that state's control). The glyph points the way the column leaves: toward
 * the window's left edge in Session first, its right edge in Editor first.
 */
export const PaneMainHideButton = React.memo(function PaneMainHideButton(
  props: Readonly<{
    size?: number;
    glyphSize?: number;
    color?: string;
    testID?: string;
    /** The gap to the neighbouring header action: their finger frames split it. */
    interactiveTargetGapPx?: number;
  }>,
) {
  const { theme } = useUnistyles();
  const main = usePaneMainColumn();
  const layout = useOptionalAppPaneScopeLayout();
  const shortcut = useKeyboardShortcutLabel('panes.main.toggle');
  const region = usePaneRegion();
    if (!main || !main.canHide || main.hidden || region !== 'main') return null;
  const edge = layout?.arrangement === 'editor' ? 'right' : 'left';
  return (
    <IconButton
      testID={props.testID ?? 'pane-main-hide'}
      variant="plain"
      size={props.size}
      interactiveTargetGapPx={props.interactiveTargetGapPx}
      accessibilityLabel={main.labels.hideLabel}
      tooltip={withShortcut(main.labels.hideLabel, shortcut)}
      tooltipPlacement="bottom"
      icon={
        <SidebarCollapseIcon
          edge={edge}
          size={props.glyphSize ?? resolveIconButtonGlyphSize(props.size ?? HAPPIER_ICON_BUTTON_SIZE)}
          color={props.color ?? theme.colors.text.secondary}
        />
      }
      onPress={() => main.setHidden(true)}
    />
  );
});

/**
 * The hidden state's control (lab H1–H3): the host's mark, name and live state, at the edge of the
 * neighbouring strip the column went to. Hiding a column never hides attention (H2): the working
 * ring and the amber "Needs you" come from the host's lifecycle projection, and a change of that
 * state is announced once. Pressing it shows the column again (or opens the narrow drawer).
 */
export const PaneMainRestoreChip = React.memo(function PaneMainRestoreChip(
  props: Readonly<{ testID?: string }>,
) {
  const main = usePaneMainColumn();
  const shortcut = useKeyboardShortcutLabel('panes.main.toggle');
  const visible = main !== null && main.hidden && main.identity.name.length > 0;
  const state = visible ? main.identity.state : undefined;
  const name = main?.identity.name ?? '';
  const lastAnnounced = React.useRef<typeof state>(undefined);
  React.useEffect(() => {
    if (!visible) {
      lastAnnounced.current = undefined;
      return;
    }
    if (state === 'attention' && lastAnnounced.current !== 'attention') {
      announceAccessibilityMessage(
        t('panes.mainColumn.chipNeedsYouAnnouncement', { name }),
      );
    }
    lastAnnounced.current = state;
  }, [name, state, visible]);
  if (!visible || !main) return null;
  return <PaneMainRestoreChipBody main={main} state={state} name={name} shortcut={shortcut} testID={props.testID} />;
});

/**
 * The chip arrives from the edge the column left by (lab H1/H3), on the column's own `overlay.panel`
 * travel, so the two read as one move; a fade alone under reduced motion.
 */
function PaneMainRestoreChipBody(props: Readonly<{
  main: NonNullable<ReturnType<typeof usePaneMainColumn>>;
  state: 'working' | 'attention' | undefined;
  name: string;
  shortcut: string | undefined;
  testID?: string;
}>) {
  const { theme } = useUnistyles();
  const { main, state, name, shortcut } = props;
  const layout = useOptionalAppPaneScopeLayout();
  const reducedMotion = useReducedMotionPreference();
  const arrival = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const panel = motionTokens.overlay.panel;
    const animation = Animated.timing(arrival, {
      toValue: 1,
      duration: reducedMotion ? panel.reducedMotionFadeMs : panel.enterMs,
      easing: motionTokens.easing.standard,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [arrival, reducedMotion]);
  const fromEdgePx = layout?.arrangement === 'editor' ? 12 : -12;
  const attention = state === 'attention';
  // App pages name themselves in the show label ("Show Plugins"); say the name once.
    const showLabelNamesIt = main.labels.showLabel.includes(name);
    const label = attention
        ? t('panes.mainColumn.chipNeedsYouA11y', { label: main.labels.showLabel, name })
        : showLabelNamesIt ? main.labels.showLabel : t('panes.mainColumn.chipA11y', { label: main.labels.showLabel, name });
  return (
    <Animated.View style={[styles.arrival, {
      opacity: arrival,
      transform: [{ translateX: reducedMotion ? 0 : arrival.interpolate({ inputRange: [0, 1], outputRange: [fromEdgePx, 0] }) }],
    }]}>
    <HappierPressable
      testID={props.testID ?? 'pane-main-restore-chip'}
      accessibilityRole="button"
      accessibilityLabel={label}
      keyboardShortcuts={shortcut}
      onPress={() => main.setHidden(false)}
      style={({ hovered, pressed }) => [
        styles.chip,
        attention
          ? { borderColor: theme.colors.state.attention.foreground }
          : null,
        hovered || pressed
          ? { backgroundColor: theme.colors.surface.selected }
          : null,
      ]}
    >
      {main.identity.mark ? (
        <View style={styles.mark}>{main.identity.mark}</View>
      ) : null}
      <Text numberOfLines={1} style={styles.name}>
        {name}
      </Text>
      {state === 'working' ? (
        <ActivitySpinner
          size="small"
          color={theme.colors.text.secondary}
          style={styles.spinner}
        />
      ) : attention ? (
        <View style={styles.attention}>
          <View
            style={[
              styles.attentionDot,
              { backgroundColor: theme.colors.state.attention.foreground },
            ]}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.attentionText,
              { color: theme.colors.state.attention.textForeground },
            ]}
          >
            {t('panes.mainColumn.needsYou')}
          </Text>
        </View>
      ) : null}
    </HappierPressable>
    </Animated.View>
  );
}

const S = DETAILS_TAB_STRIP_METRICS;

const styles = StyleSheet.create((theme) => ({
  arrival: { flexShrink: 1, minWidth: 0 },
  // One strip tab's height and radius, so the chip sits on the strip's rhythm; a flat ink edge
  // because it is an in-flow control, not a floating surface.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
    maxWidth: S.tabMaxWidthPx + 80,
    height: S.tabHeightPx,
    gap: theme.space.s6,
    paddingLeft: S.tabPaddingStartPx,
    paddingRight: S.tabPaddingStartPx,
    marginHorizontal: S.tabGapPx * 2,
    borderRadius: S.tabRadiusPx,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.strong,
    backgroundColor: theme.colors.surface.base,
  },
  mark: { flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  name: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
    minWidth: 0,
  },
  spinner: { flexShrink: 0, transform: [{ scale: 0.7 }] },
  attention: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexShrink: 0,
  },
  attentionDot: { width: 6, height: 6, borderRadius: 3 },
  attentionText: Typography.variant('meta', 'semiBold'),
}));
