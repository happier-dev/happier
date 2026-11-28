import * as React from 'react';
import { HappierComposerChip, type HappierComposerChipProps } from '@happier-dev/plugin-ui/presentation';

import { NATIVE_ACTION_CHIP_GAP_Y } from '../components/agentInputChromeStyles';
import type { KeyboardCommandId } from '@/keyboard/types';
import { Tooltip } from '@/components/ui/overlays/Tooltip';

type ChipRailHitReach = NonNullable<HappierComposerChipProps['hitReach']>;

/**
 * The composer's chip rails wrap, so any chip may sit beside another and on any wrapped line, and a new
 * session's machine · folder · resume rail sits right under the setup rail. Wrapped lines and the two rails
 * are 1 px apart (web `rowGap`/column gap, native chip `marginBottom`); chips in a line are `columnGap` apart.
 * Each chip's hit area takes half of every real gap, so neighbours meet and never overlap.
 */
export function resolveAgentInputChipRailHitReach(columnGap: number): ChipRailHitReach {
    const sideways = Math.max(0, columnGap) / 2;
    const between = NATIVE_ACTION_CHIP_GAP_Y / 2;
    return { left: sideways, right: sideways, top: between, bottom: between };
}

const AgentInputChipRowReachContext = React.createContext<HappierComposerChipProps['hitReach']>(undefined);

/** The rail's controls (every {@link AgentInputRailChip} and rail control under it) take this reach. */
export function AgentInputChipRowReach(props: Readonly<{
    reach: HappierComposerChipProps['hitReach'];
    children: React.ReactNode;
}>) {
    return <AgentInputChipRowReachContext.Provider value={props.reach}>{props.children}</AgentInputChipRowReachContext.Provider>;
}

/** The reach the enclosing rail declares, for a rail control built on the shared pressable directly. */
export function useAgentInputChipRowReach(): HappierComposerChipProps['hitReach'] {
    return React.useContext(AgentInputChipRowReachContext);
}

/** The composer's rail chip: the shared chip shell with the reach its row declares. */
type AgentInputRailChipProps = HappierComposerChipProps & Readonly<{ shortcutCommandId?: KeyboardCommandId }>;

/** Lets a chip whose label shrinks (the agent chip) still shrink inside its tooltip host. */
const RAIL_CHIP_TOOLTIP_HOST_STYLE = { minWidth: 0, flexShrink: 1 } as const;

export const AgentInputRailChip: React.ForwardRefExoticComponent<
    React.PropsWithoutRef<AgentInputRailChipProps> & React.RefAttributes<unknown>
> = React.forwardRef<unknown, AgentInputRailChipProps>(
    function AgentInputRailChip({ shortcutCommandId, ...props }, ref) {
        const rowReach = useAgentInputChipRowReach();
        // A chip's own bounds narrow its row's: a side it declares wins, the others keep the row's reach.
        const hitReach = typeof props.hitReach === 'object' && typeof rowReach === 'object' ? { ...rowReach, ...props.hitReach } : props.hitReach ?? rowReach;
        // The help text goes through the shared tooltip (which adds the command's current key); a DOM `title` never renders.
        const { title, ...webAttributes } = props.webAttributes ?? {};
        const help = title ?? (shortcutCommandId ? props.accessibilityLabel : undefined);
        const chip = <HappierComposerChip ref={ref} {...props} webAttributes={props.webAttributes ? webAttributes : undefined} hitReach={hitReach} />;
        if (!help) return chip;
        return (
            <Tooltip label={help} shortcutCommandId={shortcutCommandId} focusable={false} hidden={props.accessibilityState?.expanded === true}
                testID={props.testID ? `${props.testID}-help` : undefined} style={RAIL_CHIP_TOOLTIP_HOST_STYLE}>
                {chip}
            </Tooltip>
        );
    },
);
