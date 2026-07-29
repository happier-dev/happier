import { describe, expect, it } from 'vitest';

import {
  PluginContributesV2Schema,
  PluginResourceKindV2Schema,
} from './v2.js';

describe('plugin resource contributions', () => {
  it('retains exactly prompt, skill, template, asset, and config resource kinds', () => {
    expect(PluginResourceKindV2Schema.options).toEqual([
      'prompt',
      'skill',
      'template',
      'asset',
      'config',
    ]);

    const parsed = PluginContributesV2Schema.parse({
      resources: PluginResourceKindV2Schema.options.map((kind) => ({
        id: kind,
        kind,
        path: `resources/${kind}.txt`,
        contentType: 'text/plain',
      })),
    });

    expect(parsed.resources.map((resource) => resource.kind)).toEqual(
      PluginResourceKindV2Schema.options,
    );
  });

  it('rejects an undeclared resource kind', () => {
    expect(PluginContributesV2Schema.safeParse({
      resources: [{
        id: 'executable',
        kind: 'executable',
        path: 'resources/tool',
        contentType: 'application/octet-stream',
      }],
    }).success).toBe(false);
  });
});
