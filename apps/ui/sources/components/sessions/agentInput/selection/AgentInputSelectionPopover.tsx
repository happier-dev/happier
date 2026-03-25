import * as React from 'react';

import { Platform } from 'react-native';
import { Popover } from '@/components/ui/popover';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';

export type AgentInputSelectionPopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    onRequestClose: () => void;
    maxHeightCap?: number;
    maxWidthCap?: number;
    children: (args: Readonly<{ maxHeight: number }>) => React.ReactNode;
}>;

export function AgentInputSelectionPopover(props: AgentInputSelectionPopoverProps) {
    return (
        <Popover
            open={props.open}
            anchorRef={props.anchorRef}
            // IMPORTANT:
            // Forward `undefined` so Popover can fall back to PopoverBoundaryProvider context.
            // Passing `null` explicitly disables boundary clamping/measurement, which breaks
            // new-session popover anchoring on native where we rely on a scroll boundary.
            boundaryRef={props.boundaryRef}
            placement="top"
            gap={8}
            maxHeightCap={props.maxHeightCap}
            maxWidthCap={props.maxWidthCap}
            edgePadding={{ horizontal: 16 }}
            closeOnAnchorPress={false}
            portal={{
                // IMPORTANT:
                // Do not force portaling to `document.body`. In Expo Router web modals, Radix focus/pointer
                // management will block interaction with inputs rendered outside the modal subtree.
                // Let Popover pick the best target (screen-local modal host from PopoverPortalTargetProvider).
                web: true,
                native: true,
                matchAnchorWidth: false,
                anchorAlign: 'start',
            }}
            onRequestClose={props.onRequestClose}
            backdrop={{ style: { backgroundColor: 'transparent' } }}
            containerStyle={{ paddingHorizontal: 0 }}
        >
            {({ maxHeight }) => (
                <AgentInputNestedPortalScope>
                    {props.children({ maxHeight })}
                </AgentInputNestedPortalScope>
            )}
        </Popover>
    );
}

function AgentInputNestedPortalScope(props: { children: React.ReactNode }) {
    const [target, setTarget] = React.useState<HTMLElement | null>(null);
    const setTargetRef = React.useCallback((node: HTMLElement | null) => {
        setTarget((prev) => (prev === node ? prev : node));
    }, []);

    if (Platform.OS !== 'web') {
        return props.children;
    }

    return (
        <ModalPortalTargetProvider target={target}>
            <>
                {props.children}
                <div
                    data-happy-agent-input-popover-portal-target=""
                    ref={setTargetRef}
                    style={{
                        position: 'absolute',
                        top: '0px',
                        left: '0px',
                        width: '0px',
                        height: '0px',
                        overflow: 'visible',
                        pointerEvents: 'auto',
                    }}
                />
            </>
        </ModalPortalTargetProvider>
    );
}
