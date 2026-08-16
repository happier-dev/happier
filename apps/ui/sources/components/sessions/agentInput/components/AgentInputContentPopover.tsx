import * as React from 'react';
import { View } from 'react-native';

import {
    ListMotionQuietProvider,
    useListMotionQuiet,
} from '@/components/sessions/agentActivity/list/listMotionQuiet';
import type { FloatingOverlayEdgeFades } from '@/components/ui/overlays/FloatingOverlay';
import type { ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';

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
    /**
     * U-4: opt-in bottom keyboard inset. Only popovers that host a focused field (goal objective
     * textarea / budget input) request this; other consumers must not reserve the inset or they gain
     * dead bottom-scroll space whenever the composer keyboard happens to be up. Web is unaffected
     * (`useKeyboardHeight` returns 0 on web).
     */
    reserveKeyboardInset?: boolean;
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
    reserveKeyboardInset?: boolean;
}>;

function renderPopoverContent(
    content: AgentInputPopoverContent,
    args: AgentInputContentPopoverRenderArgs,
): React.ReactNode {
    return typeof content === 'function' ? content(args) : content;
}

export function AgentInputContentPopover(props: AgentInputContentPopoverProps) {
    // U-4: reserve a bottom inset equal to the settled keyboard height so a focused field inside the
    // popover (e.g. the goal objective textarea) can scroll clear of the on-screen keyboard instead
    // of being occluded. Opt-in per consumer (`reserveKeyboardInset`) so info/picker popovers that
    // never host a focused field don't gain dead bottom-scroll space. Passive, non-frame-critical
    // layout — the canonical use of `useKeyboardHeight` (web returns 0). The scroll surface owns the
    // actual scroll.
    const keyboardHeight = useKeyboardHeight();
    const keyboardInset = props.reserveKeyboardInset ? keyboardHeight : 0;
    /**
     * This popover's scroller, published to whatever it is showing.
     *
     * The content is a node handed in by a caller, so a list inside it has no way to learn that the
     * surface around it is being flicked — and a list that re-groups itself mid-scroll moves rows
     * under the finger doing the scrolling. The pane hands its own window to the roster directly;
     * this is the same window for the hosts whose scroller is this shared surface. Cheap enough to
     * create unconditionally: an object and, only while a flick is in flight, one timer.
     */
    const listMotion = useListMotionQuiet();
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
                    onScroll={listMotion.scrollProps.onScroll}
                >
                    <ListMotionQuietProvider quiet={listMotion.quiet}>
                        {renderPopoverContent(props.content, {
                            requestClose: props.onRequestClose,
                            maxHeight,
                        })}
                    </ListMotionQuietProvider>
                    {keyboardInset > 0 ? (
                        <View testID="agent-input-popover-keyboard-inset" style={{ height: keyboardInset }} />
                    ) : null}
                </AgentInputPopoverSurface>
            )}
        </AgentInputSelectionPopover>
    );
}
