import * as React from 'react';
import type { View } from 'react-native';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';

import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * The measured host decides presentation and motion eligibility for rail life and finite hero moments alike. These are
 * on-screen facts only: whether anyone views the app reaches the face's motion through host-gated effects
 * (`useHostActivelyViewedEffect`) and the attention clock's own host watch, so hiding the app renders no face.
 */
export function useBotFaceMotionEligibility(visible: boolean, mode: BotMotion): Readonly<{
  ref: React.RefObject<View | null>;
  id: string;
  measure: () => void;
  presented: boolean;
  eligible: boolean;
}> {
  const reduced = useReducedMotionPreference();
  const tracker = useOptionalPluginUiScrollActivityTracker();
  const ref = React.useRef<View>(null);
  const id = React.useId();
  const { near, measure } = useMeasuredNearViewport(tracker, ref, visible, id);
  const presented = visible && near;
  return { ref, id, measure, presented, eligible: presented && !reduced && mode !== 'still' };
}
