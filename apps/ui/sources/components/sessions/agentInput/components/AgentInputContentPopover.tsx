import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import type { FloatingOverlayEdgeFades } from '@/components/ui/overlays/FloatingOverlay';
import type { ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';

import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';

const MOBILE_WEB_AGENT_INPUT_POPOVER_VIEWPORT_MARGIN = 12;

export type AgentInputContentPopoverRenderArgs = Readonly<{
    requestClose: () => void;
    maxHeight: number;
}>;

export type AgentInputPopoverContent =
    | React.ReactNode
    | ((args: AgentInputContentPopoverRenderArgs) => React.ReactNode);

export type AgentInputContentPopoverConfig = Readonly<{
    renderContent: AgentInputPopoverContent;
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
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    content: AgentInputPopoverContent;
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
    const maxWidthCap = React.useMemo(() => {
        const baseMaxWidthCap = props.maxWidthCap ?? 420;
        if (!usesMobileWebBoundaryLayout) {
            return baseMaxWidthCap;
        }

        return Math.max(
            baseMaxWidthCap,
            Math.max(0, Math.floor(windowWidth - MOBILE_WEB_AGENT_INPUT_POPOVER_VIEWPORT_MARGIN * 2)),
        );
    }, [props.maxWidthCap, usesMobileWebBoundaryLayout, windowWidth]);

    return (
        <AgentInputSelectionPopover
            open={props.open}
            anchorRef={props.anchorRef}
            boundaryRef={props.boundaryRef}
            maxHeightCap={props.maxHeightCap ?? 420}
            maxWidthCap={maxWidthCap}
            portalTopBottomLayout={usesMobileWebBoundaryLayout ? 'boundary' : undefined}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight }) => (
                <AgentInputPopoverSurface
                    testID={props.testID ?? 'agent-input-content-popover'}
                    maxHeight={maxHeight}
                    scrollEnabled={props.scrollEnabled ?? true}
                    keyboardShouldPersistTaps={props.keyboardShouldPersistTaps}
                    edgeFades={props.edgeFades}
                    edgeIndicators={props.edgeIndicators}
                    initialVisibility={props.initialVisibility}
                >
                    {renderPopoverContent(props.content, {
                        requestClose: props.onRequestClose,
                        maxHeight,
                    })}
                </AgentInputPopoverSurface>
            )}
        </AgentInputSelectionPopover>
    );
}
