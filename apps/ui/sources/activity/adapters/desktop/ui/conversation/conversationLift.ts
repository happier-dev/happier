import * as React from 'react';

import {
  captureElementFlightRect,
  type WindowFlightRect,
} from '@/components/ui/motion/rectFlight';

/**
 * The pressed row lifting into the conversation's header (lab `ntshape` C): a row press records where it
 * stood, and the header that opens for that same Session plays one flight from there. Anything else (a face
 * press, a pin from main, a stale press for another Session) finds nothing and the header simply appears.
 */
export type DesktopActivityOverlayConversationLift = Readonly<{
  capture: (sessionId: string, element: unknown) => void;
  take: (sessionId: string) => WindowFlightRect | null;
}>;

export const DesktopActivityOverlayConversationLiftContext =
  React.createContext<DesktopActivityOverlayConversationLift | null>(null);

/** One recorded press for the island; it is read once and cleared, so it never replays. */
export function useDesktopActivityOverlayConversationLift(): DesktopActivityOverlayConversationLift {
  const pressed = React.useRef<Readonly<{
    sessionId: string;
    rect: WindowFlightRect;
  }> | null>(null);
  return React.useMemo(
    () => ({
      capture: (sessionId, element) => {
        pressed.current = isFlightElement(element)
          ? { sessionId, rect: captureElementFlightRect(element) }
          : null;
      },
      take: (sessionId) => {
        const press = pressed.current;
        pressed.current = null;
        return press?.sessionId === sessionId ? press.rect : null;
      },
    }),
    [],
  );
}

function isFlightElement(element: unknown): element is HTMLElement {
  return (
    typeof element === 'object' &&
    element !== null &&
    typeof (element as { getBoundingClientRect?: unknown })
      .getBoundingClientRect === 'function'
  );
}
