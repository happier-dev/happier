import * as React from 'react';
import { Platform } from 'react-native';

import { CommandMenu, type CommandMenuProps } from '@/components/ui/commandMenu';
import { useAgentInputPopoverLayout } from '@/components/sessions/agentInput/selection/useAgentInputPopoverLayout';

const AGENT_INPUT_COMMAND_MENU_EDGE_PADDING = { horizontal: 16 } as const;
const AGENT_INPUT_COMMAND_MENU_CONTAINER_STYLE = { paddingHorizontal: 0 } as const;
const AGENT_INPUT_COMMAND_MENU_WEB_BACKDROP = {
    style: { backgroundColor: 'transparent' },
    blockOutsidePointerEvents: false,
} as const;
const AGENT_INPUT_COMMAND_MENU_NATIVE_BACKDROP = {
    style: { backgroundColor: 'transparent' },
    blockOutsidePointerEvents: 'above-anchor',
} as const;

function resolveBoundaryRef(props: CommandMenuProps): CommandMenuProps['boundaryRef'] {
    return Platform.OS === 'web' && props.boundaryRef === undefined
        ? null
        : props.boundaryRef;
}

function resolveBackdrop(props: CommandMenuProps): CommandMenuProps['backdrop'] {
    return props.backdrop ?? (
        Platform.OS === 'web'
            ? AGENT_INPUT_COMMAND_MENU_WEB_BACKDROP
            : AGENT_INPUT_COMMAND_MENU_NATIVE_BACKDROP
    );
}

function ClosedAgentInputCommandMenu(props: CommandMenuProps) {
    return (
        <CommandMenu
            {...props}
            boundaryRef={resolveBoundaryRef(props)}
            edgePadding={props.edgePadding ?? AGENT_INPUT_COMMAND_MENU_EDGE_PADDING}
            backdrop={resolveBackdrop(props)}
            consumeOutsidePointerDown={props.consumeOutsidePointerDown ?? false}
            containerStyle={props.containerStyle ?? AGENT_INPUT_COMMAND_MENU_CONTAINER_STYLE}
        />
    );
}

function OpenAgentInputCommandMenu(props: CommandMenuProps) {
    const popoverLayout = useAgentInputPopoverLayout({
        open: true,
        maxHeightCap: props.maxHeight,
    });

    return (
        <CommandMenu
            {...props}
            maxHeight={popoverLayout.maxHeightCap ?? props.maxHeight}
            placement={props.placement ?? popoverLayout.placement}
            gap={props.gap ?? popoverLayout.gap}
            boundaryRef={resolveBoundaryRef(props)}
            keyboardBottomInset={props.keyboardBottomInset ?? popoverLayout.keyboardBottomInset}
            edgePadding={props.edgePadding ?? popoverLayout.edgePadding}
            backdrop={resolveBackdrop(props)}
            consumeOutsidePointerDown={props.consumeOutsidePointerDown ?? false}
            containerStyle={props.containerStyle ?? AGENT_INPUT_COMMAND_MENU_CONTAINER_STYLE}
        />
    );
}

export function AgentInputCommandMenu(props: CommandMenuProps) {
    if (!props.open) {
        return <ClosedAgentInputCommandMenu {...props} />;
    }
    return <OpenAgentInputCommandMenu {...props} />;
}
