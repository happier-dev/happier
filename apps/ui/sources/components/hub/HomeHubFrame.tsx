import * as React from 'react';
import { View } from 'react-native';

import { GlassSurface, type GlassSurfaceProps } from '@/components/ui/glass/GlassSurface';
import { PopoverScope } from '@/components/ui/popover';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useDestinationInstanceKey, useDestinationVisibility } from '@/components/appShell/workspace/destinationInstanceContext';

/** Home's existing content plane and column-local popover boundary. */
export function HomeHubFrame(props: Readonly<Pick<GlassSurfaceProps, 'children' | 'style' | 'onLayout'> & {
    focused: boolean;
    loadingLayer?: React.ReactNode;
}>) {
    const paneBoundaryRef = React.useRef<View>(null);
    const destinationKey = useDestinationInstanceKey();
    const visible = useDestinationVisibility();
    return (
        <PluginSurfaceFocusEligibilityProvider active={props.focused} presentationActive={destinationKey !== null ? visible : props.focused}>
            <GlassSurface ref={paneBoundaryRef} noCoat plane surfaceGroup="content" finishRole={null}
                style={props.style} onLayout={props.onLayout}>
                <PopoverScope boundaryRef={paneBoundaryRef}>
                    {props.children}
                </PopoverScope>
                {props.loadingLayer}
            </GlassSurface>
        </PluginSurfaceFocusEligibilityProvider>
    );
}
