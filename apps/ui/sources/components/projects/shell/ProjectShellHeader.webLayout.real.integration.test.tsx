// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

/**
 * The Project header as a browser lays it out in a narrow pane (a 1440 window with a companion open):
 * the selected page stays a named, reachable tab instead of the row collapsing into More alone.
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

installWebLayoutBridge();

const { resolveProjectPageCatalog } = await import('@/components/projects/detail/projectPageCatalog');
const PAGES = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' } })
  .filter(page => page.id !== 'memory');

it.each([510, 606, 1100])(
  'keeps the selected page a named tab a pointer reaches in a %ipx pane',
  async (width) => {
    const { ProjectShellHeader } = await import('./ProjectShellHeader');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <View style={{ width }}>
            <ProjectShellHeader
              projectName="happier-dev"
              activePage="overview"
              pages={PAGES}
              placement={{ items: PAGES, preferences: { orderedIds: [], placements: {} },
                scope: { serverId: 'home', accountId: 'account' }, onChange: () => {} }}
              onSelectPage={() => {}}
              onNewSession={() => {}}
              look={<View testID="look" style={{ width: 28, height: 28 }} />}
              menuActions={[]}
              checkout={{
                machineName: 'NLDW4-5-40-40', machineNameParts: { name: 'NLDW4-5-40-40', hint: null },
                machineIcon: 'desktop',
                branch: null,
                choices: [],
                onSelect: () => {},
              }}
            />
          </View>,
        ),
      );
      const layout = await measureWebLayout(host, {
        viewport: { width, height: 300 },
        settle: (replay) => act(replay),
      });
      const overview = layout.rect('project-shell-header.pages:overview');
      expect(overview.width).toBeGreaterThan(0);
      expect(overview.clipped).toBe(false);
      expect(overview.receivesPointer).toBe(true);
      // The pane holds most pages as named tabs (lab FIT), not the selected one alone beside More.
      const named = PAGES.filter(
        (page) => (layout.rects.get(`project-shell-header.pages:${page.id}`)?.[0]?.width ?? 0) > 0,
      );
      expect(named.length).toBeGreaterThanOrEqual(width < 606 ? 2 : 4);
      // Tabs that do not fit leave for More whole; a name is never cut short in the row.
      for (const page of named) {
        expect(layout.rect(`project-shell-header.pages:${page.id}`).clipped).not.toBe(true);
      }
      if (named.length < PAGES.length) {
        expect(layout.rects.get('project-shell-header.pages.more')?.[0]?.width ?? 0).toBeGreaterThan(0);
      }
      const more = layout.rects.get('project-shell-header.pages.more')?.[0];
      if (more) expect(more.receivesPointer).toBe(true);
      // Every page tab still inside the band, none drawn past its edge.
      const band = layout.rect('project-shell-header');
      expect(overview.right).toBeLessThanOrEqual(band.right);
      // The strip ends at the band: a tab past it runs under whatever sits beside the pane (an open details pane).
      for (const page of named) {
        expect(layout.rect(`project-shell-header.pages:${page.id}`).right).toBeLessThanOrEqual(band.right);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
