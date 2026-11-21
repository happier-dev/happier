import * as React from 'react';
import Reanimated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';

import { workflowRunStyles as styles } from './workflowRunStyles';

/**
 * The completion moment's tint, drawn behind the outcome's words (07 §M1).
 *
 * It stays mounted so the tint can fade: in over `fast`, out over `slow`, both
 * on the standard curve, opacity only. When it shows and for how long belongs
 * to `useWorkflowCompletionMoment`; this layer only draws its `active` value.
 */
export function WorkflowRunOutcomeEmphasis(
  props: Readonly<{
    active: boolean;
    onTitleEdge: boolean;
    testID: string;
  }>,
) {
  const { active } = props;
  const animatedStyle = useAnimatedStyle(
    () => ({
      opacity: withTiming(active ? 1 : 0, {
        duration: active
          ? reanimatedMotionTokens.durationMs.fast
          : reanimatedMotionTokens.durationMs.slow,
        easing: reanimatedMotionTokens.easing.standard,
      }),
    }),
    [active],
  );
  return (
    <Reanimated.View
      testID={props.testID}
      style={[
        styles.outcomeEmphasis,
        props.onTitleEdge ? styles.outcomeEmphasisOnTitleEdge : null,
        animatedStyle,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
