import { describe, expect, it } from 'vitest';

import * as advancedEntry from './advanced/index.js';
import * as componentsEntry from './components/index.js';
import * as hostApiEntry from './hostApi/index.js';
import * as rootEntry from './index.js';
import * as testingEntry from './testing/index.js';

describe('curated plugin-ui public API', () => {
  it('keeps ordinary author imports curated and reserves raw composition for the advanced entry', () => {
    for (const entry of [rootEntry, componentsEntry, hostApiEntry]) {
      expect(entry).not.toHaveProperty('PluginUiProvider');
      expect(entry).not.toHaveProperty('PluginHostApiProvider');
      expect(entry).not.toHaveProperty('createPluginUiResourceStore');
      expect(entry).not.toHaveProperty('createPluginUiHostApiResourceClient');
    }

    expect(rootEntry).toEqual(expect.objectContaining({
      defineUiSurface: expect.any(Function),
      useExecutePluginAction: expect.any(Function),
      usePluginResource: expect.any(Function),
      useLivePluginResource: expect.any(Function),
    }));
    expect(advancedEntry).toEqual(expect.objectContaining({
      PluginUiProvider: expect.any(Function),
      PluginHostApiProvider: expect.any(Function),
      createPluginUiResourceStore: expect.any(Function),
      createPluginUiHostApiResourceClient: expect.any(Function),
    }));
  });
});

describe('plugin-ui semantic testing public API', () => {
  it('exposes only the RNW semantic adapter for author tests', () => {
    expect(Object.keys(testingEntry)).toEqual([
      'createPluginUiRnwSemanticSurfaceAdapter',
    ]);
    expect(testingEntry.createPluginUiRnwSemanticSurfaceAdapter).toBeTypeOf('function');
  });
});
