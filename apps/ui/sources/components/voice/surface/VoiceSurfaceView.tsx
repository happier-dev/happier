import * as React from 'react';

import { VoiceHorizon } from './presentations/VoiceHorizon';
import type { VoiceSurfaceViewModel } from './useVoiceSurfaceModel';

/**
 * The Voice surface's presentation seam.
 *
 * `React.memo` over one `model` prop — and, since M2, a memo that actually does
 * something: `useVoiceSurfaceModel` now returns a stable object for unchanged
 * inputs, so an unrelated parent render no longer repaints the planet, the meter
 * and the transcript.
 *
 * The four host call sites and `VoiceSurface.tsx` are untouched (§5.1); the
 * presentation is swapped **behind** this seam. Horizon owns the whole surface —
 * vessel, sky, status line, transport, transcript and recovery — so there is one
 * presentation here, not a switch between two.
 */
export const VoiceSurfaceView = React.memo(function VoiceSurfaceView(props: Readonly<{
    model: VoiceSurfaceViewModel;
}>) {
    return <VoiceHorizon model={props.model} />;
});
