import * as React from 'react';
import { View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { resolveHappierCarriedPreviewPlacement, type HappierReleaseOutcome } from '@happier-dev/plugin-ui/presentation';

import { POPOVER_PORTAL_Z_INDEX, tryRenderWebPortal } from '@/components/ui/popover/portal';
import { readExternalFileDragPointer, subscribeExternalFileDragPointer } from '../externalFileDropAdapter';
import { EntityReleaseOutcomePill } from './EntityReleasePreview';

const readServerPointer = () => null;

/** Only this positioning leaf observes OS pointer frames; the target and editor remain stable. */
export function ExternalFileDropOutcomePill(props: Readonly<{ outcome: HappierReleaseOutcome; testID: string }>): React.ReactElement | null {
    const pointer = React.useSyncExternalStore(subscribeExternalFileDragPointer, readExternalFileDragPointer, readServerPointer);
    const viewport = useWindowDimensions();
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    }, []);
    if (!pointer) return null;
    const placement = resolveHappierCarriedPreviewPlacement({ pointer, size, viewport });
    const content = <View testID={props.testID} pointerEvents="none" onLayout={onLayout} style={{
        position: 'fixed' as 'absolute', left: placement.left, top: placement.top, zIndex: POPOVER_PORTAL_Z_INDEX,
    }}><EntityReleaseOutcomePill outcome={props.outcome} /></View>;
    return tryRenderWebPortal({ shouldPortalWeb: true, portalTargetOnWeb: 'body', modalPortalTarget: null,
        getBoundaryDomElement: () => null, content }) as React.ReactElement | null ?? content;
}
