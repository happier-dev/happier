import * as React from 'react';
import { HappierComposerChip, type HappierComposerChipProps } from '@happier-dev/plugin-ui/presentation';

import { NATIVE_ACTION_CHIP_GAP_Y } from '../components/agentInputChromeStyles';
import type { KeyboardCommandId } from '@/keyboard/types';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { withShortcut } from '@/keyboard/withShortcut';

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

export const AgentInputRailChip: React.ForwardRefExoticComponent<
    React.PropsWithoutRef<AgentInputRailChipProps> & React.RefAttributes<unknown>
> = React.forwardRef<unknown, AgentInputRailChipProps>(
    function AgentInputRailChip({ shortcutCommandId, ...props }, ref) {
        const rowReach = useAgentInputChipRowReach();
        const shortcut = useKeyboardShortcutLabel(shortcutCommandId);
        // A chip's own bounds narrow its row's: a side it declares wins, the others keep the row's reach.
        const hitReach = typeof props.hitReach === 'object' && typeof rowReach === 'object' ? { ...rowReach, ...props.hitReach } : props.hitReach ?? rowReach;
        const webAttributes = shortcut ? { ...props.webAttributes,
            title: withShortcut(props.webAttributes?.title ?? props.accessibilityLabel ?? '', shortcut) } : props.webAttributes;
        return <HappierComposerChip ref={ref} {...props} webAttributes={webAttributes} hitReach={hitReach} />;
    },
);
