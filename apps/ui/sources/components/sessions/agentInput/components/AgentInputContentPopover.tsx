import * as React from 'react';

import { Popover } from '@/components/ui/popover';
import type { FloatingOverlayEdgeFades } from '@/components/ui/overlays/FloatingOverlay';
import type { ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';

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
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            boundaryRef={null}
            placement="top"
            gap={8}
            maxHeightCap={props.maxHeightCap ?? 420}
            maxWidthCap={props.maxWidthCap ?? 420}
            closeOnAnchorPress={false}
            portal={{
                web: { target: 'body' },
                native: true,
                matchAnchorWidth: false,
                anchorAlign: 'start',
            }}
            onRequestClose={props.onRequestClose}
            backdrop={{ style: { backgroundColor: 'transparent' } }}
            containerStyle={{ paddingHorizontal: 0 }}
        >
            {({ maxHeight }) => (
                <AgentInputPopoverSurface
                    testID={props.testID ?? 'agent-input-content-popover'}
                    maxHeight={maxHeight}
                    scrollEnabled={props.scrollEnabled ?? false}
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
        </Popover>
    );
}
