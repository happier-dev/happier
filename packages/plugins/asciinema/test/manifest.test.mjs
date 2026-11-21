import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { manifest } from '../src/manifest.ts';
import { matchOpenableContentViewerV1 } from '../../../protocol/src/plugins/openableContentViewerV1.ts';
test('admitted .cast text viewer targets a same-plugin File details destination', () => {
    const parsed = parsePluginManifest(manifest);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const viewer = manifest.contributes?.openableContentViewers?.[0];
    assert.ok(viewer);
    assert.ok(matchOpenableContentViewerV1(viewer, { contentClass: 'text', mimeType: 'text/plain', extension: '.cast' }));
    assert.equal(matchOpenableContentViewerV1(viewer, { contentClass: 'text', mimeType: 'text/plain', extension: '.txt' }), null);
    assert.ok(manifest.contributes.ui.views.some(view => view.id === viewer.destination && view.container === 'detailsTab'));
});
