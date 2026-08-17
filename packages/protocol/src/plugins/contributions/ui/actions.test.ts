import { describe, expect, it } from 'vitest';

import {
  isExecutablePluginUiFallbackRefV1,
} from './actions.js';

describe('plugin UI fallback references', () => {
  it('distinguishes executable-tier fallbacks from unavailable markers', () => {
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'hostedWeb', contributionId: 'preview-web' })).toBe(true);
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'descriptor', descriptorId: 'preview-card' })).toBe(true);
    expect(isExecutablePluginUiFallbackRefV1({
      kind: 'structuredMessage',
      descriptorId: 'preview-message',
    })).toBe(true);
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'unavailable' })).toBe(false);
    expect(isExecutablePluginUiFallbackRefV1({ kind: 'none' })).toBe(false);
    expect(isExecutablePluginUiFallbackRefV1(undefined)).toBe(false);
  });
});
