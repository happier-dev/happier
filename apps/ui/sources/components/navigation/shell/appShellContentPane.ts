import * as React from 'react';
import type { View } from 'react-native';

/**
 * The shell's page sheet and the radius of its corners. A route presented over the shell (the floating New
 * Session composer is a transparent modal) spans the whole window, so a surface that must stay inside the page
 * measures this sheet rather than its own view, and is clipped to its corners. Null outside the app shell.
 */
export type AppShellContentPane = Readonly<{
  ref: React.RefObject<View | null>;
  radius: number;
  /** Sheet layout wakes the existing measurement owner; no rectangle is retained here. */
  subscribeLayout: (listener: () => void) => () => void;
}>;

export const AppShellContentPaneContext = React.createContext<AppShellContentPane | null>(null);

export function useAppShellContentPane(): AppShellContentPane | null {
  return React.useContext(AppShellContentPaneContext);
}
