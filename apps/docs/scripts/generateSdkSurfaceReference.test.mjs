import assert from 'node:assert/strict';
import test from 'node:test';

import {
  importPath,
  renderSdkSurfaceMarkdown,
  summarize,
  SUPPORTED_SCHEMA_VERSION,
} from './generateSdkSurfaceReference.mjs';

const surface = (overrides = {}) => ({
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  entrypoints: [
    { specifier: '.', sourceModule: 'src/index.ts', visibility: 'author', realm: 'any' },
    { specifier: './agents/runtime', sourceModule: 'src/agents/runtime/index.ts', visibility: 'author', realm: 'daemon' },
  ],
  symbols: [
    { specifier: '.', exportName: 'definePlugin', kind: 'value' },
    { specifier: '.', exportName: 'PluginApi', kind: 'type' },
    { specifier: './agents/runtime', exportName: 'AgentRuntime', kind: 'type' },
  ],
  ...overrides,
});

test('the package root and a subpath produce different import specifiers', () => {
  assert.equal(importPath('.'), '@happier-dev/plugin-sdk');
  assert.equal(importPath('./agents/runtime'), '@happier-dev/plugin-sdk/agents/runtime');
});

test('a projection this generator does not understand fails rather than publishing a guess', () => {
  // The alternative is a page that silently drops fields the new shape moved.
  assert.throws(
    () => summarize(surface({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 })),
    /schemaVersion/,
  );
});

test('an empty projection is a broken build, not an empty page', () => {
  assert.throws(() => summarize(surface({ entrypoints: [] })), /zero entrypoints/);
  assert.throws(() => summarize(surface({ symbols: [] })), /zero symbols/);
});

test('a symbol from an entrypoint nothing declares fails loudly', () => {
  assert.throws(
    () => summarize(surface({
      symbols: [{ specifier: './ghost', exportName: 'X', kind: 'value' }],
    })),
    /unlisted entrypoints: \.\/ghost/,
  );
});

test('symbols are split by kind and sorted, so a reordered projection is not a diff', () => {
  const { entrypoints, totalValues, totalTypes } = summarize(surface({
    symbols: [
      { specifier: '.', exportName: 'zeta', kind: 'value' },
      { specifier: '.', exportName: 'alpha', kind: 'value' },
      { specifier: '.', exportName: 'Beta', kind: 'type' },
    ],
  }));
  const root = entrypoints.find((e) => e.specifier === '.');
  assert.deepEqual(root.values.map((s) => s.exportName), ['alpha', 'zeta']);
  assert.deepEqual(root.types.map((s) => s.exportName), ['Beta']);
  assert.equal(totalValues, 2);
  assert.equal(totalTypes, 1);
});

test('the rendered page names the realm and marks host-only entrypoints', () => {
  const markdown = renderSdkSurfaceMarkdown(surface({
    entrypoints: [
      { specifier: './internal', sourceModule: 'src/internal/index.ts', visibility: 'host', realm: 'daemon' },
    ],
    symbols: [{ specifier: './internal', exportName: 'HostOnly', kind: 'value' }],
  }));
  assert.match(markdown, /Host-only\. Daemon only\./);
  assert.match(markdown, /@happier-dev\/plugin-sdk\/internal/);
});
