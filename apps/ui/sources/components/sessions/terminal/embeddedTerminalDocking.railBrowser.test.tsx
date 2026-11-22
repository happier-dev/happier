import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import {
  useAppPaneScope,
  type AppPaneScopeApi,
} from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PaneRegionProvider } from '@/components/appShell/panes/paneRegion';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import {
  PANE_SIZING_DEFAULTS,
  resolveDockedPaneSizing,
} from '@/components/appShell/panes/layout/paneSizing';

import { openEmbeddedToolInDockLocation } from './embeddedTerminalDocking';

/** The Session's side column (Info) holds the pane API the rail's Browser launcher uses, as `SessionRightPanel` does. */
function SideColumn(props: Readonly<{ pane: { current?: AppPaneScopeApi }; openedFrom: { current?: string | null } }>) {
  props.pane.current = useAppPaneScope('session:rail-browser');
  // The opener region the columns host lays Details out from (`AppPaneScopeHost` reads this same fact).
  props.openedFrom.current = useAppPaneContext(value => value.state.scopes['session:rail-browser']?.details.openedFrom ?? null);
  return null;
}

describe('a Browser launched from the Session rail beside Info (DESIGN-ACCEPT-142 item 5)', () => {
  it('docks beside a chat that keeps its minimum width, never a drawer leaving the chat 32 px at 1440', async () => {
    const pane: { current?: AppPaneScopeApi } = {};
    const openedFrom: { current?: string | null } = {};
    const screen = await renderScreen(
      <AppPaneProvider>
        <PaneRegionProvider region="side">
          <SideColumn pane={pane} openedFrom={openedFrom} />
        </PaneRegionProvider>
      </AppPaneProvider>,
    );
    try {
      await act(async () => pane.current!.openRight({ tabId: 'info' }));
      await act(async () =>
        openEmbeddedToolInDockLocation({
          pane: pane.current!,
          tool: 'browser',
        }),
      );
      // A 1440 window: the columns host gets 1012 px beside the sidebar and the rail; Info asks 380, Browser 600.
      const input = {
        containerWidthPx: 1012,
        deviceType: 'tablet',
        multiPaneEnabled: true,
        rightOpen: true,
        detailsOpen: true,
        detailsOpenedFrom: (openedFrom.current ?? null) as 'main' | 'side' | null,
        mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
        mainMinPxThreePane: PANE_SIZING_DEFAULTS.mainMinThreePanePx,
        rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        rightPreferredPx: 380,
        detailsPreferredPx: 600,
      } as const;
      const layout = resolvePaneLayout(input);
      expect(layout.details).toBe('docked');
      const sizing = resolveDockedPaneSizing({
        containerWidthPx: input.containerWidthPx,
        mainMinPx: input.mainMinPx,
        rightMinPx: input.rightMinPx,
        detailsMinPx: input.detailsMinPx,
        rightWidthPx: 380,
        detailsWidthPx: 600,
        rightGlobalMinPx: input.rightMinPx,
        rightGlobalMaxPx: PANE_SIZING_DEFAULTS.right.maxPx,
        detailsGlobalMinPx: input.detailsMinPx,
        detailsGlobalMaxPx: PANE_SIZING_DEFAULTS.details.maxPx,
        rightDocked: layout.right === 'docked',
        detailsDocked: true,
      });
      const chatWidth =
        input.containerWidthPx -
        (layout.right === 'docked' ? sizing.rightWidthPx : 0) -
        sizing.detailsWidthPx;
      expect(chatWidth).toBeGreaterThanOrEqual(input.mainMinPx);
    } finally {
      await screen.unmount();
    }
  });
});
