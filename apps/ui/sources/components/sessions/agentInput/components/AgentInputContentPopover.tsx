import * as React from 'react';

import type { FloatingOverlayEdgeFades } from '@/components/ui/overlays/FloatingOverlay';
import type { ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';

import { AgentInputPopoverSurface } from './AgentInputPopoverSurface';

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
    return (
        <AgentInputSelectionPopover
            open={props.open}
            anchorRef={props.anchorRef}
            boundaryRef={props.boundaryRef}
            maxHeightCap={props.maxHeightCap ?? 420}
            maxWidthCap={props.maxWidthCap ?? 420}
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
