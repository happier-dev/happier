import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildPackedResourcesBrowserManifest,
  buildPackedResourcesBrowserRuntimeSource,
  packedResourcesBrowserPayloads,
} from './packed-resources-browser-fixture.mjs';

test('resource fixture declares only the retained consumed contribution set', () => {
  const manifest = buildPackedResourcesBrowserManifest({
    manifest: {
      id: 'acme.resources-browser',
      name: 'Resources browser',
      version: '0.0.0',
      entrypoints: { development: './src/index.ts' },
      contributes: { settings: [{ id: 'must-not-survive' }] },
    },
    pluginId: 'acme.resources-browser',
    version: '1.0.0',
  });

  assert.deepEqual(Object.keys(manifest.contributes), [
    'actions',
    'resources',
  ]);
  assert.deepEqual(
    manifest.contributes.resources.map((resource) => resource.kind),
    ['prompt', 'skill', 'template', 'asset', 'config'],
  );
  assert.equal(manifest.contributes.actions.length, 1);
  assert.equal(manifest.contributes.browserTargets, undefined);
  assert.equal(manifest.contributes.browserActions, undefined);
});

test('resource runtime reads all five resources without a source fallback', () => {
  const source = buildPackedResourcesBrowserRuntimeSource({
    pluginId: 'acme.resources-browser',
    version: '1.0.0',
  });

  for (const id of ['prompt', 'skill', 'template', 'asset', 'config']) {
    assert.match(
      source,
      new RegExp(`context\\.services\\.resources\\.read\\('${id}'\\)`, 'u'),
    );
  }
  assert.doesNotMatch(source, /packages\/plugin-sdk|@\/|HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT/u);
  assert.match(source, /api\.actions\.register\('roundtrip', roundtrip\)/u);
});

test('resource payloads are exact and version-bound', () => {
  assert.deepEqual(packedResourcesBrowserPayloads('1.0.0'), {
    prompt: '# Packed prompt 1.0.0\n',
    skill: '# Packed skill 1.0.0\n',
    template: 'Packed template 1.0.0\n',
    asset: '{"kind":"asset","version":"1.0.0"}\n',
    config: '{"kind":"config","version":"1.0.0"}\n',
  });
});

test('resource candidate fixture does not retain browser contribution authoring or projection assertions', () => {
  const candidateSource = readFileSync(
    new URL('../../suites/ui-e2e/plugins.resourcesBrowser.candidate.spec.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(candidateSource, /browserTarget:|browserAction:|browserTargets|browserActions/u);
  assert.doesNotMatch(candidateSource, /session-header-browser-button|browser-view-details-surface/u);
  assert.match(candidateSource, /families\.pluginBrowser\)\.toBeUndefined\(\)/u);
});
