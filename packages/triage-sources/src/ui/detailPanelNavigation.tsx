import * as React from 'react';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { resolveTriageCrossCopyContext } from './crossCopyContext.js';

export type TriageDetailFixPullRequestNavigationV1 = Readonly<{
  entryRef: TriageEntryRefV1;
  title: string;
  url: string | null;
  open(options?: Readonly<{ signal?: AbortSignal }>): Promise<
    Readonly<{ kind: 'opened' }> | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'refused'; reason: 'invalidSelection' | 'unavailable'; code?: string }>
  >;
  openExternal(): Promise<void>;
}>;

/** The frame offers only an already-resolved primary fix. */
export function useTriageDetailFixPullRequestNavigation(): TriageDetailFixPullRequestNavigationV1 | null {
  return React.useContext(TriageDetailPanelNavigationContext)?.fixPullRequest ?? null;
}

/** Only the association owner can establish that an entry has no linked fix. */
export function useTriageDetailFixPullRequestsEmpty(): boolean {
  return React.useContext(TriageDetailPanelNavigationContext)?.fixPullRequestsEmpty === true;
}

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
  /** The mounted source alone decides its conditional panels from its current detail reads. */
  publishVisiblePanels?(panels: readonly string[] | null): void;
  fixPullRequest?: TriageDetailFixPullRequestNavigationV1;
  /** The fix owner answered with no primary association; navigation readiness is independent. */
  fixPullRequestsEmpty?: boolean;
}>;

/** Publish presentation through the existing frame seam; retirement withdraws this source's answer. */
export function useTriageDetailPanelVisibility(panels: readonly string[] | undefined): void {
  const publish = React.useContext(TriageDetailPanelNavigationContext)?.publishVisiblePanels;
  const current = React.useRef(panels);
  current.current = panels;
  const visibility = JSON.stringify(panels);
  React.useEffect(() => {
    publish?.(current.current ?? null);
  }, [visibility, publish]);
  React.useEffect(() => () => publish?.(null), [publish]);
}

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
  // A source may publish this opener back to its frame as a header action. Keep that
  // callback stable when the frame rebuilds its navigation, while using its latest selection.
  const select = React.useRef(navigation?.select);
  select.current = navigation?.select;
  return React.useMemo(
    () => (offered ? () => { select.current?.(panel); } : undefined),
    [offered, panel],
  );
}
