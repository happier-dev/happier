import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { renderSurface } from '../../../plugin-sdk/examples/public-authoring/ui/reviewPanel.native.tsx';
import { createPluginUiRnwSemanticSurfaceAdapter } from './rnwSemanticAdapter.testSupport.js';

const REVIEW_STATUS_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('public authoring Project Companion activity surface', () => {
  it('routes an opaque openable reference only through its declared openable view', async () => {
    const statOpenableContent = vi.fn(async () => ({
      status: 'ready' as const,
      mimeType: 'text/plain',
      contentClass: 'text' as const,
      extension: '.txt',
      sizeBytes: 12,
      revision: 'review-file-revision-1',
    }));
    const readOpenableContent = vi.fn(async () => ({
      status: 'ready' as const,
      revision: 'review-file-revision-1',
      content: { kind: 'utf8' as const, text: 'Review file.' },
    }));
    const launchInput = { kind: 'workspaceFile' as const, handle: 'review-file-handle' };
    const surfaceContext = createSurfaceContextFixture({
      mount: {
        kind: 'destination',
        destination: {
          pluginId: 'examples.public-sdk-review-assistant',
          localId: 'review-panel',
        },
        container: 'appPage',
      },
      target: { kind: 'app' },
    });

    const normal = await createPluginUiTestkit({
      identity: {
        pluginId: 'examples.public-sdk-review-assistant',
        pluginVersion: '0.1.0',
        viewId: 'review-panel',
        generation: 'public-authoring-normal-review-panel-test',
      },
      surface: renderSurface,
      surfaceContext,
      launchInput,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { statOpenableContent, readOpenableContent },
    });
    try {
      await vi.waitFor(async () => {
        expect(await normal.getByText('Review assistant ready')).toEqual({
          content: 'Review assistant ready',
        });
      });
      expect(statOpenableContent).not.toHaveBeenCalled();
      expect(readOpenableContent).not.toHaveBeenCalled();
    } finally {
      await normal.dispose();
    }

    const openable = await createPluginUiTestkit({
      identity: {
        pluginId: 'examples.public-sdk-review-assistant',
        pluginVersion: '0.1.0',
        viewId: 'review-openable-content',
        generation: 'public-authoring-openable-review-panel-test',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'examples.public-sdk-review-assistant',
            localId: 'review-openable-content',
          },
          container: 'detailsTab',
        },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      launchInput,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { statOpenableContent, readOpenableContent },
    });
    try {
      await vi.waitFor(async () => {
        expect(await openable.getByText('Review file.')).toEqual({ content: 'Review file.' });
      });
      expect(statOpenableContent).toHaveBeenCalledWith(expect.objectContaining({
        ref: launchInput,
        signal: expect.any(AbortSignal),
      }));
      expect(readOpenableContent).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({
          ref: launchInput,
          expectedRevision: 'review-file-revision-1',
        }),
        signal: expect.any(AbortSignal),
      }));
    } finally {
      await openable.dispose();
    }

    const missingReference = await createPluginUiTestkit({
      identity: {
        pluginId: 'examples.public-sdk-review-assistant',
        pluginVersion: '0.1.0',
        viewId: 'review-openable-content',
        generation: 'public-authoring-openable-missing-reference-test',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'examples.public-sdk-review-assistant',
            localId: 'review-openable-content',
          },
          container: 'detailsTab',
        },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { statOpenableContent, readOpenableContent },
    });
    try {
      await vi.waitFor(async () => {
        expect(await missingReference.getByText('Open this viewer from a host-selected review file.')).toEqual({
          content: 'Open this viewer from a host-selected review file.',
        });
      });
      expect(statOpenableContent).toHaveBeenCalledTimes(1);
      expect(readOpenableContent).toHaveBeenCalledTimes(1);
    } finally {
      await missingReference.dispose();
    }
  });

  it('reads the Session activity Resource and opens the existing Session details destination', async () => {
    let readResourceReference: unknown;
    let watchResourceReference: unknown;
    const readResource = vi.fn(async ({ resource }: Readonly<{ resource: unknown }>) => {
      readResourceReference = resource;
      return {
        contentType: 'text/plain',
        digest: REVIEW_STATUS_DIGEST,
        bytes: new TextEncoder().encode('Review requested follow-up on the migration boundary.'),
      };
    });
    const watchResource = vi.fn(({ resource }: Readonly<{ resource: unknown }>) => {
      watchResourceReference = resource;
      return { digest: REVIEW_STATUS_DIGEST };
    });
    const openSurface = vi.fn(async () => undefined);
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'examples.public-sdk-review-assistant',
        pluginVersion: '0.1.0',
        viewId: 'project-companion-activity-log',
        generation: 'public-authoring-project-companion-test',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'examples.public-sdk-review-assistant',
            localId: 'project-companion-activity-log',
          },
          container: 'bottomPane',
        },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { readResource, watchResource, openSurface },
    });

    try {
      const details = await fixture.findByRole('button', { name: 'Open review details' });
      // A live Resource watch resynchronizes after admission. The public
      // contract is the loaded activity's actionable destination, not the
      // number of internal canonical reads needed to establish it.
      expect(readResourceReference).toEqual({
        pluginId: 'examples.public-sdk-review-assistant',
        localId: 'review-session-status',
      });

      await fixture.press(details);

      expect(watchResource).toHaveBeenCalledTimes(1);
      expect(watchResourceReference).toEqual({
        pluginId: 'examples.public-sdk-review-assistant',
        localId: 'review-session-status',
      });
      expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
        view: {
          pluginId: 'examples.public-sdk-review-assistant',
          localId: 'review-session-status-details',
        },
        signal: expect.any(AbortSignal),
      }));
    } finally {
      await fixture.dispose();
    }
  });
});
