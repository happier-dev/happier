import * as React from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { FloatingOverlayEdgeFades } from '@/components/ui/overlays/FloatingOverlay';
import type { HoverPreviewHandlers } from '@/components/ui/popover/useHoverPreviewPopover';
import type { ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';
import { AgentInputDocumentPanelContext } from '@/components/sessions/agentInput/selection/useAgentInputPopoverLayout';
import { useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';

const MOBILE_WEB_AGENT_INPUT_POPOVER_VIEWPORT_MARGIN = 12;

export type AgentInputContentPopoverRenderArgs = Readonly<{
    requestClose: () => void;
    maxHeight: number;
    /** `sheet`: shown as a phone sheet (no hover). */
    presentation?: 'popover' | 'sheet';
    /**
     * The content is laid out in a page section (the New Session wizard's expanded sections) instead
     * of this popover: it draws page rows and leaves focus alone.
     */
    inline?: boolean;
}>;

export type AgentInputPopoverContent =
    | React.ReactNode
    | ((args: AgentInputContentPopoverRenderArgs) => React.ReactNode);

/** A popover that names itself: its title and one sentence of purpose, above the content. */
export type AgentInputContentPopoverHeader = Readonly<{
    title: string;
    description?: string;
    /** `sheet`: only a phone sheet's band names it; the anchored popover leads with its own first control. */
    placement?: 'sheet';
}>;

export type AgentInputContentPopoverConfig = Readonly<{
    renderContent: AgentInputPopoverContent;
    header?: AgentInputContentPopoverHeader;
    /** `sheet`: a phone presents it as the shared bottom sheet, whose band carries `header`. */
    phonePresentation?: 'sheet';
    /** Invoked before the shared overlay closes so content-owned async work can be invalidated. */
    onRequestClose?: () => void;
    boundaryRef?: React.RefObject<any> | null;
    maxHeightCap?: number;
    maxWidthCap?: number;
    scrollEnabled?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
    edgeFades?: FloatingOverlayEdgeFades;
    edgeIndicators?: boolean | Readonly<{ size?: number; opacity?: number }>;
    initialVisibility?: Partial<ScrollEdgeVisibility>;
}>;

export type AgentInputContentPopoverProps = Readonly<{
    open: boolean;
    /** False for a hover preview, which must not take focus from where the pointer came. */
    autoFocusOnOpen?: boolean;
    /** A hover preview's panel handlers (`useHoverPreviewPopover`), spread on the whole surface. */
    hoverProps?: HoverPreviewHandlers | null;
    /** The hover preview's stacking (`useHoverPreviewPopover`'s `popoverLayer`). */
    layer?: 'hoverCard';
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    content: AgentInputPopoverContent;
    header?: AgentInputContentPopoverHeader;
    phonePresentation?: 'sheet';
    onRequestClose: () => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    testID?: string;
    scrollEnabled?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
    edgeFades?: FloatingOverlayEdgeFades;
    edgeIndicators?: boolean | Readonly<{ size?: number; opacity?: number }>;
    initialVisibility?: Partial<ScrollEdgeVisibility>;
}>;

function renderPopoverContent(
    content: AgentInputPopoverContent,
    args: AgentInputContentPopoverRenderArgs,
): React.ReactNode {
    return typeof content === 'function' ? content(args) : content;
}

export function AgentInputContentPopover(props: AgentInputContentPopoverProps) {
    const { width: windowWidth } = useWindowDimensions();
    const usesMobileWebBoundaryLayout = Platform.OS === 'web' && isMobileLayoutWidth(windowWidth);
    // A form's picker opened inside a floating form (Run now) spans the form's own column: it covers
    // the form below its chips edge to edge instead of leaving a clipped sliver of the form's footer
    // beside it. Its content restates what that footer said (the Inputs view leads with readiness).
    const inDocumentPanel = React.useContext(AgentInputDocumentPanelContext);
    const containingSurfaceGroup = useContainingGlassSurfaceGroup();
    const spansFloatingFormColumn = inDocumentPanel && containingSurfaceGroup === 'floating';
    const maxWidthCap = React.useMemo(() => {
        const baseMaxWidthCap = spansFloatingFormColumn ? Number.MAX_SAFE_INTEGER : props.maxWidthCap ?? 420;
        if (!usesMobileWebBoundaryLayout) {
            return baseMaxWidthCap;
        }

        return Math.max(
            baseMaxWidthCap,
            Math.max(0, Math.floor(windowWidth - MOBILE_WEB_AGENT_INPUT_POPOVER_VIEWPORT_MARGIN * 2)),
        );
    }, [props.maxWidthCap, spansFloatingFormColumn, usesMobileWebBoundaryLayout, windowWidth]);
    // The header sits outside the content's own height budget, so the content keeps what is left.
    const [headerHeight, setHeaderHeight] = React.useState(0);

    return (
        <AgentInputSelectionPopover
            open={props.open}
            autoFocusOnOpen={props.autoFocusOnOpen}
            layer={props.layer}
            anchorRef={props.anchorRef}
            boundaryRef={props.boundaryRef}
            maxHeightCap={props.maxHeightCap ?? 420}
            maxWidthCap={maxWidthCap}
            portalTopBottomLayout={usesMobileWebBoundaryLayout || spansFloatingFormColumn ? 'boundary' : undefined}
            phonePresentation={props.phonePresentation}
            // A titled popover names itself in the sheet's band; an untitled one (the machine list, led by
            // its own search) keeps only the grabber instead of an empty band with a lone close button.
            sheetHeader={props.header ? 'band' : 'none'}
            accessibilityLabel={props.header?.title}
            sheetSubtitle={props.header?.description}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight, presentation }) => {
                // On a phone sheet the shared band already shows the title and purpose.
                const header = presentation === 'sheet' || props.header?.placement === 'sheet' ? undefined : props.header;
                const contentMaxHeight = header ? Math.max(0, maxHeight - headerHeight) : maxHeight;
                return (
                <AgentInputPopoverSurface
                    testID={props.testID ?? 'agent-input-content-popover'}
                    maxHeight={maxHeight}
                    scrollEnabled={props.scrollEnabled ?? true}
                    keyboardShouldPersistTaps={props.keyboardShouldPersistTaps}
                    edgeFades={props.edgeFades}
                    edgeIndicators={props.edgeIndicators}
                    initialVisibility={props.initialVisibility}
                    hoverProps={props.hoverProps}
                >
                    {header ? (
                        <View
                            testID="agent-input-content-popover.header"
                            style={styles.header}
                            onLayout={(event) => {
                                const height = Math.round(event.nativeEvent.layout.height);
                                setHeaderHeight((current) => current === height ? current : height);
                            }}
                        >
                            <Text accessibilityRole="header" style={styles.title}>{header.title}</Text>
                            {header.description ? <Text style={styles.description}>{header.description}</Text> : null}
                        </View>
                    ) : null}
                    {renderPopoverContent(props.content, {
                        requestClose: props.onRequestClose,
                        maxHeight: contentMaxHeight,
                        presentation,
                    })}
                </AgentInputPopoverSurface>
                );
            }}
        </AgentInputSelectionPopover>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: {
        gap: theme.space.s2,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
