import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  createPluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { invokeInputTypePicker, readInputTypeOptions, type InputTypePickerHostV1, type ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderSurface } from '../../../plugin-sdk/examples/public-authoring/ui/reviewPanel.native.tsx';
import { publicAuthoringDefinition } from '../../../plugin-sdk/examples/public-authoring/definition.ts';
import { repositoryInputTypes, repositoryResources, repositoryInputTypeRef } from '../../../plugin-sdk/examples/public-authoring/inputTypes.ts';
import { externalAuthoringPlugin } from '../../fixtures/external-authoring/src/index.ts';

const REVIEW_STATUS_DIGEST = `sha256:${'a'.repeat(64)}`;
const EXTERNAL_SEMANTIC_VIEW_ID = 'external-authoring-semantic';

function selectExternalAuthoringSemanticRendererArtifact(
  ui: typeof externalAuthoringPlugin.manifest.contributes.ui,
): string {
  const view = ui.views?.find(candidate => candidate.id === EXTERNAL_SEMANTIC_VIEW_ID);
  if (!view) throw new Error('Expected the loaded external authoring semantic view');
  const renderer = ui.renderers?.find(candidate => candidate.id === view.renderer);
  if (renderer?.kind !== 'reactNative') {
    throw new Error('Expected the loaded external authoring semantic React Native renderer');
  }
  return renderer.artifact;
}

async function loadExternalAuthoringSemanticSurface(): Promise<RenderSurface> {
  const artifact = selectExternalAuthoringSemanticRendererArtifact(
    externalAuthoringPlugin.manifest.contributes.ui,
  );
  if (artifact !== 'semantic-surface') {
    throw new Error(`Unsupported external authoring semantic artifact: ${artifact}`);
  }
  const module = await import('../../fixtures/external-authoring/src/semanticSurface.tsx');
  return module.renderExternalAuthoringSemanticSurface;
}

describe('public authoring Project Companion activity surface', () => {
  let externalAuthoringSemanticSurface: RenderSurface;

  beforeAll(async () => {
    externalAuthoringSemanticSurface = await loadExternalAuthoringSemanticSurface();
  });

  it('requires the semantic surface to be declared by the loaded author contribution', () => {
    const ui = externalAuthoringPlugin.manifest.contributes.ui;
    expect(() => selectExternalAuthoringSemanticRendererArtifact({
      ...ui,
      views: ui.views?.filter(view => view.id !== EXTERNAL_SEMANTIC_VIEW_ID),
    })).toThrow('Expected the loaded external authoring semantic view');
  });

  it.each(['opened', 'client_unavailable'] as const)('presents the external authoring Action outcome %s without requesting Send', async (outcome) => {
    const calls: Array<Readonly<{ action: unknown; input: unknown }>> = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'external-authoring-open', mountNonce: 'external-authoring-open-mount' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      // Actions leave the external author's process. Keep the public SDK transport and surface real.
      handlers: { executeAction: async ({ action, input }) => {
        calls.push({ action, input });
        return outcome === 'opened'
          ? { kind: 'opened', draftId: 'external-editable-draft', destination: 'newSession' }
          : { kind: 'unavailable', reason: 'client_unavailable' };
      } },
    });
    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Open an editable authoring draft' }));
      await expect(fixture.findByRole('status', { name: outcome === 'opened'
        ? 'Draft opened; review and Send in Happier'
        : 'Draft unavailable; nothing sent' })).resolves.toBeDefined();
      expect(calls).toEqual([{ action: 'session.authoring.open', input: {
        seed: { prompt: 'Help me update this review integration.' },
      } }]);
    } finally { await fixture.dispose(); }
  });

  it('mounts the external author’s controlled choice and retains it through local widget disclosure', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-m2-source', mountNonce: 'fixture-m2-source-mount' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => null },
    });
    try {
      await fixture.press(await fixture.getByRole('radio', { name: 'Choose Terminal review' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Collapse review choices' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Expand review choices' }));
      await expect(fixture.getByRole('radio', {
        name: 'Choose Terminal review', state: { checked: true },
      })).resolves.toBeDefined();
      await expect(fixture.getByText('Neutral owners review-root 480,360')).resolves.toBeDefined();
      // The public controlled frame renders the author's own content and controls (70s3).
      await expect(fixture.getByText('Framed review preview')).resolves.toBeDefined();
      await expect(fixture.getByText('Review preview controls')).resolves.toBeDefined();
      await expect(fixture.getByText('Author preview content')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Close author preview' }));
      await expect(fixture.queryByText('Author preview content')).resolves.toBeUndefined();
      await expect(fixture.getByText('Framed review preview')).resolves.toBeDefined();
    } finally { await fixture.dispose(); }
  });
  it('invokes the declared native picker through the real UI host settlement boundary and cancels without a value', async () => {
    const renderer = publicAuthoringDefinition.ui?.renderers?.find(renderer => renderer.id === 'review-native');
    if (!renderer) throw new Error('Expected the declared native picker renderer');
    const plugin = definePlugin({ id: repositoryInputTypeRef.pluginId, version: '1.0.0',
      inputTypes: repositoryInputTypes, resources: repositoryResources,
      ui: { renderers: [renderer] },
    });
    const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const resource = testkit.registration('resources', 'review-repositories');
    if (!resource) throw new Error('Expected registered options Resource');
    const type: ResolvedInputTypeV1 = { identity: repositoryInputTypeRef, occurrenceId: 'picker-fixture',
      definition: { id: 'repository', ...repositoryInputTypes.repository } };
    let selection = 'Review assistant';
    const host: InputTypePickerHostV1 = {
      resolveType: async () => type,
      resolveOptions: async () => {
        const content = await resource.read({ signal: new AbortController().signal, context: { kind: 'global' } });
        return readInputTypeOptions(type, JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content)))
          ?? { errorCode: 'input_type_options_invalid' };
      },
      openPicker: async request => {
        expect(request.picker).toEqual({ pluginId: repositoryInputTypeRef.pluginId, localId: 'review-native' });
        let answer: unknown;
        const fixture = await createPluginUiTestkit({
          identity: { instanceId: 'repository-picker', mountNonce: 'repository-picker-mount' },
          authorPlugin: { id: repositoryInputTypeRef.pluginId, version: '1.0.0' }, surface: renderSurface,
          surfaceContext: createSurfaceContextFixture({ mount: { kind: 'embedded', role: 'ephemeralInput', presentation: 'content' },
            target: { kind: 'app' } }), launchInput: request.launchInput,
          adapter: createPluginUiRnwSemanticSurfaceAdapter(),
          handlers: { settleEphemeralInput: async ({ settlement }) => { answer = settlement; } },
        });
        try { await fixture.press(await fixture.findByRole('button', { name: selection })); return answer; }
        finally { await fixture.dispose(); }
      },
    };
    const request = { field: { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: repositoryInputTypeRef },
      host, signal: new AbortController().signal };
    try {
      expect(await invokeInputTypePicker(request)).toEqual({ status: 'selected', value: { repositoryId: 'example/review-assistant' } });
      selection = 'Cancel';
      expect(await invokeInputTypePicker(request)).toEqual({ status: 'cancelled' });
    } finally { await testkit.dispose(); }
  });

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
      identity: { instanceId: 'fixture-instance-45', mountNonce: 'fixture-mount-45' },
      authorPlugin: { id: 'examples.public-sdk-review-assistant', version: '0.1.0' },
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
      identity: { instanceId: 'fixture-instance-46', mountNonce: 'fixture-mount-46' },
      authorPlugin: { id: 'examples.public-sdk-review-assistant', version: '0.1.0' },
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
      identity: { instanceId: 'fixture-instance-47', mountNonce: 'fixture-mount-47' },
      authorPlugin: { id: 'examples.public-sdk-review-assistant', version: '0.1.0' },
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
      identity: { instanceId: 'fixture-instance-48', mountNonce: 'fixture-mount-48' },
      authorPlugin: { id: 'examples.public-sdk-review-assistant', version: '0.1.0' },
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
