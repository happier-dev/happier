import * as React from 'react';

import { resolveTriageCrossCopyContext } from './crossCopyContext.js';

/**
 * The child-to-parent half of the Triage detail frame's panel selection.
 *
 * In a framed detail the tab strip belongs to Triage, and the source renders one panel
 * at a time. A source control that points at a sibling panel ("Stack trace" under the
 * occurrence in Overview) therefore asks the frame's own selection owner rather than
 * keeping a second tab state. `panels` are the ids the frame currently offers, so a
 * source never draws a control whose press would select nothing.
 */
export type TriageDetailPanelNavigationV1 = Readonly<{
  panels: readonly string[];
  select(panel: string): void;
}>;

/**
 * The parent installing this seam and the source reading it are separate plugin
 * artifacts, each with its own bundled copy of this module, so the context object
 * itself is agreed across copies. See `crossCopyContext.ts`.
 */
const TRIAGE_DETAIL_PANEL_NAVIGATION_CONTEXT_KEY = Symbol.for(
  'happier.triageSources.privateDetailPanelNavigationContext.v1',
);

const TriageDetailPanelNavigationContext = resolveTriageCrossCopyContext<TriageDetailPanelNavigationV1 | null>(
  TRIAGE_DETAIL_PANEL_NAVIGATION_CONTEXT_KEY,
  null,
);

export function TriageDetailPanelNavigationProvider(props: Readonly<{
  navigation: TriageDetailPanelNavigationV1;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <TriageDetailPanelNavigationContext.Provider value={props.navigation}>
      {props.children}
    </TriageDetailPanelNavigationContext.Provider>
  );
}

/** Opens `panel` through the frame, or `undefined` when no frame offers that panel. */
export function useTriageDetailPanelOpener(panel: string): (() => void) | undefined {
  const navigation = React.useContext(TriageDetailPanelNavigationContext);
  const offered = navigation !== null && navigation.panels.includes(panel);
  const select = navigation?.select;
  return React.useMemo(
    () => (offered && select !== undefined ? () => { select(panel); } : undefined),
    [offered, panel, select],
  );
}
