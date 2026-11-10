import { describe, expect, it } from 'vitest';

import { PluginManifestV2Schema } from '../../manifest/v2.js';
import { projectPluginPortableUiDeclarationsV1 } from './declarationProjection.js';
import {
  PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1,
  PLUGIN_UI_INLINE_SURFACE_SLOTS_V1,
  PluginUiSurfaceBindingV1Schema,
} from './surfaceRegistry.js';
import { PluginUiArtifactsManifestEntryV2Schema } from '../../ui/uiArtifactsManifest.js';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1 } from '../../ui/artifactIntegrity.js';

function portableViewsFixture() {
  // Settings pages and Session info sections have separate declaration families.
  const destinations = PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1
    .filter(slot => slot.container !== 'settingsPage')
    .map(slot => ({
      id: `${slot.container}-${slot.targetKind}`.toLowerCase(),
      container: slot.container,
      target: slot.targetKind === 'browser'
        ? { kind: slot.targetKind, browserViewIdPath: '/browserViewId' }
        : { kind: slot.targetKind },
      renderer: 'native',
    }));
  const inline = Object.values(PLUGIN_UI_INLINE_SURFACE_SLOTS_V1)
    .filter(slot => slot.authoredIn === 'ui.views')
    .flatMap(slot => Object.keys(slot.targets).map(kind => ({
      id: `${slot.role}-${kind}`.toLowerCase(), container: slot.role, target: { kind }, renderer: 'native',
      ...(slot.role === 'widget' ? { sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' } } : {}),
      ...(slot.role === 'widget' && kind === 'session' ? {
        inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
        inputSchema: { type: 'object', properties: { session: { type: 'object' } }, required: ['session'], additionalProperties: false },
        sessionInputPath: 'session',
      } : {}),
    })));
  const manifest = PluginManifestV2Schema.parse({
    schemaVersion: 2, id: 'acme.portable-views', version: '1.0.0', displayName: 'Portable views',
    runtime: { apiVersion: 1 }, contributes: { ui: {
      renderers: [
        { id: 'native', kind: 'declarative', root: { kind: 'text', text: 'Available offline' } },
        { id: 'hosted', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'panel' } },
        { id: 'missing-native', kind: 'reactNative', artifact: 'missing-native' },
      ],
      views: [...destinations, ...inline,
        { id: 'hosted-session', container: 'rightSidebarTab', target: { kind: 'session' }, renderer: 'hosted' },
        { id: 'native-session', container: 'detailsTab', target: { kind: 'session' }, renderer: 'missing-native' },
        { id: 'fallback-session', container: 'rightSidebarTab', target: { kind: 'session' }, renderer: 'missing-native', fallbackRenderers: ['native'] },
      ],
    } },
  });
  const entry = 'hosted-web/panel/index.html';
  const bytes = new TextEncoder().encode('<!doctype html><main>Session details</main>');
  const artifact = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: 'panel', tier: 'hostedWeb', entry,
    files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
    digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]),
    builtWith: { staging: 'staticDirectory' }, hostUiApiRange: '^1.0.0',
  });
  return { manifest, artifact, destinations, inline };
}

describe('portable view declarations without Machine execution facts', () => {
  it.each(['unbundled', 'bundled-empty', 'bundled-artifact'] as const)(
    'retains every registry-admitted view and renderer availability for %s declarations', state => {
      const { manifest, artifact, destinations, inline } = portableViewsFixture();
      const entries = projectPluginPortableUiDeclarationsV1(manifest,
        state === 'unbundled' ? undefined : state === 'bundled-empty' ? [] : [artifact]);
      const placements = Object.values(entries).filter(entry => entry.contributionKind === 'surfacePlacement');
      expect(placements).toHaveLength(manifest.contributes.ui.views.length);
      for (const view of [...destinations, ...inline]) {
        const placement = entries[`surfacePlacement:${manifest.id}:${view.id}`];
        expect(placement, view.id).toMatchObject({
          target: view.target, renderer: { kind: 'declarative', contributionId: 'native' },
          availability: { state: 'available' }, runtime: { resourceCapability: { readable: false, dynamic: false } },
        });
        const binding = PluginUiSurfaceBindingV1Schema.parse(placement?.binding);
        expect(binding.targetKind).toBe(view.target.kind);
        expect(binding.target).toEqual(view.target);
        expect(binding.kind === 'destination' ? binding.container : binding.role).toBe(view.container);
        expect(placement).not.toHaveProperty('executionOrigin');
      }
      expect(entries[`surfacePlacement:${manifest.id}:rightsidebartab-session`]).toHaveProperty('rightSidebar.scope', 'session');
      expect(entries[`surfacePlacement:${manifest.id}:native-session`]).toMatchObject({
        renderer: { kind: 'reactNative' }, availability: { state: 'fallback', reason: 'renderer_unavailable' },
      });
      expect(entries[`surfacePlacement:${manifest.id}:hosted-session`]).toMatchObject({
        availability: state === 'bundled-artifact'
          ? { state: 'available' }
          : { state: 'fallback', reason: 'renderer_unavailable' },
      });
      expect(entries[`surfacePlacement:${manifest.id}:fallback-session`]).toMatchObject({
        binding: { renderer: { localId: 'native' } }, renderer: { kind: 'declarative', contributionId: 'native' },
        availability: { state: 'available' },
      });
      if (state === 'bundled-artifact') {
        expect(entries[`hostedWeb:${manifest.id}:hosted`]).toMatchObject({
          runtime: { state: 'fallback', decision: { reason: 'hosted_web_frame_adapter_unknown' } },
        });
      }
    },
  );
});
