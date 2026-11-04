import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useSessionCockpitPageBottomClearance } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The phone Run's Needs-you dock (lab `phone-P1`, 07 §2.3 item 32): what waits for the person stays in
 * thumb reach while the Map scrolls, as the count, the waiting steps, and one filled **Review** that opens
 * the first of them. It floats on the role's material; the page reserves its height (`onHeight`) so the
 * last Map row is never covered.
 */
export function WorkflowRunNeedsYouDock(
  props: Readonly<{
    count: number;
    steps: readonly string[];
    onReview: (event?: unknown) => void;
    onHeight: (heightPx: number) => void;
    /** Review is filled only when the page has no other primary (one primary per page). */
    primary: boolean;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const insets = useChromeSafeAreaInsets();
  const bottomClearance = Math.max(insets.bottom, useSessionCockpitPageBottomClearance());
  const { theme } = useUnistyles();
  const { onHeight } = props;
  const frameHeight = React.useRef<number | null>(null);
  // Moving the padded parent need not produce a new layout event for its unchanged frame.
  React.useLayoutEffect(() => {
    if (frameHeight.current !== null) onHeight(frameHeight.current + bottomClearance);
  }, [bottomClearance, onHeight]);
  const handleLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      frameHeight.current = event.nativeEvent.layout.height;
      onHeight(frameHeight.current + bottomClearance);
    },
    [bottomClearance, onHeight],
  );
  return (
    <View
      pointerEvents="box-none"
      style={[styles.positioner, { paddingBottom: bottomClearance }]}
    >
      <View onLayout={handleLayout} style={styles.frame}>
        <GlassPanel
          testID={props.testIDPrefix}
          radius={theme.borderRadius.xl}
          style={styles.panel}
        >
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>
              {t('workflows.a11y.needsYou', { count: props.count })}
            </Text>
            <Text style={styles.steps} numberOfLines={1}>
              {props.steps.join(' · ')}
            </Text>
          </View>
          <ToolbarButton
            testID={`${props.testIDPrefix}-review`}
            tone={props.primary ? 'primary' : 'default'}
            size="md"
            label={t('workflows.run.review')}
            onPress={props.onReview}
          />
        </GlassPanel>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  positioner: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.space.s16,
  },
  frame: {
    paddingVertical: theme.space.s8,
  },
  panel: {
    borderRadius: theme.borderRadius.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s16,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...Typography.variant('heading'),
    color: theme.colors.state.warning.foreground,
  },
  steps: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
