import * as React from 'react';

import type { TerminalNativeSurfaceProps } from '@happier-dev/terminal-native';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { NativeTerminalSurface, type NativeTerminalSurfaceProps } from '@/components/terminal/native/surface.native';

export type GhosttyTerminalSurfaceProps = TerminalNativeSurfaceProps & Pick<
    NativeTerminalSurfaceProps,
    | 'accessibilityAccepted'
    | 'accessibilityTerminalLabel'
    | 'accessibilityFallbackValue'
    | 'accessibilityFocusActionLabel'
    | 'accessibilityCopySelectionActionLabel'
    | 'accessibilitySelectAllActionLabel'
    | 'accessibilityOpenLinkActionLabel'
    | 'onWriteComplete'
    | 'testID'
>;

export const GhosttyTerminalSurface = React.forwardRef<EmbeddedTerminalRendererHandle, GhosttyTerminalSurfaceProps>(function GhosttyTerminalSurface(
    props,
    ref,
) {
    return <NativeTerminalSurface ref={ref} {...props} />;
});
