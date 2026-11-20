import * as React from 'react';

import type { RelayRetentionDisclosureModel } from './RelayRetentionDisclosure';

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

/** Space the shell actually has above Welcome and below its header. */
export const ShellHeaderClearanceContext = React.createContext(0);

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

/** The Home's data-retention line, which a computer's shell stands in the page's bottom-right corner. */
export type ShellCornerNote = Readonly<{ disclosure: RelayRetentionDisclosureModel; onRetry?: () => void }>;

type ShellCornerNoteSlot = (note: ShellCornerNote | null) => void;

/** The page's bottom-right corner on a computer, provided by `WorkflowPanel`; absent on a phone. */
export const ShellCornerNoteContext = React.createContext<ShellCornerNoteSlot | null>(null);

/**
 * The welcome hands its retention line to the shell's bottom-right corner on a computer (owner 2026-11-20: it crowded
 * the centre above the planet); returns whether the shell placed it, so the step keeps it in its column otherwise.
 */
export function useShellCornerNote(note: ShellCornerNote | null): boolean {
  const slot = React.useContext(ShellCornerNoteContext);
  const onRetry = React.useRef(note?.onRetry);
  onRetry.current = note?.onRetry;
  const kind = note?.disclosure.kind ?? null;
  const summary = note?.disclosure.kind === 'summary' ? note.disclosure.summary : null;
  const retryable = note?.onRetry !== undefined;
  useIsomorphicLayoutEffect(() => {
    if (!slot || kind === null) return undefined;
    slot({
      disclosure: kind === 'summary' ? { kind, summary: summary ?? '' } : { kind: 'unreadable' },
      onRetry: retryable ? () => onRetry.current?.() : undefined,
    });
    return () => slot(null);
  }, [kind, retryable, slot, summary]);
  return slot !== null && note !== null;
}
