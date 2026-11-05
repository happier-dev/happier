import * as React from 'react';

/**
 * Where the open right pane presents its tab: in the side column, or inside the session column over
 * the transcript, beside the composer (lab ade-shell AR1 EFv). The tab catalog decides it
 * (`resolveRightSidebarTabPlacement`); the scope host only lays its columns out from the answer.
 */
export type RightPanePlacement = 'side' | 'main';

/** One retained body; changing columns changes its layout, never its mounted identity. */
export type RightPaneSurface = Readonly<{
  id: string;
  content: React.ReactNode;
  placement: RightPanePlacement | 'hidden';
}>;

export type RightPanePresentation = RightPanePlacement | Readonly<{
  surfaces: readonly RightPaneSurface[];
  sideVisible: boolean;
  onCloseMainSurface?: () => void;
}>;

export const RightPanePlacementReporterContext = React.createContext<
  ((placement: RightPanePresentation) => void) | null
>(null);

/** The right pane's catalog owner publishes its open tab's placement to the enclosing scope host. */
export function useReportRightPanePlacement(
  placement: RightPanePresentation,
): void {
  const report = React.useContext(RightPanePlacementReporterContext);
  React.useLayoutEffect(() => {
    report?.(placement);
  }, [placement, report]);
  React.useLayoutEffect(() => () => report?.('side'), [report]);
}
