import { describe, expect, it } from 'vitest';

import { resolvePluginResourcePath } from './resolve';

describe('resolvePluginResourcePath', () => {
  it('resolves package-relative resource paths inside the plugin root', () => {
    const resolved = resolvePluginResourcePath({
      pluginRootPath: '/plugins/acme.review',
      resourcePath: './resources/review.md',
    });

    expect(resolved).toEqual({
      absolutePath: '/plugins/acme.review/resources/review.md',
      relativePath: 'resources/review.md',
    });
  });

  it('rejects plugin resource paths that escape the plugin root', () => {
    const resolved = resolvePluginResourcePath({
      pluginRootPath: '/plugins/acme.review',
      resourcePath: '../secrets.txt',
    });

    expect(resolved).toBeNull();
  });
});
