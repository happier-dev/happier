import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { usePresentedDetailNavigationChrome } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useDeviceType } from '@/utils/platform/responsive';
import { CockpitBarFoldedContext, useReportPageBarFoldsChrome } from './pageBarChromeFold';

/** A page's own bottom bar takes the phone's bottom while it is the page on screen; a modal's bar never does. */
export function useClaimPhoneBottomForPageBar(): boolean {
    const phone = useDeviceType() === 'phone';
    const inModal = useIsInsideModalBoundary();
    const presented = useLayoutPresentationActive();
    const focused = useDestinationFocus();
    const claims = phone && !inModal && presented && focused;
    useReportPageBarFoldsChrome(claims);
    return claims;
}

/**
 * The detail page's bar, folded to one More inside the page's own bottom bar (FIN N4): the page keeps its way
 * between Map and Steps (or any page), and only one bar stands at the bottom. Draws nothing on a page with no
 * detail navigation.
 */
export function PageBarFoldedChrome(props: Readonly<{ style?: StyleProp<ViewStyle> }>) {
    const chrome = usePresentedDetailNavigationChrome();
    const execute = useMountedScopeActionCommand(chrome?.scope ?? null);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const node = chrome && cockpitEnabled ? chrome.phoneChrome(execute)?.node ?? null : null;
    return node ? <View style={props.style}><CockpitBarFoldedContext.Provider value={true}>{node}</CockpitBarFoldedContext.Provider></View> : null;
}
