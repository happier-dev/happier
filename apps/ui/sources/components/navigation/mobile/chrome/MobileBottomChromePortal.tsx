import * as React from 'react';
import { Platform } from 'react-native';
import { useLaunchCurtainState } from '@/boot/launchCurtain';
import { tryRenderWebPortal } from '@/components/ui/popover/portal';
import { MobileBottomChromeHost } from './MobileBottomChromeHost';

export function MobileBottomChromePortal(): React.ReactElement | null {
    // This web portal sits outside the curtain's stacking context. Release it with the curtain's fade.
    const contentHidden = useLaunchCurtainState() === 'up';
    // The retained navigator is hidden while the workspace owns the visible session.
    // Keep its single bottom-chrome host visible and in the same React registry.
    const chrome = <MobileBottomChromeHost contentHidden={contentHidden} />;
    return <>{tryRenderWebPortal({
        shouldPortalWeb: Platform.OS === 'web',
        portalTargetOnWeb: 'body',
        modalPortalTarget: null,
        getBoundaryDomElement: () => null,
        content: chrome,
    }) ?? chrome}</>;
}
