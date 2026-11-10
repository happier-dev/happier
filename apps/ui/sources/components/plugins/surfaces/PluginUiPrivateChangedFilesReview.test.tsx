import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import {
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ renderItemLimit: 12 });
await prepareSessionFilesViewTestkit();

// Under Review's default open-diff limit (Settings → Review, 25 files): diffs follow the prefetch window.
const FILE_COUNT = 20;


async function mountPluginReview(files: readonly Readonly<Record<string, unknown>>[], extra: Readonly<Record<string, unknown>> = {}) {
  const { PluginUiPresentationHostProviderInternal } =
    await import('../../../../../../packages/plugin-ui/src/presentationHost/context');
  const { ChangedFilesReview } = await import('@happier-dev/plugin-ui');
  const { createPluginUiPrivatePresentationHost } = await import('./pluginUiPrivatePresentationHost');
  const { PluginUiPrivateChangedFilesReview } = await import('./PluginUiPrivateChangedFilesReview');
  const host = createPluginUiPrivatePresentationHost(undefined);
  const screen = await renderScreen(
    <OverlayPortalProvider>
      <PluginUiPresentationHostProviderInternal host={host}>
        <ChangedFilesReview identity="pr:2@head" label="Files this pull request changes"
          files={files as never} loadDiff={async () => ({ state: 'unavailable' as const, reason: 'not read here' })}
          {...extra} />
      </PluginUiPresentationHostProviderInternal>
      <OverlayPortalHost />
    </OverlayPortalProvider>,
    // Platform view measurement supplies the anchored menu's host geometry.
    { createNodeMock: () => ({ measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(0, 0, 600, 40) }) },
  );
  for (let i = 0; i < 5 && screen.tree.root.findAllByType(PluginUiPrivateChangedFilesReview).length === 0; i += 1)
    await flushHookEffects();
  await act(async () => {
    screen.findByTestId('scm-review-file-widget-area')?.props.onLayout({ nativeEvent: { layout: { width: 720, height: 600 } } });
  });
  return screen;
}

describe('plugin-ui ChangedFilesReview renders through the Session review owner', () => {
  afterEach(standardCleanup);

  it('lists every file in the review index and reads diffs only for files Review asks for', async () => {
    const { PluginUiPresentationHostProviderInternal } =
      await import('../../../../../../packages/plugin-ui/src/presentationHost/context');
    const { ChangedFilesReview } = await import('@happier-dev/plugin-ui');
    const { createPluginUiPrivatePresentationHost } =
      await import('./pluginUiPrivatePresentationHost');
    const { ChangedFilesReview: HostChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
    const { PluginUiPrivateChangedFilesReview } =
      await import('./PluginUiPrivateChangedFilesReview');
    const files = Array.from({ length: FILE_COUNT }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      ...(index === FILE_COUNT - 1
        ? { diffUnavailableReason: 'The source has no diff for this file.' }
        : {}),
    }));
    const reads: string[] = [];
    const loadDiff = async (path: string) => {
      reads.push(path);
      return {
        state: 'available' as const,
        unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      };
    };
    const host = createPluginUiPrivatePresentationHost(undefined);
    const screen = await renderScreen(
      <PluginUiPresentationHostProviderInternal host={host}>
        <ChangedFilesReview
          identity="pr:1@head"
          label="Files this pull request changes"
          files={files}
          loadDiff={loadDiff}
        />
      </PluginUiPresentationHostProviderInternal>,
    );
    try {
      for (
        let i = 0;
        i < 5 &&
        screen.tree.root.findAllByType(PluginUiPrivateChangedFilesReview)
          .length === 0;
        i += 1
      )
        await flushHookEffects();
      // A detail pane is narrower than the rail: the files float in Review's file widget over the stream.
      await act(async () => {
        screen.findByTestId('scm-review-file-widget-area')!.props.onLayout({ nativeEvent: { layout: { width: 720, height: 600 } } });
      });
      expect(
        screen.findByTestId('scm-review-index'),
        'the host review index, not a plugin row list',
      ).not.toBeNull();
      expect(
        screen.tree.root.findAll((node) => typeof node.props?.testIDPrefix === 'string'
          && node.props.testIDPrefix === 'scm-review-index-layout').length,
        'without a rail, the file widget offers the list | tree switch',
      ).toBeGreaterThan(0);
      const review = screen.tree.root.findByType(HostChangedFilesReview);
      expect(review.props.allRepositoryChangedFiles.map((file: { fullPath: string }) => file.fullPath),
        'every listed file reaches the Session review owner').toEqual(files.map((file) => file.path));
      await vi.waitFor(async () => {
        await flushHookEffects();
        expect(reads.length, 'reads follow the review window').toBeGreaterThan(0);
      });
      expect(reads.length, 'N files never become N reads').toBeLessThan(
        FILE_COUNT - 1,
      );
      expect(new Set(reads).size, 'one read per file').toBe(reads.length);
      expect(reads, 'a file the source has no diff for is never read').not.toContain(`src/file-${FILE_COUNT - 1}.ts`);
    } finally {
      await screen.unmount();
    }
  });
  it('draws each file\'s line counts with the shared diff-stat readout, exact and one-sided when one side is empty', async () => {
    // Migrated from the GitHub Files test (e52b5e27fd moved the rendering to the host review).
    const screen = await mountPluginReview([
      { path: 'src/alpha.ts', status: 'modified', additions: 1234, deletions: 0 },
      { path: 'src/beta.ts', status: 'modified', additions: 3, deletions: 1 },
    ]);
    try {
      const text = screen.getTextContent();
      // The path draws as its folder and name.
      expect(text).toContain('alpha.ts');
      expect(text).toContain('+1,234');
      expect(text).not.toContain('1.2K');
      expect(text).not.toContain('−0');
      expect(text).toContain('+3');
      expect(text).toContain('−1');
    } finally {
      await screen.unmount();
    }
  });

  it('offers a file\'s Copy path and Open on its source from the file\'s quiet overflow, not as buttons on every row', async () => {
    // Live 2026-10-16: every changed file carried plain "Copy" and "Open" buttons. Owner ruling 2026-11-10:
    // keep both, through the shared review's per-file ⋯; Open on the source only when it gives a URL.
    const screen = await mountPluginReview([
      { path: 'src/alpha.ts', status: 'modified', additions: 1, deletions: 0, webUrl: 'https://github.com/o/r/blob/h/src/alpha.ts' },
      { path: 'src/beta.ts', status: 'modified', additions: 1, deletions: 0 },
    ], { openOnSourceLabel: 'Open on GitHub' });
    try {
      expect(screen.tree.root.findAll((node) => node.props?.accessibilityLabel === 'Copy src/alpha.ts')).toEqual([]);
      await screen.pressByTestIdAsync('diff-file-menu:src/alpha.ts');
      await flushHookEffects({ cycles: 3, turns: 4 });
      expect(screen.findByTestId('diff-file-copy-path')).not.toBeNull();
      expect(screen.findByTestId('diff-file-open-source')).not.toBeNull();
      expect(screen.getTextContent()).toContain('Open on GitHub');
    } finally {
      await screen.unmount();
    }
    const plain = await mountPluginReview([
      { path: 'src/beta.ts', status: 'modified', additions: 1, deletions: 0 },
    ], { openOnSourceLabel: 'Open on GitHub' });
    try {
      await plain.pressByTestIdAsync('diff-file-menu:src/beta.ts');
      await flushHookEffects({ cycles: 3, turns: 4 });
      expect(plain.findByTestId('diff-file-copy-path')).not.toBeNull();
      // No URL from the source, no Open on it.
      expect(plain.findByTestId('diff-file-open-source')).toBeNull();
    } finally {
      await plain.unmount();
    }
  });
});
