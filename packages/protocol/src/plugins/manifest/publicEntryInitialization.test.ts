import { readIndexedBundledDeclarationManifest } from '../../../../../apps/cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A public Widget-subpath consumer can initialize before the public root. Keep
// that order: Widget → declarative document → UI grammar → Widget presentation.
import '../../widgets/widgetPublicSnapshotV1.js';
import { ingestPluginManifestV2, PluginUiViewV2Schema } from '../../index.js';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST } from '../../../../plugins/triage/src/manifest.js';

describe('manifest ingestion after public Protocol initialization', () => {
  it('admits the real Triage declaration and bundled public presentations', () => {
    expect(ingestPluginManifestV2(TRIAGE_MANIFEST)).toMatchObject({ ok: true });

    const directory = new URL('../../../../../apps/cli/assets/bundled-plugin-manifests/', import.meta.url);
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      const manifest = readIndexedBundledDeclarationManifest(new URL(file, directory));
      if (JSON.stringify(manifest).includes('"publicPresentation"')) {
        expect(ingestPluginManifestV2(manifest), file).toMatchObject({ ok: true });
      }
    }
  });

  it('retains public-presentation grammar and refinements after that initialization', () => {
    const widget = {
      id: 'public-summary', container: 'widget', renderer: 'summary', target: { kind: 'app' },
      sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
      publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Public summary' } } },
    };
    expect(PluginUiViewV2Schema.safeParse(widget).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, publicPresentation: { ...widget.publicPresentation, authority: true } }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, publicPresentation: {
      kind: 'declarative', document: { version: 1, root: { kind: 'action', action: { pluginId: 'acme.private', localId: 'private-action' }, label: 'Private' } },
    } }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...widget, fallbackRenderers: ['summary'] }).success).toBe(false);
  });
});
