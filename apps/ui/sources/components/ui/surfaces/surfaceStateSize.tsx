import type { HappierStateSize } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';

/** A container's state step: one of the sized compositions, or `line` for a narrow column. */
export type SurfaceStateContainerSize = HappierStateSize | 'line';

/**
 * The size step of the state composition, set once by the container that hosts a surface (the right
 * sidebar pane, the details drawer, a phone pane, a widget frame) so every `SurfaceStateCard` inside it
 * takes the container's measure and type without each surface hand-sizing its states. A narrow column
 * (a Companion widget, a Project aside) sets `line`: each state is one line under its header. An
 * explicit `size` on a card still wins; outside any provider the card keeps its unsized centred column.
 */
const SurfaceStateSizeContext = React.createContext<SurfaceStateContainerSize | undefined>(undefined);

/**
 * `quiet`: the container never owns its page's one primary action (a widget card among cards), so every
 * state inside it offers its way forward as the quiet bordered button. Set by the widget frame; a nested
 * container keeps it.
 */
export type SurfaceStateContainerActions = 'quiet';
const SurfaceStateActionsContext = React.createContext<SurfaceStateContainerActions | undefined>(undefined);

/** `size` undefined gives no step (as outside any provider), so a host can switch steps without remounting. */
export function SurfaceStateSizeProvider(props: Readonly<{
    size: SurfaceStateContainerSize | undefined;
    actions?: SurfaceStateContainerActions;
    children: React.ReactNode;
}>) {
    const inheritedActions = React.useContext(SurfaceStateActionsContext);
    return (
        <SurfaceStateActionsContext.Provider value={props.actions ?? inheritedActions}>
            <SurfaceStateSizeContext.Provider value={props.size}>
                {props.children}
            </SurfaceStateSizeContext.Provider>
        </SurfaceStateActionsContext.Provider>
    );
}

/** Whether the enclosing container draws its states' actions quiet (see `SurfaceStateContainerActions`). */
export function useSurfaceStateQuietActions(): boolean {
    return React.useContext(SurfaceStateActionsContext) === 'quiet';
}

/** The enclosing container's sized step (pane, details, page, phone); a line column has none. */
export function useSurfaceStateSize(): HappierStateSize | undefined {
    const size = React.useContext(SurfaceStateSizeContext);
    return size === 'line' ? undefined : size;
}

/** The step a `SurfaceStateCard` takes from its container, including a line column. */
export function useSurfaceStateCardSize(): SurfaceStateContainerSize | undefined {
    return React.useContext(SurfaceStateSizeContext);
}
