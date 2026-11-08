import { createContext, useContext, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import { HappierRowActionRevealSlot } from './RowActionRevealSlot.js';

const RowInteractionContext = createContext<Readonly<{ hovered: boolean; actionsRevealed: boolean | null }>>({
  hovered: false, actionsRevealed: null,
});

/** Owns the existing row frame's pointer state; its content does not depend on pointer movement. */
export function ListItemFrame({ hoverEnabled, hoverFill, restingFill, actionsRevealed, overrideStyle, ...props }:
  ComponentProps<typeof View> & Readonly<{
    hoverEnabled: boolean;
    hoverFill?: string;
    restingFill?: string;
    actionsRevealed: boolean | null;
    overrideStyle?: HappierStyleProp;
  }>): ReactElement {
  const [hovered, setHovered] = useState(false);
  return <RowInteractionContext.Provider value={{
    hovered,
    actionsRevealed: actionsRevealed === null ? null : actionsRevealed || hovered,
  }}>
    <View {...props} {...(hoverEnabled ? {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    } : {})} style={[
      props.style,
      restingFill === undefined ? undefined : { backgroundColor: hovered && hoverFill !== undefined ? hoverFill : restingFill },
      overrideStyle,
    ]} />
  </RowInteractionContext.Provider>;
}

/** A precise pointer reveals the row's overflow without rebuilding its content. */
export function HappierRowActionsReveal(props: Readonly<{ children: ReactNode }>): ReactElement {
  const { actionsRevealed } = useContext(RowInteractionContext);
  return actionsRevealed === null ? <>{props.children}</>
    : <HappierRowActionRevealSlot revealed={actionsRevealed}>{props.children}</HappierRowActionRevealSlot>;
}

export function ListItemOverlayActions(props: Readonly<{ held: boolean; precisePointer: boolean; children: ReactNode }>): ReactElement {
  const { hovered } = useContext(RowInteractionContext);
  return <HappierRowActionRevealSlot revealed={props.held || (props.precisePointer && hovered)}>
    {props.children}
  </HappierRowActionRevealSlot>;
}
