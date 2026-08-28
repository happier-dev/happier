import * as React from 'react';

import type {
    TerminalNativeSurfaceProps,
    TerminalNativeUnavailableReason,
} from '@happier-dev/terminal-native';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { NativeTerminalSurface, type NativeTerminalSurfaceProps } from '@/components/terminal/native/surface.native';

export type TermuxTerminalSurfaceProps = Omit<TerminalNativeSurfaceProps, 'onUnavailable'> & Readonly<{
    onUnavailable?: (reason: TerminalNativeUnavailableReason) => void;
}> & Pick<
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

export const TermuxTerminalSurface = React.forwardRef<EmbeddedTerminalRendererHandle, TermuxTerminalSurfaceProps>(function TermuxTerminalSurface(
    props,
    ref,
) {
    return <NativeTerminalSurface ref={ref} {...props} />;
});
