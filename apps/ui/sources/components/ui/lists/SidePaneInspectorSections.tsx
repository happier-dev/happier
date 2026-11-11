import * as React from 'react';

import { ItemGroupDefaultSurfaceProvider } from './ItemGroup';
import { ListPresentationProvider } from './listPresentation';
import { PageRowDensityProvider } from './useResolvedItemDensity';

/**
 * A side pane's inspector anatomy (Session Info, lab csinfo I2): page sections laid flat on the pane (title,
 * description above, rows and hairlines, no card), small type and inspector-height rows. Session Info and the
 * sections it shares with the Work tab (Triggers) take it from here, so the two sidebars cannot drift apart
 * (owner 2026-11-11 desktop #16).
 */
export function SidePaneInspectorSections(
  props: Readonly<{ children?: React.ReactNode }>,
) {
  return (
    <ListPresentationProvider value="page">
      <PageRowDensityProvider value="inspector">
        <ItemGroupDefaultSurfaceProvider value="flat">
          {props.children}
        </ItemGroupDefaultSurfaceProvider>
      </PageRowDensityProvider>
    </ListPresentationProvider>
  );
}
