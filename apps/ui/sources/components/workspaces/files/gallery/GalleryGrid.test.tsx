import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { groupGalleryMedia } from '@/hooks/workspaces/files/gallery/galleryModel';
import { classifyGalleryFile } from '@/hooks/workspaces/files/gallery/galleryModel';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>(),
    renderItems: true,
  }).module;
});

const { GalleryGrid, GalleryFootLine } = await import('./GalleryGrid');
const { HappierUiEnvironmentProvider, projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
const environment = projectHappierUiEnvironment(createSurfaceContextFixture());
/** The shared media tiles read the host's UI environment, as every core surface provides at its root. */
const inUi = (element: React.ReactElement) => <HappierUiEnvironmentProvider environment={environment}>{element}</HappierUiEnvironmentProvider>;

const scope = { serverId: 'server', machineId: 'machine', rootPath: '/repo' };
const day = (date: string, hour: number) =>
  new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime();
const files = [
  { name: 'before.png', modifiedMs: day('2026-11-20', 9) },
  { name: 'after.png', modifiedMs: day('2026-11-20', 10) },
  { name: 'flow.mov', modifiedMs: day('2026-11-14', 9) },
  { name: 'phone.png', modifiedMs: day('2026-11-14', 8) },
];
const { sections, items } = groupGalleryMedia(
  files.map((file) =>
    classifyGalleryFile(
      { ...file, path: `shots/${file.name}`, sizeBytes: 10 },
      scope,
      'folder',
    )!,
  ),
);

async function layout(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  width: number,
) {
  const root = screen.findAll(
    (node) => typeof node.props.onLayout === 'function',
  )[0]!;
  await act(async () =>
    root.props.onLayout({
      nativeEvent: { layout: { width, height: 800, x: 0, y: 0 } },
    }),
  );
}

describe('gallery body (lab pr974 SG1)', () => {
  it('draws folders first, then days newest first, and a tile opens the stage at its place in the whole gallery', async () => {
    const onOpenItem = vi.fn();
    const onOpenFolder = vi.fn();
    const screen = await renderScreen(inUi(<GalleryGrid
        folders={[{ name: 'release', path: 'shots/release' }]}
        sections={sections}
        loading={false}
        stale={false}
        insetPx={12}
        onOpenItem={onOpenItem}
        onOpenFolder={onOpenFolder}
      />),
    );
    try {
      await layout(screen, 340);
      const tiles = screen.findAll(
        (node) =>
          typeof node.props.testID === 'string' &&
          node.props.testID.startsWith('gallery-tile-') &&
          typeof node.props.onPress === 'function',
      );
      const names = [
        ...new Set(tiles.map((tile) => tile.props.testID as string)),
      ];
      expect(names).toEqual([
        'gallery-tile-after.png',
        'gallery-tile-before.png',
        'gallery-tile-flow.mov',
        'gallery-tile-phone.png',
      ]);
      const phone = tiles.find(
        (tile) => tile.props.testID === 'gallery-tile-phone.png',
      )!;
      await act(async () => phone.props.onPress());
      // The stage walks the whole gallery: the fourth tile is index 3 of every item, across both days.
      expect(onOpenItem).toHaveBeenCalledWith(
        items.findIndex((item) => item.name === 'phone.png'),
      );
      expect(items.findIndex((item) => item.name === 'phone.png')).toBe(3);
      await act(async () => screen.pressByTestId('gallery-folder-release'));
      expect(onOpenFolder.mock.calls[0]?.[0]).toEqual({
        name: 'release',
        path: 'shots/release',
      });
    } finally {
      await screen.unmount();
    }
  });

  it('says honestly what was not drawn: the listing cap with its one way to load the rest', async () => {
    const loadMore = vi.fn();
    const screen = await renderScreen(inUi(<GalleryGrid
        folders={[]}
        sections={sections}
        loading={false}
        stale={false}
        insetPx={12}
        onOpenItem={() => {}}
        foot={
          <GalleryFootLine
            icon="info"
            text="Showing 4 · more weren’t loaded"
            testID="gallery-truncated"
            action={{
              label: 'Load the rest',
              onPress: loadMore,
              testID: 'gallery-load-more',
            }}
          />
        }
      />),
    );
    try {
      await layout(screen, 340);
      expect(screen.findByTestId('gallery-truncated')).toBeTruthy();
      await act(async () => screen.pressByTestId('gallery-load-more'));
      expect(loadMore).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it('holds skeleton tiles in the grid’s own squares while the first listing is on its way', async () => {
    const screen = await renderScreen(inUi(<GalleryGrid
        folders={[]}
        sections={[]}
        loading
        stale={false}
        insetPx={12}
        onOpenItem={() => {}}
      />),
    );
    try {
      await layout(screen, 340);
      // Three columns across the Files pane, three rows.
      expect(screen.findAllHostsByTestId('gallery-skeleton-tile')).toHaveLength(9);
    } finally {
      await screen.unmount();
    }
  });
});
