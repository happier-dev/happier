import * as React from 'react';

import { VoiceGlance } from '@/components/voice/presence/VoiceGlance';

import type { VoiceSurfaceViewModel } from './useVoiceSurfaceModel';

/**
 * The Voice surface's presentation seam.
 *
 * `React.memo` over one `model` prop; `useVoiceSurfaceModel` returns a stable object for unchanged
 * inputs, so an unrelated parent render does not repaint the mark or the transcript.
 *
 * The presentation is the Voice section (lab `voice-presence`): the same component the Companion,
 * the container popovers and the phone sheet host. The retired Horizon vessel is gone; placement
 * belongs to the presence containers, never to this seam.
 */
export const VoiceSurfaceView = React.memo(function VoiceSurfaceView(props: Readonly<{
    model: VoiceSurfaceViewModel;
}>) {
    return <VoiceGlance model={props.model} presentation="companion" />;
});
