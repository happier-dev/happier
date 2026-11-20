import * as React from 'react';

export type ShellCornerDoor = Readonly<{
  testID: string;
  label: string;
  onPress?: () => void;
}>;

type ShellCornerSlot = (door: ShellCornerDoor | null) => void;

/** The page's top-right corner on a computer, provided by `WorkflowPanel`; absent on a phone. */
export const ShellCornerContext = React.createContext<ShellCornerSlot | null>(
  null,
);

const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * Direction A puts the welcome's "Run your own Home" door in the page's top-right corner on a computer (lab
 * `final/shots/open-mac-welcome-*`) and under the column on a phone. The welcome step hands its door to the shell
 * here; returns whether the shell placed it, so the step draws it in its column otherwise.
 */
export function useShellCornerDoor(door: ShellCornerDoor | null): boolean {
  const slot = React.useContext(ShellCornerContext);
  const onPress = React.useRef(door?.onPress);
  onPress.current = door?.onPress;
  const testID = door?.testID ?? null;
  const label = door?.label ?? null;
  const interactive = door?.onPress !== undefined;
  useIsomorphicLayoutEffect(() => {
    if (!slot || testID === null || label === null) return undefined;
    slot({ testID, label, onPress: interactive ? () => onPress.current?.() : undefined });
    return () => slot(null);
  }, [interactive, slot, testID, label]);
  return slot !== null && door !== null;
}
