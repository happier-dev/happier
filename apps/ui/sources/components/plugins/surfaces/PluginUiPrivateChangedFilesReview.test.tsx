import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ renderItemLimit: 12 });
await prepareSessionFilesViewTestkit();

// Under Review's default open-diff limit (Settings → Review, 25 files): diffs follow the prefetch window.
const FILE_COUNT = 20;

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
      expect(
        screen.findByTestId('scm-review-index'),
        'the host review index, not a plugin row list',
      ).not.toBeNull();
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
});
