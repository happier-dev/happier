import * as React from 'react';

import { Platform, View } from 'react-native';
import { Popover } from '@/components/ui/popover';
import { SessionModelSourceBrowseHandoffContext } from '@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff';
import { handleSubmenuBackKey } from '@/components/ui/forms/dropdown/useSubmenuHoverIntent';
import { AgentInputActionMenuSubmenuContext } from './agentInputActionMenuSubmenu';
import { useAgentInputPopoverLayout } from './useAgentInputPopoverLayout';

export type AgentInputSelectionPopoverProps = Readonly<{
    open: boolean;
    autoFocusOnOpen?: boolean;
    /** A hover preview's stacking, under every popover someone opened (`Popover`'s `layer`). */
    layer?: 'hoverCard';
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    onRequestClose: () => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    /** The room the content needs to show whole, when known up front (see `useAgentInputPopoverLayout`). */
    contentRoom?: number;
    portalTopBottomLayout?: 'anchored' | 'boundary';
    /** `sheet`: a phone shows the content as the shared bottom sheet (see `Popover.phonePresentation`). */
    phonePresentation?: 'sheet';
    /** The sheet's header: the shared title band (default) or `none` when the content draws its own. */
    sheetHeader?: 'band' | 'none';
    sheetSubtitle?: string;
    /** The sheet band's trailing action (a form's Done), see `Popover.sheetHeaderAction`. */
    sheetHeaderAction?: React.ReactNode;
    accessibilityLabel?: string;
    children: (args: Readonly<{
        maxHeight: number;
        presentation: 'popover' | 'sheet';
        /**
         * The popover's own dismissal, for content that dismisses (a list's Escape) rather than chooses: for a
         * + menu row's picker it returns to the menu. Absent outside a submenu, where both mean close.
         */
        dismiss?: () => void;
    }>) => React.ReactNode;
}>;

function OpenAgentInputSelectionPopover(props: AgentInputSelectionPopoverProps) {
    const popoverLayout = useAgentInputPopoverLayout({
        open: true,
        maxHeightCap: props.maxHeightCap,
        portalTopBottomLayout: props.portalTopBottomLayout,
        contentRoom: props.contentRoom,
    });
    // On web, agent-input popovers should be constrained to the viewport (not to an in-modal boundary
    // provider), so they can extend outside sheet-like modal cards.
    const boundaryRef =
        Platform.OS === 'web' && props.boundaryRef === undefined
            ? null
            : props.boundaryRef;
    // Native popovers render through the overlay portal host, outside the composer's subtree, so the
    // composer's browse hand-off is read here and provided again inside the portalled content.
    const modelSourceBrowseHandoff = React.useContext(SessionModelSourceBrowseHandoffContext);
    // A picker opened from a + menu row is that row's submenu. The popover's own dismissals (Escape, an
    // outside press, the sheet's close) return to the menu; a choice made in the content (its own
    // `onRequestClose`) closes both.
    const submenu = React.useContext(AgentInputActionMenuSubmenuContext);
    const { onRequestClose, anchorRef } = props;
    const requestPopoverClose = React.useMemo(() => submenu ? () => {
        submenu.returnToMenu();
        onRequestClose();
    } : onRequestClose, [onRequestClose, submenu]);
    // Left from inside the submenu returns to its row, unless the content used the key (a field's caret,
    // a list stepping back).
    const handleSubmenuKeyDown = React.useCallback((event: unknown) => {
        handleSubmenuBackKey(event, () => {
            requestPopoverClose();
            anchorRef.current?.focus?.();
        });
    }, [anchorRef, requestPopoverClose]);
    return (
        <Popover
            open={props.open}
            // A submenu takes focus as it opens, like the shared dropdown's, so Left and Escape work from inside it.
            autoFocusOnOpen={props.autoFocusOnOpen ?? (submenu ? true : undefined)}
            layer={props.layer}
            anchorRef={props.anchorRef}
            // IMPORTANT:
            // Forward `undefined` so Popover can fall back to PopoverBoundaryProvider context.
            // Passing `null` explicitly disables boundary clamping/measurement, which breaks
            // new-session popover anchoring on native where we rely on a scroll boundary.
            boundaryRef={boundaryRef}
            placement={popoverLayout.placement}
            gap={popoverLayout.gap}
            maxHeightCap={popoverLayout.maxHeightCap}
            maxWidthCap={props.maxWidthCap}
            placementMinSpace={popoverLayout.placementMinSpace}
            flip={popoverLayout.flip}
            horizontalBoundaryRef={popoverLayout.horizontalBoundaryRef}
            // A + menu row's picker is a sheet on a phone, so it pushes inside the menu's sheet.
            phonePresentation={submenu ? 'sheet' : props.phonePresentation}
            sheetHeader={props.sheetHeader}
            sheetSubtitle={props.sheetSubtitle}
            sheetHeaderAction={props.sheetHeaderAction}
            accessibilityLabel={props.accessibilityLabel ?? submenu?.title}
            edgePadding={popoverLayout.edgePadding}
            closeOnAnchorPress={false}
            // IMPORTANT:
            // Do not force portaling to `document.body`. In Expo Router web modals, Radix focus/pointer
            // management will block interaction with inputs rendered outside the modal subtree.
            // Let Popover pick the best target (screen-local modal host from PopoverPortalTargetProvider).
            portal={popoverLayout.portal}
            onRequestClose={requestPopoverClose}
            consumeOutsidePointerDown={false}
            // On web, agent input popovers must NOT block outside pointer events: users should be
            // able to switch between chips in one click (no "click outside to close first").
            // Click-through prevention is handled at the selection layer by deferring popover
            // closure until after the click event completes.
            backdrop={{
                style: { backgroundColor: 'transparent' },
                blockOutsidePointerEvents: Platform.OS === 'web' ? false : 'above-anchor',
            }}
            containerStyle={{ paddingHorizontal: 0 }}
            keyboardBottomInset={popoverLayout.keyboardBottomInset}
        >
            {({ maxHeight, presentation }) => {
                const content = props.children({
                    maxHeight,
                    presentation: presentation === 'sheet' ? 'sheet' : 'popover',
                    ...(submenu ? { dismiss: requestPopoverClose } : {}),
                });
                return (
                    <SessionModelSourceBrowseHandoffContext.Provider value={modelSourceBrowseHandoff}>
                        {submenu && Platform.OS === 'web' && presentation !== 'sheet' ? (
                            <View
                                testID="agent-input-submenu-surface"
                                onPointerEnter={(event: unknown) => submenu.onSurfacePointerChange(true, event)}
                                onPointerLeave={(event: unknown) => submenu.onSurfacePointerChange(false, event)}
                                // react-native-web forwards key events on a View; RN's ViewProps does not declare them.
                                {...{ onKeyDown: handleSubmenuKeyDown }}
                            >
                                {content}
                            </View>
                        ) : content}
                    </SessionModelSourceBrowseHandoffContext.Provider>
                );
            }}
        </Popover>
    );
}

export function AgentInputSelectionPopover(props: AgentInputSelectionPopoverProps) {
    if (!props.open) return null;
    return <OpenAgentInputSelectionPopover {...props} />;
}
