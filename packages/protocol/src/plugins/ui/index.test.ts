import { describe, expect, it } from 'vitest';

import { PluginUiActionDescriptorV1Schema } from './index.js';

describe('plugin UI public entrypoint', () => {
  it('exports host action descriptor contracts used by plugin UI surfaces', () => {
    expect(PluginUiActionDescriptorV1Schema.parse({
      id: 'open-preview',
      labelKey: 'preview.open',
      kind: 'openSurface',
      target: { surfaceId: 'preview-pane' },
    })).toMatchObject({
      kind: 'openSurface',
      target: { surfaceId: 'preview-pane' },
    });
  });
});
