import * as React from 'react';

/**
 * A view pushed inside an anchored phone popover (a menu row's picker, a dropdown's submenu). The popover has
 * no band of its own, so the floating surface the pushed content draws leads with this view's way back.
 */
export type PhonePushedView = Readonly<{
  /** The pushed view's name beside Back; absent when its content draws its own header. */
  title?: string;
  back: () => void;
}>;

export const PhonePushedViewContext =
  React.createContext<PhonePushedView | null>(null);
